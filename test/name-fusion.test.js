'use strict';
// name-fusion.js の単体テスト（外部I/O無し）。node test/name-fusion.test.js
const assert = require('assert');
const { fuseCandidates, classifySource, canonName } = require('../src/name-fusion');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

console.log('name-fusion:');

// canonName: 表記ゆれ（空白有無）を同一キーに束ね、辞書姓は「姓 名」表示に整形
t('canonName が空白有無を同一キーに束ねる', () => {
  assert.strictEqual(canonName('早瀬 峻介').key, canonName('早瀬峻介').key);
});

// classifySource: 実績源の分類と重み
t('classifySource が Wantedly/自社ページを高重みに分類', () => {
  assert.strictEqual(classifySource('Wantedly', '').weight, 1.0);
  assert.strictEqual(classifySource('自社採用ページ深掘り', '').weight, 1.0);
  assert.ok(classifySource('Webインタビュー記事', '').weight < 1.0);
});

// ① クロスソース一致で確度が単一源より上がる（best-of-pool + agreement）
t('独立2源が同一氏名 → 融合確度が単一源を上回る', () => {
  const single = fuseCandidates([
    { name: '早瀬 峻介', confidence: 0.7, source: 'Webインタビュー記事', role: '採用担当' },
  ]);
  const agreed = fuseCandidates([
    { name: '早瀬 峻介', confidence: 0.7, source: 'Webインタビュー記事', role: '採用担当' },
    { name: '早瀬峻介', confidence: 0.7, source: '自社採用ページ', role: '人事' },
  ]);
  assert.ok(agreed.best, 'best が選ばれる');
  assert.strictEqual(agreed.best.agreement, true, 'クロス検証フラグが立つ');
  assert.ok(agreed.best.confidence > single.best.confidence, '一致で確度が上がる');
  assert.strictEqual(agreed.best.sourceCount, 2);
});

// ② best-of-pool: 弱い部分一致より、辞書検証済みフルネームの強い源を採る
t('プール最良: 強い源のフルネームを選ぶ', () => {
  const { best } = fuseCandidates([
    { name: '山田', confidence: 0.6, source: 'Webインタビュー記事' },      // 姓のみ・弱源
    { name: '田中 太郎', confidence: 0.82, source: '自社採用ページ', role: '採用' }, // 強源フルネーム
  ]);
  assert.strictEqual(best.name, '田中 太郎');
});

// ③ 単一 discovery源 かつ 非人名 → しきい値割れで不採用（誤爆抑制）
t('単一弱源の非人名は不採用', () => {
  const { best } = fuseCandidates([
    { name: '営業本部', confidence: 0.6, source: 'Webインタビュー記事' },
  ], { threshold: 0.62 });
  assert.strictEqual(best, null);
});

// 役職語・肩書き複合を人名扱いしない（実験1で判明した誤検出クラス）
t('役職語(社長/会長)・肩書き複合を弾く', () => {
  assert.strictEqual(canonName('社長'), null);
  assert.strictEqual(canonName('会長'), null);
  assert.strictEqual(canonName('取締役'), null);
  assert.strictEqual(canonName('会長 梅'), null);   // 先頭肩書き複合
  assert.strictEqual(canonName('日代表者'), null);  // 役割語内包（実験2で判明）
  assert.strictEqual(canonName('田中社長'), null);  // 末尾肩書き
  assert.ok(canonName('梅田 康夫'), '通常のフルネームは通す');
});

// 空入力は best=null
t('空入力で best=null', () => {
  const { best, groups } = fuseCandidates([]);
  assert.strictEqual(best, null);
  assert.strictEqual(groups.length, 0);
});

console.log(`\nname-fusion: ${pass} 件パス`);
