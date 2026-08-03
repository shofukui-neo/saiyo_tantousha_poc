'use strict';
// 「新卒母集団課題ニーズ」判定規則の単体テスト（ネットワーク/APIキー無し）。
//   node test/boshudan-needs.test.js
// 実データ（BALES 22,892件）で観測した実文面をそのままケース化している。
const assert = require('assert');
const { detectBoshudanNeeds, isUntouchedTemplate } = require('../src/boshudan-needs');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

// 便利ラッパ：顧客の現状フィールドに文面を入れて判定
const lvl = (text, field = 'カスタム情報：顧客の現状') => detectBoshudanNeeds({ [field]: text }).level;
const cats = (text) => detectBoshudanNeeds({ 'カスタム情報：顧客の現状': text }).categories;

console.log('強シグナル（母集団を課題と明言）:');

t('「母集団形成にお悩み」を強と判定', () => {
  assert.strictEqual(lvl('母集団形成にお悩み、新機能に興味持ってくれた'), '強');
});

t('「歩留りよりも母集団の方が課題」を強と判定', () => {
  assert.strictEqual(lvl('歩留りよりも母集団の方が課題。応募が来ない。'), '強');
});

t('ヒアリング様式の課題欄に母集団形成が選択されていれば強', () => {
  const s = '■採用チームとして感じている課題 ・歩留まり改善／母集団形成／その他 詳細（あれば）：学生が集まらないのが課題感。';
  assert.strictEqual(lvl(s), '強');
  assert.ok(cats(s).includes('採用課題に母集団形成'));
});

t('「母集団を増やすための施策」＝増やしたい意思も強', () => {
  assert.strictEqual(lvl('■採用チームとして感じている課題 ・母集団を増やすための施策'), '強');
});

t('「母集団が全くない」を強と判定', () => {
  assert.strictEqual(lvl('母集団が全くない アポ取っても仕方ない感じだった'), '強');
});

console.log('中シグナル（母集団が薄い実態）:');

t('「エントリー数が少ない」を中と判定', () => {
  assert.strictEqual(lvl('渕上 女性 エントリー数が少ないと'), '中');
});

t('「ナビに費用かけているのに応募が少ない」を中と判定', () => {
  assert.strictEqual(lvl('ナビサイトに費用かけているのに応募が少ない。'), '中');
});

t('「理系の学生が集まらない」を中と判定', () => {
  const s = '【課題感】 ・理系の学生が集まらない 説明会20名→本選考10名';
  assert.strictEqual(lvl(s), '中');
  assert.ok(cats(s).includes('特定層の学生が採れない'));
});

console.log('誤爆ガード（ここが本体）:');

t('中立：ヒアリング様式の事実記入「母集団形成方法：マイナビ」はニーズにしない', () => {
  assert.strictEqual(lvl('・採用目標人数：５ ・母集団形成方法：リクナビ ・接触人数：３０'), '');
});

t('未編集テンプレ（選択肢が7つ丸残り）はニーズにしない', () => {
  const tpl = '■採用チームとして感じている課題 ・歩留まり改善／工数削減／一元管理／LINEの利用／コストカット（予算の見直し）／母集団形成／その他 詳細（あれば）：';
  assert.ok(isUntouchedTemplate(tpl));
  assert.strictEqual(lvl(tpl), '');
});

t('充足：「母集団形成での課題感持っていない」はニーズなし', () => {
  assert.strictEqual(lvl('女性担当者 母集団形成での課題感持っていない 現状モチカのニーズなさそう'), '');
});

t('充足：「母集団も歩留まりも課題感もなく、今のところは順調」はニーズなし', () => {
  assert.strictEqual(lvl('ふるや（女性）いい人 母集団も歩留まりも課題感もなく、今のところは順調のよう。'), '');
});

t('充足：「母集団集まるようになった」はニーズなし', () => {
  assert.strictEqual(lvl('公式アカウント利用中 母集団集まるようになったが、LINEへの登録も進んでおり十分さばけている。'), '');
});

t('充足：4桁のエントリー数はニーズなし（母集団は薄くない）', () => {
  assert.strictEqual(lvl('リクナビのプレエントリーが2000名くらい。内定辞退とか全然困ってない。'), '');
});

t('中途ガード：痛みが中途に帰属する文は新卒ニーズにしない', () => {
  assert.strictEqual(lvl('中途採用が苦戦している'), '');
});

t('自社プロダクトガード：「MOCHICAも母集団や工数部分強化した」はニーズにしない', () => {
  assert.strictEqual(lvl('MOCHICAも母集団や工数部分強化した！ 新卒採用用のLINE・ATSは知らない。'), '');
});

t('空・無関係テキストはニーズなし', () => {
  assert.strictEqual(lvl(''), '');
  assert.strictEqual(lvl('担当者不在。折り返し依頼。'), '');
});

console.log('出力の形:');

t('根拠スニペットと分類を返す（架電者が読める形）', () => {
  const d = detectBoshudanNeeds({ 'コール結果1：コメント': '歩留りよりも母集団の方が課題。応募が来ない。' });
  assert.strictEqual(d.level, '強');
  assert.ok(d.evidence.includes('[コール]'));
  assert.ok(d.hits.length >= 1);
  assert.ok(d.categories.length >= 1);
});

t('複数フィールドを横断して走査する', () => {
  const d = detectBoshudanNeeds({
    'カスタム情報：顧客の課題感': '採用課題 ・不人気業界で応募が集まらない',
    '商談1：引き継ぎメモ': '・採用課題：母集団形成、離脱率',
  });
  assert.strictEqual(d.level, '強');
  assert.ok(d.hits.some((h) => h.label === '課題感'));
  assert.ok(d.hits.some((h) => h.label === '商談メモ'));
});

if (process.exitCode) { console.error('\nBOSHUDAN TEST FAILED'); }
else { console.log('\nBOSHUDAN TEST PASSED ✓  (' + pass + ' cases / 母集団課題ニーズ判定規則)'); }
