'use strict';
/**
 * 昨年度の採用失敗シグナル（層2の“重要指標”・S22〜S25）
 * ============================================================================
 * ユーザー確定（2026-09-18）: 「昨年度の採用がうまくいかなかった」ことが、いま動く
 * 理由としていちばん強い。二次募集（S2）や採用数増（S4）は“その結果”であって、
 * 原因そのものではない。ここは原因を直接名指しする層。
 *
 * なぜ別モジュールか:
 *   既存の系統は「今の掲載面に何が書いてあるか」を見る。ここは「昨年度の結果」を見る。
 *   見る時間軸が違うものを同じファイルに混ぜると、半減期の考え方が噛み合わなくなる
 *   （掲載文言は30〜90日で腐るが、昨年度の結果は次の採用サイクルまで効き続ける）。
 *
 * 一次情報（すべてマイナビ掲載面の公開記載。推測はしない）:
 *   ① 過去3年間の新卒採用者数・離職者数・定着率（若者雇用促進法の開示欄）
 *      → 実測（2026-09・無作為6社）で6社とも掲載。「何人採れて何人辞めたか」が数字で出る。
 *   ② 募集人数（卒年面）＋ 観測台帳に残した前年の募集人数
 *      → 「計画に対して何人届かなかったか」は前年の“計画”が要る。台帳が1周した社で確定が出る。
 *   ③ 掲載文・自社サイトの記載（「採用計画に届かず」「母集団形成に苦戦」など）
 *
 * 設計の肝:
 *   - 「採れなかった」と「絞った」は公開情報では見分けられない。数字が下がっただけの時は
 *     強度を上げず、トークで確認しに行く（根拠文にもその旨を書く）。
 *   - 定着率の開示は年に1回しか更新されない。開示年が古い社は強度を割り引く。
 *   - 重みは営業仮説であり受注確率ではない（既存3系統と同じ方針）。
 */

// 列は S22〜。既存は S1〜S8（基礎）/ S9〜S16（課題）/ S17〜S21（卒年面）。
const RULES = [
  ['LAST_YEAR_SHORTFALL', '昨年度の採用計画が未充足', '昨年度未充足', 36, 210],
  ['EARLY_TURNOVER', '直近入社の早期離職（定着率の低下）', '早期離職', 30, 210],
  ['SHORTFALL_VOICE', '採用難・計画未達の記載', '採用難の記載', 28, 90],
  ['HIRE_DOWNTREND', '新卒入社数の減少', '入社数減', 22, 210],
];
const FAILURE_SIGNALS = Object.fromEntries(RULES.map(([id, 名称, col, weight, 半減期日], i) => [id, {
  id, 名称, 列: `S${i + 22}_${col}`, 順位: i + 22, weight, 半減期日, 要履歴: false, group: 'failure',
  説明: '昨年度の採用結果（定着率の開示欄・募集人数と実績の差・掲載文）から判定',
}]));

/**
 * failure群の合計点の上限。
 * 4軸とも「昨年度うまくいかなかった」の別の言い方なので、素の重みで積むと116点＝
 * それだけでA階層が埋まる。いちばん強い軸1本（36）＋補強1本ぶんに留める。
 */
const FAILURE_GROUP_CAP = { failure: 44 };

const FAILURE_TALK = {
  LAST_YEAR_SHORTFALL: '昨年度の新卒採用は、当初の計画に対してどのくらい充足されましたか。'
    + '足りなかった分を今年の母集団でどう取り返すかというところで、お話しできる事例があります。',
  EARLY_TURNOVER: '入社後の早期離職について、いま何か手を打たれていますか。'
    + '内定から入社までの接触量で歩留まりが変わった事例をご紹介できます。',
  SHORTFALL_VOICE: '昨年度の採用で、いちばん苦しかった工程はどこでしたか。'
    + '母集団か、選考中の離脱か、内定辞退かで打ち手が変わるので、そこから伺えればと思います。',
  HIRE_DOWNTREND: '新卒の入社人数が前年から変わっていますが、これは計画を絞られたのでしょうか、'
    + 'それとも採りきれなかった側でしょうか。',
};

function hit(sig, { strength, level, 根拠, 詳細 = {}, 検知日 }) {
  const s = Math.max(0, Math.min(1, strength));
  return {
    signal: sig.id, 名称: sig.名称, 列: sig.列, weight: sig.weight, 半減期日: sig.半減期日,
    strength: Math.round(s * 100) / 100, level, 根拠: String(根拠 || '').slice(0, 300),
    詳細, 検知日: 検知日 || new Date().toISOString().slice(0, 10),
  };
}

