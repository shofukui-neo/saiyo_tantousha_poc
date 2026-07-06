'use strict';
// 採用ページURL(正リスト保有)を直接regexで叩き、公開されている採用担当者名を収穫する。
//   Gemini不要・robots遵守・増分flush・並列。工業系SMEでは歩留まり~2%（母集団の壁）。
//
//   node src/enrich-recruitpage.js --in <list.csv> --out data/recruiter-saiyo-tantou.csv [--limit N] [--conc 3]
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { politeGet } = require('./polite');
const { extractFromRecruitText, pageCorpus } = require('./probe-recruit-page');
const { isPlausiblePersonName } = require('./jp-names');
const { canonName } = require('./name-fusion');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', path.join('data', 'leads-mochica-target.csv'));
const OUT = getArg('out', path.join('data', 'recruiter-saiyo-tantou.csv'));
const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
const CONC = Math.max(1, parseInt(getArg('conc', '3'), 10) || 3);
const URL_COL = getArg('url-col', '採用ページURL');
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

async function run() {
  let recs = readCsv(fs.readFileSync(path.resolve(IN), 'utf8')).records
    .filter((r) => /^https?:\/\//.test(r[URL_COL] || ''));
  if (LIMIT) recs = recs.slice(0, LIMIT);
  log(`${URL_COL}保有 ${recs.length}社を処理（regex・Gemini非依存）`);

  const headers = ['企業名', '法人番号', '採用担当者名', '役職', '確度', URL_COL, '根拠', '取得日'];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  const flush = () => { const t = OUTABS + '.tmp'; fs.writeFileSync(t, toCsv(headers, out)); fs.renameSync(t, OUTABS); };

  let idx = 0, done = 0, hit = 0;
  async function worker() {
    while (true) {
      const my = idx++; if (my >= recs.length) return;
      const r = recs[my];
      let name = '', role = '', conf = '', ev = '';
      try {
        const p = await politeGet(r[URL_COL], { render: 'static' });
        if (p && p.html) {
          const ex = extractFromRecruitText(pageCorpus(p.html));
          if (ex && ex.name && isPlausiblePersonName(ex.name) && canonName(ex.name)) {
            name = canonName(ex.name).display; role = ex.role || '採用担当';
            conf = ex.confidence || 0.6; ev = String(ex.evidence || '').slice(0, 80);
          }
        }
      } catch (_) {}
      if (name) hit++;
      out.push({ 企業名: r['企業名'], 法人番号: r['法人番号'] || '', 採用担当者名: name, 役職: role,
        確度: conf, [URL_COL]: r[URL_COL], 根拠: ev, 取得日: today });
      if (++done % 10 === 0) { flush(); log(`  ${done}/${recs.length}（採用担当者名 ${hit}）`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  flush();
  log(`完了: ${done}社処理 ｜ 採用担当者名 ${hit}社（${(100 * hit / Math.max(1, done)).toFixed(0)}%）｜出力 ${OUTABS}`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
module.exports = { run };
