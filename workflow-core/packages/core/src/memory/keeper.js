// memory/keeper.js - the bounded memory maintenance loop.
//
// It reads a bounded digest of recent changes, asks the configured model (with
// the workflow-memory skill as its instructions) what is worth recording,
// applies only append/write operations inside the memory repository, and
// commits. It never touches project code, never sends messages, and a failure
// never blocks anything else: the next run simply uses the previous memory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'skills', 'workflow-memory', 'SKILL.md',
);

export const MAX_WRITES_PER_RUN = 20;
export const MAX_WRITE_BYTES = 64 * 1024;

export function loadMemorySkill() {
  try {
    return fs.readFileSync(SKILL_PATH, 'utf8');
  } catch {
    return null;
  }
}

// The model is told to emit a JSON array; tolerate prose or a fenced block
// around it, but never invent writes that are not in the reply.
export function parseWritePlan(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry) => (
    entry && typeof entry === 'object'
    && (entry.op === 'append' || entry.op === 'write')
    && typeof entry.path === 'string' && entry.path.trim()
  )).slice(0, MAX_WRITES_PER_RUN);
}

export function createMemoryKeeper({ memoryStore, serverLlm, digest = async () => null, log = () => {} } = {}) {
  if (!memoryStore) throw new TypeError('memoryStore is required');

  async function runOnce() {
    const skill = loadMemorySkill();
    if (!skill) return { changed: false, reason: 'skill_missing' };
    if (!serverLlm?.status?.enabled) return { changed: false, reason: 'llm_disabled' };
    let input;
    try {
      input = await digest();
    } catch (error) {
      log(`[keeper] digest failed: ${error.message}`);
      return { changed: false, reason: 'digest_failed' };
    }
    if (!input) return { changed: false, reason: 'nothing_to_record' };

    let reply;
    try {
      reply = await serverLlm.ask([
        { role: 'system', content: skill },
        { role: 'user', content: JSON.stringify(input) },
      ]);
    } catch (error) {
      log(`[keeper] model call failed: ${error.message}`);
      return { changed: false, reason: 'model_failed' };
    }

    let applied = 0;
    for (const entry of parseWritePlan(reply)) {
      const text = entry.op === 'append' ? entry.text : entry.content;
      if (typeof text !== 'string' || text.length > MAX_WRITE_BYTES) continue;
      try {
        if (entry.op === 'append') memoryStore.append(entry.path, text);
        else memoryStore.write(entry.path, text);
        applied += 1;
      } catch (error) {
        // A path that escapes the repository lands here and is dropped.
        log(`[keeper] skipped ${entry.path}: ${error.message}`);
      }
    }
    if (!applied) return { changed: false, reason: 'no_writes' };
    const commit = memoryStore.commit(`keeper: ${applied} update(s)`);
    return { changed: Boolean(commit), applied, commit };
  }

  return { runOnce };
}