// 卒年（'27'）と入社年（2027）を行き来する。定着率の表は入社年、卒年面のキーは卒年。
const gradKeyOf = (year) => String(year % 100).padStart(2, '0');

// 掲載面から取れた「新卒入社の実数」の年系列。定着率の開示欄を第一とし、
// 無ければ採用実績の年系列（"2026年26名/2025年33名"）を使う。
function hireActuals(ev = {}) {
  const ret = ev.定着 && Array.isArray(ev.定着.系列) ? ev.定着.系列 : null;
  if (ret && ret.length) return { 出所: '定着率開示', 系列: ret.map((r) => ({ 年: r.年, 人数: r.採用者 })) };
  const s = String(ev.採用実績系列 || '');
  const out = []; const seen = new Set();
  for (const m of s.matchAll(/(20\d{2})\s*年\D{0,4}?(\d{1,4})\s*名/g)) {
    if (seen.has(+m[1])) continue;
    seen.add(+m[1]); out.push({ 年: +m[1], 人数: +m[2] });
  }
  out.sort((a, b) => b.年 - a.年);
  return out.length ? { 出所: '採用実績', 系列: out } : null;
}

// 今年度の募集人数（下限）。卒年面 → 掲載の採用予定人数の順に見る。
function currentPlan(ev = {}) {
  const faces = Object.entries(ev.卒年面 || {})
    .map(([gy, f]) => ({ gy: parseInt(gy, 10), f }))
    .filter((x) => Number.isFinite(x.gy) && x.f && x.f.募集人数 && Number.isFinite(x.f.募集人数.下限))
    .sort((a, b) => b.gy - a.gy);
  if (faces.length) return { 人数: faces[0].f.募集人数.下限, 表記: faces[0].f.募集人数.表記, 卒年: faces[0].gy };
  const n = String(ev.採用予定人数 ?? '').normalize('NFKC').replace(/,/g, '').match(/^(\d{1,4})\s*(?:名|人)?$/);
  return n ? { 人数: +n[1], 表記: n[1] + '名', 卒年: null } : null;
}

// ---- S22 昨年度の採用計画が未充足 --------------------------------------
// 一番言いたいこと。計画（募集人数）と結果（入社実数）の差で言う。
// 台帳に前年の募集人数が残っている社だけが「確定」になる（1周目は傍証止まり＝仕様）。
function detectShortfall(ev, prev, 検知日) {
  const act = hireActuals(ev);
  if (!act) return null;
  const 昨年 = act.系列[0];
  if (!昨年 || !Number.isFinite(昨年.人数)) return null;

  const prevFaces = (prev && prev.卒年面) || null;
  const 前年計画面 = prevFaces && prevFaces[gradKeyOf(昨年.年)];
  const 前年計画 = 前年計画面 && 前年計画面.募集人数 && Number.isFinite(前年計画面.募集人数.下限)
    ? 前年計画面.募集人数.下限 : null;

  if (Number.isFinite(前年計画) && 前年計画 > 0 && 昨年.人数 < 前年計画) {
    const 充足率 = 昨年.人数 / 前年計画;
    let strength; let level;
    if (充足率 <= 0.6) { strength = 1; level = '確定(昨年度の入社が計画の6割以下)'; }
    else if (充足率 <= 0.85) { strength = 0.8; level = '確定(昨年度の採用計画が未充足)'; }
    else { strength = 0.6; level = '強(昨年度の採用計画にわずかに届かず)'; }
    return hit(FAILURE_SIGNALS.LAST_YEAR_SHORTFALL, {
      strength, level, 検知日,
      根拠: `${昨年.年}年入社の募集人数${前年計画}名に対し実績${昨年.人数}名`
        + `（充足率${Math.round(充足率 * 100)}%／出所:${act.出所}・前回観測の掲載面）`,
      詳細: { 年: 昨年.年, 計画: 前年計画, 実績: 昨年.人数, 充足率: Math.round(充足率 * 100), 出所: act.出所 },
    });
  }

  // 台帳が無い社（1周目）: 今年度の募集人数と昨年度の実績を並べる。
  // 「今年これだけ採ると言っているのに、昨年はこれしか採れていない」＝積み残しの傍証。
  // 増員計画そのものは S4 が別に採るので、ここは“差がついている”ことだけを弱く言う。
  const plan = currentPlan(ev);
  if (!plan || !Number.isFinite(plan.人数) || plan.人数 <= 昨年.人数) return null;
  const 差 = plan.人数 - 昨年.人数;
  const 倍率 = 昨年.人数 > 0 ? plan.人数 / 昨年.人数 : Infinity;
  let strength; let level;
  if ((倍率 >= 1.5 || 昨年.人数 === 0) && 差 >= 3) { strength = 0.65; level = '中(今年度の募集人数が昨年度実績を大きく上回る)'; }
  else if (差 >= 2) { strength = 0.45; level = '弱(今年度の募集人数が昨年度実績を上回る)'; }
  else return null;
  return hit(FAILURE_SIGNALS.LAST_YEAR_SHORTFALL, {
    strength, level, 検知日,
    根拠: `今年度の募集人数${plan.表記}に対し、${昨年.年}年入社の実績は${昨年.人数}名（+${差}名／出所:${act.出所}）`
      + '＝昨年度の積み残しか増員かは架電で確認',
    詳細: { 年: 昨年.年, 計画: plan.人数, 実績: 昨年.人数, 差分: 差, 出所: act.出所, 前年計画不明: true },
  });
}

