// client.js - Feishu OpenAPI REST client plus interactive-card builders for
// task watching. Injectable fetch keeps everything testable.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class FeishuClient {
  constructor({ appId, appSecret, fetchImpl = fetch, apiBase = 'https://open.feishu.cn/open-apis' } = {}) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async #accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) return this.token;
    const response = await this.fetchImpl(`${this.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = await response.json();
    if (body.code !== 0) throw new Error(`feishu token error ${body.code}: ${body.msg}`);
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Number(body.expire || 7200) * 1000;
    return this.token;
  }

  async #post(path, payload) {
    const token = await this.#accessToken();
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (body.code !== 0) throw new Error(`feishu ${path} error ${body.code}: ${body.msg}`);
    return body.data ?? {};
  }

  async #patch(path, payload) {
    const token = await this.#accessToken();
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (body.code !== 0) throw new Error(`feishu ${path} error ${body.code}: ${body.msg}`);
    return body.data ?? {};
  }

  async sendText(chatId, text) {
    const data = await this.#post('/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    });
    return { message_id: data.message_id };
  }

  async sendCard(chatId, card) {
    const data = await this.#post('/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    return { message_id: data.message_id };
  }

  async updateCard(messageId, card) {
    return this.#patch(`/im/v1/messages/${messageId}`, { content: JSON.stringify(card), msg_type: 'interactive' });
  }
}

const STATUS_LABELS = {
  queued: '排队中', dispatched: '已派发', running: '执行中', done: '已完成',
  failed: '失败', blocked: '受阻', awaiting_input: '待输入', cancelled: '已取消',
};

function excerpt(text, length = 120) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length)}…` : compact;
}

export function latestView(events) {
  const view = { lastAssistant: null, currentTool: null, toolCount: 0, injected: 0 };
  for (const entry of events) {
    const event = entry?.payload?.event ?? entry?.payload ?? entry?.event ?? {};
    const type = String(event.type ?? '');
    if (type === 'assistant/message' && event.data?.text) view.lastAssistant = event.data.text;
    if (type === 'tool/call') {
      const tool = event.data?.tool ?? event.tool ?? 'tool';
      const args = event.data?.args ?? event.args ?? {};
      const family = tool === 'fs' ? 'shell' : tool;
      view.currentTool = family === 'shell' && args.cmd ? `${family}: ${args.cmd}` : family;
      view.toolCount += 1;
    }
    if (type === 'injected' || entry?.type === 'injected') view.injected += 1;
  }
  return view;
}

// Feishu interactive card: live task status, current tool, latest assistant
// excerpt, and control buttons whose values carry the routing payload.
export function buildTaskCard({ task, events = [], approval = null }) {
  const view = latestView(events);
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**目标**：${excerpt(task.brief?.goal ?? task.type, 160)}\n**状态**：${STATUS_LABELS[task.status] ?? task.status}　**优先级**：P${task.priority}　**尝试**：${task.attempts}/${task.max_attempts}` } },
  ];
  if (view.currentTool) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**当前工具**：\`${view.currentTool}\`（累计 ${view.toolCount} 次）` } });
  }
  if (view.lastAssistant) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**最新输出**：${excerpt(view.lastAssistant)}` } });
  }
  if (task.result?.summary) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**结论**：${excerpt(task.result.summary)}` } });
  }
  if (approval) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**⚠ 待审批**：\`${approval.tool}\` ${approval.risk ?? ''}\n${excerpt(approval.reason ?? '', 160)}` } });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '批准' }, type: 'primary', value: { kind: 'approve', approval_id: approval.approval_id, task_id: task.task_id } },
        { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger', value: { kind: 'deny', approval_id: approval.approval_id, task_id: task.task_id } },
      ],
    });
  } else if (['dispatched', 'running'].includes(task.status)) {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '暂停' }, type: 'default', value: { kind: 'pause', task_id: task.task_id } },
        { tag: 'button', text: { tag: 'plain_text', content: '取消任务' }, type: 'danger', value: { kind: 'cancel', task_id: task.task_id } },
      ],
    });
  }
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `任务 ${task.task_id.slice(0, 8)} · 直接回复本消息即可纠正执行方向` }] });
  return {
    config: { wide_screen_mode: true },
    header: { template: task.status === 'done' ? 'green' : task.status === 'failed' ? 'red' : 'blue', title: { tag: 'plain_text', content: `Workflow 任务 · ${STATUS_LABELS[task.status] ?? task.status}` } },
    elements,
  };
}
