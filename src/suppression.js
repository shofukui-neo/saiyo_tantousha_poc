'use strict';
/**
 * サプレッション層（N層）── 負のシグナルで除外/降格（2026-07 v3.1）
 * =====================================================================
 * 現行のICP/類似スコアは「正のシグナルの最大化」だけで設計され、負のシグナルで落とす層が無かった。
 * 252件の架電アウト分析（約30-35%は架電前に判定可能）を受け、既存架電CRM(BALES)の負シグナルで
 * 「純損失架電」＝既存顧客/商談中/過去お断りへの重複架電（アポにならずブランドを毀損）をゼロにする。
 *
 * データ源: BALESCLOUD 既存リスト（会社名で法人JOIN）。
 *   N1 商談中/既存      : 商談作成あり×失注なし → 除外（既存営業へ連携）
 *   N2 過去お断り(冷却中): コール結果「担当者接触：お断り」× 直近 <クールダウン → 除外
 *   N3 失注(冷却中)     : 失注日あり × 直近 <クールダウン → 除外／明けは降格(慎重再架電)
 *   N-dead 電話不通      : 「番号不備」「現在使われていない」 → 除外
 *   N7 LINE制限業種      : 官公庁・自治体・公社系 → 降格（LINE利用不可の蓋然性）
 *                          ※金融(銀行/信金/保険)は実測で成約35%＝勝ち筋のため対象外（旧仮説を実データで却下）。
 *
 * 注) §3「採用ボリューム薄(採用2-3名)」の除外は、絶対条件③「採用6名以上」で既に達成済み（N4は不要＝重複）。
 *     採用予定人数の単一数値はSFバンドの下限（"6"="6-10名帯"）で、真の少人数ではないため降格には使わない。
 *
 * action = 'remove'(純損失回避で母集団から除外) / 'downgrade'(残すが降格) / 'keep'
 * 冷却窓は ICP_COOLDOWN_MONTHS で調整可（既定12ヶ月。全拒否ポリシーの24ヶ月は別途Sコード連携時に）。
 */
const { parseCsv, normCompanyName } = require('./csv');

const COOLDOWN_MONTHS = parseInt(process.env.ICP_COOLDOWN_MONTHS || '12', 10);
// LINE利用制限の蓋然性が高い業種（N7）＝公的セクターに限定。金融は実測の勝ち筋なので含めない。
const LINE_RISK_RE = /(官公庁|自治体|市役所|区役所|町役場|村役場|県庁|都庁|道庁|府庁|省庁|警察|消防|公社|独立行政|政府|地方公共団体|公共団体)/;

function parseYm(s) { const m = String(s || '').match(/(\d{4})[-/](\d{1,2})/); return m ? { y: +m[1], mo: +m[2] } : null; }
function cmpYm(a, b) { return a.y !== b.y ? a.y - b.y : a.mo - b.mo; }
function monthsAgo(ym, now) { return ym ? (now.y - ym.y) * 12 + (now.mo - ym.mo) : null; }

/**
 * BALESCLOUD CSV → 会社名キー別の負シグナル集約 Map。
 * @returns {Map<string, {お断り,失注,商談,不通,アポ,架電,直近Ym}>}
 */
function buildBalesIndex(text) {
  const rows = parseCsv(text);
  if (!rows.length) return new Map();
  const H = rows[0];
  const ci = (n) => H.findIndex((h) => String(h).trim() === n);
  const cName = ci('会社情報：会社名'), cLost = ci('カスタム情報：失注商談失注日'),
    cCall = ci('コール結果1：開始日時'), cKekka = ci('コール結果1：結果'), cShodan = ci('商談1：商談作成日時');
  const actCols = []; for (let i = 0; i < H.length; i++) if (/次のアクション\d+：完了日時/.test(String(H[i]))) actCols.push(i);
  const idx = new Map();
  for (const r of rows.slice(1)) {
    const k = normCompanyName(r[cName] || ''); if (!k) continue;
    const kekka = String(cKekka >= 0 ? r[cKekka] || '' : ''); const lost = String(cLost >= 0 ? r[cLost] || '' : '').trim();
    const shodan = String(cShodan >= 0 ? r[cShodan] || '' : '').trim();
    let s = idx.get(k); if (!s) { s = { お断り: false, 失注: false, 商談: false, 不通: false, アポ: false, 架電: 0, 直近Ym: null }; idx.set(k, s); }
    if (/お断り/.test(kekka)) s.お断り = true;
    if (/番号不備|使われていない/.test(kekka)) s.不通 = true;
    if (/アポ獲得/.test(kekka)) s.アポ = true;
    if (shodan) s.商談 = true;
    if (lost) { s.失注 = true; const ym = parseYm(lost); if (ym && (!s.直近Ym || cmpYm(ym, s.直近Ym) > 0)) s.直近Ym = ym; }
    const cym = parseYm(cCall >= 0 ? r[cCall] : ''); if (cym && (!s.直近Ym || cmpYm(cym, s.直近Ym) > 0)) s.直近Ym = cym;
    let touches = 0; for (const i of actCols) if (String(r[i] || '').trim()) touches++;
    s.架電 = Math.max(s.架電, touches + (cCall >= 0 && String(r[cCall] || '').trim() ? 1 : 0));
  }
  return idx;
}

