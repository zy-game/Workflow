// environment-store.js - named environment profiles for backend child processes.
// Profiles must not carry secret-like values; credentials belong to
// CredentialStore and are not injected into children by default.
import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEY = /(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const SENSITIVE_KEY_WORD = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(_|$)/i;

export function isSensitiveEnvironmentKey(key) {
  if (typeof key !== 'string' || !key) return false;
  return SENSITIVE_KEY.test(key) || SENSITIVE_KEY_WORD.test(key) || /^WFC_/i.test(key);
}

export function normalizeEnvironmentVars(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new TypeError('environment variables must be an object');
  const normalized = {};
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== 'string') throw new TypeError(`environment value for ${key} must be a string`);
    if (isSensitiveEnvironmentKey(key)) throw new TypeError(`environment key is not allowed: ${key}`);
    normalized[key] = value;
  }
  return normalized;
}

export class EnvironmentStore {
  constructor({ dataDir, filename = null } = {}) {
    if (!dataDir && !filename) throw new TypeError('dataDir or filename is required');
    this.file = path.resolve(filename || path.join(dataDir, 'environments.json'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.value = this.#load();
  }

  #load() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { /* first run or corrupt file; start fresh */ }
    if (value && typeof value === 'object' && value.profiles && typeof value.profiles === 'object') {
      return {
        revision: Number.isInteger(value.revision) ? value.revision : 0,
        profiles: value.profiles,
      };
    }
    return { revision: 0, profiles: {} };
  }

  #save() {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  #commit() {
    this.value = { ...this.value, revision: this.value.revision + 1 };
    this.#save();
    return this.value.revision;
  }

  get(name) {
    const profile = this.value.profiles[name];
    return profile ? { name, vars: { ...profile.vars }, updatedAt: profile.updatedAt } : null;
  }

  list() {
    return Object.entries(this.value.profiles).map(([name, profile]) => ({
      name, vars: { ...profile.vars }, updatedAt: profile.updatedAt,
    }));
  }

  set(name, profile) {
    if (typeof name !== 'string' || !name) throw new TypeError('environment name is required');
    const vars = normalizeEnvironmentVars(profile?.vars ?? profile);
    this.value = {
      ...this.value,
      profiles: { ...this.value.profiles, [name]: { vars, updatedAt: new Date().toISOString() } },
    };
    this.#commit();
    return this.get(name);
  }

  delete(name) {
    if (!Object.hasOwn(this.value.profiles, name)) return false;
    const profiles = { ...this.value.profiles };
    delete profiles[name];
    this.value = { ...this.value, profiles };
    this.#commit();
    return true;
  }
}
