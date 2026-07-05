'use strict';
// Gemini（Google AI Studio 無料枠）への薄いクライアント。
// GEMINI_KEY が未設定なら geminiAvailable() が false を返し、呼び出し側は
// ローカル（正規表現）経路へ自動フォールバックする（= キー無しでも全体は動く）。
const cfg = require('./config');

// 無料枠クォータ枯渇(429)を検知したらプロセス内で以降の呼び出しを止める（サイレント劣化の可視化）。
//  これが無いと 429 が null に握り潰され「AI抽出が0件」に見え、枠切れとロジック不良を区別できない（実験で判明）。
let _quotaExhausted = false;
function geminiQuotaExhausted() { return _quotaExhausted; }

/** GEMINI_KEY が設定されていて AI 経路が使えるか（クォータ枯渇後は false＝即regexフォールバック） */
function geminiAvailable(c = cfg) {
  return !!(c && c.GEMINI_KEY) && !_quotaExhausted;
}

/**
 * プロンプトを投げて JSON を受け取る（responseMimeType=application/json）。
 * 失敗時・キー未設定時は null を返す（呼び出し側でフォールバック判断）。
 * @param {string} prompt
 * @param {object} [opt] {maxTokens, temperature}
 * @param {object} [c] config（テスト時差し替え）
 * @returns {Promise<object|null>}
 */
// 無料枠のRPM制限を避ける簡易スロットル（プロセス内で直列化）。GEMINI_MIN_INTERVAL_MS で調整可。
let _lastCall = 0, _chain = Promise.resolve();
function _throttle(c) {
  const minGap = parseInt((c && c.GEMINI_MIN_INTERVAL_MS) || process.env.GEMINI_MIN_INTERVAL_MS || '4500', 10);
  _chain = _chain.then(async () => {
    const wait = _lastCall + minGap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastCall = Date.now();
  });
  return _chain;
}

async function geminiJson(prompt, opt = {}, c = cfg) {
  if (!geminiAvailable(c)) return null;
  await _throttle(c);
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
    if (!res.ok) {
      // 429=無料枠枯渇。以降の呼び出しを止め、一度だけ警告（サイレント劣化の可視化）。
      if (res.status === 429 && !_quotaExhausted) {
        _quotaExhausted = true;
        console.warn('[gemini] 429 Too Many Requests — 無料枠クォータ枯渇。以降はregex経路のみで動作します（AI抽出=採用担当個人名の歩留まりが低下）。');
      }
      return null;
    }
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

module.exports = { geminiAvailable, geminiJson, geminiQuotaExhausted };