// ---- S23 直近入社の早期離職（定着率の低下）------------------------------
// 若者雇用促進法の開示欄。「採ったのに残らなかった」＝昨年度の採用の失敗そのもの。
function detectTurnover(ev, now, 検知日) {
  const ret = ev.定着;
  if (!ret || !ret.系列 || !ret.系列.length) return null;
  const 最新 = ret.系列[0];
  const 平均 = ret.系列.reduce((a, x) => a + x.定着率, 0) / ret.系列.length;
  // 開示は年1回。古い開示は“今の状態”とは限らないので割り引く。
  const 古さ = new Date(now).getFullYear() - 最新.年;
  const 鮮度 = 古さ <= 1 ? 1 : (古さ === 2 ? 0.8 : 0.6);

  // 「100%未満なら立てる」にすると、57名採って2名辞めた社（96.5%）まで拾う。
  // 定着率96%は良い方の数字で、これを失敗として架電すると最初の一言で外す。
  // 実測8社では 96.5% と 87.5% が混ざっていた。92%を境にして良い側は採らない。
  let strength; let level;
  if (最新.定着率 <= 70) { strength = 1; level = `確定(${最新.年}年入社の定着率${最新.定着率}%)`; }
  else if (最新.定着率 <= 85) { strength = 0.8; level = `強(${最新.年}年入社の定着率${最新.定着率}%)`; }
  else if (最新.定着率 <= 92) { strength = 0.45; level = `中(${最新.年}年入社の定着率${最新.定着率}%)`; }
  else if (平均 <= 85) { strength = 0.4; level = `弱(過去3年平均の定着率${Math.round(平均)}%)`; }
  else return null;

  return hit(FAILURE_SIGNALS.EARLY_TURNOVER, {
    strength: strength * 鮮度, level: 古さ >= 2 ? `${level}／${古さ}年前の開示` : level, 検知日,
    根拠: '新卒入社の定着率: '
      + ret.系列.map((r) => `${r.年}年 採用${r.採用者}名・離職${r.離職者}名・定着${r.定着率}%`).join(' ／ ')
      + '（マイナビ掲載面の開示欄）',
    詳細: { 年: 最新.年, 定着率: 最新.定着率, 採用者: 最新.採用者, 離職者: 最新.離職者, 三年平均: Math.round(平均), 開示の古さ: 古さ },
  });
}

// ---- S24 採用難・計画未達の記載 ----------------------------------------
// 文面で自分から言っている社。数字より強いことがあるので、否定表現だけは必ず打ち消す。
const VOICE_STRONG = [
  '採用目標に届か', '採用計画に届か', '計画未達', '予定人数に満たな', '募集人数に達しな',
  '充足できな', '充足しなかった', '充足率', '採用計画を見直', '母集団形成に苦戦', '母集団が集まら',
  '応募が集まら', '採用に苦戦', '人材確保に苦戦', '採用が思うように', '欠員補充', '欠員募集',
  '内定辞退が増', '内定辞退が続', '内定辞退率',
];
const VOICE_MED = ['採用難', '人手不足', '人材不足', '採用競争の激化', '応募数の減少', '母集団の減少'];
const VOICE_NEG = /(あり?ません|ござい?ません|解消|解決しました|改善しました|課題では)/;
const VOICE_CONTEXT = /新卒|学生|内定|採用|募集/;
const LAST_YEAR = /(昨年度|前年度|昨年|前年|今年度|20\d{2}年度)/;

