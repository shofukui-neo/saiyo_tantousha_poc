'use strict';
/**
 * マイナビ掲載企業のうち、会社概要を一度も検証していない corpID を検証する
 * =====================================================================
 * 既存の検証台帳（data/fresh-verify.json・data/leads-intent-wide.csv の corpID）に無い社だけを
 * verify-fresh-hire.js の verifyOne（会社概要 outline.html を素のHTTPで取得・28/27卒の両面）で埋める。
 * コーパスは旧版（data/mynavi-20XX-corpus.csv）と再列挙版（data/allmedia/mynavi-XX-corpus.csv）の和。
 *
 * 出力: data/allmedia/mynavi-verify.json（corpID → verifyOne の結果）
 * 使い方: node src/allmedia/mynavi-verify.js [--conc 6] [--delay 120] [--limit 0]
 */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('../csv');
const { verifyOne } = require('../verify-fresh-hire');
const { Journal, runPool, log, getArg } = require('./http');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'allmedia', 'mynavi-verify.json');
const CONC = parseInt(getArg('conc', '6'), 10);
const DELAY = parseInt(getArg('delay', '120'), 10);
const LIMIT = parseInt(getArg('limit', '0'), 10);
const CORPORA = [
  ['data/allmedia/mynavi-28-corpus.csv', '28'], ['data/allmedia/mynavi-27-corpus.csv', '27'],
  ['data/mynavi-2028-corpus.csv', '28'], ['data/mynavi-2027-corpus.csv', '27'],
];

function corpusIds() {
  const m = new Map();
  for (const [rel, gy] of CORPORA) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) {
      const id = String(r.corpID || '').trim();
      if (id && !m.has(id)) m.set(id, { id, gy, name: String(r['企業名'] || '').trim() });
    }
  }
  return m;
}
// --include-ledger: インテント台帳にしか居ない社（会社概要を一度も検証していない社）も対象にする。
// 台帳の 本社/従業員数 は統合マスタ由来で空欄が多く（実測: 採用候補の16%が都道府県不明）、採用実績も9月時点のため。
const INCLUDE_LEDGER = process.argv.includes('--include-ledger');
function verifiedIds() {
  const s = new Set();
  const fv = path.join(ROOT, 'data', 'fresh-verify.json');
  if (fs.existsSync(fv)) for (const r of Object.values(JSON.parse(fs.readFileSync(fv, 'utf8')))) if (r && r.corpID && r.ok) s.add(String(r.corpID));
  const iw = path.join(ROOT, 'data', 'leads-intent-wide.csv');
  if (!INCLUDE_LEDGER && fs.existsSync(iw)) {
    // 2万行・74MBを丸ごとオブジェクト化せず、corpID 列だけ拾う
    const txt = fs.readFileSync(iw, 'utf8');
    for (const m of txt.matchAll(/job\.mynavi\.jp\/\d{2}\/pc\/search\/corp(\d+)\//g)) s.add(m[1]);
  }
  return s;
}

async function main() {
  const all = corpusIds();
  const done = verifiedIds();
  const j = new Journal(OUT);
  let todo = [...all.values()].filter((c) => !done.has(c.id) && !j.has(c.id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  log(`マイナビ corpus ${all.size}社 ／ 検証済 ${done.size} ／ 本台帳 ${j.size} → 未検証 ${todo.length}社（並列${CONC}）`);
  const st = { ok: 0, ng: 0, hire6: 0 };
  await runPool(todo, async (c) => {
    const v = await verifyOne({ id: c.id, gy: c.gy, name: c.name });
    if (!v.ok) { j.set(c.id, { corpID: c.id, 企業名: c.name, 失敗: v.reason }); st.ng++; return; }
    j.set(c.id, v); st.ok++; if (v.実績人数 >= 6) st.hire6++;
  }, { conc: CONC, delay: DELAY, every: 200, onFlush: () => j.flush(), onProgress: (d, t) => log(`  マイナビ ${d}/${t} 取得${st.ok} 失敗${st.ng} 6名以上${st.hire6}`) });
  log(`完了: 台帳 ${j.size}社 → ${path.relative(ROOT, OUT)}`);
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { OUT, corpusIds };
