'use strict';
/**
 * ICP ハードルール ── リスト作成条件の「単一の真実源」（v5 / 2026-08-31 業務判断を反映）
 * =====================================================================
 * スコアで上下させる“軟らかい”嗜好ではなく、母集団から落とす/入れるを決める“硬い”ゲートだけを
 * ここに集約する。採点そのもの（期待アポ率の2段モデル）は src/icp-score-v5.js。
 * mochica-fit.js（1件採点）・build-lookalike-list.js（SFリード再ランク）・consolidate-all.js
 * ・format-bales.js（架電リスト出口）・ハーベスト系が共用する。
 *
 * ── 絶対条件（点の高低ではなくゲート）─────────────────────────
 *   ① IT・ソフトウェア除外 : 業種ラベルが当たれば total を12で頭打ち（isExcludedIndustry）
 *   ② エントリー人数50名以上: 50名未満と“分かっている”企業だけ除外。未取得は通す
 *      （2026-08-31 業務判断。架電で聞いて初めて入る値なので、落とすと母集団が全滅する）
 *   ③ 官公庁（県庁・市役所系）: リスト作成・架電・架電リストの3出口をブロック（isGovernmentOrg）
 *      外郭（公社・事業団・独法・社協・共済組合）は含まない＝むしろ公的・協同組合系として厚遇
 *   ④ DNC/架電拒否 −100 ／ 既存顧客 −70（mochica-fit.js の penalties）
 *   ⑤ リスト掲載の資格   : 担当者名＋電話＋新卒6名以上＋従業員100名以上＋非IT（qualifiesForList）
 *      採用人数不明は落とさずエンリッチ行き（needHire=true）
 *   ⑥ 採用構成が中途中心でない（2026-09-18 追加 / classifyHiringMix・passesNewgradCentric）
 *      MOCHICAは新卒ATS。中途が採用計画の主でその横に新卒枠が少しある会社は、
 *      担当者が良いと言っても新卒側の予算が小さく決裁が下りない。
 *      他のフロアと同じ扱いで「中途中心と判明しているときだけ」落とす（不明は通す）。
 *
 * ── v4 から撤回したもの（実測で全体平均を上回っていたため）───────────
 *   規模上限2000名の罰 / 1000名超 −20 / 競合ATS −45 は廃止。規模フロア100名・採用フロア6名は
 *   「判明していて下回るときだけ弾く」フロアとして維持する。
 *
 * env で上書き可（既定は分析結論）:
 *   ICP_EXCLUDE_IT=false でIT除外を無効化 / ICP_EMP_MIN, ICP_HIRE_MIN, ICP_ENTRY_MIN でフロア変更 /
 *   ICP_EXCLUDE_GOV=false で官公庁ブロックを無効化。
 */

