// index.js - generic Workflow Worker daemon.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { CoreConnection } from './core-client.js';
import { RunStore } from './run-store.js';
import { ConfigStore } from './config-store.js';
import { ProjectRegistry } from './project-registry.js';
import { BackendRegistry } from './backend-registry.js';
import { EnvironmentStore } from './environment-store.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { InteractionBridge } from './interaction-bridge.js';
import { TaskRunner } from './runner.js';
import { JsonlCliAdapter } from './adapters/jsonl.js';
import { OmpRpcBackend } from './backends/omp-rpc.js';
import { CredentialStore } from './credential-store.js';
import { KnowledgeBridgeServer } from './knowledge-bridge.js';

export function loadWorkerConfig(env = process.env) {  if (!env.WFC_CORE_URL) throw new Error('WFC_CORE_URL is required');
  if (!env.WFC_WORKER_TOKEN) throw new Error('WFC_WORKER_TOKEN is required (process environment only)');
  return {
    coreUrl: env.WFC_CORE_URL, token: env.WFC_WORKER_TOKEN,
    workerId: env.WFC_WORKER_ID || `worker-${os.hostname()}`,
    capabilities: (env.WFC_WORKER_CAPABILITIES || 'workflow-jsonl').split(',').map((x) => x.trim()).filter(Boolean),
    projects: [], backends: [], maxConcurrency: Number.isInteger(Number(env.WFC_WORKER_MAX_CONCURRENCY)) && Number(env.WFC_WORKER_MAX_CONCURRENCY) > 0 ? Number(env.WFC_WORKER_MAX_CONCURRENCY) : 2,
    stateDir: env.WFC_WORKER_STATE_DIR || path.join(os.homedir(), '.workflow-worker'), version: '0.2.0',
    jsonlCommand: env.WFC_JSONL_COMMAND || null,
    jsonlArgs: (env.WFC_JSONL_ARGS || '').split('|').filter(Boolean),
    knowledgePort: env.WFC_KNOWLEDGE_PORT || 0,
  };
}

// Reconcile local run state at startup. Terminal runs whose stable frame is
// still in the outbox will be replayed after reconnect; runs whose frame was
// already acknowledged are dropped because Core already has the terminal state.
export function recoverPendingRuns({ runStore, log = () => {} } = {}) {
  if (!runStore) throw new TypeError('runStore is required');
  let dropped = 0;
  let kept = 0;
  for (const run of runStore.list()) {
    if (run.phase !== 'completion_pending') continue;
    if (!run.terminalFrameId || !runStore.hasFrame(run.terminalFrameId)) {
      runStore.delete(run.taskId);
      log(`[worker] dropped ${run.taskId}: terminal frame ${run.terminalFrameId ?? '(none)'} not pending`);
      dropped += 1;
      continue;
    }
    kept += 1;
  }
  return { dropped, kept };
}

function jsonlBackend(descriptor, log) {
  return new JsonlCliAdapter({ command: descriptor.command, args: descriptor.args ?? [], log });
}

function backendFor(descriptor, log) {
  if (descriptor.kind === 'omp-rpc') return new OmpRpcBackend({
    command: descriptor.command, args: descriptor.args ?? [], log,
    userProfile: process.env.WFC_OMP_USER_PROFILE || null,
    model: process.env.WFC_OMP_MODEL || null,
    provider: process.env.WFC_OMP_PROVIDER || null,
  });
  return jsonlBackend(descriptor, log);
}

