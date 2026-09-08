// memory/store.js - the git-backed memory repository.
//
// Memory is files, not tables: the user must be able to read what the
// assistant believes, edit it when it is wrong, and roll it back. Core only
// resolves the location and provides safe access; the memory keeper owns
// writing and committing.
//
// Every path is resolved inside the root and rejected if it escapes, so a
// malformed relative path can never write outside the memory repository.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MEMORY_LAYOUT = Object.freeze({
  index: 'MEMORY.md',
  profile: 'profile',
  projects: 'projects',
  channels: 'channels',
  journal: 'journal',
});

const INDEX_TEMPLATE = `# Workflow 记忆索引

这个仓库是 Workflow 对世界、对项目、对你的理解。它是纯文本，可以直接改，
也可以回滚到任意一次提交。

| 位置 | 内容 |
| --- | --- |
| \`profile/preferences.md\` | 你的偏好：何时可以打扰、哪些群可以自动回复 |
| \`profile/people.md\` | 相关的人与关系 |
| \`projects/<id>/context.md\` | 项目现状 |
| \`projects/<id>/commitments.md\` | 责任的人类可读视图 |
| \`projects/<id>/notes/\` | 观察与决策记录 |
| \`channels/<id>/recent.md\` | 渠道近期上下文（由 keeper 按 TTL 清理） |
| \`journal/YYYY-MM.md\` | 追加式观察日志 |

写入约定见 \`workflow-memory\` 技能：只追加、不覆盖，凭据与本机路径永不写入。
`;

export class MemoryStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function resolveInside(root, relativePath) {
  const text = String(relativePath ?? '').trim();
  if (!text) throw new MemoryStoreError('path_required', 'a relative path is required');
  if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
    throw new MemoryStoreError('path_must_be_relative', `memory paths must be relative: ${text}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, text);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new MemoryStoreError('path_escapes_root', `memory path escapes the repository: ${text}`);
  }
  return target;
}

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

export function createMemoryStore({ root, log = () => {} } = {}) {
  if (!root) throw new TypeError('root is required');
  const base = path.resolve(root);

  function exists(relativePath) {
    return fs.existsSync(resolveInside(base, relativePath));
  }

  function read(relativePath) {
    const file = resolveInside(base, relativePath);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function write(relativePath, content) {
    const file = resolveInside(base, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic replace: a reader never sees a half-written memory file.
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, String(content ?? ''), 'utf8');
    fs.renameSync(temp, file);
    return file;
  }

  function append(relativePath, text) {
    const file = resolveInside(base, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, String(text ?? ''), 'utf8');
    return file;
  }

  function list(relativeDir = '.') {
    const dir = resolveInside(base, relativeDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }

  function isRepo() {
    return fs.existsSync(path.join(base, '.git'));
  }

  // Create the layout and initialize the repository once. Idempotent.
  function ensureLayout({ identity = 'workflow' } = {}) {
    fs.mkdirSync(base, { recursive: true });
    for (const dir of [MEMORY_LAYOUT.profile, MEMORY_LAYOUT.projects, MEMORY_LAYOUT.channels, MEMORY_LAYOUT.journal]) {
      fs.mkdirSync(path.join(base, dir), { recursive: true });
    }
    if (!exists(MEMORY_LAYOUT.index)) write(MEMORY_LAYOUT.index, INDEX_TEMPLATE);
    if (!isRepo()) {
      const init = git(base, ['init', '--quiet']);
      if (init.status !== 0) throw new MemoryStoreError('git_init_failed', init.stderr || 'git init failed');
      git(base, ['config', 'user.name', identity]);
      git(base, ['config', 'user.email', `${identity}@localhost`]);
    }
    return { root: base, created: true };
  }

  // Commit whatever changed. Returns null when there was nothing to commit, so
  // callers can distinguish "no memory change" from "commit failed".
  function commit(message) {
    if (!isRepo()) throw new MemoryStoreError('not_a_repository', 'memory repository is not initialized');
    const add = git(base, ['add', '-A']);
    if (add.status !== 0) throw new MemoryStoreError('git_add_failed', add.stderr || 'git add failed');
    const status = git(base, ['status', '--porcelain']);
    if (status.status === 0 && !String(status.stdout).trim()) return null;
    const commitResult = git(base, ['commit', '--quiet', '-m', String(message ?? 'memory update')]);
    if (commitResult.status !== 0) throw new MemoryStoreError('git_commit_failed', commitResult.stderr || 'git commit failed');
    const head = git(base, ['rev-parse', 'HEAD']);
    return String(head.stdout ?? '').trim() || null;
  }

  function history(relativePath = null, { limit = 20 } = {}) {
    if (!isRepo()) return [];
    const args = ['log', `--max-count=${Math.min(200, Math.max(1, Number(limit) || 20))}`, '--format=%H%x09%aI%x09%s'];
    if (relativePath) args.push('--', resolveInside(base, relativePath));
    const result = git(base, args);
    if (result.status !== 0) return [];
    return String(result.stdout).split('\n').filter(Boolean).map((line) => {
      const [commit, at, ...rest] = line.split('\t');
      return { commit, at, subject: rest.join('\t') };
    });
  }

  function readAt(commitId, relativePath) {
    const result = git(base, ['show', `${commitId}:${resolveInside(base, relativePath).slice(base.length + 1).replace(/\\/g, '/')}`]);
    return result.status === 0 ? String(result.stdout) : null;
  }

  // Restore one file to a past version. The revert is itself a commit, so the
  // rollback is reversible and the history stays linear.
  function revert(commitId, relativePath) {
    const content = readAt(commitId, relativePath);
    if (content == null) {
      throw new MemoryStoreError('version_not_found', `no version of ${relativePath} at ${commitId}`);
    }
    write(relativePath, content);
    return commit(`revert ${relativePath} to ${String(commitId).slice(0, 7)}`);
  }

  return {
    root: base,
    ensureLayout,
    exists,
    read,
    write,
    append,
    list,
    commit,
    history,
    readAt,
    revert,
    isRepo,
    log,
  };
}
