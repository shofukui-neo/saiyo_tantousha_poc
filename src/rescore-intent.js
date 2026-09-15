'use strict';
/**
 * 採点し直し（取得はしない）
 * ============================================================================
 * 採点済みCSVの「シグナル内訳JSON」だけを使って、スコア・階層・総合優先度を
 * 今のコードで計算し直す。ネットワークには触らない。
 *
 * なぜ要るか:
 *   20,928社の取得に約90分かかる。重みや群上限を直すたびに取り直していては
 *   較正ができない。検知そのもの（どの軸がどの強度で立ったか）は取得時に確定していて、
 *   スコアはそこからの純粋な計算なので、採点だけやり直せる。
 *
 *   実際にこれが必要になった経緯: 追加5軸(face群)に群上限を付け忘れ、
 *   A階層が169社→467社に膨らんだ。上限を足した後、取り直さずに反映するために作った。
 *
 * できないこと:
 *   検知ルールそのもの（signals.js の判定）を変えた場合は作り直せない。
 *   一次情報の取得からやり直す必要がある（--sources を指定して intent-analyze.js）。
 *
 * 使い方:
 *   npm run intent:rescore
 *   node src/rescore-intent.js --in data/leads-intent-wide.csv [--out <csv>] [--dry]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { scoreIntent, talkGuide, whyNow, TIERS, TOP_WEIGHT } = require('./intent/score');
const { SIGNAL_LIST } = require('./intent/signals');
const { targetFit } = require('./intent/target-fit');
const { buildReport, statsFromRows } = require('./intent/report');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const hasFlag = (n) => process.argv.includes('--' + n);
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);

const IN = path.resolve(ROOT, getArg('in', 'data/leads-intent-wide.csv'));
const OUT = path.resolve(ROOT, getArg('out', getArg('in', 'data/leads-intent-wide.csv')));
const DRY = hasFlag('dry');
// 採点だけ直してレポートを置き去りにすると、CSVとmdで階層件数が食い違う。既定で作り直す。
const REPORT = getArg('report', '');
const NOW = new Date(getArg('now', '') || Date.now());

/**
 * 保存済みの内訳を scoreIntent が食える hit 配列に戻す。
 * 点数は群上限の適用後なので使わない。必ず 調整前点数（上限前）から strength を復元する。
 */
function hitsFromRow(rec) {
  let 内訳 = [];
  try { 内訳 = JSON.parse(rec['シグナル内訳JSON'] || '[]'); } catch (_) { return null; }
  if (!Array.isArray(内訳)) return null;
  return 内訳.map((d) => ({
    signal: d.signal, 名称: d.名称, 列: d.列, weight: d.weight,
    半減期日: (SIGNAL_LIST.find((s) => s.id === d.signal) || {}).半減期日,
    level: d.level, strength: d.strength, 根拠: d.根拠, 詳細: d.詳細 || {},
    検知日: d.検知日,
  })).filter((h) => h.signal && Number.isFinite(h.weight) && Number.isFinite(h.strength));
}

function main() {
  if (!fs.existsSync(IN)) { log('入力が見つかりません: ' + IN); process.exitCode = 1; return; }
  const { headers, records } = readCsv(fs.readFileSync(IN, 'utf8'));
  log(`入力 ${records.length}行 ← ${path.relative(ROOT, IN)}`);

  const before = { A: 0, B: 0, C: 0, D: 0 };
  const after = { A: 0, B: 0, C: 0, D: 0 };
  let 変化 = 0; let 内訳なし = 0;

  for (const rec of records) {
    before[rec['インテント階層']] = (before[rec['インテント階層']] || 0) + 1;
    const hits = hitsFromRow(rec);
    if (!hits) { 内訳なし++; after[rec['インテント階層']] = (after[rec['インテント階層']] || 0) + 1; continue; }
    const res = scoreIntent(hits, { now: NOW });
    const fit = targetFit(rec, {}, res);

    if (String(res.階層) !== String(rec['インテント階層'])) 変化++;
    rec['インテントスコア'] = String(res.スコア);
    rec['インテント階層'] = res.階層;
    rec['最有力シグナル'] = res.最有力 || '—';
    rec['シグナル強度'] = res.最有力レベル || '';
    rec['検知シグナル'] = res.検知シグナル || '';
    rec['なぜ今'] = whyNow(res);
    rec['根拠'] = res.根拠 || '';
    rec['推奨トーク'] = talkGuide(res);
    rec['総合優先度'] = String(fit.priority);
    rec['推奨アクション'] = fit.action;
    rec['シグナル内訳JSON'] = JSON.stringify(res.内訳);
    for (const s of SIGNAL_LIST) rec[s.列] = '';
    for (const d of res.内訳) rec[d.列] = `${d.level}(${d.点数})`;
    after[res.階層] = (after[res.階層] || 0) + 1;
  }

  records.sort((a, b) => parseFloat(b['総合優先度']) - parseFloat(a['総合優先度'])
    || parseFloat(b['インテントスコア']) - parseFloat(a['インテントスコア']));
  records.forEach((r, i) => { r.No = String(i + 1); });

  log('---- 採点し直し ----');
  const pct = (n) => Math.round(n / Math.max(1, records.length) * 100) + '%';
  for (const t of TIERS.map((x) => x.tier)) {
    log(`  ${t}: ${before[t] || 0}（${pct(before[t] || 0)}） → ${after[t] || 0}（${pct(after[t] || 0)}）`);
  }
  log(`階層が変わった行: ${変化}／内訳JSONが無く据え置いた行: ${内訳なし}`);

  if (DRY) { log('--dry のため書き込みません'); return; }
  fs.writeFileSync(OUT, toCsv(headers, records, { where: path.basename(OUT) }));
  log('出力: ' + OUT);

  // レポートも作り直す（既定は <out> と同じ名前の .md。無ければ出さない）
  const rep = REPORT ? path.resolve(ROOT, REPORT) : OUT.replace(/\.csv$/i, '.md');
  const 既存 = fs.existsSync(rep);
  if (既存 || REPORT) {
    fs.writeFileSync(rep, buildReport(records, statsFromRows(records, SIGNAL_LIST), {
      signalList: SIGNAL_LIST, tiers: TIERS, topWeight: TOP_WEIGHT,
      入力: path.relative(ROOT, IN) + '（採点し直し）', 系統: '再採点のみ（取得なし）',
      top: parseInt(getArg('top', '80'), 10),
    }));
    log('レポート: ' + rep);
  } else {
    log('レポートは作りません（' + path.relative(ROOT, rep) + ' が無いため）');
  }
}

if (require.main === module) main();
module.exports = { hitsFromRow };
