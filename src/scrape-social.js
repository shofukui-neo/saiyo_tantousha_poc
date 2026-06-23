'use strict';
// 採用SNS／LinkedIn 経由の採用担当者「個人名」取得アダプタ。
//
// 設計（recruiter-name-segment-finding / name-acquisition-layer の続き）:
//   中堅〜大手は自社採用ページに個人名を出さない（母集団問題）。個人名が公開で出るのは
//   ①採用広報が活発なSNS（Wantedly/YOUTRUST/note 等）と ②本人がプロフィールを公開する LinkedIn。
//   この層はそこを「社名＋採用/人事ロール」で検索し、検索結果タイトル＝氏名から個人名を拾う。
//
// 方針（既存層と同じ精度優先）:
//   - 検索は search.js の SERP 取得（Bing/DuckDuckGo・キー不要）を再利用。連続クエリは SEARCH_DELAY_MS で礼節を保つ。
//   - 氏名の確定は jp-names.js(姓辞書) と extract.js(人名判定) を再利用。辞書で検証できないトークンは氏名にしない。
//   - 会社一致を必須化（タイトル/スニペットに社名コアが出ること）。全文検索の無関係ヒットを攻撃面から排除する。
//   - LinkedIn 本体は robots/ログイン壁で直接巡回しない（規約遵守）。あくまで公開された検索結果タイトルのみを使う。
//   - 深掘りが要る媒体（note 等）のページ取得は polite.js 経由（robots遵守・レート制限・キャッシュ）。
const cheerio = require('cheerio');
const { runSearch } = require('./search');
const { politeGet } = require('./polite');
const { normCompanyName } = require('./csv');
const cfg = require('./config');
// firstFullName/namesMatch は scrape-names.js に既存（姓辞書検証つき）。循環参照回避のため遅延 require。
function names() { return require('./scrape-names'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 役割語（採用/人事/recruiter 等）が文字列に出るか。config.ROLE_KEYWORDS を再利用。
const ROLE_RE = new RegExp('(' + cfg.ROLE_KEYWORDS
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i');
function roleHit(text) {
  const m = String(text || '').match(ROLE_RE);
  return m ? m[1] : '';
}

// SNS/検索結果タイトルを区切り文字でセグメント化する。
// 例: "山田 太郎 - 株式会社サンプル 採用担当 | LinkedIn" -> ["山田 太郎","株式会社サンプル 採用担当","LinkedIn"]
function splitTitleSegments(title) {
  return String(title || '')
    .split(/\s*(?:[-–—｜|·•:：･・]|\/)\s*/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// 媒体ブランド語（タイトル末尾に付く媒体名）。氏名/社名セグメントと取り違えないため除外する。
const BRAND_WORDS = /^(LinkedIn|Wantedly|note|YOUTRUST|Green|グリーン|Eight|Facebook|X|Twitter|Instagram|プロフィール|Profile)$/i;

// 検索結果1件（{title, snippet, url, domain}）から、対象社の採用担当者氏名を抽出する。
//   1) タイトルをセグメント化し、媒体ブランド語を除去
//   2) 先頭セグメント→残りセグメントの順に firstFullName（姓辞書で厳密検証）で氏名を探す
//   3) 会社一致を必須化（セグメント or タイトル+スニペットに社名コアが出ること）
//   4) 役割語（任意・既定必須）を確認し役職に採る
// 戻り値: { name, role, company, where, confidence } | null
function extractNameFromResult(result, targetName, { requireRole = true } = {}) {
  const { firstFullName, namesMatch } = names();
  const { pageMatchesCompany } = require('./search');
  const title = result.title || '';
  const snippet = result.snippet || '';
  const segs = splitTitleSegments(title).filter((s) => !BRAND_WORDS.test(s));
  if (!segs.length) return null;

  // (1) 氏名: 先頭セグメントを最優先（プロフィール系タイトルは「氏名 - 所属 - 役職」順）。
  //     先頭で取れなければ後続セグメントも姓辞書で検証して拾う（順序揺れの保険）。
  let name = '';
  let nameSegIdx = -1;
  for (let i = 0; i < segs.length; i++) {
    const fn = firstFullName(segs[i]);
    if (fn) { name = fn; nameSegIdx = i; break; }
  }
  if (!name) return null;

  // (2) 会社一致: 氏名セグメント以外のセグメント、無ければタイトル+スニペット全体で社名コアを確認。
  const target = normCompanyName(targetName);
  let companyMatched = false;
  let companySeg = '';
  for (let i = 0; i < segs.length; i++) {
    if (i === nameSegIdx) continue;
    if (target && namesMatch(segs[i], targetName)) { companyMatched = true; companySeg = segs[i]; break; }
  }
  if (!companyMatched && pageMatchesCompany(targetName, title, snippet)) companyMatched = true;
  if (!companyMatched) return null; // 会社が確認できない氏名は出さない（誤帰属を排除）

  // (3) 役割語（採用/人事/recruiter 等）。タイトル+スニペットから拾う。
  const role = roleHit(title) || roleHit(snippet);
  if (requireRole && !role) return null;

  // (4) 確度: 先頭セグメント氏名＋会社一致＋役割で高め、後続セグメント氏名や役割欠落で減算。
  let confidence = 0.5;
  if (nameSegIdx === 0) confidence += 0.05;
  if (companySeg) confidence += 0.05;      // 社名が独立セグメントで明示
  if (role) confidence += 0.05;
  return { name, role: role || '', company: companySeg || targetName, where: 'serp', confidence: Math.min(0.7, confidence) };
}

// SERP を社名×ロールで引き、対象ドメインに絞って氏名を抽出する汎用ルーチン。
//   queries  検索クエリ配列（site: 制約つき）
//   domains  この媒体として採用するドメイン（result.domain が後方一致）
// 戻り値: { hit:{name,role,url,confidence}|null, status:string, scanned:number }
async function serpHarvest(companyName, { queries, domains, requireRole = true, maxResults = 8 } = {}) {
  let scanned = 0;
  let sawDomain = false;
  for (const q of queries) {
    let results;
    try {
      results = await runSearch(q);
    } catch (e) {
      await sleep(cfg.SEARCH_DELAY_MS);
      continue; // 次のクエリへ（1クエリの失敗で媒体ごと諦めない）
    }
    for (const r of (results || []).slice(0, maxResults)) {
      const dom = r.domain || '';
      if (domains && domains.length && !domains.some((d) => dom === d || dom.endsWith('.' + d))) continue;
      sawDomain = true;
      scanned++;
      const got = extractNameFromResult(r, companyName, { requireRole });
      if (got) {
        return { hit: { name: got.name, role: got.role, url: r.url, confidence: got.confidence }, status: 'hit', scanned };
      }
    }
    await sleep(cfg.SEARCH_DELAY_MS); // 検索エンジンへの礼節
  }
  return { hit: null, status: sawDomain ? 'no-name' : 'no-result', scanned };
}

// =====================================================================
// LinkedIn 経由（公開プロフィールの検索結果タイトル＝「氏名 - 所属 - 役職」を利用）
// =====================================================================
// robots/ログインの都合で本体は巡回しない。検索エンジンに出る公開タイトルのみを使う。
async function findRecruiterLinkedIn(companyName, opts = {}) {
  const detail = {};
  // ※ site: 演算子はBingのHTMLエンドポイントで無効化される（実測0件）。ドメイン名をキーワードに混ぜ、
  //    結果を linkedin.com に後方一致フィルタする方式に統一（実エンジンがLinkedInを返せば拾える）。
  //    現実には LinkedIn はログイン壁で検索エンジンに露出しにくい（母集団問題）。低歩留まりは仕様。
  const queries = [
    `${companyName} 採用 人事 LinkedIn`,
    `${companyName} recruiter "talent acquisition" linkedin.com`,
  ];
  const { hit, status } = await serpHarvest(companyName, {
    queries, domains: ['linkedin.com'], requireRole: true,
  });
  detail['LinkedIn'] = hit ? 'hit' : status;
  if (hit) {
    return {
      採用担当者名: hit.name, 役職: hit.role || '', 部署: '',
      取得元媒体: 'LinkedIn', 根拠URL: hit.url, 確度: hit.confidence, 詳細: detail,
    };
  }
  return { 採用担当者名: '', 役職: '', 部署: '', 取得元媒体: '', 根拠URL: '', 確度: 0, 詳細: detail };
}

// =====================================================================
// 採用SNS 経由（Wantedly/YOUTRUST/note 等。氏名が公開で出る媒体を社名×採用で横断検索）
// =====================================================================
// 媒体ごと: domain=採用判定/抽出対象ドメイン、roleRequired=役割語必須か（広報投稿は役割語が無いことがある）。
// query は site: を使わずドメイン名をキーワードに混ぜる（Bing HTML が site: を無効化するため）。
// 取得後 domains で後方一致フィルタして媒体を確定する。
const SOCIAL_SOURCES = [
  // Wantedly: 募集の投稿者＝採用窓口。build-names の直接DOMアダプタ（core）と相補。
  { name: 'Wantedly', domains: ['wantedly.com'], roleRequired: false,
    query: (n) => `${n} 採用 募集 wantedly` },
  // YOUTRUST: キャリアSNS。プロフィール/投稿に実名が出る。タイトルは「氏名｜所属」形式が多い。
  { name: 'YOUTRUST', domains: ['youtrust.jp'], roleRequired: false,
    query: (n) => `${n} 採用 メンバー youtrust` },
  // note: 企業の採用広報記事。著者名が実名のことがある（採用note）。
  { name: 'note', domains: ['note.com'], roleRequired: false,
    query: (n) => `${n} 採用 note` },
  // Green: 求人媒体だが面接官/担当者名が出る募集がある（experimental）。
  { name: 'Green', domains: ['green-japan.com'], roleRequired: true, experimental: true,
    query: (n) => `${n} 採用担当 面接官 green-japan` },
];

async function findRecruiterSocial(companyName, opts = {}) {
  const includeExperimental = !!opts.includeExperimental;
  const detail = {};
  for (const src of SOCIAL_SOURCES) {
    if (src.experimental && !includeExperimental) { detail[src.name] = 'skip(experimental)'; continue; }
    const { hit, status } = await serpHarvest(companyName, {
      queries: [src.query(companyName)], domains: src.domains, requireRole: src.roleRequired,
    });
    detail[src.name] = hit ? 'hit' : status;
    if (hit) {
      return {
        採用担当者名: hit.name, 役職: hit.role || '', 部署: '',
        取得元媒体: src.name, 根拠URL: hit.url, 確度: hit.confidence, 詳細: detail,
      };
    }
  }
  return { 採用担当者名: '', 役職: '', 部署: '', 取得元媒体: '', 根拠URL: '', 確度: 0, 詳細: detail };
}

module.exports = {
  findRecruiterLinkedIn, findRecruiterSocial,
  // テスト用に公開（ネットワーク不要の純ロジック）
  splitTitleSegments, extractNameFromResult, roleHit, serpHarvest, SOCIAL_SOURCES,
};
