'use strict';
// リスト品質スコアリング（テレアポ・アポ率を左右する4ディメンション加重モデル）。
//   ① ICP適合度        30%  業種・規模・地域・継続性
//   ② 採用インテント    35%  求人出稿シグナル（あれば）/ 採用ページ・担当者HITの代理シグナル
//   ③ データ到達性・品質 20%  電話番号妥当性・メール・担当者/部署・URL・鮮度
//   ④ タイミング（季節） 15%  新卒採用スケジュール連動の月係数
// 各ディメンションは 0-100 に正規化したサブ指標の加重平均。総合 = Σ(dim × weight) − ネガ調整。
// すべて純ロジック（ネットワーク・APIキー不要）。担当者マスタの1レコード(オブジェクト)を入力に取る。
const cfg = require('./config');
const { normalizeJpPhone } = require('./phone');

// 既定ウェイト（合計1.0）。config.QUALITY_WEIGHTS で上書き可。
const DEFAULT_WEIGHTS = { icp: 0.30, intent: 0.35, data: 0.20, timing: 0.15 };

function getWeights(c = cfg) {
  const w = (c && c.QUALITY_WEIGHTS) || DEFAULT_WEIGHTS;
  return { icp: w.icp, intent: w.intent, data: w.data, timing: w.timing };
}

