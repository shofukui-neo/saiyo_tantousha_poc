'use strict';
// 高卒「新卒」採用企業リスト生成（検索API発掘 → 自社ページで判定 → gBiz補完 → CSV1本）。
//
// フロー:
//   1) 検索API（koso-search）で高卒採用の募集ページを発掘（クエリ行列）
//   2) 媒体/SNS/DB/情報記事ドメインを除外し、企業の自社ページ候補に絞る
//   3) 各ページを politeGet（robots遵守）で取得 → 本文/構造化から高卒新卒シグナル判定（koso-signal）
//   4) 合格ページから企業名を抽出、gBizINFO で業種/所在地/従業員/法人番号/代表者を補完
//   5) 正規化社名で重複排除 → 単一CSVを出力
//
// 実行: npm run koso            （既定クエリで発掘）
//       npm run koso -- --target 300 --pages 3 --prefectures 東京都,大阪府 --industries 製造,建設
//
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { search, pickProvider, setupHelp } = require('./koso-search');
const { classifyKoso, extractCompanyName } = require('./koso-signal');
const { isExcludedDomain } = require('./search');
const { politeGet } = require('./polite');
const { extractText } = require('./fetch');
const { extractOrganization } = require('./structured');
const { gbizAvailable, gbizSearch } = require('./gbiz');
const { toCsv, normCompanyName, normCorpNumber } = require('./csv');
const { sleep, hostOf } = require('./cli-util');
const cfg = require('./config');

