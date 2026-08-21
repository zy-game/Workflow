// schema.js - workflow.db server schema. Byte-compatible with the previous
// wf-api authority (schema v1) so the production knowledge database carries
// over to the new core unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const KNOWLEDGE_SCHEMA_VERSION = 1;

export const SERVER_SCHEMA = `
CREATE TABLE repository_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
INSERT INTO repository_meta(key,value) VALUES('current_revision','0'),('schema_version','1');
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', metadata_json TEXT NOT NULL DEFAULT '{}', server_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tombstoned_at TEXT
) STRICT;
CREATE TABLE project_locations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  machine TEXT NOT NULL, path_flavor TEXT NOT NULL CHECK(path_flavor IN ('windows','posix')),
  normalized_path TEXT NOT NULL, display_path TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(machine,path_flavor,normalized_path)
) STRICT;
CREATE INDEX project_locations_project ON project_locations(project_id);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, legacy_id TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL CHECK(scope IN ('global','project')),
  project_id TEXT REFERENCES projects(id), type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT '', memory_date TEXT NOT NULL DEFAULT '',
  related_json TEXT NOT NULL DEFAULT '[]', keywords_json TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL,
  server_revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tombstoned_at TEXT,
  CHECK((scope='global' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX memories_legacy_global ON memories(legacy_id) WHERE scope='global' AND legacy_id<>'';
CREATE UNIQUE INDEX memories_legacy_project ON memories(project_id,legacy_id) WHERE scope='project' AND legacy_id<>'';
CREATE INDEX memories_scope_project ON memories(scope,project_id,status);
CREATE TABLE memory_revisions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(memory_id,revision)
) STRICT;
CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, tag TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY(memory_id,tag)
) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(entity_id UNINDEXED,title,body,tags,keywords,tokenize='unicode61');
CREATE TABLE documents (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('global','project')), project_id TEXT REFERENCES projects(id),
  kind TEXT NOT NULL CHECK(kind IN ('attention','roadmap','tracking')), slug TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', metadata_json TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
  server_revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, tombstoned_at TEXT,
  CHECK((scope='global' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX documents_global_key ON documents(kind,slug) WHERE scope='global';
CREATE UNIQUE INDEX documents_project_key ON documents(project_id,kind,slug) WHERE scope='project';
CREATE TABLE document_revisions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(document_id,revision)
) STRICT;
CREATE VIRTUAL TABLE document_fts USING fts5(entity_id UNINDEXED,title,body,kind,tokenize='unicode61');
CREATE TABLE sync_clients (
  id TEXT PRIMARY KEY, machine TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE sync_changes (
  revision INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  project_id TEXT, operation TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX sync_changes_entity ON sync_changes(entity_type,entity_id,revision);
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY, client_id TEXT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL, actual_revision INTEGER NOT NULL, proposed_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_at TEXT
) STRICT;
CREATE TABLE skill_metadata (
  name TEXT PRIMARY KEY, family TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL DEFAULT '',
  server_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE artifact_metadata (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), kind TEXT NOT NULL, slug TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL DEFAULT '',
  server_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(project_id,kind,slug)
) STRICT;
CREATE TABLE import_snapshots (
  id TEXT PRIMARY KEY, source_root TEXT NOT NULL, source_hash TEXT NOT NULL, report_json TEXT NOT NULL, imported_at TEXT NOT NULL
) STRICT;
`;

export function configureKnowledgeDatabase(db, options = {}) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeout || 5000)}`);
  if (!options.readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
}

export function migrateKnowledge(db, schema = SERVER_SCHEMA) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (version > KNOWLEDGE_SCHEMA_VERSION) {
    throw new Error(`SQLite schema ${version} is newer than supported schema ${KNOWLEDGE_SCHEMA_VERSION}.`);
  }
  if (version === 0) db.exec(`BEGIN IMMEDIATE;${schema}PRAGMA user_version=${KNOWLEDGE_SCHEMA_VERSION};COMMIT;`);
}

export function openKnowledgeDatabase(filename, options = {}) {
  const target = path.resolve(filename);
  if (!options.readOnly) fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target, { readOnly: Boolean(options.readOnly) });
  configureKnowledgeDatabase(db, options);
  if (!options.readOnly) migrateKnowledge(db);
  return db;
}
