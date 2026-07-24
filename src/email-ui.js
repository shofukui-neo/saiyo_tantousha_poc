'use strict';
// 企業名からメールアドレスを収集するローカルWeb UI（Node標準httpのみ・依存追加なし）。
//   起動: node src/email-ui.js  → http://localhost:5178 をブラウザで開く
//   環境変数: EMAIL_UI_PORT（既定5178） / EMAIL_UI_OPEN=1 で自動でブラウザを開く
//
// フロントは企業を1社ずつ POST /api/collect へ送り、結果を逐次テーブルに追記する
// （polite.js のホスト別レート制限を尊重しつつ進捗を可視化する設計）。
const http = require('http');
const { collectEmailsForCompany } = require('./email-harvest');

function argPort() {
  const i = process.argv.indexOf('--port');
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return parseInt(process.env.EMAIL_UI_PORT || '5178', 10);
}
const PORT = argPort();

// ---- 収集ハンドラ（1社分） ----
async function handleCollect(body) {
  const company = String(body.company || '').trim();
  if (!company) return { error: '企業名が空です' };
  const opt = {
    url: String(body.url || '').trim(),
    maxPages: Math.max(1, Math.min(10, parseInt(body.maxPages, 10) || 5)),
    guess: body.guess !== false,
  };
  const res = await collectEmailsForCompany(company, opt);
  return {
    company: res.company,
    url: res.url,
    domain: res.domain,
    note: res.note || '',
    emails: res.emails.map((e) => ({
      email: e.email,
      role: e.roleLabel,
      confidence: e.confidence,
      source: e.source === 'guess' ? '推測(MX)' : (e.source === 'mailto' ? 'mailto' : '本文'),
      own: !!e.ownDomain,
      freemail: !!e.freemail,
      foundOn: e.foundOn || '',
    })),
    best: res.best || '',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && req.url === '/api/collect') {
      const body = await readBody(req);
      let out;
      try { out = await handleCollect(body); }
      catch (e) { out = { error: String(e && e.message || e) }; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server Error: ' + String(e && e.message || e));
  }
});

