// console/app.js - the Workflow console, served by Core at /console.
//
// No build step and no external assets: the same design tokens as
// docs/design/console-mockup.html, wired to the real API with plain DOM code.
// The page itself is public like /admin; every API call it makes requires the
// user's own session.
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
html,body { margin:0; min-height:100%; background:var(--bg); color:var(--text);
  font-family:var(--font); font-size:14px; line-height:1.6; -webkit-font-smoothing:antialiased; }
button { font-family:inherit; font-size:14px; cursor:pointer; }
input { font-family:inherit; }
.btn { padding:var(--s2) var(--s4); border-radius:var(--r-btn); border:1px solid var(--border-strong);
  background:var(--surface-2); color:var(--text); transition:background .15s ease; }
.btn:hover { background:var(--surface-3); }
.btn-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn-primary:hover { filter:brightness(1.08); }
.btn-danger { background:var(--danger-soft); border-color:var(--danger); color:var(--danger); }
.btn-ghost { background:transparent; border-color:transparent; color:var(--text-2); }
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
.center { min-height:100vh; display:grid; place-items:center; padding:var(--s5); }
.shell { max-width:820px; margin:0 auto; padding:var(--s5); }
.topbar { display:flex; align-items:center; gap:var(--s3); margin-bottom:var(--s5); }
.topbar h1 { font-size:16px; font-weight:600; margin:0; }
.spacer { flex:1; }
.field { display:block; margin-bottom:var(--s3); }
.field span { display:block; font-size:12px; color:var(--text-3); margin-bottom:var(--s1); }
.field input { width:100%; padding:var(--s2) var(--s3); border-radius:var(--r-btn);
  border:1px solid var(--border-strong); background:var(--surface-2); color:var(--text); font-size:14px; }
.error { color:var(--danger); font-size:13px; margin-top:var(--s2); }
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
.section-title { font-size:12px; font-weight:600; letter-spacing:.4px; color:var(--text-3);
  text-transform:uppercase; margin:0 0 var(--s3); }
