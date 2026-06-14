'use strict';
// 採用担当者「個人名」取得アダプタ（Wantedly / ハローワーク）。
//
// 設計（recruiter-name-segment-finding の続き）:
//   この1000件(gBiz中堅〜大手)は自社採用ページ／メールに個人名を出さない。
//   個人名が公開で出るのは「採用広報が活発な媒体」= Wantedly 等。そこを社名で引いて拾う。
//
// 方針:
//   - 取得は全て polite.js 経由（robots遵守・ホスト別レート制限・ディスクキャッシュ）。
//   - 氏名の確定は jp-names.js(姓辞書+isFullName) と extract.js(採用文脈の正規表現) を再利用。
//     => 精度優先。姓辞書で検証できないトークンは人名にしない（誤った氏名を出すより取りこぼす）。
//   - 各サイトはJS描画・DOM変更が頻繁なため SELECTOR は「現状の推定値」。実DOMで calibrate 前提。
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { normCompanyName } = require('./csv');
const { isFullName, splitName } = require('./jp-names');
const { heuristicExtract, looksLikePersonName } = require('./extract');

// 文字列中から最初の「姓＋名（フルネーム）」を取り出す。
// 例: "山田 太郎 | 人事担当" -> "山田太郎"。姓辞書で検証できなければ null。
function firstFullName(str) {
  const s = String(str || '');
  // 日本語人名に使える字種（漢字・かな・長音・区切り空白）以外で分割
  const runs = s.split(/[^一-龥々぀-ゟ゠-ヿー 　]+/);
  for (const run of runs) {
    const t = run.trim();
    if (!t) continue;
    const compact = t.replace(/[ 　]/g, '');
    // 「山田太郎」連結 もしくは「山田 太郎」分かち書き の両方を許容
    if (isFullName(compact)) return compact;
    if (isFullName(t)) return compact;
    // 長い行は先頭の姓+名(最大5字)だけ切り出して再判定（肩書き連結への保険）
    const sp = splitName(compact);
    if (sp && sp.mei) {
      const cand = sp.sei + sp.mei.slice(0, 3);
      if (isFullName(cand)) return cand;
    }
  }
  return null;
}

// ページHTMLから採用担当者の個人名を1件抽出する。
//  1) 採用文脈の正規表現（extract.heuristicExtract）— 「採用担当：山田太郎」等を高確度で拾う
//  2) author/poster セレクタのテキストから firstFullName（媒体の投稿者名は文脈語を伴わないため）
//  3) いずれも姓辞書(isFullName)で最終検証。確証なしは返さない。
// 戻り値: { name, role, department, confidence, where } | null
function extractPersonName(html, { authorSel = [] } = {}) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ');

  // (1) 採用文脈つきの氏名（最も確実）
  const h = heuristicExtract(text);
  if (h.found && isFullName(String(h.name).replace(/[ 　]/g, ''))) {
    return {
      name: String(h.name).replace(/[ 　]/g, ''),
      role: h.role || '', department: h.department || '',
      confidence: h.confidence, where: 'context',
    };
  }

  // (2) 投稿者/担当者セレクタ（媒体特有。文脈語を伴わない個人名）
  for (const sel of authorSel) {
    let hit = null;
    $(sel).each((_, el) => {
      if (hit) return;
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (!t) return;
      const fn = firstFullName(t);
      if (fn && looksLikePersonName(fn)) hit = fn;
    });
    if (hit) return { name: hit, role: '', department: '', confidence: 0.5, where: 'author' };
  }

  return null;
}