// ポート使用中(EADDRINUSE)ならクラッシュせず次のポートへ自動フォールバック（最大10回）。
// 試行ごとに前回のリスナーを外す（同一serverの再listenで stale コールバックが溜まるのを防ぐ）。
function start(port = PORT, attemptsLeft = 10) {
  server.removeAllListeners('error');
  server.removeAllListeners('listening');
  server.once('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      if (attemptsLeft > 0) {
        console.log(`  ポート ${port} は使用中のため ${port + 1} を試します…`);
        setTimeout(() => start(port + 1, attemptsLeft - 1), 100);
      } else {
        console.error(`  空きポートが見つかりません。EMAIL_UI_PORT か --port <番号> で指定してください。`);
        process.exit(1);
      }
      return;
    }
    console.error('  サーバ起動エラー:', e && e.message || e);
    process.exit(1);
  });
  server.once('listening', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  企業メール収集 UI 起動: ${url}\n  （停止は Ctrl+C）\n`);
    if (process.env.EMAIL_UI_OPEN === '1') {
      const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      try { require('child_process').exec(cmd); } catch (_) {}
    }
  });
  server.listen(port);
  return server;
}

// 直接実行時のみサーバを起動（require時は起動しない）
if (require.main === module) start();

// ================== フロントエンド（単一HTML・インラインCSS/JS） ==================
const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>企業メール収集</title>
<style>
  :root{ --bg:#0f172a; --panel:#fff; --line:#e2e8f0; --ink:#0f172a; --muted:#64748b;
    --brand:#2563eb; --brand-d:#1d4ed8; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --chip:#f1f5f9; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Meiryo",system-ui,sans-serif;
    color:var(--ink); background:#f8fafc; }
  header{ background:linear-gradient(135deg,#1e3a8a,#2563eb); color:#fff; padding:20px 28px; }
  header h1{ margin:0; font-size:20px; font-weight:700; letter-spacing:.02em; }
  header p{ margin:6px 0 0; font-size:13px; opacity:.85; }
  main{ max-width:1120px; margin:0 auto; padding:24px 20px 60px; }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px;
    box-shadow:0 1px 2px rgba(15,23,42,.04); margin-bottom:20px; }
  label{ font-size:13px; font-weight:600; color:#334155; display:block; margin-bottom:6px; }
  textarea{ width:100%; min-height:130px; resize:vertical; padding:11px 12px; border:1px solid var(--line);
    border-radius:8px; font-size:14px; font-family:inherit; line-height:1.6; }
  .hint{ font-size:12px; color:var(--muted); margin-top:6px; line-height:1.6; }
  .row{ display:flex; gap:18px; align-items:center; flex-wrap:wrap; margin-top:14px; }
  .opt{ display:flex; align-items:center; gap:7px; font-size:13px; color:#334155; }
  .opt input[type=number]{ width:56px; padding:5px 7px; border:1px solid var(--line); border-radius:6px; }
  .btns{ display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
  button{ font:inherit; font-size:14px; font-weight:600; padding:10px 18px; border-radius:8px; border:1px solid transparent;
    cursor:pointer; transition:.15s; }
  button:disabled{ opacity:.5; cursor:default; }
  .primary{ background:var(--brand); color:#fff; }
  .primary:hover:not(:disabled){ background:var(--brand-d); }
  .ghost{ background:#fff; color:#334155; border-color:var(--line); }
  .ghost:hover:not(:disabled){ background:#f8fafc; }
  .stats{ font-size:13px; color:var(--muted); margin:2px 0 14px; }
  .stats b{ color:var(--ink); }
  table{ width:100%; border-collapse:collapse; font-size:13.5px; }
  th,td{ text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th{ font-size:12px; color:var(--muted); font-weight:600; background:#f8fafc; position:sticky; top:0; }
  td.email{ font-family:"Consolas","SFMono-Regular",monospace; }
  .tablewrap{ overflow-x:auto; border:1px solid var(--line); border-radius:10px; }
  .badge{ display:inline-block; font-size:11px; padding:2px 8px; border-radius:99px; background:var(--chip); color:#475569; }
  .badge.recruit{ background:#dcfce7; color:#166534; }
  .badge.contact{ background:#dbeafe; color:#1e40af; }
  .badge.sales{ background:#fef3c7; color:#92400e; }
  .conf{ font-variant-numeric:tabular-nums; }
  .st{ font-size:12px; font-weight:600; }
  .st.run{ color:var(--brand); } .st.ok{ color:var(--ok); } .st.none{ color:var(--warn); } .st.err{ color:var(--bad); }
  .sub{ font-size:11.5px; color:var(--muted); margin-top:2px; }
  .u{ color:var(--brand); text-decoration:none; } .u:hover{ text-decoration:underline; }
  .spin{ display:inline-block; width:12px; height:12px; border:2px solid #c7d2fe; border-top-color:var(--brand);
    border-radius:50%; animation:s .7s linear infinite; vertical-align:-1px; margin-right:5px; }
  @keyframes s{ to{ transform:rotate(360deg); } }
  .empty{ text-align:center; color:var(--muted); padding:34px 10px; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>企業メール収集</h1>
  <p>企業名から公式サイトを特定し、公開されているメールアドレス（mailto:／お問い合わせ・採用ページ本文）を収集します。</p>
</header>
<main>
  <div class="card">
    <label for="companies">企業名（1行に1社）</label>
    <textarea id="companies" placeholder="株式会社ネオキャリア
サイボウズ株式会社
freee, https://corp.freee.co.jp"></textarea>
    <div class="hint">既知の公式URL/ドメインがあれば <b>「企業名, https://url」</b> のようにカンマ区切りで付記すると発見を省略して高速化します。</div>
    <div class="row">
      <span class="opt"><input type="checkbox" id="guess" checked> 実在メールが無ければ役割アドレスを推測（info@等・MX確認）</span>
      <span class="opt">最大取得ページ数 <input type="number" id="maxPages" value="2" min="1" max="10"></span>
      <span class="opt">同時実行数 <input type="number" id="concurrency" value="20" min="1" max="100"></span>
    </div>
    <div class="hint">5000社/1時間を狙うなら、企業名に既知の公式URLを付記し、同時実行数を20前後に設定してください。</div>
    <div class="btns">
      <button class="primary" id="run">収集開始</button>
      <button class="ghost" id="csv" disabled>CSVダウンロード</button>
      <button class="ghost" id="clear" disabled>クリア</button>
    </div>
  </div>

  <div class="card">
    <div class="stats" id="stats">結果はここに表示されます。</div>
    <div class="tablewrap">
      <table>
        <thead><tr>
          <th style="width:20%">企業名</th>
          <th style="width:8%">状態</th>
          <th style="width:26%">メール</th>
          <th style="width:12%">種別</th>
          <th style="width:8%">確度</th>
          <th style="width:26%">公式URL / 取得元</th>
        </tr></thead>
        <tbody id="tbody"><tr><td colspan="6" class="empty">未実行</td></tr></tbody>
      </table>
    </div>
  </div>
</main>
<script>
const $ = (s)=>document.querySelector(s);
let results = [];   // {company,url,domain,note,emails,best}
let running = false;

function parseLine(line){
  const parts = line.split(/[,\\t]/).map(s=>s.trim()).filter(Boolean);
  let company='', url='';
  for(const p of parts){
    if(/^https?:\\/\\//i.test(p) || /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/i.test(p)) { if(!url) url=p; }
    else if(!company) company=p;
  }
  if(!company && parts.length) company=parts[0];
  return { company, url };
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function badgeClass(role){ if(/採用|人事/.test(role))return'recruit'; if(/問い合わせ|総合/.test(role))return'contact'; if(/営業|取引/.test(role))return'sales'; return''; }

function rowHtml(i, item){
  const r = item.result;
  let stateHtml, emailHtml='', typeHtml='', confHtml='', urlHtml='';
  if(item.status==='run'){ stateHtml='<span class="st run"><span class="spin"></span>処理中</span>'; }
  else if(item.status==='err'){ stateHtml='<span class="st err">エラー</span>'; emailHtml='<span class="sub">'+esc(r&&r.error||'失敗')+'</span>'; }
  else if(r){
    const emails = r.emails||[];
    if(emails.length){
      stateHtml='<span class="st ok">'+emails.length+'件</span>';
      emailHtml = emails.map(e=>'<div class="email">'+esc(e.email)+(e.own?'':(e.freemail?' <span class="badge">フリー</span>':' <span class="badge">他社</span>'))+'</div>').join('');
      typeHtml = emails.map(e=>'<span class="badge '+badgeClass(e.role)+'">'+esc(e.role)+'</span>').join('<br>');
      confHtml = emails.map(e=>'<span class="conf">'+esc(e.confidence)+'</span> <span class="sub">'+esc(e.source)+'</span>').join('<br>');
    } else {
      stateHtml='<span class="st none">なし</span>';
      emailHtml='<span class="sub">'+esc(r.note||'検出なし')+'</span>';
    }
    const link = r.url ? '<a class="u" href="'+esc(r.url)+'" target="_blank" rel="noopener">'+esc(r.url)+'</a>' : '<span class="sub">URL不明</span>';
    const founds = [...new Set((r.emails||[]).map(e=>e.foundOn).filter(Boolean))];
    urlHtml = link + (founds.length?('<div class="sub">'+founds.map(esc).join('<br>')+'</div>'):'');
  } else { stateHtml='<span class="st">待機</span>'; }
  return '<tr>'
    + '<td>'+esc(item.company)+(item.url?'<div class="sub">'+esc(item.url)+'</div>':'')+'</td>'
    + '<td>'+stateHtml+'</td>'
    + '<td>'+emailHtml+'</td>'
    + '<td>'+typeHtml+'</td>'
    + '<td>'+confHtml+'</td>'
    + '<td>'+urlHtml+'</td>'
    + '</tr>';
}
function render(){
  const tb = $('#tbody');
  if(!results.length){ tb.innerHTML='<tr><td colspan="6" class="empty">未実行</td></tr>'; return; }
  tb.innerHTML = results.map((it,i)=>rowHtml(i,it)).join('');
  const done = results.filter(r=>r.status==='done').length;
  const withMail = results.filter(r=>r.result&&r.result.emails&&r.result.emails.length).length;
  $('#stats').innerHTML = '対象 <b>'+results.length+'</b> 社 ｜ 完了 <b>'+done+'</b> ｜ メール取得 <b>'+withMail+'</b> 社';
  const hasDone = results.some(r=>r.status==='done');
  $('#csv').disabled = !hasDone; $('#clear').disabled = running || !results.length;
}

async function collectOne(item){
  item.status='run'; render();
  try{
    const res = await fetch('/api/collect',{ method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ company:item.company, url:item.url, guess:$('#guess').checked, maxPages:+$('#maxPages').value }) });
    const data = await res.json();
    item.result = data; item.status = data.error ? 'err' : 'done';
  }catch(e){ item.result={error:String(e)}; item.status='err'; }
  render();
}

async function runQueue(concurrency){
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const current = idx++;
      if (current >= results.length) return;
      await collectOne(results[current]);
    }
  });
  await Promise.all(workers);
}

$('#run').addEventListener('click', async ()=>{
  if(running) return;
  const lines = $('#companies').value.split(/\\n/).map(s=>s.trim()).filter(Boolean);
  const parsed = lines.map(parseLine).filter(p=>p.company);
  if(!parsed.length){ alert('企業名を入力してください'); return; }
  results = parsed.map(p=>({ company:p.company, url:p.url, status:'wait', result:null }));
  const concurrency = Math.max(1, Math.min(100, +$('#concurrency').value || 20));
  running=true; $('#run').disabled=true; render();
  await runQueue(concurrency);
  running=false; $('#run').disabled=false; render();
});

$('#clear').addEventListener('click', ()=>{ if(running)return; results=[]; render(); });

$('#csv').addEventListener('click', ()=>{
  const head = ['企業名','公式URL','メール','種別','確度','取得方法','取得元','備考'];
  const rows = [head];
  for(const it of results){
    const r = it.result||{};
    const emails = (r.emails||[]);
    if(emails.length){
      emails.forEach((e,i)=> rows.push([ i===0?it.company:'', i===0?(r.url||''):'', e.email, e.role, e.confidence, e.source, e.foundOn||'', i===0?(r.note||''):'' ]));
    } else {
      rows.push([ it.company, r.url||'', '', '', '', '', '', r.note|| (it.status==='err'?(r.error||'エラー'):'検出なし') ]);
    }
  }
  const csv = '\\ufeff' + rows.map(r=>r.map(c=>{ const s=String(c==null?'':c); return /[",\\n]/.test(s)?('"'+s.replace(/"/g,'""')+'"'):s; }).join(',')).join('\\n');
  const blob = new Blob([csv],{type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'company-emails-'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
});
</script>
</body>
</html>`;

module.exports = { server, handleCollect, start };
