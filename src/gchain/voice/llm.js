'use strict';
/**
 * G-Chain OS v2.1 — LLM 診断アダプタ（任意・ハイブリッドの高精度側）。
 *
 * ANTHROPIC_API_KEY があれば Claude で LCS 診断（Eイベント抽出＋L/C/S帰属＋GOOD/MORE）を行う。
 * 鍵が無ければ null を返し、analyze はルールベースのみで動く（必ず動く設計）。
 * 音声そのものは送らない（文字起こしテキストのみ）。使用可否は運用ポリシーに従う。
 */
const { spawnSync } = require('child_process');

const MODEL = process.env.GCHAIN_LLM_MODEL || 'claude-sonnet-5';
const URL = 'https://api.anthropic.com/v1/messages';

function available() { return !!process.env.ANTHROPIC_API_KEY; }

const SYSTEM = [
  'あなたはテレアポ通話の事実抽出器かつ診断器。以下を厳守:',
  '1) Eは事実、Gは仮説。観測できたものだけTRUE。',
  '2) 全ラベルに根拠引用(evidence_quote)。引用できないラベルは出さない。',
  '3) 未来情報(結果/アポ成否)を診断に混ぜない。',
  '出力は必ず1つのJSONのみ（前後に文章を付けない）。',
].join('\n');

function userPrompt(transcriptText) {
  return [
    '次の通話（自分=営業/相手=顧客）を分析し、JSONで返せ。',
    '```',
    transcriptText,
    '```',
    'スキーマ:',
    '{',
    '  "events":[{"event_code":"E3|E4|E5|E6","evidence_quote":"...","note":"..."}],',
    '  "attribution":{"l":0..1,"c":0..1,"s":0..1,"primary_gate":"G0|G1|G2|G3|G4","reason":"..."},',
    '  "good":{"point":"...","quote":"..."},',
    '  "more":{"point":"...","next_action":"..."},',
    '  "next_ng":{"stop_condition":"..."}',
    '}',
    'E3=意味応答, E4=情報獲得, E5=課題/関心表明, E6=打診実行。該当が無ければeventsは空配列。',
  ].join('\n');
}

/**
 * Claude を呼び LCS 診断 JSON を返す（同期・curl使用）。失敗時 null（パイプラインを壊さない）。
 * transcriptText: "自分: ...\n相手: ..." 形式。
 */
function diagnose(transcriptText, opts) {
  if (!available()) return null;
  const body = JSON.stringify({
    model: (opts && opts.model) || MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(transcriptText) }],
  });
  try {
    const r = spawnSync('curl', [
      '-s', '-X', 'POST', URL,
      '-H', 'x-api-key: ' + process.env.ANTHROPIC_API_KEY,
      '-H', 'anthropic-version: 2023-06-01',
      '-H', 'content-type: application/json',
      '--data-binary', body,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return null;
    const resp = JSON.parse(r.stdout);
    const text = resp && resp.content && resp.content[0] && resp.content[0].text;
    if (!text) return null;
    const json = extractJson(text);
    return json ? { source: 'claude', model: (opts && opts.model) || MODEL, ...json } : null;
  } catch (e) {
    return null;
  }
}

/** モデル出力から最初のJSONオブジェクトを抽出。 */
function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

module.exports = { available, diagnose, MODEL };
