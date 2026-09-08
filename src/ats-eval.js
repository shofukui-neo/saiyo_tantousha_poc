'use strict';
/**
 * ats-eval — ATS判定の精度を「目視した正解」に照らして測る
 * =====================================================================
 * data/ats-truth.csv（2026-08-28に人が目視した35社の正解）と、
 * スキャン結果（data/ats-scan/ats-scan-all.csv 等）を突き合わせて精度を出す。
 *
 * 見るべき指標はひとつだけ:
 *
 *   **誤出荷 = 0**  … 「確定」と言い切った行のうち、正解では新卒で使っていなかった数。
 *
 * 営業リストは誤りが1件でも入ると架電が空振りする。取りこぼし（確定にできなかった正解）は
 * 要確認CSVに残って目視に回せるので、再現率より誤出荷ゼロを優先する。
 *
 * 正解ファイルの列:
 *   企業名 / ホスト / 旧判定ATS / 監査結果（正解・誤り・要注意）/ 新卒ATS
 *   / 許容グレード（`|`区切り。この判定グレードなら合格）/ 備考 / 実際のURL
 *
 * 使い方:
 *   node src/ats-eval.js                                   # 既定のスキャン結果を採点
 *   node src/ats-eval.js --scan data/ats-scan/ats-scan-確定.csv
 *   node src/ats-eval.js --truth data/ats-truth.csv --verbose
 *   node src/ats-eval.js --legacy                          # 旧ロジック（旧判定ATS列）の精度を出す＝比較用
 */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('./csv');
const { getArg, log } = require('./cli-util');
const { hostOfUrl } = require('./ats');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TRUTH = path.resolve(String(getArg('truth', path.join(DATA, 'ats-truth.csv'))));
const SCAN = path.resolve(String(getArg('scan', path.join(DATA, 'ats-scan', 'ats-scan-all.csv'))));
const VERBOSE = !!getArg('verbose', false);
const LEGACY = !!getArg('legacy', false);

const norm = (s) => String(s || '').trim();
/** ホストは www を落として比較（正解ファイルとスキャン結果で表記が揺れる）。 */
const hkey = (s) => hostOfUrl(norm(s)) || norm(s).replace(/^www\./i, '').toLowerCase();

function loadTruth() {
  if (!fs.existsSync(TRUTH)) {
    console.error(`正解ファイルがありません: ${TRUTH}`);
    console.error('  目視結果を 企業名,ホスト,旧判定ATS,監査結果,新卒ATS,許容グレード,備考,実際のURL の形で置いてください。');
    process.exit(1);
  }
  const { records } = readCsv(fs.readFileSync(TRUTH, 'utf8'));
  return records.map((r) => ({
    name: norm(r['企業名']),
    host: hkey(r['ホスト']),
    legacyAts: norm(r['旧判定ATS']),
    verdict: norm(r['監査結果']),
    trueAts: norm(r['新卒ATS']),
    allow: norm(r['許容グレード']).split('|').map(norm).filter(Boolean),
    note: norm(r['備考']),
  })).filter((t) => t.host);
}

function loadScan() {
  if (!fs.existsSync(SCAN)) {
    console.error(`スキャン結果がありません: ${SCAN}`);
    console.error('  先に `npm run ats:all` を回すか、--scan で別のCSVを指定してください。');
    process.exit(1);
  }
  const { records } = readCsv(fs.readFileSync(SCAN, 'utf8'));
  const byHost = new Map();
  for (const r of records) {
    const h = hkey(r['ホスト'] || r['起点URL']);
    if (h && !byHost.has(h)) byHost.set(h, r);
  }
  return byHost;
}

/**
 * 1社の判定を採点する。
 * @returns {'誤出荷'|'正解'|'取りこぼし'|'保留(妥当)'|'未スキャン'}
 */
function judge(t, row) {
  if (!row) return '未スキャン';
  const grade = norm(row['判定グレード']);
  const ats = norm(row['ATS']);

  // 「確定」と言い切った行 → 正解の新卒ATSと一致していなければ誤出荷
  if (grade === '確定' || (!grade && ats)) {
    if (!t.trueAts) return '誤出荷';                       // 新卒でATSを使っていない会社を確定にした
    return sameAts(ats, t.trueAts) ? '正解' : '誤出荷';
  }
  // 確定にしなかった行。正解が「確定であるべき」なら取りこぼし、そうでなければ妥当な保留
  if (t.allow.includes('確定') && t.allow.length === 1) return '取りこぼし';
  return t.allow.includes(grade) || !t.allow.length ? '保留(妥当)' : '保留(妥当)';
}

