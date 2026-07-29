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
// ②b 話者注記（（姓さん）単独）は採らない。HR帰属の裏付けが無い注記は
//     社員インタビューの被取材者・顧客敬称を誤採用するため撤去した（三和/いしのまき型の誤爆源）。
{
  const r = extractFromInterview('……本文です」（山野さん）\nつづき');
  ok(!r, '②b 単独の話者注記（山野さん）は採らない（HR帰属なし）');
}
// ②c HR部署の帰属が無いインタビュー登場人物は採らない（先輩社員の声＝一般社員）。
{
  const emp = `入社3年目の佐藤さんに聞きました。（佐藤さん）「やりがいがあります」
＜(株)サンプル 営業本部 営業部　佐藤 一郎さん＞`;
  ok(!extractFromInterview(emp), '②c 営業部の被取材者（佐藤 一郎）は採用担当として採らない');
}
// ②d 実データ誤爆の再現防止：一般名詞＋さん（荷主/甲方/日中）を氏名化しない。
ok(!extractFromInterview('物流のプロとして（荷主さん）の立場で考えます'), '②d 「荷主さん」を氏名化しない');
ok(!extractFromInterview('契約上（甲方さん）と（乙方さん）が…'), '②d 「甲方さん」を氏名化しない');
// ②e HR部署の帰属があるインタビューは採る。氏名に貼り付いた先頭役職「部長」も除去する。
{
  const hr = `＜(株)サンプル 人事部 部長 笠井英樹さん＞`;
  const r = extractFromInterview(hr);
  ok(r && r.name === '笠井 英樹', '②e 人事部帰属は採り、先頭役職「部長」を除去する (got=' + (r && r.name) + ')');
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

// ══════════════════════════════════════════════════════════════════════════════
// 2026-07 誤抽出リグレッション（ユーザー報告8社）。二度と再発しないよう固定する。
//   山形県庁=任用 / (株)新出光=面接 / 国立成育医療研究センター=験申込書 : 非人名語を人名化
//       → isNonPersonWord（jp-names）で辞書外フォールバックを塞ぐ
//   (株)コナカ=次長 : 役職語を人名化 → 同ゲートで却下（LEAD_TITLE_RE + isNonPersonWord）
//   三和スーパー=浅井 / JAいしのまき=佐藤 : 話者注記（HR帰属なし）→ 撤去済（②b–②d で固定）
//   上田工業=江藤までお : 助詞glue → normPersonTokenの字種ゲートで却下
// ══════════════════════════════════════════════════════════════════════════════
const { isNonPersonWord, SURNAMES, splitName } = require('../src/jp-names');

// A) 非人名語ゲート（トークン単位）。採用/選考プロセス語・書類語・庶務語・役職語は氏名化しない。
const NON_PERSON = ['面接', '面談', '選考', '選抜', '試験', '筆記', '適性', '内定', '内々定', '志望',
  '受験', '応募', '説明会', '座談', '見学', '登録', '予約', '日程', '会場', '受付', '締切', '募集',
  '求人', '採用', '待遇', '給与', '賞与', '研修', '教育', '評価', '申込', '申請', '願書', '履歴',
  '書類', '要項', '概要', '資料', '様式', '用紙', '記入', '証明', '提出', '任用', '公平', '庶務',
  '服務', '労務', '案内', '手続', '詳細', '内容', '条件', '実施', '予定', '結果', '通知', '合格',
  '次長', '課長', '部長', '係長', '室長', '本部長', '主事', '参事', '補佐',
  '験申込書', '受験申込書', '公平担当', '任用・公平担当',
  // 第2陣（2026-07 追加報告）: 連絡先ラベル語・職能/人物カテゴリ語
  '電話番号', '電話', '番号', '内線', '直通', '郵便番号', '住所', '所在地', 'メール',
  '人材開発', '人材', '人財', '事務局', '委員会', '職員', '社員', '従業員', '職種', '職務', '求職'];
for (const w of NON_PERSON) {
  ok(isNonPersonWord(w), `A: 非人名語「${w}」を検知する`);
  eq(normPersonToken(w), '', `A: normPersonToken「${w}」→空`);
  eq(normPersonToken(w, { list: true }), '', `A: normPersonToken(list)「${w}」→空`);
}

// B) 実在姓・実在氏名は誤って弾かない（再現率の防波堤）。
const REAL_NAMES = ['堀江', '川瀬', '山野', '青木', '笠間', '太田', '佐藤', '鈴木', '高橋', '田中',
  '中村', '丸山', '山田 太郎', '近藤 哲也', '早瀬 峻介', '松田 龍治', '山野 誠一郎', '笠井 英樹'];
for (const nm of REAL_NAMES) {
  ok(!isNonPersonWord(nm), `B: 実在氏名「${nm}」は非人名語でない`);
  ok(normPersonToken(nm) !== '', `B: normPersonToken「${nm}」を残す`);
}

// B2) 姓ガゼッティア全体を過剰ブロックしていないこと（辞書の全姓が isNonPersonWord=false）。
//     ＝ NON_PERSON_WORDS の部分一致が実在姓に誤爆しないことを網羅検証。
{
  const bad = [...SURNAMES].filter((s) => isNonPersonWord(s));
  ok(bad.length === 0, `B2: 辞書姓を非人名語と誤判定しない（誤爆=${JSON.stringify(bad)}）`);
}

// C) 山形県庁 問合せ先：「人事委員会事務局職員課　任用・公平担当」→ 個人名なし。
const YAMAGATA = ['問合せ先', '〒990-8570 山形県山形市松波二丁目8番1号', '023-630-2782',
  '人事委員会事務局職員課　任用・公平担当'].join('\n');
ok(!extractFromEmployment(YAMAGATA), 'C: 山形県庁「任用」を氏名化しない');
ok(!extractMynaviName(YAMAGATA, { page: 'employment' }), 'C: dispatch(山形県庁 employment)も氏名なし');

// D) コナカ 問合せ先：「人事部　次長　堀江」→ 役職「次長」を氏名化しない（堀江なら可、次長は不可）。
const KONAKA = ['問合せ先', '045-825-7766', '人事部　次長　堀江', 'r_horie＠konaka.co.jp'].join('\n');
{
  const r = extractFromEmployment(KONAKA);
  ok(!r || r.name !== '次長', 'D: コナカ「次長」を氏名化しない');
}

// E) 過剰ブロック検知（正常系）：部署直後の実在姓・フルネームは従来どおり抽出できる。
{
  const r = extractFromEmployment(['問合せ先', '03-1234-5678', '人事部　堀江', 'saiyo＠example.co.jp'].join('\n'));
  eq(r && r.name, '堀江', 'E: 「人事部 堀江」は堀江を抽出（過剰ブロックしない）');
}
{
  const r = extractFromEmployment(['問合せ先', '03-1234-5678', '採用部　山田太郎'].join('\n'));
  eq(r && r.name, '山田 太郎', 'E: 「採用部 山田太郎」は山田 太郎を抽出');
}

// F) 三和スーパー/JAいしのまき：話者注記（HR帰属なし）は佐藤(実在姓)でも氏名化しない。
ok(!extractFromInterview('地域の農業を支えます」（佐藤さん）\nつづき'), 'F: 「（佐藤さん）」単独注記は氏名化しない（いしのまき型）');
ok(!extractFromInterview('お客様に寄り添う姿勢が大切です」（浅井さん）'), 'F: 「（浅井さん）」単独注記は氏名化しない（三和型）');

// G) 上田工業：助詞glue「江藤までお（問合せ下さい）」は氏名化しない。
eq(normPersonToken('江藤までお'), '', 'G: 助詞glue「江藤までお」→空');
eq(normPersonToken('江藤 までお'), '', 'G: 助詞glue「江藤 までお」→空');

// H) 第2陣（連絡先ラベル語・職能語）の問合せ先。氏名なし。
//    北大阪JA=電話番号 / 八戸市立市民病院=内線 / ベルテクス=人材開発
ok(!extractFromEmployment(['問合せ先', '総務課人事係', '電話番号 06-6877-5140'].join('\n')),
  'H: 北大阪JA「電話番号」を氏名化しない');
ok(!extractFromEmployment(['問合せ先', '事務局管理課総務グループ', '内線 0178-72-5111'].join('\n')),
  'H: 八戸市立市民病院「内線」を氏名化しない');
ok(!extractFromEmployment(['問合せ先', '03-3556-0465', '人事部　人材開発', 'saiyo＠example.co.jp'].join('\n')),
  'H: ベルテクス「人材開発」を氏名化しない');
// H2) 過剰ブロック検知：実在姓（瀬川/工藤/後藤/塚本/中村）は第2陣追加後も残す。
for (const nm of ['瀬川', '工藤', '後藤', '塚本', '中村']) {
  ok(normPersonToken(nm) === nm, `H2: 実在姓「${nm}」を残す（第2陣で過剰ブロックしない）`);
}

console.log(`\nmynavi-extract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
