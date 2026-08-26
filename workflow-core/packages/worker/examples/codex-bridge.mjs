// Minimal Codex CLI JSONL bridge. It intentionally keeps Codex-specific
// command/response handling outside the generic Workflow adapter.
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const codexBin = process.env.WFC_CODEX_BIN || 'codex';
let active = null;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const vendorEnv = { ...process.env };
for (const key of Object.keys(vendorEnv)) {
  if (key === 'WFC_WORKER_TOKEN' || key.startsWith('WFC_CORE_')) delete vendorEnv[key];
}

function emitEvent(event) {
  output({ type: 'event', event });
}

function parseCodexEvent(value, request) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'thread.started' && value.thread_id) {
    output({ type: 'session', session_ref: value.thread_id });
    return;
  }
  if (value.type === 'item.completed') {
    const item = value.item || {};
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      emitEvent({ type: 'assistant/message', text: item.text });
    } else if (item.type) {
      emitEvent({ type: item.type, data: item });
    }
    return;
  }
  if (value.type === 'turn.completed') {
    output({ type: 'result', kind: 'done', result: { usage: value.usage ?? null } });
    active.finished = true;
    return;
  }
  if (value.type === 'error') {
    output({ type: 'error', error: value.message || value.error || 'Codex returned an error' });
  }
}

function run(request) {
  if (active) {
    output({ type: 'error', error: 'Codex conversation is busy' });
    return;
  }
  const resume = request.session_ref && !request.session_ref.startsWith('bridge-');
  const args = resume
    ? ['exec', 'resume', request.session_ref, '--json', request.prompt]
    : ['exec', '--json', request.prompt];
  const child = spawn(codexBin, args, {
    cwd: request.workspace || process.cwd(),
    env: vendorEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active = { child, request, finished: false };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try { parseCodexEvent(JSON.parse(line), request); }
    catch { /* Codex diagnostics are not part of the JSONL contract. */ }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.once('error', (error) => {
    output({ type: 'error', error: error.message });
    if (active?.child === child) active = null;
  });
  child.once('exit', (code, signal) => {
    lines.close();
    if (active?.child === child) {
      if (active.finished !== true && code !== 0) output({ type: 'error', error: `Codex exited (${code ?? signal ?? 'unknown'})` });
      active = null;
    }
  });
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { output({ type: 'error', error: 'invalid bridge request' }); return; }
  if (request.type === 'run') run(request);
  else if (request.type === 'cancel') active?.child.kill('SIGTERM');
  else if (request.type === 'inject') {
    const prior = active;
    if (!prior) { output({ type: 'error', error: 'Codex conversation is not running' }); return; }
    active = null;
    prior.child.kill('SIGTERM');
    setImmediate(() => run({
      type: 'run', task_id: request.task_id, conversation_id: request.conversation_id,
      session_ref: request.session_ref, workspace: prior.request.workspace, prompt: request.content,
    }));
  }
});
