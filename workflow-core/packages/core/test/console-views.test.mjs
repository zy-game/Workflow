// console-views.test.mjs - every console view renders against a representative
// API payload. The page is a single inline script, so the only way to catch a
// broken view before a browser does is to run it against stubbed endpoints.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { CONSOLE_HTML } from '../src/console/app.js';

const now = new Date().toISOString();

// One payload per endpoint the console calls, shaped like the real response.
const PAYLOADS = {
  '/api/v1/proposals?state=pending': {
    proposals: [{
      proposalId: 'p1', title: '提醒评审时间', ask: '要不要发', state: 'pending', tier: 'T1',
      vetoDeadline: new Date(Date.now() + 20000).toISOString(),
      evidence: [{ kind: 'probe', ref: 'probe-1' }], draftText: '草稿',
    }],
  },
  '/api/v1/commitments?state=active': {
    commitments: [{
      commitmentId: 'c1', statement: '确认下周三评审时间', state: 'active', dueAt: now,
      triggerPolicy: 'on_due', attentionPolicy: 'quiet', lastActivityAt: now, projectId: 'mg_game',
    }],
  },
  '/api/v1/digest/pending': { commitments: [] },
  '/api/v1/replies?limit=100': {
    replies: [{ tier: 'T1', autonomy: 'user', channelTarget: '群 A', text: '好的', createdAt: now, evidence: [] }],
  },
  '/api/v1/presence': {
    online: [{ touchpointId: 't1', kind: 'desktop', idleBucket: 'active', lastSeen: now }],
    active: { touchpointId: 't1', kind: 'desktop', idleBucket: 'active', lastSeen: now },
  },
  '/api/v1/tasks?limit=50': {
    tasks: [{ task_id: 't1', type: 'workflow.project_task', status: 'succeeded', priority: 5, project_id: 'mg_game', created_at: now }],
  },
  '/api/v1/admin/peers': {
    peers: [{ node_id: 'n1', display_name: 'node', status: 'active', protocol_version: 1, endpoint_url: 'x', last_seen_at: now }],
    cursors: [],
  },
  '/api/v1/admin/peer-sync': {
    sync: { node_id: 'n1', protocol_version: 1, signing: true, relay: null, relay_origins: [], head_seq: 12, inbox: { pending: 2 } },
    cursors: [],
  },
  '/api/v1/ai/metrics': {
    metrics: {
      assistant: {
        proposals: { approval_rate: 0.8, approved: 8, total: 10, rejection_rate: 0.2, rejected: 2 },
        resolution: { auto_rate: 0.5, high_confidence: 1, total: 2 },
        replies: { veto_rate: 0, vetoed: 0, total: 3, auto_sent: 1 },
        commitments: { dropped: 0 },
      },
    },
  },
  '/api/v1/ai/suggestions?status=pending': {
    suggestions: [{ suggestionId: 's1', title: '调阈值', targetType: 'policy', summary: '因为…' }],
  },
  '/api/v1/memory/tree': { tree: [{ dir: true, name: 'projects', children: [{ name: 'a.md', path: 'projects/a.md' }] }] },
  '/api/v1/memory/file?path=projects%2Fa.md': { content: '# hi' },
  '/api/v1/memory/history?path=projects%2Fa.md': { history: [{ commit: 'abcdef1234567', subject: 'init' }] },
};

const VIEWS = {
  today: '今日', proposals: '提案', commitments: '责任', chat: '对话', memory: '记忆',
  tasks: '任务', nodes: '节点', sync: '同步', replies: '回复记录', checkup: '体检',
};

// The console script is an IIFE over the DOM, so the test provides the minimum
// surface it touches: #root, the two storages, and fetch.
function bootConsole() {
  const handlers = {};
  const root = { innerHTML: '', addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); } };
  const storage = () => ({
    map: new Map(),
    getItem(key) { return this.map.get(key) ?? null; },
    setItem(key, value) { this.map.set(key, value); },
    removeItem(key) { this.map.delete(key); },
  });
  const local = storage();
  local.setItem('workflow.console.token', 'tk');
  const unmocked = [];
  const sandbox = {
    console, setTimeout, clearTimeout, clearInterval,
    setInterval: () => ({ unref() {} }),
    localStorage: local,
    sessionStorage: storage(),
    document: {
      getElementById: (id) => (id === 'root' ? root : null),
      addEventListener() {},
      visibilityState: 'visible',
      hasFocus: () => true,
    },
    window: { addEventListener() {} },
    fetch: (url) => {
      const body = PAYLOADS[url];
      if (!body) { unmocked.push(url); return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }); }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },
  };
  const script = CONSOLE_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, sandbox, { filename: 'console-inline.js' });
  return { root, handlers, unmocked };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('every console view renders against a representative payload', async () => {
  const { root, handlers, unmocked } = bootConsole();
  await tick(); await tick(); await tick();

  for (const [view, title] of Object.entries(VIEWS)) {
    for (const handler of handlers.click || []) {
      handler({ target: { closest: (selector) => (selector === '[data-nav]' ? { dataset: { nav: view } } : null) } });
    }
    await tick(); await tick();
    const html = root.innerHTML;
    assert.ok(html.includes('<h1>' + title + '</h1>'), `${view} does not render its page title`);
    assert.ok(html.includes('class="sidebar"'), `${view} is missing the sidebar`);
    assert.ok(!html.includes('undefined'), `${view} renders an undefined value`);
  }

  assert.deepEqual(unmocked, [], `the console called endpoints the test does not stub: ${unmocked.join(', ')}`);
});
