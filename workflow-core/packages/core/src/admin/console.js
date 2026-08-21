// console.js - single-file admin console served at /admin. Vanilla JS over
// the same JSON APIs; cookie session auth; polls the active tab every 3s.
// The embedded script deliberately avoids nested template literals and inline
// handlers with string arguments - event delegation keeps it parse-safe.
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workflow Core 控制台</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#252a35;--fg:#dfe4ee;--dim:#8b93a7;--blue:#5b9cff;--green:#3ecf8e;--red:#ff6b6b;--amber:#f5b14c}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0}header .who{margin-left:auto;color:var(--dim);font-size:12px}
nav{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--line)}
nav button{background:none;border:none;border-bottom:2px solid transparent;color:var(--dim);padding:10px 14px;cursor:pointer;font-size:14px}
nav button.on{color:var(--fg);border-bottom-color:var(--blue)}
main{padding:16px;max-width:1200px;margin:0 auto}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line)}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--dim);font-weight:500}
tr:hover td{background:#1c2029}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px}
.s-queued{background:#2a2f3a}.s-dispatched{background:#1d3557}.s-running{background:#1d4e6b;color:#bfe3ff}
.s-done{background:#143d2c;color:var(--green)}.s-failed{background:#4a1f24;color:var(--red)}
.s-blocked,.s-awaiting_input{background:#4a3a1a;color:var(--amber)}.s-cancelled{background:#333}
form.inline{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap}
input,select,textarea{background:#0d0f13;border:1px solid var(--line);color:var(--fg);padding:7px 10px;border-radius:6px;font-size:13px}
button.act{background:var(--blue);border:none;color:#fff;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px}
button.ghost{background:none;border:1px solid var(--line);color:var(--fg);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px}
button.red{background:var(--red)}
#login{max-width:360px;margin:80px auto;background:var(--panel);border:1px solid var(--line);padding:24px;border-radius:10px}
#login h2{margin:0 0 16px;font-size:16px}#login input{width:100%;margin:6px 0}
.drawer{position:fixed;top:0;right:-620px;width:600px;height:100%;background:var(--panel);border-left:1px solid var(--line);transition:right .15s;overflow-y:auto;padding:16px}
.drawer.open{right:0}.drawer h3{margin-top:0}
.evt{border-left:2px solid var(--line);padding:4px 10px;margin:6px 0;font-size:12px;white-space:pre-wrap;word-break:break-all}
.evt b{color:var(--dim)}.evt.mine{border-color:var(--blue)}
.chat{display:flex;flex-direction:column;gap:10px;margin:10px 0;padding:2px}
.msg{max-width:86%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:#1d4e6b;color:#dff1ff;border-bottom-right-radius:4px}
.msg.ai{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}
.msg.tool{align-self:flex-start;background:#171a12;border:1px dashed #3f4a2b;border-radius:8px;max-width:86%}
.mhead{font-size:11px;color:var(--dim);margin-bottom:4px}
.msg.tool .mbody{font-family:Consolas,monospace;font-size:11px}
.sys{align-self:center;font-size:11px;color:var(--dim);background:#20242e;border-radius:10px;padding:2px 10px;max-width:92%;text-align:center}
.think{margin:0 0 6px;font-size:12px;color:var(--dim)}
.think summary{cursor:pointer;list-style:none}.think summary::before{content:'▸ '}.think[open] summary::before{content:'▾ '}
.msg.typing{display:flex;gap:4px;padding:12px 14px}
.typing span{width:6px;height:6px;border-radius:50%;background:var(--dim);animation:blink 1.2s infinite}
.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
.dim{color:var(--dim)}.mono{font-family:Consolas,monospace;font-size:12px}
.ok{color:var(--green)}.err{color:var(--red)}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#222836;border:1px solid var(--line);padding:8px 16px;border-radius:8px;opacity:0;transition:opacity .2s}
@media(max-width:640px){
  header{gap:10px;padding:9px 12px}header h1{font-size:14px;white-space:nowrap}header .who{display:none}#health{margin-left:auto;font-size:11px;white-space:nowrap}
  nav{overflow-x:auto;padding:0 6px}nav button{flex:0 0 auto;padding:9px 10px}
  main{padding:12px;overflow:hidden}main h3{font-size:15px}
  table{display:block;max-width:100%;overflow-x:auto;white-space:nowrap}th,td{padding:7px 8px}
  form.inline{display:grid;grid-template-columns:1fr;margin:10px 0}form.inline input,form.inline select,form.inline textarea,form.inline button{width:100%!important;min-width:0}
  .drawer{width:100vw;right:-100vw;padding:12px}.drawer.open{right:0}
}
</style></head><body>
<div id="login"><h2>Workflow Core 登录</h2>
<input id="email" placeholder="邮箱" autocomplete="username">
<input id="password" type="password" placeholder="密码" autocomplete="current-password">
<button class="act" style="width:100%;margin-top:10px" id="loginBtn">登录</button></div>
<div id="app" style="display:none">
<header><h1>Workflow Core</h1><span class="dim" id="health"></span><span class="who" id="who"></span><button class="ghost" id="logoutBtn">退出</button></header>
<nav id="tabs"></nav><main id="main"></main></div>
<div class="drawer" id="drawer"></div><div id="toast"></div>
<script>
var TABS=[['overview','概览'],['tasks','任务'],['workers','Workers'],['models','模型'],['knowledge','知识'],['ai','AI 决策']];
var tab='overview',timer=null,selectedTask=null;
function $(s){return document.querySelector(s)}
function toast(m){var t=$('#toast');t.textContent=m;t.style.opacity=1;setTimeout(function(){t.style.opacity=0},1800)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
var evtView='chat';
function partsText(arr){if(!Array.isArray(arr))return '';
  return arr.filter(function(p){return p&&p.type==='text'&&typeof p.text==='string'}).map(function(p){return p.text}).join('')}
function chatUser(text,label){return '<div class="msg user">'+(label?'<div class="mhead">'+esc(label)+'</div>':'')+esc(text)+'</div>'}
function chatAi(text,reasoning){return '<div class="msg ai">'
  +(reasoning?'<details class="think"><summary>思考过程</summary>'+esc(reasoning)+'</details>':'')
  +'<div class="mbody">'+esc(text||'（空回复）')+'</div></div>'}
function chatTool(head,detail){return '<div class="msg tool"><div class="mhead">🔧 '+esc(head)+'</div><div class="mbody">'+esc(detail)+'</div></div>'}
function chatSys(text){return '<div class="sys">'+esc(text)+'</div>'}
function renderChat(events,running){
  var items=[],chunks=0;
  events.forEach(function(e){
    var p=e.payload||{};
    if(e.type==='session_event'){
      var ev=p.event||{},d=ev.data||{},t=ev.type;
      if(t==='assistant/chunk'){chunks+=1;return}
      if(t==='user/message'){
        if(d.source&&d.source.kind==='plugin'){items.push(chatSys('上下文注入 · '+(d.source.plugin||'plugin')));return}
        var ut=partsText(d.content);if(ut)items.push(chatUser(ut));return}
      if(t==='assistant/message'){
        var textParts=[],reasonParts=[];
        ((d.message&&d.message.content)||[]).forEach(function(pt){
          if(pt&&typeof pt.text==='string'){(pt.type==='text'?textParts:reasonParts).push(pt.text)}});
        items.push(chatAi(textParts.join('\\n'),reasonParts.join('\\n')));return}
      if(t==='tool/call'){items.push(chatTool(d.tool||'tool',JSON.stringify(d.args||{}).slice(0,400)));return}
      if(t==='tool/result'){items.push(chatTool('结果',String(typeof d.text==='string'?d.text:JSON.stringify(d)).slice(0,400)));return}
      if(t==='turn/start'){items.push(chatSys('── 第'+(d.turn||'?')+'回合 ──'));return}
      if(t==='turn/end'){items.push(chatSys('回合结束 · '+((d.reason&&d.reason.kind)||'-')));return}
      return}
    if(e.type==='injected'){if(p.content)items.push(chatUser(p.content,'纠正注入 · 我'));return}
    if(e.type==='created'){items.push(chatSys('任务创建 · '+p.type+' · 优先级 '+(p.priority!=null?p.priority:'-')));return}
    if(e.type==='claimed'){items.push(chatSys('已派发给 '+String(p.worker_id||'').replace('machine:','')+' · 第'+(p.attempt||1)+'次尝试'));return}
    if(e.type==='progress'){if(p.note)items.push(chatSys(p.note));return}
    if(e.type==='done'){items.push(chatSys('✔ 任务完成'));return}
    if(e.type==='failed'){items.push(chatSys('任务失败'));return}
    if(e.type==='cancelled'){items.push(chatSys('已取消'));return}
    if(e.type==='dead_letter'){items.push(chatSys('进入死信'));return}
    if(e.type==='lease_expired_requeued'){items.push(chatSys('租约超时，重新排队'));return}
  });
  if(running)items.push('<div class="msg ai typing"><span></span><span></span><span></span></div>');
  if(chunks)items.push(chatSys(chunks+' 条流式片段已折叠进最终回复'));
  return '<div class="chat">'+items.join('')+'</div>'}
async function api(method,path,body){
  var opts={method:method,headers:{'content-type':'application/json'}};
  if(body)opts.body=JSON.stringify(body);
  var r=await fetch(path,opts);
  if(r.status===401){showLogin();throw new Error('未登录')}
  var j=await r.json().catch(function(){return {}});
  if(!r.ok)throw new Error(j.error||r.status);return j}
function showLogin(){$('#login').style.display='block';$('#app').style.display='none';clearInterval(timer)}
async function login(){try{
  await api('POST','/api/v1/auth/login',{email:$('#email').value,password:$('#password').value});
  $('#login').style.display='none';$('#app').style.display='block';init();
}catch(e){toast('登录失败：'+e.message)}}
async function logout(){await api('POST','/api/v1/auth/logout',{}).catch(function(){});showLogin()}
function init(){
  var nav='';TABS.forEach(function(p){nav+='<button data-t="'+p[0]+'">'+p[1]+'</button>'});
  $('#tabs').innerHTML=nav;setTab('overview');
  api('GET','/api/v1/auth/session').then(function(j){$('#who').textContent=j.principal.email}).catch(function(){});
}
function setTab(t){tab=t;selectedTask=null;$('#drawer').classList.remove('open');
  document.querySelectorAll('nav button').forEach(function(b){b.classList.toggle('on',b.dataset.t===t)});
  clearInterval(timer);render();timer=setInterval(render,3000)}
function formDraft(){var values={};document.querySelectorAll('form input,form textarea,form select').forEach(function(el){if(el.id)values[el.id]=el.value});return values}
function restoreDraft(values){Object.keys(values).forEach(function(id){var el=document.getElementById(id);if(el)el.value=values[id]})}
async function render(){var draft=formDraft();try{
  if(tab==='overview')await rOverview();else if(tab==='tasks')await rTasks();
  else if(tab==='workers')await rWorkers();else if(tab==='models')await rModels();
  else if(tab==='knowledge')await rKnowledge();else if(tab==='ai')await rAi();
}catch(e){if(e.message!=='未登录')console.warn(e)}finally{restoreDraft(draft)}}
function badge(s){return '<span class="badge s-'+s+'">'+s+'</span>'}
function table(headers,rows){var h='<table><tr>'+headers.map(function(x){return '<th>'+x+'</th>'}).join('')+'</tr>';
  return h+rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+c+'</td>'}).join('')+'</tr>'}).join('')+'</table>'}
async function rOverview(){
  var h=await api('GET','/api/v1/health');var t=h.checks.tasks||{};var parts=[];
  Object.keys(t).forEach(function(k){parts.push(k+'='+t[k])});
  $('#health').textContent='workers:'+(h.checks.workers_online!=null?h.checks.workers_online:'-')+'/'+(h.checks.workers_connected!=null?h.checks.workers_connected:'-');
  var rows=Object.keys(t).map(function(k){return [badge(k),t[k]]});
  $('#main').innerHTML='<h3>任务状态</h3>'+table(['状态','数量'],rows)+
    '<p class="dim">已启用模型：'+(h.checks.models_enabled!=null?h.checks.models_enabled:'-')+
    '　auth/core 完整性：'+((h.checks.auth&&h.checks.auth.ok&&h.checks.core&&h.checks.core.ok)?'<span class="ok">ok</span>':'<span class="err">异常</span>')+'</p>'}
async function rTasks(){
  var j=await api('GET','/api/v1/tasks?limit=100');
  var rows=j.tasks.map(function(t){return [
    '<a href="javascript:void 0" class="mono" data-task="'+t.task_id+'">'+t.task_id.slice(0,10)+'</a>',
    esc(t.type),badge(t.status),'P'+t.priority,
    '<span class="mono">'+esc((t.claim_worker_id||'-').replace('machine:',''))+'</span>',
    t.attempts+'/'+t.max_attempts,new Date(t.updated_at).toLocaleTimeString()]});
  $('#main').innerHTML='<h3>任务</h3>'+table(['ID','类型','状态','P','worker','尝试','更新'],rows);
  if(selectedTask)refreshDrawer()}
async function openTask(id){selectedTask=id;$('#drawer').classList.add('open');refreshDrawer()}
async function refreshDrawer(){if(!selectedTask)return;
  var draft=$('#injectText')?$('#injectText').value:'';
  var box=$('#drawer');var nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;
  var t=(await api('GET','/api/v1/tasks/'+selectedTask)).task;
  var ev=await api('GET','/api/v1/tasks/'+selectedTask+'/events?limit=2000');
  var ap=null;try{ap=await api('GET','/api/v1/admin/approvals?task_id='+selectedTask)}catch(e){ap=null}
  var active=t.status==='dispatched'||t.status==='running';
  var h='<h3>'+esc(t.type)+' <span class="mono dim">'+t.task_id+'</span> '+badge(t.status)
   +' <button class="ghost" data-evtoggle="1" style="float:right;margin:0">'+(evtView==='chat'?'JSON':'对话')+'视图</button></h3>'
   +'<p class="dim">'+esc((t.brief&&t.brief.goal)||'')+'</p>';
  if(ap&&ap.approvals&&ap.approvals.length){
    ap.approvals.forEach(function(a){
      h+='<div class="msg tool" style="align-self:stretch;max-width:none;border-style:solid;border-color:#5a4a1e;background:#241f10">'
       +'<div class="mhead" style="color:#f5b14c">⚠ 待审批 · '+esc(a.tool||'工具')+'</div>'
       +(a.reason?'<div class="mbody">'+esc(a.reason)+'</div>':'')
       +'<div style="margin-top:8px"><button class="act" data-approve="'+a.approval_id+'">批准</button> '
       +'<button class="act red" data-deny="'+a.approval_id+'">拒绝</button></div></div>';
    });
  }
  if(active)h+='<form class="inline" id="injectForm"><input id="injectText" style="flex:1" placeholder="注入纠正内容到运行中的会话…"><button class="act">发送</button></form>';
  if(active||t.status==='queued')h+='<p><button class="act red" id="cancelBtn">取消任务</button></p>';
  if(evtView==='chat'){
    h+=renderChat(ev.events||[],active);
  }else{
    h+='<h4>事件流</h4>';
    h+=(ev.events||[]).slice().reverse().map(function(e){return '<div class="evt'+(e.type==='injected'?' mine':'')+'"><b>'+e.seq+' '+esc(e.type)+' '+e.ts.slice(11,19)+'</b>\\n'+esc(JSON.stringify(e.payload).slice(0,500))+'</div>'}).join('');
  }
  box.innerHTML=h;
  if(active&&draft&&$('#injectText'))$('#injectText').value=draft;
  if(evtView==='chat'&&(nearBottom||active))box.scrollTop=box.scrollHeight}
async function doInject(text){try{
  await api('POST','/api/v1/tasks/'+selectedTask+'/inject',{content:text});
  var input=$('#injectText');if(input)input.value='';toast('已注入');refreshDrawer()}catch(err){toast(err.message)}}
async function doCancel(){try{await api('POST','/api/v1/tasks/'+selectedTask+'/cancel');toast('已取消');refreshDrawer()}catch(err){toast(err.message)}}
async function rWorkers(){var j=await api('GET','/api/v1/workers');
  var rows=j.workers.map(function(w){return [
    '<span class="mono">'+esc(w.worker_id)+'</span>',esc(w.machine||'-'),
    esc(w.capabilities.join(', ')||'-'),w.max_concurrency,
    w.connected?'<span class="ok">在线</span>':'<span class="err">离线</span>',
    w.last_seen?new Date(w.last_seen).toLocaleTimeString():'-',
    w.last_models_revision!=null?w.last_models_revision:'-']});
  $('#main').innerHTML='<h3>Workers</h3>'+table(['worker','机器','能力','并发','在线','心跳','模型版本'],rows)}
async function rModels(){var j=await api('GET','/api/v1/admin/models');
  var rows=j.models.map(function(m){return [
    '<span class="mono">'+esc(m.provider)+'</span>','<span class="mono">'+esc(m.model)+'</span>','<span class="mono">'+esc(m.base_url)+'</span>','P'+m.priority,
    m.enabled?'<span class="ok">是</span>':'<span class="err">否</span>',
    m.probe_status==='ok'?'<span class="ok">ok</span>':esc(m.probe_status),
    m.probe_latency_ms==null?'-':m.probe_latency_ms+'ms',
    '<span class="mono">'+esc((m.api_key||'').slice(0,8))+'…</span>',
    '<button class="ghost" data-probe="'+m.model_id+'">探测</button> <button class="ghost red" data-delmodel="'+m.model_id+'">删除</button>']});
  $('#main').innerHTML='<h3>模型注册表 <span class="dim">（key 仅此处可见）</span></h3>'+
   table(['Provider','模型','base_url','P','启用','探测','延迟','key','操作'],rows)+
   '<h4>新增模型</h4><form class="inline" id="modelForm">'+
   '<input id="mProvider" placeholder="provider 路由" required><input id="mModel" placeholder="model 名称" required><input id="mKey" placeholder="api_key" required style="width:240px">'+
   '<input id="mUrl" placeholder="https://base-url" required style="width:260px"><input id="mPrio" type="number" min="0" max="9" value="5" style="width:60px">'+
   '<button class="act">添加</button></form>'}
async function rKnowledge(){
  $('#main').innerHTML='<h3>知识库</h3><form class="inline" id="kForm"><input id="kq" style="flex:1" placeholder="检索记忆（FTS）…"><button class="act">搜索</button></form><div id="kres"></div>'}
async function searchMem(q){var j=await api('GET','/api/v1/workflow/memories?q='+encodeURIComponent(q));
  var rows=j.memories.map(function(m){return [esc(m.type),esc(m.title),esc(m.scope+(m.projectId?':'+m.projectId.slice(0,8):'')),
    '<span class="mono">'+esc(m.source)+'</span>',new Date(m.updatedAt).toLocaleDateString()]});
  $('#kres').innerHTML=table(['类型','标题','范围','来源','更新'],rows)+'<p class="dim">'+j.memories.length+' 条结果</p>'}
async function rAi(){var j=await api('GET','/api/v1/admin/decisions?limit=50');
  var rows=j.decisions.map(function(d){return [new Date(d.ts).toLocaleString(),esc(d.topic),
    '<span class="mono">'+esc(JSON.stringify(d.decision).slice(0,160))+'</span>',
    '<span class="mono">'+esc(JSON.stringify(d.applied).slice(0,120))+'</span>',
    d.error?'<span class="err">'+esc(d.error)+'</span>':'-']});
  $('#main').innerHTML='<h3>管理 AI 决策</h3>'+table(['时间','主题','决策','执行','错误'],rows)+
   '<h4>手动提交情境</h4><form class="inline" id="aiForm"><input id="aiTopic" placeholder="主题" style="width:140px"><input id="aiSit" style="flex:1" placeholder="情境描述…"><button class="act">决策</button></form><div id="aiRes"></div>'}
async function askAi(topic,sit){try{var j=await api('POST','/api/v1/admin/ai/decide',{topic:topic,situation:sit});
  $('#aiRes').innerHTML='<pre class="mono">'+esc(JSON.stringify(j,null,2))+'</pre>'}catch(err){toast(err.message)}}
document.addEventListener('click',function(e){
  var el=e.target.closest('[data-task],[data-probe],[data-delmodel],[data-evtoggle],[data-approve],[data-deny],nav button,#cancelBtn,#logoutBtn,#loginBtn');
  if(!el)return;
  if(el.dataset.evtoggle){evtView=evtView==='chat'?'json':'chat';refreshDrawer();return}
  if(el.dataset.approve||el.dataset.deny){
    var id=el.dataset.approve||el.dataset.deny;
    var decision=el.dataset.approve?'approve':'deny';
    api('POST','/api/v1/admin/approvals/'+id+'/resolve',{decision:decision})
      .then(function(){toast(decision==='approve'?'已批准':'已拒绝');refreshDrawer()})
      .catch(function(err){toast(err.message)});return}
  if(el.dataset.task){openTask(el.dataset.task);return}
  if(el.dataset.probe){api('POST','/api/v1/admin/models/'+el.dataset.probe+'/probe').then(function(j){
    toast(j.outcome.ok?'探测成功 '+j.outcome.latencyMs+'ms':'探测失败：'+(j.outcome.error||''));render()}).catch(function(err){toast(err.message)});return}
  if(el.dataset.delmodel){api('DELETE','/api/v1/admin/models/'+el.dataset.delmodel).then(function(){toast('已删除');render()}).catch(function(err){toast(err.message)});return}
  if(el.id==='cancelBtn'){doCancel();return}
  if(el.id==='logoutBtn'){logout();return}
  if(el.id==='loginBtn'){login();return}
  if(el.tagName==='BUTTON'&&el.dataset.t){setTab(el.dataset.t)}});
document.addEventListener('submit',function(e){
  if(e.target.id==='injectForm'){e.preventDefault();var v=$('#injectText').value;if(v)doInject(v);return}
  if(e.target.id==='modelForm'){e.preventDefault();
    api('POST','/api/v1/admin/models',{provider:$('#mProvider').value,model:$('#mModel').value,key:$('#mKey').value,baseUrl:$('#mUrl').value,priority:Number($('#mPrio').value)})
    .then(function(){toast('已添加并推送');render()}).catch(function(err){toast(err.message)});return}
  if(e.target.id==='kForm'){e.preventDefault();searchMem($('#kq').value);return}
  if(e.target.id==='aiForm'){e.preventDefault();askAi($('#aiTopic').value,$('#aiSit').value);return}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){$('#drawer').classList.remove('open');selectedTask=null}});
api('GET','/api/v1/health').then(function(){api('GET','/api/v1/auth/session').then(function(){
  $('#login').style.display='none';$('#app').style.display='block';init()}).catch(function(){})}).catch(function(){});
</script></body></html>`;
