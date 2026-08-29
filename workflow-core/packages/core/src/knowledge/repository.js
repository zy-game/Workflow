// repository.js - knowledge authority over workflow.db (ported from the
// previous wf-api repository; behavior and schema are identical so existing
// production data works as-is).
import os from 'node:os';
import path from 'node:path';
import { openKnowledgeDatabase, KNOWLEDGE_SCHEMA_VERSION } from './schema.js';
import {
  cleanList, conflictFromRow, contentHash, displayProjectPath, documentFromRow, json,
  memoryFromRow, normalizeProjectPath, now, parseJson, pathFlavor, projectBasename, uuid,
} from './utils.js';

export const MEMORY_TYPES = new Set(['pitfall', 'insight', 'decision', 'pattern', 'constraint']);
export const DOCUMENT_KINDS = new Set(['attention', 'roadmap', 'tracking']);

function utf8Prefix(value, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const character of String(value)) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export class RevisionConflictError extends Error {
  constructor(entityType, entityId, expectedRevision, actualRevision, conflictId) {
    super(`Revision conflict for ${entityType} ${entityId}: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'RevisionConflictError'; this.code = 'REVISION_CONFLICT'; this.entityType = entityType;
    this.entityId = entityId; this.expectedRevision = expectedRevision; this.actualRevision = actualRevision; this.conflictId = conflictId;
  }
}

export class WorkflowRepository {
  constructor(options = {}) {
    this.filename = path.resolve(options.filename || path.join(os.homedir(), '.agents', 'workflow', 'workflow.db'));
    this.db = openKnowledgeDatabase(this.filename, options);
    this.transactionDepth = 0;
    this.changeListeners = [];
  }
  close() { this.db.close(); }
  // Observers fire after a synced entity mutation commits its change-log
  // revision (the peer-sync publisher subscribes). Keep them cheap.
  onChange(listener) {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((entry) => entry !== listener);
    };
  }
  #emitChange(entityType, entityId, operation, record) {
    for (const listener of this.changeListeners) {
      try { listener({ entityType, entityId, operation, record }); } catch { /* observer error is contained */ }
    }
  }
  transaction(fn) {
    if (this.transactionDepth) return fn(this);
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth += 1;
    try { const result = fn(this); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ } throw error; }
    finally { this.transactionDepth -= 1; }
  }
  schemaInfo() {
    return { version: Number(this.db.prepare('PRAGMA user_version').get().user_version), journalMode: this.db.prepare('PRAGMA journal_mode').get().journal_mode, foreignKeys: Boolean(this.db.prepare('PRAGMA foreign_keys').get().foreign_keys), busyTimeout: Number(this.db.prepare('PRAGMA busy_timeout').get().timeout) };
  }
  _change(entityType, entityId, projectId, operation) {
    const revision = Number(this.db.prepare('INSERT INTO sync_changes(entity_type,entity_id,project_id,operation,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(entityType, entityId, projectId || null, operation, '{}', now()).lastInsertRowid);
    this.db.prepare("UPDATE repository_meta SET value=? WHERE key='current_revision'").run(String(revision));
    return revision;
  }
  currentRevision() { return Number(this.db.prepare("SELECT value FROM repository_meta WHERE key='current_revision'").get()?.value || 0); }
  _finishChange(revision, payload) { this.db.prepare('UPDATE sync_changes SET payload_json=? WHERE revision=?').run(json(payload), revision); }
  _conflict(clientId, entityType, entityId, expected, actual, proposed) {
    const id = uuid();
    this.db.prepare('INSERT INTO sync_conflicts(id,client_id,entity_type,entity_id,expected_revision,actual_revision,proposed_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, clientId || null, entityType, entityId, Number(expected), Number(actual), json(proposed || {}), now());
    return new RevisionConflictError(entityType, entityId, Number(expected), Number(actual), id);
  }
  resolveProject(options = {}) {
    const machine = String(options.machine || os.hostname()).trim().toLowerCase();
    const flavor = options.pathFlavor || pathFlavor(options.path); const normalized = normalizeProjectPath(options.path, flavor);
    let location = this.db.prepare('SELECT project_id FROM project_locations WHERE machine=? AND path_flavor=? AND normalized_path=?').get(machine, flavor, normalized);
    if (!location) {
      for (const candidate of this.db.prepare('SELECT project_id,aliases_json FROM project_locations WHERE machine=? AND path_flavor=?').all(machine, flavor)) {
        const aliases = parseJson(candidate.aliases_json, []).map((alias) => { try { return normalizeProjectPath(alias, flavor); } catch { return ''; } });
        if (aliases.includes(normalized)) { location = candidate; break; }
      }
    }
    if (location) return this.getProject(location.project_id);
    if (options.create === false) return null;
    const project = this.transaction(() => {
      location = this.db.prepare('SELECT project_id FROM project_locations WHERE machine=? AND path_flavor=? AND normalized_path=?').get(machine, flavor, normalized);
      if (location) return this.getProject(location.project_id);
      const id = options.projectId || uuid(); const timestamp = now();
      this.db.prepare('INSERT INTO projects(id,name,type,goal,status,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, String(options.name || projectBasename(options.path, flavor) || 'project'), String(options.type || 'unknown'), String(options.goal || ''), String(options.status || 'active'), json(options.metadata || {}), timestamp, timestamp);
      this.db.prepare('INSERT INTO project_locations(id,project_id,machine,path_flavor,normalized_path,display_path,aliases_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uuid(), id, machine, flavor, normalized, displayProjectPath(options.path, flavor), json(cleanList(options.aliases)), timestamp, timestamp);
      const revision = this._change('project', id, id, 'create'); this.db.prepare('UPDATE projects SET server_revision=? WHERE id=?').run(revision, id);
      const created = this.getProject(id); this._finishChange(revision, created); return created;
    });
    this.#emitChange('project', project.id, 'create', project);
    return project;
  }
  // Peer-sync projection write: create with the origin's project id and
  // metadata verbatim. Machine-local locations never travel with sync; the
  // project arrives location-less until this machine registers its own path.
  createProjectFromSync(input) {
    if (!input.id || typeof input.id !== 'string') throw new TypeError('project id is required');
    const result = this.transaction(() => {
      const existing = this.getProject(input.id);
      if (existing) return { project: existing, idempotent_replay: true };
      const timestamp = now();
      this.db.prepare('INSERT INTO projects(id,name,type,goal,status,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(input.id, String(input.name ?? 'project'), String(input.type ?? 'unknown'), String(input.goal ?? ''), String(input.status ?? 'active'), json(input.metadata ?? {}), timestamp, timestamp);
      const revision = this._change('project', input.id, input.id, 'create'); this.db.prepare('UPDATE projects SET server_revision=? WHERE id=?').run(revision, input.id);
      const project = this.getProject(input.id); this._finishChange(revision, project);
      return { project, idempotent_replay: false };
    });
    if (!result.idempotent_replay) this.#emitChange('project', result.project.id, 'create', result.project);
    return result;
  }
  addProjectLocation(projectId, options) {
    return this.transaction(() => {
      if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
      const machine = String(options.machine || os.hostname()).trim().toLowerCase(); const flavor = options.pathFlavor || pathFlavor(options.path); const normalized = normalizeProjectPath(options.path, flavor);
      const existing = this.db.prepare('SELECT project_id FROM project_locations WHERE machine=? AND path_flavor=? AND normalized_path=?').get(machine, flavor, normalized);
      if (existing && existing.project_id !== projectId) throw new Error(`Project location already belongs to ${existing.project_id}.`);
      if (!existing) {
        const timestamp = now();
        this.db.prepare('INSERT INTO project_locations(id,project_id,machine,path_flavor,normalized_path,display_path,aliases_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uuid(), projectId, machine, flavor, normalized, displayProjectPath(options.path, flavor), json(cleanList(options.aliases)), timestamp, timestamp);
      }
      return this.getProject(projectId);
    });
  }
  getProject(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); if (!row) return null;
    const locations = this.db.prepare('SELECT machine,path_flavor,normalized_path,display_path,aliases_json FROM project_locations WHERE project_id=? ORDER BY machine,normalized_path').all(id).map((item) => ({ machine: item.machine, pathFlavor: item.path_flavor, normalizedPath: item.normalized_path, path: item.display_path, aliases: parseJson(item.aliases_json, []) }));
    return { id: row.id, name: row.name, type: row.type, goal: row.goal, status: row.status, metadata: parseJson(row.metadata_json, {}), revision: row.server_revision, createdAt: row.created_at, updatedAt: row.updated_at, locations };
  }
  getProjectOwnerNodeId(id) {
    const project = this.getProject(id);
    if (!project) return null;
    return project.metadata?.owner_node_id ?? project.metadata?.ownerNodeId ?? null;
  }
  listProjects(options = {}) { return this.db.prepare(`SELECT id FROM projects ${options.all ? '' : "WHERE status<>'deleted'"} ORDER BY updated_at DESC`).all().map((row) => this.getProject(row.id)); }
  updateProject(id, patch, options = {}) {
    const current = this.getProject(id); if (!current) throw new Error(`Project not found: ${id}`);
    if (options.expectedRevision != null && Number(options.expectedRevision) !== current.revision) throw this._conflict(options.clientId, 'project', id, options.expectedRevision, current.revision, patch);
    const result = this.transaction(() => {
      const revision = this._change('project', id, id, 'update');
      this.db.prepare('UPDATE projects SET name=?,type=?,goal=?,status=?,metadata_json=?,server_revision=?,updated_at=? WHERE id=?').run(String(patch.name ?? current.name), String(patch.type ?? current.type), String(patch.goal ?? current.goal), String(patch.status ?? current.status), json(patch.metadata ?? current.metadata), revision, now(), id);
      const updated = this.getProject(id); this._finishChange(revision, updated); return updated;
    });
    this.#emitChange('project', id, 'update', result);
    return result;
  }
  _memoryTags(id) { return this.db.prepare('SELECT tag FROM memory_tags WHERE memory_id=? ORDER BY tag COLLATE NOCASE').all(id).map((row) => row.tag); }
  getMemory(id, options = {}) {
    let row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
    if (!row && options.legacyId) row = options.projectId ? this.db.prepare('SELECT * FROM memories WHERE legacy_id=? AND project_id=?').get(options.legacyId, options.projectId) : this.db.prepare("SELECT * FROM memories WHERE legacy_id=? AND scope='global'").get(options.legacyId);
    return memoryFromRow(row, row ? this._memoryTags(row.id) : []);
  }
  listMemories(options = {}) {
    const clauses = []; const values = [];
    if (options.scope) { clauses.push('scope=?'); values.push(options.scope); }
    if (options.projectId) { clauses.push('project_id=?'); values.push(options.projectId); }
    if (!options.all) clauses.push("status NOT IN ('archived','deleted')");
    if (options.type) { clauses.push('type=?'); values.push(options.type); }
    return this.db.prepare(`SELECT * FROM memories${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...values).map((row) => memoryFromRow(row, this._memoryTags(row.id)));
  }
  searchMemories(options = {}) {
    const query = String(options.query || options.keywords || '').trim(); if (!query) return this.listMemories(options);
    const terms = cleanList(query.replace(/[,，。！？、；：()[\]]/g, ' ').split(/\s+/)).map((term) => `"${term.replace(/"/g, '""')}"*`); if (!terms.length) return [];
    let result = this.db.prepare('SELECT entity_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?').all(terms.join(' OR '), Number(options.limit || 100)).map((item) => this.getMemory(item.entity_id)).filter(Boolean);
    result = result.filter((item) => (!options.scope || item.scope === options.scope) && (!options.projectId || item.projectId === options.projectId) && (!options.type || item.type === options.type) && (options.all || !['archived', 'deleted'].includes(item.status)));
    const tags = cleanList(options.tags).map((item) => item.toLowerCase()); return tags.length ? result.filter((item) => tags.every((tag) => item.tags.some((value) => value.toLowerCase() === tag))) : result;
  }
  createMemory(input) {
    if (!MEMORY_TYPES.has(input.type)) throw new Error(`Invalid memory type: ${input.type}`);
    if ((input.scope || 'project') === 'project' && !input.projectId) throw new Error('Project memory requires projectId.');
    const id = input.id || uuid(); const timestamp = now(); const tags = cleanList(input.tags); const keywords = cleanList(input.keywords);
    return this.transaction(() => {
      const revision = this._change('memory', id, input.projectId || null, 'create');
      const memory = { id, legacyId: String(input.legacyId || ''), scope: input.scope || 'project', projectId: input.projectId || null, type: input.type, title: String(input.title || ''), body: String(input.body || ''), status: input.status || 'active', source: String(input.source || ''), date: String(input.date || timestamp.slice(0, 10)), related: cleanList(input.related), tags, keywords, contentHash: contentHash(input.body), revision, createdAt: timestamp, updatedAt: timestamp, tombstonedAt: null };
      this.db.prepare('INSERT INTO memories(id,legacy_id,scope,project_id,type,title,body,status,source,memory_date,related_json,keywords_json,content_hash,server_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, memory.legacyId, memory.scope, memory.projectId, memory.type, memory.title, memory.body, memory.status, memory.source, memory.date, json(memory.related), json(keywords), memory.contentHash, revision, timestamp, timestamp);
      for (const tag of tags) this.db.prepare('INSERT INTO memory_tags(memory_id,tag) VALUES(?,?)').run(id, tag);
      this.db.prepare('INSERT INTO memory_fts(entity_id,title,body,tags,keywords) VALUES(?,?,?,?,?)').run(id, memory.title, memory.body, tags.join(' '), keywords.join(' '));
      this.db.prepare('INSERT INTO memory_revisions(memory_id,revision,snapshot_json,content_hash,created_at) VALUES(?,?,?,?,?)').run(id, revision, json(memory), memory.contentHash, timestamp);
      this._finishChange(revision, memory); return memory;
    });
  }
  updateMemory(id, patch, options = {}) {
    const current = this.getMemory(id); if (!current) throw new Error(`Memory not found: ${id}`);
    if (options.expectedRevision != null && Number(options.expectedRevision) !== current.revision) throw this._conflict(options.clientId, 'memory', id, options.expectedRevision, current.revision, patch);
    const next = { ...current, ...patch, id, projectId: current.projectId, scope: current.scope };
    next.tags = cleanList(next.tags); next.keywords = cleanList(next.keywords); next.related = cleanList(next.related); next.contentHash = contentHash(next.body); next.updatedAt = now();
    return this.transaction(() => {
      const revision = this._change('memory', id, current.projectId, next.status === 'deleted' ? 'delete' : 'update');
      next.revision = revision; next.tombstonedAt = next.status === 'deleted' ? current.tombstonedAt || next.updatedAt : null;
      this.db.prepare('UPDATE memories SET legacy_id=?,type=?,title=?,body=?,status=?,source=?,memory_date=?,related_json=?,keywords_json=?,content_hash=?,server_revision=?,updated_at=?,tombstoned_at=? WHERE id=?').run(next.legacyId, next.type, next.title, next.body, next.status, next.source, next.date, json(next.related), json(next.keywords), next.contentHash, revision, next.updatedAt, next.tombstonedAt, id);
      this.db.prepare('DELETE FROM memory_tags WHERE memory_id=?').run(id);
      for (const tag of next.tags) this.db.prepare('INSERT INTO memory_tags(memory_id,tag) VALUES(?,?)').run(id, tag);
      this.db.prepare('DELETE FROM memory_fts WHERE entity_id=?').run(id);
      if (next.status !== 'deleted') this.db.prepare('INSERT INTO memory_fts(entity_id,title,body,tags,keywords) VALUES(?,?,?,?,?)').run(id, next.title, next.body, next.tags.join(' '), next.keywords.join(' '));
      this.db.prepare('INSERT INTO memory_revisions(memory_id,revision,snapshot_json,content_hash,created_at) VALUES(?,?,?,?,?)').run(id, revision, json(next), next.contentHash, next.updatedAt);
      this._finishChange(revision, next); return next;
    });
  }
  deleteMemory(id, options = {}) { return this.updateMemory(id, { status: 'deleted' }, options); }
  getDocument(id, options = {}) {
    let row = this.db.prepare('SELECT * FROM documents WHERE id=?').get(id);
    if (!row && options.kind) row = options.projectId ? this.db.prepare('SELECT * FROM documents WHERE project_id=? AND kind=? AND slug=?').get(options.projectId, options.kind, options.slug || options.kind) : this.db.prepare("SELECT * FROM documents WHERE scope='global' AND kind=? AND slug=?").get(options.kind, options.slug || options.kind);
    return documentFromRow(row);
  }
  listDocuments(options = {}) {
    const clauses = []; const values = [];
    if (options.scope) { clauses.push('scope=?'); values.push(options.scope); }
    if (options.projectId) { clauses.push('project_id=?'); values.push(options.projectId); }
    if (options.kind) { clauses.push('kind=?'); values.push(options.kind); }
    if (!options.all) clauses.push("status<>'deleted'");
    return this.db.prepare(`SELECT * FROM documents${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY kind,slug`).all(...values).map(documentFromRow);
  }
  searchDocuments(options = {}) {
    const query = String(options.query || '').trim(); if (!query) return this.listDocuments(options);
    const terms = cleanList(query.split(/\s+/)).map((term) => `"${term.replace(/"/g, '""')}"*`); if (!terms.length) return [];
    return this.db.prepare('SELECT entity_id FROM document_fts WHERE document_fts MATCH ? ORDER BY bm25(document_fts) LIMIT ?').all(terms.join(' OR '), Number(options.limit || 100)).map((row) => this.getDocument(row.entity_id)).filter((item) => item && item.status !== 'deleted').filter((item) => !options.projectId || item.projectId === options.projectId).filter((item) => !options.kind || item.kind === options.kind);
  }
  createDocument(input) {
    if (!DOCUMENT_KINDS.has(input.kind)) throw new Error(`Invalid document kind: ${input.kind}`);
    if ((input.scope || 'project') === 'project' && !input.projectId) throw new Error('Project document requires projectId.');
    const id = input.id || uuid(); const timestamp = now();
    return this.transaction(() => {
      const revision = this._change('document', id, input.projectId || null, 'create');
      const doc = { id, scope: input.scope || 'project', projectId: input.projectId || null, kind: input.kind, slug: input.slug || input.kind, title: String(input.title || ''), body: String(input.body || ''), status: input.status || 'active', metadata: input.metadata || {}, contentHash: contentHash(input.body), revision, createdAt: timestamp, updatedAt: timestamp, tombstonedAt: null };
      this.db.prepare('INSERT INTO documents(id,scope,project_id,kind,slug,title,body,status,metadata_json,content_hash,server_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, doc.scope, doc.projectId, doc.kind, doc.slug, doc.title, doc.body, doc.status, json(doc.metadata), doc.contentHash, revision, timestamp, timestamp);
      this.db.prepare('INSERT INTO document_fts(entity_id,title,body,kind) VALUES(?,?,?,?)').run(id, doc.title, doc.body, doc.kind);
      this.db.prepare('INSERT INTO document_revisions(document_id,revision,snapshot_json,content_hash,created_at) VALUES(?,?,?,?,?)').run(id, revision, json(doc), doc.contentHash, timestamp);
      this._finishChange(revision, doc); return doc;
    });
  }
  updateDocument(id, patch, options = {}) {
    const current = this.getDocument(id); if (!current) throw new Error(`Document not found: ${id}`);
    if (options.expectedRevision != null && Number(options.expectedRevision) !== current.revision) throw this._conflict(options.clientId, 'document', id, options.expectedRevision, current.revision, patch);
    const next = { ...current, ...patch, id, projectId: current.projectId, scope: current.scope, updatedAt: now() }; next.contentHash = contentHash(next.body);
    return this.transaction(() => {
      const revision = this._change('document', id, current.projectId, next.status === 'deleted' ? 'delete' : 'update');
      next.revision = revision; next.tombstonedAt = next.status === 'deleted' ? current.tombstonedAt || next.updatedAt : null;
      this.db.prepare('UPDATE documents SET kind=?,slug=?,title=?,body=?,status=?,metadata_json=?,content_hash=?,server_revision=?,updated_at=?,tombstoned_at=? WHERE id=?').run(next.kind, next.slug, next.title, next.body, next.status, json(next.metadata), next.contentHash, revision, next.updatedAt, next.tombstonedAt, id);
      this.db.prepare('DELETE FROM document_fts WHERE entity_id=?').run(id);
      if (next.status !== 'deleted') this.db.prepare('INSERT INTO document_fts(entity_id,title,body,kind) VALUES(?,?,?,?)').run(id, next.title, next.body, next.kind);
      this.db.prepare('INSERT INTO document_revisions(document_id,revision,snapshot_json,content_hash,created_at) VALUES(?,?,?,?,?)').run(id, revision, json(next), next.contentHash, next.updatedAt);
      this._finishChange(revision, next); return next;
    });
  }
  deleteDocument(id, options = {}) { return this.updateDocument(id, { status: 'deleted' }, options); }
  listChanges(options = {}) {
    const cursor = Number(options.cursor || 0); const limit = Math.min(Math.max(Number(options.limit || 500), 1), 2000);
    const projectIds = cleanList(options.projectIds);
    const hasProjectFilter = Array.isArray(options.projectIds);
    const projectScope = hasProjectFilter
      ? (projectIds.length ? ` AND (project_id IS NULL OR project_id IN (${projectIds.map(() => '?').join(',')}))` : ' AND project_id IS NULL')
      : (options.projectScoped ? ' AND project_id IS NOT NULL' : '');
    const rows = this.db.prepare(`SELECT * FROM sync_changes WHERE revision>?${projectScope} ORDER BY revision LIMIT ?`).all(cursor, ...projectIds, limit);
    const changes = rows.map((row) => ({ revision: row.revision, entityType: row.entity_type, entityId: row.entity_id, projectId: row.project_id || null, operation: row.operation, payload: parseJson(row.payload_json, {}), createdAt: row.created_at }));
    return { cursor, nextCursor: changes.length ? changes[changes.length - 1].revision : ((hasProjectFilter || options.projectScoped) ? this.currentRevision() : cursor), changes };
  }
  registerClient(id, options = {}) {
    const timestamp = now();
    this.db.prepare('INSERT INTO sync_clients(id,machine,cursor,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET machine=excluded.machine,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at').run(id, String(options.machine || os.hostname()), Number(options.cursor || 0), json(options.metadata || {}), timestamp, timestamp);
    return this.db.prepare('SELECT * FROM sync_clients WHERE id=?').get(id);
  }
  applyChanges(clientId, changes) {
    this.registerClient(clientId); const applied = []; const conflicts = [];
    for (const change of changes || []) {
      try {
        let record;
        if (change.entityType === 'memory') record = change.operation === 'create' ? this.createMemory({ ...change.payload, id: change.entityId }) : change.operation === 'delete' ? this.deleteMemory(change.entityId, { expectedRevision: change.expectedRevision, clientId }) : this.updateMemory(change.entityId, change.payload, { expectedRevision: change.expectedRevision, clientId });
        else if (change.entityType === 'document') record = change.operation === 'create' ? this.createDocument({ ...change.payload, id: change.entityId }) : change.operation === 'delete' ? this.deleteDocument(change.entityId, { expectedRevision: change.expectedRevision, clientId }) : this.updateDocument(change.entityId, change.payload, { expectedRevision: change.expectedRevision, clientId });
        else if (change.entityType === 'project' && change.operation === 'update') record = this.updateProject(change.entityId, change.payload, { expectedRevision: change.expectedRevision, clientId });
        else throw new Error(`Unsupported change: ${change.entityType}/${change.operation}`);
        applied.push({ clientChangeId: change.clientChangeId || null, entityId: record.id, revision: record.revision });
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
        conflicts.push({ clientChangeId: change.clientChangeId || null, conflictId: error.conflictId, entityId: error.entityId, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision });
      }
    }
    return { applied, conflicts, serverCursor: this.currentRevision() };
  }
  listConflicts(options = {}) {
    const rows = options.clientId ? this.db.prepare('SELECT * FROM sync_conflicts WHERE status=? AND client_id=? ORDER BY created_at').all(options.status || 'open', options.clientId) : this.db.prepare('SELECT * FROM sync_conflicts WHERE status=? ORDER BY created_at').all(options.status || 'open');
    return rows.map(conflictFromRow);
  }
  getConflict(id) { return conflictFromRow(this.db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(id)); }
  resolveConflict(id, use) {
    if (!['local', 'remote'].includes(use)) throw new Error('Conflict resolution must use local or remote.');
    const row = this.db.prepare("SELECT * FROM sync_conflicts WHERE id=? AND status='open'").get(id);
    if (!row) throw new Error(`Open conflict not found: ${id}`);
    let record = null;
    if (use === 'local') {
      const proposed = parseJson(row.proposed_json, {});
      if (row.entity_type === 'memory') record = this.updateMemory(row.entity_id, proposed, { expectedRevision: row.actual_revision, clientId: row.client_id });
      else if (row.entity_type === 'document') record = this.updateDocument(row.entity_id, proposed, { expectedRevision: row.actual_revision, clientId: row.client_id });
      else if (row.entity_type === 'project') record = this.updateProject(row.entity_id, proposed, { expectedRevision: row.actual_revision, clientId: row.client_id });
      else throw new Error(`Unsupported conflict entity type: ${row.entity_type}`);
    }
    this.db.prepare("UPDATE sync_conflicts SET status='resolved',resolved_at=? WHERE id=?").run(now(), id);
    return { id, use, record, conflict: this.getConflict(id) };
  }
  getContext(options = {}) {
    let projectId = options.projectId || null;
    if (!projectId && options.location) projectId = this.resolveProject({ path: options.location, pathFlavor: options.pathFlavor, machine: options.machine, create: false })?.id || null;
    const project = projectId ? this.getProject(projectId) : null;
    if (projectId && !project) throw new Error(`Project not found: ${projectId}`);
    const sanitize = (record) => ({
      ...record,
      body: String(record.body || '').split(/\r?\n/).filter((line) => !/(?:password|secret|token|authorization|api[_-]?key|private[_-]?key)\s*[:=]/i.test(line)).join('\n'),
    });
    const projectAttention = project ? this.db.prepare("SELECT * FROM documents WHERE project_id=? AND status='active' AND kind='attention' ORDER BY slug,id").all(project.id).map(documentFromRow).map(sanitize) : [];
    const globalAttention = this.db.prepare("SELECT * FROM documents WHERE scope='global' AND status='active' AND kind='attention' ORDER BY slug,id").all().map(documentFromRow).map(sanitize);
    const projectMemories = project ? this.db.prepare("SELECT id FROM memories WHERE project_id=? AND status='active' ORDER BY memory_date DESC,title COLLATE NOCASE,id").all(project.id).map((row) => this.getMemory(row.id)).map(sanitize) : [];
    const globalMemories = this.db.prepare("SELECT id FROM memories WHERE scope='global' AND status='active' ORDER BY memory_date DESC,title COLLATE NOCASE,id").all().map((row) => this.getMemory(row.id)).map(sanitize);
    const entries = [];
    for (const doc of projectAttention) entries.push({ kind: 'project-attention', id: doc.id, text: `## Project attention\n${doc.body.trim()}` });
    for (const doc of globalAttention) entries.push({ kind: 'global-attention', id: doc.id, text: `## Global attention\n${doc.body.trim()}` });
    for (const memory of projectMemories) entries.push({ kind: 'project-memory', id: memory.id, text: `## Project memory: ${memory.title}\nType: ${memory.type}\n${memory.body.trim()}` });
    for (const memory of globalMemories) entries.push({ kind: 'global-memory', id: memory.id, text: `## Global memory: ${memory.title}\nType: ${memory.type}\n${memory.body.trim()}` });
    const maxChars = Math.min(128 * 1024, Math.max(Number(options.maxChars ?? options.max_chars ?? 32000), 0));
    const chunks = []; let usedChars = 0; let truncated = false;
    for (const entry of entries) {
      const separator = chunks.length ? '\n\n' : '';
      const available = maxChars - usedChars - Buffer.byteLength(separator);
      if (available <= 0) { truncated = true; break; }
      const entryBytes = Buffer.byteLength(entry.text);
      if (entryBytes <= available) { chunks.push(entry.text); usedChars += Buffer.byteLength(separator) + entryBytes; continue; }
      const suffix = '\n[truncated]';
      const suffixBytes = Buffer.byteLength(suffix);
      const text = available > suffixBytes ? utf8Prefix(entry.text, available - suffixBytes) + suffix : utf8Prefix(entry.text, available);
      chunks.push(text);
      usedChars += Buffer.byteLength(separator) + Buffer.byteLength(text);
      truncated = true;
      break;
    }
    return { revision: this.currentRevision(), project, context_text: chunks.join('\n\n'), max_chars: maxChars, used_chars: usedChars, truncated, totals: { projectAttention: projectAttention.length, globalAttention: globalAttention.length, projectMemories: projectMemories.length, globalMemories: globalMemories.length }, projectAttention, globalAttention, projectMemories, globalMemories };
  }
  upsertSkillMetadata(input) {
    const timestamp = now(); const body = json(input.metadata || {}); const hash = input.contentHash || contentHash(body);
    this.db.prepare('INSERT INTO skill_metadata(name,family,source,path,description,metadata_json,content_hash,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET family=excluded.family,source=excluded.source,path=excluded.path,description=excluded.description,metadata_json=excluded.metadata_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at').run(input.name, input.family || '', input.source || '', input.path || '', input.description || '', body, hash, timestamp);
  }
  listSkills() { return this.db.prepare('SELECT * FROM skill_metadata ORDER BY family,name').all().map((row) => ({ name: row.name, family: row.family, source: row.source, path: row.path, description: row.description, metadata: parseJson(row.metadata_json, {}), contentHash: row.content_hash, revision: row.server_revision, updatedAt: row.updated_at })); }
  upsertArtifactMetadata(input) {
    const id = input.id || uuid(); const timestamp = now(); const body = json(input.metadata || {}); const hash = input.contentHash || contentHash(body);
    this.db.prepare('INSERT INTO artifact_metadata(id,project_id,kind,slug,source_path,metadata_json,content_hash,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,kind,slug) DO UPDATE SET source_path=excluded.source_path,metadata_json=excluded.metadata_json,content_hash=excluded.content_hash,updated_at=excluded.updated_at').run(id, input.projectId || null, input.kind, input.slug, input.sourcePath || '', body, hash, timestamp);
  }
  recordImportSnapshot(input) { this.db.prepare('INSERT INTO import_snapshots(id,source_root,source_hash,report_json,imported_at) VALUES(?,?,?,?,?)').run(input.id || uuid(), input.sourceRoot, input.sourceHash, json(input.report), now()); }
}

export { KNOWLEDGE_SCHEMA_VERSION };
