'use strict';
/**
 * 今週架電ダッシュボード（ローカルWebアプリ）
 * =====================================================================
 * 営業が毎朝ブラウザで開き、即架電リストを 検索/フィルタ/並び替え し、
 * その場で 架電結果を記録・CSV書き出し できるエンドポイント。
 *
 * ★データは統合マスタ(data/leads-consolidated-all.csv)をローカルで読むだけ。
 *   個人情報を外部に一切送らない（サーバはこのPCの localhost のみ）。
 *
 *   node src/dashboard.js            # http://localhost:5178 で起動
 *   npm run dashboard
 *   PORT=8080 node src/dashboard.js  # ポート変更
 *
 * 架電結果は data/call-status.json に保存（企業名キー）。ブラウザを閉じても残る。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { readCsv } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const MASTER = path.join(ROOT, 'data', 'leads-consolidated-all.csv');
const STATUS_FILE = path.join(ROOT, 'data', 'call-status.json');
const PORT = parseInt(process.env.PORT || '5178', 10);

// ── データ読み込み（起動時に1回・架電可能な完全新規のみメモリ保持）──────
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());
function loadLeads() {
  if (!fs.existsSync(MASTER)) {
    console.error(`[dashboard] ✗ 統合マスタが見つかりません: ${path.relative(ROOT, MASTER)}`);
    console.error(`  → 先に node src/consolidate-all.js を実行してください。`);
    process.exit(1);
  }
  const { records } = readCsv(fs.readFileSync(MASTER, 'utf8'));
  const leads = [];
  for (const r of records) {
    const phone = g(r, '電話番号');
    const overlap = g(r, '既存被り');
    // 架電可能な完全新規のみ（被り除外・電話あり）
    if (overlap !== '' || phone === '') continue;
    leads.push({
      company: g(r, '企業名'),
      phone,
      name: g(r, '採用担当者名'),
      dept: g(r, '部署'),
      role: g(r, '役職'),
      call_to: g(r, '架電宛名'),
      industry: g(r, '業種'),
      pref: g(r, '都道府県').replace(/^(.*?[都道府県]).*/, '$1'),
      addr: g(r, '都道府県'),
      emp: g(r, '従業員数'),
      score: parseInt(g(r, 'アポ期待度') || '0', 10) || 0,
      mochica: g(r, 'MOCHICA適合'),
      priority: g(r, '優先度'),
      segment: g(r, 'セグメント区分'),
      plan: g(r, '提案プラン'),
      shinsotsu: g(r, '新卒フラグ'),
      hire_n: g(r, '採用予定人数'),
      jobs: g(r, '採用職種'),
      url: g(r, '公式URL'),
      recruit_url: g(r, '採用ページURL'),
      hasName: g(r, '採用担当者名') !== '',
    });
  }
  leads.sort((a, b) => b.score - a.score);
  return leads;
}
let LEADS = loadLeads();

// フィルタ選択肢（都道府県・業種の上位）
function distinct(key, min = 1) {
  const m = new Map();
  for (const l of LEADS) { const v = l[key]; if (v) m.set(v, (m.get(v) || 0) + 1); }
  return [...m.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]);
}

function empBracket(emp) {
  const v = parseInt(String(emp).replace(/[^0-9]/g, ''), 10);
  if (!v) return '不明';
  if (v < 50) return '〜49';
  if (v <= 150) return '50-150';
  if (v <= 300) return '151-300';
  if (v <= 1000) return '301-1000';
  return '1001〜';
}

// ── 架電ステータス永続化 ───────────────────────────────────────
function loadStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return {}; }
}
function saveStatus(s) { fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 0), 'utf8'); }

