// sync-key.js - per-node ed25519 signing key for peer-sync events. The
// private key never leaves the data directory (0600); the public key is
// shared with peers through the sync handshake and pinned on first contact.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SYNC_KEY_FILE = 'sync-key.json';

export function loadSyncKeyPair({ dataDir, filename = null } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const file = path.resolve(filename || path.join(dataDir, SYNC_KEY_FILE));
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keyObject = crypto.createPrivateKey(stored.private_key);
    if (keyObject.asymmetricKeyType !== 'ed25519') {
      throw new Error('stored sync key is not an ed25519 key');
    }
    const privateKey = crypto.createPrivateKey(stored.private_key);
    const publicKey = crypto.createPublicKey(stored.public_key);
    const derived = crypto.createPublicKey(privateKey);
    if (derived.export({ type: 'spki', format: 'pem' }) !== publicKey.export({ type: 'spki', format: 'pem' })) {
      throw new Error('stored sync key does not match its public key');
    }
    return { file, privateKey, publicKey, publicKeyBase64: spkiBase64(publicKey) };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const payload = {
    public_key: publicKey.export({ type: 'spki', format: 'pem' }),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temporary, file); } catch (error) {
      if (!fs.existsSync(file)) throw error;
      fs.rmSync(temporary, { force: true });
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    file,
    privateKey,
    publicKey,
    publicKeyBase64: spkiBase64(publicKey),
  };
}

export function spkiBase64(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function publicKeyFromBase64(base64) {
  return crypto.createPublicKey({ key: Buffer.from(base64, 'base64'), type: 'spki', format: 'der' });
}

// Stable serialization so the signer and every verifier hash the same bytes
// regardless of property insertion order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signEvent(privateKey, event) {
  return crypto.sign(null, Buffer.from(canonicalJson(event)), privateKey).toString('base64');
}

export function verifyEvent(publicKey, event, signatureBase64) {
  if (!signatureBase64 || typeof signatureBase64 !== 'string') return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(event)), publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
