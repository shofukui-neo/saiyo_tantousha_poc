'use strict';
// ============================================================================
//  精度ダッシュボード生成（履歴 → 自己完結HTML・外部依存なし）
//  履歴(history.jsonl の各行)を受け取り、最新値カード・判定バッジ・推移表・
//  スパークラインを描画した1枚のHTML文字列を返す。
// ============================================================================

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 数値配列を小さなSVG折れ線（スパークライン）に。higherBetterで色の意味は変えず、最新点だけ強調。
function spark(values, opts = {}) {
  const w = opts.w || 160, h = opts.h || 36, pad = 3;
  const vals = values.filter((v) => typeof v === 'number');
  if (vals.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (vals.length - 1);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<polyline fill="none" stroke="#4c8bf5" stroke-width="1.5" points="${pts}"/>`
    + `<circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.6" fill="#1a56db"/>`
    + `</svg>`;
}

function fmt(v, suf = '') { return v == null ? '—' : (v + suf); }

function buildHtml(history) {
  const runs = history.filter((h) => h && h.metrics);
  const latest = runs[runs.length - 1] || null;
  const baseline = [...runs].reverse().find((h) => h.kind === 'baseline') || null;
  const lastGate = [...runs].reverse().find((h) => h.kind === 'gate') || null;

  const series = (sel) => runs.map(sel);
  const wExtr = series((r) => r.metrics.wantedly.extractionRate);
  const wDict = series((r) => r.metrics.wantedly.dictFullRate);
  const wGarb = series((r) => r.metrics.wantedly.garbageRate);
  const icpMean = series((r) => r.metrics.icp.meanScore);

  const m = latest ? latest.metrics : null;
  const bm = baseline ? baseline.metrics : null;

  // 基準との差分（latest vs baseline）。
  const delta = (cur, base, suf = '%') => {
    if (cur == null || base == null) return '';
    const d = +(cur - base).toFixed(2);
    const cls = d < 0 ? 'down' : (d > 0 ? 'up' : 'flat');
    const sign = d > 0 ? '+' : '';
    return `<span class="delta ${cls}">${sign}${d}${suf}</span>`;
  };

  const card = (label, value, sub) => `
    <div class="card">
      <div class="lbl">${esc(label)}</div>
      <div class="val">${value}</div>
      <div class="sub">${sub || ''}</div>
    </div>`;

  const gateBadge = lastGate
    ? `<span class="badge ${lastGate.pass ? 'ok' : 'ng'}">${lastGate.pass ? '✓ 精度維持（PASS）' : '✗ 退行検出（FAIL）'}</span>`
    : `<span class="badge none">ゲート未実行</span>`;

  // 推移表（直近20件）
  const rows = runs.slice(-20).reverse().map((r) => {
    const w = r.metrics.wantedly, c = r.metrics.company, i = r.metrics.icp;
    const v = r.kind === 'gate' ? (r.pass ? '<span class="g ok">PASS</span>' : '<span class="g ng">FAIL</span>') : `<span class="g">${esc(r.kind)}</span>`;
    return `<tr>
      <td>${esc((r.at || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(r.label || '')}</td>
      <td class="mono">${esc(r.sha || '')}</td>
      <td class="num">${fmt(w.extractionRate, '%')}</td>
      <td class="num">${fmt(w.dictFullRate, '%')}</td>
      <td class="num">${fmt(w.garbageRate, '%')}</td>
      <td class="num">${fmt(c.garbage)}</td>
      <td class="num">${fmt(i.meanScore)}</td>
      <td>${v}</td>
    </tr>`;
  }).join('');

  const checks = lastGate && lastGate.checks ? lastGate.checks.map((c) =>
    `<li>${c.status === 'PASS' ? '✓' : '✗'} ${esc(c.name)} <span class="g ${c.status === 'PASS' ? 'ok' : 'ng'}">${c.status}</span></li>`).join('') : '';

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>精度ダッシュボード — 採用担当者名 / ICP適合</title>
<style>
  :root{--bg:#0f1419;--card:#1a2029;--ink:#e6e9ef;--mut:#9aa4b2;--line:#2a3340;--blue:#4c8bf5}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif}
  .wrap{max-width:1040px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 4px}
  .note{color:var(--mut);font-size:13px;margin:0 0 18px}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px}
  .badge.ok{background:#0f3d2e;color:#3ddc97;border:1px solid #1c6b4f}
  .badge.ng{background:#3d1414;color:#ff6b6b;border:1px solid #6b1c1c}
  .badge.none{background:#2a3340;color:var(--mut)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0 8px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .card .lbl{color:var(--mut);font-size:12px}
  .card .val{font-size:24px;font-weight:700;margin:2px 0}
  .card .sub{color:var(--mut);font-size:12px;min-height:18px}
  .delta{font-size:12px;font-weight:700;margin-left:6px}
  .delta.down{color:#ff6b6b}.delta.up{color:#3ddc97}.delta.flat{color:var(--mut)}
  h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid var(--line);padding-bottom:6px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}
  th{color:var(--mut);font-weight:600}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--mut)}
  .g{font-size:11px;color:var(--mut)} .g.ok{color:#3ddc97} .g.ng{color:#ff6b6b}
  ul.checks{list-style:none;padding:0;margin:8px 0;display:grid;gap:4px}
  ul.checks li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
  .sparks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
  .spk{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .spk .t{color:var(--mut);font-size:12px}
</style></head><body><div class="wrap">
  <h1>精度ダッシュボード — 採用担当者名 / ICP適合</h1>
  <p class="note">オフライン評価（data/scrape-cache の実HTML＋実レコード・決定論）。リファクタ前後で同じ母集団に当て、精度低下を機械検出します。${gateBadge}</p>

  <div class="cards">
    ${card('氏名 抽出率<br><small>(Wantedly・recall代理)</small>', (m ? m.wantedly.extractionRate + '%' : '—') + (bm ? delta(m.wantedly.extractionRate, bm.wantedly.extractionRate) : ''), m ? `抽出 ${m.wantedly.extracted}/${m.wantedly.pagesScanned}p` : '')}
    ${card('辞書フルネーム率<br><small>(precision質)</small>', (m ? m.wantedly.dictFullRate + '%' : '—') + (bm ? delta(m.wantedly.dictFullRate, bm.wantedly.dictFullRate) : ''), '高いほど良')}
    ${card('ゴミ率<br><small>(Wantedly・精度欠陥)</small>', (m ? m.wantedly.garbageRate + '%' : '—') + (bm ? delta(m.wantedly.garbageRate, bm.wantedly.garbageRate) : ''), m ? `${m.wantedly.garbage}件・0が理想` : '')}
    ${card('会社ページ ゴミ件数', (m ? m.company.garbage : '—') + (bm ? delta(m.company.garbage, bm.company.garbage, '') : ''), m ? `base抽出 ${m.company.baseHit}/${m.company.pagesScanned}p` : '')}
    ${card('ICP平均スコア', (m ? m.icp.meanScore : '—') + (bm ? delta(m.icp.meanScore, bm.icp.meanScore, '') : ''), m ? `採点 ${m.icp.recordsScored}件・中央 ${m.icp.medianScore}` : '')}
  </div>

  <h2>推移（スパークライン）</h2>
  <div class="sparks">
    <div class="spk"><div class="t">氏名 抽出率(Wantedly) %</div>${spark(wExtr)}</div>
    <div class="spk"><div class="t">辞書フルネーム率 %</div>${spark(wDict)}</div>
    <div class="spk"><div class="t">ゴミ率(Wantedly) % ＜低いほど良＞</div>${spark(wGarb)}</div>
    <div class="spk"><div class="t">ICP平均スコア</div>${spark(icpMean)}</div>
  </div>

  ${lastGate ? `<h2>最新ゲート判定の内訳</h2><ul class="checks">${checks}</ul>` : ''}

  <h2>実行履歴（直近20件）</h2>
  <table>
    <thead><tr><th>時刻(UTC)</th><th>ラベル</th><th>sha</th><th class="num">抽出率</th><th class="num">辞書FN率</th><th class="num">ゴミ率</th><th class="num">会社ゴミ</th><th class="num">ICP平均</th><th>種別</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="9">履歴なし</td></tr>'}</tbody>
  </table>

  <p class="note" style="margin-top:18px">生成: ${esc(new Date().toISOString())} ／ コマンド: <code>npm run eval:dashboard</code></p>
</div></body></html>`;
}

module.exports = { buildHtml };
