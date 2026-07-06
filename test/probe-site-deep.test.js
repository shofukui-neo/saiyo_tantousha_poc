'use strict';
// probe-site-deep.js / harvest-named-plus.js の純粋関数テスト（ネット不要）。
//   node test/probe-site-deep.test.js
const assert = require('assert');
const { sectionRole, collectLinks } = require('../src/probe-site-deep');
const { stripGbizTitle } = require('../src/harvest-named-plus');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

console.log('probe-site-deep / harvest-named-plus:');

// sectionRole: パス/アンカーの文言から役割と重みを判定
t('sectionRole が採用/会社概要/代表を分類', () => {
  assert.strictEqual(sectionRole('/recruit/ 採用情報').role, '採用');
  assert.strictEqual(sectionRole('/company/outline 会社概要').role, '代表');
  assert.strictEqual(sectionRole('/company/greeting 代表挨拶').role, '代表');
  assert.ok(sectionRole('/member/ 社員紹介').role === '社員');
  assert.strictEqual(sectionRole('/product/spec 製品仕様'), null); // 無関係面
});

// 会社概要(outline/profile)は generic about より高重み（実験3の取りこぼし対策）
t('sectionRole: 会社概要パスが高重み', () => {
  assert.ok(sectionRole('/company/outline').w >= 3);
  assert.ok(sectionRole('/company/profile').w >= 3);
});

// collectLinks: 内部リンクを役割つきで収集、外部SNS(note)を分離、外部ドメインは深掘り対象外
t('collectLinks が内部リンクとSNSを分離', () => {
  const html = `
    <a href="/recruit/">採用情報</a>
    <a href="/company/outline.html">会社概要</a>
    <a href="https://note.com/acme_hr">note</a>
    <a href="https://other-domain.com/x">外部</a>
    <a href="/product/">製品</a>`;
  const { internal, sns } = collectLinks('https://acme.co.jp/', html);
  const paths = internal.map((l) => l.url);
  assert.ok(paths.some((u) => /\/recruit\//.test(u)), '採用リンクを拾う');
  assert.ok(paths.some((u) => /outline/.test(u)), '会社概要リンクを拾う');
  assert.ok(!paths.some((u) => /other-domain/.test(u)), '外部ドメインは内部深掘りに入れない');
  assert.ok(sns.some((u) => /note\.com\/acme_hr/.test(u)), 'noteは外部SNSとして分離');
  assert.ok(!paths.some((u) => /\/product\//.test(u)), '無関係面(製品)はスコア0で除外');
});

// stripGbizTitle: gBiz代表者名の肩書きチェーン接着を剥がす
t('stripGbizTitle が肩書きを剥がす', () => {
  assert.strictEqual(stripGbizTitle('代表取締役社長　山田　拓郎'), '山田 拓郎');
  assert.strictEqual(stripGbizTitle('代表取締役　佐藤 花子'), '佐藤 花子');
  assert.strictEqual(stripGbizTitle('会長　田中 一郎'), '田中 一郎');
  assert.strictEqual(stripGbizTitle('代表社員　中村 修'), '中村 修');
  assert.strictEqual(stripGbizTitle('山田 太郎'), '山田 太郎'); // 肩書き無しは非破壊
});

// enrich-crossref: 突合ノイズの品質クリーニング（源データの姓連結/ふりがな/住所断片を落とす）
const { cleanCrossRefName } = require('../src/enrich-crossref');
t('cleanCrossRefName が突合ノイズを落とす', () => {
  assert.strictEqual(cleanCrossRefName('柴田 シバタ'), '柴田');   // ①ふりがな誤取り
  assert.strictEqual(cleanCrossRefName('加藤 田中'), '加藤');     // ②姓連結（名が完全な姓）
  assert.strictEqual(cleanCrossRefName('山下 矢沢'), '山下');     // ③姓サフィックス連結(沢)
  assert.strictEqual(cleanCrossRefName('渡辺 浜野'), '渡辺');     // ③姓サフィックス連結(野)
  assert.strictEqual(cleanCrossRefName('山口 県内で'), '山口');   // ④住所断片
  assert.strictEqual(cleanCrossRefName('福原 佳明'), '福原 佳明'); // クリーンなフルネームは非破壊
  assert.strictEqual(cleanCrossRefName('安部 真理子'), '安部 真理子');
  assert.strictEqual(cleanCrossRefName('Microsoft Teams'), null); // 非人名ゴミは不採用
});

console.log(`\nprobe-site-deep / harvest-named-plus: ${pass} 件パス`);
