// server-llm.js - Workflow-level LLM resident on Core.
// This is the server management model in the two-tier design: it handles
// server-wide concerns (knowledge distillation from finished sessions, and
// future server-side planning). Project-level intelligence stays with the
// per-worker execution engines. Credentials come only from the process
// environment (WFC_LLM_API_KEY); nothing is logged, and failed calls never
// block task completion.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const SUMMARIZE_PROMPT = `你是 Workflow 服务器层知识萃取模型。根据给定的任务与会话事件，判断有哪些可复用的项目知识点，输出 JSON 数组（每项含 title/content/type），type 限定为 pitfall|insight|decision|pattern|constraint。没有可复用知识点时输出 []。只输出 JSON，不要解释。`;

function compactText(value, limit = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export class ServerLlm {
  constructor({ enabled = false, baseUrl = null, apiKey = null, model = null, log = () => {}, fetchImpl = fetch, cli = null } = {}) {
    this.enabled = cli ? Boolean(enabled) : Boolean(enabled && apiKey);
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.log = log;
    this.cli = cli;
    this.fetchImpl = fetchImpl;
  }

  #cliChat(messages) {
    const transcript = (messages || []).map((m) => m.role + ': ' + String(m.content ?? '')).join(String.fromCharCode(10,10));
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli.command, [...this.cli.args, transcript], { stdio: ['ignore','pipe','pipe'], env: process.env, timeout: this.cli.timeoutMs ?? 180000 });
      let out = ''; let err = '';
      child.stdout?.setEncoding?.('utf8'); child.stdout?.on('data', (c) => { out += String(c); });
      child.stderr?.setEncoding?.('utf8'); child.stderr?.on('data', (c) => { err += String(c); });
      child.once('error', (error) => reject(error));
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error('server CLI exited ' + code + ': ' + String(err).slice(0, 300)));
        else resolve(String(out).trim());
      });
    });
  }

  async ask(messages, options = {}) {
    return this.#chat([...(messages ?? [])], options);
  }

  get status() {
    return { enabled: this.enabled };
  }
  update({ enabled = this.enabled, baseUrl = this.baseUrl, model = this.model, apiKey = this.apiKey } = {}) {
    this.enabled = Boolean(enabled && apiKey);
    this.baseUrl = (baseUrl || '').endsWith('/') ? String(baseUrl).slice(0, -1) : String(baseUrl ?? '');
    this.model = model;
    this.apiKey = apiKey;
    return this.status;
  }

  async #chat(messages, options = {}) {
    if (this.cli) return this.#cliChat(messages);
    const maxTokens = options.maxTokens ?? 900;
    if (!this.enabled) throw new Error('server LLM is not enabled');
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout?.(60_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`server LLM request failed: HTTP ${response.status} ${compactText(body, 160)}`);
    }
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    return String(text);
  }

  // Distills a finished session into knowledge entries and writes them into
  // the project knowledge repository. Idempotent per task; failures are logged
  // and never affect the task itself.
  async distillSession({ taskRepository, knowledgeRepository, taskId, projectId, taskType, events }) {
    if (!this.enabled) return { distilled: 0, reason: 'disabled' };
    try {
      const brief = String(events.find((e) => e.type === 'created')?.payload?.goal ?? taskType ?? '');
      const transcript = (events || [])
        .filter((e) => e.type === 'session_event')
        .map((e) => `${e.seq}: ${compactText(JSON.stringify(e.payload))}`)
        .join('\n')
        .slice(0, 60_000);
      const user = [
        `任务: ${taskType} (${taskId})`,
        `项目: ${projectId}`,
        `目标: ${compactText(brief, 200)}`,
        '',
        '会话事件:',
        transcript || '(无)',
      ].join('\n');
      const raw = await this.#chat([
        { role: 'system', content: SUMMARIZE_PROMPT },
        { role: 'user', content: user },
      ]);
      const entries = this.#parseEntries(raw);
      if (!entries.length) return { distilled: 0 };
      const created = [];
      for (const entry of entries) {
        if (!entry.title || !entry.content) continue;
        const memory = knowledgeRepository.createMemory({
          id: crypto.randomUUID(),
          projectId,
          type: entry.type,
          title: entry.title.slice(0, 200),
          body: String(entry.content ?? '').slice(0, 8_000),
          tags: ['llm-distilled'],
        });
        created.push(memory);
      }
      if (created.length) {
        taskRepository.appendEvent(taskId, 'knowledge_distilled', {
          count: created.length,
          titles: created.map((m) => m.title),
        }, 'server-llm');
        this.log(`[server-llm] distilled ${created.length} knowledge entries for ${taskId}`);
      }
      return { distilled: created.length };
    } catch (error) {
      this.log(`[server-llm] distillation failed for ${taskId}: ${error.message}`);
      return { distilled: 0, reason: error.message };
    }
  }

  #parseEntries(raw) {
    const text = String(raw ?? '').replace(/```(json|JSON)?/g, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end < 0 || end <= start) return [];
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
