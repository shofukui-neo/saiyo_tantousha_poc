'use strict';
// GitHub 経由の「中の人（技術者）」氏名取得。IT/Web企業に限れば、公開APIで実名が構造的に取れる。
//
// 着眼（母集団壁への新手・[[recruiter-name-segment-finding]]）:
//   採用担当の個人名は中堅大手で非公開だが、IT/Web企業は GitHub org に技術者が実名で所属する。
//   公開API（robots非対象）で org→members→user.name を辿れば、company フィールドで所属検証もできる。
//   ※ 得られるのは主に“エンジニア”であり採用担当そのものではない → 種別='技術者'として区別して出す。
//      技術職リファラル/技術広報の接点、IT企業の実在性確認、スカウト文面の具体化に使える。
//
// 認証: 無認証60req/h（共有IPだと枯渇しやすい）。GITHUB_TOKEN を置くと5000req/h。未設定でも動くが少量。
const cfg = require('./config');
const { companyCore } = require('./search');

const API = 'https://api.github.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  const h = { 'User-Agent': cfg.USER_AGENT, 'Accept': 'application/vnd.github+json' };
  const tok = process.env.GITHUB_TOKEN || '';
  if (tok) h['Authorization'] = 'Bearer ' + tok;
  return h;
}

// GitHub の Search API は core(5000/h)とは別枠で「30回/分」。org探索は search を使うため、
// ここを専用スロットルしないと 403 が多発する（実測: 未スロットルで96/125が http403）。
// 方針: /search/ 呼び出しは最小間隔を空け、残数0時は x-ratelimit-reset まで待つ。
const SEARCH_MIN_INTERVAL_MS = parseInt(process.env.GITHUB_SEARCH_INTERVAL_MS || '2200', 10); // 30/分に収める
let _searchNextAt = 0;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _now() { return Date.now(); }

// レート制限を見ながら1件GET。isSearch=true の呼び出しは search 枠を尊重して間隔調整＋reset待ち。
async function ghGet(path, { isSearch = false } = {}) {
  if (isSearch) {
    const wait = _searchNextAt - _now();
    if (wait > 0) await _sleep(wait);
  }
  try {
    const res = await fetch(API + path, { headers: headers() });
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') || '1', 10);
    const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
    if (isSearch) {
      // 次の search 可能時刻を更新（最低間隔 or 枠切れなら reset まで）。
      _searchNextAt = _now() + SEARCH_MIN_INTERVAL_MS;
      if (res.status === 403 && remaining === 0 && reset) _searchNextAt = Math.max(_searchNextAt, reset + 1000);
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, remaining, reset, json };
  } catch (e) { return { status: 0, remaining: 0, json: null, error: e.message }; }
}

// ハンドルでなく“実名らしさ”の判定。
//   - 英字2トークン（Taro Yamada）、もしくは漢字フルネーム、もしくは「姓名」を含む。
//   - 全小文字1語/数字入り/ @ 入りはハンドル扱いで除外。
function looksLikeRealName(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 40) return false;
  if (/[@_/\\]|^[a-z0-9.-]+$/.test(t) && !/\s/.test(t)) return false; // handle っぽい単一トークン
  if (/[一-龥々]/.test(t)) return t.replace(/[^一-龥々ぁ-んァ-ヶ]/g, '').length >= 2; // 日本語名
  const latin = t.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'’.-]+$/.test(w));
  return latin.length >= 2; // 英字フルネーム
}

// 公式URLのドメインから org ログイン候補を作る（cybozu.co.jp→cybozu / www.dena.com→dena）。
// 日本語社名のsearchは無力（サイボウズ株式会社→0件）なので、ドメイン起点が本命の名寄せ手段。
const TLD_LABELS = ['co', 'jp', 'com', 'ne', 'or', 'go', 'ac', 'net', 'org', 'info', 'inc', 'group', 'gr'];
// メガベンダー等の“多数の販売店/子会社が公式URLに書きがちな汎用ドメイン”。ここに解決したら対象社のorgではない。
// （実例: キタイ設計の公式URL=dell.com、イケア・ジャパン=ikea.com → Dell/IKEA本体のorgに化ける誤帰属を断つ）
const GENERIC_VENDOR_DOMAINS = new Set([
  'dell.com', 'ikea.com', 'microsoft.com', 'apple.com', 'google.com', 'amazon.com', 'amazon.co.jp',
  'oracle.com', 'sap.com', 'ibm.com', 'hp.com', 'hpe.com', 'lenovo.com', 'cisco.com', 'intel.com',
  'salesforce.com', 'adobe.com', 'yahoo.co.jp', 'rakuten.co.jp', 'shopify.com', 'wordpress.com',
  'wixsite.com', 'jimdofree.com', 'goo.ne.jp', 'ameblo.jp', 'facebook.com',
]);