// =====================================================================
// アダプタ定義
// =====================================================================
// 各アダプタ:
//   name        媒体名（取得元媒体としてCSVに刻む）
//   searchUrl   社名 -> 検索URL
//   detailSel   検索結果から詳細(募集/求人票)ページのリンクを拾うセレクタ群
//   authorSel   詳細ページで投稿者/担当者の個人名が入りうるセレクタ群
//   maxDetails  1社あたり開く詳細ページ数の上限（負荷・時間の抑制）
//   experimental 実セッション/較正が必要で本番投入前の枠であることを示す
const NAME_ADAPTERS = [
  {
    name: 'Wantedly',
    // 募集（projects）を社名で検索。投稿者の個人名が出やすい。
    searchUrl: (name) => `https://www.wantedly.com/search?q=${encodeURIComponent(name)}&type=projects`,
    detailSel: ['a[href*="/projects/"]', 'a[href*="/companies/"]'],
    // 投稿者名・メンバー名が入りうる箇所（要較正）
    authorSel: ['[class*="UserName"]', '[class*="user_name"]', '[class*="MemberName"]',
      '[data-testid*="user"]', 'a[href*="/id/"]', '.wt-text-body-1'],
    maxDetails: 2,
    experimental: false,
  },
  {
    name: 'ハローワーク',
    // 公的求人。低リスクだが現行ネットサービスはJSF(ViewState付きセッション)でGET検索が成立しにくい。
    // ここでは事業所名検索の入口URLを置き、実運用ではセッション/フォーム遷移の較正が必要（experimental）。
    // robots禁止ならpoliteGetがblockedで返し、build側がスキップ＝ゴミを流さない。
    searchUrl: (name) => `https://www.hellowork.mhlw.go.jp/kensaku/GECA110010.do?screenId=GECA110010&action=initDisp&jigyoshoMei=${encodeURIComponent(name)}`,
    detailSel: ['a[href*="GECA"]', 'a[href*="kyujin"]'],
    // 求人票の「応募・選考」担当者欄（多くは係名止まりで個人名は限定的）
    authorSel: ['td', '.tantousha', '[class*="tantou"]'],
    maxDetails: 1,
    experimental: true,
  },
];

// 検索結果HTMLから、対象社名に一致しそうな詳細ページURLを集める。
function pickDetailUrls(html, baseUrl, selectors, targetName, max) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html);
  const target = normCompanyName(targetName);
  const urls = [];
  const seen = new Set();
  for (const sel of selectors) {
    $(sel).each((_, a) => {
      if (urls.length >= max) return;
      const href = $(a).attr('href');
      if (!href) return;
      let u;
      try { u = new URL(href, base); } catch { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      u.hash = '';
      const key = u.toString();
      if (seen.has(key)) return;
      seen.add(key);
      urls.push(key);
    });
    if (urls.length) break; // 最初に当たったセレクタ群を採用
  }
  return urls.slice(0, max);
}

// 1企業について全アダプタを回し、最初に確証の取れた個人名を返す。
// 戻り値: { 採用担当者名, 役職, 部署, 取得元媒体, 根拠URL, 確度, 詳細:{media:status} }
async function findRecruiterName(companyName, { adapters = NAME_ADAPTERS, includeExperimental = false } = {}) {
  const detail = {};
  for (const ad of adapters) {
    if (ad.experimental && !includeExperimental) { detail[ad.name] = 'skip(experimental)'; continue; }
    // 1) 検索
    const sUrl = ad.searchUrl(companyName);
    const sr = await politeGet(sUrl);
    if (!sr || sr.blocked || sr.error || !sr.html) {
      detail[ad.name] = sr && sr.blocked ? 'blocked(robots)' : 'search-failed';
      continue;
    }
    // 2) 詳細ページ候補
    const urls = pickDetailUrls(sr.html, sr.finalUrl || sUrl, ad.detailSel, companyName, ad.maxDetails);
    if (!urls.length) { detail[ad.name] = 'no-detail'; continue; }
    // 3) 各詳細から個人名抽出
    let any = false;
    for (const u of urls) {
      const dr = await politeGet(u);
      if (!dr || dr.blocked || dr.error || !dr.html) continue;
      any = true;
      // 社名一致をゆるく確認（誤った会社の投稿者を拾わない）
      const target = normCompanyName(companyName);
      const pageNorm = normCompanyName(cheerio.load(dr.html)('body').text().slice(0, 4000));
      if (target && pageNorm && !pageNorm.includes(target)) { /* 一致弱いが名は文脈語で守る */ }
      const got = extractPersonName(dr.html, { authorSel: ad.authorSel });
      if (got) {
        detail[ad.name] = 'hit';
        return {
          採用担当者名: got.name, 役職: got.role || '', 部署: got.department || '',
          取得元媒体: ad.name, 根拠URL: u, 確度: got.confidence, 詳細: detail,
        };
      }
    }
    detail[ad.name] = any ? 'no-name' : 'detail-failed';
  }
  return { 採用担当者名: '', 役職: '', 部署: '', 取得元媒体: '', 根拠URL: '', 確度: 0, 詳細: detail };
}

module.exports = {
  findRecruiterName, extractPersonName, firstFullName, pickDetailUrls,
  NAME_ADAPTERS,
};
