// index.js - worker daemon entrypoint. WFC_WORKER_TOKEN stays in the process
// environment only; it is never written to disk or logs.
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { CoreConnection } from './core-client.js';
import { DshLocal } from './dsh-local.js';
import { TaskRunner } from './runner.js';
import { WorkerStateStore } from './state-store.js';

export function loadWorkerConfig(env = process.env) {
  const coreUrl = env.WFC_CORE_URL;
  const token = env.WFC_WORKER_TOKEN;
  if (!coreUrl) throw new Error('WFC_CORE_URL is required');
  if (!token) throw new Error('WFC_WORKER_TOKEN is required (process environment only)');
  return {
    coreUrl,
    token,
    workerId: env.WFC_WORKER_ID || `worker-${os.hostname()}`,
    capabilities: (env.WFC_WORKER_CAPABILITIES || 'dsh').split(',').map((item) => item.trim()).filter(Boolean),
    maxConcurrency: Number(env.WFC_WORKER_MAX_CONCURRENCY || 2),
    dshBin: env.WFC_DSH_BIN || 'dsh',
    dshNode: env.WFC_DSH_NODE || null,
    dshHome: env.WFC_DSH_HOME || null,
    dshEndpoint: env.WFC_DSH_ENDPOINT || null, // pre-existing local DSH (tests / manual)
    stateDir: env.WFC_WORKER_STATE_DIR || path.join(os.homedir(), '.workflow-worker'),
    defaultWorkspace: env.WFC_WORKER_WORKSPACE || os.homedir(),
    version: '0.1.0',
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The DSH CLI resolves its profile root from $DSH_HOME but its session and
// state databases from their own DSH_*_DB variables (falling back to the
// account's passwd home, NOT $HOME). Every path must be pinned inside
// dshHome or the worker silently shares the central DSH's databases.
export function buildDshChildEnv(config, env = process.env) {
  const childEnv = { ...env };
  delete childEnv.WFC_WORKER_TOKEN;
  if (config.dshHome) {
    const dshRoot = `${config.dshHome}/.dsh`;
    childEnv.HOME = config.dshHome;
    childEnv.DSH_HOME = dshRoot;
    childEnv.DSH_SESSION_DB = `${dshRoot}/sessions.db`;
    childEnv.DSH_STATE_DB = `${dshRoot}/dsh-state.db`;
    childEnv.DSH_SESSION_QUERY_DB = `${dshRoot}/session-query.db`;
    childEnv.XDG_CONFIG_HOME = `${config.dshHome}/.config`;
    childEnv.XDG_DATA_HOME = `${config.dshHome}/.local/share`;
    childEnv.XDG_STATE_HOME = `${config.dshHome}/.local/state`;
  }
  return childEnv;
}

export async function startWorker(config, { dsh = null, stateStore = null, log = () => {}, pollMs } = {}) {
  const localDsh = dsh ?? new DshLocal({
    baseUrl: config.dshEndpoint,
    spawnImpl: config.dshEndpoint ? null : async () => {
      const port = await freePort();
      const command = config.dshNode || config.dshBin;
      const args = [
        ...(config.dshNode ? [config.dshBin] : []),
        '--profile', 'web', '--host', '127.0.0.1', '--port', String(port),
      ];
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildDshChildEnv(config),
      });
      child.stdout?.on('data', (chunk) => {
        const message = String(chunk).trim();
        if (message) log(`[dsh] ${message}`);
      });
      child.stderr?.on('data', (chunk) => {
        const message = String(chunk).trim();
        if (message) log(`[dsh] ${message}`);
      });
      return { port, child };
    },
    log,
  });
  await localDsh.start();
  const workerState = stateStore ?? new WorkerStateStore({ dataDir: config.stateDir });

  const core = new CoreConnection({
    url: config.coreUrl,
    token: config.token,
    workerId: config.workerId,
    register: {
      machine: os.hostname(),
      capabilities: config.capabilities,
      selector: { capabilities: config.capabilities },
      max_concurrency: config.maxConcurrency,
      version: config.version,
    },
    log,
  });

  const runner = new TaskRunner({
    core, dsh: localDsh, stateStore: workerState, defaultWorkspace: config.defaultWorkspace,
    workspaceResolver: (task) => task.brief?.workspace ?? null,
    log,
    maxSlots: config.maxConcurrency,
    ...(pollMs ? { pollMs } : {}),
  });

  // Pending approvals arrive on the local DSH's events.mux websocket; the
  // runner forwards them to the core, and core decisions come back as frames.
  if (typeof localDsh.connectApprovals === 'function') {
    localDsh.connectApprovals({
      onWaiting: (payload, rpcId) => runner.handleApprovalWaiting(payload, rpcId),
      onResolved: (payload) => log(`[runner] approval ${payload.approvalId ?? '?'} resolved by DSH (${payload.outcome ?? '?'})`),
    });
  }

  core.on('config', (payload) => core.applyConfig(payload));
  core.on('models', async (payload) => {
    try {
      await localDsh.applyModels(Array.isArray(payload.models) ? payload.models : []);
      core.send('models_ack', { revision: payload.revision ?? 0 });
    } catch (error) {
      const code = error.code ?? 'MODEL_APPLY_FAILED';
      const method = error.method ?? null;
      log(`[worker] model apply failed: ${method ? `${method} ` : ''}${code}`);
      core.send('error', {
        error: 'model apply failed', code, method,
        revision: payload.revision ?? 0,
      });
    }
  });
  core.on('dispatch', (payload) => {
    const task = payload.task ?? payload;
    runner.handleDispatch(task, { resumed: payload.resumed === true }).catch((error) => {
      log(`[worker] dispatch failed: ${error.message}`);
      core.send('task_done', {
        task_id: task.task_id, claim_token: task.claim_token, kind: 'failed',
        result: { error: error.message },
      });
    });
  });
  core.on('inject', (payload) => {
    runner.handleInject(payload.task_id, payload.content).catch((error) => log(`[worker] inject failed: ${error.message}`));
  });
  core.on('cancel', (payload) => {
    runner.handleCancel(payload.task_id).catch((error) => log(`[worker] cancel failed: ${error.message}`));
  });
  core.on('approval_result', (payload) => {
    runner.handleApprovalResult(payload).catch((error) => log(`[worker] approval result failed: ${error.message}`));
  });

  core.connect();
  let stopped = false;
  return {
    core,
    runner,
    dsh: localDsh,
    stateStore: workerState,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      core.close();
      await runner.detachAll();
      await localDsh.stop();
      workerState.close();
    },
  };
}

export async function main() {
  const config = loadWorkerConfig();
  const log = (line) => process.stdout.write(`${line}\n`);
  const worker = await startWorker(config, { log });
  const stop = async () => {
    try {
      await worker.stop();
      process.exitCode = 0;
    } catch (error) {
      console.error('[worker] shutdown failed:', error.message);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  main().catch((error) => {
    console.error('[worker] startup failed:', error.message);
    process.exit(1);
  });
}