// ---- CLI引数 ----
function parseArgs(argv) {
  const a = { out: 'data/leads-koso-shinsotsu.csv', target: 200, pages: 2, maxCompanies: 0, gbiz: true, year: 2026, delay: 500 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--out') { a.out = v; i++; }
    else if (k === '--target') { a.target = parseInt(v, 10) || a.target; i++; }
    else if (k === '--pages') { a.pages = parseInt(v, 10) || a.pages; i++; }
    else if (k === '--max-companies') { a.maxCompanies = parseInt(v, 10) || 0; i++; }
    else if (k === '--year') { a.year = parseInt(v, 10) || a.year; i++; }
    else if (k === '--delay') { a.delay = parseInt(v, 10) || a.delay; i++; }
    else if (k === '--prefectures') { a.prefectures = String(v || '').split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (k === '--industries') { a.industries = String(v || '').split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (k === '--queries') { a.queries = String(v || '').split(';').map(s => s.trim()).filter(Boolean); i++; }
    else if (k === '--no-gbiz') { a.gbiz = false; }
  }
  return a;
}

// ---- クエリ行列の生成 ----
// 企業の採用ページに当たりやすい「募集要項」系フレーズを核に、業種/都道府県で広げる。
const BASE_QUERIES = [
  '高卒採用 募集要項 初任給',
  '高卒 新卒採用 募集要項 高等学校卒業見込み',
  '高校新卒 採用情報 募集職種 初任給',
  '高等学校卒業見込 応募資格 新卒 採用',
  '高卒 定期採用 募集要項 初任給 賞与',
  '高卒者 新卒採用 エントリー 募集要項',
];
// 高卒採用が多い代表業種（母集団を広げる用）
const DEFAULT_INDUSTRIES = ['製造', '建設', '運輸', '物流', '食品', '自動車整備', '電気工事', '設備', '金属加工', '小売'];

function buildQueries(a) {
  if (a.queries && a.queries.length) return a.queries;
  const out = new Set(BASE_QUERIES);
  const inds = a.industries || [];
  const prefs = a.prefectures || [];
  for (const ind of inds) {
    out.add(`高卒採用 ${ind} 募集要項 初任給`);
    out.add(`高卒 新卒 ${ind} 募集職種 高等学校卒業見込み`);
  }
  for (const pref of prefs) {
    out.add(`高卒採用 ${pref} 募集要項 初任給`);
    for (const ind of inds) out.add(`高卒採用 ${pref} ${ind} 募集要項`);
  }
  return [...out];
}

// ---- ユーティリティ ----
// 共有 EXCLUDE_DOMAINS に載っていない媒体/集約サイトの追加除外（企業自社ページのみ残す）。
const KOSO_EXTRA_EXCLUDE = [
  'xn--pckua2a7gp15o89zb.com', // 求人ボックス（punycode）
  'job-draft.jp', 'jobtalk.jp', 'stanby.com', 'jp.stanby.com', 'kyujinbox.com',
  'hellowork.mhlw.go.jp', 'koukou.gakusei.hellowork.mhlw.go.jp',
  'ameblo.jp', 'hatenablog.com', 'note.com', 'ameba.jp', 'fc2.com',
];
function isMediaOrExcluded(host) {
  if (!host) return true;
  return isExcludedDomain(host) || isExcludedDomain(host, KOSO_EXTRA_EXCLUDE);
}

// gBizで社名補完（best-effort・正規化名が一致する1件を優先、無ければ最有力）
async function enrichGbiz(name) {
  if (!gbizAvailable(cfg) || !name) return null;
  try {
    const hits = await gbizSearch({ name, limit: 5 }, cfg);
    if (!hits || !hits.length) return null;
    const want = normCompanyName(name);
    return hits.find((h) => normCompanyName(h.name) === want) || hits[0];
  } catch { return null; }
}

/** レコードに gBiz の属性（法人番号/業種/所在地/従業員/代表者/URL）を反映。反映したら true。 */
function applyGbiz(rec, g) {
  if (!g) return false;
  if (g.corporateNumber) rec['法人番号'] = normCorpNumber(g.corporateNumber) || g.corporateNumber;
  if (g.businessSummary || (g.businessItems || []).length) rec['業種'] = g.businessSummary || (g.businessItems || []).join('・');
  if (g.prefecture) rec['所在地'] = g.prefecture;
  if (g.employees != null) rec['従業員数'] = g.employees;
  if (g.representativeName) rec['代表者名'] = g.representativeName;
  if (!rec['公式URL'] && g.websiteUrl) rec['公式URL'] = g.websiteUrl;
  return true;
}

/** URLのオリジン（scheme+host）。解釈できなければ元のURLを返す。 */
function originOf(url) { try { return new URL(url).origin; } catch { return url; } }

async function main() {
  const a = parseArgs(process.argv);
  const provider = pickProvider();
  if (!provider) {
    console.error('\n' + setupHelp() + '\n');
    process.exit(2);
  }
  console.log(`[koso] provider=${provider}  target=${a.target}  pages/クエリ=${a.pages}  gBiz補完=${a.gbiz && gbizAvailable(cfg)}`);

  const queries = buildQueries(a);
  console.log(`[koso] クエリ数=${queries.length}`);

  const acceptedByKey = new Map();   // 正規化社名 → レコード
  const acceptedDomains = new Set(); // 1ドメイン1社（重複ページ抑制）
  const seenUrls = new Set();
  let fetched = 0, quotaHit = false;
  const maxCompanies = a.maxCompanies || 0;

  outer:
  for (const q of queries) {
    if (acceptedByKey.size >= a.target) break;
    let results;
    try { results = await search(q, { pages: a.pages, delayMs: 400 }); }
    catch (e) {
      if (e && e.noProvider) { console.error(setupHelp()); process.exit(2); }
      // 日次上限/レート → 停止して、それまでの成果を書き出す
      console.warn(`[koso] 検索停止: ${e && e.message}`);
      quotaHit = true;
      break;
    }
    console.log(`[koso] Q「${q}」 → ${results.length}件`);

    for (const r of results) {
      if (acceptedByKey.size >= a.target) break outer;
      const url = r.link;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const host = hostOf(url);
      if (isMediaOrExcluded(host)) continue;                     // 媒体/SNS/DB/集約サイト を除外
      if (acceptedDomains.has(host)) continue;                   // 既に採用済みドメイン
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      // スニペット段階で明らかに情報記事なら本文取得もスキップ（節約）
      const pre = classifyKoso({ title: r.title, snippet: r.snippet, baseYear: a.year });
      if (!pre.kosoHits.length) continue;

      if (maxCompanies && fetched >= maxCompanies) { console.warn('[koso] 取得上限に到達'); break outer; }
      const page = await politeGet(url, { render: 'static' });
      fetched++;
      if (!page || page.blocked || page.error || !page.html) continue;

      const text = extractText(page.html);
      const cls = classifyKoso({ title: r.title, snippet: r.snippet, text, baseYear: a.year });
      if (!cls.isKosoShinsotsu) continue;

      const org = extractOrganization(page.html) || {};
      // og:site_name は extractCompanyName が html から自前で読む（ここで先読みしない）
      const nm = extractCompanyName({ html: page.html, orgName: org.name, title: r.title, snippet: r.snippet });
      if (!nm.name) continue;
      const key = normCompanyName(nm.name);
      // 既出社名ならこのドメインは打ち止め。社名が取れなかっただけならドメインは温存する。
      if (!key) continue;
      if (acceptedByKey.has(key)) { acceptedDomains.add(host); continue; }

      const rec = {
        '企業名': nm.name,
        '法人番号': '',
        '高卒区分': '高卒新卒',
        '根拠キーワード': [...new Set([...cls.kosoHits, ...cls.shinsotsuHits, ...cls.activeHits, ...cls.yearHits])].join(' / '),
        'シグナルスコア': cls.score,
        '業種': '',
        '所在地': org.address || '',
        '従業員数': '',
        '代表者名': '',
        '公式URL': originOf(page.finalUrl || url),
        '電話番号': org.telephone || '',
        '根拠URL': page.finalUrl || url,
        '取得元媒体': `検索API:${provider}`,
        '検索クエリ': q,
        '社名抽出元': nm.source,
        '取得日': new Date().toISOString().slice(0, 10),
      };
      acceptedByKey.set(key, rec);
      acceptedDomains.add(host);
      console.log(`  ✔ [${acceptedByKey.size}] ${nm.name}  (${cls.kosoHits.slice(0, 3).join(',')})`);
    }
    await sleep(a.delay);
  }

  // ---- gBiz補完（業種/都道府県/従業員/法人番号/代表者/公式URL）----
  const records = [...acceptedByKey.values()];
  if (a.gbiz && gbizAvailable(cfg)) {
    console.log(`[koso] gBiz補完 開始（${records.length}社）…`);
    let enriched = 0;
    for (const rec of records) {
      if (applyGbiz(rec, await enrichGbiz(rec['企業名']))) enriched++;
    }
    console.log(`[koso] gBiz補完 完了（${enriched}/${records.length}社に属性付与）`);
  }

  // ---- 出力 ----
  const headers = ['企業名', '法人番号', '高卒区分', '根拠キーワード', 'シグナルスコア', '業種', '所在地',
    '従業員数', '代表者名', '公式URL', '電話番号', '根拠URL', '取得元媒体', '検索クエリ', '社名抽出元', '取得日'];
  const outPath = path.resolve(process.cwd(), a.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // シグナルスコア降順で並べる
  records.sort((x, y) => (y['シグナルスコア'] || 0) - (x['シグナルスコア'] || 0));
  fs.writeFileSync(outPath, toCsv(headers, records), 'utf8');

  console.log('\n==== 完了 ====');
  console.log(`高卒新卒採用 企業: ${records.length}社`);
  console.log(`検索取得ページ数: ${fetched}`);
  if (quotaHit) console.log('※ 検索APIの上限/レートに達したため途中終了しました。時間をおくか上限引き上げで続行できます。');
  console.log(`出力: ${outPath}`);
}

module.exports = { parseArgs, buildQueries, isMediaOrExcluded, applyGbiz, originOf, BASE_QUERIES };

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
}
