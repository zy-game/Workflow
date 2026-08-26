// credential-key.js - delegated credential encryption at rest for Core.
// A 32-byte master key is generated on first use and written to the data
// directory with mode 0600; values are encrypted with AES-256-GCM and stored
// as `v1:<iv>:<ciphertext>`. The key file must stay inside the Core data dir
// (root-owned data directory, ubuntu service user) and never leaves the box.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class CredentialCipher {
  constructor({ dataDir, filename = 'credential-master.key' } = {}) {
    this.file = path.resolve(path.join(dataDir, filename));
    this.key = this.#loadOrCreate();
  }

  #loadOrCreate() {
    try {
      const value = fs.readFileSync(this.file);
      if (value.length === 32) return value;
      throw new Error('credential master key is malformed');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const key = crypto.randomBytes(32);
      const alias = `${this.file}.tmp`;
      fs.writeFileSync(alias, key, { mode: 0o600 });
      fs.renameSync(alias, this.file);
      return key;
    }
  }

  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(payload) {
    const [version, ivHex, tagHex, dataHex] = String(payload ?? '').split(':');
    if (version !== 'v1' || !ivHex || !tagHex || !dataHex) throw new Error('unsupported credential payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  }
}
