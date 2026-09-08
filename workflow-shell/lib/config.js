// lib/config.js - local shell configuration.
//
// The worker token is a credential, so it never sits in a readable file: it is
// sealed with the OS credential store (Keychain / DPAPI / libsecret) and the
// plaintext only ever exists in memory while the executor runs.
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'shell-config.json';

function defaults(serverUrl) {
  return {
    serverUrl,
    workerId: null,
    // The local runtime the executor runs. A path to a CLI is enough; the
    // shell does not need to know what it is.
    backendCommand: null,
    backendArgs: [],
    tokenSealed: null,
  };
}

function createConfigStore({ dir, serverUrl, safeStorage, log = () => {} }) {
  const file = path.join(dir, FILE_NAME);

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...defaults(serverUrl), ...parsed };
    } catch {
      return defaults(serverUrl);
    }
  }

  function write(patch) {
    const next = { ...read(), ...patch };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }

  // The token crosses this boundary as plaintext exactly once, in each
  // direction, and is never logged.
  function setToken(token) {
    if (!token) return write({ tokenSealed: null }).tokenSealed;
    if (!safeStorage?.isEncryptionAvailable?.()) {
      log('[config] OS credential storage unavailable; the worker token will not be persisted');
      return null;
    }
    return write({ tokenSealed: safeStorage.encryptString(String(token)).toString('base64') }).tokenSealed;
  }

  function getToken() {
    const { tokenSealed } = read();
    if (!tokenSealed) return null;
    try {
      return safeStorage.decryptString(Buffer.from(tokenSealed, 'base64'));
    } catch (error) {
      log(`[config] stored token could not be read: ${error.message}`);
      return null;
    }
  }

  return {
    file,
    read,
    write,
    setToken,
    getToken,
    // Never expose the sealed value to the renderer.
    publicConfig() {
      const { tokenSealed, ...rest } = read();
      return { ...rest, hasToken: Boolean(tokenSealed) };
    },
  };
}

module.exports = { createConfigStore };
