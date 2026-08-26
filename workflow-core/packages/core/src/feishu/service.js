// service.js - Feishu task intake, live cards, session correction, and
// backend-neutral question/approval responses. Credential and file selection
// interactions never pass through this surface.
import crypto from 'node:crypto';
import { buildTaskCard } from './client.js';

const CARD_THROTTLE_MS = 3000;
const IMMEDIATE_EVENT_TYPES = new Set([
  'done', 'failed', 'cancelled', 'awaiting_input', 'input_delivered',
  'interaction_cancelled', 'injected',
]);
const APPROVE_REPLY = /^(?:批准|同意|允许|approve|allow)[!。.!，,\s]*$/i;
const DENY_REPLY = /^(?:拒绝|不同意|deny|reject)[!。.!，,\s]*$/i;

export class FeishuService {
  constructor({ client, taskRepository, interactionRepository, workerChannel, coreDb, db = null, log = () => {} } = {}) {
    this.client = client;
    this.tasks = taskRepository;
    this.interactions = interactionRepository;
    this.channel = workerChannel;
    this.db = db || coreDb.db;
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

  async handleInboundMessage({ messageId, chatId, text, senderId = null, projectId = null, project_id = null }) {
    if (!messageId || !chatId || typeof text !== 'string' || !text.trim()) return { ok: false, error: 'invalid_message' };
    if (!this.#deduped(messageId, chatId)) return { ok: true, duplicate: true };

    // A reply in a watched chat is first offered to a pending approval. Other
    // text remains a correction for the active task instead of creating work.
    const watched = this.#activeWatchForChat(chatId);
    const watchedTask = watched?.task_id ? this.tasks.get(watched.task_id) : null;
    const requestedProjectId = projectId || project_id || watchedTask?.project_id || null;
    if (watched?.task_id) {
      const pending = this.#pendingRemoteInteraction(watched.task_id);
      const operator = `feishu:${senderId ?? 'user'}`;
      if (pending?.kind === 'approval') {
        const approved = APPROVE_REPLY.test(text.trim()) ? true
          : DENY_REPLY.test(text.trim()) ? false : null;
        if (approved !== null) {
          const result = this.#resolveInteraction(
            pending,
            approvalAnswers(pending, approved),
            operator,
            `feishu-message-${messageId}`,
          );
          return {
            ok: result.ok,
            interaction_resolved: result.ok,
            approved,
            task_id: watched.task_id,
            ...(result.ok ? {} : { error: result.error }),
          };
        }
      }
      if (pending?.kind === 'question') {
        const questions = Array.isArray(pending.schema?.questions) ? pending.schema.questions : [];
        if (questions.length === 1 && !questions[0].options?.length) {
          const result = this.#resolveInteraction(
            pending,
            { [questions[0].id]: text },
            operator,
            `feishu-message-${messageId}`,
          );
          return {
            ok: result.ok,
            interaction_resolved: result.ok,
            task_id: watched.task_id,
            ...(result.ok ? {} : { error: result.error }),
          };
        }
        return { ok: false, error: 'interaction_option_required', task_id: watched.task_id };
      }
      const delivered = await this.#inject(watched.task_id, text, operator);
      if (delivered) return { ok: true, injected: true, task_id: watched.task_id };
    }

    const brief = await this.#triage(text);
    const { task } = this.tasks.create({
      type: 'feishu.message',
      title: excerptOf(text, 60),
      brief,
      project_id: requestedProjectId,
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

  async #triage(text) {
    return { goal: text, context: '来自飞书消息' };
  }

  // --- watch cards -------------------------------------------------------
  #activeWatchForChat(chatId) {
    return this.db.prepare('SELECT * FROM watch_subscriptions WHERE chat_id = ? AND active = 1 ORDER BY created_at DESC').get(chatId) ?? null;
  }

  #pendingRemoteInteraction(taskId) {
    return this.interactions?.list({ taskId, status: 'pending' })
      .find((interaction) => ['question', 'approval'].includes(interaction.kind)) ?? null;
  }

