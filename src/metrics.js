'use strict';

function summarize(results) {
  const total = results.length;
  const count = (st) => results.filter(r => r.status === st).length;
  const hit = count('HIT');
  const miss = count('MISS');
  const err = count('ERROR');
  const skip = count('SKIP_ROBOTS');
  const noUrl = count('NO_URL');
  const attempted = total - err - skip - noUrl;     // 取得まで到達した試行（URL発見済みでサイトを読めた）
  const hitRateAttempted = attempted > 0 ? hit / attempted : 0;
  const hitRateTotal = total > 0 ? hit / total : 0;
  // 4項目の取得率（企業名は入力 or 発見の前提なので、URL・電話・担当者名を集計）
  const urlFound = results.filter(r => r.resolved_url).length;
  const phoneFound = results.filter(r => r.phone).length;
  const urlRate = total > 0 ? urlFound / total : 0;
  const phoneRate = total > 0 ? phoneFound / total : 0;
  const avgMs = total ? Math.round(results.reduce((a, r) => a + (r.elapsed_ms || 0), 0) / total) : 0;
  const avgPages = total ? (results.reduce((a, r) => a + (r.pages_checked || 0), 0) / total) : 0;
  const avgConf = hit ? results.filter(r => r.status === 'HIT').reduce((a, r) => a + (r.confidence || 0), 0) / hit : 0;
  return { total, hit, miss, err, skip, noUrl, attempted, hitRateAttempted, hitRateTotal,
    urlFound, phoneFound, urlRate, phoneRate, avgMs, avgPages, avgConf };
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

function printSummary(s) {
  const L = '──────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  PoC 結果サマリ — 媒体: company_site（公式企業サイト）');
  console.log(L);
  console.log(`  対象企業数            : ${s.total}`);
  console.log(`  HIT（担当者名 取得）  : ${s.hit}`);
  console.log(`  MISS（担当者名なし）  : ${s.miss}`);
  console.log(`  NO_URL（URL未発見）   : ${s.noUrl}`);
  console.log(`  SKIP（robots等で除外）: ${s.skip}`);
  console.log(`  ERROR（取得失敗）     : ${s.err}`);
  console.log(L);
  console.log(`  ◆ 取得率（4項目）`);
  console.log(`    公式URL 発見率      : ${pct(s.urlRate)}  (${s.urlFound}/${s.total})`);
  console.log(`    電話番号 取得率     : ${pct(s.phoneRate)}  (${s.phoneFound}/${s.total})`);
  console.log(`    採用担当者名 取得率 : ${pct(s.hitRateTotal)}  (${s.hit}/${s.total})`);
  console.log(L);
  console.log(`  ★ 担当者名HIT率(試行) : ${pct(s.hitRateAttempted)}  (${s.hit}/${s.attempted})`);
  console.log(`    平均確度（HITのみ） : ${s.avgConf.toFixed(2)}`);
  console.log(`    平均処理時間/社     : ${s.avgMs} ms`);
  console.log(`    平均チェックページ数: ${s.avgPages.toFixed(1)}`);
  console.log(L + '\n');
}

module.exports = { summarize, printSummary, pct };