function detectVoice(ev, 検知日) {
  const chunks = [String(ev.掲載本文 || '')];
  for (const d of ev.インテント資料 || []) chunks.push(String(d.text || ''));
  for (const raw of chunks) {
    if (!raw) continue;
    for (const sentence of raw.normalize('NFKC').split(/[。！？\n]+/).map((x) => x.trim()).filter(Boolean)) {
      if (sentence.length > 200 || !VOICE_CONTEXT.test(sentence) || VOICE_NEG.test(sentence)) continue;
      const strong = VOICE_STRONG.find((k) => sentence.includes(k));
      const med = strong ? null : VOICE_MED.find((k) => sentence.includes(k));
      if (!strong && !med) continue;
      const 昨年度言及 = LAST_YEAR.test(sentence);
      const strength = strong ? (昨年度言及 ? 0.95 : 0.75) : (昨年度言及 ? 0.5 : 0.35);
      return hit(FAILURE_SIGNALS.SHORTFALL_VOICE, {
        strength, 検知日,
        level: strong ? (昨年度言及 ? '確定(昨年度の未充足を自社で記載)' : '強(採用の未充足を自社で記載)')
          : '中(採用難の一般的な記載)',
        根拠: `「${sentence.slice(0, 120)}」`,
        詳細: { キーワード: strong || med, 昨年度言及, 引用: sentence.slice(0, 160) },
      });
    }
  }
  return null;
}

// ---- S25 新卒入社数の減少 ----------------------------------------------
// 「採れなかった」のか「絞った」のかは公開情報では分からない。強く採らず、架電で確認する。
function detectDowntrend(ev, 検知日) {
  const act = hireActuals(ev);
  if (!act || act.系列.length < 2) return null;
  const [cur, prev] = act.系列;
  if (!(prev.人数 > 0) || cur.人数 >= prev.人数) return null;
  const 減 = prev.人数 - cur.人数;
  const 減率 = 減 / prev.人数;
  // 16名→15名のような揺れまで拾うと、実測8社中5社が「入社数減」で立つ。
  // 毎年ぴったり同じ人数を採る会社の方が珍しいので、そこはシグナルではなくノイズ。
  if (cur.人数 > 0 && 減率 < 0.15 && 減 < 3) return null;
  let strength; let level;
  if (cur.人数 === 0) { strength = 0.9; level = `確定(${cur.年}年の新卒入社が0名)`; }
  else if (減率 >= 0.5) { strength = 0.75; level = `強(${cur.年}年の入社が前年から半減)`; }
  else if (減率 >= 0.25) { strength = 0.5; level = '中(入社数が前年から25%以上減)'; }
  else { strength = 0.3; level = '弱(入社数が前年から減少)'; }
  return hit(FAILURE_SIGNALS.HIRE_DOWNTREND, {
    strength, level, 検知日,
    根拠: `新卒入社数 ${prev.年}年${prev.人数}名 → ${cur.年}年${cur.人数}名（−${減}名／出所:${act.出所}）`
      + '＝採りきれなかったのか計画を絞ったのかは架電で確認',
    詳細: { 今回: cur.人数, 前年: prev.人数, 差分: -減, 減率: Math.round(減率 * 100), 年: cur.年, 出所: act.出所 },
  });
}

/**
 * 昨年度の採用失敗シグナル（S22〜S25）を検知する。
 * @param {object} ev collect.js のエビデンス（ev.定着 / ev.卒年面 / ev.採用実績系列 / ev.掲載本文）
 * @param {{now?:Date|string, 検知日?:string, prev?:object|null}} opts prev は store.prevOf の戻り
 */
function detectFailureSignals(ev = {}, { now = new Date(), 検知日, prev = null } = {}) {
  const d = 検知日 || new Date(now).toISOString().slice(0, 10);
  return [
    detectShortfall(ev, prev, d),
    detectTurnover(ev, now, d),
    detectVoice(ev, d),
    detectDowntrend(ev, d),
  ].filter(Boolean);
}

module.exports = {
  FAILURE_SIGNALS, FAILURE_TALK, FAILURE_GROUP_CAP, detectFailureSignals,
  hireActuals, currentPlan, detectShortfall, detectTurnover, detectVoice, detectDowntrend,
};
