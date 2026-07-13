/**
 * Web dashboard 单页 HTML —— 内联 CSS + JS，无外部依赖。
 *
 * URL: http://<mac-name>:3940/#token=<xxx>
 * JS 从 location.hash 拿 token，所有后续 API 请求带 Authorization: Bearer 头。
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>multiAgentChat · Dashboard</title>
<style>
  :root{
    --bg:#0e1116; --panel:#181c22; --border:#2a2f38; --muted:#7a8290;
    --text:#e6ebf1; --accent:#4d8cff; --ok:#4caf50; --warn:#f0a020; --err:#e5484d;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Segoe UI,sans-serif;height:100%}
  a{color:var(--accent);text-decoration:none}
  #app{display:flex;flex-direction:column;height:100vh}
  header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--panel);border-bottom:1px solid var(--border);flex-shrink:0}
  header h1{font-size:14px;margin:0;font-weight:600}
  .badge{font-size:11px;padding:2px 6px;border-radius:8px;background:var(--border);color:var(--muted)}
  .badge.ok{background:#1b3a1e;color:#7fd589}
  .badge.err{background:#3a1b1e;color:#f38b8f}
  main{flex:1;overflow:auto;padding:8px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:8px;margin:8px 0;padding:10px}
  .card h2{font-size:12px;margin:0 0 8px;color:var(--muted);font-weight:500;letter-spacing:.05em;text-transform:uppercase}
  .row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)}
  .row:last-child{border-bottom:none}
  .tty{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
  .title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .title strong{color:var(--text);font-weight:500}
  .cwd{font-size:11px;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
  .st-idle{color:var(--muted)}
  .st-busy{color:var(--warn)}
  .st-claude{color:var(--accent)}
  button,input,select,textarea{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:6px 10px}
  button{cursor:pointer}
  button:hover{border-color:var(--accent)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.danger{background:var(--err);border-color:var(--err);color:#fff}
  textarea{width:100%;min-height:60px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:13px}
  .actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .actions button{font-size:12px;padding:4px 8px}
  .log{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);white-space:pre-wrap;max-height:200px;overflow:auto;background:#0a0d12;border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:8px}
  .screenshot{width:100%;border:1px solid var(--border);border-radius:6px;margin-top:8px;max-height:400px;object-fit:contain;background:#000}
  .empty{color:var(--muted);text-align:center;padding:20px 0;font-size:12px}
  #toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--border);padding:8px 14px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:100}
  #toast.show{opacity:1}
  .cmd-input{display:flex;gap:6px;margin-top:8px}
  .cmd-input input{flex:1;font-family:ui-monospace,Menlo,monospace}
  #tab-detail{display:none}
  #tab-detail.open{display:block}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>multiAgentChat</h1>
    <span id="status-badge" class="badge">connecting…</span>
    <span style="flex:1"></span>
    <button id="refresh-btn" title="刷新">↻</button>
  </header>
  <main>
    <div class="card">
      <h2>Tabs</h2>
      <div id="tabs-list"><div class="empty">加载中…</div></div>
    </div>

    <div class="card" id="tab-detail">
      <h2 id="detail-title">Tab 详情</h2>
      <div id="detail-body"></div>
      <div class="cmd-input">
        <input id="cmd-text" placeholder="输入命令 (Enter 发送)"/>
        <button id="cmd-send" class="primary">发送</button>
      </div>
      <div class="actions">
        <button data-action="screen">📸 抓屏</button>
        <button data-action="history">📜 History</button>
        <button data-action="keys-enter">⏎ Enter</button>
        <button data-action="keys-ctrlc" class="danger">⊘ Ctrl-C</button>
      </div>
      <img id="screenshot" class="screenshot" style="display:none"/>
      <div id="detail-log" class="log" style="display:none"></div>
    </div>

    <div class="card">
      <h2>Pending 任务</h2>
      <div id="pending-list"><div class="empty">无</div></div>
    </div>

    <div class="card">
      <h2>Quick Slash Commands</h2>
      <div class="actions">
        <button data-slash="/dashboard">/dashboard</button>
        <button data-slash="/shells">/shells</button>
        <button data-slash="/where">/where</button>
        <button data-slash="/watch on">/watch on</button>
        <button data-slash="/watch off">/watch off</button>
        <button data-slash="/quiet on">/quiet on</button>
        <button data-slash="/quiet off">/quiet off</button>
      </div>
      <div id="slash-out" class="log" style="display:none"></div>
    </div>
  </main>
</div>
<div id="toast"></div>
<script>
const TOKEN = (location.hash.match(/token=([^&]+)/)||[])[1] || (new URLSearchParams(location.search)).get('token') || '';
if (!TOKEN) {
  document.body.innerHTML = '<div style="padding:40px;color:#f38b8f;font-family:monospace">缺 token —— URL 带 <code>#token=xxx</code></div>';
  throw new Error('no token');
}

const HDR = { 'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json' };

function toast(msg, ms=2200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), ms);
}

async function api(method, path, body) {
  const resp = await fetch(path, { method, headers: HDR, body: body ? JSON.stringify(body) : undefined });
  if (!resp.ok) {
    const t = await resp.text().catch(()=>'');
    throw new Error(resp.status + ': ' + t);
  }
  return resp.headers.get('content-type')?.includes('json') ? resp.json() : resp.text();
}

let selectedTty = null;

function statusClass(tab) {
  const proc = (tab.processes||[]).join('/');
  if (/claude/i.test(proc)) return 'st-claude';
  if (tab.busy) return 'st-busy';
  return 'st-idle';
}

function renderTabs(tabs) {
  const list = document.getElementById('tabs-list');
  if (!tabs.length) { list.innerHTML = '<div class="empty">无 Terminal tab</div>'; return; }
  list.innerHTML = '';
  for (const t of tabs) {
    const row = document.createElement('div');
    row.className = 'row';
    const short = t.tty.replace(/^\\/dev\\//,'');
    const st = statusClass(t);
    row.innerHTML =
      '<span class="tty">'+short+'</span>' +
      '<div class="title"><strong>'+(t.title||'(untitled)').replace(/</g,'&lt;').slice(0,60)+'</strong>'+
      (t.cwd?'<div class="cwd">'+t.cwd.replace(/</g,'&lt;')+'</div>':'')+'</div>' +
      '<span class="badge '+st+'">'+(t.busy?'busy':'idle')+'</span>';
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => selectTab(t));
    list.appendChild(row);
  }
}

function selectTab(t) {
  selectedTty = t.tty;
  const short = t.tty.replace(/^\\/dev\\//,'');
  document.getElementById('detail-title').textContent = '▶ ' + short + '  ' + (t.cwd||'');
  document.getElementById('tab-detail').classList.add('open');
  document.getElementById('screenshot').style.display = 'none';
  document.getElementById('detail-log').style.display = 'none';
  toast('选中 ' + short);
}

async function refreshTabs() {
  try {
    const data = await api('GET','/api/tabs');
    renderTabs(data.tabs || []);
    document.getElementById('status-badge').textContent = 'ok · ' + (data.tabs?.length||0) + ' tabs';
    document.getElementById('status-badge').className = 'badge ok';
  } catch(e) {
    document.getElementById('status-badge').textContent = 'err: ' + e.message.slice(0,40);
    document.getElementById('status-badge').className = 'badge err';
  }
}

async function refreshPending() {
  try {
    const data = await api('GET','/api/pending');
    const el = document.getElementById('pending-list');
    if (!data.pending?.length) { el.innerHTML = '<div class="empty">无</div>'; return; }
    el.innerHTML = data.pending.map(p =>
      '<div class="row"><span class="tty">'+p.tty.replace(/^\\/dev\\//,'')+'</span>'+
      '<div class="title">'+(p.taskDescription||'').slice(0,80).replace(/</g,'&lt;')+'</div>'+
      '<span class="badge">'+ Math.floor((Date.now()-p.sentAt)/1000) +'s</span></div>'
    ).join('');
  } catch(e) { /* ignore */ }
}

