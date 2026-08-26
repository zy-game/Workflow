// omp-json-bridge.mjs - JSONL bridge wrapping `omp -p --mode json` (the
// documented headless output mode). Speaks the Workflow JSONL backend
// contract: requests are JSON lines on stdin (run), events/results are JSON
// lines on stdout (session/event/progress/result/error). Mid-run inject,
// interaction responses and resume are not supported by one-shot mode and are
// reported as errors so the Worker fails those tasks closed.
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const MAX_LINE_BYTES = 1024 * 1024;

function ompEntry() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js'),
    path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'omp.exe'),
  ];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return null;
}

function bunEntry() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
    path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
  ];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return null;
}

function out(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let currentChild = null;

function runTurn({ task, prompt }) {
  const bun = bunEntry();
  const cli = ompEntry();
  if (!bun || !cli) {
    out({ type: 'error', error: 'omp executable not found' });
    return null;
  }
  const args = [cli, '-p', '--mode', 'json', '--profile', 'wfc-worker', '--model', 'deepseek/deepseek-v4-flash-vision-exp'];
  args.push(String(prompt || task?.brief?.goal || task?.type || ''));
  const child = spawn(bun, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });
  let buffer = '';
  let sessionRef = null;
  let assistantFull = null;
  let lastText = null;
  let thinkingBuffer = '';
  let turnNo = 0;
  let done = false;
  const finish = (kind, result) => {
    if (done) return;
    done = true;
    out({ type: 'result', kind, session_ref: sessionRef, result: result ?? {} });
  };
  const emit = (type, data) => out({ type: 'event', event: { type, data } });
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    if (buffer.length > MAX_LINE_BYTES) {
      finish('failed', { error: 'omp output exceeded 1 MiB' });
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
      if (message.type === 'session') {
        sessionRef = message.id ?? null;
        out({ type: 'session', session_ref: sessionRef });
        continue;
      }
      if (message.type === 'agent_start' || message.type === 'turn_start') {
        if (message.type === 'turn_start') turnNo += 1;
        out({ type: 'progress', note: message.type === 'turn_start' ? `第 ${turnNo} 回合` : 'agent_started', percent: 10 });
        continue;
      }
      if (message.type === 'message_start') {
        if (message.message?.role === 'assistant') {
          for (const part of message.message.content ?? []) {
            if (part?.type === 'text') continue;
            if (part?.type === 'thinking' || part?.type === 'reasoning') continue;
            if (part?.type === 'tool_use') {
              emit('tool/call', { tool: String(part.name ?? 'tool'), args: part.input ?? {} });
            }
          }
        }
        continue;
      }
      if (message.type === 'message_update') {
        const kind = message.assistantMessageEvent?.type ?? '';
        if (kind === 'text_delta') {
          emit('assistant/chunk', { kind, text: message.assistantMessageEvent.delta ?? '' });
        } else if (kind === 'thinking_delta') {
          thinkingBuffer += message.assistantMessageEvent.delta ?? '';
          emit('assistant/chunk', { kind, text: message.assistantMessageEvent.delta ?? '' });
        }
        continue;
      }
      if (message.type === 'message_end') {
        if (message.message?.role === 'assistant') {
          const parts = [];
          let text = '';
          let reasoning = '';
          for (const part of message.message.content ?? []) {
            if (part?.type === 'text' && typeof part.text === 'string') {
              parts.push({ type: 'text', text: part.text });
              text += part.text;
            } else if ((part?.type === 'thinking' || part?.type === 'reasoning') && typeof part.text === 'string') {
              parts.push({ type: 'reasoning', text: part.text });
              reasoning += part.text;
            } else if (part?.type === 'tool_use') {
              emit('tool/call', { tool: String(part.name ?? 'tool'), args: part.input ?? {} });
            }
          }
          if (!reasoning && thinkingBuffer) {
            parts.push({ type: 'reasoning', text: thinkingBuffer });
            reasoning = thinkingBuffer;
          }
          thinkingBuffer = '';
          assistantFull = { text, reasoning };
          lastText = text;
          if (text || reasoning) emit('assistant/message', { message: { content: parts } });
        }
        continue;
      }
      if (message.type === 'tool_execution_start') {
        const d = message.data ?? message.payload ?? message;
        emit('tool/call', { tool: String(d.toolName ?? 'tool'), args: d.args ?? {} });
        continue;
      }
      if (message.type === 'tool_execution_update') continue;
      if (message.type === 'tool_execution_end') {
        const d = message.data ?? message.payload ?? message;
        const text = ((d.result?.content ?? []).filter((x) => x?.type === 'text').map((x) => x.text ?? '').join('\n')) || JSON.stringify(d.result ?? {}).slice(0, 400);
        emit('tool/result', { text, status: d.isError ? 'error' : 'ok' });
        continue;
      }
      if (message.type === 'turn_end') {
        emit('turn/end', { reason: { kind: 'completed' } });
        continue;
      }
      if (message.type === 'agent_end') {
        out({ type: 'progress', note: 'agent_ended', percent: 100 });
        finish('done', { text: lastText ?? assistantFull?.text ?? null, reasoning: assistantFull?.reasoning ?? null });
        continue;
      }
      if (message.type === 'error' && message.message) {
        finish('failed', { error: String(message.message) });
        continue;
      }
      if (message.type !== 'advisor_cost_changed') {
        emit(String(message.type), { payload: message });
      }
    }
  });
  child.stderr?.setEncoding?.('utf8');
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    stderrTail = String(chunk).slice(-800);
    process.stderr.write(String(chunk));
  });
  child.once?.('error', (error) => finish('failed', { error: `omp spawn failed: ${error.message}` }));
  child.once?.('exit', (code, signal) => {
    if (done) return;
    finish('failed', { error: `omp exited before completion (${code ?? signal ?? 'unknown'})${stderrTail ? `: ${stderrTail}` : ''}` });
  });
  return child;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'run') {
    currentChild = runTurn({ task: message.task ?? null, prompt: message.prompt ?? '' });
    return;
  }
  if (message.type === 'cancel') {
    currentChild?.kill?.();
    currentChild = null;
    out({ type: 'error', error: 'omp task cancelled' });
    return;
  }
  if (message.type === 'resume' || message.type === 'inject' || message.type === 'interaction_response') {
    out({ type: 'error', error: 'omp one-shot json mode does not support this request; the Worker fails the task closed' });
    return;
  }
  out({ type: 'error', error: `unknown request type: ${message.type}` });
});
rl.on('close', () => {
  if (currentChild) {
    currentChild.once?.('exit', () => process.exit(0));
    const guard = setTimeout(() => process.exit(0), 10 * 60 * 1000);
    guard.unref?.();
  } else {
    process.exit(0);
  }
});
