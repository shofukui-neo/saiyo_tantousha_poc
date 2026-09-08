'use strict';
/**
 * 新卒/中途スコープ判定と採否ゲート（src/ats-scope.js）のテスト
 * =====================================================================
 * 2026-08-28に35社を目視した結果、旧ロジックの適合率は45.7%（19社が誤り）だった。
 * 誤りは全部この4パターンのどれかなので、パターンごとに1本ずつ回帰テストを置く。
 *
 *   A) 中途採用のATSを新卒のATSとして出した   … 全体の約6割
 *   B) 新卒採用をしていない会社に印を付けた
 *   C) 本文に製品名の文字列が出ただけで確定した（確度0.6）
 *   D) ベンダーの製品紹介ページへのリンクを導入済みと読んだ
 *
 * ここで守る不変条件はひとつ。
 *   **確定を出すのは、ATSのURL/ページ自体に新卒の証拠がある時だけ。**
 *   参照元ページの雰囲気や文脈だけでは確定しない（取りこぼしてよいが、誤って載せない）。
 */
const assert = require('assert');
const { scopeOf, scopeOfUrl, scoreWords, isArticleContext, gradeEvidence, isPlausibleGradYear, GRADE, SCOPE } = require('../src/ats-scope');
const { detectAtsByHtml, atsPageUrl, isVendorOwnPage, contextAround, stripTags } = require('../src/ats');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) { if (cond) pass++; else { fail++; fails.push(label); console.log(`  ✗ ${label}`); } }
function eq(label, a, b) { ok(`${label}  (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b); }

// ── 1) 語彙の採点 ─────────────────────────────────────────────────
console.log('\n[1] 新卒/中途の語彙');
eq('「新卒採用」は新卒', scopeOf({ text: '新卒採用エントリー' }).scope, SCOPE.SHINSOTSU);
eq('「中途採用」は中途', scopeOf({ text: '中途採用の募集要項' }).scope, SCOPE.CHUTO);
eq('両方あれば新卒/中途', scopeOf({ text: '新卒採用と中途採用を行っています' }).scope, SCOPE.BOTH);
eq('どちらも無ければ不明', scopeOf({ text: '会社概要' }).scope, SCOPE.UNKNOWN);
ok('「卒業見込」は決め手（strongS）', scoreWords('2027年3月卒業見込みの大学生').strongS >= 3);
ok('「プレエントリー」も決め手', scoreWords('プレエントリー受付中').strongS >= 3);
ok('「新卒」単独は決め手にしない', scoreWords('新卒の方へ').strongS === 0);

// 「第二新卒歓迎」は中途求人の常套句。ここを新卒に数えると中途ページが全部新卒になる。
console.log('\n[2] 第二新卒の罠（中途ページを新卒と読まない）');
const daini = scoreWords('第二新卒歓迎／経験者採用／職務経歴書をご提出ください');
eq('第二新卒は新卒に加算しない', daini.shinsotsu, 0);
ok('  中途として数える', daini.chuto >= 3);
eq('  結果は中途', scopeOf({ text: '第二新卒歓迎 中途採用' }).scope, SCOPE.CHUTO);

// ── 3) URLパスの読み ──────────────────────────────────────────────
console.log('\n[3] URLパスからの判定');
eq('career-cloud.asia/27/ は卒年＝新卒', scopeOfUrl('https://www.career-cloud.asia/27/form/entry?id=1', true).scope, SCOPE.SHINSOTSU);
eq('i-webの ..._group2027/ も新卒', scopeOfUrl('https://mypage.3010.i-webs.jp/risu_group2027/applicant/login', true).scope, SCOPE.SHINSOTSU);
eq('/mid/ は中途', scopeOfUrl('https://www.career-cloud.asia/mid/entry/job/offer/x', true).scope, SCOPE.CHUTO);
eq('/shinsotsu/ は新卒', scopeOfUrl('https://example.co.jp/recruit/shinsotsu/').scope, SCOPE.SHINSOTSU);
eq('/careers/ だけでは決めない', scopeOfUrl('https://example.co.jp/careers/').scope, SCOPE.UNKNOWN);
ok('卒年の範囲外（去年より前）は拾わない', !isPlausibleGradYear(20));
ok('来年の卒年は拾う', isPlausibleGradYear(new Date().getFullYear() + 1 - 2000));

// ── 4) 採否ゲート ─────────────────────────────────────────────────
console.log('\n[4] 採否ゲート（確定を出す条件）');
const base = { kind: 'ats', source: 'embed' };

// (C) 本文マーカーだけ＝実URLが無い → 絶対に確定にしない
//     実測: 株式会社リクルートマネジメントソリューションズ（自社サイトに製品名の文字列）
eq('マーカーのみは要確認', gradeEvidence({ ...base, source: 'marker', atsUrl: '' }).grade, GRADE.REVIEW);
eq('実URLが無ければ要確認', gradeEvidence({ ...base, atsUrl: '' }).grade, GRADE.REVIEW);

// (D) ベンダー自身の製品ページ → 導入の証拠ではない
eq('hrmos.co/ats/ は要確認', gradeEvidence({ ...base, atsUrl: 'https://hrmos.co/ats/' }).grade, GRADE.REVIEW);
eq('ベンダーのトップも要確認', gradeEvidence({ ...base, atsUrl: 'https://hrmos.co/' }).grade, GRADE.REVIEW);
eq('テナントURLなら見に行く価値がある', gradeEvidence({ ...base, atsUrl: 'https://hrmos.co/pages/acme/jobs' }).grade, GRADE.REVIEW);

// 紹介記事の文脈
eq('導入事例の文脈は要確認', gradeEvidence({ ...base, atsUrl: 'https://hrmos.co/pages/x/jobs', linkContext: '導入事例のご紹介' }).grade, GRADE.REVIEW);
ok('isArticleContext', isArticleContext('ATS比較ランキング') && !isArticleContext('新卒採用エントリー'));

// (A) 中途のATSを新卒として出さない
eq('ATSページが中途なら中途用', gradeEvidence({
  ...base, atsUrl: 'https://hrmos.co/pages/acme/jobs',
  atsPageText: '中途採用 キャリア採用 職務経歴書 第二新卒歓迎',
}).grade, GRADE.CHUTO);
eq('URLが/mid/なら中途用', gradeEvidence({
  ...base, atsUrl: 'https://www.career-cloud.asia/mid/entry/job/offer/acme',
}).grade, GRADE.CHUTO);
eq('導線の文言が中途なら中途用', gradeEvidence({
  ...base, atsUrl: 'https://hrmos.co/pages/acme/jobs', linkContext: '中途採用｜キャリア採用はこちら',
}).grade, GRADE.CHUTO);

// 確定になる2経路
eq('ATSページに新卒の募集 → 確定', gradeEvidence({
  ...base, atsUrl: 'https://hrmos.co/pages/acme/jobs',
  atsPageText: '【新卒】広告営業 2027年3月卒業見込みの大学・大学院生 中途採用も実施中',
}).grade, GRADE.CONFIRMED);
eq('ATS URLに卒年 → 確定', gradeEvidence({
  ...base, atsUrl: 'https://www.career-cloud.asia/27/form/entry?id=1',
}).grade, GRADE.CONFIRMED);
eq('  用途は新卒', gradeEvidence({ ...base, atsUrl: 'https://www.career-cloud.asia/27/form/entry?id=1' }).scope, SCOPE.SHINSOTSU);

// 求人一覧は新卒と中途が混ざる。中途が多くても新卒の決め手が1つあれば確定にする
eq('中途が多くても新卒の決め手があれば確定', gradeEvidence({
  ...base, atsUrl: 'https://hrmos.co/pages/acme/jobs',
  atsPageText: '中途採用 キャリア採用 経験者 転職 職務経歴書 パート 契約社員 ／ 新卒採用 2027年卒',
}).grade, GRADE.CONFIRMED);

// **確定に使ってはいけない証拠**（ここを緩めると誤出荷が戻る）
// 実測: 株式会社ジェイ・スポーツ。ナビに新卒/中途が並び、リンク先は中途のHRMOS、新卒はsonar。
eq('参照元の文脈が新卒でも確定にしない', gradeEvidence({
  ...base, atsUrl: 'https://hrmos.co/pages/jcom/jobs/1', linkContext: '新卒採用 新卒 エントリー',
}).grade, GRADE.REVIEW);
eq('参照元ページが新卒一色でも確定にしない', gradeEvidence({
  ...base, atsUrl: 'https://hrmos.co/pages/acme/jobs',
  pageScope: { shinsotsu: 20, chuto: 0 },
}).grade, GRADE.REVIEW);

// (B) 新卒採用をやっていない会社
eq('新卒の記載が無く中途のみ → 新卒採用なし', gradeEvidence({
  ...base, atsUrl: 'https://hrmos.co/pages/acme/jobs',
  pageHasShinsotsu: false, pageScope: { shinsotsu: 0, chuto: 9 },
}).grade, GRADE.NO_SHINSOTSU);

eq('ATS以外は対象外', gradeEvidence({ kind: 'media', atsUrl: 'https://job.mynavi.jp/x' }).grade, GRADE.NONE);

// ── 5) 証拠の取り出し（ats.js側） ─────────────────────────────────
console.log('\n[5] HTMLからの証拠取り出し');
const html = '<html><body>'
  + '<h2>中途採用</h2><p>キャリア採用の応募はこちら</p>'
  + '<script src="https://hrmos.co/pages/acme/embed.js"></script>'
  + '</body></html>';
const hits = detectAtsByHtml(html, 'https://example.co.jp/recruit/');
eq('埋め込みを1件検出', hits.length, 1);
eq('  実URLを持つ', hits[0].url, 'https://hrmos.co/pages/acme/embed.js');
ok('  直前の見出しを文脈に含む', hits[0].context.includes('中途採用'));
eq('  文脈込みで判定すると中途用', gradeEvidence({
  kind: 'ats', source: hits[0].source, atsUrl: hits[0].url, linkContext: hits[0].context,
}).grade, GRADE.CHUTO);

console.log('\n[6] ATSページURLの正規化（アセット→読めるページ）');
eq('embed.js → 求人一覧', atsPageUrl('https://hrmos.co/pages/acme/embed.js'), 'https://hrmos.co/pages/acme/jobs');
eq('カテゴリ絞り込みも一覧へ', atsPageUrl('https://hrmos.co/pages/acme/jobs?category=123'), 'https://hrmos.co/pages/acme/jobs');
eq('求人詳細も一覧へ', atsPageUrl('https://hrmos.co/pages/acme/jobs/0001'), 'https://hrmos.co/pages/acme/jobs');
eq('かんりくんのフォームはそのまま', atsPageUrl('https://www.career-cloud.asia/27/form/entry?id=1'), 'https://www.career-cloud.asia/27/form/entry?id=1');
eq('未知ベンダーのcssはディレクトリへ', atsPageUrl('https://x.sonar-ats.jp/a/b/app.css'), 'https://x.sonar-ats.jp/a/b/');

console.log('\n[7] ベンダー自身のページ判定');
ok('hrmos.co/ats/ はベンダー本体', isVendorOwnPage('https://hrmos.co/ats/'));
ok('hrmos.co/pages/x/jobs は顧客テナント', !isVendorOwnPage('https://hrmos.co/pages/acme/jobs'));
ok('sonar-ats.jp 直は本体', isVendorOwnPage('https://sonar-ats.jp/'));
ok('サブドメインは顧客テナント', !isVendorOwnPage('https://acme.sonar-ats.jp/entry'));
ok('/column/ は本体のメディア', isVendorOwnPage('https://career-cloud.asia/column/ats-hikaku'));

console.log('\n[8] タグ落とし・文脈切り出し');
ok('scriptの中身は落とす', !stripTags('<script>var 中途採用=1;</script><p>新卒採用</p>').includes('var'));
ok('前後の文脈を拾う', contextAround('<h1>新卒採用</h1><a href="x">エントリー</a>', 30).includes('新卒採用'));

console.log(`\n合計: ${pass} pass / ${fail} fail`);
if (fail) { console.log('失敗:'); fails.forEach((f) => console.log('  - ' + f)); }
assert.strictEqual(fail, 0, `${fail}件失敗`);
