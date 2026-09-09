// console/app.js - the Workflow console, served by Core at /console.
//
// No build step and no external assets: the same design tokens and sidebar
// layout as docs/design/console-mockup.html, wired to the real API with plain
// DOM code. The page itself is public like /admin; every API call it makes
// requires the user's own session.
export const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workflow 控制台</title>
<style>
:root {
  --bg:#0b0d12; --surface:#14171e; --surface-2:#1b1f27; --surface-3:#222732;
  --border:#262b35; --border-strong:#333a47;
  --text:#e7e9ee; --text-2:#9aa1ad; --text-3:#6b7280;
  --accent:#6c8cff; --accent-soft:rgba(108,140,255,.12);
  --ok:#3fb950; --ok-soft:rgba(63,185,80,.12);
  --warn:#d29922; --warn-soft:rgba(210,153,34,.12);
  --danger:#f85149; --danger-soft:rgba(248,81,73,.12);
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px;
  --r-card:8px; --r-btn:6px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
* { box-sizing:border-box; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--text);
  font-family:var(--font); font-size:14px; line-height:1.6; -webkit-font-smoothing:antialiased; }
button { font-family:inherit; font-size:14px; cursor:pointer; }
input,textarea { font-family:inherit; }
.btn { padding:var(--s2) var(--s4); border-radius:var(--r-btn); border:1px solid var(--border-strong);
  background:var(--surface-2); color:var(--text); transition:background .15s ease; }
.btn:hover { background:var(--surface-3); }
.btn-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn-primary:hover { filter:brightness(1.08); }
.btn-danger { background:var(--danger-soft); border-color:var(--danger); color:var(--danger); }
.btn-ghost { background:transparent; border-color:transparent; color:var(--text-2); }
.btn-ghost:hover { background:var(--surface-2); color:var(--text); }
.btn-sm { padding:2px var(--s2); font-size:12px; }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--r-card); padding:var(--s4); }
.card + .card { margin-top:var(--s3); }
.badge { display:inline-flex; align-items:center; font-size:11px; font-weight:600;
  padding:2px var(--s2); border-radius:4px; }
.badge-ok { background:var(--ok-soft); color:var(--ok); }
.badge-warn { background:var(--warn-soft); color:var(--warn); }
.badge-danger { background:var(--danger-soft); color:var(--danger); }
.badge-muted { background:var(--surface-3); color:var(--text-2); }
.mono { font-family:var(--mono); font-size:12px; }
.muted { color:var(--text-3); }
.spacer { flex:1; }
.center { min-height:100vh; display:grid; place-items:center; padding:var(--s5); }
.field { display:block; margin-bottom:var(--s3); }
.field span { display:block; font-size:12px; color:var(--text-3); margin-bottom:var(--s1); }
.field input, .field textarea { width:100%; padding:var(--s2) var(--s3); border-radius:var(--r-btn);
  border:1px solid var(--border-strong); background:var(--surface-2); color:var(--text); font-size:14px; }
.field textarea { min-height:76px; resize:vertical; }
.error { color:var(--danger); font-size:13px; margin-top:var(--s2); }
.section-title { font-size:12px; font-weight:600; letter-spacing:.4px; color:var(--text-3);
  text-transform:uppercase; margin:0 0 var(--s3); }
.section-title + .section-title { margin-top:var(--s5); }

/* 布局：左侧边栏 + 主区 */
.app { display:flex; height:100vh; overflow:hidden; }
.sidebar { width:232px; flex-shrink:0; background:var(--surface); border-right:1px solid var(--border);
  display:flex; flex-direction:column; overflow-y:auto; }
.brand { display:flex; align-items:center; gap:var(--s3); padding:var(--s5) var(--s4) var(--s4); }
.brand-mark { width:26px; height:26px; border-radius:7px; background:linear-gradient(140deg,var(--accent),#9a6cff);
  display:grid; place-items:center; color:#fff; flex-shrink:0; }
.brand-name { font-size:15px; font-weight:600; letter-spacing:.2px; }
.brand-sub { font-size:12px; color:var(--text-3); line-height:1.2; }
.nav-group { padding:var(--s3) var(--s2); }
.nav-label { font-size:12px; color:var(--text-3); padding:0 var(--s3) var(--s2); letter-spacing:.4px; }
.nav-item { display:flex; align-items:center; gap:var(--s3); padding:var(--s2) var(--s3);
  border-radius:var(--r-btn); color:var(--text-2); cursor:pointer; border:none; background:none;
  width:100%; text-align:left; font-family:inherit; font-size:14px;
  transition:background .15s ease, color .15s ease; }
.nav-item:hover { background:var(--surface-2); color:var(--text); }
.nav-item[aria-current="page"] { background:var(--accent-soft); color:var(--text); font-weight:500; }
.nav-item[aria-current="page"] svg { color:var(--accent); }
.nav-item svg { color:var(--text-3); flex-shrink:0; }
.nav-badge { margin-left:auto; background:var(--danger); color:#fff; font-size:11px; font-weight:600;
  min-width:18px; height:18px; padding:0 5px; border-radius:9px; display:grid; place-items:center; }
.sidebar-foot { margin-top:auto; padding:var(--s4); border-top:1px solid var(--border); }
.presence { display:flex; align-items:center; gap:var(--s2); font-size:12px; color:var(--text-2); }
.dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex-shrink:0; }
.dot.off { background:var(--text-3); }
.main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
.topbar { height:56px; flex-shrink:0; border-bottom:1px solid var(--border); background:var(--surface);
  display:flex; align-items:center; gap:var(--s3); padding:0 var(--s5); }
.topbar h1 { font-size:16px; font-weight:600; margin:0; }
.content { flex:1; overflow-y:auto; padding:var(--s5); }
.inner { max-width:980px; }

/* 提案 */
.proposal { border-left:3px solid var(--accent); }
.proposal.rejected { border-left-color:var(--danger); opacity:.72; }
.proposal.approved { border-left-color:var(--ok); }
.head { display:flex; align-items:center; gap:var(--s3); }
.head strong { flex:1; }
.ask { background:var(--surface-2); border-radius:var(--r-btn); padding:var(--s3); margin:var(--s3) 0; }
.ask .label { font-size:12px; color:var(--text-3); margin-bottom:2px; }
.evidence { border-top:1px solid var(--border); padding-top:var(--s3); }
.evidence-row { display:flex; gap:var(--s3); padding:var(--s1) 0; align-items:center; }
.evidence-row .kind { font-size:11px; color:var(--text-3); width:56px; flex-shrink:0; }
.evidence-row .ref { font-family:var(--mono); font-size:12px; color:var(--accent); }
.veto { margin-top:var(--s3); padding-top:var(--s3); border-top:1px solid var(--border); }
.veto-head { display:flex; justify-content:space-between; font-size:12px; color:var(--text-2); margin-bottom:var(--s2); }
.veto-track { height:4px; border-radius:2px; background:var(--surface-3); overflow:hidden; }
.veto-fill { height:100%; background:var(--warn); border-radius:2px; }
.draft { margin-top:var(--s3); padding:var(--s3); background:var(--surface-2);
  border-radius:var(--r-btn); font-size:13px; white-space:pre-wrap; }
.actions { display:flex; gap:var(--s2); margin-top:var(--s4); align-items:center; }

/* 指标与列表 */
.metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); gap:var(--s3); }
.metric { background:var(--surface); border:1px solid var(--border); border-radius:var(--r-card); padding:var(--s4); }
.metric .k { font-size:12px; color:var(--text-3); }
.metric .v { font-size:24px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums; }
.metric .d { font-size:12px; margin-top:2px; }
.list-row { display:flex; align-items:center; gap:var(--s3); padding:var(--s3) 0; border-bottom:1px solid var(--border); }
.list-row:last-child { border-bottom:none; }
.list-row .grow { flex:1; min-width:0; }
.list-row .grow .sub { font-size:12px; color:var(--text-3); }
.clickable { cursor:pointer; margin:0 calc(var(--s3) * -1); padding-left:var(--s3); padding-right:var(--s3);
  border-radius:var(--r-btn); transition:background .15s ease; }