// Device-first bootstrap: when no token is configured the Worker registers
// itself with a device fingerprint and waits for admin approval on the Core
// console. Once approved it picks up a long-lived token via /api/v1/devices/poll
// and persists it DPAPI-encrypted (via the start script) for future runs.
export async function bootstrapDevice({ coreUrl, workerId, stateDir, log = () => {} }) {
  const secretFile = path.join(stateDir, 'device-secret');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let secret = '';
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* first run */ }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    log('[worker] created device identity');
  }
  const fingerprint = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 32);
  const base = coreUrl.endsWith('/') ? coreUrl.slice(0, -1) : coreUrl;
  const register = await fetch(base + '/api/v1/devices/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worker_id: workerId, machine: os.hostname(), fingerprint }),
  }).catch(() => null);
  if (!register || !register.ok) { log('[worker] device registration failed (Core unreachable?)'); throw new Error('device registration failed: Core unreachable'); }
  log(`[worker] device ${workerId} registered; awaiting admin approval on the Core console (设备授权)`);
  let pending = 0;
  const started = Date.now();
  while (Date.now() - started < 24 * 60 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch(base + '/api/v1/devices/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: workerId, fingerprint }),
    }).catch(() => null);
    if (!poll || !poll.ok) continue;
    const result = await poll.json();
    if (result.state === 'authorized' && result.token) {
      const tokenFile = path.join(stateDir, 'bootstrap-token.json');
      fs.writeFileSync(tokenFile, JSON.stringify({ token: result.token, worker_id: workerId }, null, 2), { mode: 0o600 });
      log(`[worker] approved! token stored at ${tokenFile}; restarting worker once`);
      return { token: result.token, tokenFile };
    }
    if (result.state === 'revoked') throw new Error('device registration was revoked by admin');
    pending += 1;
    if (pending % 12 === 0) log(`[worker] still awaiting approval (${Math.floor((Date.now() - started) / 60000)} min)`);
  }
  throw new Error('device approval timed out after 24h');
}

