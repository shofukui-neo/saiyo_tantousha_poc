'use strict';
/**
 * MOCHICA アポ取得期待値モデル（mochica-fit）
 * =====================================================================
 * 「完成リストが今のリストよりアポを取りやすい」ことを論理で言い切るための採点エンジン。
 * 汎用ICPスコア（quality.js）と決別し、MOCHICA＝LINE×新卒採用管理 の“刺さる相手”だけを
 * 上位に押し上げる。各サブスコアは「なぜアポが取れるのか」の因果で設計し、根拠を文字列で残す。
 *
 * ── 確定ターゲット（ユーザー指定 2026-06）───────────────────────────
 *   企業像 : 新卒を増やしたい中小（従業員 50〜150名）= 王道スイート
 *   タイミング: 28卒の媒体選定・採用設計期 を最優先（＝いま動く相手）
 *   到達性  : テレアポで“担当者名指し”で繋ぐため、電話＋採用担当者名を重視
 *
 * ── アポ取得期待値 = Σ(dim × weight) − ペナルティ ──────────────────
 *   A 新卒インテント  0.34  実在性で階級化（マイナビ実取得＞新卒フラグ＞採用中＞代理）
 *   B 規模フィット    0.26  50-150名=100。大企業/零細は強めに減点（自前ATS・低母数）
 *   C 到達性          0.20  電話妥当＋採用担当者名＋部署（テレアポが成立する条件）
 *   D タイミング      0.14  28卒設計期係数＋レコード単位トリガー（更新/出稿増/辞退）
 *   E 継続・信用      0.06  設立年（新卒を継続採用できる体力）＋補助金
 *
 * さらに「確信度(confidence)」を併走させる：スコアが“実データ”由来か“代理推定”由来かを
 * 0-100で可視化し、上位リストの何割が検証済みシグナルで裏打ちされているかを言い切れるようにする。
 *
 * 純ロジック・ネットワーク/APIキー不要。担当者マスタ1レコード(オブジェクト)を入力に取る。
 */
const { truthy, normCompanyName } = require('./csv');
const { normalizeJpPhone } = require('./phone');

// ── 既定の重み（合計1.0）。MOCHICA_W_* env で上書き可 ─────────────
const flt = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);
const DEFAULT_WEIGHTS = {
  intent: flt(process.env.MOCHICA_W_INTENT, 0.34),
  size:   flt(process.env.MOCHICA_W_SIZE, 0.26),
  reach:  flt(process.env.MOCHICA_W_REACH, 0.20),
  timing: flt(process.env.MOCHICA_W_TIMING, 0.14),
  trust:  flt(process.env.MOCHICA_W_TRUST, 0.06),
};

