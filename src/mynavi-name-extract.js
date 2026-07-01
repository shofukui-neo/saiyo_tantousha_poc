'use strict';
/**
 * マイナビ 採用担当者名 抽出スキル（3パターン・実DOM較正済 2026-07）
 * ============================================================================
 * ユーザー指定の「マイナビに担当者名が載る3つの場所」をそれぞれ専用抽出器で堅く取る。
 *
 *  ① 伝言板の名乗り（outline.html の企業メッセージ）
 *      例: 「人事部の青木と申します。」
 *      → ROLE の <氏名> と申します/です の自己名乗り。最強（本人が名乗る）。
 *
 *  ② インタビュー文末の帰属表記（outline.html の仕事紹介/インタビュー）
 *      例: 「＜(株)コロワイド コーポレートサービス本部 人事企画部　山野 誠一郎さん＞」
 *          「（山野さん）」
 *      → ＜…部署　姓 名さん＞ の角括弧帰属、および（姓さん）の話者注記。
 *
 *  ③ 採用データの問合せ先（displayEmployment ページ）
 *      例: 「問合せ先 … 0584-89-1620  管理部　川瀬・伊藤  kanri@onoden.jp」
 *      → 問合せ先ブロック内の「部署　氏名(・氏名)」。電話/メールに挟まれた構造で確実。
 *
 * 設計の肝＝「構造アンカー＋緩い人名ゲート」。
 *   マイナビ掲載企業は中小が多く、担当者姓が姓辞書(jp-names)に載らない事が多い（川瀬/山野…＝母集団問題）。
 *   だが上記3つは「名乗り/さん/問合せ先の部署直後」という強い構造で人名を保証するので、
 *   辞書一致を要求せず「2〜6字の漢字（間に1スペース許容）で、役割語/地名/業種語でない」なら人名として採る。
 *   辞書に載る姓は「姓 名」に整形（表記統一）、載らなければ構造位置の生トークンを尊重する。
 *
 * 戻り値は共通形: { name, dept, role, confidence, pattern, evidence } または null。
 */
const { splitName, isPlausiblePersonName } = require('./jp-names');

const K = '一-龥々〆ヶ';                        // 氏名に使う漢字レンジ
const NAME_TOKEN = `[${K}]{1,4}(?:[ 　][${K}]{1,4})?`; // 姓 or 姓+名（間に半/全角スペース1つ許容）

// 人名として却下する語（役割/組織/業種/地名）。given名にはまず現れない。
const STOP_RE = /採用|人事|総務|管理|募集|担当|責任|営業|製造|技術|企画|広報|経理|財務|事業|部門|本部|支店|支社|営業所|会社|株式|有限|合同|グループ|センター|スタッフ|チーム|部$|課$|室$|係$|科$/;
// 都道府県・主要都市の先頭一致（住所を氏名と誤認しない）。全都道府県を網羅。
const GEO_RE = /^(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄|名古屋|横浜|神戸|札幌|仙台|関東|関西|東海|九州|信越|北陸|四国|本社|本店|本部|中央|大垣|坂井)/;
// 行政区画サフィックスで終わる語は住所（氏名は 都/府/県/郡 で終わらない。市/区/町/村は姓と衝突するので除外）。
const GEO_TAIL_RE = /(都|道|府|県|郡)$/;
// 「問合せ先」の"先"や住所断片が貼り付いた壊れトークン（先住所/先日精…）を弾く。
const BROKEN_HEAD_RE = /^(先|問|御中|様方)/;
const INDUSTRY_TAIL_RE = /(業|社|店|部|課|係|科|商事|工業|電気|建設|産業|製作|販売|興業|運輸|物産|サービス|印刷|食品|運送)$/;
// 敬称・助詞（末尾から剥がす）。氏名にはこれらは含まれない。
const HONORIFIC_TAIL_RE = /(さん|さま|様|氏|くん|君|まで(?:に)?|より|から|宛て?|など|の方|行|各位|御中)$/;

