'use strict';
// 採用担当者名プローブ①（自社採用ページ）を実データに当てる単発ランナー（レジューム対応）。
//  入力: data/gbiz-records.json（公式URL保有577社）。Geminiキー不要・robots遵守・キャッシュ利用。
//  出力: data/recruiter-recruitpage.csv（HIT社のみ）＋ data/recruitpage-done.json（処理済みジャーナル）。
//  fetch層（undici）が稀に内部assertionでプロセスごと落ちるため、処理済みを記録し再起動で続きから走る。
//  ページはキャッシュ済みのため再起動の追加コストは小さい。何度か起動すれば完走する。
//  使い方:
//    node src/run-probe-recruit-page.js --limit 0 --concurrency 3       # 0=公式URL全件
//    node src/run-probe-recruit-page.js --reset                         # ジャーナルを消して最初から
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
const DONE = path.resolve(__dirname, '..', getArg('done', 'data/recruitpage-done.json'));
const LIMIT = parseInt(getArg('limit', '30'), 10);
const CONC = parseInt(getArg('concurrency', '3'), 10) || 3;
const RESET = !!getArg('reset', false);

const HEADERS = ['企業名', '公式URL', '採用担当者名', '役職', '部署', '確度', '取得元', '根拠URL', '根拠'];
const keyOf = (r) => String(r['法人番号'] || r['企業名'] || '');

async function main() {
  const t0 = Date.now();
  const records = JSON.parse(fs.readFileSync(IN, 'utf8'));

  if (RESET) { try { fs.unlinkSync(DONE); } catch (_) {} try { fs.unlinkSync(OUT); } catch (_) {} }

  // 処理済みジャーナル（{ done:[キー], hits:[行] }）を復元
  let doneKeys = new Set(), hits = [];
  if (fs.existsSync(DONE)) {
    try { const j = JSON.parse(fs.readFileSync(DONE, 'utf8')); doneKeys = new Set(j.done || []); hits = j.hits || []; } catch (_) {}
  }

  let targets = records.filter((r) => String(r['公式URL'] || '').trim() && !String(r['採用担当者名'] || '').trim() && !doneKeys.has(keyOf(r)));
  if (LIMIT > 0) targets = targets.slice(0, Math.max(0, LIMIT - doneKeys.size));
  console.log(`対象 ${targets.length}社（公式URLあり・未処理）｜既処理 ${doneKeys.size}社・既HIT ${hits.length}件｜並列${CONC}｜採用ページ特化・正規表現（API不要）`);

  const flush = () => {
    try { fs.writeFileSync(OUT, toCsv(HEADERS, hits)); } catch (_) {}
    try { fs.writeFileSync(DONE, JSON.stringify({ done: [...doneKeys], hits })); } catch (_) {}
  };
  process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e && e.message); flush(); process.exit(2); });

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
            '確度': r.confidence.toFixed(2), '取得元': r.source, '根拠URL': r.sourceUrl, '根拠': r.evidence,
          });
          console.log(`  ✓ ${rec['企業名']} → ${r.name}（${r.role || '役職?'}・確度${r.confidence.toFixed(2)}）`);
        }
      } catch (_) { /* 個社失敗はスキップ */ }
      doneKeys.add(keyOf(rec));
      done++;
      if (done % 20 === 0) { console.log(`  …${done}/${targets.length}（累計HIT ${hits.length}）`); flush(); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, () => worker()));
  flush();
  await closeBrowser();

  const totalProcessed = doneKeys.size;
  const rate = totalProcessed ? (hits.length / totalProcessed * 100).toFixed(1) : '0';
  console.log(`\n===== 完了 ｜ 累計HIT ${hits.length}/${totalProcessed}社（歩留まり ${rate}%）｜${((Date.now() - t0) / 1000).toFixed(0)}秒 =====`);
  console.log(`出力: ${OUT}`);
}

main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); closeBrowser().finally(() => process.exit(1)); });
