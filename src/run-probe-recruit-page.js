'use strict';
// 採用担当者名プローブ①（自社採用ページ）を実データに当てる単発ランナー。
//  入力: data/gbiz-records.json（公式URL保有577社）。Geminiキー不要・robots遵守・キャッシュ利用。
//  出力: data/recruiter-recruitpage.csv（HITした社のみ）＋ コンソールに歩留まり。
//  使い方:
//    node src/run-probe-recruit-page.js --limit 30 --concurrency 3
//    node src/run-probe-recruit-page.js --limit 0            # 0=公式URL全件
const fs = require('fs');
const path = require('path');
const { toCsv } = require('./csv');
const { probeRecruitPage } = require('./probe-recruit-page');
const { closeBrowser } = require('./fetch');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = path.resolve(__dirname, '..', getArg('in', 'data/gbiz-records.json'));
const OUT = path.resolve(__dirname, '..', getArg('out', 'data/recruiter-recruitpage.csv'));
const LIMIT = parseInt(getArg('limit', '30'), 10);
const CONC = parseInt(getArg('concurrency', '3'), 10) || 3;

const HEADERS = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠'];

async function main() {
  const t0 = Date.now();
  const records = JSON.parse(fs.readFileSync(IN, 'utf8'));
  let targets = records.filter((r) => String(r['公式URL'] || '').trim() && !String(r['採用担当者名'] || '').trim());
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  console.log(`対象 ${targets.length}社（公式URLあり・採用担当者名未取得）｜並列${CONC}｜エンジン: 採用ページ特化・正規表現（API不要）`);

  const hits = [];
  let done = 0, idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const rec = targets[idx++];
      try {
        const r = await probeRecruitPage(rec['公式URL']);
        if (r) {
          hits.push({
            '企業名': rec['企業名'], '公式URL': rec['公式URL'],
            '採用担当者名': r.name, '役職': r.role, '部署': r.department,
            '確度': r.confidence.toFixed(2), '取得元': r.source,
            '根拠URL': r.sourceUrl, '根拠': r.evidence,
          });
          console.log(`  ✓ ${rec['企業名']} → ${r.name}（${r.role || '役職?'}・確度${r.confidence.toFixed(2)}）`);
        }
      } catch (_) { /* 個社失敗はスキップ */ }
      done++;
      if (done % 20 === 0) console.log(`  …${done}/${targets.length}（HIT ${hits.length}）`);
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
