'use strict';
// アプローチ禁止リスト（社名テキスト）の索引化と突合 — 共有部品。
//   exclude-ng.js（除外専用）と dedupe-approach.js（3リスト統合照合）で共用する。
//
//   突合キーは csv.js の normCompanyName と同一 ＝ 法人格(株式会社/有限会社…)・
//   全半角・記号・空白の揺れを吸収した「素の社名」。法人番号は使わない
//   （禁止リストに番号が無く、要望は「同名をはじく」ため）。
//
//   旧社名表記も展開してキー化する（現社名・旧社名どちらが載っていても捕捉）:
//     （旧：株式会社○○） / （旧社名：…） / ※旧社名：…

const { normCompanyName, toHalfWidth, CORP_FORMS } = require('./csv');

// 法人格の付き位置: 'pre'(前株) / 'post'(後株) / 'none'(法人格なし or 中間)
function corpPos(name) {
  const s = toHalfWidth(name).trim().replace(/[㈱㈲㈳㈿]/g, '');
  for (const f of CORP_FORMS) {     // 配列は長い法人格が先（医療法人社団→医療法人）
    if (s.startsWith(f)) return 'pre';
    if (s.endsWith(f)) return 'post';
  }
  return 'none';
}

// 1行から「社名候補」を全部取り出す（現社名＋旧社名）。
// 旧社名は （旧：…）/（旧社名：…）/※旧社名：… 形式を抽出し、本体からは取り除く。
function namesFromLine(rawLine) {
  let s = String(rawLine || '').replace(/^﻿/, '').trim();
  // 行頭/行末の囲みダブルクォート（CSVセル貼り付け対応）
  s = s.replace(/^"+/, '').replace(/"+$/, '').trim();
  if (!s) return [];
  const out = [];

  const oldPatterns = [
    /[（(]\s*旧[：:]\s*([^（）()]+?)\s*[)）]/g,        // （旧：○○）
    /[（(]\s*旧社名[：:]\s*([^（）()]+?)\s*[)）]/g,     // （旧社名：○○）
    /※\s*旧社名[：:]\s*(.+)$/g,                        // ※旧社名：○○
  ];
  for (const re of oldPatterns) {
    let m;
    while ((m = re.exec(s)) !== null) { if (m[1]) out.push(m[1].trim()); }
  }
  let main = s
    .replace(/[（(]\s*旧[：:][^（）()]*[)）]/g, '')
    .replace(/[（(]\s*旧社名[：:][^（）()]*[)）]/g, '')
    .replace(/※\s*旧社名[：:].*$/g, '')
    .trim();
  if (main) out.push(main);
  return out.filter(Boolean);
}

// 禁止リストのテキスト全体 → 索引。
//   byKey: 正規化社名 -> { display:代表表示名, posSet:法人格位置の集合 }
function buildNgIndex(text) {
  const byKey = new Map();
  let rawNames = 0;
  for (const line of String(text).split(/\r?\n/)) {
    for (const nm of namesFromLine(line)) {
      rawNames++;
      const key = normCompanyName(nm);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, { display: nm, posSet: new Set() });
      byKey.get(key).posSet.add(corpPos(nm));
    }
  }
  return { byKey, rawNames };
}

// 対象1行が禁止と一致して「除外すべき」か → 一致エントリ or null。
//   除外: 正規化社名が一致 かつ (位置判定を無視 OR 対象が法人格なし
//         OR 禁止側に同位置の表記がある OR 禁止側に法人格なし表記がある)
//   残す: 正規化社名は一致するが、法人格が前後逆で禁止側に同位置が無い（別法人扱い）
function ngHit(name, ng, opts = {}) {
  const ignorePos = !!opts.ignorePos;
  const key = normCompanyName(name);
  if (!key || !ng.byKey.has(key)) return null;
  const entry = ng.byKey.get(key);
  if (ignorePos) return entry;
  const tPos = corpPos(name);
  if (tPos === 'none' || entry.posSet.has('none') || entry.posSet.has(tPos)) return entry;
  return null; // 前後逆 → 別法人として残す
}

module.exports = { corpPos, namesFromLine, buildNgIndex, ngHit };
