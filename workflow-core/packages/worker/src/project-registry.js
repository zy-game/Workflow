import path from 'node:path';
import fs from 'node:fs';

function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('project root is required');
  const candidate = path.resolve(value);
  let root;
  try {
    root = fs.realpathSync.native(candidate);
  } catch (error) {
    const wrapped = new Error(`project root must be an existing directory: ${candidate}`);
    wrapped.code = error.code === 'ENOENT' ? 'PROJECT_ROOT_NOT_FOUND' : 'PROJECT_ROOT_INVALID';
    throw wrapped;
  }
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    const error = new Error(`project root must be a directory: ${root}`);
    error.code = 'PROJECT_ROOT_NOT_DIRECTORY';
    throw error;
  }
  return root;
}

export class ProjectRegistry {
  constructor({ projects = [] } = {}) {
    this.projects = new Map();
    for (const project of projects) this.add(project);
  }

  add({ projectId, root, name = projectId, metadata = {} }) {
    if (!projectId || typeof projectId !== 'string') throw new TypeError('projectId is required');
    const normalizedRoot = normalizeRoot(root);
    for (const existing of this.projects.values()) {
      if (existing.projectId === projectId) continue;
      if (normalizedRoot === existing.root || normalizedRoot.startsWith(`${existing.root}${path.sep}`)
        || existing.root.startsWith(`${normalizedRoot}${path.sep}`)) {
        throw new Error(`project roots overlap: ${projectId}`);
      }
    }
    const value = { projectId, root: normalizedRoot, name: String(name), metadata: { ...metadata } };
    this.projects.set(projectId, value);
    return { ...value };
  }

  remove(projectId) { return this.projects.delete(projectId); }
  get(projectId) { const value = this.projects.get(projectId); return value ? { ...value } : null; }
  list() { return [...this.projects.values()].map((value) => ({ ...value })); }
  resolve(projectId) { const value = this.get(projectId); if (!value) throw new Error(`project is not registered: ${projectId}`); return value; }
}
