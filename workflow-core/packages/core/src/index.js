// index.js - Workflow Core entrypoint.
import readline from 'node:readline/promises';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuthRepository } from './auth/repository.js';
import { CoreDatabase } from './db/core-db.js';
import { TaskRepository } from './tasks/repository.js';
import { TaskCreationFacade } from './tasks/creation-facade.js';
import { InteractionRepository } from './interactions/repository.js';
import { WorkersRegistry } from './workers/registry.js';
import { CredentialCipher } from './workers/credential-key.js';
import { ServerLlm } from './ai/server-llm.js';
import { SettingsRepository } from './settings/repository.js';
import { SuggestionsRepository } from './ai/suggestions-repository.js';
import { BridgeRequestsRepository } from './bridge/requests-repository.js';
import { createBridgeService } from './bridge/service.js';
import { createPeerSyncService } from './sync/service.js';
import { createPeerSyncClient } from './sync/client.js';
import { loadSyncKeyPair } from './sync/sync-key.js';
import { ProjectAgentRegistry } from './agents/registry.js';
import { WorkflowAgent } from './agents/workflow-agent.js';
import { createWorkerChannel } from './ws/channel.js';
import { createCoreServer } from './http/server.js';
import { WorkflowRepository } from './knowledge/repository.js';
import { FeishuClient } from './feishu/client.js';
import { FeishuService, connectFeishuWebSocket } from './feishu/service.js';
import { loadConfig } from './config.js';
import { loadNodeIdentity } from './node-identity.js';

async function createAccountCli(authRepository, email, role) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const password = await rl.question('password (hidden): ', { hideEchoBack: true });
    const confirm = await rl.question('confirm (hidden): ', { hideEchoBack: true });
    if (password !== confirm) throw new Error('passwords do not match');
    const account = await authRepository.createAccount({ email, password, role });
    process.stdout.write(`account created: ${account.email} (${account.role})\n`);
  } finally {
    rl.close();
  }
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function forceCloseConnections(server) {
  server?.closeAllConnections?.();
}

function systemCheckupMetrics({ taskRepository, workersRegistry, suggestionsRepository, knowledgeRepository, peerSyncService = null }) {
  const counts = taskRepository.countsByStatus?.() ?? {};
  const recent = taskRepository.list?.({ limit: 200 }) ?? [];
  const failed = recent.filter((t) => t.status === 'failed').slice(0, 15);
  const workers = workersRegistry.list();
  const knowledge = { projects: knowledgeRepository?.listProjects?.().length ?? 0, memories: knowledgeRepository?.listMemories?.({ all: true }).length ?? 0 };
  const sync = peerSyncService?.status?.() ?? null;
  const peerSync = sync ? {
    relay: sync.relay,
    signing: sync.signing,
    headSeq: sync.head_seq,
    peers: sync.peers.map((peer) => ({ node_id: peer.node_id, status: peer.status, lastSeenAt: peer.last_seen_at })),
    inbox: sync.inbox,
  } : null;
  return { counts, failed: failed.map((t) => ({ id: t.task_id, type: t.type, project: t.project_id, error: t.result?.error ?? null, attempts: t.attempts })), workers: workers.map((w) => ({ id: w.worker_id, connected: w.connected, revoked: w.revoked, projects: (w.projects ?? []).length })), pendingSuggestions: suggestionsRepository?.stats?.().pending ?? 0, knowledge, peerSync };
}

