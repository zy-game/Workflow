// registry.js - pending approval state over core.db. Approvals are raised by
// a worker when its local DSH blocks a turn on a permission decision; the
// DSH-side identifiers are persisted so any resolution surface (Feishu card,
// Feishu reply, admin console) can reach the blocked turn across restarts.
import crypto from 'node:crypto';

export class ApprovalRegistry {
  constructor({ coreDb, db } = {}) {
    this.db = db || coreDb.db;
  }

  create({ taskId, tool = null, risk = null, reason = null, dshApprovalId = null, dshRpcId = null, dshSessionId = null }) {
    const approvalId = `ap-${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO pending_approvals (
        approval_id, task_id, tool, risk, reason, dsh_approval_id, dsh_rpc_id, dsh_session_id,
        status, created_at
      ) VALUES (?,?,?,?,?,?,?,?, 'pending', ?)
    `).run(
      approvalId, taskId, tool, risk, reason, dshApprovalId, dshRpcId, dshSessionId,
      new Date().toISOString(),
    );
    return this.get(approvalId);
  }

  #rowToApproval(row) {
    if (!row) return null;
    return {
      approval_id: row.approval_id,
      task_id: row.task_id,
      tool: row.tool,
      risk: row.risk,
      reason: row.reason,
      dsh_approval_id: row.dsh_approval_id,
      dsh_rpc_id: row.dsh_rpc_id,
      dsh_session_id: row.dsh_session_id,
      status: row.status,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    };
  }

  get(approvalId) {
    return this.#rowToApproval(this.db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId));
  }

  pendingForTask(taskId) {
    return this.#rowToApproval(this.db.prepare(
      "SELECT * FROM pending_approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC",
    ).get(taskId));
  }

  pending({ taskId = null } = {}) {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM pending_approvals WHERE status = 'pending' AND task_id = ? ORDER BY created_at DESC").all(taskId)
      : this.db.prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at DESC").all();
    return rows.map((row) => this.#rowToApproval(row));
  }

  // Marks the approval decided; returns the pre-update row (with DSH ids) or
  // null when unknown/already resolved.
  resolve(approvalId, approved, operator) {
    const row = this.db.prepare(
      "SELECT * FROM pending_approvals WHERE approval_id = ? AND status = 'pending'",
    ).get(approvalId);
    if (!row) return null;
    this.db.prepare(
      'UPDATE pending_approvals SET status = ?, resolved_at = ? WHERE approval_id = ?',
    ).run(approved ? 'approved' : 'denied', new Date().toISOString(), approvalId);
    return { ...this.#rowToApproval(row), resolved_by: operator };
  }
}
