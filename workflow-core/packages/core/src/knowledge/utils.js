// utils.js - shared helpers for the knowledge repository (ported as-is; the
// normalization rules are part of the data contract with existing rows).
import crypto from 'node:crypto';
import path from 'node:path';

export function now() { return new Date().toISOString(); }
export function uuid() { return crypto.randomUUID(); }
export function json(value) { return JSON.stringify(value == null ? null : value); }
export function parseJson(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}
export function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || '').replace(/\r\n?/g, '\n')).digest('hex');
}
export function cleanList(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
}
export function pathFlavor(value) {
  const text = String(value || '');
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text) ? 'windows' : 'posix';
}
export function normalizeProjectPath(value, flavor = pathFlavor(value)) {
  const text = String(value || '').trim();
  if (!text || text.includes('\0')) throw new Error('Project path must be non-empty and contain no NUL bytes.');
  if (flavor === 'windows') {
    let normalized = path.win32.normalize(text.replace(/\//g, '\\')).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) normalized = normalized[0].toUpperCase() + normalized.slice(1);
    if (normalized.length > 3) normalized = normalized.replace(/\/$/, '');
    return normalized.toLowerCase();
  }
  if (!text.startsWith('/')) throw new Error('POSIX project paths must be absolute.');
  const normalized = path.posix.normalize(text);
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}
export function displayProjectPath(value, flavor = pathFlavor(value)) {
  if (flavor === 'windows') {
    let normalized = path.win32.normalize(String(value).replace(/\//g, '\\'));
    if (/^[A-Za-z]:/.test(normalized)) normalized = normalized[0].toUpperCase() + normalized.slice(1);
    return normalized;
  }
  return path.posix.normalize(String(value));
}
export function projectBasename(value, flavor = pathFlavor(value)) {
  const displayed = displayProjectPath(value, flavor);
  return flavor === 'windows' ? path.win32.basename(displayed) : path.posix.basename(displayed);
}
export function memoryFromRow(row, tags = []) {
  if (!row) return null;
  return {
    id: row.id, legacyId: row.legacy_id || '', scope: row.scope, projectId: row.project_id || null,
    type: row.type, title: row.title, body: row.body, status: row.status, source: row.source || '',
    date: row.memory_date || '', related: parseJson(row.related_json, []), tags,
    keywords: parseJson(row.keywords_json, []), contentHash: row.content_hash,
    revision: row.server_revision, createdAt: row.created_at, updatedAt: row.updated_at,
    tombstonedAt: row.tombstoned_at || null,
  };
}
export function conflictFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, clientId: row.client_id || null, entityType: row.entity_type,
    entityId: row.entity_id, expectedRevision: row.expected_revision,
    actualRevision: row.actual_revision, proposed: parseJson(row.proposed_json, {}),
    status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at || null,
  };
}
export function documentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, scope: row.scope, projectId: row.project_id || null, kind: row.kind,
    slug: row.slug, title: row.title || '', body: row.body, status: row.status,
    metadata: parseJson(row.metadata_json, {}), contentHash: row.content_hash,
    revision: row.server_revision, createdAt: row.created_at, updatedAt: row.updated_at,
    tombstonedAt: row.tombstoned_at || null,
  };
}