/** ツール名の同一視（表記ゆれ・i-web/i-webs 等）。 */
function sameAts(a, b) {
  const k = (s) => String(s || '').toLowerCase().replace(/[\s　・－ー\-_（）()]/g, '')
    .replace(/採用$/, '').replace(/s$/, '');
  return !!a && !!b && (k(a) === k(b) || k(a).includes(k(b)) || k(b).includes(k(a)));
}

/** 旧ロジック（正解ファイルの「旧判定ATS」列＝2026-08-28のスキャン結果）を同じ物差しで採点。 */
function judgeLegacy(t) {
  if (!t.legacyAts) return '保留(妥当)';
  if (!t.trueAts) return '誤出荷';
  return sameAts(t.legacyAts, t.trueAts) ? '正解' : '誤出荷';
}

function run() {
  const truth = loadTruth();
  log(`正解 ${truth.length}社を読込（${path.basename(TRUTH)}）`);
  const scan = LEGACY ? null : loadScan();
  if (scan) log(`スキャン結果 ${scan.size}社を読込（${path.basename(SCAN)}）`);

  const tally = new Map();
  const rows = [];
  for (const t of truth) {
    const row = scan ? scan.get(t.host) : null;
    const result = LEGACY ? judgeLegacy(t) : judge(t, row);
    tally.set(result, (tally.get(result) || 0) + 1);
    rows.push({ t, row, result });
  }

  const n = (k) => tally.get(k) || 0;
  const scanned = truth.length - n('未スキャン');
  const shipped = n('正解') + n('誤出荷');

  console.log(`\n[ats-eval] ${LEGACY ? '旧ロジック（2026-08-28のスキャン）' : path.basename(SCAN)}`);
  console.log(`  対象          ${truth.length}社（うちスキャン済み ${scanned}社）`);
  console.log(`  確定として出力 ${shipped}社`);
  console.log(`    正解        ${n('正解')}社`);
  console.log(`    ★誤出荷     ${n('誤出荷')}社  ← ここが0でないと営業リストに載せられない`);
  console.log(`  保留(妥当)     ${n('保留(妥当)')}社（中途利用・新卒なし等を正しく落とせた）`);
  console.log(`  取りこぼし     ${n('取りこぼし')}社（本当は確定にできたはずの正解）`);
  if (n('未スキャン')) console.log(`  未スキャン     ${n('未スキャン')}社`);
  if (shipped) console.log(`\n  適合率（確定のうち正しかった割合） ${(100 * n('正解') / shipped).toFixed(1)}%`);
  const recallable = truth.filter((t) => t.allow.includes('確定')).length;
  if (recallable) console.log(`  再現率（確定にすべき ${recallable}社のうち確定にできた割合） ${(100 * n('正解') / recallable).toFixed(1)}%`);

  const bad = rows.filter((r) => r.result === '誤出荷');
  if (bad.length) {
    console.log(`\n[ats-eval] 誤出荷の内訳`);
    for (const r of bad) {
      const got = LEGACY ? r.t.legacyAts : norm(r.row && r.row['ATS']);
      console.log(`  ✗ ${r.t.name}`);
      console.log(`      出力: ${got || '（空）'} ／ 正解: ${r.t.trueAts || '新卒では未使用'}`);
      console.log(`      ${r.t.note}`);
      if (!LEGACY && r.row) console.log(`      根拠: ${norm(r.row['新卒根拠'])} ｜ URL: ${norm(r.row['ATS URL'])}`);
    }
  }
  if (VERBOSE) {
    console.log(`\n[ats-eval] 全件`);
    for (const r of rows) {
      const g = LEGACY ? `旧:${r.t.legacyAts || '—'}` : `${norm(r.row && r.row['判定グレード']) || '未'}:${norm(r.row && r.row['ATS']) || '—'}`;
      console.log(`  ${r.result.padEnd(10)} ${g.padEnd(28)} ${r.t.name}`);
    }
  }
  if (!LEGACY) console.log(`\n  比較: node src/ats-eval.js --legacy  で改訂前の数字が出ます`);
  process.exitCode = n('誤出荷') > 0 ? 1 : 0;   // 誤出荷があればCIで落とす
}

if (require.main === module) run();
module.exports = { judge, judgeLegacy, sameAts, loadTruth };
