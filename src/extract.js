'use strict';
// 採用・人事担当者の「氏名」抽出。
// ※ 外部AI API（Anthropic等）は一切使用しない。ページ本文に対する正規表現＋人名らしさ判定のみで動作する。
const cfg = require('./config');

// 人名ではない典型語（誤検出を弾くためのブロックリスト）。
// 例:「舞台裏（人事）」のような見出し語、役割語、組織語など。
const NON_NAME_WORDS = [
  '採用', '人事', '人材', '人財', '担当', '責任', '窓口', '部門', '部署', '採用担当', '人事担当',
  '舞台裏', 'チーム', 'メンバー', '社員', 'スタッフ', '全般', '各位', '募集', '情報', '広報', '総務',
  '本社', '支社', '会社', '当社', '弊社', '新卒', '中途', '代表', '事業', '管理', '営業', '経営', '企画',
  'お問', '問合', '連絡', '電話', '受付', '対応', '詳細', '一覧', '以下', '上記', '皆様', '私たち',
];

// 日本語の姓＋名らしさ（漢字またはカナ）。1〜4字＋（任意の空白）＋1〜5字。
const JP_NAME = '([\\u4e00-\\u9fa5々]{1,4}[ \\u3000]?[\\u4e00-\\u9fa5々\\u3040-\\u309f\\u30a0-\\u30ffー]{1,5})';

// 抽出した語が「人名らしい」か（役割語・組織語・ブロックリストを排除）
function looksLikePersonName(name) {
  const n = String(name || '').trim();
  if (n.length < 2) return false;
  if (NON_NAME_WORDS.some((w) => n.includes(w))) return false;
  if (cfg.ROLE_KEYWORDS.some((k) => n.toLowerCase().includes(String(k).toLowerCase()))) return false;
  // 数字・記号・URLっぽいものを除外
  if (/[0-9０-９@.\/:：、。（）()\[\]]/.test(n)) return false;
  return true;
}

/**
 * 本文から採用/人事担当者の氏名をヒューリスティック抽出する（API不要）。
 * @param {string} text ページ可視テキスト
 * @returns {{found:boolean,name:string|null,role:string|null,department:string|null,evidence:string|null,confidence:number,reason:string}}
 */
function heuristicExtract(text) {
  const patterns = [
    // 「採用担当：山田 太郎」「人事ご担当 佐藤花子」など
    { re: new RegExp('(?:採用|人事|採用ご|人事ご)(?:担当|責任者)(?:者)?\\s*[:：]?\\s*' + JP_NAME), conf: 0.7 },
    // 「担当者：山田太郎」（前後に採用/人事の文脈がある場合に採用）
    { re: new RegExp('担当者\\s*[:：]\\s*' + JP_NAME), conf: 0.62 },
    // 「山田 太郎（採用担当）」
    { re: new RegExp(JP_NAME + '\\s*[（(]\\s*(?:採用|人事)'), conf: 0.7 },
  ];
  for (const { re, conf } of patterns) {
    const m = text.match(re);
    if (m && m[1] && looksLikePersonName(m[1])) {
      const idx = text.indexOf(m[0]);
      const around = text.slice(Math.max(0, idx - 24), idx + m[0].length + 24);
      const role = (around.match(/(採用責任者|採用担当|人事担当|採用部|人事部|人事|採用)/) || [])[0] || '';
      const dept = (around.match(/([一-龥]{2,6}部)/) || [])[0] || '';
      return { found: true, name: m[1].trim(), role, department: dept, evidence: m[0].trim(), confidence: conf, reason: 'heuristic pattern match' };
    }
  }
  return { found: false, name: null, role: null, department: null, evidence: null, confidence: 0, reason: 'no pattern matched (heuristic)' };
}

/**
 * 本文から採用担当者を抽出（ヒューリスティックのみ・外部API不使用）。
 * @param {{text:string, companyName?:string}} opts
 * @returns {object} 抽出結果（+ engine フィールド）
 */
function extractContact({ text }) {
  return Object.assign({ engine: 'heuristic' }, heuristicExtract(text));
}

module.exports = { extractContact, heuristicExtract, looksLikePersonName };
