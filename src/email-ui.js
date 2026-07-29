'use strict';
// 企業名からメールアドレスを収集するローカルWeb UI（Node標準httpのみ・依存追加なし）。
//   起動: node src/email-ui.js  → http://localhost:5178 をブラウザで開く
//   環境変数: EMAIL_UI_PORT（既定5178） / EMAIL_UI_OPEN=1 で自動でブラウザを開く
//
// 5000件規模を1時間以内で処理するため、フロントは全企業を1本の POST /api/collect-batch へ送り、
// サーバ側が harvestMany で真の並列（企業ごとに別ホスト）を行い、結果を NDJSON でストリーミング返却する。
// これによりブラウザの「同一ホスト同時接続数(~6)」上限を回避し、進捗バー/実測スループット/ETAを表示する。
// polite.js のホスト別レート制限は保つため、各サイトへの負荷は増えない。
const http = require('http');
const { collectEmailsForCompany, harvestMany, estimateThroughput } = require('./email-harvest');
const { setScrapeDelay } = require('./polite');

// サーバ側の上限（暴走防止）
const MAX_CONCURRENCY = parseInt(process.env.EMAIL_UI_MAX_CONC || '64', 10);
const MIN_DELAY_MS = parseInt(process.env.EMAIL_UI_MIN_DELAY || '300', 10); // 相手サイト保護の下限

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
  return toClient(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8e6) req.destroy(); }); // 5000社+URLでも数百KB
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// 収集結果を UI 向けの軽量オブジェクトへ整形
function toClient(res) {
  return {
    company: res.company, url: res.url || '', domain: res.domain || '', note: res.note || '', best: res.best || '',
    emails: (res.emails || []).map((e) => ({
      email: e.email, role: e.roleLabel, confidence: e.confidence,
      source: e.source === 'guess' ? '推測(MX)' : (e.source === 'mailto' ? 'mailto' : '本文'),
      own: !!e.ownDomain, freemail: !!e.freemail, foundOn: e.foundOn || '',
    })),
  };
}

