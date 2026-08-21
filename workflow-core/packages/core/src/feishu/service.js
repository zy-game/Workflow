// service.js - Feishu backend of the core: inbound messages become watched
// tasks, live task events refresh the watch card (throttled), replies to the
// card inject corrections into the running session, buttons cancel/pause, and
// worker approval requests turn into approve/deny cards routed back to the
// worker. The Feishu WebSocket long connection is owned by start(); tests
// drive the service handlers directly.
import crypto from 'node:crypto';
import { buildTaskCard } from './client.js';
import { parseDecisionJson } from '../ai/driver.js';
import { ApprovalRegistry } from '../approvals/registry.js';

const CARD_THROTTLE_MS = 3000;
const IMMEDIATE_EVENT_TYPES = new Set(['done', 'failed', 'cancelled', 'approval_request', 'injected']);
const APPROVE_REPLY = /^(?:批准|同意|允许|approve|allow)[!。.!，,\s]*$/i;
const DENY_REPLY = /^(?:拒绝|不同意|deny|reject)[!。.!，,\s]*$/i;

export class FeishuService {
  constructor({ client, taskRepository, workerChannel, coreDb, db = null, driver = null, approvals = null, log = () => {} } = {}) {
    this.client = client;
    this.tasks = taskRepository;
    this.channel = workerChannel;
    this.db = db || coreDb.db;
    this.driver = driver;
    this.approvals = approvals ?? new ApprovalRegistry({ db: this.db });
    this.log = log;
    this.connection = null;
    this.timers = new Map(); // task_id -> pending flush timer
    this.unsubscribe = this.tasks.onEvent((event) => this.#onTaskEvent(event));
  }

  stop() {
    this.connection?.stop();
    this.connection = null;
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  connectionStatus() {
    return this.connection?.status() ?? { enabled: true, state: 'idle' };
  }

  async connect(options) {
    if (this.connection) throw new Error('Feishu connection has already been created');
    const connection = new FeishuConnection(this, options);
    this.connection = connection;
    await connection.start();
    return connection;
  }

  // --- inbound -----------------------------------------------------------
  #deduped(messageId, chatId) {
    const changes = this.db.prepare('INSERT OR IGNORE INTO feishu_inbox(message_id, chat_id, ts) VALUES (?,?,?)')
      .run(messageId, chatId, new Date().toISOString()).changes;
    return changes > 0;
  }

  async handleInboundMessage({ messageId, chatId, text, senderId = null }) {
    if (!messageId || !chatId || typeof text !== 'string' || !text.trim()) return { ok: false, error: 'invalid_message' };
    if (!this.#deduped(messageId, chatId)) return { ok: true, duplicate: true };

    // A reply in a chat with an active watched task is a correction, not a
    // new task. A bare 批准/拒绝 reply decides a pending approval instead.
    const watched = this.#activeWatchForChat(chatId);
    if (watched && watched.task_id) {
      const pending = this.approvals.pendingForTask(watched.task_id);
      if (pending) {
        const operator = `feishu:${senderId ?? 'user'}`;
        if (APPROVE_REPLY.test(text.trim())) {
          const resolved = this.channel?.resolveApproval
            ? this.channel.resolveApproval(pending.approval_id, true, operator)
            : this.#resolveApproval(pending.approval_id, true, operator);
          return { ok: resolved.ok !== false, approval_resolved: true, approved: true, task_id: watched.task_id };
        }
        if (DENY_REPLY.test(text.trim())) {
          const resolved = this.channel?.resolveApproval
            ? this.channel.resolveApproval(pending.approval_id, false, operator)
            : this.#resolveApproval(pending.approval_id, false, operator);
          return { ok: resolved.ok !== false, approval_resolved: true, approved: false, task_id: watched.task_id };
        }
      }
      const delivered = await this.#inject(watched.task_id, text, `feishu:${senderId ?? 'user'}`);
      if (delivered) return { ok: true, injected: true, task_id: watched.task_id };
    }

    const brief = await this.#triage(text);
    const { task } = this.tasks.create({
      type: 'feishu.message',
      title: excerptOf(text, 60),
      brief,
      created_by: 'machine:feishu',
    });
    await this.#watch(task, chatId);
    if (this.channel?.tryDispatch) {
      setImmediate(() => {
        try {
          this.channel.tryDispatch();
        } catch (error) {
          this.log(`[feishu] dispatch failed for ${task.task_id}: ${error.message}`);
        }
      });
    }
    return { ok: true, task_id: task.task_id };
  }

  // Optional AI triage refines the raw message into a structured brief;
  // any failure falls back to the plain message as the goal.
  async #triage(text) {
    if (!this.driver) return { goal: text, context: '来自飞书消息' };
    try {
      const reply = await this.driver.ask('feishu-triage', [
        '把下面的飞书消息整理成任务 brief。只回复 JSON：{"goal":"一句话目标","acceptance":["验收标准"],"context":"补充上下文"}',
        `消息：${text}`,
      ].join('\n'));
      const parsed = parseDecisionJson(reply);
      if (parsed?.goal) {
        return {
          goal: String(parsed.goal),
          acceptance: Array.isArray(parsed.acceptance) ? parsed.acceptance.map(String).slice(0, 5) : [],
          context: `${parsed.context ?? ''}\n原始消息：${text}`.trim(),
        };
      }
    } catch (error) {
      this.log(`[feishu] triage fallback: ${error.message}`);
    }
    return { goal: text, context: '来自飞书消息' };
  }

  // --- watch cards -------------------------------------------------------
  #activeWatchForChat(chatId) {
    return this.db.prepare('SELECT * FROM watch_subscriptions WHERE chat_id = ? AND active = 1 ORDER BY created_at DESC').get(chatId) ?? null;
  }

