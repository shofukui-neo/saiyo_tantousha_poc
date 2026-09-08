'use strict';
/**
 * 卒年抽出と横断一覧の組み立て（src/ats-scope.js / src/build-ats-shinsotsu-list.js）のテスト
 * =====================================================================
 * 守りたいこと:
 *   1) 卒年は **確定した行にだけ** 付く（中途・要確認に卒年が付くと一覧の意味が壊れる）
 *   2) 「第二新卒」から卒年を作らない
 *   3) 過年度（今年-2 以前）の卒年は拾わない＝古い採用ページを現行として出さない
 *   4) 架電可否は行を消さずに理由として持つ（全体像が要る用途なので落とさない）
 */
const assert = require('assert');
const { extractGradYears, gradeEvidence, GRADE } = require('../src/ats-scope');
const { toRow, callBlockReason, yearsOf } = require('../src/build-ats-shinsotsu-list');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) { if (cond) pass++; else { fail++; fails.push(label); console.log(`  ✗ ${label}`); } }
function eq(label, a, b) { ok(`${label}  (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b); }
const same = (label, a, b) => eq(label, JSON.stringify(a), JSON.stringify(b));

// 今年を基準に「妥当な卒年」が変わるので、テストも今年から作る（2027年に落ちないように）
const Y = new Date().getFullYear();
const yy = (n) => String(Y + n - 2000);       // yy(1) → 来年の卒年（2桁）

console.log('\n[1] 卒年の取り出し');
same('27卒／28卒を両方拾う', extractGradYears({ text: `${yy(1)}卒 と ${yy(2)}卒 を募集` }), [yy(1), yy(2)]);
same('「2027年3月卒業見込み」も卒年', extractGradYears({ text: `20${yy(1)}年3月卒業見込みの大学生` }), [yy(1)]);
same('4桁表記も2桁に寄せる', extractGradYears({ text: `20${yy(1)}年卒` }), [yy(1)]);
same('ATS URLのパスから', extractGradYears({ url: `https://www.career-cloud.asia/${yy(1)}/form/entry?id=1`, atsHost: true }), [yy(1)]);
same('i-webの企業ID末尾の年も', extractGradYears({ url: `https://mypage.3010.i-webs.jp/acme_group20${yy(1)}/login`, atsHost: true }), [yy(1)]);
same('ATSホストでないURLの数字は卒年にしない', extractGradYears({ url: `https://example.co.jp/news/20${yy(1)}/` }), []);
same('第二新卒から卒年を作らない', extractGradYears({ text: '第二新卒歓迎' }), []);
same('古すぎる卒年は拾わない', extractGradYears({ text: '20卒 22卒 の実績' }), []);
same('先すぎる卒年も拾わない', extractGradYears({ text: `${yy(20)}卒` }), []);
same('重複は畳む', extractGradYears({ text: `${yy(1)}卒 ${yy(1)}卒 ${yy(1)}年卒` }), [yy(1)]);

console.log('\n[2] 卒年が付くのは確定行だけ');
const conf = gradeEvidence({ kind: 'ats', source: 'url', atsUrl: `https://www.career-cloud.asia/${yy(1)}/form/entry?id=1` });
eq('確定である', conf.grade, GRADE.CONFIRMED);
same('  卒年が付く', conf.years, [yy(1)]);
// 中途「だけ」のATSページ＝確定しない。卒年も付けない。
const chuto = gradeEvidence({
  kind: 'ats', source: 'embed', atsUrl: 'https://hrmos.co/pages/acme/jobs',
  atsPageText: '中途採用 キャリア採用 職務経歴書 第二新卒歓迎',
  linkContext: '中途採用｜キャリア採用',
});
eq('中途のみのATSページは中途用', chuto.grade, GRADE.CHUTO);
same('  中途の行に卒年は付けない', chuto.years, []);
// 一方、ATSページ本文に卒年があればナビの文言が中途でも確定にする。
// ページ本文（そのATSに実際に載っている求人）は、周辺ナビのテキストより強い証拠なので上書きさせる。
const mixed = gradeEvidence({
  kind: 'ats', source: 'embed', atsUrl: 'https://hrmos.co/pages/acme/jobs',
  atsPageText: `中途採用 キャリア採用 職務経歴書 ／ ${yy(1)}卒 新卒採用`,
  linkContext: '中途採用｜キャリア採用',
});
eq('中途求人が並んでいても卒年があれば確定', mixed.grade, GRADE.CONFIRMED);
same('  その卒年が付く', mixed.years, [yy(1)]);
const review = gradeEvidence({ kind: 'ats', source: 'marker', atsUrl: '' });
eq('要確認', review.grade, GRADE.REVIEW);
same('  要確認にも卒年は付けない', review.years, []);

console.log('\n[3] 卒年セルの読み戻し');
same('スラッシュ区切りを配列に', yearsOf('27卒/28卒'), ['27', '28']);
same('空は空配列', yearsOf(''), []);
same('（卒年不明）は卒年として扱わない', yearsOf('（卒年不明）').filter((y) => /^\d\d$/.test(y)), []);

console.log('\n[4] 架電可否（行は消さず理由を持つ）');
const rec = (o) => ({ '会社情報：電話': '03-1234-5678', ...o });
eq('電話があれば架電可', callBlockReason(rec({})), '');
ok('アプローチ禁止は理由が出る', /アプローチ禁止/.test(callBlockReason(rec({ 'カスタム情報：アプローチ禁止の種類': '反社' }))));
ok('新卒やってないは弾く', /ペンディング/.test(callBlockReason(rec({ 'カスタム情報：ペンディング理由': '新卒やってない' }))));
ok('架電拒否は弾く', /架電拒否/.test(callBlockReason(rec({ 'コール結果1：結果': '架電拒否' }))));
eq('電話が無ければ弾く', callBlockReason({ '会社情報：会社名': 'A' }), '電話番号なし');
eq('BALES未登録（rec無し）はここでは判定しない', callBlockReason(null), '');

console.log('\n[5] 行の組み立て（BALES優先→統合マスタで補完）');
const scan = {
  企業名: '株式会社テスト', ホスト: 'test.co.jp', ATS: '採用一括かんりくん',
  ATSベンダー: 'HRクラウド株式会社', 卒年: `${yy(1)}卒`, 判定グレード: '確定',
  新卒根拠: `ATS URLに新卒の印（卒年${yy(1)}）`, 'ATS URL': 'https://www.career-cloud.asia/x',
};
const withBales = toRow(scan, { rec: rec({ '会社情報：住所：都道府県': '東京都', '担当者情報：姓': '山田', '担当者情報：名': '太郎' }), how: 'ホスト一致' }, { rec: null, how: '' });
eq('BALESの電話を使う', withBales.電話, '03-1234-5678');
eq('  担当者名が入る', withBales.担当者, '山田 太郎');
eq('  架電可', withBales.架電可否, '架電可');
const onlyMaster = toRow(scan, { rec: null, how: '' }, { rec: { 電話番号: '06-1111-2222', 都道府県: '大阪府', 採用担当者名: '鈴木 花子' }, how: '統合マスタ（ホスト）' });
eq('BALESに無ければマスタの電話', onlyMaster.電話, '06-1111-2222');
eq('  マスタの担当者名も使う', onlyMaster.担当者, '鈴木 花子');
ok('  BALES未登録だと分かる文言', /BALES未登録/.test(onlyMaster.架電可否));
ok('  それでも架電可として残す', onlyMaster.架電可否.startsWith('架電可'));
const neither = toRow(scan, { rec: null, how: '' }, { rec: null, how: '' });
eq('どちらにも無ければ電話は空', neither.電話, '');
ok('  架電不可として理由が出る', /電話番号なし/.test(neither.架電可否));
eq('プレースホルダ担当者名は落とす', toRow(scan, { rec: rec({ '担当者情報：姓': '採用担当者' }), how: 'ホスト一致' }, { rec: null, how: '' }).担当者, '');
eq('卒年が空なら（卒年不明）', toRow({ ...scan, 卒年: '' }, { rec: null, how: '' }, { rec: null, how: '' }).卒年, '（卒年不明）');

console.log(`\n合計: ${pass} pass / ${fail} fail`);
if (fail) { console.log('失敗:'); fails.forEach((f) => console.log('  - ' + f)); }
assert.strictEqual(fail, 0, `${fail}件失敗`);
