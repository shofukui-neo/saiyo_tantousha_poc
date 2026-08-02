'use strict';
/**
 * G-Chain OS v2.1（音声レイヤ）— 通話の客観指標（AI不使用・純関数）。
 *
 * 入力は話者付きトランスクリプト segments[{ speaker:'self'|'customer', start, end, text }]。
 * ステレオ録音（左ch=自分/右ch=相手）を各chで文字起こしするため、話者は確定している
 * （ダイアライゼーションAI不要）。ここでは会話の構造だけから弱み診断可能な指標を計算する。
 *
 * これらの指標は「架電中の話し方」を数値化する本システムの根幹。API不要で必ず動く。
 */

// 質問マーカー（自分の発話が質問か）
const QUESTION_RE = /[？?]|ですか|ますか|でしょうか|いかが|どう(ですか|でしょう|されて)|どちら|どの|いつ|どこ|なぜ|教えて(ください)?|お聞かせ|伺(っ|え)|ございますか/;
// 相手の断り・反論マーカー
const OBJECTION_RE = /(今|いま).{0,3}(忙し|立て込)|間に合って|結構です|必要(ない|あり?ません)|いらない|予算(が)?ない|検討(します|中)|また(今度|にして)|他社|変える(予定|つもり)は?ない|担当(が|は)いない|お断り|興味(が)?ない|急いで|時間(が)?ない/;
// 自分の打診マーカー（次接点の"具体的な"提案。冒頭の「ご案内」等は含めない）
const PROPOSAL_RE = /お時間(を|いただ|ある)|日程|日にち|ご都合(は|よろ)|打ち合わせ|お打ち合わせ|面談|ご面談|オンライン|訪問|デモ|資料(を)?(送|お送り|お渡し)|アポ|来週|再来週|画面を(見|お見せ|ご覧)|一度.{0,8}(見て|お見せ|ご覧|お時間)|折り返し|再度お電話/;
// 自分の名乗り・目的明示（冒頭品質）
const OPENING_PURPOSE_RE = /と申します|でございます|ご案内|新卒(採用|の)|採用(の|に関して)|MOCHICA|お忙しいところ/;

const dur = (s) => Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0));

// 話者ラベルの正規化。移植先(asumo/Gemini)は agent/customer/unknown を使うため吸収する。
const SPEAKER_ALIASES = {
  self: 'self', agent: 'self', rep: 'self', sales: 'self', operator: 'self', 営業: 'self', 自分: 'self',
  customer: 'customer', client: 'customer', 顧客: 'customer', 相手: 'customer',
};
function normalizeSpeaker(sp) {
  const k = String(sp == null ? '' : sp).trim().toLowerCase();
  return SPEAKER_ALIASES[k] || SPEAKER_ALIASES[String(sp).trim()] || 'unknown';
}
const chars = (s) => (s && s.text ? String(s.text).length : 0);

/**
 * 通話指標を計算。segments は時刻昇順を想定（順不同でもソートする）。
 * 返り値は数値指標＋根拠（quote）を含む。
 */
function computeMetrics(segments) {
  // 話者ラベルを正規化（agent→self 等）。並びは start があれば時刻、無ければ入力順を保つ。
  const segs = [...(segments || [])].filter((s) => s && s.text != null)
    .map((s, i) => ({ ...s, speaker: normalizeSpeaker(s.speaker), _i: i }))
    .sort((a, b) => ((Number(a.start) || 0) - (Number(b.start) || 0)) || (a._i - b._i));
  const self = segs.filter((s) => s.speaker === 'self');
  const cust = segs.filter((s) => s.speaker === 'customer');

  // 発話量：タイムスタンプがあれば秒、無ければ文字数へ自動フォールバック（移植先=asumo対応）。
  const selfTalk = self.reduce((t, s) => t + dur(s), 0);
  const custTalk = cust.reduce((t, s) => t + dur(s), 0);
  const totalTalk = selfTalk + custTalk;
  const selfChars = self.reduce((t, s) => t + chars(s), 0);
  const custChars = cust.reduce((t, s) => t + chars(s), 0);
  const useTime = totalTalk > 0;
  const timing_basis = useTime ? 'time' : 'chars';
  const selfVol = useTime ? selfTalk : selfChars;
  const custVol = useTime ? custTalk : custChars;
  const totalVol = selfVol + custVol;

  const callEnd = segs.length ? Math.max(...segs.map((s) => Number(s.end) || 0)) : 0;
  const callStart = segs.length ? Math.min(...segs.map((s) => Number(s.start) || 0)) : 0;
  const durationSec = Math.max(0, callEnd - callStart);

  const questions = self.filter((s) => QUESTION_RE.test(s.text));
  const objections = cust.filter((s) => OBJECTION_RE.test(s.text));
  const proposals = self.filter((s) => PROPOSAL_RE.test(s.text));

  // 冒頭：相手が最初に話し出すまで。時刻があれば秒、無ければ「相手が何番目のターンで話したか」。
  const firstCustIdx = cust.length ? segs.indexOf(cust[0]) : null;
  const firstCustSec = (useTime && cust.length) ? (Number(cust[0].start) || 0) - callStart : null;
  const openingHasPurpose = self.length ? OPENING_PURPOSE_RE.test(self[0].text) : false;

  // 最長独白：時刻があれば秒、無ければ文字数。
  const longestMonoSec = longestSelfRun(segs, dur);
  const longestMonoChars = longestSelfRun(segs, chars);

  const turns = countTurns(segs);
  const speakRate = selfTalk > 0 ? selfChars / selfTalk : null;

  return {
    timing_basis,
    duration_sec: round1(durationSec),
    self_talk_sec: round1(selfTalk),
    customer_talk_sec: round1(custTalk),
    self_chars: selfChars,
    customer_chars: custChars,
    // 発話比＝時刻優先・無ければ文字数（弱み診断の最重要指標を常に算出可能に）
    talk_ratio_self: totalVol > 0 ? round3(selfVol / totalVol) : null,
    question_count: questions.length,
    question_examples: questions.slice(0, 3).map((s) => s.text),
    objection_count: objections.length,
    objection_examples: objections.slice(0, 3).map((s) => s.text),
    proposal_made: proposals.length > 0,
    proposal_examples: proposals.slice(0, 2).map((s) => s.text),
    opening_customer_first_sec: firstCustSec == null ? null : round1(firstCustSec),
    opening_customer_first_index: firstCustIdx,
    opening_has_purpose: openingHasPurpose,
    longest_monologue_sec: round1(longestMonoSec),
    longest_monologue_chars: longestMonoChars,
    turn_count: turns,
    self_speak_rate_cps: speakRate == null ? null : round1(speakRate),
    seg_count: segs.length,
  };
}

/** 自分の連続発話（間に相手が入らない）の最長ラン。valueFn=dur(秒) or chars(文字)。 */
function longestSelfRun(segs, valueFn) {
  const val = valueFn || dur;
  let best = 0, run = 0;
  for (const s of segs) {
    if (s.speaker === 'self') { run += val(s); if (run > best) best = run; }
    else run = 0;
  }
  return best;
}

/** 話者が切り替わった回数＝ターン数。 */
function countTurns(segs) {
  let turns = 0, prev = null;
  for (const s of segs) { if (s.speaker !== prev) { turns++; prev = s.speaker; } }
  return turns;
}

function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }
function round3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }

module.exports = {
  QUESTION_RE, OBJECTION_RE, PROPOSAL_RE, OPENING_PURPOSE_RE, SPEAKER_ALIASES,
  normalizeSpeaker, computeMetrics, longestSelfRun, countTurns,
};
