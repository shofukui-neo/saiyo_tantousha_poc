'use strict';
// プレスリリース等の「お問い合わせ先」フッターから“担当者個人名”を抽出する。
//
// 着眼（[[recruiter-name-segment-finding]] の母集団壁への新手）:
//   中堅大手は自社採用ページに個人名を出さないが、プレスリリースの末尾には
//   「本件に関するお問い合わせ先 ○○部 担当：山田太郎 TEL/Email」という“ラベル付き実名”が載ることがある。
//   ラベルが付く＝人名が構造的に露出している＝姓辞書ゲートと相性が良い。広報/PR担当が多いが、
//   採用系リリース（新卒採用/採用強化/採用イベント）では人事・採用の担当者であることも多い。
//
// 設計: 既存資産を再利用（firstFullName=姓辞書ゲート / config.ROLE_KEYWORDS / 正規表現）。確証なしは返さない。
const { firstFullName } = require('./scrape-names');
const cfg = require('./config');

// 問い合わせ/取材ブロックの開始マーカー
const BLOCK_MARKERS = [
  '本件に関するお問', '本リリースに関するお問', '本件に関する報道', '本資料に関する',
  'お問い合わせ先', 'お問合せ先', 'お問合わせ先', 'お問い合せ先',
  '報道関係者', '取材に関する', '取材のお申し込み', 'メディア関係者', 'プレスに関する',
  'お問い合わせ', 'お問合せ', '【お問い合わせ', '＜お問い合わせ',
];

// 部署語（採用窓口に当たりやすい順で role 推定に使う）
const DEPT_RE = /(人事|採用|人材|広報|ＰＲ|PR|総務|経営企画|管理|事業|コーポレート|マーケティング)(?:部|本部|室|課|グループ|G|チーム|担当|局|センター)?/;
const ROLE_RE = new RegExp('(' + cfg.ROLE_KEYWORDS.concat(['広報', 'PR', 'ＰＲ', '総務', '担当'])
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i');

// 問い合わせブロックを“構造語”の手前で切る（後続の会社概要/関連リンク/PR TIMESチラシ/次の問合せを混ぜない）。
// この truncation が無いと 220字窓に「…小沢」「お問」「関連リンク」等が連結し、姓辞書ゲートを断片が突破する。
function clipBlock(block) {
  const b = String(block || '');
  let end = b.length;
  for (const stop of ['会社概要', '関連リンク', '関連リ', 'プレスリリース', 'ニュースリリース',
    'Copyright', '©', 'URL ', 'URL：', '当社は', '当社が', 'について\n', 'すべての画像']) {
    const i = b.indexOf(stop, 8); // 先頭マーカー自身は除く
    if (i >= 0 && i < end) end = i;
  }
  // 2つ目の「お問」が来たらそこで切る（次の問合せ枠の混入を防ぐ）
  const i2 = b.indexOf('お問', 8);
  if (i2 >= 0 && i2 < end) end = i2;
  return b.slice(0, end);
}

// 氏名候補トークンの最終検証。断片混入（お/ご/、/長音/役職語残り）を弾き、漢字フルネームを優先。
function cleanName(raw) {
  if (!raw) return '';
  const compact = String(raw).replace(/[ 　]/g, '');
  // 漢字（＋ごく一部のかな名）2〜5字。役割語/組織語/接続語の断片を拒否。
  if (!/^[一-龥々ぁ-んァ-ヶ]{2,5}$/.test(compact)) return '';
  if (/(お問|ご担|関連|詳細|当社|弊社|同社|本件|株式|有限|会社|について|まで|など|ほか|担当|窓口|部$|課$|室$)/.test(compact)) return '';
  const name = firstFullName(compact);
  return (name && name.length >= 2 && name.length <= 5) ? name : '';
}

// 1ブロック文字列から担当者を1名抽出する。
//   「担当：山田太郎」「担当者 山田 太郎」「広報部 山田太郎」「採用担当 田中花子」等。
//   名は原則“漢字フルネーム”に限定（プレスの担当表記の大半が漢字＝精度優先）。
function extractFromBlock(block) {
  const b = clipBlock(String(block || '').replace(/[ \t]+/g, ' '));
  // (1) 「担当(者)：氏名」最優先。氏名は漢字2-4＋任意の分かち書き1-3に限定（断片連結を断つ）。
  let m = b.match(/担当(?:者)?\s*[:：]?\s*([一-龥々]{2,4}(?:[ 　][一-龥々]{1,3})?)/);
  if (m) { const name = cleanName(m[1]); if (name) return finalize(name, b); }
  // (2) 部署＋担当ラベル＋氏名（「人事部 採用担当 田中花子」）
  const dm = b.match(new RegExp(DEPT_RE.source + '(?:採用|人事|広報|ＰＲ|PR|ご)?担当[:：]?\\s*([一-龥々]{2,4}(?:[ 　][一-龥々]{1,3})?)'));
  if (dm) { const name = cleanName(dm[dm.length - 1]); if (name) return finalize(name, b); }
  // (3) 部署語の直後に来る氏名（ラベルなし。「広報部 山田太郎」「コーポレート本部 田中一郎」）。cleanNameの辞書ゲートで断片を排除。
  const dm2 = b.match(new RegExp(DEPT_RE.source + '[ 　]?([一-龥々]{2,4}(?:[ 　][一-龥々]{1,3})?)'));
  if (dm2) { const name = cleanName(dm2[dm2.length - 1]); if (name) return finalize(name, b); }
  return null;
}

function finalize(name, block) {
  const role = (block.match(ROLE_RE) || [])[0] || '';
  const dept = (block.match(DEPT_RE) || [])[0] || '';
  const email = (block.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/) || [])[0] || '';
  const tel = (block.match(/(?:TEL|Tel|電話)[:：\s]*([0-9０-９][\d０-９\-－\(\) ]{7,})/) || [, ''])[1].trim();
  return { name, role, dept, email, tel };
}

// 本文テキスト全体から、問い合わせブロックを探して担当者を抽出する。
//   戻り値: { name, role, dept, email, tel, where } | null
function extractPressContact(text) {
  const t = String(text || '');
  if (!t) return null;
  // マーカー位置を全部集め、各マーカー以降 ~220字をブロック候補にする（後ろのものほど末尾フッターで確実）。
  const positions = [];
  for (const mk of BLOCK_MARKERS) {
    let from = 0, i;
    while ((i = t.indexOf(mk, from)) >= 0) { positions.push(i); from = i + mk.length; }
  }
  positions.sort((a, b) => a - b);
  // 末尾側（=会社チラシでなく問い合わせフッター）を優先しつつ、全ブロックを試して最初にヒットしたものを返す
  for (const pos of positions) {
    const block = t.slice(pos, pos + 220);
    const got = extractFromBlock(block);
    if (got) return { ...got, where: 'press-contact' };
  }
  return null;
}

module.exports = { extractPressContact, extractFromBlock, BLOCK_MARKERS };
