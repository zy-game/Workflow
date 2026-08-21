import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { FeishuConnection } from '../src/feishu/service.js';

function validEnv(overrides = {}) {
  return {
    WFC_DATA_DIR: 'C:/workflow-core-data',
    WFC_ALLOW_PLAIN_HTTP: '1',
    ...overrides,
  };
}

test('plain HTTP defaults to loopback and validates numeric configuration', () => {
  const config = loadConfig(validEnv());
  assert.equal(config.httpsHost, '127.0.0.1');
  assert.equal(config.httpsPort, 8710);
  assert.equal(config.dshUpstream, 'http://127.0.0.1:3081');
  assert.equal(config.feishu.enabled, false);
  assert.throws(
    () => loadConfig(validEnv({ WFC_HTTPS_PORT: 'not-a-port' })),
    /WFC_HTTPS_PORT must be an integer/,
  );
  assert.throws(
    () => loadConfig(validEnv({ WFC_HTTPS_HOST: '0.0.0.0' })),
    /may only bind.*loopback/,
  );
});

test('DSH upstream is restricted to a plain HTTP loopback origin', () => {
  assert.equal(
    loadConfig(validEnv({ WFC_DSH_UPSTREAM: 'http://localhost:4081/' })).dshUpstream,
    'http://localhost:4081',
  );
  assert.throws(
    () => loadConfig(validEnv({ WFC_DSH_UPSTREAM: 'https://127.0.0.1:3081' })),
    /must use HTTP on a loopback address/,
  );
  assert.throws(
    () => loadConfig(validEnv({ WFC_DSH_UPSTREAM: 'http://10.0.0.8:3081' })),
    /must use HTTP on a loopback address/,
  );
  assert.throws(
    () => loadConfig(validEnv({ WFC_DSH_UPSTREAM: 'http://127.0.0.1:3081/base' })),
    /must be an origin/,
  );
  assert.throws(
    () => loadConfig(validEnv({ WFC_DSH_UPSTREAM: 'not-a-url' })),
    /must be a valid HTTP URL/,
  );
});

test('Feishu credentials, enable switch, and callbacks are validated', () => {
  assert.throws(
    () => loadConfig(validEnv({ WFC_FEISHU_APP_ID: 'cli_0123456789abcdef' })),
    /must be configured together/,
  );
  assert.throws(
    () => loadConfig(validEnv({ WFC_FEISHU_ENABLED: '1' })),
    /requires WFC_FEISHU_APP_ID/,
  );
  assert.throws(
    () => loadConfig(validEnv({
      WFC_FEISHU_APP_ID: 'cli_0123456789abcdef',
      WFC_FEISHU_APP_SECRET: 'secret',
      WFC_FEISHU_CALLBACKS_ENABLED: '1',
    })),
    /requires WFC_FEISHU_VERIFICATION_TOKEN/,
  );

  const config = loadConfig(validEnv({
    WFC_FEISHU_APP_ID: ' cli_0123456789abcdef ',
    WFC_FEISHU_APP_SECRET: ' secret ',
    WFC_FEISHU_CALLBACKS_ENABLED: '1',
    WFC_FEISHU_VERIFICATION_TOKEN: ' verify ',
  }));
  assert.deepEqual(
    {
      enabled: config.feishu.enabled,
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      callbacksEnabled: config.feishu.callbacksEnabled,
      verificationToken: config.feishu.verificationToken,
    },
    {
      enabled: true,
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
      callbacksEnabled: true,
      verificationToken: 'verify',
    },
  );
});

function fakeSdk({ ready = true } = {}) {
  let registered;
  let instance;
  class EventDispatcher {
    register(handlers) {
      registered = handlers;
      return this;
    }
  }
  class WSClient {
    constructor(options) {
      this.options = options;
      this.closed = false;
      this.state = 'idle';
      instance = this;
    }
    async start() {
      this.state = 'connecting';
      if (ready) {
        this.state = 'connected';
        queueMicrotask(() => this.options.onReady());
      }
    }
    getConnectionStatus() {
      return { state: this.state, reconnectAttempts: 0 };
    }
    close() {
      this.closed = true;
      this.state = 'idle';
    }
  }
  return {
    module: { EventDispatcher, WSClient },
    handlers: () => registered,
    instance: () => instance,
  };
}

test('Feishu connection waits for readiness, forwards messages, and closes', async () => {
  const sdk = fakeSdk();
  const received = [];
  const service = {
    handleInboundMessage: async (message) => received.push(message),
  };
  const connection = new FeishuConnection(service, {
    appId: 'cli_0123456789abcdef',
    appSecret: 'secret',
    connectTimeoutMs: 100,
    loadSdk: async () => sdk.module,
  });
  await connection.start();
  assert.equal(connection.status().state, 'connected');
  assert.ok(connection.status().connected_at);

  await sdk.handlers()['im.message.receive_v1']({
    message: {
      message_id: 'om-1',
      chat_id: 'oc-1',
      content: JSON.stringify({ text: '@_user_1 修复构建' }),
    },
    sender: { sender_id: { open_id: 'ou-1' } },
  });
  assert.deepEqual(received, [{
    messageId: 'om-1',
    chatId: 'oc-1',
    text: '修复构建',
    senderId: 'ou-1',
  }]);

  connection.stop();
  assert.equal(connection.status().state, 'stopped');
  assert.equal(sdk.instance().closed, true);
});

test('Feishu connection times out when the SDK never becomes ready', async () => {
  const sdk = fakeSdk({ ready: false });
  const connection = new FeishuConnection({ handleInboundMessage: async () => {} }, {
    appId: 'cli_0123456789abcdef',
    appSecret: 'secret',
    connectTimeoutMs: 10,
    loadSdk: async () => sdk.module,
  });
  await assert.rejects(connection.start(), /did not connect within 10ms/);
  assert.equal(connection.status().state, 'failed');
  assert.equal(sdk.instance().closed, true);
});
