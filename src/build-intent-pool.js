'use strict';
/**
 * インテント採点の母集団づくり（層2の“件数”を広げる入口）
 * ============================================================================
 * これまで層2は 1,700〜2,600社の納品リストにだけ当てていた。統合マスタには
 * 28,000社あり、そのうち 18,800社はマイナビの corpID を持つ＝掲載面を取りに行ける。
 * つまり件数の制約は「取りに行けないこと」ではなく「入力を絞っていたこと」だった。
 *
 * ここは統合マスタ（または任意のCSV）から、採点しに行ける社だけを取り出して
 * インテント採点の入力を作る。取得できる系統を社ごとに判定して列に残すので、
 * 「なぜこの社は採点が薄いのか」が後から分かる。
 *
 * 使い方:
 *   npm run intent:pool                      … 統合マスタ全件から採点可能な社を出す
 *   node src/build-intent-pool.js --fetchable-only --out data/intent-pool.csv
 *
 * 主なオプション:
 *   --in <csv>         入力（既定 data/leads-consolidated-all.csv／カンマ区切りで複数可）
 *   --out <csv>        出力（既定 data/intent-pool.csv）
 *   --fetchable-only   マイナビ掲載面か公式URLを持つ社だけ（＝ネットワーク採点が効く社）
 *   --exclude-scored <csv>  既に採点済みのCSVを渡すと、その社を除いて差分だけ出す
 *   --limit N          先頭N社（0=全件）
 *   --order <mode>     並び順: intent（既定・取れる系統が多い順）| asis（入力のまま）
 *   --tier A,B         採点済みCSVを入力にした時、その階層だけを残す（深掘り2周目の入口）
 *
 * 2周目（深掘り）の使い方:
 *   広く浅く採った結果から熱い層だけを取り出し、重い系統（jobs/site）を当てる。
 *   求人ボックスはホスト単位で直列化されるため（polite.js）実測6秒/社。
 *   最強シグナルの S1（人事・採用担当の中途求人・重み40）はこの系統でしか立たない。
 *     npm run intent:deep:pool   →   npm run intent:deep
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName, normCorpNumber } = require('./csv');
const ngGuard = require('./ng-guard');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const hasFlag = (n) => process.argv.includes('--' + n);
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);

const INS = getArg('in', 'data/leads-consolidated-all.csv').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(ROOT, getArg('out', 'data/intent-pool.csv'));
const FETCHABLE_ONLY = hasFlag('fetchable-only');
const EXCLUDE_SCORED = getArg('exclude-scored', '');
const LIMIT = parseInt(getArg('limit', '0'), 10);
const ORDER = getArg('order', 'intent');
const TIERS = getArg('tier', '').split(',').map((x) => x.trim()).filter(Boolean);

// インテント採点が使う列。統合マスタの列名の揺れをここで吸収する。
const COLS = ['企業名', '架電宛名', '採用担当者名', '電話番号', 'メール', '業種', '従業員数', '都道府県', '卒年',
  '採用ページURL', '公式URL', 'corpID', '法人番号', '採用予定人数', '年間新卒採用人数', '採用実績(直近3年)',
  'アポ期待度', 'ICPランク', 'MOCHICA適合', '既存被り', '掲載媒体', 'インテント階層', 'インテントスコア', '取得可能系統', '採点優先度'];

const MYNAVI_CORP_RE = /job\.mynavi\.jp\/(\d{2})\/pc\/(?:search\/)?corp(\d+)/;

// その社で実際に効く取得系統を、持っているURLから判定する。
// 「採点したが薄かった」のか「そもそも取りに行けなかった」のかを後から切り分けるため、
// 推測ではなく“持っている一次情報”だけで決める。
function fetchableSources(rec) {
  const out = ['csv'];
  const page = String(rec['採用ページURL'] || '').trim();
  const corp = String(rec.corpID || '').trim() || (page.match(MYNAVI_CORP_RE) || [])[2] || '';
  if (corp) out.push('mynavi', 'faces');
  const site = String(rec['公式URL'] || '').trim();
  // マイナビ等の媒体URLが公式URL列に入っている行がある（実測2,234件）。自社サイトではない。
  if (site && !/job\.mynavi\.jp|rikunabi\.com|career-tasu|gakujo\.ne\.jp/.test(site)) out.push('site');
  if (String(rec['企業名'] || '').trim()) out.push('jobs');
  return { sources: out, corpID: corp };
}

// 採点の当たりやすさ＝取れる一次情報の多さ。ネットワーク採点が効く社を先に回す。
function poolPriority(rec, sources) {
  let p = 0;
  if (sources.includes('mynavi')) p += 40;     // 掲載面が取れる＝21軸のうち大半が動く
  if (sources.includes('site')) p += 15;       // 採用ページ＝メール/LINE/課題文面
  if (String(rec['電話番号'] || '').trim()) p += 15;   // 架電できない社を上位に置かない
  if (String(rec['採用担当者名'] || '').trim()) p += 10;
  const emp = parseInt(String(rec['従業員数'] || '').replace(/[^0-9]/g, ''), 10);
  if (Number.isFinite(emp) && emp >= 100 && emp <= 2000) p += 10;   // MOCHICAの主戦場
  const fit = parseFloat(rec['アポ期待度'] || rec['MOCHICA適合'] || '');
  if (Number.isFinite(fit)) p += Math.min(10, fit / 10);
  return Math.round(p * 10) / 10;
}

function keyOf(rec) {
  const cn = normCorpNumber(rec['法人番号']);
  if (cn) return 'C:' + cn;
  const corp = String(rec.corpID || '').trim();
  if (corp) return 'M:' + corp;
  const nm = normCompanyName(rec['企業名'] || '');
  return nm ? 'N:' + nm : null;
}

function main() {
  const rows = [];
  for (const rel of INS) {
    const f = path.resolve(ROOT, rel);
    if (!fs.existsSync(f)) { log('入力が見つかりません（飛ばす）: ' + rel); continue; }
    const { records } = readCsv(fs.readFileSync(f, 'utf8'));
    log(`読み込み ${records.length}社 ← ${rel}`);
    rows.push(...records);
  }
  if (!rows.length) { log('入力が空です'); process.exitCode = 1; return; }

  const 除外 = new Set();
  if (EXCLUDE_SCORED) {
    for (const rel of EXCLUDE_SCORED.split(',').map((s) => s.trim()).filter(Boolean)) {
      const f = path.resolve(ROOT, rel);
      if (!fs.existsSync(f)) { log('採点済みが見つかりません（飛ばす）: ' + rel); continue; }
      for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) { const k = keyOf(r); if (k) 除外.add(k); }
    }
    log(`採点済みとして除外: ${除外.size}社`);
  }

  const seen = new Set();
  const out = [];
  const stat = { 入力: rows.length, NG: 0, 重複: 0, 採点済み: 0, 取得不可: 0, 階層外: 0, mynavi: 0, site: 0 };
  for (const rec of rows) {
    const name = String(rec['企業名'] || '').trim();
    if (!name) continue;
    if (ngGuard.hit(name)) { stat.NG++; continue; }
    // 採点済みCSVを入力にした場合だけ効く（階層列を持たない入力は素通り）
    if (TIERS.length && rec['インテント階層'] && !TIERS.includes(rec['インテント階層'])) { stat.階層外++; continue; }
    const key = keyOf(rec);
    if (!key || seen.has(key)) { stat.重複++; continue; }
    if (除外.has(key)) { stat.採点済み++; continue; }
    seen.add(key);

    const { sources, corpID } = fetchableSources(rec);
    const ネット系統 = sources.filter((s) => s !== 'csv' && s !== 'jobs');
    if (FETCHABLE_ONLY && !ネット系統.length) { stat.取得不可++; continue; }
    if (sources.includes('mynavi')) stat.mynavi++;
    if (sources.includes('site')) stat.site++;

    const o = {};
    for (const c of COLS) o[c] = rec[c] ?? '';
    o.corpID = corpID;
    o['採用実績(直近3年)'] = rec['採用実績(直近3年)'] || rec['採用実績3年'] || '';
    o['都道府県'] = rec['都道府県'] || rec['本社'] || '';
    o.取得可能系統 = sources.join('+');
    o.採点優先度 = String(poolPriority(rec, sources));
    out.push(o);
  }

  if (ORDER === 'intent') out.sort((a, b) => parseFloat(b.採点優先度) - parseFloat(a.採点優先度));
  const final = LIMIT > 0 ? out.slice(0, LIMIT) : out;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, toCsv(COLS, final, { where: path.basename(OUT) }));

  log('---- インテント母集団 ----');
  log(`入力 ${stat.入力}社 → 出力 ${final.length}社`);
  log(`  架電禁止で除外 ${stat.NG}／名寄せ重複 ${stat.重複}／採点済みで除外 ${stat.採点済み}／取得系統なしで除外 ${stat.取得不可}`
    + (TIERS.length ? `／階層${TIERS.join('')}以外で除外 ${stat.階層外}` : ''));
  log(`  マイナビ掲載面あり ${stat.mynavi}社（21軸のうち卒年面5軸が動く）／自社サイトあり ${stat.site}社`);
  log('出力: ' + OUT);
  log('次: node src/intent-analyze.js --in ' + path.relative(ROOT, OUT) + ' --sources csv,mynavi,faces --conc 12 --resume');
}

if (require.main === module) main();
module.exports = { fetchableSources, poolPriority };
