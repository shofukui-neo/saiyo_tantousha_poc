'use strict';
// 究極の営業リスト作成アプリ — 一気通貫CLI
//   企業選定（発掘）→ 名寄せ → 公式URL → 電話/採用担当者 → メール → Tier → 担当者マスタ出力
// すべてローカルで動作。APIキー（gBizINFO/国税庁/Gemini/Hunter）があれば自動で高精度経路に点火。
//
// 使い方:
//   node src/app.js                         # ICP(.env) から発掘して一気通貫
//   node src/app.js --discover "渋谷 SaaS"   # キーワードで発掘
//   node src/app.js --discover-url <一覧URL> # 一覧ページから発掘
//   node src/app.js --input names.csv        # 企業名リスト(company_name列)を起点に
//   node src/app.js --limit 30 --concurrency 3 --out leads.csv
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { getIcp } = require('./icp');
const { discover } = require('./discovery');
const { processCompany } = require('./pipeline');
const { fetchPage, extractText, closeBrowser } = require('./fetch');
const { writeMaster } = require('./master-io');
const { summarize, printSummary } = require('./metrics');
const { gbizAvailable } = require('./gbiz');
const { ntaAvailable } = require('./nta');
const { geminiAvailable } = require('./gemini');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// company_name 列だけ読む簡易CSV（# はコメント、ヘッダ任意）
function readNamesCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  let header = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((s) => s.replace(/^"|"$/g, '').trim());
    if (!header) {
      const low = cols.map((c) => c.toLowerCase());
      if (low.includes('company_name') || low.includes('企業名') || low.includes('name')) { header = low; continue; }
      header = null; // ヘッダ無し → 1列目を社名として扱う
    }
    const idx = header ? Math.max(0, header.findIndex((h) => /company_name|企業名|name/.test(h))) : 0;
    const name = cols[idx] || cols[0];
    const url = header ? (cols[header.findIndex((h) => /homepage_url|url|ドメイン|hp/.test(h))] || '') : (cols[1] || '');
    if (name) out.push({ name, websiteUrl: url || '', corporateNumber: '', domain: '', representativeName: '', prefecture: '', employees: null, industry: '', source: 'input' });
  }
  return out;
}

// 並列プール
async function pool(items, n, worker) {
  const ret = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; ret[i] = await worker(items[i], i); }
  });
  await Promise.all(runners);
  return ret;
}

function describeEngines(c) {
  return [
    `発掘: ${gbizAvailable(c) ? 'gBizINFO（構造化）' : 'Bing検索（API不要）'}`,
    `名寄せ: ${ntaAvailable(c) ? '国税庁法人番号' : 'なし'}`,
    `担当者抽出: ${geminiAvailable(c) ? 'Gemini(AI)' : '正規表現'}`,
    `メール検証: ${(c.DO_EMAIL_VERIFY && c.HUNTER_KEY) ? 'Hunter' : 'MX篩いのみ'}`,
  ].join(' ｜ ');
}