// 文字列/数値の従業員数を整数へ（"150名 [ICP60]" / "150" / 150 → 150、不明は null）
function parseEmployees(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d[\d,]*/);
  if (!m) return null;
  const n = parseInt(m[0].replace(/,/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// 値がトラックの真偽（"○"/"true"/"1"/"有"/"あり"/"掲載中" 等）か
function truthy(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return /^(○|◯|✓|true|1|yes|y|有|あり|掲載中|出稿|済)$/.test(s) || s === 'o';
}

// min-max 正規化（0-100）。範囲外はクリップ。
function minmax(v, min, max) {
  if (v == null || max <= min) return 0;
  const x = (Number(v) - min) / (max - min);
  return Math.max(0, Math.min(1, x)) * 100;
}
// 対数正規化（0-100）。出稿費用など分布が極端な指標向け。
function logNorm(v, max) {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0 || max <= 1) return 0;
  return Math.max(0, Math.min(1, Math.log(x) / Math.log(max))) * 100;
}

// 文字列にキーワード配列のいずれかが部分一致するか
function hasAny(hay, keywords) {
  const s = String(hay || '');
  return (keywords || []).some((k) => k && s.indexOf(k) >= 0);
}

// 加重平均（[{score,w}] → 0-100）
function weightedAvg(parts) {
  let sum = 0, wsum = 0;
  for (const p of parts) { sum += p.score * p.w; wsum += p.w; }
  return wsum > 0 ? sum / wsum : 0;
}

// ===== ① ICP適合度 =====
function scoreIcp(rec, icp, c = cfg) {
  const reasons = [];
  const sweetMin = c.ICP_EMP_SWEET_MIN, sweetMax = c.ICP_EMP_SWEET_MAX;
  const empMin = c.ICP_EMP_MIN, empMax = c.ICP_EMP_MAX;

  // 従業員規模
  const emp = parseEmployees(rec['従業員数']);
  let empScore;
  if (emp == null) { empScore = 40; }
  else if (emp >= sweetMin && emp <= sweetMax) { empScore = 100; reasons.push(`規模${emp}=スイート`); }
  else if (emp >= empMin && emp <= empMax) { empScore = 70; reasons.push(`規模${emp}=ICP内`); }
  else { empScore = 25; reasons.push(`規模${emp}=ICP外`); }

  // 業種一致
  const inds = (icp && icp.target_industries) || [];
  let indScore;
  if (!inds.length) indScore = 60;
  else if (hasAny(rec['業種'], inds)) { indScore = 100; reasons.push('業種一致'); }
  else { indScore = 40; }

  // 地域一致
  const geo = (icp && icp.geography) || [];
  let geoScore;
  if (!geo.length) geoScore = 60;
  else if (hasAny(rec['都道府県'], geo)) { geoScore = 100; reasons.push('地域一致'); }
  else { geoScore = 40; }

  // 継続性・信用（設立年＋補助金）
  let trust = 50;
  const yr = parseEmployees(rec['設立年']);
  if (yr) {
    const age = (new Date()).getFullYear() - yr;
    if (age >= 10) { trust += 30; reasons.push(`設立${age}年`); }
    else if (age >= 5) { trust += 15; }
  }
  if (truthy(rec['補助金'])) { trust += 20; reasons.push('補助金採択'); }
  trust = Math.min(100, trust);

  const score = weightedAvg([
    { score: empScore, w: 0.40 },
    { score: indScore, w: 0.30 },
    { score: geoScore, w: 0.15 },
    { score: trust, w: 0.15 },
  ]);
  return { score: Math.round(score), reasons };
}

// ===== ② 採用インテント =====
// 求人出稿系の列（HRogリスト等で後付け可能）があればそれを最優先。無ければ採用ページ/担当者HITの代理シグナル。
const INTENT_COLS = ['新卒出稿', '現在求人掲載中', '出稿媒体数', '予想出稿金額', '出稿継続性', '募集職種数', '採用予定人数'];
function hasIntentData(rec) {
  return INTENT_COLS.some((k) => rec[k] != null && String(rec[k]).trim() !== '');
}
function scoreIntent(rec, c = cfg) {
  const reasons = [];
  if (hasIntentData(rec)) {
    // 出稿データに基づく本スコア（知見の配点: 新卒40/媒体25/継続20/費用15）
    const shinsotsu = (truthy(rec['新卒出稿']) || truthy(rec['現在求人掲載中'])) ? 100 : 0;
    const media = minmax(parseEmployees(rec['出稿媒体数']), 1, (c.INTENT_MEDIA_MAX || 5));
    const cont = truthy(rec['出稿継続性']) ? 100 : (rec['出稿継続性'] ? 50 : 0);
    const cost = logNorm(parseEmployees(rec['予想出稿金額']), (c.INTENT_COST_MAX || 10000000));
    if (shinsotsu) reasons.push('新卒出稿中');
    if (parseEmployees(rec['出稿媒体数'])) reasons.push(`媒体数${parseEmployees(rec['出稿媒体数'])}`);
    const score = weightedAvg([
      { score: shinsotsu, w: 0.40 },
      { score: media, w: 0.25 },
      { score: cont, w: 0.20 },
      { score: cost, w: 0.15 },
    ]);
    return { score: Math.round(score), reasons, proxy: false };
  }
  // 代理シグナル（求人出稿データが無い場合）：採用ページ存在・担当者HIT
  let score = 20; // ベース
  const recruitPage = /recruit|saiyo|career|採用|entry/i.test(String(rec['根拠URL'] || ''));
  const hitConf = Number(rec['担当者確度'] || 0);
  if (rec['採用担当者名']) { score += 40 + Math.round(20 * Math.min(1, hitConf)); reasons.push('採用担当者HIT'); }
  else if (recruitPage) { score += 25; reasons.push('採用ページ有'); }
  if (recruitPage && rec['採用担当者名']) { score += 5; }
  score = Math.min(100, score);
  return { score, reasons: reasons.length ? reasons : ['出稿データ無し(代理推定)'], proxy: true };
}

// ===== ③ データ到達性・品質 =====
function daysSince(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 86400000);
}
function scoreData(rec, c = cfg, nowMs) {
  nowMs = nowMs || Date.now();
  const reasons = [];

  // 電話番号の妥当性
  const phoneRaw = String(rec['電話番号'] || '').trim();
  let phoneScore;
  if (!phoneRaw) phoneScore = 0;
  else if (normalizeJpPhone(phoneRaw)) { phoneScore = 100; reasons.push('電話妥当'); }
  else { phoneScore = 50; reasons.push('電話要確認'); }

  // メール（確度を反映）
  const emConf = Number(rec['メール確度'] || 0);
  const emScore = rec['メール'] ? Math.max(20, Math.min(100, Math.round(emConf * 100))) : 0;
  if (rec['メール']) reasons.push('メール有');

  // 担当者/部署
  let contactScore = 0;
  if (rec['採用担当者名']) { contactScore = 100; reasons.push('担当者名有'); }
  else if (rec['部署']) contactScore = 50;

  // 公式URL
  const urlScore = rec['公式URL'] ? 100 : 0;

  // 鮮度
  const d = daysSince(rec['取得日'], nowMs);
  let freshScore;
  if (d == null) freshScore = 50;
  else if (d < 30) freshScore = 100;
  else if (d < 90) freshScore = 70;
  else if (d < 180) freshScore = 40;
  else { freshScore = 20; reasons.push('鮮度低'); }

  const score = weightedAvg([
    { score: phoneScore, w: 0.30 },
    { score: emScore, w: 0.25 },
    { score: contactScore, w: 0.20 },
    { score: urlScore, w: 0.15 },
    { score: freshScore, w: 0.10 },
  ]);
  return { score: Math.round(score), reasons };
}