// 従業員数を整数へ（"150名 [ICP60]" / "150" / 150 → 150、不明は null）
function parseEmployees(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d[\d,]*/);
  if (!m) return null;
  const n = parseInt(m[0].replace(/,/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}
function parseIntLoose(v) { return parseEmployees(v); }

// =====================================================================
// A. 新卒採用インテント（最重要・実在性で階級化）
// =====================================================================
// MOCHICAは「新卒採用を“いま”やっている／増やしたい」相手にしか刺さらない。
// よって最大の差は『本当に新卒採用しているか』の検証強度。マイナビ実取得 ＞ 新卒フラグ ＞
// 求人検索ヒット(採用中) ＞ 採用ページのみ(代理) の順で確信度も段階化する。
function scoreIntent(rec) {
  const reasons = [];
  let base = 10;       // 何のシグナルも無い
  let confidence = 20; // この次元の確信度（代理は低い）

  const mynaviHit = truthy(rec['マイナビ掲載']) || truthy(rec['新卒掲載確認']) ||
    /マイナビ|リクナビ/.test(String(rec['掲載媒体'] || '')) || /マイナビ|リクナビ/.test(String(rec['発見媒体'] || ''));
  const flag = truthy(rec['新卒フラグ']) || truthy(rec['新卒出稿']) || truthy(rec['現在求人掲載中']);
  const hiring = truthy(rec['採用中']) || (parseIntLoose(rec['求人件数']) || 0) > 0;
  const recruitPage = truthy(rec['採用ページ有無']) || /recruit|saiyo|career|採用|entry/i.test(String(rec['採用ページURL'] || rec['根拠URL'] || ''));

  if (mynaviHit && flag) { base = 100; confidence = 100; reasons.push('新卒媒体掲載を実取得'); }
  else if (mynaviHit) { base = 95; confidence = 95; reasons.push('マイナビ/リクナビ掲載確認'); }
  else if (flag) { base = 88; confidence = 80; reasons.push('新卒フラグ確定'); }
  else if (hiring) { base = 72; confidence = 65; reasons.push('求人検索で採用中ヒット'); }
  else if (recruitPage) { base = 40; confidence = 35; reasons.push('採用ページのみ(代理推定)'); }
  else { base = 10; confidence = 20; reasons.push('新卒シグナル無し'); }

  // ── 痛みの濃さ：母集団形成に投資しているほどMOCHICAの管理価値が立つ ──
  let bonus = 0;
  const mediaN = parseIntLoose(rec['掲載媒体数']) || parseIntLoose(rec['出稿媒体数']) || 0;
  if (mediaN >= 2) { bonus += 8; reasons.push(`複数媒体出稿(${mediaN})=母集団形成に投資`); }
  const jobsN = parseIntLoose(rec['募集職種数']) ||
    (String(rec['採用職種'] || rec['職種'] || '').split(/[\/、,・]/).filter(Boolean).length || 0);
  if (jobsN >= 3) { bonus += 5; reasons.push(`募集職種${jobsN}=選考管理が複雑`); }
  // 28卒/27卒 の明示は“いま動いている”裏取り
  const yrMention = String(rec['新卒言及'] || rec['採用職種'] || rec['職種'] || rec['掲載媒体'] || '');
  if (/28卒|2028/.test(yrMention)) { bonus += 6; reasons.push('28卒募集を明示'); }
  else if (/27卒|2027/.test(yrMention)) { bonus += 3; reasons.push('27卒募集を明示'); }

  const score = Math.max(0, Math.min(100, base + bonus));
  return { score, confidence, reasons };
}

// =====================================================================
// B. 規模フィット（50-150名=スイート。大企業/零細を強めに減点）
// =====================================================================
// 50-150名は「新卒を毎年数名〜十数名採るが専任の採用管理基盤が無い」MOCHICAの王道。
// 500名超は自前ATS/競合導入済みが増え商談も長期化、20名未満は新卒母数・予算が薄い。
function scoreSize(rec) {
  const emp = parseEmployees(rec['従業員数']);
  if (emp == null) return { score: 50, confidence: 30, reasons: ['規模不明(中立)'], emp: null };
  let score, reason;
  if (emp >= 50 && emp <= 150) { score = 100; reason = `規模${emp}=スイート(50-150)`; }
  else if (emp >= 30 && emp < 50) { score = 72; reason = `規模${emp}=やや小(30-50)`; }
  else if (emp > 150 && emp <= 250) { score = 76; reason = `規模${emp}=スイート上限超(150-250)`; }
  else if (emp >= 20 && emp < 30) { score = 46; reason = `規模${emp}=零細寄り`; }
  else if (emp > 250 && emp <= 500) { score = 40; reason = `規模${emp}=中堅(自前管理化が進む)`; }
  else if (emp > 500 && emp <= 1000) { score = 20; reason = `規模${emp}=大手寄り(競合ATS懸念)`; }
  else if (emp > 1000) { score = 8; reason = `規模${emp}=大企業(自前/競合ATS濃厚)`; }
  else { score = 25; reason = `規模${emp}=零細(新卒母数薄い)`; }
  return { score, confidence: 90, reasons: [reason], emp };
}

// =====================================================================
// C. 到達性（テレアポが“担当者名指し”で成立する条件）
// =====================================================================
function scoreReach(rec) {
  const reasons = [];
  let pts = 0, confidence = 40;
  const phoneRaw = String(rec['電話番号'] || '').trim();
  if (phoneRaw && normalizeJpPhone(phoneRaw)) { pts += 60; confidence += 30; reasons.push('電話妥当'); }
  else if (phoneRaw) { pts += 30; reasons.push('電話要確認'); }
  else { reasons.push('電話無し=架電不可'); }

  if (String(rec['採用担当者名'] || '').trim()) { pts += 30; confidence += 30; reasons.push('採用担当者名あり=名指し架電可'); }
  else if (String(rec['代表者名'] || '').trim()) { pts += 8; reasons.push('代表者名のみ'); }

  if (String(rec['部署'] || '').trim() || String(rec['役職'] || '').trim()) { pts += 10; reasons.push('部署/役職あり'); }

  return { score: Math.max(0, Math.min(100, pts)), confidence: Math.min(100, confidence), reasons };
}

// =====================================================================
// D. タイミング（28卒の媒体選定・採用設計期を最優先）
// =====================================================================
// 設計期＝「来期どう採るか」を決める＝採用管理ツールを比較検討するテーブルに乗りやすい瞬間。
// 6-8月は28卒サマーインターン準備＋媒体選定が走る山。9-12月は計画ピーク。
// レコード単位のトリガー（採用ページ更新/出稿増/辞退）で“今この瞬間”をさらに引き上げる。
const SEASON_28 = {
  1: 70, 2: 68, 3: 60,            // 27卒直前期（28卒設計はまだ薄い）
  4: 78, 5: 84, 6: 92, 7: 95, 8: 92, // 28卒サマーインターン準備＋媒体選定の山（いま）
  9: 100, 10: 100, 11: 96, 12: 90,   // 28卒本計画・媒体確定ピーク
};
function scoreTiming(rec, now) {
  const m = (now ? now : new Date()).getMonth() + 1;
  let score = SEASON_28[m] != null ? SEASON_28[m] : 75;
  const reasons = [`${m}月=28卒設計期係数${score}`];
  let confidence = 60;
  if (truthy(rec['辞退シグナル'])) { score = Math.max(score, 96); confidence = 85; reasons.push('辞退発生直後=最刺さり'); }
  if (truthy(rec['出稿増']) || truthy(rec['採用ページ更新'])) { score = Math.min(100, score + 6); confidence = Math.max(confidence, 75); reasons.push('直近の採用アクション検知'); }
  if (truthy(rec['来期検討'])) { score = Math.max(score, 92); reasons.push('来期採用設計を明示'); }
  if (truthy(rec['プレスリリース'])) { score = Math.min(100, score + 3); reasons.push('プレス=動きあり'); }
  return { score: Math.max(0, Math.min(100, score)), confidence, reasons };
}

// =====================================================================
// E. 継続・信用（新卒を毎年採れる体力）
// =====================================================================
function scoreTrust(rec) {
  const reasons = [];
  let score = 50;
  const yr = parseEmployees(rec['設立年']);
  if (yr) {
    const age = (new Date()).getFullYear() - yr;
    if (age >= 10) { score += 30; reasons.push(`設立${age}年=継続採用の体力`); }
    else if (age >= 5) { score += 15; reasons.push(`設立${age}年`); }
    else { score += 5; reasons.push(`設立${age}年=若い`); }
  }
  if (truthy(rec['補助金'])) { score += 15; reasons.push('補助金採択=投資余力'); }
  return { score: Math.min(100, score), confidence: yr ? 70 : 40, reasons };
}

// =====================================================================
// ペナルティ（アポにならない／取ってはいけない相手を沈める）
// =====================================================================
function penalties(rec, sizeEmp) {
  let penalty = 0; const reasons = [];
  if (truthy(rec['除外フラグ']) || truthy(rec['DNC']) || truthy(rec['架電拒否'])) { penalty += 100; reasons.push('除外/DNC'); }
  if (truthy(rec['既存顧客'])) { penalty += 70; reasons.push('既存顧客'); }
  if (truthy(rec['競合ATS導入'])) { penalty += 45; reasons.push('競合ATS導入済み'); }
  // 大企業は自前/競合ATS濃厚 → サイズ減点に加え、商談長期化ぶんを上乗せで沈める
  if (sizeEmp != null && sizeEmp > 1000) { penalty += 20; reasons.push('大企業=自前ATS/長期商談'); }
  return { penalty, reasons };
}

// 優先度バンド
function priorityOf(total) {
  const hi = parseInt(process.env.MOCHICA_PRIORITY_HIGH || '70', 10);
  const mid = parseInt(process.env.MOCHICA_PRIORITY_MID || '50', 10);
  if (total >= hi) return '今週架電';
  if (total >= mid) return 'ナーチャリング';
  return '後回し';
}

function getWeights() {
  const w = DEFAULT_WEIGHTS;
  const sum = w.intent + w.size + w.reach + w.timing + w.trust;
  // 正規化（env上書きで合計が1.0からずれても安全に）
  return { intent: w.intent / sum, size: w.size / sum, reach: w.reach / sum, timing: w.timing / sum, trust: w.trust / sum };
}

/**
 * 1レコードのMOCHICAアポ取得期待値を採点。
 * @returns {{total, dims, priority, confidence, why, reasons, flags}}
 */
function scoreMochica(rec, opt = {}) {
  const now = opt.now || new Date();
  const w = getWeights();

  const A = scoreIntent(rec);
  const B = scoreSize(rec);
  const C = scoreReach(rec);
  const D = scoreTiming(rec, now);
  const E = scoreTrust(rec);
  const P = penalties(rec, B.emp);

  const raw = A.score * w.intent + B.score * w.size + C.score * w.reach + D.score * w.timing + E.score * w.trust;
  const total = Math.max(0, Math.min(100, Math.round(raw - P.penalty)));

  // 確信度＝各次元の確信度を「スコアへの寄与（重み×スコア）」で加重平均。
  // “上位の何割が検証済みシグナルで裏打ちされているか”を言い切るための指標。
  const contrib = [
    { c: A.confidence, x: A.score * w.intent },
    { c: B.confidence, x: B.score * w.size },
    { c: C.confidence, x: C.score * w.reach },
    { c: D.confidence, x: D.score * w.timing },
    { c: E.confidence, x: E.score * w.trust },
  ];
  const cw = contrib.reduce((s, p) => s + p.x, 0) || 1;
  const confidence = Math.round(contrib.reduce((s, p) => s + p.c * p.x, 0) / cw);

  const dims = { intent: A.score, size: B.score, reach: C.score, timing: D.score, trust: E.score };
  const priority = priorityOf(total);

  // ── 「なぜ今・なぜこの企業」一行サマリ（営業がそのまま読める） ──
  const whyParts = [];
  whyParts.push(A.reasons[0]);                 // 新卒の根拠
  whyParts.push(B.reasons[0]);                 // 規模の適合
  if (C.score >= 60) whyParts.push(C.reasons.find(r => /担当者名|電話妥当/.test(r)) || C.reasons[0]);
  whyParts.push(D.reasons.find(r => /辞退|来期|アクション|設計期/.test(r)) || D.reasons[0]);
  const why = whyParts.filter(Boolean).join('｜');

  const reasons = []
    .concat(A.reasons.map(r => 'INT:' + r))
    .concat(B.reasons.map(r => 'SIZE:' + r))
    .concat(C.reasons.map(r => 'REACH:' + r))
    .concat(D.reasons.map(r => 'TIM:' + r))
    .concat(E.reasons.map(r => 'TRUST:' + r))
    .concat(P.reasons.map(r => 'NEG:' + r));

  // 検証フラグ（上位リストの裏取り集計に使う）
  const flags = {
    verifiedIntent: A.confidence >= 80,           // 新卒採用が実データで裏取りできている
    sizeFit: dims.size >= 90,                      // スイート規模
    callable: /電話妥当/.test(C.reasons.join('')), // 架電できる
    named: /担当者名あり/.test(C.reasons.join('')), // 担当者名指しできる
  };

  return { total, dims, priority, confidence, why, reasons, flags };
}

module.exports = {
  scoreMochica, scoreIntent, scoreSize, scoreReach, scoreTiming, scoreTrust,
  priorityOf, getWeights, parseEmployees, DEFAULT_WEIGHTS,
};