export async function startWorker(config, { log = () => {}, WebSocketImpl, stateStore = null, backends = null, projects = null } = {}) {
  if (!config.token) {
    const booted = await bootstrapDevice({ coreUrl: config.coreUrl, workerId: config.workerId, stateDir: config.stateDir, log });
    config.token = booted.token;
  }
  const runStore = stateStore ?? new RunStore({ dataDir: config.stateDir });  const { dropped, kept } = recoverPendingRuns({ runStore, log });
  if (dropped || kept) log(`[worker] recovered runs: ${kept} pending, ${dropped} dropped`);
  const configStore = new ConfigStore({ dataDir: config.stateDir });
  let saved = configStore.get();
  if (saved.backends.length === 0 && config.jsonlCommand) {
    configStore.upsertBackend({
      kind: 'workflow-jsonl',
      command: config.jsonlCommand,
      args: config.jsonlArgs,
      enabled: true,
      capabilities: ['run', 'resume', 'inject', 'cancel', 'interaction'],
    });
    saved = configStore.get();
  }
  const projectRegistry = projects ?? (() => {
    const registry = new ProjectRegistry({});
    const entries = saved.projects.length ? saved.projects : config.projects;
    for (const project of entries) {
      try { registry.add(project); } catch (error) {
        log(`[worker] skipping project ${project.projectId}: ${error.message}`);
      }
    }
    return registry;
  })();
  const backendRegistry = backends ?? new BackendRegistry({ log });
  for (const descriptor of saved.backends) {
    if (descriptor.enabled === false || !descriptor.command) continue;
    if (backendRegistry.get(descriptor.kind)) continue;
    backendRegistry.register(descriptor.kind, backendFor(descriptor, log), {
      kind: descriptor.kind,
      capabilities: descriptor.capabilities ?? [],
      version: '1',
    });
  }
  await backendRegistry.startAll({ stateDir: config.stateDir, projectRegistry });
  const environmentStore = new EnvironmentStore({ dataDir: config.stateDir });
  const supervisor = new ProcessSupervisor({ log });
  const registeredBackends = backendRegistry.list();
  const capabilities = [...new Set(registeredBackends.flatMap((backend) => backend.capabilities ?? []))];
  const core = new CoreConnection({ url: config.coreUrl, token: config.token, workerId: config.workerId, runStore, WebSocketImpl,
    register: { machine: os.hostname(), capabilities, projects: projectRegistry.list().map((p) => p.projectId), backends: registeredBackends, max_concurrency: config.maxConcurrency, version: config.version }, log });
  const interactions = new InteractionBridge({ core, backendRegistry, log });
  const runner = new TaskRunner({ core, backendRegistry, runStore, projectRegistry, interactionBridge: interactions, log, maxSlots: config.maxConcurrency });
  const credentialStore = new CredentialStore({ dataDir: config.stateDir });
  const knowledgeBridge = new KnowledgeBridgeServer({ coreUrl: config.coreUrl, coreToken: config.token, stateDir: config.stateDir, port: Number(config.knowledgePort || 0), log });
  await knowledgeBridge.start();
  let draining = false;
  const drain = {
    active: () => draining,
    enter: async () => { draining = true; core.send('status', { state: 'draining' }, { durable: false }); return true; },
    exit: async () => { draining = false; core.send('status', { state: 'running' }, { durable: false }); return true; },
  };
  core.on('config', (payload) => {
    core.applyConfig(payload);
    try {
      if (applyServerConfig({ configStore, projectRegistry, backendRegistry, environmentStore, credentialStore, drain, log, core }, payload)) {
        const backends = backendRegistry.list();
        core.send('register', {
          ...core.register,
          worker_id: core.workerId,
          projects: projectRegistry.list().map((p) => p.projectId),
          backends,
          capabilities: [...new Set(backends.flatMap((b) => b.capabilities ?? []))],
        }, { durable: false });
      }
    } catch (error) {
      log(`[worker] server config apply failed: ${error.message}`);
    }
  });
  core.on('dispatch', (payload) => {
    if (draining) return;
    runner.handleDispatch(payload.task ?? payload, { resumed: payload.resumed === true }).catch((error) => log(`[worker] dispatch failed: ${error.message}`));
  });
  core.on('inject', (payload) => runner.handleInject(payload.task_id, payload.content));
  core.on('cancel', (payload) => runner.handleCancel(payload.task_id));
  core.on('interaction_response', (payload) => runner.handleInteractionResponse(payload));
  core.on('interaction_cancel', (payload) => runner.handleInteractionCancel(payload));
  core.connect();
  let stopped = false;
  return { core, runner, runStore, projectRegistry, backendRegistry, environmentStore, supervisor, credentialStore, configStore, knowledgeBridge, drain, stop: async () => { if (stopped) return; stopped = true; await knowledgeBridge.stop(); core.close(); await runner.detachAll(); await backendRegistry.dispose(); await supervisor.stopAll(); runStore.close(); } };
}

export { CredentialStore } from './credential-store.js';

export async function main() { const worker = await startWorker(loadWorkerConfig(), { log: (line) => process.stdout.write(`${line}\n`) }); const stop = () => worker.stop().catch((error) => { console.error(error); process.exitCode = 1; }); process.once('SIGINT', stop); process.once('SIGTERM', stop); }