  async #watch(task, chatId) {
    const card = buildTaskCard({ task });
    const { message_id } = await this.client.sendCard(chatId, card);
    this.db.prepare('INSERT INTO watch_subscriptions(id, task_id, chat_id, message_id, last_card_at, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(`ws-${crypto.randomUUID()}`, task.task_id, chatId, message_id, new Date().toISOString(), new Date().toISOString());
    return message_id;
  }

  async #onTaskEvent(event) {
    const { task_id: taskId, type } = event;
    const watched = this.db.prepare('SELECT 1 FROM watch_subscriptions WHERE task_id = ? AND active = 1').get(taskId);
    if (!watched) return;
    const immediate = IMMEDIATE_EVENT_TYPES.has(type);
    const pending = this.timers.get(taskId);
    if (pending) {
      if (!immediate) return; // coalesced into the already-pending refresh
      clearTimeout(pending);
      this.timers.delete(taskId);
    }
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.#refreshCard(taskId).catch((error) => this.log(`[feishu] card refresh failed: ${error.message}`));
    }, immediate ? 0 : CARD_THROTTLE_MS);
    timer.unref();
    this.timers.set(taskId, timer);
  }

  async #refreshCard(taskId) {
    const subs = this.db.prepare('SELECT * FROM watch_subscriptions WHERE task_id = ? AND active = 1').all(taskId);
    if (!subs.length) return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    const events = this.tasks.events(taskId, { type: 'session_event', limit: 50 });
    const approval = this.approvals.pendingForTask(taskId);
    const card = buildTaskCard({
      task,
      events,
      approval: approval ? { approval_id: approval.approval_id, tool: approval.tool, risk: approval.risk, reason: approval.reason } : null,
    });
    for (const sub of subs) {
      if (!sub.message_id) continue;
      try {
        await this.client.updateCard(sub.message_id, card);
        this.db.prepare('UPDATE watch_subscriptions SET last_card_at = ? WHERE id = ?').run(new Date().toISOString(), sub.id);
      } catch (error) {
        this.log(`[feishu] card update failed for ${sub.id}: ${error.message}`);
      }
    }
    if (['done', 'failed', 'cancelled'].includes(task.status)) {
      this.db.prepare('UPDATE watch_subscriptions SET active = 0 WHERE task_id = ?').run(taskId);
    }
  }

  // --- outbound actions --------------------------------------------------
  async #inject(taskId, content, by) {
    const task = this.tasks.get(taskId);
    if (!task || !['dispatched', 'running'].includes(task.status)) return false;
    const delivered = this.channel?.sendToWorker(task.claim_worker_id, {
      type: 'inject', id: crypto.randomUUID(), ts: new Date().toISOString(),
      payload: { task_id: taskId, content, by },
    });
    if (delivered) this.tasks.appendEvent(taskId, 'injected', { content }, by);
    return Boolean(delivered);
  }

  // Card button callback. `value` is the button's value payload from Feishu.
  async handleCardAction(value, operator = 'feishu-user') {
    const kind = value?.kind;
    if (kind === 'cancel') {
      const task = this.tasks.get(value.task_id);
      if (!task) return { ok: false, error: 'task_not_found' };
      try {
        const cancelled = this.tasks.cancel(value.task_id, operator);
        this.channel?.sendToWorker(cancelled.claim_worker_id ?? value.task_id, {
          type: 'cancel', id: crypto.randomUUID(), ts: new Date().toISOString(),
          payload: { task_id: value.task_id, reason: `cancelled by ${operator}` },
        });
        return { ok: true, status: cancelled.status };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    if (kind === 'pause') {
      const delivered = await this.#inject(value.task_id, '暂停：请停止当前步骤，总结已完成的进度和当前状态，等待进一步指示。', operator);
      return { ok: delivered };
    }
    if (kind === 'approve' || kind === 'deny') {
      if (this.channel?.resolveApproval) {
        return this.channel.resolveApproval(value.approval_id, kind === 'approve', operator);
      }
      return this.#resolveApproval(value.approval_id, kind === 'approve', operator);
    }
    return { ok: false, error: `unknown action: ${kind}` };
  }

  #resolveApproval(approvalId, approved, operator) {
    const row = this.approvals.resolve(approvalId, approved, operator);
    if (!row) return { ok: false, error: 'approval_not_found' };
    this.tasks.appendSessionEvent(row.task_id, {
      kind: 'approval_resolved', approval_id: approvalId, approved, by: operator,
    }, operator);
    const task = this.tasks.get(row.task_id);
    if (task?.claim_worker_id && this.channel) {
      this.channel.sendToWorker(task.claim_worker_id, {
        type: 'approval_result', id: crypto.randomUUID(), ts: new Date().toISOString(),
        payload: {
          task_id: row.task_id, approval_id: approvalId, approved, by: operator,
          dsh_approval_id: row.dsh_approval_id, dsh_rpc_id: row.dsh_rpc_id, dsh_session_id: row.dsh_session_id,
        },
      });
    }
    return { ok: true, approved };
  }

  // Card refresh entry point for other surfaces (e.g. the WS channel after an
  // approval was decided outside Feishu).
  async refreshCardForTask(taskId) {
    return this.#refreshCard(taskId);
  }

  // Called by the WS channel when a worker raises an approval request; the
  // card refresh path renders the pending approval into the watch card.
  async handleApprovalRequest(payload) {
    const record = this.approvals.create({
      taskId: payload.task_id,
      tool: payload.tool ?? null,
      risk: payload.risk ?? null,
      reason: payload.reason ?? null,
      dshApprovalId: payload.dsh_approval_id ?? null,
      dshRpcId: payload.dsh_rpc_id ?? null,
      dshSessionId: payload.dsh_session_id ?? null,
    });
    this.tasks.appendSessionEvent(payload.task_id, {
      kind: 'approval_request', approval_id: record.approval_id,
      tool: record.tool, risk: record.risk, reason: record.reason,
    }, 'worker');
    await this.#refreshCard(payload.task_id);
    return { approval_id: record.approval_id };
  }
}

