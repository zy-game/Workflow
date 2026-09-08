// config.js - validated environment-driven configuration.
import path from 'node:path';
import { NODE_ID_PATTERN } from './node-identity.js';

function text(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Extra origins allowed to call the HTTP API cross-origin (desktop shells,
// local dev servers). Comma-separated; must include the scheme.
function corsOrigins(env, name) {
  const raw = text(env, name);
  if (raw === null) return [];
  return [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))].map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      throw new Error(`${name} entries must be absolute origins: ${origin}`);
    }
  });
}

// Peers are configured as a JSON array because each entry carries three
// related values; the sync token is provisioned by the remote peer and only
// ever travels through environment/system credential channels.
function peers(env, name) {
  const raw = text(env, name);
  if (raw === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed.map((entry, index) => {
    const label = `${name}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    const nodeId = String(entry.node_id ?? '');
    if (!NODE_ID_PATTERN.test(nodeId)) throw new Error(`${label}.node_id must match ^[a-z][a-z0-9._-]{2,63}$`);
    let endpoint;
    try {
      endpoint = new URL(String(entry.endpoint ?? ''));
    } catch {
      throw new Error(`${label}.endpoint must be an absolute http(s) URL`);
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      throw new Error(`${label}.endpoint must be an absolute http(s) URL`);
    }
    const token = String(entry.token ?? '');
    if (!token) throw new Error(`${label}.token is required`);
    if (entry.pull != null && typeof entry.pull !== 'boolean') throw new Error(`${label}.pull must be a boolean`);
    if (entry.push != null && typeof entry.push !== 'boolean') throw new Error(`${label}.push must be a boolean`);
    let origins = [];
    if (entry.origins != null) {
      if (!Array.isArray(entry.origins)) throw new Error(`${label}.origins must be an array of node ids`);
      origins = [...new Set(entry.origins.map((origin) => {
        const originId = String(origin ?? '');
        if (!NODE_ID_PATTERN.test(originId)) throw new Error(`${label}.origins entries must match ^[a-z][a-z0-9._-]{2,63}$`);
        return originId;
      }))];
    }
    return { node_id: nodeId, endpoint: endpoint.origin, token, pull: entry.pull !== false, push: entry.push === true, origins };
  });
}

function integer(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = text(env, name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function flag(env, name, fallback = false) {
  const raw = text(env, name);
  if (raw === null) return fallback;
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new Error(`${name} must be 0 or 1`);
}

function stringArray(env, name) {
  const raw = text(env, name);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function oneOf(env, name, allowed, fallback) {
  const raw = text(env, name);
  if (raw === null) return fallback;
  if (!allowed.includes(raw)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return raw;
}

function loopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function loadConfig(env = process.env) {
  const dataDirValue = text(env, 'WFC_DATA_DIR');
  if (!dataDirValue) throw new Error('WFC_DATA_DIR is required');
  const dataDir = path.resolve(dataDirValue);

  const cert = text(env, 'WFC_TLS_CERT');
  const key = text(env, 'WFC_TLS_KEY');
  if (Boolean(cert) !== Boolean(key)) {
    throw new Error('WFC_TLS_CERT and WFC_TLS_KEY must be configured together');
  }
  const tls = cert && key ? { cert, key } : null;
  const allowPlainHttp = flag(env, 'WFC_ALLOW_PLAIN_HTTP');
  if (!tls && !allowPlainHttp) {
    throw new Error('WFC_TLS_CERT and WFC_TLS_KEY are required (or set WFC_ALLOW_PLAIN_HTTP=1 for loopback testing)');
  }
  const httpsHost = text(env, 'WFC_HTTPS_HOST') || (allowPlainHttp ? '127.0.0.1' : '0.0.0.0');
  if (!tls && !loopbackHost(httpsHost)) {
    throw new Error('WFC_ALLOW_PLAIN_HTTP=1 may only bind WFC_HTTPS_HOST to a loopback address');
  }

  const appId = text(env, 'WFC_FEISHU_APP_ID');
  const appSecret = text(env, 'WFC_FEISHU_APP_SECRET');
  if (Boolean(appId) !== Boolean(appSecret)) {
    throw new Error('WFC_FEISHU_APP_ID and WFC_FEISHU_APP_SECRET must be configured together');
  }
  const feishuEnabled = flag(env, 'WFC_FEISHU_ENABLED', Boolean(appId && appSecret));
  if (feishuEnabled && (!appId || !appSecret)) {
    throw new Error('WFC_FEISHU_ENABLED=1 requires WFC_FEISHU_APP_ID and WFC_FEISHU_APP_SECRET');
  }
  const callbacksEnabled = flag(env, 'WFC_FEISHU_CALLBACKS_ENABLED');
  const verificationToken = text(env, 'WFC_FEISHU_VERIFICATION_TOKEN');
  if (callbacksEnabled && !feishuEnabled) {
    throw new Error('WFC_FEISHU_CALLBACKS_ENABLED=1 requires WFC_FEISHU_ENABLED=1');
  }
  if (callbacksEnabled && !verificationToken) {
    throw new Error('WFC_FEISHU_CALLBACKS_ENABLED=1 requires WFC_FEISHU_VERIFICATION_TOKEN');
  }

  // Server LLM backend: 'auto' prefers a configured CLI and falls back to the
  // direct API; 'cli' requires an explicit command; 'direct' ignores any CLI.
  const llmBackend = oneOf(env, 'WFC_LLM_BACKEND', ['auto', 'cli', 'direct'], 'auto');
  const llmCliCommand = text(env, 'WFC_LLM_CLI_COMMAND');
  if (llmBackend === 'cli' && !llmCliCommand) {
    throw new Error('WFC_LLM_BACKEND=cli requires WFC_LLM_CLI_COMMAND');
  }

  return {
    dataDir,
    nodeId: text(env, 'WFC_NODE_ID'),
    httpsHost,
    httpsPort: integer(env, 'WFC_HTTPS_PORT', 8710, { max: 65535 }),
    internalHost: '127.0.0.1',
    internalPort: integer(env, 'WFC_INTERNAL_PORT', 8711, { max: 65535 }),
    tls,
    claimTimeoutMs: integer(env, 'WFC_CLAIM_TIMEOUT_MS', 15 * 60 * 1000),
    peerSyncIntervalMs: integer(env, 'WFC_PEER_SYNC_INTERVAL_MS', 15_000, { min: 1_000 }),
    peerRelay: flag(env, 'WFC_PEER_RELAY'),
    peers: peers(env, 'WFC_PEERS_JSON'),
    corsOrigins: corsOrigins(env, 'WFC_CORS_ORIGINS'),
    // Optional directory of a built web client served on the public server
    // (same origin as the API - no CORS involved at all).
    webDist: text(env, 'WFC_WEB_DIST') ? path.resolve(text(env, 'WFC_WEB_DIST')) : null,
    knowledgeDb: text(env, 'WFC_KNOWLEDGE_DB')
      ? path.resolve(text(env, 'WFC_KNOWLEDGE_DB'))
      : path.join(dataDir, 'workflow.db'),
    // Git-backed memory repository. Core only resolves the location; the
    // memory keeper owns writing and committing it.
    memoryDir: text(env, 'WFC_MEMORY_DIR')
      ? path.resolve(text(env, 'WFC_MEMORY_DIR'))
      : path.join(dataDir, 'memory'),
    // The keeper calls the model on every run, so it is opt-in rather than a
    // surprise recurring cost on a fresh deployment.
    memoryKeeper: {
      enabled: flag(env, 'WFC_MEMORY_KEEPER_ENABLED'),
      intervalMs: integer(env, 'WFC_MEMORY_KEEPER_INTERVAL_MS', 15 * 60 * 1000, { min: 60_000 }),
    },
    llm: {
      enabled: flag(env, 'WFC_LLM_ENABLED'),
      baseUrl: text(env, 'WFC_LLM_BASE_URL') || 'https://api.openai.com/v1',
      apiKey: text(env, 'WFC_LLM_API_KEY'),
      model: text(env, 'WFC_LLM_MODEL') || 'gpt-4o-mini',
      backend: llmBackend,
      // The CLI is an opaque external command: Core passes the transcript on
      // stdin-equivalent argv and reads the model reply from stdout. No
      // product-specific path is assumed.
      cli: llmCliCommand
        ? {
          command: llmCliCommand,
          args: stringArray(env, 'WFC_LLM_CLI_ARGS') ?? [],
          timeoutMs: integer(env, 'WFC_LLM_CLI_TIMEOUT_MS', 240_000, { min: 1_000 }),
        }
        : null,
    },
    feishu: {
      enabled: feishuEnabled,
      appId,
      appSecret,
      connectTimeoutMs: integer(env, 'WFC_FEISHU_CONNECT_TIMEOUT_MS', 30_000),
      callbacksEnabled,
      verificationToken,
    },
  };
}
