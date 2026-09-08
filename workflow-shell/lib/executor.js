// lib/executor.js - the local Agent Runtime, supervised by the shell.
//
// The shell does not execute anything itself: it starts the Worker, which is
// the component that owns the backend contract, claim leases and result
// reporting. The shell's job is to keep exactly one such process alive and to
// hand it credentials in memory rather than on disk.
const { spawn } = require('node:child_process');

// The Worker requires Node 24 (node:sqlite); Electron's bundled runtime is
// older, so the executor always runs on an explicit Node binary.
const NODE_BIN = process.env.WORKFLOW_NODE_BIN || 'node';
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 5_000;

function createExecutor({ entry, log = () => {} } = {}) {
  let child = null;
  let restarts = 0;
  let stopped = true;
  let restartTimer = null;
  let status = { running: false, pid: null, startedAt: null, restarts: 0, lastError: null };

  function snapshot() {
    return { ...status, restarts };
  }

  function launch({ serverUrl, token, workerId, backendCommand, backendArgs = [] }) {
    const env = {
      ...process.env,
      WFC_CORE_URL: serverUrl,
      ...(token ? { WFC_WORKER_TOKEN: token } : {}),
      ...(workerId ? { WFC_WORKER_ID: workerId } : {}),
      // A local runtime is whatever CLI the user configured; the shell does not
      // assume a product.
      ...(backendCommand ? { WFC_JSONL_COMMAND: backendCommand, WFC_JSONL_ARGS: backendArgs.join('|') } : {}),
    };
    // Not process.execPath: Electron bundles an older Node without node:sqlite,
    // which the Worker needs. The executor therefore runs on a real Node
    // runtime, configured explicitly or found on PATH.
    child = spawn(NODE_BIN, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    status = { running: true, pid: child.pid ?? null, startedAt: new Date().toISOString(), restarts, lastError: null };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => log(`[executor] ${String(chunk).trimEnd()}`));
    child.stderr?.on('data', (chunk) => log(`[executor:err] ${String(chunk).trimEnd()}`));
    child.once('error', (error) => {
      status = { ...status, running: false, lastError: error.message };
      log(`[executor] failed to start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      child = null;
      status = { ...status, running: false, pid: null, lastError: code === 0 ? null : `exit ${code ?? signal}` };
      log(`[executor] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      // A crash loop must not become an infinite loop: give up after a few tries.
      if (!stopped && restarts < MAX_RESTARTS) {
        restarts += 1;
        log(`[executor] restarting (${restarts}/${MAX_RESTARTS})`);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (!stopped && !child) launch({ serverUrl, token, workerId, backendCommand, backendArgs });
        }, RESTART_DELAY_MS);
        restartTimer.unref?.();
      }
    });
    return snapshot();
  }

  function start(options) {
    if (child) return snapshot();
    if (!entry) {
      status = { ...status, running: false, lastError: 'worker entry not configured' };
      return snapshot();
    }
    stopped = false;
    restarts = 0;
    return launch(options);
  }

  function stop() {
    stopped = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      child.kill();
      child = null;
    }
    status = { ...status, running: false, pid: null };
    return snapshot();
  }

  return { start, stop, snapshot, isRunning: () => Boolean(child) };
}

module.exports = { createExecutor, NODE_BIN };
