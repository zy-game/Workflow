// config-store.js - authoritative local worker configuration with revisions.
// Holds projects, backend descriptors and admin settings. Secrets never belong
// here; environment profiles live in EnvironmentStore, credentials in
// CredentialStore.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ADMIN = Object.freeze({ enabled: true });

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) throw new TypeError('projects must be an array');
  const seen = new Set();
  return projects.map((project) => {
    if (!project || typeof project !== 'object' || Array.isArray(project)) throw new TypeError('project entries must be objects');
    if (typeof project.projectId !== 'string' || !project.projectId) throw new TypeError('projectId is required');
    if (typeof project.root !== 'string' || !project.root) throw new TypeError('project root is required');
    if (seen.has(project.projectId)) throw new TypeError(`duplicate project: ${project.projectId}`);
    seen.add(project.projectId);
    return {
      projectId: project.projectId,
      root: project.root,
      name: String(project.name ?? project.projectId),
      metadata: project.metadata && typeof project.metadata === 'object' ? project.metadata : {},
    };
  });
}

function normalizeBackends(backends) {
  if (!Array.isArray(backends)) throw new TypeError('backends must be an array');
  const seen = new Set();
  return backends.map((backend) => {
    if (!backend || typeof backend !== 'object' || Array.isArray(backend)) throw new TypeError('backend entries must be objects');
    const kind = String(backend.kind || '');
    if (!kind) throw new TypeError('backend kind is required');
    if (seen.has(kind)) throw new TypeError(`duplicate backend: ${kind}`);
    seen.add(kind);
    if (typeof backend.command !== 'string' || !backend.command) throw new TypeError(`backend ${kind} command is required`);
    return {
      kind,
      command: backend.command,
      args: Array.isArray(backend.args) ? backend.args.map(String) : [],
      enabled: backend.enabled !== false,
      capabilities: Array.isArray(backend.capabilities) ? [...new Set(backend.capabilities.map(String).filter(Boolean))] : [],
      environment: typeof backend.environment === 'string' ? backend.environment : null,
    };
  });
}

export class ConfigStore {
  constructor({ dataDir, filename = null } = {}) {
    if (!dataDir && !filename) throw new TypeError('dataDir or filename is required');
    this.file = path.resolve(filename || path.join(dataDir, 'config.json'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.value = this.#load();
  }

  #load() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { /* first run or corrupt file; start fresh */ }
    if (value && typeof value === 'object' && Number.isInteger(value.revision)) {
      return {
        revision: value.revision,
        projects: Array.isArray(value.projects) ? value.projects : [],
        backends: Array.isArray(value.backends) ? value.backends : [],
        admin: value.admin && typeof value.admin === 'object' ? value.admin : { ...DEFAULT_ADMIN },
      };
    }
    return { revision: 0, projects: [], backends: [], admin: { ...DEFAULT_ADMIN } };
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

  get() {
    return {
      revision: this.value.revision,
      projects: [...this.value.projects],
      backends: [...this.value.backends],
      admin: { ...this.value.admin },
    };
  }

  addProject(project) {
    const normalized = normalizeProjects([project])[0];
    if (this.value.projects.some((existing) => existing.projectId === normalized.projectId)) {
      throw new TypeError(`project already exists: ${normalized.projectId}`);
    }
    this.value = { ...this.value, projects: [...this.value.projects, normalized] };
    return this.#commit();
  }

  removeProject(projectId) {
    const remaining = this.value.projects.filter((project) => project.projectId !== projectId);
    if (remaining.length === this.value.projects.length) return false;
    this.value = { ...this.value, projects: remaining };
    this.#commit();
    return true;
  }

  upsertBackend(backend) {
    const normalized = normalizeBackends([backend])[0];
    const others = this.value.backends.filter((existing) => existing.kind !== normalized.kind);
    this.value = { ...this.value, backends: [...others, normalized] };
    return this.#commit();
  }

  removeBackend(kind) {
    const remaining = this.value.backends.filter((backend) => backend.kind !== kind);
    if (remaining.length === this.value.backends.length) return false;
    this.value = { ...this.value, backends: remaining };
    this.#commit();
    return true;
  }

  setAdmin(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('admin patch must be an object');
    this.value = { ...this.value, admin: { ...this.value.admin, ...patch } };
    return this.#commit();
  }
}
