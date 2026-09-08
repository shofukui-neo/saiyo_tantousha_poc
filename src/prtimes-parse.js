'use strict';
/**
 * prtimes-parse — PR TIMES リリースページの構造抽出（build-prtimes / harvest-signals 共用）
 * =====================================================================
 * PR TIMES は本文末尾に「会社概要」をラベル連結のプレーンテキストで出すため、
 * 検索エンジンを介さずに 企業名・公式URL・業種・所在地・電話・代表者名 が1本で揃う。
 * その取り出し方をここに集約する（同じ壊れ方を2箇所で直さないため）。
 *
 * 実データで踏んだ罠（2026-09 実測）— 個別のスクリプトに書くと必ず片方だけ直る:
 *   ・代表者名に肩書き/上場区分が貼り付く … 「高橋泰行上場東証スタンダ」「代表取締役社長 加納慎也」
 *   ・都道府県が前の文字を巻き込む       … 「：石川県」「地福岡県」（`.{2,3}県` の貪欲一致）
 *   ・本文末尾のタグ欄が本文と混ざる      … 商品リリースなのに「新工場」タグでシグナル誤爆
 */

// 47都道府県の明示列挙。`.{2,3}県` だと直前の文字を巻き込む（「地福岡県」）ため使わない。
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
const PREF_RE = new RegExp('(' + PREFS.join('|') + ')');

/** テキスト中の最初の都道府県名を返す（無ければ空文字）。 */
function pickPrefecture(text) {
  const m = String(text || '').match(PREF_RE);
  return m ? m[1] : '';
}

/**
 * PR TIMES「代表者名」ラベル直後の値を整形。
 * ラベル付き＝人名確定なので isPlausiblePersonName の厳格ゲート（姓辞書/全漢字/≤6字）には頼らず、
 * 前後に貼り付く肩書き・制度語を剥がして軽く検証する（珍姓・かな名も許容する）。
 */
function cleanRepName(raw) {
  let s = String(raw || '').replace(/[ 　]/g, '');
  // 末尾に貼り付く制度語・肩書きを除去
  s = s.replace(/(上場.*|未上場.*|資本金.*|設立.*|電話.*|所在地.*|URL.*|代表取締役社?長?|代表取締|取締役社?長?|CEO|社長|会長|理事長|院長|店長|園長|代表)$/g, '');
  s = s.replace(/^(代表取締役(社長|会長|CEO)?|代表取締|取締役(社長)?|CEO|社長|会長|理事長|代表)/g, '');
  if (s.length < 2 || s.length > 8) return '';
  if (/[A-Za-z0-9０-９@./、。（）()]/.test(s)) return '';
  if (/採用|人事|総務|担当|事業|株式|有限|会社|部$|課$|室$|営業|本社|支店/.test(s)) return '';
  if (/^(東京|大阪|名古屋|横浜|本社|当社|同社|弊社)/.test(s)) return '';
  if (!/^[一-龥々ぁ-んァ-ヶ]+$/.test(s)) return '';
  return s;
}

/**
 * PR TIMES 本文の「読むべき範囲」だけを返す。
 * ページ末尾には タグ欄／関連リンク／会社概要／問い合わせ先 が続き、そこに現れる単語で
 * シグナルが誤爆する（実例: 新商品リリースが「新工場」タグだけで新工場OPEN判定された）。
 * @param {string} bodyText article/main のテキスト
 */
function trimBoilerplate(bodyText) {
  const t = String(bodyText || '');
  const markers = ['プレスリリース詳細', '関連リンク', 'このプレスリリース', 'ダウンロード', '会社概要', '本件に関する', 'お問い合わせ先', 'すべての画像', '種類ビジネスカテゴリ'];
  let cut = t.length;
  for (const m of markers) {
    const i = t.indexOf(m);
    // 冒頭付近の一致は見出しの一部なので無視する（本文が丸ごと消えるのを防ぐ）
    if (i > 120 && i < cut) cut = i;
  }
  return t.slice(0, cut);
}

/**
 * 会社概要ブロック（ラベル連結のプレーンテキスト）から企業属性を抜く。
 * @param {string} pageText body 全体のテキスト（空白畳み込み済みでよい）
 * @returns {{公式URL:string, 業種:string, 都道府県:string, 電話番号:string, 代表者名:string, 上場:string, 設立:string}}
 */
function parseCompanyProfile(pageText) {
  const t = String(pageText || '').replace(/[ \t　]+/g, ' ');
  const seg = (t.match(/会社名[\s\S]{0,500}?(?:設立|資本金|関連リンク|プレスリリース詳細)/) || [t])[0];
  const pick = (re) => { const m = seg.match(re); return m ? m[1].trim() : ''; };
  return {
    公式URL: pick(/URL\s*(https?:\/\/[a-zA-Z0-9.\-/_%?=&#~]+)/),
    業種: pick(/業種\s*([^\s：:]{2,14}?)(?:本社|所在地|電話|代表|URL)/),
    都道府県: pickPrefecture(seg),
    電話番号: pick(/電話番号\s*([0-9０-９][\d０-９\-－]{7,})/),
    代表者名: cleanRepName(pick(/代表者(?:名)?[：:\s]*([一-龥々ぁ-んァ-ヶ]{2,20}(?:[ 　][一-龥々ぁ-んァ-ヶ]{1,8})?)/)),
    上場: pick(/上場\s*(未上場|東証[^\s]{0,6}|名証[^\s]{0,4}|上場)/),
    設立: (seg.match(/設立\s*((?:19|20)\d{2})\s*年/) || [, ''])[1],
  };
}

module.exports = { PREFS, PREF_RE, pickPrefecture, cleanRepName, trimBoilerplate, parseCompanyProfile };
