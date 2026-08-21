// driver.js - drives management sessions on the central DSH. Context, memory
// and compaction are DSH's job; this driver only submits situations and
// collects the model's structured reply.
import { DshLocalClient } from '../models/dsh-sync.js';

const POLL_MS = 800;
const REPLY_TIMEOUT_MS = 120_000;

// Real DSH wraps assistant message content in typed part arrays; the flat
// data.text form only exists in test fakes.
function replyText(event) {
  const data = event?.data;
  if (typeof data?.text === 'string') return data.text;
  const parts = Array.isArray(data?.message?.content) ? data.message.content : null;
  if (!parts) return '';
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

export class DshDriver {
  constructor({ client = null, baseUrl = 'http://127.0.0.1:3081', log = () => {} } = {}) {
    this.client = client ?? new DshLocalClient({ baseUrl });
    this.log = log;
    this.sessions = new Map(); // topic -> { sessionId, lastSeq }
  }

  async #sessionFor(topic) {
    const existing = this.sessions.get(topic);
    if (existing) return existing;
    const value = await this.client.call('session.create', { cwd: '/home/ubuntu/workflows/manager', title: `management:${topic}` });
    const session = { sessionId: value?.sessionId ?? value?.id ?? value, lastSeq: -1 };
    this.sessions.set(topic, session);
    this.log(`[ai] management session for "${topic}" opened (${session.sessionId})`);
    return session;
  }

  // Sends the prompt, waits for the turn to end, and returns the assistant
  // message text emitted during that turn.
  async ask(topic, prompt, { timeoutMs = REPLY_TIMEOUT_MS } = {}) {
    const session = await this.#sessionFor(topic);
    const history = await this.client.call('session.history', { sessionId: session.sessionId, maxMessages: 1 });
    const baselineSeq = history?.events?.at(-1)?.event?.seq ?? session.lastSeq;
    await this.client.call('session.prompt', {
      sessionId: session.sessionId, mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const page = await this.client.call('session.history', { sessionId: session.sessionId, maxMessages: 500 });
      const events = Array.isArray(page?.events) ? page.events : [];
      const fresh = events.filter((entry) => Number(entry?.event?.seq) > baselineSeq);
      const turnEnded = fresh.some((entry) => String(entry.event?.type) === 'turn/end');
      if (turnEnded) {
        session.lastSeq = Math.max(baselineSeq, ...fresh.map((entry) => Number(entry.event?.seq) || baselineSeq));
        const reply = fresh
          .filter((entry) => String(entry.event?.type) === 'assistant/message')
          .map((entry) => replyText(entry.event))
          .join('\n')
          .trim();
        return reply;
      }
    }
    throw new Error(`management session "${topic}" did not answer within ${timeoutMs}ms`);
  }
}

// Extracts the first JSON object embedded in a model reply.
export function parseDecisionJson(reply) {
  if (typeof reply !== 'string') return null;
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = (fenced ? fenced[1] : reply).trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}