function excerptOf(text, length) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length)}…` : compact;
}

export class FeishuConnection {
  constructor(service, {
    appId,
    appSecret,
    connectTimeoutMs = 30_000,
    log = () => {},
    loadSdk = () => import('@larksuiteoapi/node-sdk'),
  } = {}) {
    this.service = service;
    this.appId = appId;
    this.appSecret = appSecret;
    this.connectTimeoutMs = connectTimeoutMs;
    this.log = log;
    this.loadSdk = loadSdk;
    this.client = null;
    this.state = 'idle';
    this.lastError = null;
    this.connectedAt = null;
    this.stopped = false;
  }

  status() {
    const sdkStatus = this.client?.getConnectionStatus?.();
    const terminalState = this.stopped || this.state === 'failed';
    return {
      enabled: true,
      state: this.stopped ? 'stopped' : (terminalState ? this.state : (sdkStatus?.state ?? this.state)),
      connected_at: this.connectedAt,
      last_error: this.lastError,
      reconnect_attempts: sdkStatus?.reconnectAttempts ?? 0,
      last_connect_at: sdkStatus?.lastConnectTime
        ? new Date(sdkStatus.lastConnectTime).toISOString()
        : null,
      next_connect_at: sdkStatus?.nextConnectTime
        ? new Date(sdkStatus.nextConnectTime).toISOString()
        : null,
    };
  }

  async start() {
    if (!this.appId || !this.appSecret) throw new Error('Feishu App ID and App Secret are required');
    if (this.state !== 'idle') throw new Error('Feishu connection has already started');
    this.state = 'connecting';
    const lark = await this.loadSdk();
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const message = data?.message ?? data?.event?.message ?? {};
          let text = message.content ?? '';
          try { text = JSON.parse(text).text ?? text; } catch { /* plain text */ }
          if (!text) return;
          await this.service.handleInboundMessage({
            messageId: message.message_id,
            chatId: message.chat_id ?? data?.chat_id,
            text: String(text).replace(/@_user_\d+/g, '').trim(),
            senderId: data?.event?.sender?.sender_id?.open_id
              ?? data?.sender?.sender_id?.open_id
              ?? data?.sender?.open_id
              ?? null,
          });
        } catch (error) {
          this.log(`[feishu] inbound message failed: ${error.message}`);
        }
      },
    });

    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Feishu WebSocket did not connect within ${this.connectTimeoutMs}ms`));
    }, this.connectTimeoutMs);
    timeout.unref?.();

    this.client = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: 'warn',
      autoReconnect: true,
      handshakeTimeoutMs: Math.min(this.connectTimeoutMs, 15_000),
      wsConfig: { pingTimeout: 10 },
      onReady: () => {
        this.state = 'connected';
        this.lastError = null;
        this.connectedAt = new Date().toISOString();
        this.log('[feishu] websocket long connection ready');
        resolveReady();
      },
      onError: (error) => {
        this.state = 'failed';
        this.lastError = error.message;
        this.log(`[feishu] websocket terminal error: ${error.message}`);
        rejectReady(error);
      },
      onReconnecting: () => {
        this.state = 'reconnecting';
        this.log('[feishu] websocket reconnecting');
      },
      onReconnected: () => {
        this.state = 'connected';
        this.lastError = null;
        this.connectedAt = new Date().toISOString();
        this.log('[feishu] websocket reconnected');
      },
    });

    try {
      await this.client.start({ eventDispatcher: dispatcher });
      await ready;
      return this;
    } catch (error) {
      this.state = 'failed';
      this.lastError = error.message;
      this.client.close({ force: true });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.client?.close({ force: true });
  }
}

export async function connectFeishuWebSocket(service, options) {
  return service.connect(options);
}
