'use strict';
const { isExcludedIndustry, isGovernmentOrg, passesIcpFloor, resolveIcpInputs, MIX } = require('../icp-rules');
const { hiringMix } = require('./mix-signals');
const { parseHireSeries } = require('./signals');
const { truthy } = require('../csv');

// 10～20名を1020名に変換しない。不明・範囲・連結/単体混在は確認に回す。
function exactCount(value) {
  const s = String(value ?? '').normalize('NFKC').trim().replace(/,/g, '');
  if (!/^\d+\s*(?:名|人)?$/.test(s)) return null;
  const n = Number(s.replace(/\s*(?:名|人)$/, ''));
  return Number.isSafeInteger(n) ? n : null;
}
const flagged = value => truthy(value) || /^(?:対象|既存顧客|禁止|拒否)$/i.test(String(value ?? '').trim());

function targetFit(rec, ev = {}, res = {}) {
  const company = String(rec.企業名 || ev.企業名 || '');
  const industry = String(rec.業種 || '').trim();
  // 入力CSVで空だった従業員数・新卒採用人数を掲載面（マイナビ会社概要）で埋める。
  // 埋まったぶん ICP のフロアが実際に効く＝「不明だから通す」で膨らんでいた要確認が減る。
  const resolved = resolveIcpInputs(rec, ev);
  const emp = exactCount(rec.従業員数) ?? resolved.emp;
  const series = parseHireSeries(ev.採用実績系列 || rec['採用実績(直近3年)']);
  // フロア判定に使う「新卒採用人数」は **今年度の採用目標人数** で見る（ユーザー指定 2026-09-18）。
  //
  // 以前はここで採用実績系列（＝昨年度に実際に入社した人数）を最優先していた。これが逆だった:
  //   昨年度の実績が低い社は「計画を充たせなかった社」であって、MOCHICAがいちばん刺さる相手。
  //   実際その事実は S22（昨年度の採用計画が未充足）として **加点** している。
  //   同じ事実でフロアから落とすと、最も熱い層を母集団から捨てることになる。
  //   実測 2026-09-18: 「28卒6〜10名募集・昨年度3名入社」型が1,664社が対象外に落ちており、
  //   うち287社は公的・協同組合系（v5で接触2.1倍・アポ4.4倍の最重要層）だった。
  //
  // 優先順は resolveIcpInputs() に一本化する（CSV → 掲載面の募集人数 → 入社実績 → 採用予定）。
  // 実績系列は、目標人数がどこからも取れなかったときの最後の手当てとしてだけ残す。
  const hire = resolved.hire ?? (series.length ? series[0].人数 : null);
  const entry = exactCount(rec.エントリー人数 ?? rec.応募者数);
  // 採用構成。中途中心・新卒なしと判明した社はここで対象外になる（MOCHICAは新卒ATS）。
  const mix = hiringMix(ev);
  const reasons = [];
  const missing = [];
  if (['DNC', '架電拒否', '除外フラグ', '既存顧客'].some(k => flagged(rec[k]))) reasons.push('架電除外・既存顧客');
  // 統合マスタが実際に持っている重複列は `既存被り`（MOCHICA顧客 / BALES / SF）で、
  // 上の4列とは名前が違うため従来ここを素通りしていた。結果、既存顧客が「適合」で
  // 上位に出ていた（実測: (株)ネオキャリア【BPO事業部】が総合89.5でS帯3位・自社グループ）。
  //
  // 落とすのは **MOCHICA既存顧客だけ**。SF／BALESは「過去に接触した」だけで失注ではなく、
  // 履歴がある側＝再アプローチの材料がある層なので母集団には残す
  // （新規/既存の切り分けは split-icp-intent-fresh.js が4層索引で後段に割る）。
  if (/MOCHICA顧客|既存顧客/.test(String(rec['既存被り'] ?? ''))) reasons.push('MOCHICA既存顧客');
  if (isGovernmentOrg(company, industry)) reasons.push('官公庁');
  let host = ''; try { host = new URL(ev.公式URL || rec.公式URL).hostname; } catch (_) {}
  if (/(^|\.)(pref|city|town|vill)\.[a-z]+\.jp$|\.lg\.jp$/.test(host)) reasons.push('自治体ドメイン');
  if (isExcludedIndustry(industry)) reasons.push('IT・ソフトウェアは対象外');
  reasons.push(...passesIcpFloor({ emp, hire, entry, mix }).reasons);
  if (!industry || /^(不明|未取得|未確認|—|-)$/.test(industry)) missing.push('業種');
  if (emp == null) missing.push('従業員数');
  if (hire == null) missing.push('新卒採用人数');
  const status = reasons.length ? '対象外' : missing.length ? '要確認' : '適合';
  const fitRaw = Number.parseFloat(rec.アポ期待度);
  const fit = Number.isFinite(fitRaw) ? Math.max(0, Math.min(100, fitRaw)) : 50;
  // 学習済み受注モデルではない。適合未確認企業は優先度を49に制限。
  // 資金係数（budget-signals.assessFunding）は「採用にお金を出せない状態」の減点。
  //   赤字・人員削減 0.70 ／ 採用縮小 0.75〜0.80 ／ 予算確定 0.85 ／ それ以外 1.0
  // インテントスコア側を下げないのは、シグナルは実際に立っているから（事実は曲げない）。
  // 下げるのは「今どの順で架けるか」だけ。予算が閉じている社は順番を後ろにし、
  // 推奨アクション（score.js）でナーチャリングに回す。
  const 予算係数 = Number.isFinite(res.予算係数) ? Math.max(0.5, Math.min(1, res.予算係数)) : 1;
  const raw = ((Number(res.スコア) || 0) * 0.65 + fit * 0.35) * 予算係数;
  const priority = status === '対象外' ? 0 : Math.round(Math.min(status === '要確認' ? 49 : 100, raw) * 10) / 10;
  const ats = String(rec.ATS判定 || '不明');
  const route = ats === '未導入' ? '新規導入候補' : ats === '導入済' ? '既存ATSとの併用・切替条件を確認' : 'ATS利用状況を確認';
  // 中途の規模は midjobs 系統でしか取れない。status（適合/要確認）には入れず、
  // 「埋めるべき穴」としてだけ出す。ここを status に入れると、midjobs を回していない
  // リストが丸ごと要確認に落ちて、従来の成果物の意味が変わってしまう。
  const mixGap = (mix.構成 === MIX.UNKNOWN && hire != null) ? ['中途採用の規模(midjobs未取得)'] : [];
  const gaps = [...missing, ...mixGap, ...(entry == null ? ['エントリー人数'] : []), ...(!Number.isFinite(fitRaw) ? ['アポ期待度'] : [])];
  return {
    status, priority, route, mix,
    reasons: reasons.length ? reasons.join('／')
      : `従業員:${emp ?? '不明'}／新卒:${hire ?? '不明'}／エントリー:${entry ?? '不明'}／業種:${industry || '不明'}`
        + `／採用構成:${mix.構成}`,
    missing: gaps.join('・'),
    action: status === '対象外' ? '対象外（架電しない）' : status === '要確認' ? 'ターゲット条件を確認' : res.行動 || '監視',
    // どの値がCSVで、どれが掲載面から埋まったかを成果物に残す（後で突き合わせるため）
    入力出所: Object.entries(resolved.出所).map(([k, v]) => `${k}:${v}`).join('・'),
  };
}

const TARGET_COLS = ['MOCHCA適合判定', 'MOCHCA適合根拠', '要確認項目', '提案ルート', '優先度モデル', '根拠URL一覧', 'インテント資料JSON', 'シグナル内訳JSON'];
// 資金面の列。架電者が「今すぐ売る相手か／時期を押さえる相手か」を1行で判断するためのもの。
const BUDGET_COLS = ['予算状態', '予算係数', '資金リスク', '検討時期', '予算トーク'];
// 採用構成の列。「新卒中心だから架ける」という選別理由をそのまま成果物に出す。
const MIX_COLS = ['採用構成', '新卒規模', '中途求人件数', '採用構成根拠', '入力出所'];
module.exports = { targetFit, exactCount, TARGET_COLS, BUDGET_COLS, MIX_COLS };
