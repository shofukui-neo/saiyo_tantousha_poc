'use strict';
// マイナビ3パターン抽出器の単体テスト（ユーザー提示の実文面で較正）。
const assert = require('assert');
const {
  extractFromMessageBoard, extractFromInterview, extractFromEmployment, extractMynaviName, normPersonToken,
} = require('../src/mynavi-name-extract');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}  (got=${JSON.stringify(a)} want=${JSON.stringify(b)})`); }

// ── ① 伝言板の名乗り（corp237612 実文面）──────────────────────────
const PAT1 = `積極的に受付中
【新卒４期生募集中！】内々定まで最短2週間！ （2026/06/29更新）
人事部の青木と申します。
27新卒の採用をスタートしました。`;
{
  const r = extractFromMessageBoard(PAT1);
  ok(r, '① 名乗りを抽出できる');
  eq(r && r.name, '青木', '① 氏名=青木');
  eq(r && r.pattern, '伝言板の名乗り', '① パターン名');
}

// ── ② インタビュー帰属（corp72687 実文面）──────────────────────────
const PAT2 = `「企業規模の大きさに注目が集まりがちですが、当社グループのいちばんの魅力は“人”。個性を活かして輝ける会社です」（山野さん）
私たちは食の総合プロデュース事業会社です。……本文……
＜(株)コロワイド コーポレートサービス本部 人事企画部　山野 誠一郎さん＞`;
{
  const r = extractFromInterview(PAT2);
  ok(r, '② 帰属を抽出できる');
  eq(r && r.name, '山野 誠一郎', '② 氏名=山野 誠一郎（フル）');
  eq(r && r.dept, '人事企画部', '② 部署=人事企画部');
  eq(r && r.pattern, 'インタビュー帰属', '② パターン名（完全形優先）');
}
// ②補助：話者注記のみでも姓を取れる
{
  const r = extractFromInterview('……本文です」（山野さん）\nつづき');
  ok(r && r.name === '山野', '②b 話者注記（山野さん）→山野');
}

// ── ③ 問合せ先（displayEmployment 実文面）──────────────────────────
const PAT3 = `問合せ先
問合せ先	〒503-0854
岐阜県大垣市築捨町4－38－3
0584－89－1620
管理部　川瀬・伊藤
kanri＠onoden.jp`;
{
  const r = extractFromEmployment(PAT3);
  ok(r, '③ 問合せ先を抽出できる');
  eq(r && r.name, '川瀬', '③ 氏名=川瀬（複数の先頭）');
  eq(r && r.dept, '管理部', '③ 部署=管理部');
}

// ── ディスパッチャ（ページ種別ごと）──────────────────────────────
eq(extractMynaviName(PAT1, { page: 'outline' }).name, '青木', 'dispatch outline→①');
eq(extractMynaviName(PAT2, { page: 'outline' }).name, '山野 誠一郎', 'dispatch outline→②');
eq(extractMynaviName(PAT3, { page: 'employment' }).name, '川瀬', 'dispatch employment→③');

// ── normPersonToken（緩い人名ゲート）────────────────────────────
eq(normPersonToken('山野 誠一郎さん'), '山野 誠一郎', 'normalize: 敬称除去＋姓名');
eq(normPersonToken('川瀬・伊藤', { list: true }), '川瀬', 'normalize: 複数→先頭');
eq(normPersonToken('青木'), '青木', 'normalize: 辞書姓');
eq(normPersonToken('人事部'), '', 'normalize: 役割語を却下');
eq(normPersonToken('管理部'), '', 'normalize: 部署語を却下');
eq(normPersonToken('岐阜'), '', 'normalize: 地名を却下');
eq(normPersonToken('田中 太郎まで'), '田中 太郎', 'normalize: 末尾助詞除去');
// 実走で観測した住所/断片の誤爆を却下（フォールバック抽出の後段ゲート）
eq(normPersonToken('東京都'), '', 'normalize: 「東京都」を却下（住所語尾）');
eq(normPersonToken('福井 県坂井'), '', 'normalize: 「福井県坂井」を却下（都道府県先頭）');
eq(normPersonToken('先住所'), '', 'normalize: 「先住所」を却下（壊れ断片）');
eq(normPersonToken('先日精'), '', 'normalize: 「先日精」を却下（壊れ断片）');
eq(normPersonToken('近藤哲也'), '近藤 哲也', 'normalize: 良い氏名は姓名整形して残す');
eq(normPersonToken('丸山'), '丸山', 'normalize: 辞書姓は残す');

// ── 誤爆しないこと（学歴の＜＞は さん が無いので拾わない）──────────
ok(!extractFromInterview('＜大学院＞\n＜大学＞\n＜短大・高専・専門学校＞'), '② 学歴の角括弧は拾わない');
ok(!extractFromMessageBoard('私たちは食の総合プロデュース事業会社です'), '① 一般文は拾わない');

console.log(`\nmynavi-extract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