// ---- 一括収集（サーバ側で真の並列 → NDJSON でストリーミング返却） ----
// ブラウザの「同一ホスト同時接続数(~6)」上限を回避するため、1本のリクエストで結果を逐次流す。
async function handleBatch(req, res, body) {
  const companies = Array.isArray(body.companies) ? body.companies
    .map((c) => ({ company: String(c.company || '').trim(), url: String(c.url || '').trim() }))
    .filter((c) => c.company) : [];
  if (!companies.length) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '企業名がありません' }));
  }
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, parseInt(body.concurrency, 10) || 20));
  const maxPages = Math.max(1, Math.min(10, parseInt(body.maxPages, 10) || 3));
  const delayMs = Math.max(MIN_DELAY_MS, parseInt(body.delayMs, 10) || 1200);
  const staticOnly = body.staticOnly !== false;
  const guess = body.guess !== false;
  const verify = !!body.verify;

  setScrapeDelay(delayMs);
  const prevDisableRender = process.env.DISABLE_RENDER;
  if (staticOnly) process.env.DISABLE_RENDER = '1'; else delete process.env.DISABLE_RENDER;

  let aborted = false;
  req.on('close', () => { aborted = true; });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };

  const est = estimateThroughput({ count: companies.length, concurrency, maxPages, delayMs, discovery: companies.some((c) => !c.url), static: staticOnly });
  write({ type: 'start', total: companies.length, concurrency, maxPages, delayMs, staticOnly, verify, estimate: est });

  let hit = 0;
  try {
    await harvestMany(companies, {
      concurrency, maxPages, guess, verify, render: staticOnly ? 'static' : 'auto',
      isAborted: () => aborted,
      onResult(i, item, result, done) {
        if (result && result.best) hit++;
        write({ type: 'result', i, done, hit, result: toClient(result) });
      },
    });
    write({ type: 'done', hit, aborted });
  } catch (e) {
    write({ type: 'error', error: String(e && e.message || e) });
  } finally {
    if (prevDisableRender === undefined) delete process.env.DISABLE_RENDER; else process.env.DISABLE_RENDER = prevDisableRender;
    res.end();
  }
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
    if (req.method === 'POST' && req.url === '/api/collect-batch') {
      const body = await readBody(req);
      return handleBatch(req, res, body);
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
  .est{ font-size:12.5px; color:#475569; margin-top:12px; background:#f1f5f9; border-radius:8px; padding:8px 12px; }
  .est b{ color:var(--ink); }
  .est.warn{ background:#fef3c7; color:#92400e; } .est.warn b{ color:#7c2d12; }
  .progress{ margin-top:16px; }
  .bar{ height:10px; background:#e2e8f0; border-radius:99px; overflow:hidden; }
  .bar>span{ display:block; height:100%; width:0%; background:linear-gradient(90deg,#2563eb,#16a34a); transition:width .25s; }
  .pmeta{ font-size:12.5px; color:var(--muted); margin-top:7px; font-variant-numeric:tabular-nums; }
  .pmeta b{ color:var(--ink); }
</style>
</head>
<body>
<header>
  <h1>企業メール収集</h1>
  <p>企業名から公式サイトを特定し、公開メール（mailto:／問い合わせ・採用ページ本文）を収集。確度しきい値以上のみを「企業名,メールアドレス」の採用リスト（スプレッドシート）として書き出します。</p>
</header>
<main>
  <div class="card">
    <label for="companies">企業名（1行に1社）</label>
    <textarea id="companies" placeholder="株式会社ネオキャリア
サイボウズ株式会社
freee, https://corp.freee.co.jp"></textarea>
    <div class="hint">既知の公式URL/ドメインがあれば <b>「企業名, https://url」</b> のようにカンマ区切りで付記すると発見を省略して高速化します。</div>
    <div class="row">
      <span class="opt">同時実行数 <input type="number" id="concurrency" value="24" min="1" max="64"></span>
      <span class="opt">最大取得ページ数 <input type="number" id="maxPages" value="3" min="1" max="10"></span>
      <span class="opt">ホスト間隔ms <input type="number" id="delayMs" value="1200" min="300" max="8000" step="100"></span>
      <span class="opt">採用確度しきい値 <input type="number" id="minConf" value="0.7" min="0" max="1" step="0.05"></span>
      <span class="opt"><input type="checkbox" id="staticOnly" checked> 静的取得のみ（高速）</span>
      <span class="opt"><input type="checkbox" id="guess" checked> 役割アドレス推測(info@等)</span>
    </div>
    <div class="est" id="est">—</div>
    <div class="btns">
      <button class="primary" id="run">収集開始</button>
      <button class="ghost" id="stop" disabled>停止</button>
      <button class="ghost" id="csv" disabled>採用リストDL（企業名,メール）</button>
      <button class="ghost" id="csvFull" disabled>詳細CSV</button>
      <button class="ghost" id="clear" disabled>クリア</button>
    </div>
    <div class="progress" id="progressWrap" style="display:none">
      <div class="bar"><span id="bar"></span></div>
      <div class="pmeta" id="pmeta"></div>
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
const $=(s)=>document.querySelector(s);
let results=[];      // 完了順の結果（CSV用）
let running=false, abortCtl=null;
let counters={total:0,done:0,hit:0,t0:0};
let pendingRows=[], flushTimer=null, lastStat=0;

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtDur(sec){ sec=Math.max(0,Math.round(sec)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return (h?h+'時間':'')+((h||m)?m+'分':'')+s+'秒'; }
function badgeClass(role){ if(/採用|人事/.test(role))return'recruit'; if(/問い合わせ|総合/.test(role))return'contact'; if(/営業|取引/.test(role))return'sales'; return''; }

function parseLine(line){
  const parts=line.split(/[,\\t]/).map(s=>s.trim()).filter(Boolean);
  let company='',url='';
  for(const p of parts){
    if(/^https?:\\/\\//i.test(p)||/^[a-z0-9-]+(\\.[a-z0-9-]+)+$/i.test(p)){ if(!url)url=p; }
    else if(!company)company=p;
  }
  if(!company&&parts.length)company=parts[0];
  return {company,url};
}
function readItems(){
  const lines=$('#companies').value.split(/\\n/).map(s=>s.trim()).filter(Boolean);
  return lines.map(parseLine).filter(p=>p.company);
}
function opts(){
  return {
    concurrency:Math.max(1,Math.min(64,+$('#concurrency').value||24)),
    maxPages:Math.max(1,Math.min(10,+$('#maxPages').value||3)),
    delayMs:Math.max(300,+$('#delayMs').value||1200),
    staticOnly:$('#staticOnly').checked,
    guess:$('#guess').checked,
  };
}
function minConf(){ const v=parseFloat($('#minConf').value); return Number.isFinite(v)?Math.max(0,Math.min(1,v)):0.7; }
// 確度しきい値以上の採用1件（emailsはサーバ側で優先度降順済み）。無ければ ''。
function bestQualified(r, thr){ const q=(r.emails||[]).filter(e=>(+e.confidence||0)>=thr); return q.length?q[0].email:''; }
function adoptedCount(){ const thr=minConf(); return results.reduce((n,r)=>n+(bestQualified(r,thr)?1:0),0); }
function estimate(){
  const items=readItems(); const o=opts();
  const discovery=items.some(i=>!i.url);
  const avgFetch=o.staticOnly?1.6:3.2;
  const per=o.maxPages*avgFetch+(o.maxPages-1)*(o.delayMs/1000)+(discovery?2.5:0)+0.3;
  const perMin=60*o.concurrency/per;
  const totalSec=items.length*per/o.concurrency;
  const el=$('#est');
  if(!items.length){ el.textContent='企業名を入力すると推定処理時間を表示します。'; el.className='est'; return; }
  let msg='対象 <b>'+items.length+'</b>社 ｜ 推定 <b>'+Math.round(perMin)+'</b>社/分 ｜ 完了まで約 <b>'+fmtDur(totalSec)+'</b>';
  if(discovery) msg+=' ｜ <span style="color:#b45309">URL未指定あり（検索発見が必要＝遅く/失敗しやすい）</span>';
  el.innerHTML=msg;
  el.className=(items.length>=1000 && perMin<83)?'est warn':'est';
}
document.addEventListener('input', estimate);
document.addEventListener('change', estimate);

function rowHtml(company, url, r){
  let stateHtml,emailHtml='',typeHtml='',confHtml='',urlHtml='';
  if(!r || r.error){ stateHtml='<span class="st err">エラー</span>'; emailHtml='<span class="sub">'+esc(r&&r.error||'失敗')+'</span>'; }
  else{
    const emails=r.emails||[];
    if(emails.length){
      stateHtml='<span class="st ok">'+emails.length+'件</span>';
      emailHtml=emails.map(e=>'<div class="email">'+esc(e.email)+(e.own?'':(e.freemail?' <span class="badge">フリー</span>':' <span class="badge">他社</span>'))+'</div>').join('');
      typeHtml=emails.map(e=>'<span class="badge '+badgeClass(e.role)+'">'+esc(e.role)+'</span>').join('<br>');
      confHtml=emails.map(e=>'<span class="conf">'+esc(e.confidence)+'</span> <span class="sub">'+esc(e.source)+'</span>').join('<br>');
    }else{ stateHtml='<span class="st none">なし</span>'; emailHtml='<span class="sub">'+esc(r.note||'検出なし')+'</span>'; }
    const link=r.url?'<a class="u" href="'+esc(r.url)+'" target="_blank" rel="noopener">'+esc(r.url)+'</a>':'<span class="sub">URL不明</span>';
    const founds=[...new Set((r.emails||[]).map(e=>e.foundOn).filter(Boolean))];
    urlHtml=link+(founds.length?('<div class="sub">'+founds.map(esc).join('<br>')+'</div>'):'');
  }
  return '<tr><td>'+esc(company)+(url?'<div class="sub">'+esc(url)+'</div>':'')+'</td><td>'+stateHtml+'</td><td>'+emailHtml+'</td><td>'+typeHtml+'</td><td>'+confHtml+'</td><td>'+urlHtml+'</td></tr>';
}
function queueRow(html){ pendingRows.push(html); if(!flushTimer) flushTimer=setTimeout(flushRows,120); }
function flushRows(){ flushTimer=null; if(pendingRows.length){ $('#tbody').insertAdjacentHTML('beforeend', pendingRows.join('')); pendingRows=[]; } }
function updateProgress(force){
  const now=Date.now();
  if(!force && now-lastStat<200) return;
  lastStat=now;
  const c=counters, pct=c.total?Math.round(100*c.done/c.total):0;
  $('#bar').style.width=pct+'%';
  const elapsed=(now-c.t0)/1000, rate=c.done/Math.max(0.001,elapsed), eta=(c.total-c.done)/Math.max(0.0001,rate);
  const adopted=adoptedCount();
  $('#pmeta').innerHTML='完了 <b>'+c.done+'</b>/'+c.total+' ('+pct+'%) ｜ 採用(確度'+minConf()+'+) <b>'+adopted+'</b>社 ｜ メール検出 <b>'+c.hit+'</b>社 ｜ 実測 <b>'+Math.round(rate*60)+'</b>社/分 ｜ 経過 '+fmtDur(elapsed)+' ｜ 残り '+(c.done?fmtDur(eta):'—');
  $('#stats').innerHTML='対象 <b>'+c.total+'</b> 社 ｜ 完了 <b>'+c.done+'</b> ｜ 採用 <b>'+adopted+'</b> 社 ｜ メール検出 <b>'+c.hit+'</b> 社';
}

async function runBatch(){
  const items=readItems();
  if(!items.length){ alert('企業名を入力してください'); return; }
  results=[]; counters={total:items.length,done:0,hit:0,t0:Date.now()};
  $('#tbody').innerHTML=''; pendingRows=[];
  $('#progressWrap').style.display='block'; $('#bar').style.width='0%';
  running=true; $('#run').disabled=true; $('#stop').disabled=false; $('#csv').disabled=true; $('#clear').disabled=true;
  updateProgress(true);
  abortCtl=new AbortController();
  const o=opts();
  try{
    const res=await fetch('/api/collect-batch',{ method:'POST', headers:{'Content-Type':'application/json'}, signal:abortCtl.signal,
      body:JSON.stringify({companies:items, concurrency:o.concurrency, maxPages:o.maxPages, delayMs:o.delayMs, staticOnly:o.staticOnly, guess:o.guess}) });
    const reader=res.body.getReader(); const dec=new TextDecoder(); let buf='';
    while(true){
      const {value,done}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      let nl;
      while((nl=buf.indexOf('\\n'))>=0){
        const line=buf.slice(0,nl); buf=buf.slice(nl+1);
        if(line.trim()){ try{ handleMsg(JSON.parse(line)); }catch(_){} }
      }
    }
  }catch(e){
    if(!(e&&e.name==='AbortError')) $('#pmeta').innerHTML+=' ｜ <span style="color:#dc2626">通信エラー: '+esc(String(e))+'</span>';
  }finally{
    flushRows(); updateProgress(true);
    running=false; $('#run').disabled=false; $('#stop').disabled=true;
    $('#csv').disabled=!results.length; $('#csvFull').disabled=!results.length; $('#clear').disabled=false;
  }
}
function handleMsg(msg){
  if(msg.type==='result'){
    const it=msg.result; results.push(it);
    counters.done=msg.done; counters.hit=msg.hit;
    queueRow(rowHtml(it.company, it.url, it));
    updateProgress(false);
  }else if(msg.type==='done'){ updateProgress(true); }
  else if(msg.type==='error'){ $('#pmeta').innerHTML+=' ｜ <span style="color:#dc2626">サーバエラー: '+esc(msg.error||'')+'</span>'; }
}

$('#run').addEventListener('click',()=>{ if(!running) runBatch(); });
$('#stop').addEventListener('click',()=>{ if(abortCtl) abortCtl.abort(); });
$('#clear').addEventListener('click',()=>{ if(running)return; results=[]; counters={total:0,done:0,hit:0,t0:0};
  $('#tbody').innerHTML='<tr><td colspan="6" class="empty">未実行</td></tr>'; $('#progressWrap').style.display='none';
  $('#stats').textContent='結果はここに表示されます。'; $('#csv').disabled=true; $('#csvFull').disabled=true; $('#clear').disabled=true; estimate(); });

function downloadCsv(rows, name){
  const csv='\\ufeff'+rows.map(r=>r.map(c=>{ const s=String(c==null?'':c); return /[",\\n]/.test(s)?('"'+s.replace(/"/g,'""')+'"'):s; }).join(',')).join('\\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; a.click();
}
// 採用リスト: 企業名,メールアドレス（確度しきい値以上・企業ごと最上位1件）
$('#csv').addEventListener('click',()=>{
  const thr=minConf(); const rows=[['企業名','メールアドレス']];
  for(const r of results){ const e=bestQualified(r,thr); if(e) rows.push([r.company, e]); }
  if(rows.length<=1){ alert('確度'+thr+'以上のメールがありません。'); return; }
  downloadCsv(rows, 'company-emails-採用リスト-'+new Date().toISOString().slice(0,10)+'.csv');
});
// 詳細CSV: 全メール・全項目（QA用）
$('#csvFull').addEventListener('click',()=>{
  const rows=[['企業名','公式URL','メール','種別','確度','取得方法','取得元','備考']];
  for(const r of results){
    const emails=(r.emails||[]);
    if(emails.length){ emails.forEach((e,i)=> rows.push([ i===0?r.company:'', i===0?(r.url||''):'', e.email, e.role, e.confidence, e.source, e.foundOn||'', i===0?(r.note||''):'' ])); }
    else{ rows.push([ r.company, r.url||'', '', '', '', '', '', r.note||'検出なし' ]); }
  }
  downloadCsv(rows, 'company-emails-詳細-'+new Date().toISOString().slice(0,10)+'.csv');
});
estimate();
</script>
</body>
</html>`;

module.exports = { server, handleCollect, start };
