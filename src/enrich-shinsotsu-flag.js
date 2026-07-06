'use strict';
// 新卒フラグ無×採用ページURL有の社の採用ページを見て、新卒採用の記載があれば新卒フラグ/新卒言及を補完。
//   Gemini不要・robots遵守。対象CSVを直接更新し、mochica-fitで再スコアする。
//
//   node src/enrich-shinsotsu-flag.js --file data/leads-mochica-target-enriched.csv [--conc 3]
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { fetchStatic } = require('./fetch');
const { visibleText } = require('./probe-recruit-page');
const { scoreMochica } = require('./mochica-fit');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const FILE = getArg('file', path.join('data', 'leads-mochica-target-enriched.csv'));
const CONC = Math.max(1, parseInt(getArg('conc', '3'), 10) || 3);
const RESCORE = !process.argv.includes('--no-rescore');
const SHINSOTSU = /(新卒採用|新卒募集|新卒者|新規学卒|20\d\d年卒|新卒エントリー|新卒の?方|新卒予定|定期採用|春入社|来春.{0,4}入社)/;
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

async function run() {
  const ABS = path.resolve(FILE);
  const { records, headers } = readCsv(fs.readFileSync(ABS, 'utf8'));
  const targets = records.filter((r) => !(r['新卒フラグ'] || '').trim() && /^https?:\/\//.test(r['採用ページURL'] || ''));
  log(`新卒フラグ補完候補（フラグ無×採用ページURL有）: ${targets.length}社`);
  const cols = headers || Object.keys(records[0]);
  const flush = () => { const t = ABS + '.tmp'; fs.writeFileSync(t, toCsv(cols, records)); fs.renameSync(t, ABS); };

  let idx = 0, done = 0, hit = 0;
  async function worker() {
    while (true) {
      const my = idx++; if (my >= targets.length) return;
      const r = targets[my];
      try {
        const p = await fetchStatic(r['採用ページURL']);
        if (p && p.html && SHINSOTSU.test(visibleText(p.html))) {
          r['新卒フラグ'] = '1'; if (r['新卒言及'] !== undefined) r['新卒言及'] = '採用ページに新卒採用の記載'; hit++;
        }
      } catch (_) {}
      if (++done % 20 === 0) { flush(); log(`  ${done}/${targets.length}（新卒補完 ${hit}）`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  if (RESCORE) {
    for (const r of records) { const s = scoreMochica(r);
      if (r['アポ期待度'] !== undefined) r['アポ期待度'] = String(s.total);
      if (r['優先度'] !== undefined) r['優先度'] = s.priority;
      if (r['確信度'] !== undefined) r['確信度'] = String(s.confidence); }
  }
  flush();
  const tier = {}; for (const r of records) tier[r['優先度']] = (tier[r['優先度']] || 0) + 1;
  log(`完了: 新卒フラグ補完 ${hit}社 ｜ ${RESCORE ? '再スコア後ティア ' + JSON.stringify(tier) : '再スコアなし'}`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { run };
