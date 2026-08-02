'use strict';
// koso-signal の純ロジック自己テスト（ネットワーク不要）。
// 実行: npm run koso:test
const assert = require('assert');
const { classifyKoso, extractCompanyName, nameFromTitle } = require('../src/koso-signal');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✔', name); }
  catch (e) { fail++; console.error('  x', name, '->', e.message); }
}

console.log('koso-signal 判定テスト');

// --- 高卒新卒として合格すべきケース ---
t('高卒新卒の募集ページ＝合格', () => {
  const r = classifyKoso({
    title: '新卒採用（高卒）｜株式会社サンプル製作所',
    snippet: '2027年3月高等学校卒業見込みの方を対象とした募集要項。初任給・応募資格を掲載。',
    text: '募集要項 応募資格 高等学校卒業見込み 新卒 高卒 初任給 18万円 エントリー',
    baseYear: 2026,
  });
  assert.strictEqual(r.isKosoShinsotsu, true, r.reason);
  assert.ok(r.kosoHits.length && r.shinsotsuHits.length);
});

// --- 高卒可の中途求人＝新卒シグナル無しで却下 ---
t('中途「高卒以上」＝新卒シグナル無しで却下', () => {
  const r = classifyKoso({
    title: '中途採用 営業スタッフ募集',
    snippet: '応募資格：高卒以上、学歴不問。経験者歓迎。',
    text: '中途採用のみ 高卒以上 学歴不問 募集要項 応募資格',
    baseYear: 2026,
  });
  assert.strictEqual(r.isKosoShinsotsu, false);
  assert.ok(/negative|shinsotsu/.test(r.reason));
});

// --- 高卒シグナルが無い＝却下 ---
t('高卒シグナル無し＝却下', () => {
  const r = classifyKoso({ title: '新卒採用 大卒総合職', snippet: '大学卒業見込みの方', text: '新卒 大卒 募集要項', baseYear: 2026 });
  assert.strictEqual(r.isKosoShinsotsu, false);
  assert.strictEqual(r.reason, 'no-koso-signal');
});

// --- 解説記事タイトル＝却下 ---
t('ランキング/解説記事タイトル＝却下', () => {
  const r = classifyKoso({
    title: '【2026年最新】高卒就職先ランキングTOP10｜おすすめ徹底解説',
    snippet: '高卒 新卒 募集要項 初任給 2027年卒',
    text: '高卒 新卒 募集要項 初任給 2027年卒 応募資格',
    baseYear: 2026,
  });
  assert.strictEqual(r.isKosoShinsotsu, false);
  assert.strictEqual(r.reason, 'guide-article-title');
});

// --- 募集の現役シグナルが無い＝却下 ---
t('現役募集シグナル無し＝却下', () => {
  const r = classifyKoso({ title: '高卒新卒の心得', snippet: '高卒 新卒 について', text: '高卒 新卒 とは 一般論', baseYear: 2026 });
  assert.strictEqual(r.isKosoShinsotsu, false);
});

// --- 企業名抽出 ---
console.log('企業名抽出テスト');
t('JSON-LD orgName 最優先', () => {
  const r = extractCompanyName({ orgName: '株式会社テスト工業', title: '採用情報｜テスト' });
  assert.strictEqual(r.name, '株式会社テスト工業');
  assert.strictEqual(r.source, 'jsonld');
});
t('タイトルから法人格つき社名', () => {
  assert.strictEqual(nameFromTitle('新卒採用（高卒）｜株式会社サンプル製作所'), '株式会社サンプル製作所');
});
t('タイトル 社名先頭パターン', () => {
  assert.strictEqual(nameFromTitle('サンプル金属株式会社 - 採用情報'), 'サンプル金属株式会社');
});
t('og:site_name フォールバック', () => {
  const html = '<html><head><meta property="og:site_name" content="株式会社オーゲー"></head><body>高卒 新卒 募集要項</body></html>';
  const r = extractCompanyName({ html, title: '採用情報' });
  assert.strictEqual(r.name, '株式会社オーゲー');
  assert.strictEqual(r.source, 'og:site_name');
});

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