function applySuggestion(ctx, suggestion) {
  const payload = suggestion.payload ?? {};
  if (suggestion.targetType === 'skill') {
    if (!payload.name || !payload.content) throw new Error('suggestion payload requires name and content');
    const skill = ctx.workersRegistry.upsertSkill(payload.name, payload.content);
    for (const workerId of ctx.workerChannel?.connectedWorkers?.() ?? []) ctx.workerChannel.pushConfig(workerId);
    return { applied: 'skill', name: skill.name, version: skill.version };
  }
  if (suggestion.targetType === 'knowledge') {
    if (!payload.projectId || !payload.title || !payload.content) throw new Error('suggestion payload requires projectId, title and content');
    const validTypes = ['pitfall','insight','decision','pattern','constraint'];
    const memoryType = validTypes.includes(payload.type) ? payload.type : 'insight';
    const memory = ctx.knowledgeRepository.createMemory({ id: crypto.randomUUID(), projectId: payload.projectId, type: memoryType, title: payload.title, body: payload.content, tags: ['ai-suggestion'] });
    return { applied: 'knowledge', memoryId: memory.id };
  }
  if (suggestion.targetType === 'settings') {
    const key = payload.key; if (!key) throw new Error('suggestion payload requires key');
    ctx.settingsRepository.set(key, payload.value);
    return { applied: 'settings', key };
  }
  if (suggestion.targetType === 'rule') {
    const key = payload.key ?? 'rules.custom'; if (typeof payload.rules !== 'object') throw new Error('suggestion payload requires rules object');
    ctx.settingsRepository.set(key, payload.rules);
    return { applied: 'rules', key };
  }
  throw new Error(`unsupported target type: ${suggestion.targetType}`);
}
export async function startCore(env = process.env, dependencies = {}) {
  const config = loadConfig(env);
  const log = dependencies.log ?? ((line) => process.stdout.write(`${line}\n`));
  const connectFeishu = dependencies.connectFeishu ?? connectFeishuWebSocket;
  let authRepository;
  let coreDatabase;
  let knowledgeRepository;
  let workerChannel;
  let feishuService;
  let workflowAgent;
  let peerSyncService;
  let peerSyncClient;
  let internal;
  let publicServer;
  let shutdownPromise = null;

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const listenerClosures = [closeServer(publicServer), closeServer(internal)];
      feishuService?.stop();
      workerChannel?.stop();
      forceCloseConnections(publicServer);
      forceCloseConnections(internal);
      await Promise.allSettled(listenerClosures);
      peerSyncService?.close();
      knowledgeRepository?.close();
      coreDatabase?.close();
      authRepository?.close();
    })();
    return shutdownPromise;
  };

  try {
    authRepository = new AuthRepository({ dataDir: config.dataDir });
    const nodeIdentity = loadNodeIdentity({ dataDir: config.dataDir, nodeId: config.nodeId });
    coreDatabase = new CoreDatabase({ dataDir: config.dataDir });
    const taskRepository = new TaskRepository({ coreDb: coreDatabase, claimTimeoutMs: config.claimTimeoutMs, nodeId: nodeIdentity.nodeId });
    const interactionRepository = new InteractionRepository({ coreDb: coreDatabase });
    const workersRegistry = new WorkersRegistry({ coreDb: coreDatabase });
    const bridgeRequestsRepository = new BridgeRequestsRepository({ coreDb: coreDatabase });
    bridgeRequestsRepository.pruneExpired();
    const bridgeService = createBridgeService({
      bridgeRequestsRepository,
      workersRegistry,
      taskRepository,
      interactionRepository,
      nodeId: nodeIdentity.nodeId,
      log,
    });
    const projectAgentsRegistry = new ProjectAgentRegistry({ coreDb: coreDatabase });
    const credentialCipher = new CredentialCipher({ dataDir: config.dataDir });
    const settingsRepository = new SettingsRepository({ coreDb: coreDatabase });
    const LLM_CLI_AVAILABLE = fs.existsSync("/opt/dsh8/lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
    const llmCfg = (() => {
      const saved = settingsRepository.get('llm') ?? {};
      let apiKey = config.llm?.apiKey ?? null;
      try {
        const cred = workersRegistry.listCredentials(null).find((c) => c.credentialId === 'server-llm-key');
        if (cred?.secretEncrypted) apiKey = credentialCipher.decrypt(cred.secretEncrypted);
      } catch { /* keep env fallback */ }
      const backend = saved.backend ?? 'auto';
      const useCli = backend === 'dsh-cli' || (backend === 'auto' && LLM_CLI_AVAILABLE);
      return {
        enabled: useCli || Boolean((saved.enabled ?? config.llm?.enabled ?? false) && apiKey),
        baseUrl: saved.baseUrl ?? config.llm?.baseUrl ?? null,
        model: saved.model ?? config.llm?.model ?? null,
        apiKey,
        cli: useCli ? { command: '/opt/node24/bin/node', args: ['/opt/dsh8/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'headless'], timeoutMs: 240000 } : null,
        backend: useCli ? 'dsh-cli' : 'direct',
      };
    })();
    log(`[core] server-llm: cli=${LLM_CLI_AVAILABLE} enabled=${llmCfg.enabled} backend=${llmCfg.backend}`);
    const serverLlm = new ServerLlm({
      enabled: llmCfg.enabled,
      baseUrl: llmCfg.baseUrl,
      apiKey: llmCfg.apiKey,
      cli: llmCfg.cli,
      model: llmCfg.model,
      log,
    });
    serverLlm.reload = async () => {
      const next = settingsRepository.get('llm') ?? {};
      let key = config.llm?.apiKey ?? null;
      try {
        const cred = workersRegistry.listCredentials(null).find((c) => c.credentialId === 'server-llm-key');
        if (cred?.secretEncrypted) key = credentialCipher.decrypt(cred.secretEncrypted);
      } catch { /* keep */ }
      serverLlm.update({
        enabled: next.enabled ?? serverLlm.enabled,
        baseUrl: next.baseUrl ?? serverLlm.baseUrl,
        model: next.model ?? serverLlm.model,
        apiKey: key,
      });
    };
    knowledgeRepository = new WorkflowRepository({ filename: config.knowledgeDb, readOnly: false });
    const syncKeyPair = loadSyncKeyPair({ dataDir: config.dataDir });
    peerSyncService = createPeerSyncService({
      coreDb: coreDatabase,
      nodeId: nodeIdentity.nodeId,
      taskRepository,
      knowledgeRepository,
      signingKey: { privateKey: syncKeyPair.privateKey, publicKeyBase64: syncKeyPair.publicKeyBase64 },
      relay: config.peerRelay,
    });
    const taskCreationFacade = new TaskCreationFacade({ taskRepository, knowledgeRepository, nodeId: nodeIdentity.nodeId });
    workflowAgent = new WorkflowAgent({ taskRepository, taskCreationFacade, projectAgentsRegistry, knowledgeRepository, log });
    feishuService = config.feishu.enabled ? new FeishuService({
      client: new FeishuClient({ appId: config.feishu.appId, appSecret: config.feishu.appSecret }),
      taskRepository,
      taskCreationFacade,
      interactionRepository,
      workerChannel: null,
      coreDb: coreDatabase,
      log,
    }) : null;
    workerChannel = createWorkerChannel({
      authRepository,
      taskRepository,
      taskCreationFacade,
      interactionRepository,
      workersRegistry,
      feishuService,
      credentialCipher,
      serverLlm,
      knowledgeRepository,
      nodeId: nodeIdentity.nodeId,
      log,
    });
    if (feishuService) feishuService.channel = workerChannel;
    const suggestionsRepository = new SuggestionsRepository({ coreDb: coreDatabase });
    const applySuggestionBound = (suggestion) => applySuggestion({ workersRegistry, knowledgeRepository, settingsRepository, workerChannel }, suggestion);
    const runCheckup = async () => {
      // Role-session pool: carry the previous round summary as context
      const role = 'checkup';
      const sessions = settingsRepository.get('ai.sessions') ?? {};
      const stat = sessions[role] ?? { rounds: 0, baseline: null, lastAt: null };
      if (Number(stat.rounds) >= 20) {
        stat.baseline = null; stat.rounds = 0;
      }
      const context = stat.baseline
        ? 'Previous round summary (use as context, do not repeat it):\n' + String(stat.baseline).slice(0, 2000)
        : 'This is the first round for this role.';
      const metrics = systemCheckupMetrics({ taskRepository, workersRegistry, suggestionsRepository, knowledgeRepository, peerSyncService });
      const recent = suggestionsRepository.list({});
      const metrics2 = {
        ...metrics,
        recentDecisions: {
          approvedTitles: recent.filter((y) => y.status === 'approved').slice(0, 10).map((y) => ({ title: y.title, type: y.targetType, appliedAs: y.reason || '' })),
          ignoredTitles: recent.filter((y) => y.status === 'ignored').slice(0, 10).map((y) => y.title),
        },
      };
      if (!serverLlm?.status?.enabled) return { ok: false, reason: 'server LLM is not enabled (configure it in Server Settings)' };
      const text = await serverLlm.ask([
        { role: 'system', content: 'You are the Workflow system intelligence agent. Look at the system checkup metrics, find where the workflow is not intelligent, and propose actionable improvements. Output ONLY a JSON array; each item: {target_type,title,summary,payload}; target_type is one of skill|knowledge|settings|rule. skill payload: {name,content (Markdown)}; knowledge: {projectId,title,type,content}; settings: {key,value}; rule: {key,rules}. No suggestions -> []. No explanations.' },
        { role: 'system', content: 'recentDecisions feedback: previously approved suggestions were applied to the system and ignored ones were rejected by the admin. Consider this feedback - do not re-propose ignored suggestions; build on approved ones; use appliedAs to see what an approval actually changed.' },
        { role: 'system', content: context },
        { role: 'user', content: JSON.stringify(metrics2) },
      ]);
      let items = [];
      let text0 = String(text ?? '').trim();
      const fence = text0.split(String.fromCharCode(96,96,96));
      if (fence.length > 2) text0 = fence[1].trim();

      const i = text0.indexOf('['); const j = text0.lastIndexOf(']');
      items = i >= 0 && j > i ? JSON.parse(text0.slice(i, j + 1)) : [];
      const created = [];
      for (const item of Array.isArray(items) ? items : []) {
        if (!item?.target_type || !item?.title) continue;
        if (!['skill','knowledge','settings','rule'].includes(item.target_type)) continue;
        created.push(suggestionsRepository.create({ targetType: item.target_type, title: String(item.title).slice(0,200), summary: String(item.summary ?? '').slice(0,1000), payload: item.payload ?? {}, metrics: metrics2 }));
      }
      stat.rounds += 1;
      stat.lastAt = new Date().toISOString();
      stat.baseline = String(text0 ?? '').slice(0, 1500) || stat.baseline;
      settingsRepository.set('ai.sessions', { ...sessions, [role]: stat });
      return { ok: true, generated: created.length, suggestions: created.map((c) => ({ id: c.suggestionId, title: c.title })) };
    };
    const server = createCoreServer({
      config,
      nodeId: nodeIdentity.nodeId,
      authRepository,
      taskRepository,
      taskCreationFacade,
      interactionRepository,
      workersRegistry,
      bridgeService,
      peerSyncService,
      workerChannel,
      knowledgeRepository,
      feishuService,
      projectAgentsRegistry,
      workflowAgent,
      credentialCipher,
      settingsRepository,
      serverLlm,
      suggestionsRepository,
      runCheckup,
      applySuggestion: applySuggestionBound,
    });
    internal = await server.listen({ host: config.internalHost, port: config.internalPort, tls: null, surface: 'internal' });
    publicServer = await server.listen({ host: config.httpsHost, port: config.httpsPort, tls: config.tls, surface: 'public' });
    workerChannel.handleUpgrade(publicServer);
    if (config.peers.length) {
      peerSyncClient = createPeerSyncClient({
        peerSyncService,
        peers: config.peers,
        nodeId: nodeIdentity.nodeId,
        intervalMs: config.peerSyncIntervalMs,
        log,
      });
      peerSyncClient.start();
      log(`[workflow-core] peer sync: pulling from ${config.peers.map((peer) => peer.node_id).join(', ')}`);
    }
    if (feishuService) {
      await connectFeishu(feishuService, {
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        connectTimeoutMs: config.feishu.connectTimeoutMs,
        log,
      });
    }
    log(
      `[workflow-core] internal http://${config.internalHost}:${config.internalPort}`
      + ` public ${config.tls ? 'https' : 'http'}://${config.httpsHost}:${config.httpsPort}`,
    );
    return {
      config,
      nodeIdentity,
      authRepository,
      coreDatabase,
      knowledgeRepository,
      taskRepository,
      interactionRepository,
      workersRegistry,
      bridgeRequestsRepository,
      bridgeService,
      projectAgentsRegistry,
      workflowAgent,
      feishuService,
      internal,
      publicServer,
      shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  if (argv[0] === 'create-account') {
    const config = loadConfig(env);
    const authRepository = new AuthRepository({ dataDir: config.dataDir });
    try {
      const email = argv[1];
      const role = argv[2] || 'admin';
      if (!email) throw new Error('usage: create-account <email> [role]');
      await createAccountCli(authRepository, email, role);
      return null;
    } finally {
      authRepository.close();
    }
  }

  const runtime = await startCore(env, dependencies);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.shutdown();
      process.exitCode = 0;
    } catch (error) {
      console.error('[workflow-core] shutdown failed:', error);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return runtime;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error('[workflow-core] startup failed:', error);
    process.exitCode = 1;
  });
}