.btn-sm { padding: 2px var(--s2); font-size: 12px; }
.tree-item { padding: 2px var(--s2); border-radius: 5px; color: var(--text-2); cursor: pointer; font-size: 13px; }
.tree-item:hover { background: var(--surface-2); color: var(--text); }
.tree-item.active { background: rgba(108,140,255,.12); color: var(--text); }
.memory-grid { display: grid; grid-template-columns: 240px 1fr; gap: var(--s3); align-items: start; }
.file-head { padding-bottom: var(--s3); border-bottom: 1px solid var(--border); margin-bottom: var(--s3); }
.file-body { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; color: var(--text-2); }
.history-row { display: flex; align-items: center; gap: var(--s3); padding: var(--s2) 0; border-bottom: 1px solid var(--border); }
.history-row:last-child { border-bottom: none; }
.history-row .muted { flex: 1; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s3); }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); padding: var(--s4); }
.metric .k { font-size: 12px; color: var(--text-3); }
.metric .v { font-size: 24px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.metric .d { font-size: 12px; margin-top: 2px; }
@media (max-width:640px) { .shell { padding:var(--s4); } .actions { flex-wrap:wrap; } .memory-grid { grid-template-columns: 1fr; } .metrics { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var TOKEN_KEY = 'workflow.console.token';
  var root = document.getElementById('root');
  var state = {
    view: 'proposals', proposals: [], loading: false, error: '', busy: '', loginError: '', busyLogin: false,
    memory: { tree: [], path: null, content: '', history: [], error: '' },
    replies: { items: [], error: '' },
    checkup: { metrics: null, suggestions: [], error: '', busy: '' },
    setup: { needed: false, codeState: 'missing', error: '', busy: false },
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
    state.proposals = []; state.error = '';
    render();
    if (value) load();
  }

  // Presence: this tab reports its own facts; the server decides who is most
  // likely in front of the user.
  var TOUCHPOINT_KEY = 'workflow.console.touchpoint';
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
        body: {
          touchpoint_id: touchpointId(),
          kind: desktop ? 'desktop' : 'browser',
          idle_bucket: value,
        },
      });
    }).catch(function () { /* presence is best effort */ });
  }

  // A native notification is the one thing a closed tab cannot do.
  function notifyIfMorePending(proposals) {
    var desktop = window.workflowDesktop;
    var pending = (proposals || []).filter(function (proposal) { return proposal.state === 'pending'; });
    if (!pending.length) { state.notifiedCount = 0; return; }
    if (!desktop || !desktop.notify) return;
    if (pending.length <= (state.notifiedCount || 0)) return;
    state.notifiedCount = pending.length;
    desktop.notify({
      title: 'Workflow：' + pending.length + ' 条待决策',
      body: pending[0].title,
    });
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

  function load() {
    if (!token()) return;
    state.loading = true; state.error = ''; render();
    api('/api/v1/proposals?state=pending')
      .then(function (result) {
        state.proposals = result.proposals || [];
        notifyIfMorePending(state.proposals);
      })
      .catch(function (err) { state.error = err.message || String(err); })
      .then(function () { state.loading = false; render(); });
  }

  function secondsLeft(deadline) {
    if (!deadline) return null;
    return Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
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
      : state.error ? '<div class="card error">' + esc(state.error) + '</div>'
      : state.proposals.length ? state.proposals.map(proposalView).join('')
      : '<div class="card muted">没有待决策的提案。</div>';
    return '<div class="shell"><div class="topbar"><h1>提案</h1><div class="spacer"></div>' +
      '<button class="btn btn-ghost" data-nav="memory">记忆</button>' +
      '<button class="btn btn-ghost" data-nav="replies">回复记录</button>' +
      '<button class="btn btn-ghost" data-nav="checkup">体检</button>' +
      '<button class="btn btn-ghost" data-act="refresh">刷新</button>' +
      '<button class="btn btn-ghost" data-act="logout">退出</button></div>' +
      '<h2 class="section-title">待决策 · ' + state.proposals.length + '</h2>' + body + '</div>';
  }

  // --- audit: every reply the assistant sent, with the tier that allowed it ---
  function loadReplies() {
    state.replies.error = ''; render();
    api('/api/v1/replies?limit=100')
      .then(function (result) { state.replies.items = result.replies || []; render(); })
      .catch(function (err) { state.replies.error = err.message || String(err); render(); });
  }

  function repliesView() {
    var items = state.replies.items;
    var body = state.replies.error ? '<div class="card error">' + esc(state.replies.error) + '</div>'
      : !items.length ? '<div class="card muted">还没有回复记录。</div>'
      : items.map(function (reply) {
        var evidence = (reply.evidence || []).map(function (item) {
          return '<span class="mono">' + esc(item.kind || '—') + ':' + esc(item.ref || '') + '</span>';
        }).join(' ');
        return '<div class="card"><div class="head">' +
          '<span class="badge badge-muted">' + esc(reply.tier) + '</span>' +
          '<span class="badge ' + (reply.autonomy === 'timeout' ? 'badge-warn' : 'badge-ok') + '">' +
            esc(reply.autonomy === 'timeout' ? '超时发出' : reply.autonomy === 'user' ? '你批准' : '自主') + '</span>' +
          '<strong style="flex:1">' + esc(reply.channelTarget) + '</strong>' +
          '<span class="muted mono">' + esc(reply.createdAt) + '</span></div>' +
          '<div class="draft">' + esc(reply.text) + '</div>' +
          (evidence ? '<div class="evidence" style="border-top:none;padding-top:8px">' + evidence + '</div>' : '') +
          '</div>';
      }).join('');
    return '<div class="shell"><div class="topbar"><h1>回复记录</h1><div class="spacer"></div>' +
      '<button class="btn btn-ghost" data-nav="proposals">提案</button>' +
      '<button class="btn btn-ghost" data-nav="memory">记忆</button>' +
      '<button class="btn btn-ghost" data-nav="replies">回复记录</button>' +
      '<button class="btn btn-ghost" data-act="replies-refresh">刷新</button>' +
      '<button class="btn btn-ghost" data-act="logout">退出</button></div>' +
      '<h2 class="section-title">共 ' + items.length + ' 条</h2>' + body + '</div>';
  }

  // --- checkup: how well the assistant judges when to interrupt ---
  function loadCheckup() {
    state.checkup.error = ''; render();
    Promise.all([api('/api/v1/ai/metrics'), api('/api/v1/ai/suggestions?status=pending')])
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

  function metricCard(label, value, hint) {
    return '<div class="metric"><div class="k">' + esc(label) + '</div><div class="v">' +
      esc(value == null ? '—' : value) + '</div>' + (hint ? '<div class="d muted">' + esc(hint) + '</div>' : '') + '</div>';
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
      : '<div class="card muted">没有待处理的建议。</div>';
    return '<div class="shell"><div class="topbar"><h1>体检</h1><div class="spacer"></div>' +
      '<button class="btn btn-ghost" data-nav="proposals">提案</button>' +
      '<button class="btn btn-ghost" data-nav="memory">记忆</button>' +
      '<button class="btn btn-ghost" data-nav="replies">回复记录</button>' +
      '<button class="btn btn-ghost" data-act="checkup-refresh">刷新</button>' +
      '<button class="btn btn-ghost" data-act="checkup-run"' + (checkup.busy === 'checkup' ? ' disabled' : '') + '>立即体检</button>' +
      '<button class="btn btn-ghost" data-act="logout">退出</button></div>' +
      (checkup.error ? '<div class="card error">' + esc(checkup.error) + '</div>' : '') +
      '<h2 class="section-title">助理行为指标</h2><div class="metrics">' + cards + '</div>' +
      '<h2 class="section-title" style="margin-top:24px">AI 改进建议 · ' + checkup.suggestions.length + '</h2>' + suggestions + '</div>';
  }

  // First-run setup: the only way into a fresh install. It disappears as soon
  // as an account exists.
  function setupView() {
    var setup = state.setup;
    return '<div class="center"><form class="card" id="setup" style="width:100%;max-width:400px">' +
      '<h1 style="font-size:16px;margin:0 0 4px">初始化 Workflow</h1>' +
      '<p class="muted" style="margin:0 0 20px;font-size:13px">还没有账号。创建第一个管理员账号。</p>' +
      (setup.codeState === 'expired'
        ? '<p class="muted" style="font-size:13px">设置码已过期，请在服务器上重新运行 <code>setup-code</code>。</p>'
        : setup.codeState === 'missing'
          ? '<p class="muted" style="font-size:13px">服务器尚未签发设置码，请先运行 <code>setup-code</code>。</p>'
          : '') +
      '<label class="field"><span>设置码</span><input id="setupCode" type="text" autocomplete="off"></label>' +
      '<label class="field"><span>邮箱</span><input id="setupEmail" type="email" autocomplete="username"></label>' +
      '<label class="field"><span>密码</span><input id="setupPassword" type="password" autocomplete="new-password"></label>' +
      '<button class="btn btn-primary" type="submit" style="width:100%"' + (setup.busy ? ' disabled' : '') + '>' +
        (setup.busy ? '创建中…' : '创建账号') + '</button>' +
      (setup.error ? '<div class="error">' + esc(setup.error) + '</div>' : '') +
      '</form></div>';
  }

  function loadSetup() {
    api('/api/v1/auth/bootstrap')
      .then(function (result) {
        state.setup.needed = Boolean(result.needed);
        state.setup.codeState = result.codeState || 'missing';
        render();
      })
      .catch(function () { /* a failed probe just leaves the login form */ });
  }

  function render() {
    if (!token() && state.setup.needed) { root.innerHTML = setupView(); return; }
    if (!token()) { root.innerHTML = loginView(); return; }
    if (state.view === 'memory') root.innerHTML = memoryView();
    else if (state.view === 'replies') root.innerHTML = repliesView();
    else if (state.view === 'checkup') root.innerHTML = checkupView();
    else root.innerHTML = proposalsView();
  }

  // --- memory: the assistant's beliefs, as readable files ---
  function loadMemory() {
    state.memory.error = ''; render();
    api('/api/v1/memory/tree')
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
      ? '<div class="file-head"><span class="muted mono">' + esc(memory.path) + '</span></div>' +
        '<pre class="file-body">' + esc(memory.content) + '</pre>'
      : '<div class="card muted">从左侧选一个文件。</div>';
    var history = memory.history.length
      ? '<h2 class="section-title">历史</h2>' + memory.history.map(function (entry) {
        return '<div class="history-row"><span class="mono">' + esc(entry.commit.slice(0, 7)) + '</span>' +
          '<span class="muted">' + esc(entry.subject) + '</span>' +
          '<button class="btn btn-sm" data-revert="' + esc(entry.commit) + '">回滚</button></div>';
      }).join('')
      : '';
    return '<div class="shell"><div class="topbar"><h1>记忆</h1><div class="spacer"></div>' +
      '<button class="btn btn-ghost" data-nav="proposals">提案</button>' +
      '<button class="btn btn-ghost" data-act="memory-refresh">刷新</button>' +
      '<button class="btn btn-ghost" data-act="logout">退出</button></div>' +
      (memory.error ? '<div class="card error">' + esc(memory.error) + '</div>' : '') +
      '<div class="memory-grid"><div class="card tree">' + treeHtml(memory.tree, 0) + '</div>' +
      '<div><div class="card">' + body + '</div>' + history + '</div></div></div>';
  }

  root.addEventListener('submit', function (event) {
    if (event.target.id === 'setup') {
      event.preventDefault();
      var code = document.getElementById('setupCode');
      var email = document.getElementById('setupEmail').value.trim();
      var password = document.getElementById('setupPassword').value;
      state.setup.busy = true; state.setup.error = ''; render();
      api('/api/v1/auth/bootstrap', { method: 'POST', body: {
        code: code ? code.value.trim() : '', email: email, password: password,
      } }).then(function () {
        state.setup.busy = false; state.setup.needed = false; render();
      }).catch(function (err) {
        state.setup.busy = false; state.setup.error = err.message || String(err); render();
      });
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
      state.view = nav.dataset.nav;
      render();
      if (state.view === 'memory' && !state.memory.tree.length) loadMemory();
      if (state.view === 'replies' && !state.replies.items.length) loadReplies();
      if (state.view === 'checkup' && !state.checkup.metrics) loadCheckup();
      return;
    }
    var file = event.target.closest('[data-file]');
    if (file) return openFile(file.dataset.file);
    var revert = event.target.closest('[data-revert]');
    if (revert) return revertFile(revert.dataset.revert);
    var suggestion = event.target.closest('[data-suggestion]');
    if (suggestion) return decideSuggestion(suggestion.dataset.suggestion, suggestion.dataset.decision);
    var button = event.target.closest('[data-act]');
    if (!button) return;
    var action = button.dataset.act;
    if (action === 'refresh') return load();
    if (action === 'memory-refresh') return loadMemory();
    if (action === 'replies-refresh') return loadReplies();
    if (action === 'checkup-refresh') return loadCheckup();
    if (action === 'checkup-run') return runCheckup();
    if (action === 'logout') return setToken('');
    var id = button.dataset.id;
    state.busy = id; render();
    api('/api/v1/proposals/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: {} })
      .catch(function (err) { state.error = err.message || String(err); })
      .then(function () { state.busy = ''; load(); });
  });

  // The countdown is the only thing that changes without a server round trip.
  timer = setInterval(function () {
    if (!token()) return;
    if (state.proposals.some(function (proposal) { return proposal.state === 'pending' && proposal.vetoDeadline; })) render();
  }, 1000);
  window.addEventListener('beforeunload', function () { if (timer) clearInterval(timer); });

  document.addEventListener('visibilitychange', reportPresence);
  window.addEventListener('focus', reportPresence);
  window.addEventListener('blur', reportPresence);
  setInterval(reportPresence, 30000).unref?.();

  render();
  if (token()) { load(); reportPresence(); }
  else loadSetup();
})();
</script>
</body>
</html>`;
