// codex-bridge.mjs - vendor-neutral JSONL bridge wrapping the codex CLI.
// Speaks the Workflow JSONL backend contract: requests are JSON lines on
// stdin (run), events/results are JSON lines on stdout
// (session/event/progress/result/error). `resume` and mid-run inject are not
// supported by `codex exec --json`, so the bridge reports them as errors and
// the Worker fails those tasks closed.
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const MAX_LINE_BYTES = 1024 * 1024;

function codexEntry() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return null;
}

function out(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function runTurn({ task, prompt, sessionRef }) {
  const entry = codexEntry();
  if (!entry) {
    out({ type: 'error', error: 'codex entry not found in npm global tree' });
    return null;
  }
  const args = [entry, 'exec', '--json', '--skip-git-repo-check'];
  args.push(String(prompt || task?.brief?.goal || task?.type || ''));
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });
  child.stdin?.end?.();
  let buffer = '';
  let started = false;
  let done = false;
  let sawSession = false;
  const finish = (kind, result) => {
    if (done) return;
    done = true;
    out({ type: 'result', kind, session_ref: sessionRef ?? null, result: result ?? {} });
  };
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    if (buffer.length > MAX_LINE_BYTES) {
      finish('failed', { error: 'codex output exceeded 1 MiB' });
      child.kill?.();
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message.type !== 'string') continue;
      if (message.type === 'thread.started' && message.thread_id) {
        started = true;
        sawSession = true;
        sessionRef = String(message.thread_id);
        out({ type: 'session', session_ref: sessionRef });
        continue;
      }
      if (message.type === 'turn.started') {
        out({ type: 'progress', note: 'codex turn started', percent: 10 });
        continue;
      }
      if (message.type === 'item.completed' && message.item?.type === 'agent_message') {
        out({ type: 'event', event: { type: 'assistant_message', text: String(message.item.text ?? '') } });
        continue;
      }
      if (message.type === 'item.completed' && (message.item?.type === 'tool_call' || message.item?.type === 'tool_call_attempt')) {
        out({ type: 'event', event: { type: 'tool_started', name: String(message.item.name ?? 'tool') } });
        continue;
      }
      if (message.type === 'item.completed' && message.item?.type === 'reasoning') {
        out({ type: 'event', event: { type: 'reasoning', text: String(message.item.text ?? '') } });
        continue;
      }
      if (message.type === 'turn.completed') {
        out({ type: 'progress', note: 'codex turn completed', percent: 100 });
        finish('done', { usage: message.usage ?? null });
        continue;
      }
      if (message.type === 'error' || message.type === 'turn.failed' || message.type === 'thread.failed') {
        finish('failed', { error: String(message.error || message.message || 'codex failed') });
        continue;
      }
      out({ type: 'event', event: { type: String(message.type), payload: message } });
    }
  });
  child.stderr?.setEncoding?.('utf8');
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    stderrTail = String(chunk).slice(-800);
    process.stderr.write(String(chunk));
  });
  child.once?.('error', (error) => finish('failed', { error: `codex spawn failed: ${error.message}` }));
  child.once?.('exit', (code, signal) => {
    if (done) return;
    if (!started) finish('failed', { error: `codex exited before a session started (${code ?? signal ?? 'unknown'})${stderrTail ? `: ${stderrTail}` : ''}` });
    else finish('failed', { error: `codex exited unexpectedly (${code ?? signal ?? 'unknown'})` });
  });
  return child;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'run') {
    const child = runTurn({
      task: message.task ?? null,
      prompt: message.prompt ?? '',
      sessionRef: message.session_ref ?? null,
    });
    currentChild = child;
    return;
  }
  if (message.type === 'cancel') {
    currentChild?.kill?.();
    currentChild = null;
    out({ type: 'error', error: 'codex task cancelled' });
    return;
  }
  if (message.type === 'resume') {
    out({ type: 'error', error: 'codex exec does not support resume; the Worker fails the task closed' });
    return;
  }
  if (message.type === 'inject' || message.type === 'interaction_response') {
    out({ type: 'error', error: 'codex exec does not support mid-run inject or interaction responses' });
    return;
  }
  out({ type: 'error', error: `unknown request type: ${message.type}` });
});

let currentChild = null;
rl.on('close', () => {
  // stdin closed: wait for the in-flight turn (if any) to finish, then exit.
  // Never kill the codex child here - the Worker's JSONL pipe stays open, but
  // a one-shot test consumes the whole line and immediately hits close.
  if (currentChild) {
    currentChild.once?.('exit', () => process.exit(0));
    const guard = setTimeout(() => process.exit(0), 10 * 60 * 1000);
    guard.unref?.();
  } else {
    process.exit(0);
  }
});
