'use strict';
/**
 * 卒年面シグナル（層2の“幅”の追加分・S17〜S21）
 * ============================================================================
 * mynavi-face.js が取り出した構造値だけを見る純ロジック。ネットワークには触らない。
 *
 * なぜ別モジュールか:
 *   既存の8軸は「1本に潰した本文から語を探す」設計で、S9〜S16（課題シグナル）は
 *   「根拠資料の文面」を見る設計。ここは3つ目の系統＝「掲載面の構造値どうしの差」を見る。
 *   入力の形が違うものを同じファイルに混ぜると、どの検知がどの入力に依存するのかが
 *   追えなくなるため分けている。
 *
 * ここで初めて言えるようになること:
 *   - 履歴ゼロでも「前年比」が言える（27卒面と28卒面を今日まとめて取るため）
 *   - 応募の受け口が手作業かどうかが言える（＝MOCHICAの提案がそのまま刺さる状態）
 *   - 選考が何段あるかが言える（＝応募者の状態管理コストの実測値）
 *
 * 重みは営業仮説であり受注確率ではない（既存2層と同じ方針）。
 */
const { headcountValue } = require('./mynavi-face');

const RULES = [
  ['MANUAL_ENTRY', '応募受付が手作業動線（メール・電話・郵送）', '手作業応募', 26, 120],
  ['NEXT_FACE_LIVE', '次年度卒面の始動・先行更新', '次年度面始動', 24, 30],
  ['SELECTION_LOAD', '選考プロセスの多段化', '多段選考', 18, 150],
  ['PAY_RAISE', '初任給の引き上げ', '初任給引上げ', 18, 150, true],
  ['COURSE_MULTI', '募集コースの複線化', 'コース複線', 14, 150],
];
const FACE_SIGNALS = Object.fromEntries(RULES.map(([id, 名称, col, weight, 半減期日, 要履歴 = false], i) => [id, {
  id, 名称, 列: `S${i + 17}_${col}`, 順位: i + 17, weight, 半減期日, 要履歴, group: 'face',
  説明: 'マイナビ掲載面の構造値（募集人数・選考フロー・エントリー方法・初任給）から判定',
}]));

/**
 * face群の合計点の上限。
 * 既存の課題群（operations32 / conversion32 / complexity24 / purchase40）と同じ仕組み。
 * これが無いと5軸が素の重みのまま積み上がり（合計100点）、掲載面が丁寧な会社ほど
 * 中身と関係なく上位に来る。1軸ぶん強く出れば足りるので、最大重み(26)に合わせる。
 */
const FACE_GROUP_CAP = { face: 26 };

const FACE_TALK = {
  MANUAL_ENTRY: '応募の受け付けから面接のご案内まで、いまはどなたが手で対応されていますか。',
  NEXT_FACE_LIVE: '次の卒年の準備で、いちばん手が足りなくなりそうな工程はどこでしょうか。',
  SELECTION_LOAD: '選考の各段階で、学生の状況はどのように追われていますか。',
  PAY_RAISE: '採用の条件を見直された背景と、今年の目標人数を伺えますか。',
  COURSE_MULTI: 'コースごとの応募者を、いまはどのように分けて管理されていますか。',
};

function hit(sig, { strength, level, 根拠, 詳細 = {}, 検知日 }) {
  const s = Math.max(0, Math.min(1, strength));
  return {
    signal: sig.id, 名称: sig.名称, 列: sig.列, weight: sig.weight, 半減期日: sig.半減期日,
    strength: Math.round(s * 100) / 100, level, 根拠: String(根拠 || '').slice(0, 300),
    詳細, 検知日: 検知日 || new Date().toISOString().slice(0, 10),
  };
}

// 面を「卒年の新しい順」に並べる。28卒面 → 27卒面。
function sortedFaces(卒年面) {
  return Object.entries(卒年面 || {})
    .filter(([, f]) => f && typeof f === 'object')
    .map(([gy, f]) => ({ gy: parseInt(gy, 10), ...f }))
    .filter((f) => Number.isFinite(f.gy))
    .sort((a, b) => b.gy - a.gy);
}

function daysSince(dateStr, now) {
  const m = String(dateStr || '').match(/(20\d{2})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (!Number.isFinite(d.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - d.getTime()) / 86400000));
}

