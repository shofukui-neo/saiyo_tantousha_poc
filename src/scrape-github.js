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

// レート制限を見ながら1件GET。429/403(レート)時は残数を返して上位で打ち切れるように。
async function ghGet(path) {
  try {
    const res = await fetch(API + path, { headers: headers() });
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') || '1', 10);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, remaining, json };
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

// 会社名→org候補を検索（type:org）。company の核トークンで照合し、無関係orgを弾く。
async function findOrgs(companyName, { max = 3 } = {}) {
  const core = companyCore(companyName);
  // 英語社名やローマ字org向けに、社名そのもの＋核トークンで検索
  const q = encodeURIComponent(`${companyName} type:org`);
  const r = await ghGet(`/search/users?q=${q}&per_page=${max}`);
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) return { orgs: [], status: r.status === 200 ? 'no-org' : ('http' + r.status), remaining: r.remaining };
  // GitHubのランキングに乗ったorgを候補に（弱い一致でも所属検証は後段のcompanyフィールドで行う）
  const orgs = r.json.items.map((o) => o.login).slice(0, max);
  return { orgs, status: orgs.length ? 'ok' : 'no-org', remaining: r.remaining };
}

// org のメンバー実名を集める。各メンバーの company フィールドで所属を再検証（精度の肝）。
async function membersOf(org, companyName, { maxMembers = 8 } = {}) {
  const core = companyCore(companyName).toLowerCase();
  const r = await ghGet(`/orgs/${encodeURIComponent(org)}/members?per_page=${maxMembers}`);
  if (r.status !== 200 || !Array.isArray(r.json)) return { contacts: [], remaining: r.remaining, status: 'no-members' };
  const contacts = [];
  for (const m of r.json.slice(0, maxMembers)) {
    const u = await ghGet(`/users/${encodeURIComponent(m.login)}`);
    if (u.remaining <= 1) break; // レート枯渇で打ち切り
    const uj = u.json || {};
    if (!uj.name || !looksLikeRealName(uj.name)) continue;
    // 所属検証: user.company に org名 or 社名核が含まれる、もしくは org名自体が社名核を含む（弱一致の補強）
    const comp = String(uj.company || '').toLowerCase().replace(/^@/, '');
    const orgMatch = org.toLowerCase().includes(core) || (core && core.length >= 3 && comp.includes(core));
    const companyFieldMatch = comp && (comp.includes(org.toLowerCase()) || (core && comp.includes(core)));
    if (!orgMatch && !companyFieldMatch) continue; // 所属が確認できない実名は出さない
    contacts.push({
      name: uj.name, login: uj.login, role: '技術者', kind: '技術者',
      company: uj.company || org, url: uj.html_url || `https://github.com/${uj.login}`,
      confidence: companyFieldMatch ? 0.55 : 0.45,
    });
    await sleep(120);
  }
  return { contacts, remaining: r.remaining, status: contacts.length ? 'hit' : 'no-name' };
}

// 1社について GitHub から技術者の実名候補を返す（findRecruiterName と同形に寄せる）。
async function findGithubContacts(companyName, { maxOrgs = 2, maxMembers = 8 } = {}) {
  const detail = {};
  const { orgs, status, remaining } = await findOrgs(companyName, { max: maxOrgs });
  detail['GitHub'] = status + (remaining != null ? `(rl${remaining})` : '');
  if (!orgs.length) return { contacts: [], 詳細: detail };
  const all = [];
  for (const org of orgs) {
    const m = await membersOf(org, companyName, { maxMembers });
    detail[`org:${org}`] = m.status;
    all.push(...m.contacts);
    if (m.remaining <= 1) { detail['GitHub'] += ' rate-limited'; break; }
  }
  // 重複（login）排除・確度順
  const seen = new Set();
  const contacts = all.filter((c) => !seen.has(c.login) && seen.add(c.login))
    .sort((a, b) => b.confidence - a.confidence);
  return { contacts, 詳細: detail };
}

module.exports = { findGithubContacts, findOrgs, membersOf, looksLikeRealName };