// ── HTTP ───────────────────────────────────────────────────────
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/') {
    const html = PAGE();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (u.pathname === '/api/leads') {
    const status = loadStatus();
    const rows = LEADS.map((l, i) => ({ id: i, ...l, bracket: empBracket(l.emp), status: status[l.company]?.status || '', memo: status[l.company]?.memo || '' }));
    return sendJson(res, {
      total: rows.length,
      named: rows.filter(r => r.hasName).length,
      prefs: distinct('pref', 5).map(([v, c]) => ({ v, c })),
      industries: distinct('industry', 8).slice(0, 30).map(([v, c]) => ({ v, c })),
      segments: distinct('segment', 3).map(([v, c]) => ({ v, c })),
      rows,
    });
  }
  if (u.pathname === '/api/status' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { company, status, memo } = JSON.parse(body || '{}');
        if (!company) return sendJson(res, { ok: false, error: 'company required' }, 400);
        const all = loadStatus();
        all[company] = { status: status || '', memo: memo || '', at: new Date().toISOString() };
        if (!all[company].status && !all[company].memo) delete all[company];
        saveStatus(all);
        sendJson(res, { ok: true });
      } catch (e) { sendJson(res, { ok: false, error: String(e) }, 400); }
    });
    return;
  }
  if (u.pathname === '/api/reload') { LEADS = loadLeads(); return sendJson(res, { ok: true, total: LEADS.length }); }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  今週架電ダッシュボード 起動`);
  console.log(`  ───────────────────────────────`);
  console.log(`  ブラウザで開く →  http://localhost:${PORT}`);
  console.log(`  架電可能リード ${LEADS.length}社（うち担当者名あり ${LEADS.filter(l => l.hasName).length}社）`);
  console.log(`  停止: Ctrl+C\n`);
});