// ---- S17 応募受付が手作業動線 ------------------------------------------
// マイナビ経由だけの社は応募データが媒体側に揃う。そこにメール/電話/郵送が混じると
// 応募者が担当者の受信箱に散る＝MOCHICAが解く問題そのもの。実測では25社中1社と稀で、
// 稀であることがそのままシグナルの価値になる。
function detectManualEntry(faces, 検知日) {
  const f = faces.find((x) => x.エントリー && x.エントリー.手作業.length);
  if (!f) return null;
  const routes = f.エントリー.手作業;
  const 重い = routes.filter((r) => r === 'メール' || r === '郵送' || r === 'FAX');
  const strength = 重い.length >= 2 ? 1 : (重い.length === 1 ? 0.8 : 0.5);
  return hit(FACE_SIGNALS.MANUAL_ENTRY, {
    strength, 検知日,
    level: 重い.length >= 2 ? '確定(複数の手作業経路で応募を受けている)'
      : (重い.length === 1 ? '強(手作業経路で応募を受けている)' : '中(自社フォーム・電話での受付)'),
    根拠: `${f.gy}卒面のエントリー方法に「${routes.join('・')}」の記載`
      + (f.エントリー.媒体経由 ? '（マイナビ経由と併用）' : '')
      + `: ${f.エントリー.引用.slice(0, 80)}`,
    詳細: { 卒年: f.gy, 経路: routes, 媒体経由: f.エントリー.媒体経由, url: f.url },
  });
}

// ---- S18 次年度卒面の始動・先行更新 ------------------------------------
// 次の卒年の面を現行面より新しく触っている＝来期の採用設計を今まさに作っている。
// 検討が動いている時期そのものなので、半減期は短く（30日）取る。
// 実測（200社・2026-09）: 「次年度面が直近21日以内に更新」だけなら40%が該当し、
// しかも S5（掲載面を直近更新）と同じことを二度数えるだけになる。そこで
// 「次年度面のほうが現行面より新しい」＝卒年の主戦場が移ったケースだけを採る。
const 先行余裕日 = 14;
function detectNextFaceLive(faces, now, 検知日) {
  if (faces.length < 2) return null;
  const [next, cur] = faces;
  const dNext = daysSince(next.更新日, now);
  const dCur = daysSince(cur.更新日, now);
  if (dNext == null || dCur == null) return null;
  const 先行日数 = dCur - dNext;                      // 次年度面が何日ぶん新しいか
  if (先行日数 <= 0) return null;                     // 現行面のほうが新しい＝まだ移っていない
  let strength; let level;
  if (先行日数 >= 先行余裕日 && dNext <= 14) { strength = 1; level = `確定(${next.gy}卒面を直近${dNext}日で更新・現行面より${先行日数}日新しい)`; }
  else if (先行日数 >= 先行余裕日) { strength = 0.7; level = `強(${next.gy}卒面が現行面より${先行日数}日新しい)`; }
  else { strength = 0.4; level = `中(${next.gy}卒面をわずかに先行更新)`; }
  return hit(FACE_SIGNALS.NEXT_FACE_LIVE, {
    strength, level, 検知日,
    根拠: `${next.gy}卒面の最終更新日 ${next.更新日}（${dNext}日前）`
      + (dCur != null ? `／${cur.gy}卒面は ${cur.更新日}（${dCur}日前）` : '')
      + '＝次の卒年の採用設計を今つくっている',
    詳細: { 次年度: next.gy, 次年度更新日: next.更新日, 次年度経過日: dNext, 現行更新日: cur.更新日 || '', 現行経過日: dCur, url: next.url },
  });
}

// ---- S19 選考プロセスの多段化 ------------------------------------------
// 段数＝応募者の状態が何回変わるか。多いほど「誰がどこにいるか」の管理が破綻しやすい。
function detectSelectionLoad(faces, 検知日) {
  const f = faces.find((x) => x.選考フロー && x.選考フロー.選考段数);
  if (!f) return null;
  const { 選考段数, 面接回数, 段 } = f.選考フロー;
  // 実測（200社・2026-09）の分布: 選考段数は4段が最頻（56社/28%）、5段以上は18社。
  // 最頻値をシグナルにすると順位が作れないので、4段は採らず5段以上・面接3回以上だけを採る。
  if (選考段数 < 5 && 面接回数 < 3) return null;
  let strength; let level;
  if (選考段数 >= 5 && 面接回数 >= 3) { strength = 1; level = '確定(5段以上かつ面接3回以上)'; }
  else if (選考段数 >= 6 || 面接回数 >= 4) { strength = 0.8; level = '強(選考が際立って長い)'; }
  else { strength = 0.55; level = 選考段数 >= 5 ? '中(5段の選考)' : '中(面接3回)'; }
  return hit(FACE_SIGNALS.SELECTION_LOAD, {
    strength, level, 検知日,
    根拠: `${f.gy}卒面の選考フローが${選考段数}段（面接${面接回数}回）: ${段.join('→')}`,
    詳細: { 卒年: f.gy, 選考段数, 面接回数, 段, url: f.url },
  });
}

