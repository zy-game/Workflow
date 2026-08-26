// Runtime registry for one project agent per Workflow project.
import crypto from 'node:crypto';

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function fromRow(row) {
  if (!row) return null;
  return {
    agent_id: row.agent_id,
    project_id: row.project_id,
    name: row.name,
    status: row.status,
    capabilities: parseJson(row.capabilities_json, []),
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ProjectAgentRegistry {
  constructor({ coreDb, db } = {}) {
    this.db = db || coreDb.db;
  }

  ensure(projectId, { name = `project-agent:${projectId}`, capabilities = [], metadata = {} } = {}) {
    if (!projectId || typeof projectId !== 'string') throw new TypeError('project_id is required');
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM project_agents WHERE project_id = ?').get(projectId);
    if (existing) return fromRow(existing);
    const agentId = `pa-${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO project_agents(agent_id, project_id, name, status, capabilities_json, metadata_json, created_at, updated_at)
      VALUES(?,?,?,'active',?,?,?,?)
    `).run(agentId, projectId, String(name), JSON.stringify([...new Set(capabilities)]), JSON.stringify(metadata), now, now);
    return this.get(agentId);
  }

  get(agentId) {
    return fromRow(this.db.prepare('SELECT * FROM project_agents WHERE agent_id = ?').get(agentId));
  }

  getByProject(projectId) {
    return fromRow(this.db.prepare('SELECT * FROM project_agents WHERE project_id = ?').get(projectId));
  }

  list({ projectId = null, status = null } = {}) {
    const clauses = [];
    const args = [];
    if (projectId) { clauses.push('project_id = ?'); args.push(projectId); }
    if (status) { clauses.push('status = ?'); args.push(status); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM project_agents${where} ORDER BY project_id, agent_id`).all(...args).map(fromRow);
  }

  update(agentId, patch = {}) {
    const current = this.get(agentId);
    if (!current) throw new Error('project agent does not exist');
    const next = {
      ...current,
      ...patch,
      agent_id: current.agent_id,
      project_id: current.project_id,
      capabilities: patch.capabilities ?? current.capabilities,
      metadata: patch.metadata ?? current.metadata,
      updated_at: new Date().toISOString(),
    };
    if (!['active', 'paused', 'disabled'].includes(next.status)) throw new TypeError('invalid project agent status');
    this.db.prepare(`
      UPDATE project_agents SET name=?, status=?, capabilities_json=?, metadata_json=?, updated_at=? WHERE agent_id=?
    `).run(next.name, next.status, JSON.stringify(next.capabilities), JSON.stringify(next.metadata), next.updated_at, agentId);
    return this.get(agentId);
  }
}
