'use strict';
// 既存の採用担当者名つきリスト（非マイナビ）と対象リストを社名突合し、採用担当者名を充填する。
//   本セッション最大の採用担当者名レバー（正リストで 0.5%→8%・スクレイピング不要）。
//   源データ(旧harvest)は姓連結・ふりがな・住所断片ノイズを含むため必ず品質パスを通す。
//
//   node src/enrich-crossref.js --file data/leads-mochica-target-enriched.csv [--no-rescore]
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { canonName } = require('./name-fusion');
const { isPlausiblePersonName, splitName, isKnownSurname, isFullName } = require('./jp-names');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const FILE = getArg('file', path.join('data', 'leads-mochica-target-enriched.csv'));
const RESCORE = !process.argv.includes('--no-rescore');
const INCLUDE_MYNAVI = process.argv.includes('--include-mynavi');
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

// 既存の採用担当者名つきリスト（優先度順・クリーンな源を先に）。存在するものだけ使う。
const SOURCES = [
  'data/recruiter-wantedly.csv', 'data/recruiter-nonwantedly-clean.csv', 'data/recruiter-adaptive.csv',
  'data/leads-prtimes-named-1000.csv', 'data/recruiter-scored-all.csv', 'sources/A-names-from-cache.csv',
  'leads-mochica-named-consolidated.csv',
];

/**
 * 突合で得た氏名の品質クリーニング（源データのノイズを落とす）。
 * @returns クリーンな氏名 or null（不採用）
 */
function cleanCrossRefName(raw) {
  const cn = canonName(raw);
  if (!cn || !isPlausiblePersonName(cn.display)) return null;
  let name = cn.display;
  const parts = name.split(' ');
  if (parts.length === 2) {
    const [sei, mei] = parts;
    if (/^[ァ-ヶー]+$/.test(mei)) return sei;                       // ①ふりがな誤取り → 姓のみ
    if (/[県市区町村都府内]/.test(mei)) return sei;                  // ④住所断片 → 姓のみ
    const sp = splitName(mei);
    if (sp && sp.sei === mei && sp.mei === '') return sei;          // ②名が完全な姓＝連結 → 姓のみ
    if (isKnownSurname(mei) && !isFullName(name)) return sei;       // ②連結（別判定）
    if (mei.length === 2 && /[沢澤野尾崎浜塩窪郷]$/.test(mei)) return sei; // ③姓サフィックス連結 → 姓のみ
  }
  return name;
}

function loadIndex() {
  const idx = new Map();
  for (const f of SOURCES) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) continue;
    let recs = [];
    try { recs = readCsv(fs.readFileSync(abs, 'utf8')).records; } catch (_) { continue; }
    for (const r of recs) {
      if (!INCLUDE_MYNAVI && /マイナビ|mynavi/i.test(r['取得元'] || r['取得手法'] || '')) continue;
      const raw = (r['採用担当者名'] || r['氏名'] || '').trim();
      if (!raw) continue;
      const k = normCompanyName(r['企業名']);
      if (!k || idx.has(k)) continue;
      const name = cleanCrossRefName(raw);
      if (name) idx.set(k, { name, src: path.basename(f) });
    }
  }
  return idx;
}

function run() {
  const ABS = path.resolve(FILE);
  const idx = loadIndex();
  log(`既存の採用担当者名つき（濾過後）: ${idx.size}社`);
  const { records, headers } = readCsv(fs.readFileSync(ABS, 'utf8'));
  const cols = headers || Object.keys(records[0]);
  let fill = 0;
  for (const r of records) {
    if ((r['採用担当者名'] || '').trim()) continue;
    const h = idx.get(normCompanyName(r['企業名']));
    if (h) { r['採用担当者名'] = h.name; if (r['採用担当者名取得元'] !== undefined) r['採用担当者名取得元'] = '既存リスト突合(' + h.src + ')'; fill++; }
  }
  if (RESCORE) {
    const { scoreMochica } = require('./mochica-fit');
    for (const r of records) { const s = scoreMochica(r);
      if (r['アポ期待度'] !== undefined) r['アポ期待度'] = String(s.total);
      if (r['優先度'] !== undefined) r['優先度'] = s.priority;
      if (r['確信度'] !== undefined) r['確信度'] = String(s.confidence); }
  }
  const tmp = ABS + '.tmp'; fs.writeFileSync(tmp, toCsv(cols, records)); fs.renameSync(tmp, ABS);
  const tan = records.filter((r) => (r['採用担当者名'] || '').trim()).length;
  log(`突合充填 ${fill}社 ｜ 採用担当者名 実効 ${tan}/${records.length} (${(100 * tan / records.length).toFixed(0)}%)${RESCORE ? ' ｜再スコア済' : ''}`);
}

if (require.main === module) run();
module.exports = { cleanCrossRefName, loadIndex };
