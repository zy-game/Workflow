// console.js - single-file admin console served at /admin. Vanilla JS over
// the same JSON APIs; cookie session auth; polls the active tab every 3s.
// Layout: left navigation tree, right detail area. The overview tab is
// card-based (running tasks, online workers, Core status). The embedded
// script deliberately avoids nested template literals and inline handlers
// with string arguments - event delegation keeps it parse-safe.
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workflow Core 控制台</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#252a35;--fg:#dfe4ee;--dim:#8b93a7;--blue:#5b9cff;--green:#3ecf8e;--red:#ff6b6b;--amber:#f5b14c}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0}header .who{margin-left:auto;color:var(--dim);font-size:12px}
.layout{display:flex;min-height:calc(100vh - 49px)}
aside{width:190px;flex:0 0 auto;border-right:1px solid var(--line);padding:10px 8px;background:#12151a}
aside .tgroup{font-size:11px;color:var(--dim);padding:10px 10px 4px;letter-spacing:.08em;margin-top:6px}
aside button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--dim);padding:8px 10px;border-radius:6px;cursor:pointer;font-size:14px;margin:2px 0}
aside button:hover{background:#1c212b;color:var(--fg)}
aside button.on{background:#27324a;color:var(--fg);font-weight:600}
main{flex:1;padding:16px;max-width:1100px;margin:0 auto;min-width:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .chead{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.card .chead .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.card.clickable{cursor:pointer}
.card.clickable:hover{border-color:var(--blue);background:#1a2030}
.card .meta{font-size:12px;color:var(--dim);margin-top:6px;word-break:break-all}
.cTitle{font-size:12px;color:var(--dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em}
.big{font-size:30px;font-weight:650;line-height:1.1}
.big small{font-size:13px;color:var(--dim);font-weight:400;margin-left:6px}
.crow{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #1e232d;font-size:13px}
.crow:last-child{border-bottom:none}
.crow .mono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{background:#20242e;border:1px solid var(--line);border-radius:8px;padding:2px 8px;font-size:12px}
.chip b{font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dim)}
.dot.ok{background:var(--green)}.dot.bad{background:var(--red)}.dot.warn{background:var(--amber)}
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
.drawer{position:fixed;top:0;right:-620px;width:600px;height:100%;background:var(--panel);border-left:1px solid var(--line);transition:right .15s;overflow-y:auto;padding:16px;z-index:5;display:flex;flex-direction:column}
.drawer.open{right:0}.drawer h3{margin-top:0}
.drawer .drawerScroll{flex:1;overflow-y:auto;padding-right:4px}
#injectForm{position:sticky;bottom:-16px;background:var(--panel);box-shadow:0 -10px 18px -12px rgba(0,0,0,.55);margin:12px -4px -8px 0;padding:10px 4px 4px 0;display:flex;gap:8px;align-items:center}
#injectForm input{flex:1;border-radius:16px;padding:9px 14px}
#injectForm button{flex:0 0 auto;border-radius:16px}
.evt{border-left:2px solid var(--line);padding:4px 10px;margin:6px 0;font-size:12px;white-space:pre-wrap;word-break:break-all}
.evt b{color:var(--dim)}.evt.mine{border-color:var(--blue)}
.chat{display:flex;flex-direction:column;gap:10px;margin:10px 0;padding:2px}
.msg{max-width:86%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:#1d4e6b;color:#dff1ff;border-bottom-right-radius:4px}
.msg.ai{align-self:flex-start;background:#1b1f28;border:1px solid var(--line);border-bottom-left-radius:4px}
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
.modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:8;display:flex;align-items:center;justify-content:center}
.modalBox{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;width:min(560px,92vw);max-height:86vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.modalBox .chead{display:flex;align-items:center;gap:8px}
.modalBox .chead .name{flex:1;font-weight:600}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#222836;border:1px solid var(--line);padding:8px 16px;border-radius:8px;opacity:0;transition:opacity .2s;z-index:6}
@media(max-width:640px){
  header{gap:10px;padding:9px 12px}header h1{font-size:14px;white-space:nowrap}header .who{display:none}#health{margin-left:auto;font-size:11px;white-space:nowrap}
  .layout{flex-direction:column}
  aside{width:100%;border-right:none;border-bottom:1px solid var(--line);padding:6px;display:flex;flex-wrap:wrap;gap:2px}
  aside .tgroup{display:none}
  aside button{width:auto;padding:6px 10px;margin:0}
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
<div class="layout"><aside id="tree"></aside><main id="main"></main></div></div>
<div class="drawer" id="drawer"></div><div id="modal" class="modal" style="display:none"><div class="modalBox"><div class="chead"><span class="name">新建技能</span><button class="ghost" id="modalClose">×</button></div><div class="row" style="display:flex;gap:6px;margin:10px 0"><button class="act" data-mtab="custom">自定义新建</button><button class="ghost" data-mtab="upload">上传文件</button><button class="ghost" data-mtab="git">从 Git 安装</button></div><div id="mPanelCustom"><form class="inline" id="mCustomForm"><input id="mName" placeholder="技能名（字母数字._-）" required><button class="act">保存</button></form><textarea id="mContent" placeholder="Markdown 内容，可留空（保存后创建骨架）" style="width:100%;min-height:220px;font-family:Consolas,monospace"></textarea></div><div id="mPanelUpload" style="display:none"><div class="meta dim" style="margin-bottom:8px">选择技能文件夹（内部须有 SKILL.md）或单个 .md 文件</div><div class="row" style="display:flex;gap:8px"><input type="file" id="mFile" accept=".md,.markdown,.txt"><button class="ghost" id="mFolderBtn">选择文件夹…</button><input type="file" id="mFolder" webkitdirectory style="display:none"></div></div><div id="mPanelGit" style="display:none"><form class="inline" id="mGitForm"><input id="mGitUrl" style="flex:2" placeholder="https://.../repo.git" required><input id="mGitName" placeholder="技能名（可选）"><button class="act">安装</button></form></div><div class="error" id="mErr"></div></div></div><div id="memModal" class="modal" style="display:none"><div class="modalBox"><div class="chead"><span class="name" id="memTitle"></span><button class="ghost" id="memClose">×</button></div><div id="memBody" style="margin-top:8px"></div></div></div>
<div id="toast"></div>
<script>
var TREE=[['overview','总览'],['projects','项目'],['tasks','任务'],['workers','Workers'],['devices','设备授权'],['credentials','凭据'],['skills','技能'],['settings','服务器设置'],['ai','智能建议'],['knowledge','知识库']];
var tab='overview',timer=null,selectedTask=null,currentProject=null;
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
      var ev=p.event||p,d=ev.data||{},t=ev.type;
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
var mTab='custom';
function openModal(){mTab='custom';setMtab('custom');$('#modal').style.display='flex';$('#mErr').textContent='';
  $('#mName').value='';$('#mContent').value='';$('#mGitUrl').value='';$('#mGitName').value='';$('#mFile').value='';
  setTimeout(function(){$('#mName').focus()},50)}
function closeModal(){$('#modal').style.display='none'}
function setMtab(t){mTab=t;['custom','upload','git'].forEach(function(k){$('#mPanel'+k[0].toUpperCase()+k.slice(1)).style.display=k===t?'block':'none'});
  document.querySelectorAll('[data-mtab]').forEach(function(b){b.classList.toggle('act',b.dataset.mtab===t);b.classList.toggle('ghost',b.dataset.mtab!==t)})}
function mErr(msg){$('#mErr').textContent=msg||''}
function bindModal(){
  $('#modalClose').onclick=function(){closeModal()};
  $('#modal').addEventListener('click',function(e){if(e.target===$('#modal'))closeModal()});
  document.querySelectorAll('[data-mtab]').forEach(function(b){b.onclick=function(){setMtab(b.dataset.mtab)}});
  $('#mCustomForm').onsubmit=async function(e){e.preventDefault();
    var name=$('#mName').value.trim();if(!name){mErr('技能名必填');return}
    var content=$('#mContent').value||'';if(!content.trim())content='# '+name+'\\n\\n（待编辑）\\n';
    try{await api('PUT','/api/v1/skills/'+encodeURIComponent(name),{content:content});toast('已创建 '+name);closeModal();selectedSkill=name;render()}catch(err){mErr(err.message)}};
  $('#mFile').addEventListener('change',function(){var f=$('#mFile').files&&$('#mFile').files[0];if(!f)return;
    var name=f.name.replace(/.(md|markdown|txt)$/i,'');if(!name)name='skill';
    var reader=new FileReader();reader.onload=async function(){
      try{await api('PUT','/api/v1/skills/'+encodeURIComponent(name),{content:String(reader.result||'')});toast('已上传 '+name);closeModal();selectedSkill=name;render()}catch(err){mErr(err.message)}};reader.readAsText(f)});
  $('#mFolderBtn').addEventListener('click',function(){$('#mFolder').click()});
  $('#mFolder').addEventListener('change',async function(){
    var files=Array.from($('#mFolder').files||[]);if(!files.length)return;
    var dirName=files[0].webkitRelativePath.split('/')[0]||'skill';if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dirName))dirName='skill';
    var payload={name:dirName,files:[]};
    for(var i=0;i<files.length;i++){var f=files[i];if(f.size>512*1024){mErr(f.name+' 超过 512KB，已忽略');continue}
      payload.files.push({path:f.webkitRelativePath,content:String(await f.text())});}
    try{var r=await api('POST','/api/v1/skills/upload-folder',payload);toast('已导入文件夹技能 '+r.skill.name+' v'+r.skill.version);closeModal();selectedSkill=r.skill.name;render()}
    catch(err){mErr(err.message)}
  });
  $('#mGitForm').onsubmit=async function(e){e.preventDefault();
    var body={url:$('#mGitUrl').value.trim()};if($('#mGitName').value.trim())body.name=$('#mGitName').value.trim();
    try{var r=await api('POST','/api/v1/skills/install-git',body);toast('已安装 '+r.skill.name+' v'+r.skill.version);closeModal();selectedSkill=r.skill.name;render()}catch(err){mErr(err.message)}};
  $('#memClose').onclick=function(){closeMem()};
  $('#memModal').addEventListener('click',function(e){if(e.target===$('#memModal'))closeMem()});
}
function init(){
  var tree='';TREE.forEach(function(item){
    tree+='<button data-t="'+item[0]+'">'+esc(item[1])+'</button>'});
  $('#tree').innerHTML=tree;setTab('overview');
  api('GET','/api/v1/auth/session').then(function(j){$('#who').textContent=j.principal.email}).catch(function(){});
  bindModal();
}
function setTab(t){tab=t;currentProject=null;selectedTask=null;$('#drawer').classList.remove('open');
  document.querySelectorAll('aside button').forEach(function(b){b.classList.toggle('on',b.dataset.t===t)});
  clearInterval(timer);render();timer=setInterval(function(){
    if(tab==='skills'&&selectedSkill)return;                    /* 技能详情/编辑：静态内容，不轮询 */
    var a=document.activeElement;if(a&&['INPUT','SELECT','TEXTAREA'].indexOf(a.tagName)>=0)return;
    var ta=document.querySelector('textarea');if(ta&&ta.scrollHeight>ta.clientHeight+8)return; /* 长文本滚动中 */
    render()},3000)}
function formDraft(){var values={};document.querySelectorAll('form input,form textarea,form select').forEach(function(el){if(el.id)values[el.id]=el.value});return values}
function restoreDraft(values){Object.keys(values).forEach(function(id){var el=document.getElementById(id);if(el)el.value=values[id]})}
async function render(){var draft=formDraft();var scrollTop=document.documentElement.scrollTop;try{
  if(tab==='overview')await rOverview();else if(tab==='projects')await (currentProject?rProjectDetail(currentProject):rProjects());else if(tab==='tasks')await rTasks();
  else if(tab==='workers')await (selectedWorker?rWorkerDetail(selectedWorker):rWorkers());
  else if(tab==='devices')await rDevices();
  else if(tab==='credentials')await rCredentialsPage();
  else if(tab==='skills')await (selectedSkill==='__new__'?rSkillNew():selectedSkill?rSkillDetail(selectedSkill):rSkillsPage());
  else if(tab==='settings')await rSettingsPage();
  else if(tab==='ai')await rAiSuggestions();
  else if(tab==='knowledge')await rKnowledge();
}catch(e){if(e.message!=='未登录')console.warn(e)}finally{restoreDraft(draft);document.documentElement.scrollTop=scrollTop}}
var selectedWorker=null;
var selectedSkill=null;
function badge(s){return '<span class="badge s-'+s+'">'+s+'</span>'}
function table(headers,rows){var h='<table><tr>'+headers.map(function(x){return '<th>'+x+'</th>'}).join('')+'</tr>';
  return h+rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+c+'</td>'}).join('')+'</tr>'}).join('')+'</table>'}
function card(title,body){return '<div class="card"><div class="cTitle">'+esc(title)+'</div>'+body+'</div>'}
function emptyLine(text){return '<div class="dim" style="padding:6px 0">'+esc(text)+'</div>'}
function gridOf(items,cardFn){if(!items.length)return emptyLine('暂无数据');return '<div class="cards">'+items.map(cardFn).join('')+'</div>'}
function workerBridgeMeta(w,activeClaims){
  var protocol=w.bridge_protocol_version==null?'-':'v'+w.bridge_protocol_version;
  return '<div class="meta">传输 '+esc(w.transport||'websocket')+' · Bridge 协议 '+esc(protocol)+' · 活跃领取 '+Number(activeClaims||0)+'</div>'
    +'<div class="meta dim">最近拉取 '+esc(w.last_pull_at?new Date(w.last_pull_at).toLocaleString():'-')+'</div>'}
function taskCard(t){
  return '<div class="card clickable" data-task="'+t.task_id+'">'
    +'<div class="chead"><span class="name">'+esc(t.type)+'</span>'+badge(t.status)+'</div>'
    +'<div class="mono">'+esc(t.task_id.slice(0,10))+'</div>'
    +'<div class="meta">项目 '+esc((t.project_id||'-').slice(0,14))+' · P'+t.priority+' · 执行端 '+esc((t.claim_worker_id||'-').replace('machine:',''))+' · 尝试 '+t.attempts+'/'+t.max_attempts+'</div>'
    +'<div class="meta dim">'+new Date(t.updated_at).toLocaleTimeString()+'</div></div>'}
function workerCard(w){
  return '<div class="card">'
    +'<div class="chead"><span class="dot '+(w.connected?'ok':'bad')+'"></span><span class="name mono">'+esc(w.worker_id)+'</span>'+(w.connected?'<span class="ok" style="font-size:12px">在线</span>':'<span class="err" style="font-size:12px">离线</span>')+'</div>'
    +'<div class="meta">机器 '+esc(w.machine||'-')+' · 状态 '+esc(w.state||'-')+' · 并发 '+w.max_concurrency+'</div>'
    +'<div class="chips">'+(w.capabilities||[]).map(function(c){return '<span class="chip">'+esc(c)+'</span>'}).join('')+'</div>'
    +'<div class="meta">项目 '+esc((w.projects||[]).join(', '))+' · Backends '+esc((w.backends||[]).map(function(b){return b.kind}).join(', '))+'</div>'
    +'<div class="meta dim">心跳 '+esc(w.last_seen?new Date(w.last_seen).toLocaleString():'-')+'</div></div>'}
function memoryCard(m){
  return '<div class="card" data-mem="'+esc(m.id)+'" style="cursor:pointer"><div class="chead"><span class="name">'+esc(m.title||'-')+'</span><span class="chip">'+esc(m.type)+'</span></div>'
    +'<div class="meta">'+esc(m.scope+(m.projectId?':'+m.projectId.slice(0,8):''))+' · '+esc(m.source)+' · '+new Date(m.updatedAt).toLocaleDateString()+'</div></div>'}
function mdEscapeInline(t){
  var codes=[];var src=t.replace(/\`([^\`]+)\`/g,function(m,c){codes.push(c);return '@@WFC'+(codes.length-1)+'@@'});
  src=src.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  src=src.replace(/__([^_]+)__/g,'<strong>$1</strong>');
  src=src.replace(/(^|[\\s(\\[])\\*([^*\\n]+)\\*/g,'$1<em>$2</em>');
  src=src.replace(/~~([^~]+)~~/g,'<del>$1</del>');
  src=src.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,function(m,txt,url){return /^https?:\\/\\//i.test(url)?'<a href="'+url+'" target="_blank" rel="noopener nofollow">'+txt+'</a>':txt});
  return src.replace(/@@WFC(\\d+)@@/g,function(_,i){return '<code>'+codes[Number(i)]+'</code>'});
}
function mdToHtml(text){
  var lines=String(text==null?'':text).split('\\n');var out=[];var listTag=null;var inCode=false;var codeBuf=[];
  function closeList(){if(listTag){out.push('</'+listTag+'>');listTag=null}}
  for(var i=0;i<lines.length;i++){var line=lines[i];
    if(line.trim().startsWith('\`\`\`')){closeList();if(inCode){out.push('<pre><code>'+esc(codeBuf.join('\\n'))+'</code></pre>');codeBuf=[];inCode=false}else{inCode=true}continue}
    if(inCode){codeBuf.push(line);continue}
    if(!line.trim()){closeList();continue}
    var h=line.match(/^(#{1,6})\s+(.*)$/);if(h){closeList();var n=h[1].length;out.push('<h'+n+'>'+mdEscapeInline(esc(h[2]))+'</h'+n+'>');continue}
    var ul=line.match(/^[-*]\s+(.*)$/);if(ul){if(listTag!=='ul'){closeList();out.push('<ul>');listTag='ul'}out.push('<li>'+mdEscapeInline(esc(ul[1]))+'</li>');continue}
    var ol=line.match(/^\d+[.)]\s+(.*)$/);if(ol){if(listTag!=='ol'){closeList();out.push('<ol>');listTag='ol'}out.push('<li>'+mdEscapeInline(esc(ol[1]))+'</li>');continue}
    if(line.trim().startsWith('>')){closeList();out.push('<blockquote>'+mdEscapeInline(esc(line.trim().replace(/^>\s?/,'')))+'</blockquote>');continue}
    if(/^\s*[-*_]+\s*$/.test(line)){closeList();out.push('<hr>');continue}
    closeList();out.push('<p>'+mdEscapeInline(esc(line))+'</p>');}
  closeList();if(inCode)out.push('<pre><code>'+esc(codeBuf.join('\\n'))+'</code></pre>');
  return out.join('\\n');}
var MEM_MD_STYLE='<style>.markdown{line-height:1.6;color:var(--text);word-break:break-word}.markdown h1,.markdown h2,.markdown h3{margin:10px 0 6px;line-height:1.3}.markdown h4,.markdown h5,.markdown h6{margin:8px 0 4px}.markdown p{margin:6px 0}.markdown ul,.markdown ol{margin:6px 0;padding-left:22px}.markdown li{margin:2px 0}.markdown code{background:var(--line);padding:1px 4px;border-radius:3px;font-family:Consolas,monospace;font-size:.92em}.markdown pre{background:var(--line);padding:10px;border-radius:6px;overflow-x:auto;margin:8px 0}.markdown pre code{background:none;padding:0}.markdown blockquote{border-left:3px solid var(--line);margin:6px 0;padding-left:10px;color:var(--text)}.markdown a{color:#4a9eff}.markdown hr{border:none;border-top:1px solid var(--line);margin:12px 0}</style>';
function memoryDetailHtml(m){
  var tags=(m.tags||[]).map(function(t){return '<span class="chip">'+esc(t)+'</span>'}).join('');
  var kw=(m.keywords||[]).map(function(t){return '<span class="chip">'+esc(t)+'</span>'}).join('');
  var scope=m.scope==='project'?('<span class="chip">项目 '+esc(m.projectId||'-')+'</span>'):'<span class="chip">全局</span>';
  return MEM_MD_STYLE+'<div style="margin:4px 0"><span class="chip">'+esc(m.type)+'</span>'+scope+'<span class="chip">'+new Date(m.updatedAt).toLocaleString()+'</span></div>'
    +(tags?('<div class="meta" style="margin-top:6px">标签：'+tags+'</div>'):'')
    +(kw?('<div class="meta">关键词：'+kw+'</div>'):'')
    +'<div class="meta">来源：'+esc(m.source||'-')+'</div>'
    +'<div class="meta">状态：'+esc(m.status||'active')+'</div>'
    +'<div class="markdown">'+mdToHtml(m.body||'')+'</div>'}
async function openMemory(id){
  var j=await api('GET','/api/v1/workflow/memories/'+encodeURIComponent(id));var m=j.memory;
  if(!m){toast('未找到该知识点');return}
  $('#memTitle').textContent=m.title||'(无标题)';$('#memBody').innerHTML=memoryDetailHtml(m);$('#memModal').style.display='flex'}
function closeMem(){$('#memModal').style.display='none'}
async function rOverview(){
  var h=await api('GET','/api/v1/health');var c=h.checks||{};var t=c.tasks||{};
  var activeKeys=['dispatched','running','awaiting_input'];
  var activeCount=activeKeys.reduce(function(s,k){return s+(Number(t[k])||0)},0);
  var count=function(k){return Number(t[k])||0};
  $('#health').textContent='workers:'+(c.workers_online!=null?c.workers_online:'-')+'/'+(c.workers_connected!=null?c.workers_connected:'-');
  var all=await api('GET','/api/v1/tasks?limit=100');
  var active=(all.tasks||[]).filter(function(x){return activeKeys.indexOf(x.status)>=0}).slice(0,6);
  var w=await api('GET','/api/v1/workers');
  var online=(w.workers||[]).filter(function(x){return x.connected&&x.fresh});
  // Core 状态卡
  var coreOk=(c.auth&&c.auth.ok&&c.core&&c.core.ok);
  var feishu=c.feishu||{};
  var coreBody='<div class="big">'+coreOk?'<span class="ok">● 正常</span>':'<span class="err">● 异常</span>'
    +'<small>auth v'+(c.auth&&c.auth.version||'-')+' · core v'+(c.core&&c.core.version||'-')+'</small></div>'
    +'<div class="crow"><span class="dot '+(feishu.state==='connected'?'ok':'warn')+'"></span><span>Feishu</span><span class="dim">'+esc(feishu.state||'-')+(feishu.connected_at?' · '+new Date(feishu.connected_at).toLocaleString():'')+'</span></div>'
    +'<div class="crow"><span class="dot ok"></span><span>db 完整性</span><span class="dim">'+(h.integrity&&h.integrity.ok?'ok':'n/a')+'</span></div>';
  // 运行中任务卡
  var activeBody=active.length?active.map(function(x){
    return '<div class="crow"><span class="mono"><a href="javascript:void 0" class="mono" data-task="'+x.task_id+'">'+esc(x.task_id.slice(0,10))+'</a> '+badge(x.status)+'</span><span class="dim">'+esc((x.claim_worker_id||'-').replace('machine:',''))+'</span></div>'}).join('')+('<div class="dim" style="margin-top:6px;font-size:12px">共 '+activeCount+' 个进行中任务 · 查看全部 → 任务</div>'):emptyLine('当前无进行中的任务');
  // Worker 卡
  var workerBody=online.length?online.map(function(x){
    return '<div class="crow"><span class="dot ok"></span><span class="mono">'+esc(x.worker_id)+'</span><span class="dim">'+(x.projects.length?'项目 '+(x.projects.length):'未登记项目')+' · '+esc(x.state||'running')+'</span></div>'}).join('')+('<div class="dim" style="margin-top:6px;font-size:12px">在线 '+online.length+'/'+(w.workers||[]).length+' · 查看全部 → Workers</div>')
    :emptyLine('没有 Worker 在线');
  // 状态分布卡
  var distKeys=['queued','dispatched','running','awaiting_input','done','failed','cancelled','blocked'];
  var distBody='<div class="chips">'+distKeys.map(function(k){
    var n=count(k);return '<span class="chip">'+badge(k)+' <b>'+n+'</b></span>'}).join('')+'</div>';
  var statsBody='<div class="big">'+activeCount+'<small>进行中</small></div>'
    +'<div class="crow"><span>已完成</span><span class="mono">'+count('done')+'</span></div>'
    +'<div class="crow"><span>失败</span><span class="mono">'+count('failed')+'</span></div>';
  $('#main').innerHTML='<h3>总览</h3><div class="cards">'
    +card('Core 运行状态',coreBody)
    +card('进行中的任务',activeBody)
    +card('在线 Workers',workerBody)
    +card('任务状态分布',distBody)
    +card('统计',statsBody)
    +'</div>'}
async function rProjects(){
  var p=await api('GET','/api/v1/workflow/projects');var a=await api('GET','/api/v1/project-agents');var w=await api('GET','/api/v1/workers');
  var agents={};(a.agents||[]).forEach(function(x){agents[x.project_id]=x});
  var data=await Promise.all((p.projects||[]).map(async function(x){var ag=agents[x.id];var ts=await api('GET','/api/v1/tasks?project_id='+encodeURIComponent(x.id)+'&limit=500');var counts={};(ts.tasks||[]).forEach(function(t){counts[t.status]=(counts[t.status]||0)+1});var available=(w.workers||[]).filter(function(worker){return worker.connected&&worker.fresh&&((worker.projects||[]).includes('*')||(worker.projects||[]).includes(x.id))});return {x:x,ag:ag,counts:counts,available:available.length}}));
  var cards=data.map(function(item){
    return '<div class="card clickable" data-project="'+esc(item.x.id)+'">'
      +'<div class="chead"><span class="name">'+esc(item.x.name||item.x.id.slice(0,12))+'</span><span class="mono">'+esc(item.x.id.slice(0,12))+'</span></div>'
      +'<div class="meta">'+(item.ag?esc(item.ag.name)+' · '+badge(item.ag.status):'<span class="dim">未创建 Agent</span>')+'</div>'
      +'<div class="meta">可用 Worker：'+item.available+'</div>'
      +'<div class="chips">'+Object.keys(item.counts).map(function(k){return '<span class="chip">'+badge(k)+' <b>'+item.counts[k]+'</b></span>'}).join('')+'</div>'
      +'<div class="meta dim">'+esc(item.x.goal||'').slice(0,90)+'</div></div>'}).join('');
  $('#main').innerHTML='<h3>项目</h3>'+(data.length?'<div class="cards">'+cards+'</div>':emptyLine('暂无项目'))+
    '<p class="dim">Worker 按 project scope、backend 描述和能力声明参与任务派发；点击卡片打开项目详情。</p>'}
async function rTasks(){
  var j=await api('GET','/api/v1/tasks?limit=100');
  $('#main').innerHTML='<h3>任务</h3>'+gridOf(j.tasks||[],taskCard);
  if(selectedTask)refreshDrawer()}
async function rProjectDetail(id){
  currentProject=id;
  var p=(await api('GET','/api/v1/workflow/projects/'+encodeURIComponent(id))).project;
  var ags=await api('GET','/api/v1/project-agents?project_id='+encodeURIComponent(id));
  var ws=await api('GET','/api/v1/workers');
  var ts=await api('GET','/api/v1/tasks?project_id='+encodeURIComponent(id)+'&limit=500');
  var ag=(ags.agents||[])[0];
  var available=(ws.workers||[]).filter(function(w){return (w.projects||[]).includes('*')||(w.projects||[]).includes(id)});
  var meta='<div class="card"><div class="chead"><span class="name">'+esc(p.name||id)+'</span><span class="mono">'+esc(id)+'</span></div>'
    +'<div class="meta">'+esc(p.goal||'')+'</div>'
    +'<div class="meta">Project Agent：'+(ag?esc(ag.name)+' · '+badge(ag.status):'未创建')+'　可用 Worker：'+available.length+'</div></div>';
  $('#main').innerHTML='<button class="ghost" id="backProjects">返回项目</button><h3>项目详情</h3>'+meta+'<h4>任务</h4>'+gridOf(ts.tasks||[],taskCard);
}
async function openTask(id){selectedTask=id;$('#drawer').classList.add('open');refreshDrawer()}
async function refreshDrawer(){if(!selectedTask)return;
  var draft=$('#injectText')?$('#injectText').value:'';
  var box=$('#drawer');var nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;
  var t=(await api('GET','/api/v1/tasks/'+selectedTask)).task;
  var ev=await api('GET','/api/v1/tasks/'+selectedTask+'/events?limit=2000');
  var ix=null;try{ix=await api('GET','/api/v1/interactions?task_id='+selectedTask+'&status=pending')}catch(e){ix=null}
  var active=t.status==='dispatched'||t.status==='running'||t.status==='awaiting_input';
  var h='<h3>'+esc(t.type)+' <span class="mono dim">'+t.task_id+'</span> '+badge(t.status)
   +' <button class="ghost" data-evtoggle="1" style="float:right;margin:0">'+(evtView==='chat'?'JSON':'对话')+'视图</button></h3>'
   +'<p class="dim">'+esc((t.brief&&t.brief.goal)||'')+'</p>'
   +'<p class="dim mono">项目 '+esc(t.project_id||'-')+' · Agent '+esc(t.agent_id||'-')+' · Backend '+esc(t.backend_kind||t.requested_backend_kind||'-')+' · Worker '+esc(t.claim_worker_id||'-')+' · session '+esc(t.session_ref||'-')+'</p>';
  if(ix&&ix.interactions&&ix.interactions.length){
    ix.interactions.forEach(function(interaction){
      if(interaction.kind==='credential'||interaction.kind==='file_select'){
        h+='<div class="msg tool" style="align-self:stretch;max-width:none"><div class="mhead">需在 Worker 本机处理 '+esc(interaction.kind)+'</div></div>';return}
      var qs=(interaction.schema&&interaction.schema.questions)||[];
      h+='<div class="msg tool" style="align-self:stretch;max-width:none;border-style:solid;border-color:#5a4a1e;background:#241f10">'
       +'<div class="mhead" style="color:#f5b14c">'+(interaction.kind==='approval'?'待审批':'待回答')+'</div>';
      qs.forEach(function(q){h+='<div class="mbody">'+esc(q.prompt||q.label||q.title||q.id)+'</div>';
        (q.options||[]).forEach(function(o){h+=' <button class="act" data-interaction="'+esc(interaction.interaction_id)+'" data-question="'+esc(q.id)+'" data-option="'+esc(o.id)+'">'+esc(o.label||o.id)+'</button>'})});
      h+='</div>';
    });
  }
  var injectHint=active?'发送后即时注入运行中的会话':'任务已结束，注入仅对进行中任务生效';
  var injectFormHtml='<form id="injectForm"><input id="injectText" placeholder="'+esc(injectHint)+'" autocomplete="off"><button class="act" type="submit">发送</button></form>';
  var cancelHtml=(active||t.status==='queued')?'<p><button class="act red" id="cancelBtn">取消任务</button></p>':'';
  if(evtView==='chat'){
    h+=renderChat(ev.events||[],active);
  }else{
    h+='<h4>事件流</h4>';
    h+=(ev.events||[]).slice().reverse().map(function(e){return '<div class="evt'+(e.type==='injected'?' mine':'')+'"><b>'+e.seq+' '+esc(e.type)+' '+e.ts.slice(11,19)+'</b>\\n'+esc(JSON.stringify(e.payload).slice(0,500))+'</div>'}).join('');
  }
  box.innerHTML='<div class="drawerScroll">'+h+'</div>'+injectFormHtml+cancelHtml;
  var scroll=box.querySelector('.drawerScroll');
  if(active&&draft&&$('#injectText'))$('#injectText').value=draft;
  if(evtView==='chat'&&(nearBottom||active)&&scroll)scroll.scrollTop=scroll.scrollHeight}
async function doInject(text){try{
  var t=(await api('GET','/api/v1/tasks/'+selectedTask)).task;
  var active=t.status==='dispatched'||t.status==='running'||t.status==='awaiting_input';
  if(!active){toast('任务已结束，无法注入');return}
  await api('POST','/api/v1/tasks/'+selectedTask+'/inject',{content:text});
  var input=$('#injectText');if(input)input.value='';toast('已注入');refreshDrawer()}catch(err){toast(err.message)}}
async function doCancel(){try{await api('POST','/api/v1/tasks/'+selectedTask+'/cancel');toast('已取消');refreshDrawer()}catch(err){toast(err.message)}}
async function rWorkers(){var j=await api('GET','/api/v1/workers');
  var tasks=(await api('GET','/api/v1/tasks?limit=500')).tasks||[];
  var activeStatuses=['dispatched','running','awaiting_input'];var claims={};
  tasks.forEach(function(t){if(t.claim_worker_id&&activeStatuses.indexOf(t.status)>=0)claims[t.claim_worker_id]=(claims[t.claim_worker_id]||0)+1});
  $('#main').innerHTML='<h3>Workers</h3>'+gridOf(j.workers||[],function(w){
    return '<div class="card clickable" data-worker="'+esc(w.worker_id)+'">'
      +'<div class="chead"><span class="dot '+(w.connected?'ok':'bad')+'"></span><span class="name mono">'+esc(w.worker_id)+'</span>'+(w.revoked?'<span class="err" style="font-size:12px">已停用</span>':(w.connected?'<span class="ok" style="font-size:12px">在线</span>':'<span class="err" style="font-size:12px">离线</span>'))+'</div>'
      +'<div class="meta">机器 '+esc(w.machine||'-')+' · 状态 '+esc(w.state||'-')+' · 并发 '+w.max_concurrency+'</div>'
      +workerBridgeMeta(w,claims[w.worker_id])
      +'<div class="chips">'+(w.capabilities||[]).map(function(c){return '<span class="chip">'+esc(c)+'</span>'}).join('')+'</div>'
      +'<div class="meta">项目 '+esc((w.projects||[]).join(', '))+' · Backends '+esc((w.backends||[]).map(function(b){return b.kind}).join(', '))+'</div>'
      +'<div class="meta dim">心跳 '+esc(w.last_seen?new Date(w.last_seen).toLocaleString():'-')+'</div></div>'})}

async function rWorkerDetail(id){
  selectedWorker=id;
  var w=(await api('GET','/api/v1/workers')).workers.filter(function(x){return x.worker_id===id})[0];
  if(!w){selectedWorker=null;return rWorkers()}
  var cfg=(await api('GET','/api/v1/workers/'+encodeURIComponent(id)+'/config')).config||{};
  var creds=(await api('GET','/api/v1/credentials?worker_id='+encodeURIComponent(id))).credentials||[];
  var tasks=(await api('GET','/api/v1/tasks?limit=500')).tasks||[];
  var activeClaims=tasks.filter(function(t){return t.claim_worker_id===id&&['dispatched','running','awaiting_input'].indexOf(t.status)>=0});
  $('#main').innerHTML='<button class="ghost" id="backWorkers">返回 Workers</button><h3>Worker · '+esc(id)+'</h3>'
    +'<div class="cards"><div class="card"><div class="cTitle">运行状态</div>'
    +'<div class="chead"><span class="dot '+(w.connected?'ok':'bad')+'"></span><span class="name">'+esc(w.state||'-')+'</span>'+(w.revoked?'<span class="err">已停用</span>':(w.connected?'<span class="ok">在线</span>':'<span class="err">离线</span>'))+'</div>'
    +workerBridgeMeta(w,activeClaims.length)
    +'<div class="meta dim">心跳 '+esc(w.last_seen?new Date(w.last_seen).toLocaleString():'-')+'</div>'
    +(activeClaims.length?'<div class="chips">'+activeClaims.map(function(t){return '<span class="chip mono">'+esc(t.task_id.slice(0,10))+' · '+esc(t.status)+'</span>'}).join('')+'</div>':'')+'</div>'
    +'<div class="card"><div class="cTitle">服务器侧配置（下次心跳生效）</div>'
    +'<form id="cfgForm"><input class="wide" id="cfgProjects" placeholder="projects（JSON：[{&quot;projectId&quot;:&quot;x&quot;,&quot;root&quot;:&quot;C:/dir&quot;}]）" style="width:100%">'
    +'<input class="wide" id="cfgBackends" placeholder="backends（JSON 数组：[{kind,command,args}]）" style="width:100%;margin-top:6px">'
    +'<input class="wide" id="cfgCapabilities" placeholder="capabilities（逗号分隔）" style="width:100%;margin-top:6px">'
    +'<button class="act" style="margin-top:8px">保存配置</button></form><div class="error" id="cfgErr"></div></div>'
    +'<div class="card"><div class="cTitle">已分配凭据</div>'+(creds.length?creds.map(function(c){return '<div class="crow"><span class="mono">'+esc(c.name)+'</span><span class="dim">'+esc(c.kind)+(c.reference?' · '+esc(c.reference):'')+'</span></div>'}).join(''):emptyLine('未分配'))+'</div>'
    +'<div class="card"><div class="cTitle">操作</div><div class="row" style="display:flex;gap:8px">'
    +'<button class="act red" id="revokeBtn">卸载 / 停用</button>'
    +'<button class="ghost" id="unrevokeBtn">重新启用</button></div></div></div>'
    +'<div id="cfgDraft" style="display:none"></div>';
  $('#cfgProjects').value=JSON.stringify(w.serverConfig&&w.serverConfig.projects||[]);
  $('#cfgBackends').value=JSON.stringify(w.serverConfig&&w.serverConfig.backends||[]);
  $('#cfgCapabilities').value=(w.capabilities||[]).join(', ');
  $('#cfgForm').onsubmit=async function(e){e.preventDefault();
    try{
      var projects=JSON.parse($('#cfgProjects').value||'[]');
      var backends=JSON.parse($('#cfgBackends').value||'[]');
      await api('PUT','/api/v1/workers/'+encodeURIComponent(id)+'/config',{projects:projects,backends:backends,capabilities:$('#cfgCapabilities').value.split(',').map(function(x){return x.trim()}).filter(Boolean)});
      toast('配置已保存');render();
    }catch(err){$('#cfgErr').textContent=err.message}
  };
  $('#revokeBtn').onclick=async function(){ if(confirm('确认停止并卸载 Worker '+id+'？Worker 将删除本机计划任务并退出。')){ await api('POST','/api/v1/workers/'+encodeURIComponent(id)+'/revoke',{reason:'removed by admin'}); toast('已发起停用'); render(); } };
  $('#unrevokeBtn').onclick=async function(){ await api('POST','/api/v1/workers/'+encodeURIComponent(id)+'/unrevoke',{}); toast('已重新启用'); render(); };
}
async function rDevices(){
  var en=(await api('GET','/api/v1/enrollments')).enrollments||[];
  var label={pending:'等待授权',authorized:'已批准·待领取',consumed:'已授权',revoked:'已撤销'};
  var cards=en.map(function(e){
    var action='';
    if(e.status==='pending') action='<button class="act" data-approve-dev="'+esc(e.workerId||e.code)+'" style="margin-top:8px">批准授权</button>';
    else if(e.status!=='consumed') action='<button class="act red" data-revoke-code="'+esc(e.code)+'" style="margin-top:8px">撤销</button>';
    return '<div class="card"><div class="chead"><span class="name mono">'+esc(e.workerId||e.code)+'</span><span class="chip">'+esc(label[e.status]||e.status)+'</span></div>'
      +'<div class="meta">机器 '+esc(e.machine||'-')+' · 指纹 '+esc(e.fingerprint||'-')+(e.approvedAt?' · 批准 '+new Date(e.approvedAt).toLocaleString():'')+'</div>'+action+'</div>'})
    .join('');
  $('#main').innerHTML='<h3>设备授权</h3>'
    +'<div class="meta dim" style="margin-bottom:10px">开启一台新 Worker 时它会自动在此登记为「等待授权」，点「批准授权」即可放行；已授权的设备之后无需再次确认。</div>'
    +(en.length?'<div class="cards">'+cards+'</div>':emptyLine('暂无设备请求'))
    +'<div id="codeBox" class="card" style="display:none;margin-top:12px"><div class="cTitle">新授权码（兼容模式）</div><div class="meta mono" id="codeText"></div></div>';
  document.querySelectorAll('[data-approve-dev]').forEach(function(b){b.onclick=async function(){
    try{await api('POST','/api/v1/devices/'+encodeURIComponent(b.dataset.approveDev)+'/approve',{});toast('已授权 '+b.dataset.approveDev);render()}catch(err){toast(err.message)}
  }});
  document.querySelectorAll('[data-revoke-code]').forEach(function(b){b.onclick=async function(){ await api('POST','/api/v1/enrollments/revoke',{code:b.dataset.revokeCode}); toast('已撤销'); render(); }});
}
async function rSkillNew(){
  $('#main').innerHTML=
    '<h3>新建技能</h3>'
    +'<form class="inline" id="newSkillForm"><input id="nskName" placeholder="技能名（字母数字._-）" required><button class="act">保存</button></form>'
    +'<textarea id="nskContent" placeholder="Markdown 内容，可留空（保存后创建骨架）" style="width:100%;min-height:300px;font-family:Consolas,monospace"></textarea>'
    +'<button class="ghost" id="cancelNewSkill" style="margin-top:8px">返回</button><div class="error" id="nskErr"></div>';
  $('#newSkillForm').onsubmit=async function(e){e.preventDefault();
    var name=$('#nskName').value.trim();
    if(!name){$('#nskErr').textContent='技能名必填';return}
    var content=$('#nskContent').value||'';
    if(!content.trim())content='# '+name+'\\n\\n（待编辑）\\n';
    try{await api('PUT','/api/v1/skills/'+encodeURIComponent(name),{content:content});toast('已创建 '+name);selectedSkill=name;render()}
    catch(err){$('#nskErr').textContent=err.message}
  };
  $('#cancelNewSkill').onclick=function(){selectedSkill=null;setTab('skills')};
}
async function rSkillsPage(){
  var list=(await api('GET','/api/v1/skills')).skills||[];
  $('#main').innerHTML='<h3>技能</h3>'
    +'<div class="row" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><button class="act" id="newSkillBtn">新建技能</button><span class="dim">技能保存后即时下发给所有在线 Worker（~/.agents/workflow/skills/）</span></div>'
    +'<div class="cards">'+list.map(function(s){return '<div class="card clickable" data-skill="'+esc(s.name)+'"><div class="chead"><span class="name">'+esc(s.name)+'</span><span class="chip">v'+s.version+'</span></div>'
      +'<div class="meta dim">更新 '+new Date(s.updatedAt).toLocaleString()+'</div></div>'}).join('')||emptyLine('暂无技能')+'</div>'
    +'<section><h3>从 Git 安装</h3><form class="inline" id="gitSkipForm"><input id="gitUrl" style="flex:2" placeholder="https://.../repo.git" required><input id="gitName" placeholder="技能名（可选，默认仓库名）"><button class="act">安装</button></form><div class="error" id="gitSkipErr"></div></section>'
    +'<section id="skillEditor" style="display:none"><h3>新建 / 上传技能</h3><form class="inline"><input id="skName" placeholder="技能名（如 review-python）" required><button class="act" id="skSave">保存</button><input id="skContent" style="flex:2" placeholder="或粘贴 Markdown 内容（也可先保存再在详情编辑）"></form></section>';
  $('#newSkillBtn').onclick=function(){ openModal(); };
  $('#skSave').onclick=async function(){
    var name=$('#skName').value.trim();
    if(!name){$('#gitSkipErr').textContent='技能名必填';return}
    var content=($('#skContent').value||'')+'';
    if(!content.trim())content='# '+name+'\\n\\n（待编辑）\\n';
    await api('PUT','/api/v1/skills/'+encodeURIComponent(name),{content:content});
    toast('已创建'); selectedSkill=name; render();
  };
  $('#gitSkipForm').onsubmit=async function(e){e.preventDefault();
    try{
      var body={url:$('#gitUrl').value.trim()};
      if($('#gitName').value.trim())body.name=$('#gitName').value.trim();
      var r=await api('POST','/api/v1/skills/install-git',body);
      toast('已安装 '+r.skill.name+' v'+r.skill.version); selectedSkill=r.skill.name; render();
    }catch(err){$('#gitSkipErr').textContent=err.message}
  };
}
async function rSkillDetail(name){
  selectedSkill=name;
  var r=await api('GET','/api/v1/skills/'+encodeURIComponent(name));
  var s=r.skill;
  $('#main').innerHTML='<button class="ghost" id="backSkills">返回技能</button><h3>技能 · '+esc(s.name)+' <span class="chip">v'+s.version+'</span></h3>'
    +'<div class="meta dim">更新 '+new Date(s.updatedAt).toLocaleString()+' · 保存后推送所有在线 Worker</div>'
    +'<textarea id="skEdit" style="width:100%;min-height:320px;font-family:Consolas,monospace">'+esc(s.content)+'</textarea>'
    +'<div class="row" style="display:flex;gap:8px;margin-top:10px"><button class="act" id="skUpdate">保存并分发</button><button class="act red" id="skDelete">删除</button></div><div class="error" id="skErr"></div>';
  $('#skUpdate').onclick=async function(){
    try{await api('PUT','/api/v1/skills/'+encodeURIComponent(name),{content:$('#skEdit').value});toast('已保存并推送');render()}catch(err){$('#skErr').textContent=err.message}
  };
  $('#skDelete').onclick=async function(){
    if(confirm('删除技能 '+name+'？')){await api('DELETE','/api/v1/skills/'+encodeURIComponent(name));toast('已删除');selectedSkill=null;setTab('skills')}
  };
}
async function rCredentialsPage(){
  var creds=(await api('GET','/api/v1/credentials')).credentials||[];
  $('#main').innerHTML='<h3>全局凭据</h3><div class="meta dim" style="margin-bottom:8px">值以 AES-256-GCM 加密存储于服务器；分配 worker_id 后随 config 帧下发给对应 Worker（本地 DPAPI 再保护），列表永不回显明文。</div>'
    +'<div class="cards">'+creds.map(function(c){return '<div class="card"><div class="chead"><span class="name">'+esc(c.name)+'</span><span class="chip">'+esc(c.kind)+'</span></div>'
      +'<div class="meta">ID <span class="mono">'+esc(c.credentialId)+'</span> · 分配至 '+(c.workerId?'<span class="mono">'+esc(c.workerId)+'</span>':'未分配（全局）')+(c.reference?' · 引用 '+esc(c.reference):'')+'</div>'
      +'<button class="act red" data-del-cred="'+esc(c.credentialId)+'" style="margin-top:8px">删除</button></div>'}).join('')||emptyLine('暂无凭据')+'</div>'
    +'<section><h3>新增凭据</h3><form class="inline" id="credForm"><input id="cId" placeholder="credentialId" required><input id="cName" placeholder="名称">'
    +'<input id="cWorker" placeholder="worker_id（留空=全局）"><input id="cValue" type="password" placeholder="机密值">'
    +'<input id="cReference" placeholder="外部引用（如 systemd://name）"><button class="act">保存</button></form></section>';
  $('#credForm').onsubmit=async function(e){e.preventDefault();
    var body={credentialId:$('#cId').value,name:$('#cName').value};
    if($('#cWorker').value)body.worker_id=$('#cWorker').value;
    if($('#cValue').value)body.value=$('#cValue').value;
    if($('#cReference').value)body.reference=$('#cReference').value;
    await api('POST','/api/v1/credentials',body); toast('已保存'); render();
  };
  document.querySelectorAll('[data-del-cred]').forEach(function(b){b.onclick=async function(){ await api('DELETE','/api/v1/credentials/'+encodeURIComponent(b.dataset.delCred)); toast('已删除'); render(); }});
}
async function rSettingsPage(){
  var st=(await api('GET','/api/v1/settings')).settings;
  var llm=st.llm||{};
  $('#main').innerHTML='<h3>服务器设置</h3><div class="card"><div class="cTitle">Workflow LLM（服务器层）</div>'
    +'<div class="meta dim" style="margin-bottom:8px">管理服务器全局事务：任务完成后自动将会话提炼为项目知识点写入知识库。密钥仅在服务器凭据库中加密保存，永不回显。</div>'
    +'<form id="llmForm"><label><input type="checkbox" id="llmEnabled"'+(llm.enabled?' checked':'')+'> 启用</label>'
    +'<input id="llmBase" placeholder="Base URL，如 https://api.deepseek.com/v1" value="'+esc(llm.baseUrl||'')+'" style="width:100%">'
    +'<input id="llmModel" placeholder="模型名，如 deepseek/deepseek-v4-flash-vision-exp" value="'+esc(llm.model||'')+'" style="width:100%;margin-top:6px">'
    +'<input id="llmKey" type="password" placeholder="'+(llm.apiKeyConfigured?'API Key 已配置（留空则不修改）':'API Key（保存后加密存储，不会回显）')+'" style="width:100%;margin-top:6px">'
    +'<button class="act" style="margin-top:8px">保存设置</button><div class="error" id="llmErr"></div></form></div>';
  $('#llmForm').onsubmit=async function(e){e.preventDefault();
    try{
      var body={llm:{enabled:$('#llmEnabled').checked,baseUrl:$('#llmBase').value.trim(),model:$('#llmModel').value.trim()}};
      if($('#llmKey').value.trim())body.llm.apiKey=$('#llmKey').value.trim();
      await api('PUT','/api/v1/settings',body);toast('设置已保存并即时生效');render();
    }catch(err){$('#llmErr').textContent=err.message}
  };
}

async function rAiSuggestions(){
  var j=await api('GET','/api/v1/ai/suggestions');
  var items=j.suggestions||[];
  var label={skill:'技能',knowledge:'知识',settings:'设置',rule:'规则'};
  var cards=items.map(function(x){
    var action='';
    if(x.status==='pending')action='<button class="act" data-ai-ok="'+esc(x.suggestionId)+'" style="margin-right:6px">采纳</button><button class="ghost" data-ai-no="'+esc(x.suggestionId)+'">忽略</button>';
    return '<div class="card"><div class="chead"><span class="name">'+esc(x.title)+'</span><span class="chip">'+esc(label[x.targetType]||x.targetType)+'</span><span class="chip">'+esc(x.status)+'</span></div>'
      +'<div class="meta">'+esc(x.summary||'')+'</div>'
      +'<div class="meta dim">'+(x.status==='approved'?'已应用：'+esc(x.reason||''):'')+(x.resolvedAt?' · '+new Date(x.resolvedAt).toLocaleString():'')+'</div>'
      +'<div style="margin-top:8px">'+action+'</div></div>'}).join('');
  $('#main').innerHTML='<h3>智能建议</h3>'
    +'<div class="row" style="display:flex;gap:8px;margin-bottom:10px"><button class="act" id="aiCheckup">立即体检</button><span class="dim">AI 生成改进建议；采纳后才生效（意见→技能/知识/设置/规则），并用采纳效果回喂下一轮</span></div>'
    +(items.length?'<div class="cards">'+cards+'</div>':emptyLine('暂无建议'));
  $('#aiCheckup').onclick=async function(){
    var r=await api('POST','/api/v1/ai/checkup',{});
    if(!r.ok){toast(r.reason||'体检未运行');return}
    toast('生成了 '+r.generated+' 条建议');render();
  };
  document.querySelectorAll('[data-ai-ok]').forEach(function(b){b.onclick=async function(){
    try{await api('POST','/api/v1/ai/suggestions/'+encodeURIComponent(b.dataset.aiOk)+'/approve',{});toast('已采纳并应用');render()}catch(err){toast(err.message)}
  }});
  document.querySelectorAll('[data-ai-no]').forEach(function(b){b.onclick=async function(){
    await api('POST','/api/v1/ai/suggestions/'+encodeURIComponent(b.dataset.aiNo)+'/ignore',{});toast('已忽略');render();
  }});
}

async function rKnowledge(){
  $('#main').innerHTML='<h3>知识库</h3><form class="inline" id="kForm"><input id="kq" style="flex:1" placeholder="检索记忆，留空显示全部…"><button class="act">搜索</button></form><div id="kres"></div>'
  searchMem($('#kq').value)}
async function searchMem(q){var j=await api('GET','/api/v1/workflow/memories?q='+encodeURIComponent(q));
  $('#kres').innerHTML=gridOf(j.memories||[],memoryCard)+(q.trim()?'<p class="dim">'+j.memories.length+' 条结果</p>':'')}
document.addEventListener('click',function(e){
  // Click outside the task drawer closes it (unless hitting another opener).
  var drawer=$('#drawer');
  if(drawer.classList.contains('open')&&!e.target.closest('#drawer')&&!e.target.closest('[data-task],[data-project],[data-worker],[data-mem],aside button')){
    drawer.classList.remove('open');selectedTask=null;selectedWorker=null;return}
  var el=e.target.closest('[data-task],[data-project],[data-worker],[data-mem],[data-skill],[data-evtoggle],[data-interaction],aside button,#backProjects,#backSkills,#backWorkers,#cancelBtn,#logoutBtn,#loginBtn');
  if(!el)return;
  if(el.dataset.evtoggle){evtView=evtView==='chat'?'json':'chat';refreshDrawer();return}
  if(el.dataset.interaction){
    api('POST','/api/v1/interactions/'+el.dataset.interaction+'/respond',{response_id:'admin-'+el.dataset.interaction+'-'+el.dataset.question+'-'+el.dataset.option,answers:Object.fromEntries([[el.dataset.question,el.dataset.option]])})
      .then(function(){toast('已回答');refreshDrawer()})
      .catch(function(err){toast(err.message)});return}
  if(el.dataset.mem){openMemory(el.dataset.mem).catch(function(err){toast(err.message)});return}
  if(el.dataset.task){openTask(el.dataset.task);return}
  if(el.dataset.skill){selectedSkill=el.dataset.skill;render();return}
  if(el.dataset.worker){selectedWorker=el.dataset.worker;render();return}
  if(el.dataset.project){rProjectDetail(el.dataset.project).catch(function(err){toast(err.message)});return}
  if(el.id==='backSkills'){selectedSkill=null;setTab('skills');return}
  if(el.id==='backWorkers'){selectedWorker=null;setTab('workers');return}
  if(el.id==='backProjects'){setTab('projects');return}
  if(el.id==='cancelBtn'){doCancel();return}
  if(el.id==='logoutBtn'){logout();return}
  if(el.id==='loginBtn'){login();return}
  if(el.tagName==='BUTTON'&&el.dataset.t){setTab(el.dataset.t)}});
document.addEventListener('submit',function(e){
  if(e.target.id==='injectForm'){e.preventDefault();var v=$('#injectText').value;if(v)doInject(v);return}
  if(e.target.id==='kForm'){e.preventDefault();searchMem($('#kq').value);return}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){$('#drawer').classList.remove('open');$('#memModal').style.display='none';selectedTask=null}});
api('GET','/api/v1/health').then(function(){api('GET','/api/v1/auth/session').then(function(){
  $('#login').style.display='none';$('#app').style.display='block';init()}).catch(function(){})}).catch(function(){});
</script></body></html>`;