// ── フロント（1ファイル・依存なし・PC内で完結）──────────────────
function PAGE() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>今週架電ダッシュボード</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--ink:#1a1d21;--sub:#6b7280;--brand:#1f6feb;--brand2:#0b3d91;--ok:#16a34a;--warn:#d97706;--ng:#dc2626}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,"Segoe UI","Hiragino Kaku Gothic ProN","Meiryo",sans-serif;background:var(--bg);color:var(--ink)}
header{background:linear-gradient(90deg,var(--brand2),var(--brand));color:#fff;padding:14px 20px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:20}
header h1{font-size:17px;margin:0;font-weight:700}
header .kpi{margin-left:auto;display:flex;gap:18px;font-size:13px;opacity:.95}
header .kpi b{font-size:18px}
.controls{background:var(--card);border-bottom:1px solid var(--line);padding:10px 20px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;position:sticky;top:50px;z-index:19}
.controls input,.controls select{padding:7px 9px;border:1px solid var(--line);border-radius:7px;font-size:13px;background:#fff}
.controls input[type=search]{min-width:200px}
.controls .spacer{margin-left:auto}
.btn{padding:7px 12px;border:1px solid var(--line);background:#fff;border-radius:7px;cursor:pointer;font-size:13px}
.btn.primary{background:var(--brand);color:#fff;border-color:var(--brand)}
.btn:hover{filter:brightness(.97)}
.wrap{padding:14px 20px}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
thead th{background:#f0f2f5;text-align:left;padding:9px 10px;font-weight:600;color:var(--sub);border-bottom:1px solid var(--line);white-space:nowrap;cursor:pointer;user-select:none}
thead th:hover{color:var(--ink)}
tbody td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:hover{background:#f9fafb}
.co{font-weight:600}
.co a{color:var(--brand);text-decoration:none}.co a:hover{text-decoration:underline}
.sub{color:var(--sub);font-size:12px}
.tel{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700}
.b-mochi{background:#fff3d6;color:#92600a}
.b-seg{background:#eef2ff;color:#3949ab;font-weight:600}
.score{font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}
.s-hi{color:var(--ok)}.s-mid{color:var(--warn)}.s-lo{color:var(--sub)}
.name{font-weight:600}.noname{color:var(--sub);font-style:italic}
.stat{display:flex;gap:3px;flex-wrap:wrap}
.stat button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:2px 6px;font-size:11px;cursor:pointer}
.stat button.on-called{background:#e0f2fe;border-color:#7dd3fc}
.stat button.on-apo{background:#dcfce7;border-color:#86efac;font-weight:700}
.stat button.on-absent{background:#fef9c3;border-color:#fde047}
.stat button.on-ng{background:#fee2e2;border-color:#fca5a5}
.memo{margin-top:4px;width:100%;border:1px solid var(--line);border-radius:5px;font-size:11px;padding:3px 5px;resize:vertical;min-height:24px}
.empty{padding:40px;text-align:center;color:var(--sub)}
.count{color:var(--sub);font-size:13px;margin:0 0 8px}
tfoot{display:none}
</style></head><body>
<header>
  <h1>📞 今週架電ダッシュボード</h1>
  <div class="kpi">
    <div>架電可能 <b id="k-total">–</b></div>
    <div>担当者名あり <b id="k-named">–</b></div>
    <div>アポ <b id="k-apo">0</b></div>
    <div>架電済 <b id="k-called">0</b></div>
  </div>
</header>
<div class="controls">
  <input type="search" id="q" placeholder="会社名・担当者名・電話で検索">
  <select id="f-pref"><option value="">都道府県（全て）</option></select>
  <select id="f-ind"><option value="">業種（全て）</option></select>
  <select id="f-seg"><option value="">セグメント（全て）</option></select>
  <select id="f-emp"><option value="">規模（全て）</option><option>50-150</option><option>151-300</option><option>301-1000</option><option>〜49</option><option>1001〜</option><option>不明</option></select>
  <select id="f-mochi"><option value="">MOCHICA（全て）</option><option value="◎">◎のみ</option><option value="○">○以上</option></select>
  <label style="font-size:13px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="f-name">担当者名ありのみ</label>
  <label style="font-size:13px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="f-todo">未架電のみ</label>
  <div class="spacer"></div>
  <button class="btn" id="export">CSV書き出し</button>
  <button class="btn" id="reload" title="マスタ更新後に再読込">↻ 再読込</button>
</div>
<div class="wrap">
  <p class="count" id="count">読み込み中…</p>
  <table>
    <thead><tr>
      <th data-sort="score">期待度 ▾</th>
      <th data-sort="company">会社名</th>
      <th data-sort="phone">電話</th>
      <th data-sort="name">採用担当</th>
      <th data-sort="industry">業種 / 規模</th>
      <th data-sort="segment">セグメント / 提案</th>
      <th style="min-width:190px">架電結果</th>
    </tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div class="empty" id="empty" style="display:none">条件に一致する企業がありません</div>
</div>
<script>
let DATA=[], sortKey='score', sortDir=-1;
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function boot(){
  const r=await fetch('/api/leads'); const j=await r.json();
  DATA=j.rows;
  $('#k-total').textContent=j.total.toLocaleString();
  $('#k-named').textContent=j.named.toLocaleString();
  for(const p of j.prefs){const o=document.createElement('option');o.value=p.v;o.textContent=p.v+' ('+p.c+')';$('#f-pref').appendChild(o);}
  for(const i of j.industries){const o=document.createElement('option');o.value=i.v;o.textContent=(i.v.length>14?i.v.slice(0,14)+'…':i.v)+' ('+i.c+')';$('#f-ind').appendChild(o);}
  for(const s of j.segments){const o=document.createElement('option');o.value=s.v;o.textContent=s.v+' ('+s.c+')';$('#f-seg').appendChild(o);}
  render();
}
function kpiStatus(){
  let apo=0,called=0;for(const d of DATA){if(d.status==='apo')apo++;if(d.status&&d.status!=='ng')called++;}
  $('#k-apo').textContent=apo;$('#k-called').textContent=called;
}
function current(){
  const q=$('#q').value.trim(),pf=$('#f-pref').value,ind=$('#f-ind').value,seg=$('#f-seg').value,emp=$('#f-emp').value,mo=$('#f-mochi').value,nameOnly=$('#f-name').checked,todo=$('#f-todo').checked;
  let rows=DATA.filter(d=>{
    if(q&&!(d.company.includes(q)||d.name.includes(q)||d.phone.includes(q)))return false;
    if(pf&&d.pref!==pf)return false;
    if(ind&&d.industry!==ind)return false;
    if(seg&&d.segment!==seg)return false;
    if(emp&&d.bracket!==emp)return false;
    if(mo==='◎'&&!d.mochica.includes('◎'))return false;
    if(mo==='○'&&!(d.mochica.includes('◎')||d.mochica.includes('○')))return false;
    if(nameOnly&&!d.hasName)return false;
    if(todo&&d.status)return false;
    return true;
  });
  rows.sort((a,b)=>{let x=a[sortKey],y=b[sortKey];if(typeof x==='number')return (x-y)*sortDir;return String(x).localeCompare(String(y),'ja')*sortDir;});
  return rows;
}
function scoreCls(s){return s>=90?'s-hi':s>=70?'s-mid':'s-lo';}
function render(){
  const rows=current();
  $('#count').textContent=rows.length.toLocaleString()+' 社を表示（全'+DATA.length.toLocaleString()+'社中）';
  $('#empty').style.display=rows.length?'none':'block';
  const tb=$('#tb');tb.innerHTML='';
  const frag=document.createDocumentFragment();
  for(const d of rows.slice(0,600)){
    const tr=document.createElement('tr');
    const mochi=d.mochica?'<span class="badge b-mochi">'+esc(d.mochica)+'</span> ':'';
    const nm=d.hasName?'<span class="name">'+esc(d.name)+'</span>':'<span class="noname">担当者名なし</span>';
    const deptrole=[d.dept,d.role].filter(Boolean).join(' / ');
    const url=d.url?'<a href="'+esc(d.url)+'" target="_blank" rel="noopener">'+esc(d.company)+'</a>':esc(d.company);
    const seg=d.segment?'<span class="badge b-seg">'+esc(d.segment)+'</span>':'';
    tr.innerHTML=
      '<td><span class="score '+scoreCls(d.score)+'">'+d.score+'</span> '+mochi+'</td>'+
      '<td class="co">'+url+'<div class="sub">'+esc(d.pref||d.addr||'')+(d.shinsotsu?' ・新卒○':'')+(d.hire_n?' ・採用'+esc(d.hire_n)+'名':'')+'</div></td>'+
      '<td class="tel">'+esc(d.phone)+'</td>'+
      '<td>'+nm+(deptrole?'<div class="sub">'+esc(deptrole)+'</div>':'')+'<div class="sub">'+esc(d.call_to||'')+'</div></td>'+
      '<td>'+esc(d.industry||'')+'<div class="sub">'+esc(d.bracket)+(d.emp?'（'+esc(d.emp)+'名）':'')+'</div></td>'+
      '<td>'+seg+(d.plan?'<div class="sub">'+esc(d.plan)+'</div>':'')+'</td>'+
      '<td>'+statCell(d)+'</td>';
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  if(rows.length>600)$('#count').textContent+='（先頭600社を描画）';
  kpiStatus();
}
function statCell(d){
  const b=(k,l)=>'<button data-c="'+esc(d.company)+'" data-s="'+k+'" class="'+(d.status===k?'on-'+k:'')+'">'+l+'</button>';
  return '<div class="stat">'+b('called','架電済')+b('apo','アポ')+b('absent','不在')+b('ng','NG')+'</div>'+
    '<textarea class="memo" data-c="'+esc(d.company)+'" placeholder="メモ">'+esc(d.memo||'')+'</textarea>';
}
async function setStatus(company,status,memo){
  const d=DATA.find(x=>x.company===company);if(!d)return;
  if(status!==undefined){d.status=(d.status===status?'':status);}
  if(memo!==undefined){d.memo=memo;}
  await fetch('/api/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company,status:d.status,memo:d.memo})});
  kpiStatus();
}
document.addEventListener('click',e=>{
  const btn=e.target.closest('.stat button');
  if(btn){setStatus(btn.dataset.c,btn.dataset.s).then(render);return;}
});
document.addEventListener('change',e=>{
  if(e.target.classList.contains('memo')){setStatus(e.target.dataset.c,undefined,e.target.value);}
});
['#q','#f-pref','#f-ind','#f-seg','#f-emp','#f-mochi','#f-name','#f-todo'].forEach(s=>{
  $(s).addEventListener('input',render);$(s).addEventListener('change',render);
});
document.querySelectorAll('thead th[data-sort]').forEach(th=>{
  th.addEventListener('click',()=>{const k=th.dataset.sort;if(sortKey===k)sortDir*=-1;else{sortKey=k;sortDir=(k==='score')?-1:1;}
    document.querySelectorAll('thead th').forEach(t=>t.textContent=t.textContent.replace(/ [▾▴]$/,''));
    th.textContent+=sortDir<0?' ▾':' ▴';render();});
});
$('#export').addEventListener('click',()=>{
  const rows=current();
  const cols=['期待度','会社名','電話','採用担当者名','部署','役職','業種','都道府県','従業員数','MOCHICA','セグメント','提案プラン','新卒','採用予定人数','架電結果','メモ','公式URL'];
  const map={called:'架電済',apo:'アポ',absent:'不在',ng:'NG'};
  const esc2=v=>{v=String(v==null?'':v);return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;};
  const lines=[cols.join(',')];
  for(const d of rows)lines.push([d.score,d.company,d.phone,d.name,d.dept,d.role,d.industry,d.pref,d.emp,d.mochica,d.segment,d.plan,d.shinsotsu,d.hire_n,map[d.status]||'',d.memo,d.url].map(esc2).join(','));
  const blob=new Blob(['\\ufeff'+lines.join('\\n')],{type:'text/csv'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='今週架電_'+new Date().toISOString().slice(0,10)+'.csv';a.click();
});
$('#reload').addEventListener('click',async()=>{await fetch('/api/reload');location.reload();});
boot();
</script></body></html>`;
}
