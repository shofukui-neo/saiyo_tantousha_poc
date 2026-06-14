'use strict';
// Gemini（Google AI Studio 無料枠）への薄いクライアント。
// GEMINI_KEY が未設定なら geminiAvailable() が false を返し、呼び出し側は
// ローカル（正規表現）経路へ自動フォールバックする（= キー無しでも全体は動く）。
const cfg = require('./config');

/** GEMINI_KEY が設定されていて AI 経路が使えるか */
function geminiAvailable(c = cfg) {
  return !!(c && c.GEMINI_KEY);
}

/**
 * プロンプトを投げて JSON を受け取る（responseMimeType=application/json）。
 * 失敗時・キー未設定時は null を返す（呼び出し側でフォールバック判断）。
 * @param {string} prompt
 * @param {object} [opt] {maxTokens, temperature}
 * @param {object} [c] config（テスト時差し替え）
 * @returns {Promise<object|null>}
 */
async function geminiJson(prompt, opt = {}, c = cfg) {
  if (!geminiAvailable(c)) return null;
  // 認証はヘッダ x-goog-api-key で行う（新形式 "AQ." 認可キー・従来 "AIza" キー共通）。
  // ?key= クエリと併用すると "Multiple authentication credentials" になるため、クエリは付けない。
  const url = `${c.LLM_ENDPOINT}${c.LLM_MODEL}:generateContent`;
  const generationConfig = {
    temperature: opt.temperature != null ? opt.temperature : 0.1,
    maxOutputTokens: opt.maxTokens || 800,
    responseMimeType: 'application/json',
  };
  // Gemini 3.x の thinking はこの抽出タスクでは不要。budget=0 で無効化（高速・低コスト・トークン枯渇回避）。
  if (c.GEMINI_THINKING_BUDGET != null && c.GEMINI_THINKING_BUDGET >= 0) {
    generationConfig.thinkingConfig = { thinkingBudget: c.GEMINI_THINKING_BUDGET };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), c.PER_PAGE_TIMEOUT_MS || 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.GEMINI_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const text = j && j.candidates && j.candidates[0] &&
      j.candidates[0].content && j.candidates[0].content.parts &&
      j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { geminiAvailable, geminiJson };
