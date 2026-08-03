'use strict';
/**
 * 企業同定マッチャ（重複除去の単一情報源）── 2026-07 v2
 * =====================================================================
 * 「この企業は既存顧客/既納品リストに含まれるか」を判定する層。
 * 除外マスタの読込は exclusion-index.js に集約され、本モジュールが突合規則を持つ。
 *
 * 突合キー（上から順に判定。先に当たった段で確定）:
 *   1) 法人番号（13桁完全一致）              … 最優先・誤りなし          tier=法人番号
 *   2) 正規化社名（csv.normCompanyName）      … 注釈括弧/法人格/記号除去   tier=社名
 *   3) 農協コア（companyCore）                … JA○○ ⇔ ○○農業協同組合   tier=農協
 *   4) 表記ゆれキー（looseKey）               … 旧字体/長音記号の字種/カナ⇔かな/支店等  tier=表記ゆれ
 *   5) 長音ゆれキー（fuzzyKey・任意）          … 長音「ー」の有無を無視     tier=長音ゆれ
 *
 * 4/5 を足した理由（2026-07-30 実測）: マスタ110,426行(strictユニーク55,925)で
 * 旧字体30組・長音字種76組・カナ405組・支店等327組が「同一法人の別表記」として
 * strictキーで分離していた＝取りこぼしていた。一方 5) の長音削除は
 * 「ファミリー/ファミリ」「スリーエス/スリーエース」のような別法人衝突を含むため
 * 既定で有効にしつつ**必ず監査ログへ出す**（silent drop を作らない）。
 *
 * 安全ガード:
 *   - 農協: 連合会/中央会（信連・経済連・共済連・厚生連）は別法人なので collapse しない。
 *   - 支店/営業所: 「後株＋支店名」（例 ○○株式会社柏支社）は法人格の後ろを丸ごと落として
 *     親法人に寄せる。前株（例 株式会社○○本社）は末尾の支店語のみ落とす。
 *   - ホールディングス/HD は別法人（持株会社）なので落とさない。「グループ」は落とす。
 *   - キーが1つも作れない行（社名も法人番号も無い）は hasKey()=false。呼び出し側は
 *     「未突合＝新規」と誤認しないこと（verifiable でない行は成果物から落とす）。
 */
const { normCompanyName, normCorpNumber, stripAnnotations, toHalfWidth, CORP_FORMS } = require('./csv');

// 会社名として拾う列（内部スキーマ／BALES 266列／Google出力/MOCHICA顧客の揺れを吸収）
const NAME_COLS = ['会社情報：会社名', '企業名', '会社名', '法人名', 'LINEアカウント登録企業名', 'company_name'];
const BANGO_COLS = ['法人番号'];

