'use strict';
/**
 * telapo-ui — テレアポ分析システム（架電録音・架電分析の運用画面）
 * =====================================================================
 * ローカルWeb UI（Node標準httpのみ・依存追加なし。email-ui.js と同じ流儀）。
 *   起動: node src/telapo-ui.js  → http://localhost:5179 をbrowザで開く
 *   環境変数: TELAPO_UI_PORT（既定5179） / TELAPO_UI_OPEN=1 で自動起動
 *
 * ■ 中核（運用フロー）
 *   1. 架電録音 : ブラウザのマイクで通話を録音（MediaRecorder）、または既存音声を
 *                 アップロード → data/recordings/ へ保存。
 *   2. 架電分析 : 文字起こし（手入力）＋コール結果から、規則ベース（talk-analysis.js）で
 *                 断り理由・アポ獲得トーク要素をライブ判定。
 *   3. 架電台帳 : data/telapo/calls.jsonl へ1架電=1行で記録。
 *   4. ダッシュボード : 接続ファネル/結果分布/断り理由/トーク要素/語彙lift/担当者別を集計。
 *
 * ※ 完全ローカル・外部API不使用。文字起こしは手入力（別STTツールの結果貼付も可）。
 */
const http = require('http');
const { URL } = require('url');
const store = require('./telapo-store');
const { analyzeCall, aggregate } = require('./telapo-analyze');
const TA = require('./talk-analysis');

const MAX_AUDIO_BYTES = parseInt(process.env.TELAPO_MAX_AUDIO || String(80 * 1024 * 1024), 10); // 80MB
const MAX_JSON_BYTES = 12 * 1024 * 1024;

// 録音ストリーミング応答用の拡張子→MIME
const MIME_BY_EXT = {
  webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  mp3: 'audio/mpeg', wav: 'audio/wav',
};

function argPort() {
  const i = process.argv.indexOf('--port');
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10);
  return parseInt(process.env.TELAPO_UI_PORT || '5179', 10);
}
const PORT = argPort();