// Applies management decisions delivered in the Core `config` frame: server
// project/backend/environment config, delegated credentials, and revocation.
function applyServerConfig({ configStore, projectRegistry, backendRegistry, environmentStore, credentialStore, drain, log }, payload) {
  const serverConfig = payload.server_config;
  let changed = false;
  if (serverConfig && typeof serverConfig === 'object') {
    if (serverConfig.projects && Array.isArray(serverConfig.projects)) {
      const before = projectRegistry.list().map((p) => p.projectId).sort().join(',');
      for (const project of serverConfig.projects) {
        const entry = typeof project === 'string' ? { projectId: project } : project;
        if (!entry?.projectId) continue;
        const registered = projectRegistry.list().find((existing) => existing.projectId === entry.projectId);
        if (!entry.root && !registered) {
          log(`[worker] server project ${entry.projectId} has no root and is not registered locally; skipping`);
          continue;
        }
        if (!entry.root && registered) {
          try { projectRegistry.add(registered); } catch { /* already there */ }
          continue;
        }
        try {
          projectRegistry.add(entry);
          if (!configStore.get().projects.some((existing) => existing.projectId === entry.projectId)) configStore.addProject(entry);
          log(`[worker] registered server project ${entry.projectId} -> ${entry.root}`);
        } catch (error) {
          log(`[worker] skip project ${entry.projectId}: ${error.message}`);
        }
      }
      const after = projectRegistry.list().map((p) => p.projectId).sort().join(',');
      if (before !== after) changed = true;
      log(`[worker] applied server projects: ${after || '(none)'}`);
    }
    if (serverConfig.backends && Array.isArray(serverConfig.backends)) {
      const before = backendRegistry.kinds().sort().join(',');
      const wanted = serverConfig.backends.filter((b) => b?.kind && b.enabled !== false);
      for (const kind of backendRegistry.kinds()) {
        if (!wanted.some((b) => b.kind === kind)) backendRegistry.unregister(kind);
      }
      for (const backend of wanted) {
        if (backendRegistry.get(backend.kind)) continue;
        try {
          backendRegistry.register(backend.kind, backendFor(backend, log), { kind: backend.kind, capabilities: backend.capabilities ?? [], version: '1' });
        } catch (error) { log(`[worker] skip backend ${backend.kind}: ${error.message}`); }
      }
      const after = backendRegistry.kinds().sort().join(',');
      if (before !== after) changed = true;
      log(`[worker] applied server backends: ${after || '(none)'}`);
    }
    if (serverConfig.environment && typeof serverConfig.environment === 'object') {
      for (const [name, vars] of Object.entries(serverConfig.environment)) {
        if (vars === null) environmentStore.delete(name);
        else if (vars && typeof vars === 'object') environmentStore.set(name, { vars });
      }
    }
  }
  if (Array.isArray(payload.credentials)) {
    for (const credential of payload.credentials) {
      if (!credential?.credentialId) continue;
      try {
        if (credential.value && typeof credential.value === 'string') {
          credentialStore.set(credential.credentialId, { name: credential.name ?? credential.credentialId, provider: 'core', value: credential.value, metadata: credential.metadata ?? {} });
        } else if (credential.reference) {
          credentialStore.set(credential.credentialId, { name: credential.name ?? credential.credentialId, provider: 'core', reference: credential.reference, metadata: credential.metadata ?? {} });
        }
      } catch (error) { log(`[worker] credential ${credential.credentialId} apply failed: ${error.message}`); }
    }
    log(`[worker] applied ${payload.credentials.length} delegated credentials`);
  }
  if (Array.isArray(payload.skills)) {
    const base = path.join(os.homedir(), '.agents', 'workflow', 'skills');
    fs.mkdirSync(base, { recursive: true, mode: 0o755 });
    for (const skill of payload.skills) {
      const safe = String(skill.name ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
      if (!safe) continue;
      fs.writeFileSync(path.join(base, `${safe}.md`), String(skill.content ?? ''), { mode: 0o644 });
    }
    log(`[worker] applied ${payload.skills.length} workflow skills -> ${base}`);
  }
  if (payload.revoked) {
    log('[worker] revoked by server; uninstalling local scheduled task and exiting');
    drain.enter();
    selfUninstall(log);
  }
  return changed;
}

function selfUninstall(log) {
  const taskName = process.env.WFC_WORKER_TASK_NAME || 'Workflow Core Worker';
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Stop-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ], { windowsHide: true, stdio: 'ignore' });
    child.once?.('exit', () => process.exit(0));
  } catch { /* best effort */ }
  setTimeout(() => process.exit(0), 5000);
  log(`[worker] self-uninstall requested for task ${taskName}`);
}
if (process.argv[1]?.endsWith('index.js')) main().catch((error) => { console.error(`[worker] startup failed: ${error.message}`); process.exit(1); });
