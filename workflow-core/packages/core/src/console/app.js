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
@media (max-width:640px) { .shell { padding:var(--s4); } .actions { flex-wrap:wrap; } }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var TOKEN_KEY = 'workflow.console.token';
  var root = document.getElementById('root');
  var state = { view: 'proposals', proposals: [], loading: false, error: '', busy: '', loginError: '', busyLogin: false };
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
      .then(function (result) { state.proposals = result.proposals || []; })
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
      '<button class="btn btn-ghost" data-act="refresh">刷新</button>' +
      '<button class="btn btn-ghost" data-act="logout">退出</button></div>' +
      '<h2 class="section-title">待决策 · ' + state.proposals.length + '</h2>' + body + '</div>';
  }

  function render() {
    root.innerHTML = token() ? proposalsView() : loginView();
  }

  root.addEventListener('submit', function (event) {
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
    var button = event.target.closest('[data-act]');
    if (!button) return;
    var action = button.dataset.act;
    if (action === 'refresh') return load();
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

  render();
  if (token()) load();
})();
</script>
</body>
</html>`;
