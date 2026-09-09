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
  '/api/v1/tasks?limit=100': {
    tasks: [{ task_id: 't1', type: 'workflow.project_task', status: 'failed', priority: 5, project_id: 'mg_game', created_at: now }],
  },
  '/api/v1/tasks/t1': {
    task: {
      task_id: 't1', type: 'workflow.project_task', title: '跑一次工作流', status: 'failed', priority: 5,
      project_id: 'mg_game', created_by: 'workflow:agent', backend_kind: 'jsonl', attempts: 1, max_attempts: 3,
      created_at: now, started_at: now, finished_at: now,
      brief: { goal: '把项目跑起来', acceptance: ['构建通过'], context: '上下文' },
      result: { error: 'backend unavailable' },
    },
  },
  '/api/v1/tasks/t1/events?limit=200': {
    events: [{ event_id: 'e1', seq: 0, type: 'created', actor: 'workflow:agent', ts: now, payload: { project_id: 'mg_game' } }],
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
  '/api/v1/memory/history?path=projects%2Fa.md': { history: [{ commit: 'abcdef1234567', at: now, subject: 'init' }] },
  '/api/v1/workflow/memories?limit=200': {
    memories: [{
      id: 'm1', scope: 'project', projectId: 'wfc-demo', type: 'pitfall', title: '模板字符串里的反斜杠要两层转义',
      body: '外层模板字符串会先处理转义。\n结论：写成两层。', status: 'active', source: 'codex',
      tags: ['console'], keywords: ['escape'], revision: 2, createdAt: now, updatedAt: now,
    }],
  },
  '/api/v1/skills': { skills: [{ name: 'eng-review', version: 3, updatedAt: now }] },
  '/api/v1/skills/eng-review': { skill: { name: 'eng-review', version: 3, updatedAt: now, content: '# 评审\n\n按正确性/并发/安全分级。' } },
  '/api/v1/workers': {
    workers: [{
      worker_id: 'windows-TEST', machine: 'TEST-PC', projects: ['wfc-demo'], capabilities: ['workflow-jsonl'],
      backends: [{ kind: 'workflow-jsonl', command: 'node', args: ['omp-json-bridge.mjs'] }],
      connected: true, revoked: false, config_revision: 2, version: '1.0.0', last_seen: now,
      serverConfig: { backends: [{ kind: 'workflow-jsonl', command: 'node', args: ['omp-json-bridge.mjs'] }], revision: 2 },
    }],
  },
  '/api/v1/enrollments': { enrollments: [{ code: 'ABCD2345', status: 'pending', createdAt: now }] },
};

const VIEWS = {
  today: '今日', proposals: '提案', commitments: '责任', chat: '对话', memory: '记忆',
  knowledge: '知识库', tasks: '任务', nodes: '节点与同步', skills: '技能', replies: '回复记录',
  checkup: '体检', settings: '设置',
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

// A click target that answers closest() for the selectors the console asks about.
function clickOn(handlers, matches) {
  const target = { closest: (selector) => matches[selector] ?? null };
  for (const handler of handlers.click || []) handler({ target });
}

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

test('clicking a task opens its detail', async () => {
  const { root, handlers, unmocked } = bootConsole();
  await tick(); await tick(); await tick();

  clickOn(handlers, { '[data-nav]': { dataset: { nav: 'tasks' } } });
  await tick(); await tick();
  assert.ok(root.innerHTML.includes('data-task="t1"'), 'the task list must offer a clickable row');

  clickOn(handlers, { '[data-task]': { dataset: { task: 't1' } } });
  await tick(); await tick();
  const html = root.innerHTML;
  assert.ok(html.includes('任务说明'), 'the detail shows the brief');
  assert.ok(html.includes('构建通过'), 'the detail shows the acceptance criteria');
  assert.ok(html.includes('backend unavailable'), 'the detail shows why the task failed');
  assert.ok(html.includes('事件流'), 'the detail shows the event stream');
  assert.deepEqual(unmocked, []);
});

test('clicking a knowledge record opens its body', async () => {
  const { root, handlers, unmocked } = bootConsole();
  await tick(); await tick(); await tick();

  clickOn(handlers, { '[data-nav]': { dataset: { nav: 'knowledge' } } });
  await tick(); await tick();
  assert.ok(root.innerHTML.includes('data-knowledge="m1"'), 'the list must offer a clickable record');

  clickOn(handlers, { '[data-knowledge]': { dataset: { knowledge: 'm1' } } });
  await tick();
  const html = root.innerHTML;
  assert.ok(html.includes('模板字符串里的反斜杠要两层转义'), 'the detail shows the title');
  assert.ok(html.includes('结论：写成两层。'), 'the detail shows the body');
  assert.deepEqual(unmocked, []);
});

test('opening a skill loads its content into the editor', async () => {
  const { root, handlers, unmocked } = bootConsole();
  await tick(); await tick(); await tick();

  clickOn(handlers, { '[data-nav]': { dataset: { nav: 'skills' } } });
  await tick(); await tick();
  assert.ok(root.innerHTML.includes('data-skill="eng-review"'), 'the list must offer a clickable skill');

  clickOn(handlers, { '[data-skill]': { dataset: { skill: 'eng-review' } } });
  await tick(); await tick();
  const html = root.innerHTML;
  assert.ok(html.includes('id="skillContent"'), 'the editor is shown');
  assert.ok(html.includes('按正确性/并发/安全分级。'), 'the editor holds the skill content');
  assert.ok(html.includes('data-act="skill-delete"'), 'an existing skill can be deleted');
  assert.deepEqual(unmocked, []);
});

test('opening an executor shows its command line configuration', async () => {
  const { root, handlers, unmocked } = bootConsole();
  await tick(); await tick(); await tick();

  clickOn(handlers, { '[data-nav]': { dataset: { nav: 'settings' } } });
  await tick(); await tick();
  assert.ok(root.innerHTML.includes('data-worker="windows-TEST"'), 'the executor list must offer a row');
  assert.ok(root.innerHTML.includes('ABCD2345'), 'a pending enrollment code is listed');

  clickOn(handlers, { '[data-worker]': { dataset: { worker: 'windows-TEST' } } });
  await tick();
  const html = root.innerHTML;
  assert.ok(html.includes('data-backend-field="command"'), 'the backend command is editable');
  assert.ok(html.includes('value="node"'), 'the command field carries the configured value');
  assert.ok(html.includes('omp-json-bridge.mjs'), 'the args field carries the configured value');
  assert.ok(html.includes('data-act="worker-save"'), 'the configuration can be saved');
  assert.deepEqual(unmocked, []);
});
