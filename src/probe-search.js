'use strict';
// 採用担当者名プローブ②：検索ファースト（ソース横断・APIキー不要）。
//  自社採用ページは大手ほど個人名を出さない（実測: この母集団で歩留まり≒0）。そこで母集団に依存せず、
//  「会社名 × 採用担当」等で web 検索し、ヒットした note / X / Wantedly / プレスリリース / 求人媒体 / 自社
//  などソースを問わず、検索スニペット（title+snippet）に氏名抽出器を当てる。多くは名乗り
//  （「採用担当の○○です」）がスニペットに出るため、ページ取得せずに拾える＝高速・軽量。
//  スニペットで取れない時だけ上位ページ本文を少数だけ取得して再抽出する。
//  抽出は probe-recruit-page.js の extractFromRecruitText（採用ページ特化パターン＋姓辞書ゲート）を共用。
const { runSearch } = require('./search');
const { extractFromRecruitText, visibleText } = require('./probe-recruit-page');
const { politeGet } = require('./polite');

// ソース横断のクエリ（上ほど個人名が出やすい）。会社名は引用符で固有名詞化。
function buildQueries(company) {
  const n = `"${company}"`;
  return [
    `${n} 採用担当 ご挨拶`,            // 自社/媒体の採用担当メッセージ
    `${n} 採用 note 人事`,            // note の採用広報（自己名乗りが濃い）
    `${n} 採用担当 (twitter OR X)`,    // SNS発信
    `${n} 人事 採用担当者`,            // 汎用（媒体/プレス/求人）
  ];
}

// 検索結果1件の素性からソース種別ラベルを推定（KPI帰属・確度調整に使う）
function sourceLabel(domain) {
  const d = String(domain || '').toLowerCase();
  if (d.includes('note.com')) return 'note(採用広報)';
  if (d.includes('twitter.com') || d === 'x.com') return 'X/Twitter';
  if (d.includes('wantedly.com')) return 'Wantedly';
  if (d.includes('prtimes.jp') || d.includes('atpress.ne.jp')) return 'プレスリリース';
  if (/(mynavi|rikunabi|en-japan|doda|type\.jp|green-japan|onecareer|engage)/.test(d)) return 'ナビ系媒体';
  if (d.includes('linkedin.com')) return 'LinkedIn';
  return '検索ヒット(自社等)';
}

// 検索スニペット群（横断）に抽出器を当て、最初の確定HITを返す。
//  opt.fetchPages>0 のとき、スニペットで取れなければ上位ページ本文も取得して再抽出。
async function probeSearch(company, opt = {}) {
  const fetchPages = opt.fetchPages || 0;
  const maxCand = opt.maxCandidates || 8;
  if (!company || !company.trim()) return null;

  const seen = new Set();
  for (const q of buildQueries(company)) {
    let cands;
    try { cands = await runSearch(q); } catch (_) { continue; }
    if (!cands || !cands.length) continue;
    const top = cands.slice(0, maxCand);

    // (1) スニペット抽出（ページ取得なし）。1件ずつ当て、ソースURLを根拠に残す。
    for (const c of top) {
      const text = `${c.title || ''}。${c.snippet || ''}`;
      const hit = extractFromRecruitText(text);
      if (hit) {
        return {
          name: hit.name, role: hit.role || '', department: hit.department || '',
          confidence: Math.min(0.9, hit.confidence + 0.04), // 検索ヒット＝独立ソースで微加点
          evidence: hit.evidence, sourceUrl: c.url, source: sourceLabel(c.domain), via: 'snippet', query: q,
        };
      }
    }

    // (2) スニペットで取れない時だけ、上位の有望ソースを少数ページ取得して本文抽出
    if (fetchPages > 0) {
      const promising = top.filter((c) => sourceLabel(c.domain) !== '検索ヒット(自社等)').slice(0, fetchPages);
      for (const c of promising) {
        if (seen.has(c.url)) continue; seen.add(c.url);
        const r = await politeGet(c.url, { render: 'static' });
        if (!r || r.blocked || r.error || !r.html) continue;
        const hit = extractFromRecruitText(visibleText(r.html));
        if (hit) {
          return {
            name: hit.name, role: hit.role || '', department: hit.department || '',
            confidence: hit.confidence, evidence: hit.evidence,
            sourceUrl: c.url, source: sourceLabel(c.domain), via: 'page', query: q,
          };
        }
      }
    }
  }
  return null;
}

module.exports = { probeSearch, buildQueries, sourceLabel };