function pickName(rec) {
  for (const c of NAME_COLS) { const v = rec[c]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}
function pickBango(rec) {
  for (const c of BANGO_COLS) { const v = rec[c]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}

/**
 * 農協系の別称コアを返す（無ければ ''）。JA○○ と ○○農業協同組合/○○農協 を同一視するためのキー。
 * ・連合会/中央会 を含む名称は別法人なので collapse しない（'' を返す）。
 * ・末尾「農業協同組合」/「農協」除去、先頭「ja」除去でコアを得る。コア長 < 2 は無効。
 */
function companyCore(name) {
  const s = normCompanyName(name); // 注釈除去・記号除去・小文字化済み（漢字は残る）
  if (!s) return '';
  if (/連合会|中央会/.test(s)) return ''; // 信連/経済連/共済連/厚生連/中央会 は collapse しない
  let core = s;
  let isCoop = false;
  if (/農業協同組合$/.test(core)) { core = core.replace(/農業協同組合$/, ''); isCoop = true; }
  else if (/農協$/.test(core)) { core = core.replace(/農協$/, ''); isCoop = true; }
  if (/^ja/.test(core)) { core = core.replace(/^ja/, ''); isCoop = true; }
  core = core.trim();
  if (!isCoop || core.length < 2) return '';
  return 'coop:' + core;
}

// ── 表記ゆれキー（tier4） ─────────────────────────────────────────────
// 旧字体 → 新字体（実測でマスタ内に同一法人の別表記として出現したものを採録）
const OLD_TO_NEW = {
  髙: '高', 﨑: '崎', 濵: '浜', 濱: '浜', 德: '徳', 嶋: '島', 嵜: '崎', 眞: '真', 瀨: '瀬', 瀧: '滝',
  邊: '辺', 邉: '辺', 齋: '斎', 齊: '斉', 國: '国', 學: '学', 會: '会', 廣: '広', 澤: '沢', 曾: '曽',
  寳: '宝', 龍: '竜', 藪: '薮', 桒: '桑', 槗: '橋', 圓: '円', 惠: '恵', 榮: '栄', 豐: '豊', 淸: '清',
  眗: '晃', 舘: '館', 冨: '富', 籔: '薮', 珎: '珍', 竈: '釜',
};
const OLD_RE = new RegExp('[' + Object.keys(OLD_TO_NEW).join('') + ']', 'g');
// 長音・ダッシュ類の字種ゆれ（「ソニ―」「ソニ－」→「ソニー」）。長音そのものは残す。
// ※ normCompanyName は「-‐－―」を区切り記号として**削除**するため、正規化より前に
//    「ー」へ寄せておく必要がある（後段だと「ソニ―」が「そに」に潰れて別キーになる）。
const DASH_RE = /[―‐–—－‒﹣ｰ~～〜]/g;
const unifyDash = (s) => String(s || '').replace(DASH_RE, 'ー');
// 支店・拠点ラベル（同一法人の拠点差。除去して親法人に寄せる）
const BRANCH_WORD = '支社|支店|営業所|営業部|営業本部|本社|本店|本部|事業部|事業所|支部|出張所|工場';
const BRANCH_TAIL_RE = new RegExp(`(${BRANCH_WORD})$`);
const PREFS_RE = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)$/;
// 後株＋支店名（例「ソニー生命保険株式会社柏支社」）→ 法人格まででカット
const CORP_FORM_ALT = CORP_FORMS.concat(['(株)', '（株）']).map((s) => s.replace(/[()（）]/g, '\\$&')).join('|');
const POST_CORP_BRANCH_RE = new RegExp(`^(.+?(?:${CORP_FORM_ALT}))(.{1,14}?(?:${BRANCH_WORD}))$`);

function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
// 支店・拠点表記を落として親法人名に寄せる（正規化前の原文に対して適用）
function stripBranch(name) {
  let s = stripAnnotations(toHalfWidth(String(name || ''))).trim();
  if (!s) return String(name || '');
  const m = s.match(POST_CORP_BRANCH_RE);
  if (m && m[1].length >= 3) return m[1]; // 後株の後ろは拠点名＝丸ごと落とす
  // 前株/法人格なし: 末尾の支店語（＋直前の都道府県名）を反復除去
  for (let i = 0; i < 3; i++) {
    const t = s.replace(BRANCH_TAIL_RE, '');
    if (t === s) break;
    const t2 = t.replace(PREFS_RE, '');
    const next = (t2.length >= 2 ? t2 : t);
    if (next.length < 2) break;
    s = next;
  }
  return s;
}
/** tier4キー: 旧字体/長音字種/カナ⇔かな/支店/グループ を吸収した表記ゆれキー（無ければ ''） */
function looseKey(name) {
  let s = normCompanyName(stripBranch(unifyDash(name)));
  if (!s) return '';
  s = s.replace(OLD_RE, (c) => OLD_TO_NEW[c] || c);
  s = kataToHira(s);
  const g = s.replace(/(グループ|ぐるーぷ)$/, '');
  if (g.length >= 2) s = g;
  if (s.length < 2) return ''; // 1文字キーは衝突源なので使わない
  return s;
}
/** tier5キー: 長音「ー」の有無も無視（「コンピュータ/コンピューター」）。別法人衝突を含むため要監査 */
function fuzzyKey(name) {
  const s = looseKey(name).replace(/ー/g, '');
  return s.length >= 2 ? s : '';
}

// レコード（または社名文字列）→ 突合キー群
function keysOf(recOrName) {
  const isStr = typeof recOrName === 'string';
  const name = isStr ? recOrName : pickName(recOrName);
  const bango = isStr ? '' : pickBango(recOrName);
  return {
    bango: normCorpNumber(bango),
    name: normCompanyName(name),
    core: companyCore(name),
    loose: looseKey(name),
    fuzzy: fuzzyKey(name),
  };
}
// 突合キーが1つも作れない（＝新規判定が不能な）行か
function hasKey(recOrName) {
  const k = keysOf(recOrName);
  return !!(k.bango || k.name);
}

/**
 * マッチインデックス。マスタ側（顧客/既納品）を add し、候補側を matchDetail/matchLabel/has で判定。
 * @param {{fuzzy?:boolean}} [opts] fuzzy=false で tier5（長音ゆれ）を無効化
 */
function createMatchIndex(opts = {}) {
  const useFuzzy = opts.fuzzy !== false;
  const byBango = new Map(); // 13桁    -> {label, name}
  const byName = new Map();  // 正規化名 -> {label, name}
  const byCore = new Map();  // 農協コア -> {label, name}
  const byLoose = new Map(); // 表記ゆれ -> {label, name}
  const byFuzzy = new Map(); // 長音ゆれ -> {label, name}
  let added = 0;

  function addName(name, label = '') {
    const raw = typeof name === 'string' ? name : pickName(name || {});
    if (!raw || !String(raw).trim()) return;
    const k = keysOf(String(raw).trim());
    const v = { label, name: String(raw).trim() };
    let touched = false;
    if (k.name && !byName.has(k.name)) { byName.set(k.name, v); touched = true; }
    if (k.core && !byCore.has(k.core)) { byCore.set(k.core, v); touched = true; }
    if (k.loose && !byLoose.has(k.loose)) { byLoose.set(k.loose, v); touched = true; }
    if (useFuzzy && k.fuzzy && !byFuzzy.has(k.fuzzy)) { byFuzzy.set(k.fuzzy, v); touched = true; }
    if (touched) added++;
  }
  function addBango(bango, label = '', name = '') {
    const b = normCorpNumber(bango);
    if (b && !byBango.has(b)) byBango.set(b, { label, name });
  }
  function addRecord(rec, label = '') { addBango(pickBango(rec), label, pickName(rec)); addName(pickName(rec), label); }

  /**
   * 一致の詳細を返す。matched=false なら未一致。
   * @returns {{matched:boolean, label:string, tier:string, key:string, master:string}}
   */
  function matchDetail(recOrName) {
    const k = keysOf(recOrName);
    const hit = (tier, key, v) => ({ matched: true, label: v.label || 'match', tier, key, master: v.name || '' });
    if (k.bango && byBango.has(k.bango)) return hit('法人番号', k.bango, byBango.get(k.bango));
    if (k.name && byName.has(k.name)) return hit('社名', k.name, byName.get(k.name));
    if (k.core && byCore.has(k.core)) return hit('農協', k.core, byCore.get(k.core));
    if (k.loose && byLoose.has(k.loose)) return hit('表記ゆれ', k.loose, byLoose.get(k.loose));
    if (useFuzzy && k.fuzzy && byFuzzy.has(k.fuzzy)) return hit('長音ゆれ', k.fuzzy, byFuzzy.get(k.fuzzy));
    return { matched: false, label: '', tier: '', key: '', master: '' };
  }
  // 一致したマスタのラベル（無ければ ''）
  const matchLabel = (recOrName) => matchDetail(recOrName).label;
  const has = (recOrName) => matchDetail(recOrName).matched;

  return {
    addName, addBango, addRecord, matchDetail, matchLabel, has,
    get size() { return added; },
    get bangoSize() { return byBango.size; },
    get nameSize() { return byName.size; },
    get coreSize() { return byCore.size; },
    get looseSize() { return byLoose.size; },
    get fuzzySize() { return byFuzzy.size; },
    get fuzzyEnabled() { return useFuzzy; },
    _byName: byName, _byCore: byCore, _byBango: byBango, _byLoose: byLoose, _byFuzzy: byFuzzy, // テスト/監査用
  };
}

/**
 * 「社名 → 任意の値」の Map を全キー系統で引けるようにする補助。
 * エンリッチ用の索引（BALES情報の引き当て等）が strict キーだけだと表記ゆれで取りこぼす。
 *   indexPut(map, '株式会社カワデン', info) / indexGet(map, '株式会社かわでん') → info
 */
function indexPut(map, name, value) {
  const k = keysOf(String(name || ''));
  for (const key of [k.name, k.core, k.loose, k.fuzzy]) if (key && !map.has(key)) map.set(key, value);
  return map;
}
function indexGet(map, name) {
  const k = keysOf(String(name || ''));
  for (const key of [k.name, k.core, k.loose, k.fuzzy]) if (key && map.has(key)) return map.get(key);
  return undefined;
}

module.exports = {
  NAME_COLS, BANGO_COLS, pickName, pickBango,
  companyCore, looseKey, fuzzyKey, stripBranch, keysOf, hasKey, createMatchIndex,
  indexPut, indexGet,
};
