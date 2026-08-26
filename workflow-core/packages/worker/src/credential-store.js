// credential-store.js - local secrets with a platform protection provider.
// Windows stores values DPAPI-encrypted in the current user/machine scope;
// other platforms store only an external credential reference, never a value.
// The list API returns metadata only; values resolve transiently at the
// controlled call site and are not injected into backend child processes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export function windowsDpapiProvider({ powershell = 'powershell.exe' } = {}) {
  const run = (script, input = undefined) => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const error = new Error(`Windows credential protection failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
      error.code = 'CREDENTIAL_PROTECTION_FAILED';
      throw error;
    }
    return result.stdout;
  };
  return {
    name: 'windows-dpapi',
    protect(plain) {
      const output = run([
        '$ErrorActionPreference = "Stop"',
        '$payload = [Console]::In.ReadToEnd()',
        '$secure = ConvertTo-SecureString -String $payload -AsPlainText -Force',
        '[Console]::Out.Write((ConvertFrom-SecureString $secure))',
      ].join('; '), plain);
      const protectedValue = output.replace(/\r?\n/g, '');
      if (!protectedValue) throw new Error('Windows credential protection returned no data');
      return protectedValue;
    },
    unprotect(protectedValue) {
      const script = [
        '$ErrorActionPreference = "Stop"',
        '$payload = [Console]::In.ReadToEnd()',
        '$secure = ConvertTo-SecureString $payload',
        '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
        '[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr))',
        '[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)',
      ].join('; ');
      return run(script, protectedValue);
    },
  };
}

export function externalReferenceProvider() {
  return {
    name: 'external-reference',
    protect() {
      const error = new Error('local secret values are not supported on this platform; store an external credential reference instead');
      error.code = 'CREDENTIAL_EXTERNAL_REQUIRED';
      throw error;
    },
    unprotect() {
      const error = new Error('external credential references resolve outside this store');
      error.code = 'CREDENTIAL_EXTERNAL_REFERENCE';
      throw error;
    },
  };
}

export function defaultCredentialProvider() {
  return process.platform === 'win32' ? windowsDpapiProvider() : externalReferenceProvider();
}

export class CredentialStore {
  constructor({ dataDir, filename = null, provider = null } = {}) {
    if (!dataDir && !filename) throw new TypeError('dataDir or filename is required');
    this.file = path.resolve(filename || path.join(dataDir, 'credentials.json'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.provider = provider ?? defaultCredentialProvider();
    this.values = this.#load();
  }
  #load() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { /* first run or corrupt file */ }
    return value && typeof value === 'object' ? value : {};
  }
  #save() {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.values, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  #metadata(entry) {
    return {
      id: entry.id, name: entry.name, provider: entry.provider,
      kind: entry.kind, reference: entry.reference ?? null,
      metadata: { ...(entry.metadata || {}) }, updatedAt: entry.updatedAt,
    };
  }
  list() {
    return Object.entries(this.values).map(([, entry]) => this.#metadata(entry));
  }
  async get(id) {
    const entry = this.values[id];
    if (!entry) return null;
    if (entry.kind === 'reference') return { ...this.#metadata(entry), reference: entry.reference };
    return { ...this.#metadata(entry), value: await this.provider.unprotect(entry.secret) };
  }
  async set(id, { name = id, provider = null, value = null, reference = null, metadata = {} } = {}) {
    if (!id || typeof id !== 'string') throw new TypeError('credential id is required');
    if ((value === null || value === undefined) && (reference === null || reference === undefined)) {
      throw new TypeError('credential value or reference is required');
    }
    if (value !== null && value !== undefined) {
      if (typeof value !== 'string' || !value) throw new TypeError('credential value must be a non-empty string');
      const secret = await this.provider.protect(value);
      this.values[id] = {
        id, name: String(name), provider: provider ?? this.provider.name, kind: 'local',
        secret, metadata: { ...metadata }, updatedAt: new Date().toISOString(),
      };
    } else {
      if (typeof reference !== 'string' || !reference) throw new TypeError('credential reference must be a non-empty string');
      this.values[id] = {
        id, name: String(name), provider: provider ?? 'external-reference', kind: 'reference',
        reference, metadata: { ...metadata }, updatedAt: new Date().toISOString(),
      };
    }
    this.#save();
    return this.#metadata(this.values[id]);
  }
  delete(id) {
    const existed = Object.hasOwn(this.values, id);
    delete this.values[id];
    if (existed) this.#save();
    return existed;
  }
}

export function redactCredential(value) {
  return value ? `${value.slice(0, 2)}…${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}` : null;
}
