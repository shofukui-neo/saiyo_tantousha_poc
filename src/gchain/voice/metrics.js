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
// 自分の打診マーカー（次接点の提案）
const PROPOSAL_RE = /お時間(を|いただ)|日程|打ち合わせ|面談|ご面談|一度(お|ご)|オンライン|訪問|デモ|資料(を)?(送|お送り|お渡し)|ご案内|説明(の|させ)|お打ち合わせ|アポ|来週|再度お電話|折り返し/;
// 自分の名乗り・目的明示（冒頭品質）
const OPENING_PURPOSE_RE = /と申します|でございます|ご案内|新卒(採用|の)|採用(の|に関して)|MOCHICA|お忙しいところ/;

const dur = (s) => Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0));

/**
 * 通話指標を計算。segments は時刻昇順を想定（順不同でもソートする）。
 * 返り値は数値指標＋根拠（quote）を含む。
 */
function computeMetrics(segments) {
  const segs = [...(segments || [])].filter((s) => s && s.text != null)
    .sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  const self = segs.filter((s) => s.speaker === 'self');
  const cust = segs.filter((s) => s.speaker === 'customer');

  const selfTalk = self.reduce((t, s) => t + dur(s), 0);
  const custTalk = cust.reduce((t, s) => t + dur(s), 0);
  const totalTalk = selfTalk + custTalk;
  const callEnd = segs.length ? Math.max(...segs.map((s) => Number(s.end) || 0)) : 0;
  const callStart = segs.length ? Math.min(...segs.map((s) => Number(s.start) || 0)) : 0;
  const durationSec = Math.max(0, callEnd - callStart);

  // 質問数（自分）
  const questions = self.filter((s) => QUESTION_RE.test(s.text));
  // 相手の反論
  const objections = cust.filter((s) => OBJECTION_RE.test(s.text));
  // 打診の有無
  const proposals = self.filter((s) => PROPOSAL_RE.test(s.text));
  // 冒頭：相手が最初に話し出すまでの秒（短い=引き込めた／長い・無し=一方的/切られ気味）
  const firstCust = cust.length ? (Number(cust[0].start) || 0) - callStart : null;
  // 冒頭の目的明示
  const openingHasPurpose = self.length ? OPENING_PURPOSE_RE.test(self[0].text) : false;
  // 最長独白（自分の連続発話の合計秒）
  const longestMonologue = longestSelfRun(segs);
  // ターン数
  const turns = countTurns(segs);
  // 発話速度（自分・文字/秒）
  const selfChars = self.reduce((t, s) => t + (s.text ? s.text.length : 0), 0);
  const speakRate = selfTalk > 0 ? selfChars / selfTalk : null;

  return {
    duration_sec: round1(durationSec),
    self_talk_sec: round1(selfTalk),
    customer_talk_sec: round1(custTalk),
    talk_ratio_self: totalTalk > 0 ? round3(selfTalk / totalTalk) : null,
    question_count: questions.length,
    question_examples: questions.slice(0, 3).map((s) => s.text),
    objection_count: objections.length,
    objection_examples: objections.slice(0, 3).map((s) => s.text),
    proposal_made: proposals.length > 0,
    proposal_examples: proposals.slice(0, 2).map((s) => s.text),
    opening_customer_first_sec: firstCust == null ? null : round1(firstCust),
    opening_has_purpose: openingHasPurpose,
    longest_monologue_sec: round1(longestMonologue),
    turn_count: turns,
    self_speak_rate_cps: speakRate == null ? null : round1(speakRate),
    seg_count: segs.length,
  };
}

/** 自分の連続発話（間に相手が入らない）の最長合計秒。 */
function longestSelfRun(segs) {
  let best = 0, run = 0;
  for (const s of segs) {
    if (s.speaker === 'self') { run += dur(s); if (run > best) best = run; }
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
  QUESTION_RE, OBJECTION_RE, PROPOSAL_RE, OPENING_PURPOSE_RE,
  computeMetrics, longestSelfRun, countTurns,
};
