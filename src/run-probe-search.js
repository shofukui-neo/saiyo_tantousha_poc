'use strict';
// 検索ファースト・プローブ②を実データに当てる単発ランナー（APIキー不要）。
//  入力: data/gbiz-records.json。出力: data/recruiter-search.csv（HIT社のみ）＋歩留まり。
//  使い方:
//    node src/run-probe-search.js --limit 20 --concurrency 2
//    node src/run-probe-search.js --limit 20 --fetchPages 1   # スニペット不発時に上位1ページ取得
const fs = require('fs');
const path = require('path');
const { toCsv } = require('./csv');
const { probeSearch } = require('./probe-search');
const { closeBrowser } = require('./fetch');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = path.resolve(__dirname, '..', getArg('in', 'data/gbiz-records.json'));
const OUT = path.resolve(__dirname, '..', getArg('out', 'data/recruiter-search.csv'));
const LIMIT = parseInt(getArg('limit', '20'), 10);
const CONC = parseInt(getArg('concurrency', '2'), 10) || 2; // 検索は低並列でレートに配慮
const FETCH = parseInt(getArg('fetchPages', '0'), 10) || 0;

const HEADERS = ['企業名', '採用担当者名', '役職', '部署', '確度', '取得元', '経路', '根拠URL', '根拠', 'クエリ'];

async function main() {
  const t0 = Date.now();
  const records = JSON.parse(fs.readFileSync(IN, 'utf8'));
  let targets = records.filter((r) => String(r['企業名'] || '').trim() && !String(r['採用担当者名'] || '').trim());
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  console.log(`対象 ${targets.length}社 ｜並列${CONC}｜fetchPages=${FETCH}｜検索ファースト（ソース横断・APIキー不要）`);

  const hits = [];
  let done = 0, idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const rec = targets[idx++];
      try {
        const r = await probeSearch(rec['企業名'], { fetchPages: FETCH });
        if (r) {
          hits.push({
            '企業名': rec['企業名'], '採用担当者名': r.name, '役職': r.role, '部署': r.department,
            '確度': r.confidence.toFixed(2), '取得元': r.source, '経路': r.via,
            '根拠URL': r.sourceUrl, '根拠': r.evidence, 'クエリ': r.query,
          });
          console.log(`  ✓ ${rec['企業名']} → ${r.name}（${r.source}・${r.via}・確度${r.confidence.toFixed(2)}）`);
        }
      } catch (_) { /* skip */ }
      done++;
      if (done % 10 === 0) console.log(`  …${done}/${targets.length}（HIT ${hits.length}）`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, () => worker()));
  await closeBrowser();

  fs.writeFileSync(OUT, toCsv(HEADERS, hits));
  const rate = targets.length ? (hits.length / targets.length * 100).toFixed(1) : '0';
  console.log(`\n===== 完了 ｜ HIT ${hits.length}/${targets.length}社（歩留まり ${rate}%）｜${((Date.now() - t0) / 1000).toFixed(0)}秒 =====`);
  console.log(`出力: ${OUT}`);
}

main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); closeBrowser().finally(() => process.exit(1)); });
