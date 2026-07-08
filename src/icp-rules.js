'use strict';
/**
 * ICP ハードルール ── リスト作成条件の「単一の真実源」（2026-07 v3）
 * =====================================================================
 * 既存顧客429社＋SF全リード86,674件の実コンバージョン率分析（docs/mochica-list-logic-v3.md）から、
 * スコアで上下させる“軟らかい”嗜好ではなく、母集団から落とす/入れるを決める“硬い”ルールだけをここに集約する。
 * mochica-fit.js（1件採点）・build-lookalike-list.js（SFリード再ランク）・ハーベスト系が共用。
 *
 *   絶対除外   : IT・ソフトウェア（経路・規模を問わず成約率6%前後で最下位＝構造的不適合 / 仮説H4）
 *   規模フロア : 従業員100名以上（<100名は成約率<14%、<50名は<10%で不適）
 *   採用フロア : 年間新卒6名以上（1-2名=3.6%は不毛、3-5名=13%は中程度、6名+で26%へ急伸）
 *   提案プラン : 規模帯で提案プランを振り分け（500超=スタンダード提案、1000超=競合ATS警戒 / 仮説H6）
 *
 * env で上書き可（既定は分析結論）:
 *   ICP_EXCLUDE_IT=false で IT除外を無効化 / ICP_EMP_MIN, ICP_HIRE_MIN でフロア変更。
 */

const intEnv = (v, d) => (v !== undefined && v !== '' && Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const boolEnv = (v, d) => (v === undefined || v === '' ? d : !/^(0|false|no|off)$/i.test(v));

const ICP = {
  EXCLUDE_IT: boolEnv(process.env.ICP_EXCLUDE_IT, true), // 仮説H4: IT除外は経路非依存の絶対ルール
  EMP_MIN: intEnv(process.env.ICP_EMP_MIN, 100),         // 規模フロア（<100名は成約率<14%）
  EMP_MAX: intEnv(process.env.ICP_EMP_MAX, 2000),        // 有効上限（超は自前/競合ATS濃厚）
  EMP_SWEET_MIN: intEnv(process.env.ICP_EMP_SWEET_MIN, 300),
  EMP_SWEET_MAX: intEnv(process.env.ICP_EMP_SWEET_MAX, 500),
  HIRE_MIN: intEnv(process.env.ICP_HIRE_MIN, 6),         // 採用フロア（<6名は成約率<14%、1-2名=3.6%）
};

// --- 絶対除外業種（IT・ソフトウェア）。細分ラベル完全一致＋キーワードの両建てで漏らさない ---
// SF実測: ソフトウエア6.2% / 情報処理7.1% / インターネット関連2.0% など、温かい経路でも13%止まりで全業種最下位。
const EXCLUDE_INDUSTRY_RE =
  /(ソフトウ|ＩＴ|IT|SIer|SES|情報処理|情報サービス|システム開発|システムインテグ|受託開発|インターネット|Web制作|ウェブ|アプリ|ゲームソフト|ゲーム・|コンピュータ|コンピューター|通信機器|セキュリティ|ソフトウェア|クラウド|ＳaaS|SaaS)/i;

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
 * 規模×採用のハードフロアを通過するか（ユーザー指定: 従業員100名以上・新卒6名以上）。
 * 値が「不明(null)」の軸は落とさない（フロアは“判明していて下回る”ときだけ弾く）。
 * @param {{emp?:number|null, hire?:number|null}} v
 * @returns {{pass:boolean, reasons:string[]}}
 */
function passesIcpFloor({ emp = null, hire = null } = {}) {
  const reasons = [];
  let pass = true;
  if (emp != null && emp < ICP.EMP_MIN) { pass = false; reasons.push(`従業員${emp}名<${ICP.EMP_MIN}(規模フロア未満)`); }
  if (hire != null && hire < ICP.HIRE_MIN) { pass = false; reasons.push(`新卒${hire}名<${ICP.HIRE_MIN}(採用フロア未満)`); }
  return { pass, reasons };
}

/**
 * リスト作成の絶対条件（ユーザー指定 2026-07）。呼べる名指しリストに載せる資格を判定する。
 *   ① 採用担当者名あり  ② 電話番号あり  ③ 年間新卒6名以上  ＋ 非IT ＋ 従業員100名以上
 * 採用人数が「不明(null)」のときは pass=false・needHire=true を返す（落とすのではなく採用数エンリッチへ回す）。
 * @param {{contactName?:string, phone?:string, hire?:number|null, emp?:number|null, industry?:string}} v
 * @returns {{pass:boolean, needHire:boolean, reasons:string[]}}
 */
function qualifiesForList({ contactName = '', phone = '', hire = null, emp = null, industry = '' } = {}) {
  const reasons = [];
  let pass = true; let needHire = false;
  if (!String(contactName || '').trim()) { pass = false; reasons.push('担当者名なし'); }
  if (!String(phone || '').trim()) { pass = false; reasons.push('電話番号なし'); }
  if (isExcludedIndustry(industry)) { pass = false; reasons.push('IT/ソフト=絶対除外'); }
  if (emp != null && emp < ICP.EMP_MIN) { pass = false; reasons.push(`従業員${emp}名<${ICP.EMP_MIN}`); }
  if (hire == null) { pass = false; needHire = true; reasons.push('採用人数不明(要エンリッチ)'); }
  else if (hire < ICP.HIRE_MIN) { pass = false; reasons.push(`新卒${hire}名<${ICP.HIRE_MIN}`); }
  return { pass, needHire, reasons };
}

/**
 * 規模帯 → 提案プラン/セグメント（仮説H6の tier routing）。
 * 単価を規模で当てにいく：スイートはコア、500超はスタンダード提案、1000超は競合ATS警戒。
 * @param {number|null} emp 従業員数
 */
function proposalTier(emp) {
  if (emp == null) return { segment: '規模不明', plan: 'ミニマム基準', note: '規模の確認が必要' };
  if (emp < ICP.EMP_MIN) return { segment: '対象外(小)', plan: '—', note: `<${ICP.EMP_MIN}名=不適(成約率<14%)` };
  if (emp <= ICP.EMP_SWEET_MAX) return { segment: '主戦場(スイート)', plan: 'ミニマム/ミドル', note: `${ICP.EMP_MIN}-${ICP.EMP_SWEET_MAX}名=最重点(成約率19-24%)` };
  if (emp <= 1000) return { segment: '有効(中堅上)', plan: 'スタンダード提案', note: '500-1000名=成約率22%・単価を上げにいく' };
  if (emp <= ICP.EMP_MAX) return { segment: '有効(上限)', plan: 'スタンダード提案', note: '1000-2000名=成約率22%・競合ATS要確認' };
  return { segment: '要注意(大)', plan: '競合ATS確認', note: `${ICP.EMP_MAX}名超=自前/競合ATS濃厚(成約率<20%)` };
}

module.exports = { ICP, isExcludedIndustry, passesIcpFloor, qualifiesForList, proposalTier, EXCLUDE_INDUSTRY_RE };