// ---- S20 初任給の引き上げ ----------------------------------------------
// 初任給は「2025年04月実績」のように“前年の実績”として書かれる欄で、マイナビは
// 次年度面にも同じ数字をそのまま載せる。実測（両面で金額が取れた19社）では
// 卒年面どうしの差は全社ゼロだった＝2面の比較では原理的に検知できない。
// そのため比較相手は観測台帳（前回サイクルに記録した金額）にする。
// 既存の S3/S5/S6 と同じ「要履歴」型のシグナルで、初回観測では立たない（仕様）。
function detectPayRaise(faces, prev, 検知日) {
  const cur = faces.find((f) => f.初任給 && f.初任給.大卒月額);
  if (!cur) return null;
  const 今回 = cur.初任給.大卒月額;
  // 台帳に残した同じ卒年面の金額と比べる（卒年が違うと実績年も違うため比較しない）
  const 前回記録 = prev && prev[String(cur.gy)] && prev[String(cur.gy)].初任給;
  if (!Number.isFinite(前回記録)) return null;
  const 差 = 今回 - 前回記録;
  if (差 <= 0) return null;
  const 率 = 差 / 前回記録;
  let strength; let level;
  if (率 >= 0.05) { strength = 1; level = '確定(初任給を5%以上引き上げ)'; }
  else if (率 >= 0.02) { strength = 0.75; level = '強(初任給を2%以上引き上げ)'; }
  else { strength = 0.4; level = '弱(初任給を微増)'; }
  return hit(FACE_SIGNALS.PAY_RAISE, {
    strength, level, 検知日,
    根拠: `${cur.gy}卒面の初任給が前回観測 ${前回記録.toLocaleString()}円 → 今回 ${今回.toLocaleString()}円`
      + `（+${差.toLocaleString()}円 / +${Math.round(率 * 1000) / 10}%）＝採用への投資判断`,
    詳細: { 卒年: cur.gy, 今回, 前回: 前回記録, 差分: 差, 率: Math.round(率 * 1000) / 10, url: cur.url },
  });
}

// ---- S21 募集コースの複線化 --------------------------------------------
function detectCourseMulti(faces, 検知日) {
  const f = faces.find((x) => x.募集コース && x.募集コース.コース数);
  if (!f) return null;
  const n = f.募集コース.コース数;
  if (n < 3) return null;                              // 1〜2コースは普通
  const prev = faces.find((x) => x.gy !== f.gy && x.募集コース && x.募集コース.コース数);
  const 増 = prev ? n - prev.募集コース.コース数 : 0;
  let strength; let level;
  if (増 > 0) { strength = 1; level = `確定(コースを${増}本増やした)`; }
  else if (n >= 5) { strength = 0.7; level = '強(5コース以上の並行募集)'; }
  else { strength = 0.45; level = '中(3〜4コースの並行募集)'; }
  return hit(FACE_SIGNALS.COURSE_MULTI, {
    strength, level, 検知日,
    根拠: `${f.gy}卒面の募集コースが${n}本`
      + (prev ? `（${prev.gy}卒面は${prev.募集コース.コース数}本）` : '')
      + '＝コース別に応募者を分けて追う必要がある',
    詳細: { 卒年: f.gy, コース数: n, 前年コース数: prev ? prev.募集コース.コース数 : null, 増分: 増, url: f.url },
  });
}

/**
 * 卒年面から S17〜S21 を検知する。
 * @param {object} ev collect.js のエビデンス（ev.卒年面 を使う）
 */
function detectFaceSignals(ev = {}, { now = new Date(), 検知日, prev = null } = {}) {
  const faces = sortedFaces(ev.卒年面);
  if (!faces.length) return [];
  const d = 検知日 || new Date(now).toISOString().slice(0, 10);
  return [
    detectManualEntry(faces, d),
    detectNextFaceLive(faces, new Date(now), d),
    detectSelectionLoad(faces, d),
    detectPayRaise(faces, prev && prev.卒年面, d),
    detectCourseMulti(faces, d),
  ].filter(Boolean);
}

/**
 * 卒年面から「前年比の募集人数」を取り出す。既存の④（採用予定数の前年比増）に
 * 履歴なしで前年値を与えるためのもの。採用“実績”系列があるならそちらが優先される。
 * @returns {{plan:number, prevPlan:number, 卒年:number, 前年:number}|null}
 */
function crossYearHeadcount(ev = {}) {
  const faces = sortedFaces(ev.卒年面).filter((f) => headcountValue(f.募集人数) != null);
  if (faces.length < 2) return null;
  const [next, cur] = faces;
  return {
    plan: headcountValue(next.募集人数), prevPlan: headcountValue(cur.募集人数),
    卒年: next.gy, 前年: cur.gy, 表記: `${cur.gy}卒 ${cur.募集人数.表記} → ${next.gy}卒 ${next.募集人数.表記}`,
  };
}

module.exports = { FACE_SIGNALS, FACE_TALK, FACE_GROUP_CAP, detectFaceSignals, crossYearHeadcount, sortedFaces };
