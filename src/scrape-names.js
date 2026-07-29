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
const { isFullName, splitName, stripNonName, completeSurname, normalizeNameKanji } = require('./jp-names');
const { heuristicExtract, looksLikePersonName } = require('./extract');

// 取得モード。既定 'static'（plain HTTP・Chromium不使用＝低メモリ）。
// JS描画が必要な媒体（Wantedly等）は NAMES_RENDER=auto で Playwright 描画にエスカレーションできるが、
// chromium 同時起動はメモリを食うため build-names 側は並列1を推奨。
const RENDER = process.env.NAMES_RENDER === 'auto' ? 'auto' : 'static';

// 文字列中から最初の「姓＋名（フルネーム）」を取り出す。
// 例: "山田 太郎 | 人事担当" -> "山田太郎"。姓辞書で検証できなければ null。
function firstFullName(str) {
  // 異体字を標準化（小松﨑→小松崎）。﨑等は基本漢字範囲外で字種分割を壊すため、分割前に正規化する。
  // 続けて役割語/役職/地名を剥がす（「田中花子採用担当」→「田中花子」/「関東支店」→「」/「中村課長」→「中村」）。
  const s = stripNonName(normalizeNameKanji(String(str || '')));
  // 日本語人名に使える字種（漢字・かな・長音・区切り空白）以外で分割
  const runs = s.split(/[^一-龥々぀-ゟ゠-ヿー 　]+/);
  for (const run of runs) {
    const t = run.trim();
    if (!t) continue;
    const compact = t.replace(/[ 　]/g, '');
    if (!compact) continue;
    // 「山田太郎」連結 もしくは「山田 太郎」分かち書き の両方を許容
    if (isFullName(compact)) return compact;
    if (isFullName(t)) return compact;
    // 名が長すぎる場合は先頭1-2字に詰めて再検証（肩書き連結の保険。一般的な名は1-2字、3字は最後）
    const sp = splitName(compact);
    if (sp && sp.mei) {
      for (const n of [2, 1, 3]) {
        const cand = sp.sei + sp.mei.slice(0, n);
        if (isFullName(cand)) return cand;
      }
    }
    // 名を伴わない単独姓は辞書完全一致のみ採用（中村/小田=採用、地名片 関東/中央=不採用）
    const sur = completeSurname(compact);
    if (sur) return sur;
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

  // (1) 投稿者/担当者セレクタ（媒体の構造化された投稿者名＝最も確実）。本文ヒューリスティックより優先する。
  //   ※本文を先に見ると、募集説明文の「採用担当 ○○ 小学…」等のノイズが正しい投稿者名を上書きしてしまう
  //     （実例: 大畑健小学/鈴木その他/上田これ ← 真の投稿者は 大畑健/萩原勇輝/黒澤一男）。
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

  // (2) 採用文脈つきの氏名（本文ヒューリスティック）。セレクタが無い/取れない場合のフォールバック。
  //   辞書フルネームで厳密検証（役職/助詞が混じる貪欲一致は不採用＝精度優先）。
  const text = $('body').text().replace(/\s+/g, ' ');
  const h = heuristicExtract(text);
  if (h.found && isFullName(String(h.name).replace(/[ 　]/g, ''))) {
    return {
      name: String(h.name).replace(/[ 　]/g, ''),
      role: h.role || '', department: h.department || '',
      confidence: h.confidence, where: 'context',
    };
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
    // 募集一覧（projects）を社名で検索。SSRで募集カードが返り、各募集ページに投稿者の個人名が載る。
    // ※ 全文検索のため対象社と無関係な人気募集も混じる → companySel で会社一致を必須化する。
    searchUrl: (name) => `https://www.wantedly.com/projects?q=${encodeURIComponent(name)}`,
    detailSel: ['a[href*="/projects/"]'],
    // 募集ページのメンバー氏名。FocusedMemberName＝募集の投稿者(＝採用窓口)を最優先する。
    // 実DOM検証: 各募集に3-12名のメンバーが載るが、先頭のFocused名が投稿者。明示優先でDOM順依存を排除。
    // （実キャッシュ4963件で MemberName先頭 と FocusedMemberName は完全一致を確認済み＝出力不変・堅牢化）
    authorSel: ['[class*="FocusedMemberName"]', '[class*="MemberName"]', '[class*="UserName"]', '[data-testid*="user"]'],
    // 募集ページ上の掲載企業（会社一致の判定に使う）
    companySel: ['a[href*="/companies/"]'],
    // 全文検索は社名スコープでなく上位が変動するため、一致する募集を取りこぼさない範囲で深めに探す
    maxDetails: 5,
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

// 正規化社名どうしのゆるい一致（どちらかが他方を包含＝表記揺れ・部署付きを許容）。
function namesMatch(a, b) {
  const x = normCompanyName(a), y = normCompanyName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// 詳細ページの掲載企業名（companySel の最初の非空テキスト）。
function companyOnPage($, selectors) {
  for (const sel of selectors) {
    let name = '';
    $(sel).each((_, el) => {
      if (name) return;
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && t.length <= 60) name = t;
    });
    if (name) return name;
  }
  return '';
}

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
    const sr = await politeGet(sUrl, { render: RENDER });
    if (!sr || sr.blocked || sr.error || !sr.html) {
      detail[ad.name] = sr && sr.blocked ? 'blocked(robots)' : 'search-failed';
      continue;
    }
    // 2) 詳細ページ候補
    const urls = pickDetailUrls(sr.html, sr.finalUrl || sUrl, ad.detailSel, companyName, ad.maxDetails);
    if (!urls.length) { detail[ad.name] = 'no-detail'; continue; }
    // 3) 各詳細から個人名抽出（会社一致を必須化）
    const target = normCompanyName(companyName);
    let any = false, mismatch = false, noname = false;
    for (const u of urls) {
      const dr = await politeGet(u, { render: RENDER });
      if (!dr || dr.blocked || dr.error || !dr.html) continue;
      any = true;
      const $d = cheerio.load(dr.html);
      // 募集ページの掲載企業が対象社と一致するか（全文検索の無関係ヒットを排除）
      if (ad.companySel && target) {
        const pageCompany = companyOnPage($d, ad.companySel);
        if (pageCompany && !namesMatch(pageCompany, target)) { mismatch = true; continue; }
      }
      const got = extractPersonName(dr.html, { authorSel: ad.authorSel });
      if (got) {
        detail[ad.name] = 'hit';
        return {
          採用担当者名: got.name, 役職: got.role || '', 部署: got.department || '',
          取得元媒体: ad.name, 根拠URL: u, 確度: got.confidence, 詳細: detail,
        };
      }
      noname = true;
    }
    detail[ad.name] = !any ? 'detail-failed' : (noname ? 'no-name' : (mismatch ? 'company-mismatch' : 'no-detail'));
  }
  return { 採用担当者名: '', 役職: '', 部署: '', 取得元媒体: '', 根拠URL: '', 確度: 0, 詳細: detail };
}

// 媒体DOM・採用SNS・LinkedIn を横断して採用担当者の個人名を探す統合ルーチン。
// チャネル優先順 media → sns → linkedin（mediaはキャッシュ効きやすく低コスト、SNS/LinkedInは検索負荷が高い）。
// 先に確証の取れたチャネルで打ち切り、根拠URL・取得元媒体・チャネルを刻んで返す。
//   channels: ['media','sns','linkedin'] のサブセット（既定=全部）
//   戻り値: findRecruiterName と同形 ＋ チャネル
async function findRecruiterAllChannels(companyName, opts = {}) {
  const channels = (opts.channels && opts.channels.length) ? opts.channels : ['media', 'sns', 'linkedin'];
  const detail = {};
  const empty = { 採用担当者名: '', 役職: '', 部署: '', 取得元媒体: '', 根拠URL: '', 確度: 0 };

  if (channels.includes('media')) {
    const r = await findRecruiterName(companyName, { includeExperimental: opts.includeExperimental });
    Object.assign(detail, r.詳細);
    if (r.採用担当者名) return { ...r, 詳細: detail, チャネル: 'media' };
  }
  // SNS/LinkedIn は遅延 require（scrape-social が firstFullName 等で本モジュールを参照する循環を回避）。
  const social = require('./scrape-social');
  if (channels.includes('sns')) {
    const r = await social.findRecruiterSocial(companyName, opts);
    Object.assign(detail, r.詳細);
    if (r.採用担当者名) return { ...r, 詳細: detail, チャネル: 'sns' };
  }
  if (channels.includes('linkedin')) {
    const r = await social.findRecruiterLinkedIn(companyName, opts);
    Object.assign(detail, r.詳細);
    if (r.採用担当者名) return { ...r, 詳細: detail, チャネル: 'linkedin' };
  }
  return { ...empty, 詳細: detail, チャネル: '' };
}

module.exports = {
  findRecruiterName, findRecruiterAllChannels, extractPersonName, firstFullName, pickDetailUrls,
  namesMatch, companyOnPage, NAME_ADAPTERS,
};
