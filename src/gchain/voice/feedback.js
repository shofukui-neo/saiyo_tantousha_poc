'use strict';
/**
 * G-Chain OS v2.1 — 客観指標→フィードバック（ルールベース・AI不使用・純関数）。
 *
 * 架電直後に「良かった点(GOOD)・直す点(MORE)・次の停止条件(次NG)」を引用付きで返す。
 * LLM(LCS診断)があれば analyze 側で上書き/補強するが、ここは鍵なしでも必ず動く土台。
 * 各通話に execution_score(0-100) と次元別内訳を付け、weakness.js が蓄積する。
 */

// 5次元の評価（各0-1）＋重み。合計で execution_score。
const DIMS = [
  { key: 'balance', weight: 0.22, label: '傾聴バランス' },
  { key: 'questions', weight: 0.20, label: 'ヒアリング量' },
  { key: 'proposal', weight: 0.26, label: '打診' },
  { key: 'opening', weight: 0.16, label: '冒頭の掴み' },
  { key: 'monologue', weight: 0.16, label: '一方通行の抑制' },
];

/** 各次元スコア（0-1）を指標から算出。 */
function scoreDimensions(m) {
  const s = {};
  // 傾聴バランス: talk_ratio_self が 0.5 付近で最良、0.75+ で悪い
  if (m.talk_ratio_self == null) s.balance = null;
  else s.balance = clamp01(1 - Math.abs(m.talk_ratio_self - 0.5) / 0.35);
  // ヒアリング量: 質問3件で満点
  s.questions = clamp01(m.question_count / 3);
  // 打診: したか否か（会話が成立した通話でのみ意味を持つ→analyzeで前提判定）
  s.proposal = m.proposal_made ? 1 : 0;
  // 冒頭: 目的明示＋相手が早く話し出す。時刻があれば秒(<10満点/>25で0)、無ければターン番号(0-1番=満点/6番+で0)。
  let op = m.opening_has_purpose ? 0.4 : 0;
  if (m.timing_basis === 'time' && m.opening_customer_first_sec != null) {
    op += 0.6 * clamp01(1 - (m.opening_customer_first_sec - 10) / 15);
  } else if (m.opening_customer_first_index != null) {
    op += 0.6 * clamp01(1 - (m.opening_customer_first_index - 1) / 5);
  }
  s.opening = clamp01(op);
  // 一方通行の抑制: 時刻なら最長独白<20秒満点/>60で0、文字数なら<80満点/>280で0。
  if (m.timing_basis === 'time') {
    s.monologue = clamp01(1 - (m.longest_monologue_sec - 20) / 40);
  } else {
    s.monologue = clamp01(1 - ((m.longest_monologue_chars || 0) - 80) / 200);
  }
  return s;
}

function executionScore(dimScores) {
  let sum = 0, wsum = 0;
  for (const d of DIMS) {
    const v = dimScores[d.key];
    if (v == null) continue;
    sum += v * d.weight; wsum += d.weight;
  }
  return wsum ? Math.round(100 * sum / wsum) : null;
}

/**
 * フィードバック生成。
 * m: computeMetrics の返り値。opts: { connected:bool 目安（E2成立） }
 * 返り値: { execution_score, dims, good, more, next_ng }
 */
function buildFeedback(m, opts) {
  const o = opts || {};
  const dims = scoreDimensions(m);
  const score = executionScore(dims);

  // GOOD = 最高次元
  const ranked = DIMS.map((d) => ({ ...d, v: dims[d.key] })).filter((d) => d.v != null);
  const best = [...ranked].sort((a, b) => b.v - a.v)[0];
  const worst = [...ranked].sort((a, b) => a.v - b.v)[0];

  const good = best ? goodText(best.key, m) : null;
  const more = worst ? moreText(worst.key, m, o) : null;
  const next_ng = worst ? ngText(worst.key) : null;

  return { execution_score: score, dims, good, more, next_ng };
}

function goodText(key, m) {
  switch (key) {
    case 'balance': return { point: `傾聴バランスが良い（自分の発話比 ${pctOf(m.talk_ratio_self)}）`, metric: 'talk_ratio_self', value: m.talk_ratio_self };
    case 'questions': return { point: `よくヒアリングできた（質問${m.question_count}件）`, metric: 'question_count', value: m.question_count, quote: m.question_examples[0] };
    case 'proposal': return { point: '次接点の打診ができた', metric: 'proposal_made', value: true, quote: m.proposal_examples[0] };
    case 'opening': return { point: '冒頭で相手を引き込めた', metric: 'opening', quote: null };
    case 'monologue': return { point: `一方的な説明を抑えられた（最長独白 ${monoLabel(m)}）`, metric: 'longest_monologue', value: m.longest_monologue_sec };
    default: return null;
  }
}

function monoLabel(m) { return m.timing_basis === 'time' ? `${m.longest_monologue_sec}秒` : `${m.longest_monologue_chars || 0}文字`; }
function openLabel(m) { return m.timing_basis === 'time' ? `${m.opening_customer_first_sec ?? '—'}秒` : `${m.opening_customer_first_index == null ? '—' : m.opening_customer_first_index + 1}番目のターン`; }

function moreText(key, m, o) {
  switch (key) {
    case 'balance': return {
      point: `話しすぎ（自分の発話が ${pctOf(m.talk_ratio_self)}）。相手に話させる`,
      next_action: '説明を一区切りしたら必ず質問で返し、talk比0.5以下を狙う',
      metric: 'talk_ratio_self', value: m.talk_ratio_self,
    };
    case 'questions': return {
      point: `質問が少ない（${m.question_count}件）。ヒアリング不足`,
      next_action: '状況・課題・時期の3点を必ず1問ずつ聞く（冒頭2分以内に最初の質問）',
      metric: 'question_count', value: m.question_count,
    };
    case 'proposal': return {
      point: o.connected ? '担当と話せたのに打診していない（打診漏れ）' : '打診に至っていない',
      next_action: '会話の終盤で必ず2択で次接点を提示（「来週火か木、どちらが」）',
      metric: 'proposal_made', value: false,
    };
    case 'opening': return {
      point: `冒頭で引き込めていない（相手の初回発話まで ${openLabel(m)}）`,
      next_action: '名乗り→用件を1文→すぐ相手に問いを投げ、序盤で相手を話させる',
      metric: 'opening', value: m.opening_customer_first_sec,
    };
    case 'monologue': return {
      point: `一方的な説明が長い（最長独白 ${monoLabel(m)}）`,
      next_action: '長い連続説明を禁止。一区切りごとに相手へ確認の問いを入れる',
      metric: 'longest_monologue', value: m.longest_monologue_sec,
    };
    default: return null;
  }
}

function ngText(key) {
  const map = {
    balance: '相手の発話を遮って説明を続ける',
    questions: '質問ゼロのまま商品説明に入る',
    proposal: '次接点を決めずに通話を終える',
    opening: '名乗りの後すぐ長い説明に入る',
    monologue: '30秒を超えて一方的に話し続ける',
  };
  return map[key] ? { stop_condition: map[key] } : null;
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function pctOf(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }

module.exports = { DIMS, scoreDimensions, executionScore, buildFeedback };