/**
 * 構造アンカーで得た生トークンを正規化して人名を返す（緩いゲート・辞書非依存）。
 * @param {string} raw 例: "青木" / "山野 誠一郎" / "川瀬・伊藤" / "山野さん"
 * @param {{list?: boolean}} opts list=true なら中黒/読点区切りの複数担当を先頭1名に正規化
 * @returns {string} 整形済み氏名（"姓 名" or "姓"）／不適格なら ''
 */
function normPersonToken(raw, opts = {}) {
  let s = String(raw || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[　\s]+/g, ' ').trim();
  if (!s) return '';
  // 複数担当（川瀬・伊藤）は先頭1名。※氏名内スペースは保持したいので中黒/読点でのみ分割。
  if (opts.list) s = s.split(/[・･／/、,，]/)[0].trim();
  // 末尾の敬称/助詞を剥がす（繰り返し：「田中さんまで」→「田中」）
  for (let i = 0; i < 3; i++) { const t = s.replace(HONORIFIC_TAIL_RE, '').trim(); if (t === s) break; s = t; }
  s = s.replace(/[　\s]+/g, ' ').trim();
  const compact = s.replace(/\s/g, '');
  // 字種・長さ（2〜6字の漢字のみ）
  if (!new RegExp(`^[${K}]{2,6}$`).test(compact)) return '';
  if (STOP_RE.test(compact)) return '';
  if (GEO_RE.test(compact)) return '';
  if (GEO_TAIL_RE.test(compact)) return '';       // 「東京都」「○○県」等の住所語尾
  if (BROKEN_HEAD_RE.test(compact)) return '';     // 「先住所」「先日精」等の壊れ断片
  if (INDUSTRY_TAIL_RE.test(compact)) return '';
  // 姓辞書に載れば「姓 名」に整形（表記統一）
  const sp = splitName(compact);
  if (sp && sp.mei) return `${sp.sei} ${sp.mei}`;
  if (sp && sp.mei === '') return sp.sei;
  // 辞書外：構造アンカーが人名を保証。スペースがあれば姓名境界として尊重。
  if (s.includes(' ')) { const p = s.split(' '); return `${p[0]} ${p.slice(1).join('')}`; }
  return compact; // 2〜6字の漢字（辞書外姓・単独）
}

// 部署（人事/採用/総務/管理/広報 等＋組織サフィックス）。氏名の直前アンカーに使う。
const DEPT_RE = new RegExp(`([${K}]{0,8}?(?:人事|採用|人材|人財|総務|管理|広報|経営企画|コーポレート)[${K}ァ-ヶ]{0,8}?(?:部|課|室|グループ|本部|センター|係|G))`);

// ── ① 伝言板の名乗り ─────────────────────────────────────────────
// 「人事部の青木と申します」「採用担当の田中です」「人事の佐藤と申し上げます」
const MB_ROLE = `(?:人事|採用|人材|人財|総務|広報|経営企画|新卒採用)[${K}]{0,6}?(?:部|課|室|グループ|本部|チーム|担当者?|スタッフ)?`;
const MB_RE = new RegExp(`(${MB_ROLE})の(${NAME_TOKEN})\\s*(と申します|と申し上げ|と申し上げます|です|でございます|が担当|が(?:採用を)?担当)`, 'g');

function extractFromMessageBoard(text) {
  const t = String(text || '');
  MB_RE.lastIndex = 0;
  let m;
  while ((m = MB_RE.exec(t)) !== null) {
    const dept = m[1];
    const name = normPersonToken(m[2]);
    if (!name) { MB_RE.lastIndex = m.index + 1; continue; }
    return { name, dept: /部|課|室|グループ|本部|チーム/.test(dept) ? dept : '', role: dept,
      confidence: 0.85, pattern: '伝言板の名乗り', evidence: m[0].trim().slice(0, 80) };
  }
  return null;
}

// ── ② インタビュー文末の帰属表記 ─────────────────────────────────
// 完全形: 「＜(株)コロワイド … 人事企画部　山野 誠一郎さん＞」← 姓名フル。最優先。
const IV_FULL_RE = new RegExp(`[＜<]([^＜<＞>]{0,60}?)((?:[${K}]{1,4})[ 　][${K}]{1,4})さん[ 　]*[＞>]`, 'g');
// 話者注記: 「（山野さん）」「(山野さん)」← 姓のみ。補助。
const IV_PAREN_RE = new RegExp(`[（(]([${K}]{2,5})さん[）)]`, 'g');