const parseNum = (v) => { const m = String(v == null ? '' : v).match(/\d+/); return m ? parseInt(m[0], 10) : null; };
// レンジ表記("6~10名")では上限を採る。採用ボリュームの薄さは「上限が小さい」で判定する。
const parseNumMax = (v) => { const ms = String(v == null ? '' : v).match(/\d+/g); return ms ? Math.max(...ms.map(Number)) : null; };

/**
 * 1社のサプレッション判定。
 * @param {object} rec 統合リストの1行（企業名/業種/採用予定人数/募集コース数 等）
 * @param {Map} balesIdx buildBalesIndex の結果
 * @param {{now?:{y,mo}, cooldownMonths?:number}} opt
 * @returns {{action:'remove'|'downgrade'|'keep', codes:string[], reasons:string[], bales:boolean}}
 */
function suppress(rec, balesIdx, opt = {}) {
  const now = opt.now || { y: 2026, mo: 7 };
  const cooldown = opt.cooldownMonths || COOLDOWN_MONTHS;
  const codes = []; const reasons = []; let action = 'keep';
  const setDown = () => { if (action !== 'remove') action = 'downgrade'; };

  const key = normCompanyName(rec['企業名'] || rec.name || '');
  const b = key ? balesIdx.get(key) : null;
  if (b) {
    const age = monthsAgo(b.直近Ym, now);
    if (b.商談 && !b.失注) { action = 'remove'; codes.push('N1'); reasons.push('BALES商談中/既存＝重複架電回避(既存営業へ連携)'); }
    if (b.不通) { action = 'remove'; codes.push('N-dead'); reasons.push('BALES電話不通(番号不備/現在使われていない)'); }
    if (b.お断り) {
      if (age == null || age < cooldown) { action = 'remove'; codes.push('N2'); reasons.push(`BALES過去お断り(${age == null ? '時期不明' : age + 'ヶ月前'})＝クールダウン`); }
      else { setDown(); codes.push('N3'); reasons.push(`BALES過去お断り(${age}ヶ月前,冷却明け)＝慎重再架電`); }
    }
    if (b.失注 && !b.お断り) {
      if (age != null && age < cooldown) { action = 'remove'; codes.push('N3'); reasons.push(`BALES失注(${age}ヶ月前)＝クールダウン`); }
      else { setDown(); codes.push('N3'); reasons.push(`BALES失注(${age == null ? '時期不明' : age + 'ヶ月前'},冷却明け)＝慎重再架電`); }
    }
  }
  if (action !== 'remove') {
    // N7: 公的セクター（LINE利用制限の蓋然性）は降格。金融は勝ち筋なので対象外。
    if (LINE_RISK_RE.test(String(rec['業種'] || ''))) { setDown(); codes.push('N7'); reasons.push('LINE利用制限の蓋然性業種(官公庁/自治体)＝降格'); }
    // N4(採用ボリューム): 絶対条件③(採用6名以上)で大半は代替済み。職種数が確実に「単一」と判明し、
    // かつ採用上限も最少(≤6)のときだけ降格（＝真に母集団が薄い）。職種数はマイナビ採用データのエンリッチ由来。
    const courses = parseNum(rec['募集コース数']);
    const hireMax = parseNumMax(rec['採用予定人数'] || rec['採用人数']);
    if (courses != null && courses <= 1 && hireMax != null && hireMax <= 6) { setDown(); codes.push('N4'); reasons.push('職種1×採用上限≤6＝母集団が薄い(歩留まり課題が成立しにくい)'); }
  }
  return { action, codes, reasons, bales: !!b };
}

module.exports = { buildBalesIndex, suppress, LINE_RISK_RE, COOLDOWN_MONTHS };