// ===== ④ タイミング（新卒採用シーズン係数）=====
// 一次選考の前倒し市場（前年10-12月にピーク・3月前に8割が一次選考開始）を反映。
function monthSeason(month, c = cfg) {
  const map = (c && c.SEASON_BY_MONTH) || {
    1: 85, 2: 85, 3: 85,        // 直前期
    4: 70, 5: 70, 6: 70,        // 夏インターン準備
    7: 55, 8: 55,               // 中だるみ
    9: 100, 10: 100, 11: 100, 12: 100, // 計画・媒体選定ピーク
  };
  return map[month] != null ? map[month] : 70;
}
function scoreTiming(rec, c = cfg, now) {
  const m = (now ? now : new Date()).getMonth() + 1;
  const score = monthSeason(m, c);
  return { score, reasons: [`${m}月=季節係数${score}`] };
}

// ===== 総合 =====
function priorityOf(total, c = cfg) {
  const hi = (c && c.QUALITY_PRIORITY_HIGH) != null ? c.QUALITY_PRIORITY_HIGH : 70;
  const mid = (c && c.QUALITY_PRIORITY_MID) != null ? c.QUALITY_PRIORITY_MID : 45;
  if (total >= hi) return '今週架電';
  if (total >= mid) return 'ナーチャリング';
  return '後回し';
}

// ネガティブ調整（除外フラグ・競合ATS導入済み・DNC 等の列があれば減点）
function negativeAdjust(rec) {
  let penalty = 0; const reasons = [];
  if (truthy(rec['除外フラグ']) || truthy(rec['DNC']) || truthy(rec['架電拒否'])) { penalty += 100; reasons.push('除外/DNC'); }
  if (truthy(rec['既存顧客'])) { penalty += 60; reasons.push('既存顧客'); }
  if (truthy(rec['競合ATS導入'])) { penalty += 30; reasons.push('競合ATS導入'); }
  return { penalty, reasons };
}

/**
 * 1レコードの品質を採点。
 * @param {object} rec 担当者マスタの1行（オブジェクト）
 * @param {object} opt { icp, now(Date), nowMs(number), c(config) }
 * @returns {{total:number, dims:{icp,intent,data,timing}, priority:string, reasons:string[], proxyIntent:boolean}}
 */
function scoreRecord(rec, opt = {}) {
  const c = opt.c || cfg;
  const icp = opt.icp || { target_industries: c.ICP_INDUSTRIES, geography: c.ICP_PREFECTURES };
  const now = opt.now || new Date();
  const nowMs = opt.nowMs || (opt.now ? opt.now.getTime() : Date.now());
  const w = getWeights(c);

  const icpR = scoreIcp(rec, icp, c);
  const intentR = scoreIntent(rec, c);
  const dataR = scoreData(rec, c, nowMs);
  const timingR = scoreTiming(rec, c, now);
  const neg = negativeAdjust(rec);

  const raw = icpR.score * w.icp + intentR.score * w.intent + dataR.score * w.data + timingR.score * w.timing;
  const total = Math.max(0, Math.min(100, Math.round(raw - neg.penalty)));

  const reasons = []
    .concat(icpR.reasons.map((r) => 'ICP:' + r))
    .concat(intentR.reasons.map((r) => 'INT:' + r))
    .concat(dataR.reasons.map((r) => 'DAT:' + r))
    .concat(neg.reasons.map((r) => 'NEG:' + r));

  return {
    total,
    dims: { icp: icpR.score, intent: intentR.score, data: dataR.score, timing: timingR.score },
    priority: priorityOf(total, c),
    proxyIntent: !!intentR.proxy,
    reasons,
  };
}

module.exports = {
  scoreRecord, scoreIcp, scoreIntent, scoreData, scoreTiming,
  priorityOf, monthSeason, parseEmployees, getWeights, DEFAULT_WEIGHTS,
  hasIntentData, negativeAdjust,
};