function extractFromInterview(text) {
  const t = String(text || '');
  // まず完全形（部署＋姓名）を探す
  IV_FULL_RE.lastIndex = 0;
  let m;
  while ((m = IV_FULL_RE.exec(t)) !== null) {
    const ctx = m[1] || '';
    const name = normPersonToken(m[2]);
    if (!name) { IV_FULL_RE.lastIndex = m.index + 1; continue; }
    const dept = (ctx.match(DEPT_RE) || [])[1] || '';
    return { name, dept, role: dept, confidence: 0.78, pattern: 'インタビュー帰属', evidence: m[0].trim().slice(0, 90) };
  }
  // 補助：（姓さん）注記。ただし単独では弱いので confidence 低め。
  IV_PAREN_RE.lastIndex = 0;
  while ((m = IV_PAREN_RE.exec(t)) !== null) {
    const name = normPersonToken(m[1]);
    // 姓辞書に載る or 明確な人名のみ採る（一般語（例:「以上さん」）誤爆防止）
    if (name && isPlausiblePersonName(name)) {
      return { name, dept: '', role: '', confidence: 0.6, pattern: 'インタビュー話者注記', evidence: m[0].trim().slice(0, 60) };
    }
    IV_PAREN_RE.lastIndex = m.index + 1;
  }
  return null;
}

// ── ③ 採用データの問合せ先ブロック ───────────────────────────────
// 「問合せ先 … TEL … 管理部　川瀬・伊藤 … kanri@…」部署直後の氏名(複数は先頭)。
const CONTACT_KW_RE = /問\s?合わ?せ先|お問い?合わ?せ先?|連絡先/;
// 部署　氏名（・氏名）… の行。氏名は中黒/読点で複数連結され得る。
// ※DEPT_RE.source は既に自身のキャプチャ群を含むので、ここでは括らない（g1=部署, g2=氏名）。
const EMP_NAME_RE = new RegExp(`${DEPT_RE.source}[ 　]+([${K}]{2,4}(?:[・･、,][${K}]{2,4})*)(?![${K}])`);

function extractFromEmployment(text) {
  const t = String(text || '').replace(/[ \t]+/g, ' ');
  const km = t.match(CONTACT_KW_RE);
  if (!km) return null;
  // 問合せ先の見出し以降 250字を作業ブロックに（住所→電話→部署氏名→メールの並び）
  const block = t.slice(km.index, km.index + 250);
  const nm = block.match(EMP_NAME_RE);
  if (nm) {
    const dept = nm[1];
    const name = normPersonToken(nm[2], { list: true });
    if (name) {
      return { name, dept, role: dept, confidence: 0.8, pattern: '問合せ先', evidence: (dept + ' ' + nm[2]).slice(0, 60) };
    }
  }
  return null;
}

/**
 * ページ種別に応じて最適な抽出器を当て、最有力の担当者名を1件返す。
 * @param {string} text ページ本文（innerText）
 * @param {{page?: 'outline'|'employment'|'is'|'message'|'any'}} opts
 * @returns {{name, dept, role, confidence, pattern, evidence}|null}
 */
function extractMynaviName(text, opts = {}) {
  const page = opts.page || 'any';
  const tryOrder = [];
  if (page === 'employment' || page === 'is') tryOrder.push(extractFromEmployment);
  if (page === 'outline' || page === 'message' || page === 'any') {
    tryOrder.push(extractFromMessageBoard, extractFromInterview);
  }
  if (page === 'any') tryOrder.push(extractFromEmployment);
  // employmentページでも名乗り/帰属が本文にある事があるので any 相当で補完
  if (page === 'employment') tryOrder.push(extractFromMessageBoard, extractFromInterview);
  let best = null;
  for (const fn of tryOrder) {
    const r = fn(text);
    if (r && (!best || r.confidence > best.confidence)) best = r;
  }
  return best;
}

module.exports = {
  extractFromMessageBoard, extractFromInterview, extractFromEmployment,
  extractMynaviName, normPersonToken,
};