.clickable:hover { background:var(--surface-2); }
.kv { display:grid; grid-template-columns:104px 1fr; gap:var(--s1) var(--s3); font-size:13px; }
.kv .k { color:var(--text-3); }
.kv > div { min-width:0; overflow-wrap:anywhere; }
.filters { display:flex; gap:var(--s2); margin-bottom:var(--s3); flex-wrap:wrap; }
.filter { padding:2px var(--s3); border-radius:14px; border:1px solid var(--border-strong);
  background:transparent; color:var(--text-2); font-size:12px; }
.filter:hover { background:var(--surface-2); color:var(--text); }
.filter[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent); color:var(--text); }
.detail-head { display:flex; align-items:center; gap:var(--s3); margin-bottom:var(--s4); }
.detail-head h2 { font-size:15px; margin:0; }
.block { margin-top:var(--s4); }
.block .label { font-size:12px; color:var(--text-3); margin-bottom:var(--s2); }
.brief { background:var(--surface-2); border-radius:var(--r-btn); padding:var(--s3); font-size:13px;
  white-space:pre-wrap; overflow-wrap:anywhere; }
.brief ul { margin:var(--s2) 0 0; padding-left:var(--s4); }
.event { display:flex; gap:var(--s3); padding:var(--s2) 0; border-bottom:1px solid var(--border); font-size:13px; align-items:baseline; }
.event:last-child { border-bottom:none; }
.event .seq { color:var(--text-3); font-family:var(--mono); font-size:11px; width:28px; flex-shrink:0; text-align:right; }
.event .type { flex-shrink:0; }
.event .payload { color:var(--text-3); font-family:var(--mono); font-size:11px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1; }
.tree-item { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* 知识库 / 技能 */
.toolbar { display:flex; gap:var(--s2); margin-bottom:var(--s3); flex-wrap:wrap; align-items:center; }
.toolbar input, .toolbar select { padding:var(--s2) var(--s3); border-radius:var(--r-btn);
  border:1px solid var(--border-strong); background:var(--surface-2); color:var(--text); font-size:13px; }
.toolbar input { flex:1; min-width:180px; }
.editor { width:100%; min-height:320px; font-family:var(--mono); font-size:12px; line-height:1.6;
  padding:var(--s3); border-radius:var(--r-btn); border:1px solid var(--border-strong);
  background:var(--surface-2); color:var(--text); resize:vertical; }
.knowledge-body { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; color:var(--text-2); }
.chips { display:flex; gap:var(--s2); flex-wrap:wrap; margin-top:var(--s3); }

/* 记忆 */
.tree-item { padding:2px var(--s2); border-radius:5px; color:var(--text-2); cursor:pointer; font-size:13px; }
.tree-item:hover { background:var(--surface-2); color:var(--text); }
.tree-item.active { background:var(--accent-soft); color:var(--text); }
.memory-grid { display:grid; grid-template-columns:240px 1fr; gap:var(--s3); align-items:start; }
.file-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s3);
  padding-bottom:var(--s3); border-bottom:1px solid var(--border); margin-bottom:var(--s3); }
.file-head .mono { min-width:0; overflow-wrap:anywhere; }
.file-body { margin:0; white-space:pre-wrap; word-break:break-word; font-family:var(--mono); font-size:12px; color:var(--text-2); }
.history-row { display:flex; align-items:center; gap:var(--s3); padding:var(--s2) 0; border-bottom:1px solid var(--border); }
.history-row:last-child { border-bottom:none; }
.history-row .muted { flex:1; }

/* 对话 */
.thread { display:flex; flex-direction:column; gap:var(--s3); }
.bubble { padding:var(--s3); border-radius:var(--r-card); font-size:13px; white-space:pre-wrap; }
.bubble.me { background:var(--accent-soft); align-self:flex-end; max-width:80%; }
.bubble.it { background:var(--surface); border:1px solid var(--border); }
.bubble .meta { font-size:11px; color:var(--text-3); margin-top:var(--s2); }

