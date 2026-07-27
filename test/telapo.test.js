'use strict';
// テレアポ分析システムの純ロジック単体テスト（ネットワーク/APIキー無し）。
//   node test/telapo.test.js
// 台帳の保存先はスクラッチ一時ディレクトリへ隔離（実データ data/ を汚さない）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// store の保存先を隔離してから require（module読込時に env を参照するため順序が重要）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telapo-test-'));
process.env.TELAPO_DATA_DIR = TMP;

const TA = require('../src/talk-analysis');
const store = require('../src/telapo-store');
const { analyzeCall, aggregate } = require('../src/telapo-analyze');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

console.log('talk-analysis（規則エンジン）:');

t('classifyResult がファネル位置を判定', () => {
  assert.deepStrictEqual(TA.classifyResult('担当者接触：アポ獲得'), { reached: true, refused: false, appo: true, follow: false });
  assert.deepStrictEqual(TA.classifyResult('担当者接触：お断り'), { reached: true, refused: true, appo: false, follow: false });
  assert.deepStrictEqual(TA.classifyResult('担当者不在'), { reached: false, refused: false, appo: false, follow: false });
});

t('classifyRefusal：構造化ペンディング理由を優先マップ', () => {
  assert.strictEqual(TA.classifyRefusal({ pending: '検討時期が3カ月以上先' }), '検討時期が先・タイミング');
  assert.strictEqual(TA.classifyRefusal({ pending: '他社ツール契約済み' }), '既存ツール・他社ATS/媒体で充足');
});

t('classifyRefusal：自由記述からの分類（優先度順）', () => {
  assert.strictEqual(TA.classifyRefusal({ comment: '新規営業はお断りしています' }), '新規営業を一律お断り');
  assert.strictEqual(TA.classifyRefusal({ comment: '予算が取れないので今回は見送り' }), '予算なし');
  assert.strictEqual(TA.classifyRefusal({ comment: 'LINEは会社の方針でNGなんです' }), 'LINE方針・セキュリティNG');
  assert.strictEqual(TA.classifyRefusal({ comment: '' }), '(コメントなし)');
});

t('classifyTalk：アポ獲得トーク要素を複数抽出', () => {
  const r = TA.classifyTalk('母集団形成が課題で、内定者のつなぎ止めにLINE連携を提案。採用目標人数は10名');
  assert.ok(r.labels.includes('母集団形成の文脈'));
  assert.ok(r.labels.includes('つなぎ止め・歩留まり改善'));
  assert.ok(r.labels.includes('LINE連携ATSの提案（コア訴求）'));
  assert.ok(r.elements[0].sample && r.elements[0].sample.length > 0);
});

t('suggestResult：文字起こしからコール結果を自動推定', () => {
  assert.strictEqual(TA.suggestResult('来週火曜14時で訪問のアポをいただけました'), '担当者接触：アポ獲得');
  assert.strictEqual(TA.suggestResult('予算がないので今回は見送りたいとのこと'), '担当者接触：お断り');
  assert.strictEqual(TA.suggestResult('興味はあるので資料を送ってほしいと言われた'), '担当者接触：営業フォロー');
  assert.strictEqual(TA.suggestResult('担当者が不在で折り返しをお願いした'), '担当者不在');
  assert.strictEqual(TA.suggestResult('受付で取次いただけませんでした'), '受付ブロック');
  assert.strictEqual(TA.suggestResult(''), '');
});

t('computeLift：アポ側で過剰出現する語はlift>1', () => {
  const appo = ['母集団形成と内定者フォロー', '説明会からの母集団', '母集団の課題'];
  const refuse = ['結構です', '必要ないです', '間に合っています'];
  const lift = TA.computeLift(appo, refuse);
  const boshu = lift.find((x) => x.word === '母集団');
  assert.ok(boshu.lift === Infinity || boshu.lift > 1, '母集団のliftが1超');
});

console.log('telapo-analyze（単一分析）:');