// 複合SLD（これらの手前までが登録可能ドメイン）。日本企業に多い .co.jp 等を正しく畳む。
const MULTI_SLD = new Set(['co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.uk', 'org.uk', 'com.cn', 'com.au', 'co.kr', 'com.tw', 'com.hk', 'com.sg']);
// eTLD+1（登録可能ドメイン）。corp.freee.co.jp→freee.co.jp / www.cybozu.com→cybozu.com。
function etld1(url) {
  let host;
  try { host = new URL(/^https?:\/\//.test(url) ? url : 'http://' + url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
  const p = host.split('.');
  if (p.length <= 2) return host;
  return MULTI_SLD.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
function orgCandidatesFromUrl(url) {
  const reg = etld1(url);
  if (!reg || GENERIC_VENDOR_DOMAINS.has(reg)) return []; // 汎用ベンダードメインは対象社のorgでない
  const parts = reg.split('.').filter((p) => !TLD_LABELS.includes(p));
  const cands = new Set();
  if (parts.length) { cands.add(parts[parts.length - 1]); cands.add(parts[0]); cands.add(parts.join('-')); }
  return [...cands].filter((c) => /^[a-z0-9][a-z0-9-]{1,38}$/.test(c));
}

// ドメイン候補で /orgs/{login} を直接叩く（coreレート＝5000/h・search枠を消費しない）。
// 精度ゲート（precision-first）: 見つかった org の“自己申告サイト(blog)”の eTLD+1 が対象URLの eTLD+1 と
//   一致する時のみ採用。これで princeton.co.jp(日本)→github.com/princeton(米大学) の誤帰属を断つ。
//   代償: orgのblogが製品ドメインの企業（例 Cybozu=kintone.com）は取りこぼす＝誤帰属より取りこぼしを選ぶ。
// 戻り値: {org, remaining, verified} | {org:'', ...}
async function findOrgByDomain(url, { max = 3 } = {}) {
  const target = etld1(url);
  const cands = orgCandidatesFromUrl(url).slice(0, max);
  let remaining = null;
  for (const c of cands) {
    const r = await ghGet(`/orgs/${encodeURIComponent(c)}`);
    remaining = r.remaining;
    if (r.status === 200 && r.json && r.json.login) {
      const orgSite = etld1(r.json.blog || '');
      if (orgSite && target && orgSite === target) return { org: r.json.login, remaining, verified: true };
    }
    if (r.remaining <= 1) break;
  }
  return { org: '', remaining, verified: false };
}

// 会社名→org候補を検索（type:org）。company の核トークンで照合し、無関係orgを弾く。
async function findOrgs(companyName, { max = 3 } = {}) {
  const core = companyCore(companyName);
  // 英語社名やローマ字org向けに、社名そのもの＋核トークンで検索
  const q = encodeURIComponent(`${companyName} type:org`);
  let r = await ghGet(`/search/users?q=${q}&per_page=${max}`, { isSearch: true });
  // search枠切れ(403/remaining0)なら reset まで待って1回だけ再試行（_searchNextAtにreset反映済）。
  if (r.status === 403 && r.remaining === 0) {
    const wait = _searchNextAt - _now();
    if (wait > 0 && wait < 90000) { await _sleep(wait); r = await ghGet(`/search/users?q=${q}&per_page=${max}`, { isSearch: true }); }
  }
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) return { orgs: [], status: r.status === 200 ? 'no-org' : ('http' + r.status), remaining: r.remaining };
  // GitHubのランキングに乗ったorgを候補に（弱い一致でも所属検証は後段のcompanyフィールドで行う）
  const orgs = r.json.items.map((o) => o.login).slice(0, max);
  return { orgs, status: orgs.length ? 'ok' : 'no-org', remaining: r.remaining };
}

// org の公開メンバー実名を集める。
//   verified=true（orgサイト==対象ドメインで同一企業を確定済）: 公開メンバーは当該企業の人と見なし、実名なら採用。
//   verified=false（弱一致）: 追加で user.company が org/社名核を含むことを要求（誤帰属防止）。
async function membersOf(org, companyName, { maxMembers = 8, verified = false } = {}) {
  const core = companyCore(companyName).toLowerCase();
  const r = await ghGet(`/orgs/${encodeURIComponent(org)}/members?per_page=${maxMembers}`);
  if (r.status !== 200 || !Array.isArray(r.json)) return { contacts: [], remaining: r.remaining, status: 'no-members' };
  const contacts = [];
  for (const m of r.json.slice(0, maxMembers)) {
    const u = await ghGet(`/users/${encodeURIComponent(m.login)}`);
    if (u.remaining <= 1) break; // レート枯渇で打ち切り
    const uj = u.json || {};
    if (!uj.name || !looksLikeRealName(uj.name)) continue;
    const comp = String(uj.company || '').toLowerCase().replace(/^@/, '');
    const companyFieldMatch = comp && (comp.includes(org.toLowerCase()) || (core && core.length >= 3 && comp.includes(core)));
    if (!verified && !companyFieldMatch) continue; // 弱一致orgでは company で裏取りできない実名は出さない
    contacts.push({
      name: uj.name, login: uj.login, role: '技術者', kind: '技術者',
      company: uj.company || org, url: uj.html_url || `https://github.com/${uj.login}`,
      confidence: verified ? (companyFieldMatch ? 0.55 : 0.5) : 0.4,
    });
    await sleep(120);
  }
  return { contacts, remaining: r.remaining, status: contacts.length ? 'hit' : 'no-name' };
}

// 1社について GitHub から技術者の実名候補を返す（findRecruiterName と同形に寄せる）。
//   url を渡すとドメイン起点でorgを直接特定（推奨・coreレート）。無ければ日本語社名searchにフォールバック。
async function findGithubContacts(companyName, { maxOrgs = 2, maxMembers = 8, url = '' } = {}) {
  const detail = {};
  let orgs = []; // {login, verified}
  // (1) ドメイン起点（本命）: 公式URLがあれば /orgs/{login} を直接引く（search枠を使わない）。
  if (url) {
    const d = await findOrgByDomain(url, { max: 3 });
    if (d.org) { orgs = [{ login: d.org, verified: d.verified }]; detail['GitHub'] = `domain-hit:${d.org}${d.verified ? '' : '?'}(rl${d.remaining})`; }
    else detail['GitHub'] = `domain-miss(rl${d.remaining})`;
  }
  // (2) フォールバック: URLが無い/ドメインで当たらない時だけ日本語社名search（30/分枠・当たりにくい）。
  if (!orgs.length && !url) {
    const s = await findOrgs(companyName, { max: maxOrgs });
    orgs = s.orgs.map((o) => ({ login: o, verified: false }));
    detail['GitHub'] = s.status + (s.remaining != null ? `(rl${s.remaining})` : '');
  }
  if (!orgs.length) return { contacts: [], 詳細: detail };
  const all = [];
  for (const { login, verified } of orgs) {
    const m = await membersOf(login, companyName, { maxMembers, verified });
    detail[`org:${login}`] = m.status;
    all.push(...m.contacts);
    if (m.remaining <= 1) { detail['GitHub'] += ' rate-limited'; break; }
  }
  // 重複（login）排除・確度順
  const seen = new Set();
  const contacts = all.filter((c) => !seen.has(c.login) && seen.add(c.login))
    .sort((a, b) => b.confidence - a.confidence);
  return { contacts, 詳細: detail };
}

module.exports = { findGithubContacts, findOrgs, findOrgByDomain, orgCandidatesFromUrl, membersOf, looksLikeRealName };