document.getElementById('refresh-btn').addEventListener('click', () => { refreshTabs(); refreshPending(); });

document.getElementById('cmd-send').addEventListener('click', sendCmd);
document.getElementById('cmd-text').addEventListener('keydown', e => { if (e.key === 'Enter') sendCmd(); });

async function sendCmd() {
  if (!selectedTty) { toast('先选一个 tab'); return; }
  const text = document.getElementById('cmd-text').value.trim();
  if (!text) return;
  try {
    await api('POST','/api/send',{tty:selectedTty,text});
    document.getElementById('cmd-text').value = '';
    toast('已发送');
  } catch(e) { toast('失败: '+e.message); }
}

document.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!selectedTty) { toast('先选一个 tab'); return; }
    const a = btn.dataset.action;
    try {
      if (a === 'screen') {
        toast('抓屏中…');
        const data = await api('POST','/api/screen',{tty:selectedTty});
        const img = document.getElementById('screenshot');
        img.src = data.dataUrl;
        img.style.display = 'block';
      } else if (a === 'history') {
        const data = await api('GET','/api/history?tty='+encodeURIComponent(selectedTty)+'&lines=60');
        const log = document.getElementById('detail-log');
        log.textContent = data.text || '(空)';
        log.style.display = 'block';
      } else if (a === 'keys-enter') {
        await api('POST','/api/keys',{tty:selectedTty,sequence:'⏎'});
        toast('已发 Enter');
      } else if (a === 'keys-ctrlc') {
        await api('POST','/api/keys',{tty:selectedTty,sequence:'ctrl+c'});
        toast('已发 Ctrl-C');
      }
    } catch(e) { toast(a+' 失败: '+e.message); }
  });
});

document.querySelectorAll('[data-slash]').forEach(btn => {
  btn.addEventListener('click', async () => {
    try {
      const slash = btn.dataset.slash;
      const data = await api('POST','/api/exec',{text:slash});
      const out = document.getElementById('slash-out');
      out.textContent = data.text || JSON.stringify(data);
      out.style.display = 'block';
    } catch(e) { toast('exec 失败: '+e.message); }
  });
});

// SSE：实时推送 pending 变化
try {
  const es = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
  es.addEventListener('pending', () => refreshPending());
  es.addEventListener('tabs', () => refreshTabs());
} catch(e) { /* fallback: poll */ }

// 兜底轮询（5s 一次）
setInterval(() => { refreshTabs(); refreshPending(); }, 5000);

// 初始加载
refreshTabs();
refreshPending();
</script>
</body>
</html>`;