t('analyzeCall：お断り時に断り理由、アポ時にトーク要素', () => {
  const refuse = analyzeCall({ result: '担当者接触：お断り', transcript: '既にかんり君を使っていて充足しています' });
  assert.strictEqual(refuse.resultClass.refused, true);
  assert.strictEqual(refuse.refusalReason, '既存ツール・他社ATS/媒体で充足');
  const appo = analyzeCall({ result: '担当者接触：アポ獲得', transcript: '母集団形成の課題にLINE連携ATSを提案' });
  assert.strictEqual(appo.resultClass.appo, true);
  assert.ok(appo.talkElements.includes('LINE連携ATSの提案（コア訴求）'));
});

console.log('telapo-store（永続化・隔離ディレクトリ）:');

t('appendCall→readCall で往復・整形される', () => {
  const rec = store.appendCall({ company: '株式会社テスト', operator: '福井', result: '担当者接触：アポ獲得', talkElements: ['母集団形成の文脈'] });
  assert.ok(rec.id, 'idが発番される');
  assert.ok(rec.ts, 'tsが付与される');
  const calls = store.readCalls();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].company, '株式会社テスト');
  assert.deepStrictEqual(calls[0].talkElements, ['母集団形成の文脈']);
});

t('updateCall：後勝ちで部分更新される', () => {
  const before = store.readCalls()[0];
  const upd = store.updateCall(before.id, { memo: '追記メモ', nextAction: '来期再架電' });
  assert.strictEqual(upd.memo, '追記メモ');
  const after = store.readCalls().find((c) => c.id === before.id);
  assert.strictEqual(after.memo, '追記メモ');
  assert.strictEqual(after.company, '株式会社テスト', '未指定フィールドは保持');
});

t('deleteCall：tombstoneで論理削除され一覧から消える', () => {
  const id = store.readCalls()[0].id;
  assert.strictEqual(store.deleteCall(id), true);
  assert.strictEqual(store.readCalls().find((c) => c.id === id), undefined);
});

t('saveRecording：MIME→拡張子で保存、パストラバーサルを防ぐ', () => {
  const file = store.saveRecording('abc123', Buffer.from('dummy-audio'), 'audio/webm');
  assert.strictEqual(file, 'abc123.webm');
  assert.ok(store.recordingPath(file), '保存後に参照できる');
  assert.strictEqual(store.recordingPath('../../etc/passwd'), null, 'ディレクトリ脱出は不可');
});

console.log('telapo-analyze（集計・ダッシュボード）:');

t('aggregate：接続ファネルと各分布を集計', () => {
  const calls = [
    { ts: '2026-07-27T10:00:00Z', operator: 'A', result: '担当者接触：アポ獲得', transcript: '母集団形成とLINE連携', talkElements: ['母集団形成の文脈', 'LINE連携ATSの提案（コア訴求）'] },
    { ts: '2026-07-27T10:05:00Z', operator: 'A', result: '担当者接触：お断り', transcript: '予算がないので', refusalReason: '予算なし' },
    { ts: '2026-07-27T10:10:00Z', operator: 'B', result: '担当者不在' },
    { ts: '2026-07-27T10:15:00Z', operator: 'B', result: '担当者接触：営業フォロー', transcript: '検討中' },
  ];
  const agg = aggregate(calls);
  assert.strictEqual(agg.summary.total, 4);
  assert.strictEqual(agg.summary.reached, 3);
  assert.strictEqual(agg.summary.appo, 1);
  assert.strictEqual(agg.summary.refused, 1);
  assert.strictEqual(agg.summary.follow, 1);
  assert.ok(agg.refusalDist.find((r) => r.reason === '予算なし'));
  assert.ok(agg.talkDist.find((r) => r.element === '母集団形成の文脈'));
  assert.strictEqual(agg.operators.length, 2);
  assert.ok(agg.daily.length >= 1);
});

t('aggregate：空入力でも落ちない', () => {
  const agg = aggregate([]);
  assert.strictEqual(agg.summary.total, 0);
  assert.strictEqual(agg.summary.reachRate, '-');
});

// 後片付け
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

if (process.exitCode) { console.error('\nTELAPO TEST FAILED'); }
else { console.log('\nTELAPO TEST PASSED ✓  (' + pass + ' cases / 録音・分析・台帳・集計ロジック)'); }
