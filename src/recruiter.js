'use strict';
// L3: 採用担当者の氏名抽出（AI/正規表現の両対応）。
//  - GEMINI_KEY があれば Gemini で抽出、無ければ既存 extract.js（正規表現＋人名判定）。
//  - どちらの経路でも最終的に validate.js の検証ゲートを通したものだけ HIT とする。
// 1ページ分の本文を受け取り、HITなら正規化済みの担当者オブジェクトを返す（無ければ null）。
const cfg = require('./config');
const { extractContact } = require('./extract');
const { validateHit } = require('./validate');
const { geminiAvailable, geminiJson } = require('./gemini');

// Gemini で1ページ本文から採用担当者を抽出（生レスポンス）
async function geminiExtractRecruiter(text, company, c = cfg) {
  const prompt =
    '次のWebページ本文から、企業「' + (company.name || '') + '」の採用・人事の担当者を最大1名だけ厳密に抽出しJSON出力。\n' +
    '条件: 実在の個人名のみ（会社名・部署名だけは不可）。役職または部署が採用/人事/HR/新卒/中途/タレント等に関連すること。\n' +
    '該当が無ければ {"found": false} を返す。\n' +
    '出力キー: found(bool), name(string), title(string), department(string), snippet(string 根拠20〜60字), confidence(0〜1)\n' +
    '本文:\n' + String(text || '').slice(0, c.MAX_TEXT_CHARS || 8000);
  const j = await geminiJson(prompt, { maxTokens: 400, temperature: 0.1 }, c);
  if (!j || !j.found) return null;
  return j;
}

// Gemini の生レスポンスを extract.js 互換の ext 形へ
function geminiToExt(j) {
  return {
    found: true,
    name: j.name || '',
    role: j.title || '',
    department: j.department || '',
    evidence: j.snippet || '',
    confidence: Number(j.confidence || 0),
    engine: 'gemini',
  };
}

/**
 * 1ページの本文から採用担当者を抽出し、検証ゲートを通れば確定オブジェクトを返す。
 * @param {string} text ページ可視テキスト
 * @param {{name:string}} company
 * @returns {Promise<{name,role,department,evidence,confidence,engine}|null>}
 */
async function extractRecruiterFromText(text, company, c = cfg) {
  if (!text || text.length < 40) return null;

  let ext;
  if (geminiAvailable(c)) {
    const j = await geminiExtractRecruiter(text, company, c);
    ext = j ? geminiToExt(j) : { found: false, engine: 'gemini' };
  } else {
    // extractContact は非同期（OLLAMA_URL 設定時はローカルLLM、無ければ正規表現＋人名判定）
    ext = await extractContact({ text, companyName: company.name });
  }

  const v = validateHit(ext, { threshold: c.SCORE_THRESHOLD, roleKeywords: c.ROLE_KEYWORDS });
  if (!v.hit) return null;
  return {
    name: ext.name,
    role: ext.role || '',
    department: ext.department || '',
    evidence: String(ext.evidence || '').slice(0, 160),
    confidence: ext.confidence || 0,
    engine: ext.engine || (geminiAvailable(c) ? 'gemini' : 'heuristic'),
  };
}

module.exports = { extractRecruiterFromText, geminiExtractRecruiter, geminiToExt };