// ── リクエストボディ読み取り ──
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    req.on('data', (c) => { len += c.length; if (len > limit) { req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readRaw(req, MAX_JSON_BYTES);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (_) { return {}; }
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const p = u.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }

    // 設定（コール結果の選択肢・トーク要素・断り理由カテゴリ）をフロントへ供給
    if (req.method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, {
        results: TA.RESULT_OPTIONS,
        talkLabels: TA.TALK_RULES.map((r) => r[0]),
        reasonLabels: TA.REASON_RULES.map((r) => r[0]),
      });
    }

    // ライブ分析（保存せず判定のみ）
    if (req.method === 'POST' && p === '/api/analyze') {
      const body = await readJson(req);
      return sendJson(res, 200, analyzeCall(body));
    }

    // 録音アップロード（生バイナリ）。id を発番し data/recordings/ へ保存。
    if (req.method === 'POST' && p === '/api/recording') {
      const buf = await readRaw(req, MAX_AUDIO_BYTES);
      if (!buf.length) return sendJson(res, 400, { error: '音声データが空です' });
      const id = store.newId();
      const mime = req.headers['x-audio-type'] || req.headers['content-type'] || 'audio/webm';
      const audioFile = store.saveRecording(id, buf, mime);
      return sendJson(res, 200, { id, audioFile, bytes: buf.length });
    }

    // 録音の再生（ストリーミング）
    if (req.method === 'GET' && p === '/api/recording') {
      const file = u.searchParams.get('file') || '';
      const abs = store.recordingPath(file);
      if (!abs) { res.writeHead(404); return res.end('not found'); }
      const ext = abs.split('.').pop().toLowerCase();
      const fs = require('fs');
      const stat = fs.statSync(abs);
      res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Accept-Ranges': 'none' });
      return fs.createReadStream(abs).pipe(res);
    }

    // 架電を台帳へ保存（分析を付与）
    if (req.method === 'POST' && p === '/api/calls') {
      const body = await readJson(req);
      if (!String(body.company || '').trim() && !String(body.transcript || '').trim() && !body.audioFile) {
        return sendJson(res, 400, { error: '会社名・文字起こし・録音のいずれかが必要です' });
      }
      const analysis = analyzeCall(body);
      // 断り理由/トーク要素は手動指定があれば尊重、無ければ規則の判定を採用。
      const rec = store.appendCall({
        ...body,
        refusalReason: body.refusalReason || (analysis.resultClass.refused ? analysis.refusalReason : ''),
        talkElements: (Array.isArray(body.talkElements) && body.talkElements.length)
          ? body.talkElements
          : (analysis.resultClass.appo ? analysis.talkElements : []),
      });
      return sendJson(res, 200, { saved: rec, analysis });
    }

    // 台帳一覧
    if (req.method === 'GET' && p === '/api/calls') {
      return sendJson(res, 200, { calls: store.readCalls() });
    }

    // 架電削除
    if (req.method === 'DELETE' && p === '/api/calls') {
      const id = u.searchParams.get('id') || '';
      return sendJson(res, 200, { deleted: store.deleteCall(id) });
    }

    // ダッシュボード集計
    if (req.method === 'GET' && p === '/api/dashboard') {
      return sendJson(res, 200, aggregate(store.readCalls()));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

// ポート使用中なら次のポートへ自動フォールバック（email-ui と同方針）
function start(port = PORT, attemptsLeft = 10) {
  server.removeAllListeners('error');
  server.removeAllListeners('listening');
  server.once('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  ポート ${port} は使用中のため ${port + 1} を試します…`);
      setTimeout(() => start(port + 1, attemptsLeft - 1), 100);
      return;
    }
    console.error('  サーバ起動エラー:', (e && e.message) || e);
    process.exit(1);
  });
  server.once('listening', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  テレアポ分析システム 起動: ${url}\n  （録音はマイク許可が必要／停止は Ctrl+C）\n`);
    if (process.env.TELAPO_UI_OPEN === '1') {
      const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      try { require('child_process').exec(cmd); } catch (_) {}
    }
  });
  server.listen(port);
  return server;
}
if (require.main === module) start();
module.exports = { server, start };

// ================== フロントエンド（単一HTML・インラインCSS/JS） ==================
const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>テレアポ分析システム</title>
<style>
  :root{ --panel:#fff; --line:#e2e8f0; --ink:#0f172a; --muted:#64748b;
    --brand:#2563eb; --brand-d:#1d4ed8; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --chip:#f1f5f9; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Meiryo",system-ui,sans-serif; color:var(--ink); background:#f8fafc; }
  header{ background:linear-gradient(135deg,#1e3a8a,#2563eb); color:#fff; padding:18px 28px; }
  header h1{ margin:0; font-size:20px; font-weight:700; letter-spacing:.02em; }
  header p{ margin:5px 0 0; font-size:13px; opacity:.85; }
  nav{ display:flex; gap:4px; background:#fff; border-bottom:1px solid var(--line); padding:0 20px; position:sticky; top:0; z-index:5; }
  nav button{ background:none; border:none; padding:13px 18px; font:inherit; font-size:14px; font-weight:600; color:var(--muted); cursor:pointer; border-bottom:3px solid transparent; }
  nav button.active{ color:var(--brand); border-bottom-color:var(--brand); }
  main{ max-width:1100px; margin:0 auto; padding:22px 20px 70px; }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; box-shadow:0 1px 2px rgba(15,23,42,.04); margin-bottom:18px; }
  .card h2{ margin:0 0 14px; font-size:15px; font-weight:700; color:#1e293b; }
  label{ font-size:12.5px; font-weight:600; color:#334155; display:block; margin-bottom:5px; }
  input[type=text],input[type=tel],select,textarea{ width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit; background:#fff; }
  textarea{ min-height:96px; resize:vertical; line-height:1.6; }
  .grid{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
  .grid .full{ grid-column:1/-1; }
  @media(max-width:720px){ .grid{ grid-template-columns:1fr; } }
  .hint{ font-size:11.5px; color:var(--muted); margin-top:5px; line-height:1.6; }
  .btns{ display:flex; gap:10px; margin-top:14px; flex-wrap:wrap; }
  button.act{ font:inherit; font-size:14px; font-weight:600; padding:10px 18px; border-radius:8px; border:1px solid transparent; cursor:pointer; transition:.15s; }
  button.act:disabled{ opacity:.5; cursor:default; }
  .primary{ background:var(--brand); color:#fff; } .primary:hover:not(:disabled){ background:var(--brand-d); }
  .ghost{ background:#fff; color:#334155; border-color:var(--line); } .ghost:hover:not(:disabled){ background:#f8fafc; }
  .danger{ background:#fff; color:var(--bad); border-color:#fecaca; } .danger:hover{ background:#fef2f2; }
  .rec-panel{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; background:#f8fafc; border:1px dashed var(--line); border-radius:10px; padding:14px 16px; }
  .rec-dot{ width:11px; height:11px; border-radius:50%; background:#cbd5e1; }
  .rec-dot.on{ background:var(--bad); animation:pulse 1s infinite; }
  @keyframes pulse{ 50%{ opacity:.3; } }
  .timer{ font-variant-numeric:tabular-nums; font-size:20px; font-weight:700; letter-spacing:.04em; min-width:74px; }
  audio{ height:34px; vertical-align:middle; }
  .file-lbl{ display:inline-flex; align-items:center; gap:7px; cursor:pointer; font-size:13.5px; font-weight:600; color:#334155; border:1px solid var(--line); background:#fff; padding:9px 14px; border-radius:8px; }
  .file-lbl:hover{ background:#f8fafc; }
  .analysis{ background:#f0f9ff; border:1px solid #bae6fd; border-radius:10px; padding:13px 15px; margin-top:12px; }
  .analysis .lead{ font-size:12px; color:#0369a1; font-weight:700; margin-bottom:8px; }
  .chips{ display:flex; gap:7px; flex-wrap:wrap; }
  .chip{ display:inline-block; font-size:12px; padding:3px 10px; border-radius:99px; background:#dbeafe; color:#1e40af; font-weight:600; }
  .chip.reason{ background:#fee2e2; color:#991b1b; }
  .chip.muted{ background:var(--chip); color:#475569; }
  /* ワンクリック分類チップ（クリックで選択/解除） */
  .pick{ display:inline-block; font-size:12px; padding:5px 12px; border-radius:99px; border:1px solid var(--line); background:#fff; color:#475569; cursor:pointer; user-select:none; margin:0 6px 6px 0; transition:.12s; }
  .pick:hover{ background:#f1f5f9; }
  .pick.auto{ border-color:#93c5fd; box-shadow:inset 0 0 0 1px #bfdbfe; }
  .pick.auto::before{ content:"◎ "; color:#2563eb; }
  .pick.on{ background:var(--brand); color:#fff; border-color:var(--brand); box-shadow:none; }
  .pick.on::before{ content:""; }
  .pick.res.on{ background:#0f766e; border-color:#0f766e; }
  .pick.rz.on{ background:var(--bad); border-color:var(--bad); }
  .sug{ font-size:12.5px; color:#0369a1; margin-bottom:9px; }
  .sug b{ color:#0f172a; }
  .picklab{ font-size:12px; color:#64748b; margin:8px 0 5px; font-weight:600; }
  .switch{ display:inline-flex; align-items:center; gap:7px; font-size:13px; font-weight:600; color:#334155; cursor:pointer; }
  .switch input{ width:16px; height:16px; }
  .stt-live{ font-size:12.5px; color:#0369a1; min-height:16px; margin-top:5px; }
  .badge{ display:inline-block; font-size:11px; padding:2px 9px; border-radius:99px; background:var(--chip); color:#475569; font-weight:600; white-space:nowrap; }
  .badge.appo{ background:#dcfce7; color:#166534; } .badge.refuse{ background:#fee2e2; color:#991b1b; }
  .badge.follow{ background:#fef3c7; color:#92400e; } .badge.pre{ background:#e2e8f0; color:#475569; }
  table{ width:100%; border-collapse:collapse; font-size:13px; }
  th,td{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th{ font-size:11.5px; color:var(--muted); font-weight:600; background:#f8fafc; }
  .tablewrap{ overflow-x:auto; border:1px solid var(--line); border-radius:10px; }
  .empty{ text-align:center; color:var(--muted); padding:32px 10px; font-size:13px; }
  .status{ font-size:12.5px; margin-top:10px; min-height:18px; }
  .status.ok{ color:var(--ok); } .status.err{ color:var(--bad); } .status.run{ color:var(--brand); }
  .kpis{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  @media(max-width:720px){ .kpis{ grid-template-columns:repeat(2,1fr); } }
  .kpi{ background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px; }
  .kpi .n{ font-size:26px; font-weight:800; color:#1e293b; font-variant-numeric:tabular-nums; }
  .kpi .l{ font-size:12px; color:var(--muted); margin-top:3px; }
  .bar-row{ display:grid; grid-template-columns:180px 1fr 62px; gap:10px; align-items:center; margin:6px 0; font-size:12.5px; }
  .bar-row .lab{ color:#334155; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar{ background:#eff6ff; border-radius:6px; height:20px; overflow:hidden; }
  .bar > span{ display:block; height:100%; background:linear-gradient(90deg,#60a5fa,#2563eb); }
  .bar.r > span{ background:linear-gradient(90deg,#fca5a5,#dc2626); }
  .bar.g > span{ background:linear-gradient(90deg,#86efac,#16a34a); }
  .bar-row .v{ text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  @media(max-width:720px){ .bar-row{ grid-template-columns:120px 1fr 54px; } }
  .funnel{ display:flex; gap:10px; flex-wrap:wrap; }
  .fn{ flex:1; min-width:120px; background:#f8fafc; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .fn .n{ font-size:22px; font-weight:800; } .fn .l{ font-size:11.5px; color:var(--muted); margin-top:2px; }
  .spin{ display:inline-block; width:12px; height:12px; border:2px solid #c7d2fe; border-top-color:var(--brand); border-radius:50%; animation:s .7s linear infinite; vertical-align:-1px; margin-right:5px; }
  @keyframes s{ to{ transform:rotate(360deg); } }
</style>
</head>
<body>
<header>
  <h1>テレアポ分析システム</h1>
  <p>架電録音 → 文字起こし → 規則ベース架電分析（完全ローカル）→ 台帳 → ダッシュボード</p>
</header>
<nav>
  <button id="tab-call" class="active" onclick="showTab('call')">① 架電・録音</button>
  <button id="tab-ledger" onclick="showTab('ledger')">② 架電台帳</button>
  <button id="tab-dash" onclick="showTab('dash')">③ 分析ダッシュボード</button>
</nav>
<main>
  <!-- ===== ① 架電・録音 ===== -->
  <section id="view-call">
    <div class="card">
      <h2>架電情報</h2>
      <div class="grid">
        <div><label>会社名 *</label><input type="text" id="company" placeholder="株式会社〇〇"></div>
        <div><label>架電者</label><input type="text" id="operator" placeholder="担当オペレーター名"></div>
        <div><label>電話番号</label><input type="tel" id="phone" placeholder="03-xxxx-xxxx"></div>
        <div><label>業種</label><input type="text" id="industry" placeholder="製造業 など"></div>
        <div><label>従業員規模</label><input type="text" id="empSize" placeholder="300〜500名 など"></div>
        <div><label>利用中ATS</label><input type="text" id="ats" placeholder="かんり君 / なし など"></div>
      </div>
    </div>

    <div class="card">
      <h2>架電録音</h2>
      <div class="rec-panel">
        <span class="rec-dot" id="recDot"></span>
        <span class="timer" id="timer">00:00</span>
        <button class="act primary" id="btnRec" onclick="toggleRec()">● 録音開始</button>
        <label class="file-lbl">📁 音声ファイル
          <input type="file" id="fileInput" accept="audio/*" style="display:none" onchange="onFile(event)">
        </label>
        <span id="audioBox"></span>
      </div>
      <div class="hint">マイク録音（要許可）または既存音声（mp3/wav/m4a/webm 等）をアップロード。保存先は data/recordings/。</div>
      <div class="row" style="margin-top:12px; gap:10px; align-items:center">
        <label class="switch"><input type="checkbox" id="sttToggle" onchange="onSttToggle()"> 🎙 音声認識で文字起こしを自動入力</label>
        <span id="sttState" class="badge">—</span>
      </div>
      <div class="hint" id="sttNote">録音開始と同時にブラウザの音声認識（日本語）が文字起こしを自動入力します。<b>※ブラウザ内蔵のクラウド認識を使うため通信が発生します（完全ローカルではありません）。Chrome / Edge 推奨。</b></div>
    </div>

    <div class="card">
      <h2>文字起こし・結果</h2>
      <label>文字起こし（音声認識で自動入力／手入力／別STTの結果を貼付）</label>
      <textarea id="transcript" placeholder="通話内容…（この本文から結果・断り理由・トーク要素を自動判定します）" oninput="onTranscriptInput()"></textarea>
      <div class="stt-live" id="sttInterim"></div>

      <div class="analysis" id="analysisBox" style="display:none">
        <div class="lead">▼ 自動判定（クリックで確定・修正 — 入力不要）</div>
        <div class="sug" id="sugLine"></div>
        <div class="picklab">コール結果（自動判定 ◎ / クリックで修正）</div>
        <div id="pickResult"></div>
        <div id="pickReasonWrap" style="display:none">
          <div class="picklab">断り理由（1つ選択）</div>
          <div id="pickReason"></div>
        </div>
        <div id="pickTalkWrap" style="display:none">
          <div class="picklab">アポ獲得トーク要素（複数選択可）</div>
          <div id="pickTalk"></div>
        </div>
      </div>

      <div class="grid" style="margin-top:14px">
        <div><label>ペンディング理由（任意）</label><input type="text" id="pending" placeholder="検討時期が3カ月以上先 など" oninput="scheduleAnalyze()"></div>
        <div><label>次アクション（任意）</label><input type="text" id="nextAction" placeholder="来期に再架電 / 資料送付 など"></div>
        <div><label>メモ（任意）</label><input type="text" id="memo" placeholder="補足・所感"></div>
      </div>
      <div class="btns">
        <button class="act primary" id="btnSave" onclick="saveCall()">台帳へ保存</button>
        <button class="act ghost" onclick="resetForm()">クリア</button>
      </div>
      <div class="status" id="callStatus"></div>
    </div>
  </section>

  <!-- ===== ② 架電台帳 ===== -->
  <section id="view-ledger" style="display:none">
    <div class="card">
      <h2>架電台帳 <button class="act ghost" style="float:right;padding:6px 12px" onclick="loadLedger()">再読込</button></h2>
      <div id="ledgerBody"><div class="empty">読み込み中…</div></div>
    </div>
  </section>

  <!-- ===== ③ ダッシュボード ===== -->
  <section id="view-dash" style="display:none">
    <div class="card">
      <h2>分析ダッシュボード <button class="act ghost" style="float:right;padding:6px 12px" onclick="loadDash()">再集計</button></h2>
      <div id="dashBody"><div class="empty">読み込み中…</div></div>
    </div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let RESULTS = [], REASON_LABELS = [], TALK_LABELS = [];
// 自動判定＋ワンクリック分類の状態
let curResult='', resultTouched=false, selReason='', reasonTouched=false, selTalk=new Set(), talkTouched=false, lastAnalysis=null;

// ---- タブ ----
function showTab(t){
  for(const k of ['call','ledger','dash']){
    $('view-'+k).style.display = (k===t)?'':'none';
    $('tab-'+(k==='dash'?'dash':k)).classList.toggle('active', k===t);
  }
  if(t==='ledger') loadLedger();
  if(t==='dash') loadDash();
}

// ---- 初期化：結果選択肢・分類ラベルの取得 ----
async function init(){
  try{
    const cfg = await (await fetch('/api/config')).json();
    RESULTS = cfg.results||[]; REASON_LABELS = cfg.reasonLabels||[]; TALK_LABELS = cfg.talkLabels||[];
  }catch(e){}
  initStt();
}

// ---- 録音（MediaRecorder） ----
let mediaRec=null, chunks=[], recStart=0, timerIv=null;
let pending = { id:'', audioFile:'', durationSec:0 }; // アップロード済み録音の参照

function fmtTime(s){ s=Math.floor(s); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function tick(){ $('timer').textContent = fmtTime((Date.now()-recStart)/1000); }

async function toggleRec(){
  if(mediaRec && mediaRec.state==='recording'){ mediaRec.stop(); return; }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    chunks=[]; mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = e=>{ if(e.data.size) chunks.push(e.data); };
    mediaRec.onstop = async ()=>{
      clearInterval(timerIv); $('recDot').classList.remove('on'); $('btnRec').textContent='● 録音開始';
      stopStt();
      stream.getTracks().forEach(t=>t.stop());
      const dur = (Date.now()-recStart)/1000;
      const blob = new Blob(chunks, {type: mediaRec.mimeType||'audio/webm'});
      await uploadAudio(blob, dur);
    };
    mediaRec.start(); recStart=Date.now(); timerIv=setInterval(tick,250); tick();
    $('recDot').classList.add('on'); $('btnRec').textContent='■ 録音停止';
    if($('sttToggle').checked) startStt();
    setStatus('callStatus','録音中…','run');
  }catch(e){ setStatus('callStatus','マイクにアクセスできません（権限をご確認ください）: '+e.message,'err'); }
}

async function onFile(ev){
  const f = ev.target.files[0]; if(!f) return;
  // 音声長を取得してからアップロード
  let dur = 0;
  try{ dur = await audioDuration(f); }catch(_){}
  await uploadAudio(f, dur, f.name, f.type);
  ev.target.value='';
}
function audioDuration(file){
  return new Promise((resolve,reject)=>{
    const a=document.createElement('audio'); a.preload='metadata';
    a.onloadedmetadata=()=>{ resolve(isFinite(a.duration)?a.duration:0); URL.revokeObjectURL(a.src); };
    a.onerror=()=>reject(new Error('duration')); a.src=URL.createObjectURL(file);
  });
}

async function uploadAudio(blob, durationSec, name, type){
  setStatus('callStatus','録音をアップロード中… ('+Math.round(blob.size/1024)+'KB)','run');
  try{
    const r = await fetch('/api/recording', { method:'POST', headers:{'x-audio-type': type||blob.type||'audio/webm'}, body: blob });
    const j = await r.json();
    if(j.error) throw new Error(j.error);
    pending.id=j.id; pending.audioFile=j.audioFile; pending.durationSec=Math.round(durationSec||0);
    const url='/api/recording?file='+encodeURIComponent(j.audioFile);
    $('audioBox').innerHTML='<audio controls src="'+url+'"></audio> <span class="badge">'+esc(name||j.audioFile)+' ・ '+fmtTime(pending.durationSec)+'</span>';
    setStatus('callStatus','録音を保存しました：'+j.audioFile,'ok');
  }catch(e){ setStatus('callStatus','アップロード失敗: '+e.message,'err'); }
}

// ---- 音声認識（Web Speech API・任意トグル。既定OFF＝完全ローカル維持） ----
let recog=null, sttFinal='';
function sttSupported(){ return !!(window.SpeechRecognition||window.webkitSpeechRecognition); }
function recording(){ return mediaRec && mediaRec.state==='recording'; }
function setStt(s){ $('sttState').textContent=s; }
function initStt(){
  if(!sttSupported()){
    $('sttToggle').checked=false; $('sttToggle').disabled=true; setStt('非対応');
    $('sttNote').innerHTML='このブラウザは音声認識(Web Speech API)に非対応です。Chrome / Edge をご利用ください。文字起こしは手入力／貼付で従来どおり分析できます。';
  } else setStt('待機');
}
function onSttToggle(){
  if($('sttToggle').checked){ setStt('ON（録音開始で認識）'); if(recording()) startStt(); }
  else { setStt('待機'); stopStt(); }
}
function startStt(){
  if(!sttSupported()||recog) return;
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  recog=new SR(); recog.lang='ja-JP'; recog.continuous=true; recog.interimResults=true;
  const base=$('transcript').value; sttFinal = base ? (base.replace(/\\s+$/,'')+' ') : '';
  recog.onresult=(e)=>{
    let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){ const r=e.results[i]; if(r.isFinal) sttFinal+=r[0].transcript; else interim+=r[0].transcript; }
    $('transcript').value = sttFinal + interim;
    $('sttInterim').textContent = interim ? ('認識中… '+interim) : '';
    scheduleAnalyze();
  };
  recog.onerror=(e)=>{ if(e.error!=='aborted'&&e.error!=='no-speech') setStt('エラー: '+e.error); };
  recog.onend=()=>{ if($('sttToggle').checked && recording()){ try{recog.start();}catch(_){} } else setStt('待機'); };
  try{ recog.start(); setStt('認識中…'); }catch(_){}
}
function stopStt(){ if(recog){ try{ recog.onend=null; recog.stop(); }catch(_){} recog=null; } $('sttInterim').textContent=''; }

// ---- ライブ自動判定（デバウンス） ----
let analyzeTimer=null;
function onTranscriptInput(){ scheduleAnalyze(); }
function scheduleAnalyze(){ clearTimeout(analyzeTimer); analyzeTimer=setTimeout(runAnalyze, 300); }
async function runAnalyze(){
  const transcript=$('transcript').value, memo=$('memo').value;
  if(!transcript.trim() && !curResult){ $('analysisBox').style.display='none'; return; }
  try{
    const a = await (await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ result:curResult, transcript, memo, pending:$('pending').value })})).json();
    applyAnalysis(a);
  }catch(e){}
}
// 自動判定を反映（オペレーターが手で触っていない項目だけ上書き＝クリックを尊重）
function applyAnalysis(a){
  lastAnalysis=a;
  if(!resultTouched && a.suggestedResult) curResult=a.suggestedResult;
  const rc=classifyLocal(curResult);
  if(!reasonTouched) selReason = rc.refused ? (a.refusalReason||'') : '';
  if(!talkTouched) selTalk = new Set(a.talkElements||[]);
  renderPicks();
}
function renderPicks(){
  const a=lastAnalysis||{}; $('analysisBox').style.display='';
  const sug = a.suggestedResult
    ? ('<b>'+esc(labelOf(a.suggestedResult))+'</b> と自動判定（違う場合は下のチップをクリック）')
    : '結果を自動判定できませんでした。下のチップから選択してください。';
  $('sugLine').innerHTML='◎ '+sug;
  // コール結果チップ（自動判定に◎、選択中は塗り）
  $('pickResult').innerHTML = RESULTS.map((o,i)=>{
    const on=o.value===curResult, auto=(o.value===a.suggestedResult);
    return '<span class="pick res'+(on?' on':'')+((auto&&!on)?' auto':'')+'" onclick="pickResult('+i+')">'+esc(o.label)+'</span>';
  }).join('');
  const rc=classifyLocal(curResult);
  // 断り理由（お断り時のみ・単一選択）
  $('pickReasonWrap').style.display = rc.refused ? '' : 'none';
  if(rc.refused){
    $('pickReason').innerHTML = REASON_LABELS.map((l,i)=>{
      const on=l===selReason, auto=(l===(a.refusalReason||''));
      return '<span class="pick rz'+(on?' on':'')+((auto&&!on)?' auto':'')+'" onclick="pickReason('+i+')">'+esc(l)+'</span>';
    }).join('');
  }
  // アポ獲得トーク要素（接続かつ非お断り時・複数選択）
  const showTalk = rc.reached && !rc.refused;
  $('pickTalkWrap').style.display = showTalk ? '' : 'none';
  if(showTalk){
    const autoSet=new Set(a.talkElements||[]);
    $('pickTalk').innerHTML = TALK_LABELS.map((l,i)=>{
      const on=selTalk.has(l), auto=autoSet.has(l);
      return '<span class="pick'+(on?' on':'')+((auto&&!on)?' auto':'')+'" onclick="pickTalk('+i+')">'+esc(l)+'</span>';
    }).join('');
  }
}
function pickResult(i){ const v=RESULTS[i].value; curResult=(curResult===v?'':v); resultTouched=true; const rc=classifyLocal(curResult); if(!reasonTouched && !rc.refused) selReason=''; renderPicks(); }
function pickReason(i){ const l=REASON_LABELS[i]; selReason=(selReason===l?'':l); reasonTouched=true; renderPicks(); }
function pickTalk(i){ const l=TALK_LABELS[i]; if(selTalk.has(l)) selTalk.delete(l); else selTalk.add(l); talkTouched=true; renderPicks(); }
function labelOf(v){ const o=RESULTS.find(x=>x.value===v); return o?o.label:v; }

// ---- 保存 ----
async function saveCall(){
  const company=$('company').value.trim();
  if(!company && !$('transcript').value.trim() && !pending.audioFile){ setStatus('callStatus','会社名・文字起こし・録音のいずれかを入力してください','err'); return; }
  $('btnSave').disabled=true; setStatus('callStatus','保存中…','run');
  const body={
    company, operator:$('operator').value, phone:$('phone').value, industry:$('industry').value,
    empSize:$('empSize').value, ats:$('ats').value, result:curResult,
    transcript:$('transcript').value, memo:$('memo').value, pending:$('pending').value, nextAction:$('nextAction').value,
    refusalReason:selReason, talkElements:[...selTalk],
    audioFile:pending.audioFile, durationSec:pending.durationSec, id:pending.id||undefined,
  };
  try{
    const j = await (await fetch('/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    if(j.error) throw new Error(j.error);
    setStatus('callStatus','✓ 台帳へ保存しました（'+esc(j.saved.result||'結果未設定')+'）','ok');
    resetForm(true);
  }catch(e){ setStatus('callStatus','保存失敗: '+e.message,'err'); }
  finally{ $('btnSave').disabled=false; }
}
function resetForm(keepAttr){
  ['transcript','memo','pending','nextAction','phone'].forEach(id=>$(id).value='');
  if(!keepAttr){ ['company','operator','industry','empSize','ats'].forEach(id=>$(id).value=''); }
  pending={id:'',audioFile:'',durationSec:0}; $('audioBox').innerHTML=''; $('timer').textContent='00:00'; $('sttInterim').textContent='';
  curResult=''; resultTouched=false; selReason=''; reasonTouched=false; selTalk=new Set(); talkTouched=false; lastAnalysis=null;
  $('analysisBox').style.display='none';
}

// ---- 台帳 ----
async function loadLedger(){
  $('ledgerBody').innerHTML='<div class="empty"><span class="spin"></span>読み込み中…</div>';
  try{
    const {calls} = await (await fetch('/api/calls')).json();
    if(!calls.length){ $('ledgerBody').innerHTML='<div class="empty">まだ架電記録がありません。「① 架電・録音」から記録してください。</div>'; return; }
    const rows = calls.map(c=>{
      const rc = resultBadge(c.result);
      const audio = c.audioFile ? '<audio controls style="height:30px" src="/api/recording?file='+encodeURIComponent(c.audioFile)+'"></audio>' : '<span class="badge pre">録音なし</span>';
      const tags = (c.talkElements&&c.talkElements.length)? c.talkElements.map(e=>'<span class="chip" style="font-size:11px">'+esc(e)+'</span>').join(' ') : '';
      const reason = c.refusalReason? '<span class="chip reason" style="font-size:11px">'+esc(c.refusalReason)+'</span>':'';
      return '<tr>'
        +'<td style="white-space:nowrap">'+esc((c.ts||'').replace('T',' ').slice(0,16))+'</td>'
        +'<td><b>'+esc(c.company||'-')+'</b><div class="hint">'+esc(c.operator||'')+(c.phone?(' ・ '+esc(c.phone)):'')+'</div></td>'
        +'<td>'+rc+'</td>'
        +'<td>'+reason+tags+'<div class="hint" style="max-width:260px">'+esc((c.transcript||'').slice(0,60))+'</div></td>'
        +'<td>'+audio+'</td>'
        +'<td><button class="act danger" style="padding:5px 10px;font-size:12px" onclick="delCall(\\''+c.id+'\\')">削除</button></td>'
        +'</tr>';
    }).join('');
    $('ledgerBody').innerHTML='<div class="tablewrap"><table><thead><tr><th>日時</th><th>会社 / 架電者</th><th>結果</th><th>分析・文字起こし</th><th>録音</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  }catch(e){ $('ledgerBody').innerHTML='<div class="empty" style="color:#dc2626">読込失敗: '+esc(e.message)+'</div>'; }
}
async function delCall(id){
  if(!confirm('この架電記録を削除しますか？（録音も削除されます）')) return;
  await fetch('/api/calls?id='+encodeURIComponent(id),{method:'DELETE'}); loadLedger();
}

// ---- ダッシュボード ----
async function loadDash(){
  $('dashBody').innerHTML='<div class="empty"><span class="spin"></span>集計中…</div>';
  try{
    const d = await (await fetch('/api/dashboard')).json();
    const s=d.summary;
    if(!s.total){ $('dashBody').innerHTML='<div class="empty">集計対象がありません。架電を記録すると自動で集計されます。</div>'; return; }
    let h='';
    h+='<div class="kpis">'
      +kpi(s.total,'総架電数')+kpi(s.reachRate,'接続率')+kpi(s.appoOfReached,'アポ率（接続後）')+kpi(s.appo,'アポ獲得数')
      +'</div>';
    h+='<h2 style="margin:22px 0 10px;font-size:14px">接続ファネル</h2><div class="funnel">'
      +fn(s.reached,'担当者接続 ('+s.reachRate+')')
      +fn(s.appo,'アポ獲得 ('+s.appoOfReached+')')
      +fn(s.follow,'営業フォロー ('+s.followOfReached+')')
      +fn(s.refused,'お断り ('+s.refusedOfReached+')')
      +'</div>';
    h+=barSection('コール結果分布', d.resultDist.map(r=>({lab:r.result,count:r.count,pct:r.pct})), s.total, '');
    if(d.refusalDist.length) h+=barSection('断り理由（お断り '+s.refused+'件）', d.refusalDist.map(r=>({lab:r.reason,count:r.count,pct:r.pct})), s.refused, 'r');
    if(d.talkDist.length) h+=barSection('アポ獲得トーク要素（アポ '+s.appo+'件・複数該当可）', d.talkDist.map(r=>({lab:r.element,count:r.count,pct:r.pct})), s.appo, 'g');
    // 語彙lift（上位）
    const lift=d.lift.filter(x=>x.lift!==null && x.lift>=1 && x.appoRate>0).slice(0,12);
    if(lift.length){
      h+='<h2 style="margin:22px 0 10px;font-size:14px">語彙lift（アポ ÷ お断り 出現率。トークの決定要因）</h2>';
      h+='<div class="tablewrap"><table><thead><tr><th>語</th><th>lift</th><th>アポ%</th><th>お断り%</th></tr></thead><tbody>'
        +lift.map(x=>'<tr><td>'+esc(x.word)+'</td><td><b>'+(x.lift==null?'∞':x.lift)+'</b></td><td>'+x.appoRate+'</td><td>'+x.refuseRate+'</td></tr>').join('')
        +'</tbody></table></div>';
    }
    // オペレーター別
    if(d.operators.length){
      h+='<h2 style="margin:22px 0 10px;font-size:14px">オペレーター別成績</h2>';
      h+='<div class="tablewrap"><table><thead><tr><th>担当</th><th>架電</th><th>接続</th><th>接続率</th><th>アポ</th><th>アポ率</th></tr></thead><tbody>'
        +d.operators.map(o=>'<tr><td>'+esc(o.operator)+'</td><td>'+o.calls+'</td><td>'+o.reached+'</td><td>'+o.reachRate+'</td><td>'+o.appo+'</td><td><b>'+o.appoRate+'</b></td></tr>').join('')
        +'</tbody></table></div>';
    }
    $('dashBody').innerHTML=h;
  }catch(e){ $('dashBody').innerHTML='<div class="empty" style="color:#dc2626">集計失敗: '+esc(e.message)+'</div>'; }
}
function kpi(n,l){ return '<div class="kpi"><div class="n">'+esc(String(n))+'</div><div class="l">'+esc(l)+'</div></div>'; }
function fn(n,l){ return '<div class="fn"><div class="n">'+n+'</div><div class="l">'+esc(l)+'</div></div>'; }
function barSection(title, items, denom, cls){
  const max=Math.max(1,...items.map(i=>i.count));
  let h='<h2 style="margin:22px 0 10px;font-size:14px">'+esc(title)+'</h2>';
  h+=items.map(i=>{
    const w=Math.round(100*i.count/max);
    return '<div class="bar-row"><div class="lab" title="'+esc(i.lab)+'">'+esc(i.lab)+'</div><div class="bar '+cls+'"><span style="width:'+w+'%"></span></div><div class="v">'+i.count+' ・ '+i.pct+'</div></div>';
  }).join('');
  return h;
}
function resultBadge(result){
  const rc=classifyLocal(result);
  let cls='pre', t=result||'-';
  if(rc.appo)cls='appo'; else if(rc.refused)cls='refuse'; else if(rc.follow)cls='follow'; else if(rc.reached)cls='appo';
  return '<span class="badge '+cls+'">'+esc(t)+'</span>';
}
function classifyLocal(result){ const r=String(result||''); const reached=r.indexOf('担当者接触：')===0; return {reached,appo:r==='担当者接触：アポ獲得',refused:r==='担当者接触：お断り',follow:r==='担当者接触：営業フォロー'}; }

function setStatus(id,msg,cls){ const el=$(id); el.textContent=msg; el.className='status '+(cls||''); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

init();
</script>
</body>
</html>`;