  #resolveInteraction(interaction, answers, operator, responseId = crypto.randomUUID()) {
    if (!interaction || !this.channel?.resolveInteraction) {
      return { ok: false, error: 'interaction_channel_unavailable' };
    }
    return this.channel.resolveInteraction(interaction.interaction_id, {
      interaction_id: interaction.interaction_id,
      response_id: responseId,
      answers,
      answered_by: operator,
    });
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
    const interactions = this.interactions?.list({ taskId, status: 'pending' })
      .filter((interaction) => ['question', 'approval'].includes(interaction.kind)) ?? [];
    const card = buildTaskCard({ task, events, interactions });
    for (const sub of subs) {
      if (!sub.message_id) continue;
      try {
        await this.client.updateCard(sub.message_id, card);
        this.db.prepare('UPDATE watch_subscriptions SET last_card_at = ? WHERE id = ?').run(new Date().toISOString(), sub.id);
      } catch (error) {
        this.log(`[feishu] card update failed for ${sub.id}: ${error.message}`);
      }
    }
    // Keep the subscription after completion so a later message in the same
    // chat creates a follow-up task for the same project. Active execution is
    // determined by the task status, not by this conversation pointer.
  }

  // --- outbound actions --------------------------------------------------
  async #inject(taskId, content, by) {
    const task = this.tasks.get(taskId);
    if (!task || !['dispatched', 'running'].includes(task.status)) return false;
    const delivered = this.channel?.sendToWorker?.(task.claim_worker_id, {
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
        const ownerWorkerId = task.claim_worker_id;
        const cancelled = this.tasks.cancel(value.task_id, operator);
        if (ownerWorkerId) {
          this.channel?.sendToWorker?.(ownerWorkerId, {
            type: 'cancel', id: crypto.randomUUID(), ts: new Date().toISOString(),
            payload: { task_id: value.task_id, reason: `cancelled by ${operator}` },
          });
        }
        return { ok: true, status: cancelled.status };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    if (kind === 'pause') {
      const delivered = await this.#inject(value.task_id, '暂停：请停止当前步骤，总结已完成的进度和当前状态，等待进一步指示。', operator);
      return { ok: delivered };
    }
    if (kind === 'interaction_response') {
      const interaction = this.interactions?.get(value.interaction_id);
      if (!interaction || interaction.task_id !== value.task_id) {
        return { ok: false, error: 'interaction_not_found' };
      }
      if (!['question', 'approval'].includes(interaction.kind)) {
        return { ok: false, error: 'local_interaction_required' };
      }
      const result = this.#resolveInteraction(
        interaction,
        { [value.question_id]: value.option_id },
        operator,
        value.response_id || `feishu-card-${interaction.interaction_id}-${value.option_id}`,
      );
      if (result.ok) await this.#refreshCard(interaction.task_id);
      return result;
    }
    return { ok: false, error: `unknown action: ${kind}` };
  }

  async refreshCardForTask(taskId) {
    return this.#refreshCard(taskId);
  }

  async handleInteractionRequired(interaction) {
    if (!['question', 'approval'].includes(interaction.kind)) return { routed: false };
    await this.#refreshCard(interaction.task_id);
    return { routed: true, interaction_id: interaction.interaction_id };
  }
}

function approvalAnswers(interaction, approved) {
  const questions = Array.isArray(interaction?.schema?.questions) ? interaction.schema.questions : [];
  const question = questions.find((entry) => Array.isArray(entry.options) && entry.options.length >= 2);
  if (!question) throw new Error('approval interaction has no decision question');
  const preferredIds = approved ? ['approve', 'approved', 'allow', 'yes'] : ['deny', 'denied', 'reject', 'no'];
  const option = preferredIds.map((id) => question.options.find((entry) => entry.id === id)).find(Boolean)
    ?? question.options[approved ? 0 : 1];
  if (!option?.id) throw new Error('approval interaction has no decision option');
  return { [question.id]: option.id };
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
