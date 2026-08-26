// index.js - Workflow Core entrypoint.
import readline from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthRepository } from './auth/repository.js';
import { CoreDatabase } from './db/core-db.js';
import { TaskRepository } from './tasks/repository.js';
import { InteractionRepository } from './interactions/repository.js';
import { WorkersRegistry } from './workers/registry.js';
import { CredentialCipher } from './workers/credential-key.js';
import { ProjectAgentRegistry } from './agents/registry.js';
import { WorkflowAgent } from './agents/workflow-agent.js';
import { createWorkerChannel } from './ws/channel.js';
import { createCoreServer } from './http/server.js';
import { WorkflowRepository } from './knowledge/repository.js';
import { FeishuClient } from './feishu/client.js';
import { FeishuService, connectFeishuWebSocket } from './feishu/service.js';
import { loadConfig } from './config.js';

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
      knowledgeRepository?.close();
      coreDatabase?.close();
      authRepository?.close();
    })();
    return shutdownPromise;
  };

  try {
    authRepository = new AuthRepository({ dataDir: config.dataDir });
    coreDatabase = new CoreDatabase({ dataDir: config.dataDir });
    const taskRepository = new TaskRepository({ coreDb: coreDatabase, claimTimeoutMs: config.claimTimeoutMs });
    const interactionRepository = new InteractionRepository({ coreDb: coreDatabase });
    const workersRegistry = new WorkersRegistry({ coreDb: coreDatabase });
    const projectAgentsRegistry = new ProjectAgentRegistry({ coreDb: coreDatabase });
    const credentialCipher = new CredentialCipher({ dataDir: config.dataDir });
    knowledgeRepository = new WorkflowRepository({ filename: config.knowledgeDb, readOnly: false });
    workflowAgent = new WorkflowAgent({ taskRepository, projectAgentsRegistry, knowledgeRepository, log });
    feishuService = config.feishu.enabled ? new FeishuService({
      client: new FeishuClient({ appId: config.feishu.appId, appSecret: config.feishu.appSecret }),
      taskRepository,
      interactionRepository,
      workerChannel: null,
      coreDb: coreDatabase,
      log,
    }) : null;
    workerChannel = createWorkerChannel({
      authRepository,
      taskRepository,
      interactionRepository,
      workersRegistry,
      feishuService,
      credentialCipher,
      log,
    });
    if (feishuService) feishuService.channel = workerChannel;
    const server = createCoreServer({
      config,
      authRepository,
      taskRepository,
      interactionRepository,
      workersRegistry,
      workerChannel,
      knowledgeRepository,
      feishuService,
      projectAgentsRegistry,
      workflowAgent,
      credentialCipher,
    });
    internal = await server.listen({ host: config.internalHost, port: config.internalPort, tls: null, surface: 'internal' });
    publicServer = await server.listen({ host: config.httpsHost, port: config.httpsPort, tls: config.tls, surface: 'public' });
    workerChannel.handleUpgrade(publicServer);
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
      authRepository,
      coreDatabase,
      knowledgeRepository,
      taskRepository,
      interactionRepository,
      workersRegistry,
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
