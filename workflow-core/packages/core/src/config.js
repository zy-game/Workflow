// config.js - validated environment-driven configuration.
import path from 'node:path';

function text(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

  return {
    dataDir,
    nodeId: text(env, 'WFC_NODE_ID'),
    httpsHost,
    httpsPort: integer(env, 'WFC_HTTPS_PORT', 8710, { max: 65535 }),
    internalHost: '127.0.0.1',
    internalPort: integer(env, 'WFC_INTERNAL_PORT', 8711, { max: 65535 }),
    tls,
    claimTimeoutMs: integer(env, 'WFC_CLAIM_TIMEOUT_MS', 15 * 60 * 1000),
    knowledgeDb: text(env, 'WFC_KNOWLEDGE_DB')
      ? path.resolve(text(env, 'WFC_KNOWLEDGE_DB'))
      : path.join(dataDir, 'workflow.db'),
    llm: {
      enabled: flag(env, 'WFC_LLM_ENABLED'),
      baseUrl: text(env, 'WFC_LLM_BASE_URL') || 'https://api.openai.com/v1',
      apiKey: text(env, 'WFC_LLM_API_KEY'),
      model: text(env, 'WFC_LLM_MODEL') || 'gpt-4o-mini',
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