@media (max-width:720px) {
  .app { flex-direction:column; height:auto; min-height:100vh; }
  .sidebar { width:100%; flex-direction:row; align-items:center; overflow-x:auto; border-right:none; border-bottom:1px solid var(--border); }
  .brand, .nav-label, .sidebar-foot { display:none; }
  .nav-group { display:flex; padding:var(--s2); }
  .nav-item { white-space:nowrap; }
  .content { padding:var(--s4); }
  .memory-grid { grid-template-columns:1fr; }
  .actions { flex-wrap:wrap; }
}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var TOKEN_KEY = 'workflow.console.token';
  var TOUCHPOINT_KEY = 'workflow.console.touchpoint';
  var root = document.getElementById('root');

  var ICON = {
    logo: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7.5 4.5v9L12 21l-7.5-4.5v-9L12 3z"/><path d="M12 12l7.5-4.5M12 12v9M12 12L4.5 7.5"/></svg>',
    today: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    proposal: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 5h16v11H8l-4 3V5z"/></svg>',
    commitment: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 5h9a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3z"/><path d="M9 3v4M9 12l2 2 3-3"/></svg>',
    chat: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z"/></svg>',
    memory: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"/></svg>',
    task: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
    node: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3"/></svg>',
    reply: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 015 5v6"/></svg>',
    book: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 5a2 2 0 012-2h12v16H6a2 2 0 00-2 2V5z"/><path d="M4 19a2 2 0 012-2h12"/></svg>',
    skill: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 4h6a1 1 0 011 1v2H8V5a1 1 0 011-1z"/><path d="M8 6H5v14h14V6h-3"/><path d="M9 12l2 2 4-4"/></svg>',
    checkup: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 12h4l2-6 3 12 2-6h7"/></svg>'
  };

  var state = {
    view: 'today',
    loading: false, error: '', busy: '',
    loginError: '', busyLogin: false,
    setup: { needed: false, error: '', busy: false },
    proposals: [], commitments: [], tasks: [], replies: [], digest: [],
    tasksFilter: 'all', taskDetail: null, taskBusy: '',
    peers: [], sync: null, cursors: [],
    presence: null,
    memory: { tree: [], path: null, content: '', history: [], error: '' },
    knowledge: { items: [], query: '', projectId: '', type: '', detail: null, error: '' },
    skills: { items: [], detail: null, draft: null, draftName: '', error: '', busy: '' },
    checkup: { metrics: null, suggestions: [], error: '', busy: '' },
    chat: { items: [], error: '', busy: false },
    notifiedCount: 0,
  };
  var timer = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(value) {
    try { if (value) localStorage.setItem(TOKEN_KEY, value); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    state.proposals = []; state.error = ''; state.view = 'today';
    render();
    if (value) load();
  }
  function when(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    var diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) return diff <= 0 ? '刚刚' : diff + ' 秒前';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return Math.floor(diff / 86400) + ' 天前';
  }

  // Presence: this tab reports its own facts; the server decides who is most
  // likely in front of the user.
  function touchpointId() {
    try {
      var id = sessionStorage.getItem(TOUCHPOINT_KEY);
      if (!id) { id = 'tp-' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem(TOUCHPOINT_KEY, id); }
      return id;
    } catch (e) { return 'tp-unknown'; }
  }
  // The browser can only see its own tab; the desktop shell can ask the OS.
  function localIdleBucket() {
    if (document.visibilityState !== 'visible') return 'idle';
    return document.hasFocus() ? 'active' : 'recent';
  }
  function reportPresence() {
    if (!token()) return;
    var desktop = window.workflowDesktop;
    var bucket = desktop && desktop.idleBucket
      ? Promise.resolve(desktop.idleBucket()).catch(function () { return localIdleBucket(); })
      : Promise.resolve(localIdleBucket());
    bucket.then(function (value) {
      return api('/api/v1/presence', {
        method: 'POST',
        body: { touchpoint_id: touchpointId(), kind: desktop ? 'desktop' : 'browser', idle_bucket: value },
      });
    }).then(loadPresence).catch(function () { /* presence is best effort */ });
  }
  function loadPresence() {
    return api('/api/v1/presence').then(function (result) {
      state.presence = result; render();
    }).catch(function () { /* the footer just stays unknown */ });
  }

  // A native notification is the one thing a closed tab cannot do.
  function notifyIfMorePending(proposals) {
    var desktop = window.workflowDesktop;
    var pending = (proposals || []).filter(function (proposal) { return proposal.state === 'pending'; });
    if (!pending.length) { state.notifiedCount = 0; return; }
    if (!desktop || !desktop.notify) return;
    if (pending.length <= (state.notifiedCount || 0)) return;
    state.notifiedCount = pending.length;
    desktop.notify({ title: 'Workflow：' + pending.length + ' 条待决策', body: pending[0].title });
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { 'content-type': 'application/json' };
    var tk = token();
    if (tk) headers.authorization = 'Bearer ' + tk;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          if (response.status === 401 && tk) setToken('');
          throw new Error(body.error || body.code || ('HTTP ' + response.status));
        }
        return body;
      });
    });
  }

  // --- 加载器 ---
  function load() {
    if (!token()) return Promise.resolve();
    state.loading = true; state.error = ''; render();
    return api('/api/v1/proposals?state=pending')
      .then(function (result) {
        state.proposals = result.proposals || [];
        notifyIfMorePending(state.proposals);
      })
      .catch(function (err) { state.error = err.message || String(err); })
      .then(function () { state.loading = false; render(); });
  }
  function loadCommitments() {
    return api('/api/v1/commitments?state=active').then(function (result) {
      state.commitments = result.commitments || []; render();
    }).catch(function (err) { state.error = err.message || String(err); render(); });
  }
  function loadTasks() {
    return api('/api/v1/tasks?limit=100').then(function (result) {
      state.tasks = result.tasks || []; render();
    }).catch(function (err) { state.error = err.message || String(err); render(); });
  }
  function openTask(taskId) {
    state.taskBusy = taskId; state.taskDetail = null; render();
    Promise.all([
      api('/api/v1/tasks/' + encodeURIComponent(taskId)),
      api('/api/v1/tasks/' + encodeURIComponent(taskId) + '/events?limit=200'),
    ]).then(function (results) {
      state.taskDetail = { task: results[0].task, events: results[1].events || [] };
      state.taskBusy = ''; render();
    }).catch(function (err) { state.taskBusy = ''; state.error = err.message || String(err); render(); });
  }
  // 节点与同步同页：本节点的同步身份、peer 列表、游标和收件箱回答的是同一个
  // 问题——有没有别的机器在和我交换事件。单节点部署时这一页本来就只有本节点。
  function loadNodes() {
    return Promise.all([api('/api/v1/admin/peers'), api('/api/v1/admin/peer-sync')])
      .then(function (results) {
        state.peers = results[0].peers || [];
        state.cursors = results[0].cursors || results[1].cursors || [];
        state.sync = results[1].sync || null;
        render();
      })
      .catch(function (err) { state.error = err.message || String(err); render(); });
  }
  function loadReplies() {
    return api('/api/v1/replies?limit=100').then(function (result) {
      state.replies = result.replies || []; render();
    }).catch(function (err) { state.error = err.message || String(err); render(); });
  }
  function loadDigest() {
    return api('/api/v1/digest/pending').then(function (result) {
      state.digest = result.commitments || []; render();
    }).catch(function () { /* the digest is optional on the overview */ });
  }
  function loadToday() {
    state.error = ''; render();
    return Promise.all([load(), loadCommitments(), loadDigest(), loadReplies(), loadPresence()]);
  }

  // --- 知识库：跨项目沉淀的坑、洞察、决策、模式、约束 ---
  function loadKnowledge() {
    var knowledge = state.knowledge;
    knowledge.error = '';
    var params = ['limit=200'];
    if (knowledge.projectId) params.push('project_id=' + encodeURIComponent(knowledge.projectId));
    if (knowledge.type) params.push('type=' + encodeURIComponent(knowledge.type));
    if (knowledge.query) params.push('query=' + encodeURIComponent(knowledge.query));
    return api('/api/v1/workflow/memories?' + params.join('&'))
      .then(function (result) { knowledge.items = result.memories || []; render(); })
      .catch(function (err) { knowledge.error = err.message || String(err); render(); });
  }

  // --- 技能：服务器侧是唯一真源，保存即推送给在线执行器 ---
  function loadSkills() {
    state.skills.error = '';
    return api('/api/v1/skills')
      .then(function (result) { state.skills.items = result.skills || []; render(); })
      .catch(function (err) { state.skills.error = err.message || String(err); render(); });
  }
  function openSkill(name) {
    state.skills.error = '';
    return api('/api/v1/skills/' + encodeURIComponent(name))
      .then(function (result) {
        state.skills.detail = result.skill;
        state.skills.draft = result.skill.content;
        state.skills.draftName = result.skill.name;
        render();
      })
      .catch(function (err) { state.skills.error = err.message || String(err); render(); });
  }
  function saveSkill() {
    var name = String(state.skills.draftName || '').trim();
    if (!name) { state.skills.error = '技能名不能为空'; render(); return; }
    state.skills.busy = 'save'; render();
    api('/api/v1/skills/' + encodeURIComponent(name), { method: 'PUT', body: { content: state.skills.draft || '' } })
      .then(function () { state.skills.busy = ''; return loadSkills().then(function () { return openSkill(name); }); })
      .catch(function (err) { state.skills.busy = ''; state.skills.error = err.message || String(err); render(); });
  }
  function deleteSkill(name) {
    state.skills.busy = 'delete'; render();
    api('/api/v1/skills/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function () {
        state.skills.busy = ''; state.skills.detail = null; state.skills.draft = null; state.skills.draftName = '';
        return loadSkills();
      })
      .catch(function (err) { state.skills.busy = ''; state.skills.error = err.message || String(err); render(); });
  }

  // --- 骨架 ---
  function navItem(view, label, icon, badge) {
    var active = state.view === view ? ' aria-current="page"' : '';
    return '<button class="nav-item"' + active + ' data-nav="' + view + '">' + icon +
      '<span>' + label + '</span>' +
      (badge ? '<span class="nav-badge">' + badge + '</span>' : '') + '</button>';
  }
  function presenceHtml() {
    var presence = state.presence;
    var live = presence && presence.online ? presence.online : [];
    var active = presence && presence.active ? presence.active : null;
    if (!live.length) return '<div class="presence"><span class="dot off"></span><span>不在场</span></div>';
    var label = active
      ? '在场 · ' + (active.kind === 'desktop' ? '桌面端' : '浏览器') + '（' + when(active.lastSeen) + '）'
      : '已连接 · ' + live.length + ' 个触点';
    return '<div class="presence"><span class="dot"></span><span>' + esc(label) + '</span></div>';
  }
  function sidebar() {
    var pending = state.proposals.filter(function (proposal) { return proposal.state === 'pending'; }).length;
    return '<aside class="sidebar">' +
      '<div class="brand"><div class="brand-mark">' + ICON.logo + '</div><div>' +
        '<div class="brand-name">Workflow</div><div class="brand-sub">第二个我</div></div></div>' +
      '<div class="nav-group"><div class="nav-label">助理</div>' +
        navItem('today', '今日', ICON.today) +
        navItem('proposals', '提案', ICON.proposal, pending || '') +
        navItem('commitments', '责任', ICON.commitment) +
        navItem('chat', '对话', ICON.chat) +
        navItem('memory', '记忆', ICON.memory) +
        navItem('knowledge', '知识库', ICON.book) +
      '</div>' +
      '<div class="nav-group"><div class="nav-label">运维</div>' +
        navItem('tasks', '任务', ICON.task) +
        navItem('nodes', '节点', ICON.node) +
        navItem('skills', '技能', ICON.skill) +
        navItem('replies', '回复记录', ICON.reply) +
        navItem('checkup', '体检', ICON.checkup) +
      '</div>' +
      '<div class="sidebar-foot">' + presenceHtml() + '</div></aside>';
  }
  function topbarActions() {
    var buttons = '';
    if (state.view === 'checkup') {
      buttons += '<button class="btn btn-ghost btn-sm" data-act="checkup-run"' +
        (state.checkup.busy === 'checkup' ? ' disabled' : '') + '>立即体检</button>';
    }
    buttons += '<button class="btn btn-ghost btn-sm" data-act="refresh">刷新</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="logout">退出</button>';
    return buttons;
  }
  function page(title, body) {
    return '<div class="app">' + sidebar() +
      '<div class="main"><header class="topbar"><h1>' + esc(title) + '</h1>' +
      '<div class="spacer"></div>' + topbarActions() + '</header>' +
      '<main class="content"><div class="inner">' +
      (state.error ? '<div class="card error">' + esc(state.error) + '</div>' : '') +
      body + '</div></main></div></div>';
  }
  function empty(text) { return '<div class="card muted">' + esc(text) + '</div>'; }
  function metricCard(label, value, hint) {
    return '<div class="metric"><div class="k">' + esc(label) + '</div><div class="v">' +
      esc(value == null ? '—' : value) + '</div>' + (hint ? '<div class="d muted">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function loginView() {
    return '<div class="center"><form class="card" id="login" style="width:100%;max-width:360px">' +
      '<h1 style="font-size:16px;margin:0 0 4px">Workflow</h1>' +
      '<p class="muted" style="margin:0 0 20px;font-size:13px">第二个我</p>' +
      '<label class="field"><span>邮箱</span><input id="email" type="email" autocomplete="username"></label>' +
      '<label class="field"><span>密码</span><input id="password" type="password" autocomplete="current-password"></label>' +
      '<button class="btn btn-primary" type="submit" style="width:100%"' + (state.busyLogin ? ' disabled' : '') + '>' +
        (state.busyLogin ? '登录中…' : '登录') + '</button>' +
      (state.loginError ? '<div class="error">' + esc(state.loginError) + '</div>' : '') +
      '</form></div>';
  }

  // First-run setup: a fresh install has no credentials at all, so the console
  // offers to create the first admin. It disappears the moment an account
  // exists.
  function setupView() {
    var setup = state.setup;
    return '<div class="center"><form class="card" id="setup" style="width:100%;max-width:400px">' +
      '<h1 style="font-size:16px;margin:0 0 4px">初始化 Workflow</h1>' +
      '<p class="muted" style="margin:0 0 20px;font-size:13px">还没有账号。创建第一个管理员账号。</p>' +
      '<label class="field"><span>邮箱</span><input id="setupEmail" type="email" autocomplete="username"></label>' +
      '<label class="field"><span>密码</span><input id="setupPassword" type="password" autocomplete="new-password"></label>' +
      '<button class="btn btn-primary" type="submit" style="width:100%"' + (setup.busy ? ' disabled' : '') + '>' +
        (setup.busy ? '创建中…' : '创建账号') + '</button>' +
      (setup.error ? '<div class="error">' + esc(setup.error) + '</div>' : '') +
      '</form></div>';
  }
  function loadSetup() {
    api('/api/v1/auth/bootstrap')
      .then(function (result) { state.setup.needed = Boolean(result.needed); render(); })
      .catch(function () { /* a failed probe just leaves the login form */ });
  }

  // --- 今日 ---
  function todayView() {
    var pending = state.proposals.filter(function (proposal) { return proposal.state === 'pending'; });
    var soon = state.commitments.filter(function (item) { return item.dueAt; }).slice(0, 5);
    var cards = metricCard('待决策', pending.length, pending.length ? '需要你拍板' : '没有等你的事') +
      metricCard('活跃责任', state.commitments.length, '我记着的事') +
      metricCard('待提醒', state.digest.length, '到了提醒时间') +
      metricCard('在场触点', state.presence && state.presence.online ? state.presence.online.length : 0,
        state.presence && state.presence.active ? '主设备 ' + (state.presence.active.kind === 'desktop' ? '桌面端' : '浏览器') : '');
    var proposals = pending.slice(0, 3).map(function (proposal) {
      return '<div class="list-row clickable" data-goto="proposals"><span class="badge badge-warn">待决策</span>' +
        '<div class="grow">' + esc(proposal.title) + '<div class="sub">' + esc(proposal.ask) + '</div></div>' +
        '<span class="muted">查看</span></div>';
    }).join('');
    var commitments = soon.length ? soon.map(function (item) {
      return '<div class="list-row clickable" data-goto="commitments"><div class="grow">' + esc(item.statement) +
        '<div class="sub">' + esc(item.projectId || '未归属项目') + ' · 截止 ' + esc(when(item.dueAt)) + '</div></div></div>';
    }).join('') : '<div class="list-row muted">没有带截止时间的责任。</div>';
    var replies = state.replies.slice(0, 3).map(function (reply) {
      return '<div class="list-row clickable" data-goto="replies"><span class="badge badge-muted">' + esc(reply.tier) + '</span>' +
        '<div class="grow">' + esc(reply.channelTarget) + '<div class="sub">' + esc(reply.text) + '</div></div>' +
        '<span class="muted mono">' + esc(when(reply.createdAt)) + '</span></div>';
    }).join('') || '<div class="list-row muted">还没有回复。</div>';
    return page('今日',
      '<h2 class="section-title">概览</h2><div class="metrics">' + cards + '</div>' +
      '<h2 class="section-title">需要你决定 · ' + pending.length + '</h2>' +
      (proposals || empty('没有待决策的提案。')) +
      '<h2 class="section-title">临近的责任</h2><div class="card">' + commitments + '</div>' +
      '<h2 class="section-title">最近回复</h2><div class="card">' + replies + '</div>');
  }

  // --- 提案 ---
  function secondsLeft(deadline) {
    if (!deadline) return null;
    return Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
  }
  function proposalView(proposal) {
    var pending = proposal.state === 'pending';
    var left = pending ? secondsLeft(proposal.vetoDeadline) : null;
    var badge = pending ? 'badge-warn' : proposal.state === 'approved' ? 'badge-ok' : 'badge-danger';
    var label = pending ? '待决策' : proposal.state === 'approved' ? '已批准' : '已否决';
    var busy = state.busy === proposal.proposalId;
    var evidence = (proposal.evidence || []).map(function (item) {
      return '<div class="evidence-row"><span class="kind">' + esc(item.kind || '—') + '</span>' +
        '<span class="ref">' + esc(item.ref || '') + '</span></div>';
    }).join('');
    var actions = '';
    if (pending) {
      actions += '<button class="btn btn-primary" data-act="approve" data-id="' + esc(proposal.proposalId) + '"' + (busy ? ' disabled' : '') + '>批准</button>';
      actions += '<button class="btn btn-danger" data-act="reject" data-id="' + esc(proposal.proposalId) + '"' + (busy ? ' disabled' : '') + '>否决</button>';
    } else if (proposal.state === 'approved' && proposal.draftText && !proposal.sent) {
      actions += '<button class="btn" data-act="send" data-id="' + esc(proposal.proposalId) + '"' + (busy ? ' disabled' : '') + '>立即发送</button>';
    }
    return '<div class="card proposal ' + esc(proposal.state) + '">' +
      '<div class="head"><strong>' + esc(proposal.title) + '</strong>' +
        '<span class="badge ' + badge + '">' + label + '</span>' +
        '<span class="badge badge-muted">' + esc(proposal.tier || 'T2') + '</span></div>' +
      '<div class="ask"><div class="label">要我决定什么</div><div>' + esc(proposal.ask) + '</div></div>' +
      (evidence ? '<div class="evidence">' + evidence + '</div>' : '') +
      (proposal.draftText ? '<div class="draft">' + esc(proposal.draftText) + '</div>' : '') +
      (left !== null ? '<div class="veto"><div class="veto-head"><span>否决窗口</span>' +
        '<span class="mono">' + left + 's</span></div><div class="veto-track">' +
        '<div class="veto-fill" style="width:' + Math.min(100, Math.max(0, left / 30 * 100)) + '%"></div></div></div>' : '') +
      '<div class="actions">' + actions + '<div class="spacer"></div>' +
        '<span class="muted mono">' + esc(proposal.proposalId) + '</span></div></div>';
  }
  function proposalsView() {
    var body = state.loading ? '<div class="card muted">加载中…</div>'
      : state.proposals.length ? state.proposals.map(proposalView).join('')
      : empty('没有待决策的提案。');
    return page('提案', '<h2 class="section-title">待决策 · ' + state.proposals.length + '</h2>' + body);
  }

  // --- 责任 ---
  function commitmentsView() {
    var body = !state.commitments.length ? empty('没有活跃的责任。')
      : state.commitments.map(function (item) {
        return '<div class="card"><div class="head"><strong style="flex:1">' + esc(item.statement) + '</strong>' +
          '<span class="badge badge-ok">' + esc(item.state) + '</span></div>' +
          '<div class="kv" style="margin-top:12px">' +
            '<div class="k">项目</div><div>' + esc(item.projectId || '—') + '</div>' +
            '<div class="k">截止</div><div>' + esc(item.dueAt ? when(item.dueAt) : '—') + '</div>' +
            '<div class="k">触发策略</div><div class="mono">' + esc(item.triggerPolicy || '—') + '</div>' +
            '<div class="k">关注策略</div><div class="mono">' + esc(item.attentionPolicy || '—') + '</div>' +
            '<div class="k">最近活动</div><div>' + esc(when(item.lastActivityAt)) + '</div>' +
          '</div></div>';
      }).join('');
    return page('责任', '<h2 class="section-title">活跃责任 · ' + state.commitments.length + '</h2>' + body);
  }

  // --- 对话 ---
  function chatView() {
    var thread = state.chat.items.length
      ? state.chat.items.map(function (item) {
        return '<div class="bubble ' + (item.role === 'me' ? 'me' : 'it') + '">' + esc(item.text) +
          (item.meta ? '<div class="meta">' + esc(item.meta) + '</div>' : '') + '</div>';
      }).join('')
      : '<div class="card muted">说点什么。你说的话会变成一条信号，由 Workflow 判断该不该动手。</div>';
    return page('对话',
      '<h2 class="section-title">和 Workflow 说话</h2>' +
      '<div class="thread" id="thread">' + thread + '</div>' +
      '<form class="card" id="chat" style="margin-top:16px">' +
        '<label class="field"><span>内容</span><textarea id="chatText" placeholder="例如：下周三评审前提醒我确认时间"></textarea></label>' +
        '<div class="actions" style="margin-top:0">' +
        '<button class="btn btn-primary" type="submit"' + (state.chat.busy ? ' disabled' : '') + '>' +
          (state.chat.busy ? '发送中…' : '发送') + '</button>' +
        '<span class="muted" style="font-size:12px">发出去之后，是否回复由提案和策略决定。</span></div>' +
        (state.chat.error ? '<div class="error">' + esc(state.chat.error) + '</div>' : '') +
      '</form>');
  }
  function sendChat(text) {
    state.chat.busy = true; state.chat.error = ''; render();
    api('/api/v1/signals', { method: 'POST', body: { channel: 'console', kind: 'ambient', text: text } })
      .then(function (result) {
        var signal = result.signal || {};
        var parts = [];
        if (result.created === false) parts.push('这条信号已经收到过');
        if (result.attached) parts.push('并入已有责任');
        if (result.opened) parts.push('新开了一条责任');
        state.chat.items.push({ role: 'me', text: text, meta: when(new Date().toISOString()) });
        state.chat.items.push({
          role: 'it',
          text: parts.length ? parts.join('，') : '记下了。',
          meta: '信号 ' + (signal.signal_id || signal.signalId || '—') + (signal.kind ? ' · ' + signal.kind : ''),
        });
        state.chat.busy = false;
        render();
        load();
      })
      .catch(function (err) { state.chat.busy = false; state.chat.error = err.message || String(err); render(); });
  }

  // --- 记忆 ---
  function loadMemory() {
    state.memory.error = ''; render();
    return api('/api/v1/memory/tree')
      .then(function (result) { state.memory.tree = result.tree || []; render(); })
      .catch(function (err) { state.memory.error = err.message || String(err); render(); });
  }
  function openFile(pathname) {
    state.memory.path = pathname; state.memory.error = ''; render();
    Promise.all([
      api('/api/v1/memory/file?path=' + encodeURIComponent(pathname)),
      api('/api/v1/memory/history?path=' + encodeURIComponent(pathname)),
    ]).then(function (results) {
      state.memory.content = results[0].content || '';
      state.memory.history = results[1].history || [];
      render();
    }).catch(function (err) { state.memory.error = err.message || String(err); render(); });
  }
  function revertFile(commit) {
    if (!state.memory.path) return;
    state.memory.error = ''; render();
    api('/api/v1/memory/revert', { method: 'POST', body: { commit: commit, path: state.memory.path } })
      .then(function () { openFile(state.memory.path); })
      .catch(function (err) { state.memory.error = err.message || String(err); render(); });
  }
  function treeHtml(nodes, depth) {
    return (nodes || []).map(function (node) {
      var pad = 'style="padding-left:' + (8 + depth * 14) + 'px"';
      if (node.dir) {
        return '<div class="tree-item" ' + pad + '>' + esc(node.name) + '</div>' + treeHtml(node.children, depth + 1);
      }
      var active = state.memory.path === node.path ? ' active' : '';
      return '<div class="tree-item' + active + '" ' + pad + ' data-file="' + esc(node.path) + '">' + esc(node.name) + '</div>';
    }).join('');
  }
  function memoryView() {
    var memory = state.memory;
    var body = memory.path
      ? '<div class="file-head"><span class="muted mono">' + esc(memory.path) + '</span>' +
        '<span class="muted" style="font-size:12px;white-space:nowrap">' +
        esc(memory.content.split('\\n').length) + ' 行</span></div>' +
        (memory.content.trim()
          ? '<pre class="file-body">' + esc(memory.content) + '</pre>'
          : '<div class="muted">这个文件是空的。</div>')
      : empty('从左侧选一个文件。');
    var history = memory.history.length
      ? '<h2 class="section-title">历史</h2>' + memory.history.map(function (entry) {
        return '<div class="history-row"><span class="mono">' + esc(entry.commit.slice(0, 7)) + '</span>' +
          '<span class="muted">' + esc(entry.subject) + '</span>' +
          '<span class="muted mono" style="white-space:nowrap">' + esc(when(entry.at)) + '</span>' +
          '<button class="btn btn-sm" data-revert="' + esc(entry.commit) + '">回滚</button></div>';
      }).join('')
      : '';
    return page('记忆',
      (memory.error ? '<div class="card error">' + esc(memory.error) + '</div>' : '') +
      '<div class="memory-grid"><div class="card tree">' +
        (memory.tree.length ? treeHtml(memory.tree, 0) : '<span class="muted">仓库还是空的。</span>') +
      '</div><div><div class="card">' + body + '</div>' + history + '</div></div>');
  }

  // --- 知识库 ---
  var KNOWLEDGE_TYPES = ['pitfall', 'insight', 'decision', 'pattern', 'constraint'];
  var KNOWLEDGE_TYPE_LABEL = { pitfall: '坑', insight: '洞察', decision: '决策', pattern: '模式', constraint: '约束' };
  function knowledgeTypeLabel(type) { return KNOWLEDGE_TYPE_LABEL[type] || type; }
  function knowledgeDetailView(item) {
    var meta = '<div class="kv" style="margin-top:12px">' +
      '<div class="k">项目</div><div>' + esc(item.projectId || '全局') + '</div>' +
      '<div class="k">类型</div><div>' + esc(knowledgeTypeLabel(item.type)) + '</div>' +
      '<div class="k">来源</div><div>' + esc(item.source || '—') + '</div>' +
      '<div class="k">创建</div><div>' + esc(when(item.createdAt)) + '</div>' +
      '<div class="k">更新</div><div>' + esc(when(item.updatedAt)) + '</div>' +
      '<div class="k">版本</div><div>' + esc(item.revision) + '</div>' +
      '</div>';
    var chips = (item.tags || []).concat(item.keywords || []);
    return '<div class="card"><div class="detail-head">' +
      '<button class="btn btn-sm" data-act="knowledge-back">返回列表</button>' +
      '<h2>' + esc(item.title) + '</h2>' +
      '<span class="badge badge-muted">' + esc(knowledgeTypeLabel(item.type)) + '</span></div>' +
      meta +
      '<div class="block"><div class="label">正文</div><div class="knowledge-body">' + esc(item.body) + '</div></div>' +
      (chips.length ? '<div class="chips">' + chips.map(function (chip) {
        return '<span class="badge badge-muted">' + esc(chip) + '</span>';
      }).join('') + '</div>' : '') +
      '</div>';
  }
  function knowledgeView() {
    var knowledge = state.knowledge;
    if (knowledge.detail) return page('知识库', knowledgeDetailView(knowledge.detail));
    var projects = [];
    knowledge.items.forEach(function (item) {
      if (item.projectId && projects.indexOf(item.projectId) < 0) projects.push(item.projectId);
    });
    var toolbar = '<form class="toolbar" id="knowledgeSearch">' +
      '<input id="knowledgeQuery" placeholder="搜索标题或正文…" value="' + esc(knowledge.query) + '">' +
      '<select id="knowledgeProject"><option value="">全部项目</option>' + projects.map(function (id) {
        return '<option value="' + esc(id) + '"' + (id === knowledge.projectId ? ' selected' : '') + '>' + esc(id) + '</option>';
      }).join('') + '</select>' +
      '<select id="knowledgeType"><option value="">全部类型</option>' + KNOWLEDGE_TYPES.map(function (type) {
        return '<option value="' + type + '"' + (type === knowledge.type ? ' selected' : '') + '>' + esc(knowledgeTypeLabel(type)) + '</option>';
      }).join('') + '</select>' +
      '<button class="btn" type="submit">搜索</button></form>';
    var body = knowledge.error ? '<div class="card error">' + esc(knowledge.error) + '</div>'
      : !knowledge.items.length ? empty(knowledge.query ? '没有匹配的知识。' : '知识库还是空的。')
      : knowledge.items.map(function (item) {
        var first = String(item.body || '').split('\\n')[0];
        return '<div class="list-row clickable" data-knowledge="' + esc(item.id) + '">' +
          '<span class="badge badge-muted">' + esc(knowledgeTypeLabel(item.type)) + '</span>' +
          '<div class="grow">' + esc(item.title) + '<div class="sub">' +
            esc(item.projectId || item.scope || '全局') + ' · ' + esc(first.slice(0, 80)) + '</div></div>' +
          '<span class="muted mono">' + esc(when(item.updatedAt)) + '</span></div>';
      }).join('');
    return page('知识库',
      toolbar + '<h2 class="section-title">共 ' + knowledge.items.length + ' 条</h2><div class="card">' + body + '</div>');
  }

  // --- 技能 ---
  function skillDetailView() {
    var skills = state.skills;
    var isNew = !skills.detail;
    var busy = skills.busy === 'save';
    return '<div class="card"><div class="detail-head">' +
      '<button class="btn btn-sm" data-act="skill-back">返回列表</button>' +
      '<h2>' + esc(isNew ? '新建技能' : skills.detail.name) + '</h2>' +
      (isNew ? '' : '<span class="badge badge-muted">v' + esc(skills.detail.version) + '</span>') + '</div>' +
      (isNew ? '<label class="field"><span>技能名（就是文件名，例如 my-skill）</span>' +
        '<input id="skillName" value="' + esc(skills.draftName) + '"></label>' : '') +
      '<label class="field"><span>内容（Markdown）</span>' +
        '<textarea class="editor" id="skillContent">' + esc(skills.draft || '') + '</textarea></label>' +
      (skills.error ? '<div class="error">' + esc(skills.error) + '</div>' : '') +
      '<div class="actions" style="margin-top:12px">' +
        '<button class="btn btn-primary" data-act="skill-save"' + (busy ? ' disabled' : '') + '>' +
          (busy ? '保存中…' : '保存') + '</button>' +
        (isNew ? '' : '<button class="btn btn-danger" data-act="skill-delete"' +
          (skills.busy === 'delete' ? ' disabled' : '') + '>删除</button>') +
      '</div></div>';
  }
  function skillsView() {
    var skills = state.skills;
    if (skills.draft !== null) return page('技能', skillDetailView());
    var body = skills.error ? '<div class="card error">' + esc(skills.error) + '</div>'
      : !skills.items.length ? empty('还没有技能。')
      : skills.items.map(function (skill) {
        return '<div class="list-row clickable" data-skill="' + esc(skill.name) + '">' +
          '<div class="grow">' + esc(skill.name) + '<div class="sub">v' + esc(skill.version) + '</div></div>' +
          '<span class="muted mono">' + esc(when(skill.updatedAt)) + '</span></div>';
      }).join('');
    return page('技能',
      '<div class="toolbar"><button class="btn btn-primary" data-act="skill-new">新建技能</button>' +
        '<span class="muted" style="font-size:12px">保存后立即推送给所有在线执行器。</span></div>' +
      '<h2 class="section-title">已分发 · ' + skills.items.length + '</h2><div class="card">' + body + '</div>');
  }

  // --- 任务 ---
  var TASK_STATUS_LABEL = {
    queued: '排队', claimed: '已领取', running: '运行中', awaiting_input: '等待输入',
    done: '已完成', failed: '失败', cancelled: '已取消',
  };
  var TASK_FILTERS = [
    { key: 'all', label: '全部', match: function () { return true; } },
    { key: 'active', label: '进行中', match: function (task) { return ['queued', 'claimed', 'running', 'awaiting_input'].indexOf(task.status) >= 0; } },
    { key: 'failed', label: '失败', match: function (task) { return task.status === 'failed' || task.status === 'cancelled'; } },
    { key: 'done', label: '已完成', match: function (task) { return task.status === 'done'; } },
  ];
  function taskStatusBadge(status) {
    var map = {
      done: 'badge-ok', failed: 'badge-danger', cancelled: 'badge-danger',
      running: 'badge-warn', claimed: 'badge-warn', awaiting_input: 'badge-warn',
    };
    return '<span class="badge ' + (map[status] || 'badge-muted') + '">' + esc(TASK_STATUS_LABEL[status] || status) + '</span>';
  }
  function briefBlock(brief) {
    if (!brief || typeof brief !== 'object') return '';
    var parts = '';
    if (brief.goal) parts += '<div class="brief">' + esc(brief.goal) + '</div>';
    if (brief.prompt) parts += '<div class="brief">' + esc(brief.prompt) + '</div>';
    if (Array.isArray(brief.acceptance) && brief.acceptance.length) {
      parts += '<div class="block"><div class="label">验收标准</div><div class="brief"><ul>' +
        brief.acceptance.map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul></div></div>';
    }
    if (brief.context) parts += '<div class="block"><div class="label">上下文</div><div class="brief">' + esc(brief.context) + '</div></div>';
    return parts;
  }
  function taskDetailView() {
    var detail = state.taskDetail;
    var task = detail.task;
    var kv = '<div class="kv">' +
      '<div class="k">任务 id</div><div class="mono">' + esc(task.task_id) + '</div>' +
      '<div class="k">项目</div><div>' + esc(task.project_id || '—') + '</div>' +
      '<div class="k">类型</div><div class="mono">' + esc(task.type) + '</div>' +
      '<div class="k">创建者</div><div>' + esc(task.created_by || '—') + '</div>' +
      '<div class="k">优先级</div><div>' + esc(task.priority) + '</div>' +
      '<div class="k">后端</div><div>' + esc(task.backend_kind || '—') + '</div>' +
      '<div class="k">执行节点</div><div class="mono">' + esc(task.executor_node_id || '—') + '</div>' +
      '<div class="k">尝试次数</div><div>' + esc(task.attempts) + ' / ' + esc(task.max_attempts) + '</div>' +
      '<div class="k">创建</div><div>' + esc(when(task.created_at)) + '</div>' +
      (task.started_at ? '<div class="k">开始</div><div>' + esc(when(task.started_at)) + '</div>' : '') +
      (task.finished_at ? '<div class="k">结束</div><div>' + esc(when(task.finished_at)) + '</div>' : '') +
      (task.session_ref ? '<div class="k">会话</div><div class="mono">' + esc(task.session_ref) + '</div>' : '') +
      '</div>';
    var brief = briefBlock(task.brief);
    var result = task.result
      ? '<div class="block"><div class="label">' + (task.status === 'failed' ? '失败原因' : '结果') + '</div>' +
        '<div class="brief">' + esc(task.result.error || JSON.stringify(task.result, null, 2)) + '</div></div>'
      : '';
    var events = detail.events.length
      ? detail.events.map(function (event) {
        var payload = event.payload && Object.keys(event.payload).length ? JSON.stringify(event.payload) : '';
        return '<div class="event"><span class="seq">' + esc(event.seq) + '</span>' +
          '<span class="type">' + esc(event.type) + '</span>' +
          '<span class="payload" title="' + esc(payload) + '">' + esc(payload) + '</span>' +
          '<span class="muted mono">' + esc(when(event.ts)) + '</span></div>';
      }).join('')
      : '<div class="muted">没有事件记录。</div>';
    return '<div class="card"><div class="detail-head">' +
      '<button class="btn btn-sm" data-act="task-back">返回列表</button>' +
      '<h2>' + esc(task.title || task.type) + '</h2>' + taskStatusBadge(task.status) + '</div>' +
      kv +
      (brief ? '<div class="block"><div class="label">任务说明</div>' + brief + '</div>' : '') +
      result +
      '<div class="block"><div class="label">事件流 · ' + detail.events.length + '</div>' + events + '</div></div>';
  }
  function tasksView() {
    if (state.taskDetail) return page('任务', taskDetailView());
    var rows = state.tasks.filter((TASK_FILTERS.filter(function (entry) { return entry.key === state.tasksFilter; })[0] || TASK_FILTERS[0]).match);
    var filters = '<div class="filters">' + TASK_FILTERS.map(function (entry) {
      return '<button class="filter" data-filter="' + entry.key + '" aria-pressed="' +
        (entry.key === state.tasksFilter ? 'true' : 'false') + '">' + entry.label + ' ' +
        state.tasks.filter(entry.match).length + '</button>';
    }).join('') + '</div>';
    var body = !state.tasks.length ? empty('还没有任务。')
      : !rows.length ? empty('这个筛选下没有任务。')
      : rows.map(function (task) {
        var busy = state.taskBusy === task.task_id;
        return '<div class="list-row clickable" data-task="' + esc(task.task_id) + '">' + taskStatusBadge(task.status) +
          '<div class="grow">' + esc(task.title || task.type) + '<div class="sub">' +
            esc(task.project_id || '未归属项目') + ' · 优先级 ' + esc(task.priority) + ' · ' + esc(task.type) + '</div></div>' +
          '<span class="muted mono">' + esc(busy ? '加载中…' : when(task.created_at)) + '</span></div>';
      }).join('');
    return page('任务', filters + '<div class="card">' + body + '</div>');
  }

  // --- 节点与同步 ---
  function nodesView() {
    var sync = state.sync;
    var identity = sync
      ? '<div class="card"><div class="kv">' +
          '<div class="k">本节点</div><div class="mono">' + esc(sync.node_id) + '</div>' +
          '<div class="k">协议版本</div><div>v' + esc(sync.protocol_version) + '</div>' +
          '<div class="k">签名</div><div>' + (sync.signing ? '已启用' : '<span class="badge badge-warn">未启用</span>') + '</div>' +
          '<div class="k">中继</div><div>' + (sync.relay ? '已配置 · ' + (sync.relay_origins || []).length + ' 个来源' : '直连') + '</div>' +
          '<div class="k">最高序号</div><div class="mono">' + esc(sync.head_seq) + '</div>' +
        '</div></div>'
      : empty('还没有同步状态。');
    var peers = !state.peers.length
      ? empty('还没有别的节点。只有一台机器跑 Core 时，这一页本来就只有本节点。')
      : state.peers.map(function (peer) {
        var revoked = peer.status !== 'active';
        return '<div class="card"><div class="head"><strong style="flex:1">' + esc(peer.display_name || peer.node_id) + '</strong>' +
          '<span class="badge ' + (revoked ? 'badge-danger' : 'badge-ok') + '">' + esc(peer.status) + '</span>' +
          '<span class="badge badge-muted">v' + esc(peer.protocol_version) + '</span></div>' +
          '<div class="kv" style="margin-top:12px">' +
            '<div class="k">节点 id</div><div class="mono">' + esc(peer.node_id) + '</div>' +
            '<div class="k">地址</div><div class="mono">' + esc(peer.endpoint_url || '—') + '</div>' +
            '<div class="k">最近可见</div><div>' + esc(when(peer.last_seen_at)) + '</div>' +
          '</div></div>';
      }).join('');
    var inbox = sync
      ? (Object.keys(sync.inbox || {}).map(function (key) {
        return '<div class="list-row"><div class="grow">' + esc(key) + '</div>' +
          '<span class="mono">' + esc(sync.inbox[key]) + '</span></div>';
      }).join('') || '<div class="list-row muted">收件箱是空的。</div>')
      : '';
    var cursors = state.cursors.length
      ? state.cursors.map(function (cursor) {
        return '<div class="list-row"><div class="grow mono">' + esc(cursor.node_id || cursor.nodeId) + '</div>' +
          '<span class="muted mono">' + esc(cursor.last_seq ?? cursor.lastSeq ?? '—') + '</span></div>';
      }).join('')
      : '<div class="list-row muted">还没有游标。</div>';
    return page('节点与同步',
      '<p class="muted" style="margin:0 0 16px;font-size:13px">多台机器各跑一个 Core 时，' +
        '它们用签名事件互相复制状态。这里显示本节点的同步身份，以及每个对端复制到哪了。</p>' +
      '<h2 class="section-title">本节点</h2>' + identity +
      '<h2 class="section-title">对端节点 · ' + state.peers.length + '</h2>' + peers +
      (sync ? '<h2 class="section-title">收件箱</h2><div class="card">' + inbox + '</div>' : '') +
      '<h2 class="section-title">对端游标</h2><div class="card">' + cursors + '</div>');
  }

  // --- 回复记录 ---
  function repliesView() {
    var body = !state.replies.length ? empty('还没有回复记录。')
      : state.replies.map(function (reply) {
        var evidence = (reply.evidence || []).map(function (item) {
          return '<span class="mono">' + esc(item.kind || '—') + ':' + esc(item.ref || '') + '</span>';
        }).join(' ');
        return '<div class="card"><div class="head">' +
          '<span class="badge badge-muted">' + esc(reply.tier) + '</span>' +
          '<span class="badge ' + (reply.autonomy === 'timeout' ? 'badge-warn' : 'badge-ok') + '">' +
            esc(reply.autonomy === 'timeout' ? '超时发出' : reply.autonomy === 'user' ? '你批准' : '自主') + '</span>' +
          '<strong style="flex:1">' + esc(reply.channelTarget) + '</strong>' +
          '<span class="muted mono">' + esc(when(reply.createdAt)) + '</span></div>' +
          '<div class="draft">' + esc(reply.text) + '</div>' +
          (evidence ? '<div class="evidence" style="border-top:none;padding-top:8px">' + evidence + '</div>' : '') +
          '</div>';
      }).join('');
    return page('回复记录', '<h2 class="section-title">共 ' + state.replies.length + ' 条</h2>' + body);
  }

  // --- 体检 ---
  function loadCheckup() {
    state.checkup.error = ''; render();
    return Promise.all([api('/api/v1/ai/metrics'), api('/api/v1/ai/suggestions?status=pending')])
      .then(function (results) {
        state.checkup.metrics = results[0].metrics || null;
        state.checkup.suggestions = results[1].suggestions || [];
        render();
      })
      .catch(function (err) { state.checkup.error = err.message || String(err); render(); });
  }
  function runCheckup() {
    state.checkup.busy = 'checkup'; render();
    api('/api/v1/ai/checkup', { method: 'POST', body: {} })
      .catch(function (err) { state.checkup.error = err.message || String(err); })
      .then(function () { state.checkup.busy = ''; loadCheckup(); });
  }
  function decideSuggestion(id, action) {
    state.checkup.busy = id; render();
    api('/api/v1/ai/suggestions/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: {} })
      .catch(function (err) { state.checkup.error = err.message || String(err); })
      .then(function () { state.checkup.busy = ''; loadCheckup(); });
  }
  function checkupView() {
    var checkup = state.checkup;
    var assistant = checkup.metrics && checkup.metrics.assistant;
    var pct = function (rate) { return rate == null ? null : Math.round(rate * 100) + '%'; };
    var cards = assistant
      ? metricCard('提案准确率', pct(assistant.proposals.approval_rate), '批准 ' + assistant.proposals.approved + ' / ' + assistant.proposals.total) +
        metricCard('提案否决率', pct(assistant.proposals.rejection_rate), '否决 ' + assistant.proposals.rejected) +
        metricCard('消解自动率', pct(assistant.resolution.auto_rate), '高置信 ' + assistant.resolution.high_confidence + ' / ' + assistant.resolution.total) +
        metricCard('回复否决率', pct(assistant.replies.veto_rate), '否决 ' + assistant.replies.vetoed + ' / ' + assistant.replies.total) +
        metricCard('自主发送', String(assistant.replies.auto_sent), '非人工批准') +
        metricCard('责任丢弃', String(assistant.commitments.dropped), '最安静的负信号')
      : '<div class="card muted">还没有可计算的指标。</div>';
    var suggestions = checkup.suggestions.length
      ? checkup.suggestions.map(function (suggestion) {
        var busy = checkup.busy === suggestion.suggestionId;
        return '<div class="card"><div class="head"><strong style="flex:1">' + esc(suggestion.title) + '</strong>' +
          '<span class="badge badge-muted">' + esc(suggestion.targetType) + '</span></div>' +
          '<div class="ask"><div class="label">依据</div><div>' + esc(suggestion.summary) + '</div></div>' +
          '<div class="actions">' +
          '<button class="btn btn-primary" data-suggestion="' + esc(suggestion.suggestionId) + '" data-decision="approve"' + (busy ? ' disabled' : '') + '>采纳并应用</button>' +
          '<button class="btn btn-ghost" data-suggestion="' + esc(suggestion.suggestionId) + '" data-decision="ignore"' + (busy ? ' disabled' : '') + '>忽略</button>' +
          '</div></div>';
      }).join('')
      : empty('没有待处理的建议。');
    return page('体检',
      (checkup.error ? '<div class="card error">' + esc(checkup.error) + '</div>' : '') +
      '<h2 class="section-title">助理行为指标</h2><div class="metrics">' + cards + '</div>' +
      '<h2 class="section-title">AI 改进建议 · ' + checkup.suggestions.length + '</h2>' + suggestions);
  }

  function render() {
    if (!token() && state.setup.needed) { root.innerHTML = setupView(); return; }
    if (!token()) { root.innerHTML = loginView(); return; }
    if (state.view === 'proposals') root.innerHTML = proposalsView();
    else if (state.view === 'commitments') root.innerHTML = commitmentsView();
    else if (state.view === 'chat') root.innerHTML = chatView();
    else if (state.view === 'memory') root.innerHTML = memoryView();
    else if (state.view === 'knowledge') root.innerHTML = knowledgeView();
    else if (state.view === 'skills') root.innerHTML = skillsView();
    else if (state.view === 'tasks') root.innerHTML = tasksView();
    else if (state.view === 'nodes') root.innerHTML = nodesView();
    else if (state.view === 'replies') root.innerHTML = repliesView();
    else if (state.view === 'checkup') root.innerHTML = checkupView();
    else root.innerHTML = todayView();
  }

  function ensureView(view) {
    if (view === 'today') return loadToday();
    if (view === 'proposals') return load();
    if (view === 'commitments') return loadCommitments();
    if (view === 'memory') return state.memory.tree.length ? undefined : loadMemory();
    if (view === 'knowledge') return loadKnowledge();
    if (view === 'skills') return loadSkills();
    if (view === 'tasks') return loadTasks();
    if (view === 'nodes') return loadNodes();
    if (view === 'replies') return loadReplies();
    if (view === 'checkup') return loadCheckup();
    return undefined;
  }

  root.addEventListener('submit', function (event) {
    if (event.target.id === 'setup') {
      event.preventDefault();
      var setupEmail = document.getElementById('setupEmail').value.trim();
      var setupPassword = document.getElementById('setupPassword').value;
      state.setup.busy = true; state.setup.error = ''; render();
      api('/api/v1/auth/bootstrap', { method: 'POST', body: { email: setupEmail, password: setupPassword } })
        .then(function () { state.setup.busy = false; state.setup.needed = false; render(); })
        .catch(function (err) { state.setup.busy = false; state.setup.error = err.message || String(err); render(); });
      return;
    }
    if (event.target.id === 'chat') {
      event.preventDefault();
      var field = document.getElementById('chatText');
      var text = field ? field.value.trim() : '';
      if (text) sendChat(text);
      return;
    }
    if (event.target.id === 'knowledgeSearch') {
      event.preventDefault();
      var queryField = document.getElementById('knowledgeQuery');
      var projectField = document.getElementById('knowledgeProject');
      var typeField = document.getElementById('knowledgeType');
      state.knowledge.query = queryField ? queryField.value.trim() : '';
      state.knowledge.projectId = projectField ? projectField.value : '';
      state.knowledge.type = typeField ? typeField.value : '';
      loadKnowledge();
      return;
    }
    if (event.target.id !== 'login') return;
    event.preventDefault();
    // Read the fields before re-rendering: render() rebuilds the form.
    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;
    state.busyLogin = true; state.loginError = ''; render();
    api('/api/v1/auth/client-login', { method: 'POST', body: { email: email, password: password } })
      .then(function (result) { state.busyLogin = false; setToken(result.access_token); })
      .catch(function (err) { state.busyLogin = false; state.loginError = err.message || String(err); render(); });
  });

  root.addEventListener('click', function (event) {
    var nav = event.target.closest('[data-nav]');
    if (nav) {
      state.view = nav.dataset.nav; state.error = ''; render();
      ensureView(state.view);
      return;
    }
    var file = event.target.closest('[data-file]');
    if (file) return openFile(file.dataset.file);
    var goto = event.target.closest('[data-goto]');
    if (goto) {
      state.view = goto.dataset.goto; state.error = ''; render();
      ensureView(state.view);
      return;
    }
    var filter = event.target.closest('[data-filter]');
    if (filter) { state.tasksFilter = filter.dataset.filter; render(); return; }
    var taskRow = event.target.closest('[data-task]');
    if (taskRow) return openTask(taskRow.dataset.task);
    var knowledgeRow = event.target.closest('[data-knowledge]');
    if (knowledgeRow) {
      state.knowledge.detail = state.knowledge.items.filter(function (item) {
        return item.id === knowledgeRow.dataset.knowledge;
      })[0] || null;
      render();
      return;
    }
    var skillRow = event.target.closest('[data-skill]');
    if (skillRow) return openSkill(skillRow.dataset.skill);
    var revert = event.target.closest('[data-revert]');
    if (revert) return revertFile(revert.dataset.revert);
    var suggestion = event.target.closest('[data-suggestion]');
    if (suggestion) return decideSuggestion(suggestion.dataset.suggestion, suggestion.dataset.decision);
    var button = event.target.closest('[data-act]');
    if (!button) return;
    var action = button.dataset.act;
    if (action === 'refresh') return ensureView(state.view) || loadToday();
    if (action === 'task-back') { state.taskDetail = null; render(); return; }
    if (action === 'knowledge-back') { state.knowledge.detail = null; render(); return; }
    if (action === 'skill-new') {
      state.skills.detail = null; state.skills.draft = ''; state.skills.draftName = ''; state.skills.error = '';
      render();
      return;
    }
    if (action === 'skill-back') {
      state.skills.detail = null; state.skills.draft = null; state.skills.draftName = ''; state.skills.error = '';
      render();
      return;
    }
    if (action === 'skill-save') {
      // Read the editor before render() rebuilds it.
      var contentField = document.getElementById('skillContent');
      var nameField = document.getElementById('skillName');
      if (contentField) state.skills.draft = contentField.value;
      if (nameField) state.skills.draftName = nameField.value;
      return saveSkill();
    }
    if (action === 'skill-delete') return deleteSkill(state.skills.detail.name);
    if (action === 'checkup-run') return runCheckup();
    if (action === 'logout') return setToken('');
    var id = button.dataset.id;
    state.busy = id; render();
    api('/api/v1/proposals/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: {} })
      .catch(function (err) { state.error = err.message || String(err); })
      .then(function () { state.busy = ''; load(); });
  });

  // The two knowledge filters reload on change; the search box waits for submit.
  root.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.id) return;
    if (target.id === 'knowledgeProject') { state.knowledge.projectId = target.value; loadKnowledge(); }
    if (target.id === 'knowledgeType') { state.knowledge.type = target.value; loadKnowledge(); }
  });

  // The countdown is the only thing that changes without a server round trip.
  timer = setInterval(function () {
    if (!token()) return;
    if (state.view === 'proposals' &&
        state.proposals.some(function (proposal) { return proposal.state === 'pending' && proposal.vetoDeadline; })) render();
  }, 1000);
  window.addEventListener('beforeunload', function () { if (timer) clearInterval(timer); });

  document.addEventListener('visibilitychange', reportPresence);
  window.addEventListener('focus', reportPresence);
  window.addEventListener('blur', reportPresence);
  setInterval(reportPresence, 30000).unref?.();

  render();
  if (token()) { load(); loadToday(); reportPresence(); }
  else loadSetup();
})();
</script>
</body>
</html>`;