async function main() {
  const limit = parseInt(getArg('limit', '0'), 10) || 0;
  if (getArg('concurrency', null)) cfg.CONCURRENCY = parseInt(getArg('concurrency'), 10) || cfg.CONCURRENCY;
  const inputCsv = getArg('input', null);
  const discoverQuery = getArg('discover', null);
  const discoverUrlArg = getArg('discover-url', null);
  const outPath = getArg('out', 'leads.csv');
  const onlyDiscover = process.argv.includes('--only-discover');

  console.log('\n===== 究極の営業リスト作成アプリ =====');
  console.log(describeEngines(cfg));

  // L1: ICP
  const icp = await getIcp(cfg);
  console.log(`ICP: source=${icp.source} ｜ 業種=${(icp.target_industries || []).join('/') || '(未指定)'} ｜ 地域=${(icp.geography || []).join('/') || '(未指定)'} ｜ 従業員=${icp.company_size.employees_min}〜${icp.company_size.employees_max}`);

  // L2: 候補の用意（入力 or 発掘）
  let candidates;
  if (inputCsv && inputCsv !== true) {
    candidates = readNamesCsv(inputCsv);
    if (limit > 0) candidates = candidates.slice(0, limit);
    console.log(`入力: ${path.resolve(inputCsv)} から ${candidates.length}社`);
  } else {
    const opt = { limit: limit || cfg.DISCOVER_TARGET };
    if (discoverQuery && discoverQuery !== true) opt.query = discoverQuery;
    if (discoverUrlArg && discoverUrlArg !== true) opt.listUrl = discoverUrlArg;
    console.log(`発掘中…（目標 ${opt.limit}社）`);
    const d = await discover(icp, { fetchPage, extractText }, opt, cfg);
    candidates = d.candidates;
    console.log(`→ ${candidates.length}社を発掘（source=${d.source}）`);
  }

  if (!candidates.length) {
    console.error('候補企業が0件です。--discover でキーワードを指定するか、.env の ICP_INDUSTRIES/ICP_PREFECTURES を設定してください。');
    await closeBrowser();
    process.exit(1);
  }

  // 発掘だけ確認したい場合
  if (onlyDiscover) {
    const records = candidates.map((c) => ({
      '企業名': c.name, '法人番号': c.corporateNumber || '', '代表者名': c.representativeName || '',
      '公式URL': c.websiteUrl || '', '業種': c.industry || '', '都道府県': c.prefecture || '',
      '従業員数': c.employees != null ? c.employees : '', '取得元媒体': c.source || '',
      '補助金': c.subsidyFlag || '', '設立年': c.establishmentYear || '',
    }));
    const { csvPath } = await writeMaster(cfg, records, { csvPath: outPath });
    console.log(`発掘結果のみを書き出しました: ${path.resolve(csvPath)}`);
    candidates.slice(0, 15).forEach((c, i) => console.log(`  ${i + 1}. ${c.name}${c.icpScore != null ? '（ICP' + c.icpScore + '）' : ''}`));
    await closeBrowser();
    return;
  }

  // L3〜L5: 一気通貫処理
  console.log(`\n処理開始: ${candidates.length}社 / 並列 ${cfg.CONCURRENCY}（取得項目: 法人番号・代表者・公式URL・電話・採用担当者・メール・Tier）`);
  const out = await pool(candidates, cfg.CONCURRENCY, (c) => processCompany(c, icp, cfg));
  await closeBrowser();

  const records = out.map((o) => o.record);
  const results = out.map((o) => o.result);

  // 出力
  let written;
  try { written = await writeMaster(cfg, records, { csvPath: outPath }); }
  catch (e) { console.error('出力に失敗: ' + (e.message || e)); written = { csvPath: outPath }; }

  // サンプル表示
  const withUrl = results.filter((r) => r.resolved_url);
  if (withUrl.length) {
    console.log('\n--- 取得サンプル（企業名｜URL｜電話｜担当者｜Tier） ---');
    out.filter((o) => o.result.resolved_url).slice(0, 8).forEach((o) => console.log(
      `  ● ${o.record['企業名']}｜${o.record['公式URL'] || '-'}｜${o.record['電話番号'] || '-'}｜${o.record['採用担当者名'] || '-'}｜${o.record['Tier']}`));
  }

  printSummary(summarize(results));
  // Tier 集計
  const tierCount = records.reduce((a, r) => { a[r.Tier] = (a[r.Tier] || 0) + 1; return a; }, {});
  console.log(`  Tier内訳: A=${tierCount.A || 0} B=${tierCount.B || 0} C=${tierCount.C || 0} D=${tierCount.D || 0}`);
  console.log(`\n担当者マスタCSV: ${path.resolve(written.csvPath)}`);
  if (written.sheetWritten != null) console.log(`スプレッドシート「${cfg.MASTER_TAB}」へ ${written.sheetWritten}件 upsert 済み`);
  else if (written.sheetError) console.log(`（シート書き戻しはスキップ/失敗: ${written.sheetError}）`);
  else if (!cfg.SHEET_ID) console.log('（SHEET_ID 未設定のためCSVのみ。シート出力するには .env に SHEET_ID とサービスアカウントを設定）');
  console.log('');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
