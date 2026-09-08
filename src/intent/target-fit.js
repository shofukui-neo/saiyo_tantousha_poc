'use strict';
const { isExcludedIndustry, isGovernmentOrg, passesIcpFloor } = require('../icp-rules');
const { parseHireSeries } = require('./signals');

// 10～20名を1020名に変換しない。不明・範囲・連結/単体混在は確認に回す。
function exactCount(value) {
  const s = String(value ?? '').normalize('NFKC').trim().replace(/,/g, '');
  if (!/^\d+\s*(?:名|人)?$/.test(s)) return null;
  const n = Number(s.replace(/\s*(?:名|人)$/, ''));
  return Number.isSafeInteger(n) ? n : null;
}
const flagged = value => /^(?:1|true|yes|有|あり|対象|既存顧客|禁止|拒否)$/i.test(String(value ?? '').trim());

function targetFit(rec, ev = {}, res = {}) {
  const company = String(rec.企業名 || ev.企業名 || '');
  const industry = String(rec.業種 || '').trim();
  const emp = exactCount(rec.従業員数);
  const series = parseHireSeries(ev.採用実績系列 || rec['採用実績(直近3年)']);
  const hire = series.length ? series[0].人数 : exactCount(rec.年間新卒採用人数) ?? exactCount(ev.採用予定人数 || rec.採用予定人数);
  const entry = exactCount(rec.エントリー人数 ?? rec.応募者数);
  const reasons = [];
  const missing = [];
  if (['DNC', '架電拒否', '除外フラグ', '既存顧客'].some(k => flagged(rec[k]))) reasons.push('架電除外・既存顧客');
  if (isGovernmentOrg(company, industry)) reasons.push('官公庁');
  let host = ''; try { host = new URL(ev.公式URL || rec.公式URL).hostname; } catch (_) {}
  if (/(^|\.)(pref|city|town|vill)\.[a-z]+\.jp$|\.lg\.jp$/.test(host)) reasons.push('自治体ドメイン');
  if (isExcludedIndustry(industry)) reasons.push('IT・ソフトウェアは対象外');
  reasons.push(...passesIcpFloor({ emp, hire, entry }).reasons);
  if (!industry || /^(不明|未取得|未確認|—|-)$/.test(industry)) missing.push('業種');
  if (emp == null) missing.push('従業員数');
  if (hire == null) missing.push('新卒採用人数');
  const status = reasons.length ? '対象外' : missing.length ? '要確認' : '適合';
  const fitRaw = Number.parseFloat(rec.アポ期待度);
  const fit = Number.isFinite(fitRaw) ? Math.max(0, Math.min(100, fitRaw)) : 50;
  // 学習済み受注モデルではない。適合未確認企業は優先度を49に制限。
  const raw = (Number(res.スコア) || 0) * 0.65 + fit * 0.35;
  const priority = status === '対象外' ? 0 : Math.round(Math.min(status === '要確認' ? 49 : 100, raw) * 10) / 10;
  const ats = String(rec.ATS判定 || '不明');
  const route = ats === '未導入' ? '新規導入候補' : ats === '導入済' ? '既存ATSとの併用・切替条件を確認' : 'ATS利用状況を確認';
  const gaps = [...missing, ...(entry == null ? ['エントリー人数'] : []), ...(!Number.isFinite(fitRaw) ? ['アポ期待度'] : [])];
  return {
    status, priority, route,
    reasons: reasons.length ? reasons.join('／') : `従業員:${emp ?? '不明'}／新卒:${hire ?? '不明'}／エントリー:${entry ?? '不明'}／業種:${industry || '不明'}`,
    missing: gaps.join('・'),
    action: status === '対象外' ? '対象外（架電しない）' : status === '要確認' ? 'ターゲット条件を確認' : res.行動 || '監視',
  };
}

const TARGET_COLS = ['MOCHCA適合判定', 'MOCHCA適合根拠', '要確認項目', '提案ルート', '優先度モデル', '根拠URL一覧', 'インテント資料JSON', 'シグナル内訳JSON'];
module.exports = { targetFit, exactCount, TARGET_COLS };