const intEnv = (v, d) => (v !== undefined && v !== '' && Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const flt = (v, d) => (v !== undefined && v !== '' && Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
const boolEnv = (v, d) => (v === undefined || v === '' ? d : !/^(0|false|no|off)$/i.test(v));

const ICP = {
  EXCLUDE_IT: boolEnv(process.env.ICP_EXCLUDE_IT, true),   // 仮説H4: IT除外は経路非依存の絶対ルール
  EXCLUDE_GOV: boolEnv(process.env.ICP_EXCLUDE_GOV, true), // 2026-08-27: 官公庁は3出口ともブロック
  EMP_MIN: intEnv(process.env.ICP_EMP_MIN, 100),           // 規模フロア（判明していて下回るときだけ弾く）
  EMP_MAX: intEnv(process.env.ICP_EMP_MAX, 2000),          // 提案プラン振り分けの目安（罰ではない / v5で罰は撤回）
  EMP_SWEET_MIN: intEnv(process.env.ICP_EMP_SWEET_MIN, 300),
  EMP_SWEET_MAX: intEnv(process.env.ICP_EMP_SWEET_MAX, 500),
  HIRE_MIN: intEnv(process.env.ICP_HIRE_MIN, 6),           // 採用フロア（<6名は成約率<14%、1-2名=3.6%）
  ENTRY_MIN: intEnv(process.env.ICP_ENTRY_MIN, 50),        // エントリー人数フロア（2026-08-31 業務判断）
  // 採用構成ゲート（2026-09-18）。中途の募集規模が新卒の何倍を超えたら「中途中心」と見なすか。
  // 単位が違う（中途＝公開中の求人件数／新卒＝募集人数）ので、等倍ではなく余裕を持たせる。
  REQUIRE_NEWGRAD_CENTRIC: boolEnv(process.env.ICP_REQUIRE_NEWGRAD_CENTRIC, true),
  MIDCAREER_RATIO_MAX: flt(process.env.ICP_MIDCAREER_RATIO_MAX, 2),
  MIDCAREER_MIN_COUNT: intEnv(process.env.ICP_MIDCAREER_MIN_COUNT, 5), // 件数が少ないうちは中途中心と言わない
};

// --- 絶対除外業種（IT・ソフトウェア）。細分ラベル完全一致＋キーワードの両建てで漏らさない ---
// SF実測: ソフトウエア6.2% / 情報処理7.1% / インターネット関連2.0% など、温かい経路でも13%止まりで全業種最下位。
const EXCLUDE_INDUSTRY_RE =
  /(ソフトウ|ＩＴ|IT|SIer|SES|情報処理|情報サービス|システム開発|システムインテグ|受託開発|インターネット|Web制作|ウェブ|アプリ|ゲームソフト|ゲーム・|コンピュータ|コンピューター|通信機器|セキュリティ|ソフトウェア|クラウド|ＳaaS|SaaS)/i;

// --- 第1段（受付を通るか）で負リフトの業種群: IT・建設・機械・不動産・情報処理 ---
// 実測で接触率が全体を下回る群だけを ×0.83 に落とし、それ以外は一律 ×1.06（正リフトは中立化）。
// ※SFの“勝ち業種”は温かいリードの代理変数でしかなく、コールド架電の並べ替えには効かない。
const NEGATIVE_LIFT_INDUSTRY_RE =
  /(ソフトウ|ＩＴ|IT|SIer|SES|情報処理|情報サービス|システム|受託開発|インターネット|Web|ウェブ|建設|建築|土木|工務店|設備工事|プラント|ゼネコン|機械|機器|産業機械|工作機械|不動産|住宅|マンション|ハウス)/i;

/**
 * IT・ソフトウェア業種か（絶対除外の判定）。ICP_EXCLUDE_IT=false なら常に false。
 * @param {string} raw 業種ラベル（細分/マクロどちらでも）
 */
function isExcludedIndustry(raw) {
  if (!ICP.EXCLUDE_IT) return false;
  const s = String(raw || '').trim();
  if (!s) return false;
  return EXCLUDE_INDUSTRY_RE.test(s);
}

/**
 * 第1段で負リフトの業種群か（IT・建設・機械・不動産・情報処理）。業種空欄は false（中立側）。
 * @param {string} raw 業種ラベル
 */
function isNegativeLiftIndustry(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  return NEGATIVE_LIFT_INDUSTRY_RE.test(s);
}

// =====================================================================
// 官公庁（県庁・市役所系）ブロック ── 2026-08-27 追加
// =====================================================================
// リスト作成・架電・架電リストの3出口をブロックする。外郭団体（公社・事業団・独立行政法人・
// 社会福祉協議会・共済組合）は“官公庁”に含まない＝除外せず、組織型では公的・協同組合系として扱う。
const GOV_OUTER_RE = /(公社|事業団|独立行政法人|地方独立行政法人|社会福祉協議会|社協|共済組合)/;
const CORP_FORM_RE = /(株式会社|㈱|\(株\)|（株）|有限会社|合同会社|合資会社|合名会社|Inc\.|Co\.,|Ltd)/i;
const GOV_RE = /(都庁|道庁|府庁|県庁|市役所|区役所|町役場|村役場|市庁舎|人事委員会|教育委員会|選挙管理委員会|議会事務局|警察本部|県警本部|消防本部|消防局|水道局|下水道局|上下水道局|企業局|交通局|港湾局|内閣府|地方公共団体|地方自治体)/;
// 中央省庁（「〜省」「〜庁」で終わる組織名）。民間の「〜商事」等と衝突しないよう末尾一致に限定。
const MINISTRY_RE = /^[^\s]{1,8}(省|庁)$/;
// 「青森県」「横浜市」のように自治体名そのものが社名欄に入っているケース
const MUNICIPALITY_RE = /^(?:[一-龥ぁ-んァ-ヶA-Za-z]{2,6})(?:都|道|府|県|市|区|町|村)$/;

/**
 * 官公庁（県庁・市役所系）か。ICP_EXCLUDE_GOV=false なら常に false。
 * 外郭（公社・事業団・独法・社協・共済組合）と、法人格を持つ民間企業は含まない。
 * @param {string} name 企業名/組織名
 * @param {string} [industry] 業種ラベル（あれば補助的に見る）
 */
function isGovernmentOrg(name, industry = '') {
  if (!ICP.EXCLUDE_GOV) return false;
  const s = String(name || '').trim().replace(/\s+/g, '');
  if (!s) return false;
  if (GOV_OUTER_RE.test(s)) return false;   // 外郭はブロックしない
  if (CORP_FORM_RE.test(s)) return false;   // 法人格つきは民間
  if (GOV_RE.test(s)) return true;
  if (MINISTRY_RE.test(s)) return true;
  if (MUNICIPALITY_RE.test(s)) return true;
  const ind = String(industry || '');
  if (/(官公庁|地方公務員|国家公務員|公務員|公務)/.test(ind)) return true;
  return false;
}

// =====================================================================
// 組織型（v5で最大の効き）── 公的・協同組合系 vs 民間
// =====================================================================
// 実測: 公的・協同組合系は接触率2.1倍・アポ率4.4倍。業種ラベルは欠損84%のため“社名”から判定する。
const ORG_PUBLIC_PATTERNS = [
  [/(^JA|^ＪＡ|農業協同組合|農協|漁業協同組合|漁協|森林組合|厚生連|経済連|全農|中央会)/, 'JA・厚生連'],
  [/(生活協同組合|生協|事業協同組合|協同組合|協業組合|共済)/, '協同組合・共済'],
  [/(信用金庫|信金|信用組合|信組|労働金庫|労金)/, '協同組織金融'],
  [/(社会福祉法人|医療法人|学校法人|公益財団法人|公益社団法人|一般財団法人|一般社団法人|宗教法人|特定非営利活動法人|NPO法人)/, '非営利法人'],
  [/(公社|事業団|独立行政法人|地方独立行政法人|社会福祉協議会|社協|共済組合|国立大学法人|公立大学法人|公団|振興機構|開発機構)/, '公共・外郭'],
];

/**
 * 組織型を社名から判定する（v5の第1段・第2段の両方に入る唯一の共通係数）。
 * @param {string} name 企業名/組織名
 * @returns {{type:'public'|'private', label:string, reason:string}}
 */
function classifyOrgType(name) {
  const s = String(name || '').trim().replace(/\s+/g, '');
  for (const [re, label] of ORG_PUBLIC_PATTERNS) {
    if (re.test(s)) return { type: 'public', label, reason: `組織型[${label}]=公的・協同組合系` };
  }
  return { type: 'private', label: '民間', reason: '組織型[民間]' };
}

/**
 * エントリー人数フロア（2026-08-31 業務判断）。
 * 「50名未満と分かっている」ときだけ落とす。未取得(null)は通す ── 架電で聞いて初めて入る値のため。
 * @param {number|null} entry
 * @returns {{pass:boolean, reason:string}}
 */
function passesEntryFloor(entry) {
  if (entry == null) return { pass: true, reason: 'エントリー人数不明(通す)' };
  if (entry < ICP.ENTRY_MIN) return { pass: false, reason: `エントリー${entry}名<${ICP.ENTRY_MIN}(判明済で下回る)` };
  return { pass: true, reason: `エントリー${entry}名≥${ICP.ENTRY_MIN}` };
}

/**
 * 規模×採用のハードフロア（従業員100名以上・新卒6名以上）。
 * 値が「不明(null)」の軸は落とさない（フロアは“判明していて下回る”ときだけ弾く）。
 * @param {{emp?:number|null, hire?:number|null, entry?:number|null}} v
 * @returns {{pass:boolean, reasons:string[]}}
 */
function passesIcpFloor({ emp = null, hire = null, entry = null, mix = null } = {}) {
  const reasons = [];
  let pass = true;
  if (emp != null && emp < ICP.EMP_MIN) { pass = false; reasons.push(`従業員${emp}名<${ICP.EMP_MIN}(規模フロア未満)`); }
  if (hire != null && hire < ICP.HIRE_MIN) { pass = false; reasons.push(`新卒${hire}名<${ICP.HIRE_MIN}(採用フロア未満)`); }
  const e = passesEntryFloor(entry);
  if (!e.pass) { pass = false; reasons.push(e.reason); }
  // 採用構成。mix を渡さない呼び出し（従来のCSVだけの経路）は素通りする＝挙動を変えない。
  if (mix) {
    const m = passesNewgradCentric(mix);
    if (!m.pass) { pass = false; reasons.push(m.reason); }
  }
  return { pass, reasons };
}

// =====================================================================
// 採用構成（新卒中心か、中途中心か）── 2026-09-18 追加
// =====================================================================
// MOCHICAは新卒ATS。「新卒採用をやっていて、なおかつ中途の方が小さい」会社が主戦場で、
// 中途が主で新卒枠が横にちょっとある会社は、担当者の感触が良くても新卒側の予算が動かない。
//
// 単位が揃わないことを正面から扱う:
//   新卒 = 募集“人数”（掲載面の募集人数 / 年間新卒採用人数 / 直近の入社実数）
//   中途 = 公開中の求人“件数”（求人ボックスの社名一致カード）
// 1件の中途求人が何人採るかは分からないので、等倍では比べない。
//   - 中途件数 ≤ 新卒人数                     → 新卒中心
//   - 中途件数 ≥ 新卒人数 × MIDCAREER_RATIO_MAX かつ MIDCAREER_MIN_COUNT 件以上 → 中途中心
//   - その間                                   → 併用
// 中途が「取得できて0件」と「取得できていない」は必ず区別する（後者は不明）。
const MIX = { NEWGRAD: '新卒中心', BOTH: '併用', MIDCAREER: '中途中心', NONE: '新卒なし', UNKNOWN: '不明' };

/**
 * 採用構成を判定する（新卒中心の唯一の真実源）。
 * @param {{newgrad?:number|null, midcareer?:number|null, midcareerFetched?:boolean, 確度?:string}} v
 *   newgrad          新卒の募集人数（不明は null）
 *   midcareer        中途の公開求人件数（不明は null）
 *   midcareerFetched 中途側を実際に取得できたか（0件の意味を決めるため）
 * @returns {{構成:string, 新卒:number|null, 中途:number|null, 比:number|null, 確度:string, 理由:string}}
 */
function classifyHiringMix({ newgrad = null, midcareer = null, midcareerFetched = false, 確度 = '' } = {}) {
  const ng = Number.isFinite(newgrad) ? newgrad : null;
  const mc = Number.isFinite(midcareer) ? midcareer : null;
  const mk = (構成, 理由, conf) => ({
    構成, 新卒: ng, 中途: mc, 確度: conf,
    比: ng != null && mc != null && ng > 0 ? Math.round((mc / ng) * 100) / 100 : null,
    理由,
  });
  if (ng != null && ng <= 0) return mk(MIX.NONE, '新卒の募集が0名', '中');
  if (ng == null) return mk(MIX.UNKNOWN, '新卒の募集人数が不明', '—');
  if (mc == null) {
    // 取得していない＝不明。取得したのにカードが無かった場合だけ「中途0件」として扱う。
    if (!midcareerFetched) return mk(MIX.UNKNOWN, '中途の募集規模が未取得', '—');
    return mk(MIX.NEWGRAD, `新卒${ng}名／中途の公開求人は0件`, 確度 || '中');
  }
  if (mc <= ng) return mk(MIX.NEWGRAD, `新卒${ng}名 ≥ 中途${mc}件`, 確度 || '中');
  if (mc >= ng * ICP.MIDCAREER_RATIO_MAX && mc >= ICP.MIDCAREER_MIN_COUNT) {
    return mk(MIX.MIDCAREER, `中途${mc}件 ≥ 新卒${ng}名×${ICP.MIDCAREER_RATIO_MAX}`, 確度 || '中');
  }
  return mk(MIX.BOTH, `新卒${ng}名／中途${mc}件（どちらかに寄っていない）`, 確度 || '中');
}

/**
 * 採用構成のゲート。他のフロアと同じく「判明していて外れるときだけ」落とす。
 * 新卒なしも落とす（新卒ATSを売る相手ではない）。不明・併用・新卒中心は通す。
 * @param {{構成?:string}} mix classifyHiringMix() の戻り
 */
function passesNewgradCentric(mix) {
  if (!ICP.REQUIRE_NEWGRAD_CENTRIC) return { pass: true, reason: '採用構成ゲート無効' };
  const c = mix && mix.構成;
  if (c === MIX.MIDCAREER) return { pass: false, reason: `採用構成=中途中心(${mix.理由})` };
  if (c === MIX.NONE) return { pass: false, reason: '新卒採用なし' };
  return { pass: true, reason: c ? `採用構成=${c}` : '採用構成=不明(通す)' };
}

/**
 * ICP判定の入力を、入力CSVと掲載面（intent の ev）の両方から解決する。
 *
 * これを足した理由: 従来 ICP は入力CSVの列だけを見ていて、従業員数・新卒採用人数が
 * 空の行は「不明」として全部通していた。層2で掲載面（マイナビ会社概要）を読むように
 * なった今は、同じ事実が取れている ── 募集人数・直近の入社実数・従業員数は掲載面にある。
 * 埋めたぶんフロアが実際に効くようになり、「不明だから通す」で膨らんでいた母集団が締まる。
 * どこから来た値かを 出所 に必ず残す（CSVの値と掲載面の値を後で見分けられるように）。
 *
 * @param {object} rec 入力CSVの1行
 * @param {object} ev  intent/collect.js のエビデンス（無くてよい）
 */
function resolveIcpInputs(rec = {}, ev = {}) {
  const num = (value) => {
    const s = String(value ?? '').normalize('NFKC').trim().replace(/,/g, '');
    if (!/^\d+\s*(?:名|人)?$/.test(s)) return null;
    const n = parseInt(s, 10);
    return Number.isSafeInteger(n) ? n : null;
  };
  const 出所 = {};
  const pick = (key, candidates) => {
    for (const [src, v] of candidates) {
      const n = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : num(v);
      if (n != null) { 出所[key] = src; return n; }
    }
    return null;
  };
  // 掲載面の卒年面のうち、いちばん新しい卒年の募集人数（下限）
  const faces = Object.entries((ev && ev.卒年面) || {})
    .map(([gy, f]) => ({ gy: parseInt(gy, 10), f }))
    .filter((x) => Number.isFinite(x.gy) && x.f && x.f.募集人数 && Number.isFinite(x.f.募集人数.下限))
    .sort((a, b) => b.gy - a.gy);
  const 面の募集 = faces.length ? faces[0].f.募集人数.下限 : null;
  // 定着率の開示欄にある直近の採用者数（＝実際に入社した人数）
  const 直近実績 = ev && ev.定着 && ev.定着.系列 && ev.定着.系列[0] ? ev.定着.系列[0].採用者 : null;

  const emp = pick('emp', [
    ['CSV', rec.従業員数], ['CSV', rec['従業員数']],
    ['掲載面', ev && ev.会社データ ? ev.会社データ.従業員数 : null],
  ]);
  const hire = pick('hire', [
    ['CSV', rec.年間新卒採用人数], ['CSV', rec['年間新卒採用人数']],
    ['掲載面(募集人数)', 面の募集],
    ['掲載面(入社実績)', 直近実績],
    ['CSV(予定)', rec['採用予定人数']],
  ]);
  const entry = pick('entry', [['CSV', rec['エントリー人数']], ['CSV', rec['応募者数']]]);
  const mc = ev && ev.中途求人 ? ev.中途求人 : null;
  const mix = classifyHiringMix({
    newgrad: hire,
    midcareer: mc && Number.isFinite(mc.件数) ? mc.件数 : null,
    midcareerFetched: !!(mc && mc.取得),
    確度: mc ? mc.確度 : '',
  });
  return { emp, hire, entry, mix, 出所, industry: String(rec.業種 || (ev && ev.業種) || '').trim() };
}

/**
 * リスト作成の絶対条件。呼べる名指しリストに載せる資格を判定する。
 *   ① 採用担当者名あり ② 電話番号あり ③ 年間新卒6名以上 ＋ 非IT ＋ 従業員100名以上
 *   ＋ 官公庁でない ＋ エントリー人数が判明していて50名未満でない
 * 採用人数が「不明(null)」のときは pass=false・needHire=true（落とすのではなく採用数エンリッチへ回す）。
 * エントリー人数は未取得なら通す（架電で聞いて初めて入る値）。
 * @param {{company?:string, contactName?:string, phone?:string, hire?:number|null, emp?:number|null, entry?:number|null, industry?:string}} v
 * @returns {{pass:boolean, needHire:boolean, blocked:boolean, reasons:string[]}}
 */
function qualifiesForList({ company = '', contactName = '', phone = '', hire = null, emp = null, entry = null, industry = '', mix = null } = {}) {
  const reasons = [];
  let pass = true; let needHire = false; let blocked = false;
  // 採用構成は「中途中心と判明」した時だけ落とす絶対条件（⑥）。mix 未指定の呼び出しは素通り。
  if (mix) {
    const m = passesNewgradCentric(mix);
    if (!m.pass) { pass = false; blocked = true; reasons.push(m.reason + '=絶対除外'); }
  }
  if (isGovernmentOrg(company, industry)) { pass = false; blocked = true; reasons.push('官公庁(県庁・市役所系)=絶対除外'); }
  if (!String(contactName || '').trim()) { pass = false; reasons.push('担当者名なし'); }
  if (!String(phone || '').trim()) { pass = false; reasons.push('電話番号なし'); }
  if (isExcludedIndustry(industry)) { pass = false; blocked = true; reasons.push('IT/ソフト=絶対除外'); }
  if (emp != null && emp < ICP.EMP_MIN) { pass = false; reasons.push(`従業員${emp}名<${ICP.EMP_MIN}`); }
  const e = passesEntryFloor(entry);
  if (!e.pass) { pass = false; blocked = true; reasons.push(e.reason); }
  if (hire == null) { pass = false; needHire = true; reasons.push('採用人数不明(要エンリッチ)'); }
  else if (hire < ICP.HIRE_MIN) { pass = false; reasons.push(`新卒${hire}名<${ICP.HIRE_MIN}`); }
  return { pass, needHire, blocked, reasons };
}

/**
 * 規模帯 → 提案プラン/セグメント（単価を規模で当てにいく tier routing）。
 * ※v5で「2000名超＝要注意」の“罰”は撤回済み。ここは提案プランの振り分けラベルであって減点ではない。
 * @param {number|null} emp 従業員数
 */
function proposalTier(emp) {
  if (emp == null) return { segment: '規模不明', plan: 'ミニマム基準', note: '規模の確認が必要' };
  if (emp < ICP.EMP_MIN) return { segment: '対象外(小)', plan: '—', note: `<${ICP.EMP_MIN}名=規模フロア未満` };
  if (emp <= ICP.EMP_SWEET_MAX) return { segment: '主戦場(スイート)', plan: 'ミニマム/ミドル', note: `${ICP.EMP_MIN}-${ICP.EMP_SWEET_MAX}名` };
  if (emp <= 1000) return { segment: '有効(中堅上)', plan: 'スタンダード提案', note: '500-1000名=接触率が最も高い帯(×1.18)' };
  if (emp <= ICP.EMP_MAX) return { segment: '有効(上限)', plan: 'スタンダード提案', note: '1000-2000名=接触率も高い(×1.12)' };
  return { segment: '有効(大)', plan: 'スタンダード提案', note: `${ICP.EMP_MAX}名超=罰は撤回済み(実測で全体を上回る)` };
}

module.exports = {
  ICP, isExcludedIndustry, isNegativeLiftIndustry, isGovernmentOrg, classifyOrgType,
  passesEntryFloor, passesIcpFloor, qualifiesForList, proposalTier,
  classifyHiringMix, passesNewgradCentric, resolveIcpInputs, MIX,
  EXCLUDE_INDUSTRY_RE, NEGATIVE_LIFT_INDUSTRY_RE,
};
