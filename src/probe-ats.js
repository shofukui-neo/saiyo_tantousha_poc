'use strict';
/**
 * ATS未導入判定プローブ（取得層）
 * ============================================================================
 * 判定ロジックは ats-detect.js（純関数）。ここは「どのページを見に行くか」だけを持つ。
 *
 * 見る面の設計（エントリー動線が実際に置かれている場所）:
 *   トップ → 採用トップ → エントリー/募集要項/説明会予約 の2ホップ。
 *   1ホップ目（採用トップ）には「エントリーはこちら」ボタンしか無く、
 *   実体（Googleフォーム/ベンダー/メール）は2ホップ目に出る。ここを取りに行かないと
 *   entry_type が全部 none になる。よって採用ページからの深掘りを必ず1段入れる。
 *
 * ドメイン規律:
 *   ・深掘りは公式URLと同一ドメイン（サブドメイン含む）のみ。
 *   ・採用サイトが別ドメイン（例 xxx-recruit.jp）で、媒体でなければ種として足す。
 *     ただし「そこへ遷移した事実」は動線の証跡としては採らない（自社サイトの分割なので）。
 *
 * 打ち切り:
 *   自前辞書で確定した ATSベンダー導線を1本掴んだ時点で終了（＝除外が確定するので以降は無駄）。
 *   「未導入」と言い切る時だけ全ページ見る＝コストを主張の重さに比例させる。
 *
 *   node src/probe-ats.js "会社名" "https://公式URL/" [--recruit URL] [--fresh] [--max 6] [--render]
 */
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { politeGet } = require('./polite');
const { closeBrowser } = require('./fetch');
const {
  detectEntryOnPage, summarizeAts, atsTalkGuide, sameCompanyHost, isMediaHost, isSocialHost, isInfraHost, rootDomain,
} = require('./ats-detect');

const ROOT = path.resolve(__dirname, '..');
const DICT_PATH = path.resolve(ROOT, 'data/ats-fingerprints.json');

let _dict = null; let _dictMtime = 0;
/** 自前指紋辞書を読む（無ければ空辞書＝全ての外部ホストが「要確認」になるだけで動作はする）。 */
function loadDict(force) {
  try {
    const st = fs.statSync(DICT_PATH);
    if (!force && _dict && st.mtimeMs === _dictMtime) return _dict;
    _dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    _dictMtime = st.mtimeMs;
  } catch (_) { _dict = _dict || { hosts: {}, scripts: {}, metas: {} }; }
  return _dict;
}

// 見に行く面の優先度。w が大きいほど先に取る。
const PAGE_HINTS = [
  { re: /entry|エントリー|応募|申[しし]?込|mypage|マイページ/i, role: 'エントリー', w: 6 },
  { re: /boshu|募集要項|募集要領|募集職種|要項|youkou|requirements|recruit-?guide/i, role: '募集要項', w: 5 },
  { re: /setsumeikai|説明会|セミナー|会社説明|briefing|seminar|event/i, role: '説明会', w: 4 },
  { re: /recruit|saiyo|career|採用|新卒|shinsotsu|graduate|freshers/i, role: '採用', w: 3 },
  { re: /contact|inquiry|toiawase|問\s*い?\s*合|お問合せ/i, role: '問合せ', w: 2 },
];
function pageRoleOf(hay) {
  let best = null;
  for (const h of PAGE_HINTS) if (h.re.test(hay)) { if (!best || h.w > best.w) best = h; }
  return best;
}

/**
 * HTMLから深掘り候補（同一ドメイン・役割つき）を集める。
 * @param {string} baseUrl 取得元URL（相対リンク解決に使う）
 * @param {string} html
 * @param {number} [bonus] 呼び出し元の面の重み（採用ページから辿るリンクを優先させる）
 */
function collectEntryPages(baseUrl, html, bonus = 0) {
  let base;
  try { base = new URL(baseUrl); } catch (_) { return []; }
  const $ = cheerio.load(html);
  const out = []; const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || /^(mailto|tel|javascript):/i.test(href)) return;
    let u;
    try { u = new URL(href, base); } catch (_) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (!sameCompanyHost(u.hostname, base.hostname)) return;      // 同一企業ドメインのみ
    if (/\.(pdf|jpg|jpeg|png|gif|zip|docx?|xlsx?)$/i.test(u.pathname)) return;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key) || key === baseUrl) return;
    seen.add(key);
    let p = u.pathname;
    try { p = decodeURIComponent(p); } catch (_) { /* そのまま */ }
    const r = pageRoleOf(`${p} ${($(a).text() || '').trim()}`);
    if (r) out.push({ url: key, role: r.role, score: r.w + bonus });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 媒体ページから企業の自社サイトを拾う。
 * ============================================================================
 * リストの「公式URL」列に媒体ページ（マイナビの企業ページ等）が入っている社が実在する。
 * 実測: leads-icp-perfect-named-1000.csv は1000社中949社がそれ。
 * そのまま巡回すると媒体のUIしか見えず、エントリー動線が判定不能（または媒体誤検出）になる。
 * 媒体の企業ページには自社サイトへのリンクがあるので、そこから本体へ移る。
 * @returns {string} 自社サイトURL（見つからなければ ''）
 */
function findOwnSiteOnMediaPage(baseUrl, html) {
  let base;
  try { base = new URL(baseUrl); } catch (_) { return ''; }
  const $ = cheerio.load(html);
  const byDomain = new Map();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || /^(mailto|tel|javascript):/i.test(href)) return;
    let u;
    try { u = new URL(href, base); } catch (_) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const h = u.hostname;
    if (isMediaHost(h) || isSocialHost(h) || isInfraHost(h)) return;
    const anchor = ($(a).text() || '').replace(/\s+/g, ' ').trim();
    // 「企業ホームページ」「公式サイト」等の文言、またはトップページ直リンクを高く見る
    let score = 1;
    if (/ホームページ|公式|コーポレート|会社概要|website|home\s*page|企業サイト/i.test(anchor)) score += 5;
    if (u.pathname === '/' || u.pathname === '') score += 2;
    if (/\.co\.jp$/i.test(h)) score += 1;
    const d = u.origin;
    byDomain.set(d, (byDomain.get(d) || 0) + score);
  });
  const ranked = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked[0][0] + '/' : '';
}

// 採用ページに辿り着けなかった時に試す定番パス（多すぎるとサイト負荷になるので絞る）。
const COMMON_PATHS = ['/recruit/', '/recruit/entry/', '/saiyo/', '/careers/', '/recruit/newgraduate/'];

function altHostUrl(url) {
  try {
    const u = new URL(url);
    u.host = u.host.startsWith('www.') ? u.host.slice(4) : 'www.' + u.host;
    return u.toString();
  } catch (_) { return ''; }
}

/**
 * 1社のエントリー動線を判定する。
 * @param {string} companyName
 * @param {string} officialUrl 公式サイトURL（必須）
 * @param {{maxPages?:number, recruitUrl?:string, render?:string, noCache?:boolean, dict?:object, learn?:boolean}} [opts]
 * @returns {Promise<object>} summarizeAts の結果 + { トーク指針, 検査ページ数, pages, signals, 学習材料 }
 */
async function probeAts(companyName, officialUrl, opts = {}) {
  const maxPages = opts.maxPages != null ? opts.maxPages : 6;
  const dict = opts.dict || loadDict();
  const started = Date.now();
  const signals = []; const pages = [];
  const learn = { hosts: [], scripts: [], metas: [] };
  let pagesOk = 0; let pagesFailed = 0; let recruitFound = false;
  let startUrl = officialUrl; let viaMedia = '';

  const finish = (extra) => {
    const sum = summarizeAts(signals, { pagesOk, pagesFailed, recruitFound });
    // 打ち切り理由は営業が読む根拠列に必ず出す（「不明」の中身が判らないと再取得の判断ができない）。
    if (extra && extra.エラー) sum.根拠 = `${extra.エラー}${sum.根拠 ? ' ／ ' + sum.根拠 : ''}`.slice(0, 500);
    return {
      ...sum,
      トーク指針: atsTalkGuide(sum.ATS判定, sum.entry_type, sum.ベンダー),
      検査ページ数: pagesOk, 失敗ページ数: pagesFailed, 採用ページ到達: recruitFound ? '○' : '',
      解決した自社サイト: viaMedia ? startUrl : '',
      pages, signals, 学習材料: learn, 所要ms: Date.now() - started, ...(extra || {}),
    };
  };
  if (!officialUrl || !/^https?:\/\//i.test(officialUrl)) return finish({ エラー: '公式URLなし' });

  const visit = async (url, role, render) => {
    const r = await politeGet(url, { render: render || 'static', noCache: !!opts.noCache }).catch(() => null);
    if (!r || r.blocked || r.error || !r.html) {
      pagesFailed++;
      pages.push({ url, role, ok: false, reason: r ? (r.reason || r.error || 'no-html') : 'fetch-failed' });
      return null;
    }
    pagesOk++;
    const finalUrl = r.finalUrl || url;
    const d = detectEntryOnPage(r.html, { pageUrl: finalUrl, pageRole: role, dict, companyName });
    signals.push(...d.signals);
    learn.hosts.push(...d.hosts);
    learn.scripts.push(...d.scripts);
    learn.metas.push(...d.metas);
    if (role === '採用' || role === 'エントリー' || role === '募集要項') recruitFound = true;
    pages.push({ url: finalUrl, role, ok: true, 証跡: d.signals.length });
    return { ...r, finalUrl };
  };

  // 確定ベンダー導線を掴んだら打ち切る（＝除外決定。以降のページは無駄）。
  const vendorLocked = () => signals.some((s) => s.entry_type === 'ats_vendor' && s.side === 'ats' && s.entry_ctx);

  // ① トップ（JS差し込みのエントリーボタンを拾うため 'auto'）
  let top = await visit(startUrl, 'トップ', opts.render || 'auto');
  if (!top) {
    const alt = altHostUrl(startUrl);
    if (alt) top = await visit(alt, 'トップ(www補正)', opts.render || 'auto');
  }
  // 「公式URL」が媒体ページだった場合は、そこから自社サイトを拾って本体へ移る。
  let startIsMedia = false;
  try { startIsMedia = isMediaHost(new URL(startUrl).hostname); } catch (_) { /* 不正URL */ }
  if (top && startIsMedia) {
    const own = findOwnSiteOnMediaPage(top.finalUrl, top.html);
    if (own) {
      viaMedia = startUrl;
      startUrl = own;
      const t2 = await visit(own, 'トップ(媒体から自社サイト解決)', opts.render || 'auto');
      if (t2) top = t2;
    } else {
      // 自社サイトが判らないまま媒体ページだけ見ても、動線の主張はできない
      return finish({ エラー: '公式URLが媒体ページ・自社サイト未特定', 媒体経由: startUrl });
    }
  }
  const baseUrl = top ? top.finalUrl : startUrl;

  const queue = [];
  const seen = new Set([baseUrl]);
  const enqueue = (list) => {
    for (const c of list) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      queue.push(c);
    }
    queue.sort((a, b) => b.score - a.score);
  };
  if (top) enqueue(collectEntryPages(baseUrl, top.html));

  // 別ドメインの採用サイト（媒体でなければ）を種として足す。エントリー実体はそちらにある。
  if (opts.recruitUrl && /^https?:\/\//i.test(opts.recruitUrl)) {
    try {
      const ru = new URL(opts.recruitUrl);
      if (!isMediaHost(ru.hostname) && !isSocialHost(ru.hostname) && !seen.has(opts.recruitUrl)) {
        seen.add(opts.recruitUrl);
        queue.unshift({ url: opts.recruitUrl, role: '採用', score: 9 });
      }
    } catch (_) { /* 不正URLは無視 */ }
  }

  // ② 幅優先で深掘り。採用系ページからは1段だけ更に潜る（エントリー実体は2ホップ目）。
  let fetched = 0;
  while (queue.length && fetched < maxPages && !vendorLocked()) {
    const c = queue.shift();
    const r = await visit(c.url, c.role, 'static');
    fetched++;
    if (!r) continue;
    if (/^(採用|募集要項|説明会)$/.test(c.role) && fetched < maxPages) {
      // 採用面から見つかるエントリーリンクを最優先で積む
      enqueue(collectEntryPages(r.finalUrl, r.html, 3).filter((x) => x.score >= 7));
    }
  }

  // ③ 採用ページに一度も辿り着けなかった場合だけ定番パスを少数探る
  if (!recruitFound && fetched < maxPages && top) {
    let origin = '';
    try { origin = new URL(baseUrl).origin; } catch (_) { origin = ''; }
    for (const p of COMMON_PATHS) {
      if (fetched >= maxPages || recruitFound) break;
      const u = origin + p;
      if (seen.has(u)) continue;
      seen.add(u);
      const r = await visit(u, '採用', 'static');
      fetched++;
      if (r && fetched < maxPages) enqueue(collectEntryPages(r.finalUrl, r.html, 3).filter((x) => x.score >= 7));
    }
  }

  // 学習材料は重複を潰して返す（辞書学習が集計しやすい形）
  learn.hosts = [...new Set(learn.hosts.filter((h) => h && !isInfraHost(h) && !isSocialHost(h)).map(rootDomain))];
  learn.scripts = [...new Set(learn.scripts)].slice(0, 60);
  learn.metas = [...new Set(learn.metas)].slice(0, 10);
  return finish();
}

async function main() {
  const args = process.argv.slice(2);
  const name = args[0]; const url = args[1];
  if (!name || !url) {
    console.error('使い方: node src/probe-ats.js "会社名" "https://公式URL/" [--recruit URL] [--fresh] [--max 6] [--render]');
    process.exit(1);
  }
  const gi = args.indexOf('--recruit');
  const mi = args.indexOf('--max');
  const r = await probeAts(name, url, {
    recruitUrl: gi >= 0 ? args[gi + 1] : '',
    noCache: args.includes('--fresh'),
    maxPages: mi >= 0 && args[mi + 1] ? parseInt(args[mi + 1], 10) : 6,
    render: args.includes('--render') ? 'auto' : undefined,
  });
  const dict = loadDict();
  console.log(`[ATS判定] ${name} <${url}>｜辞書 ${Object.keys((dict && dict.hosts) || {}).length}ホスト`);
  console.log(`  判定: ${r.ATS判定}（確度${r.確度}） entry_type: ${r.entry_type} entry_host: ${r.entry_host || '-'} ベンダー: ${r.ベンダー || '-'} 重症度: ${r.重症度}`);
  console.log(`  内訳: ${r.動線内訳 || '-'}`);
  console.log(`  根拠: ${r.根拠}`);
  console.log(`  トーク: ${r.トーク指針}`);
  console.log(`  検査: ${r.検査ページ数}ページ成功 / ${r.失敗ページ数}失敗 / ${r.所要ms}ms`);
  for (const p of r.pages) console.log(`    - [${p.role}] ${p.ok ? `証跡${p.証跡}` : 'NG:' + p.reason} ${p.url}`);
  if (r.学習材料.hosts.length) console.log(`  外部ホスト（学習材料）: ${r.学習材料.hosts.slice(0, 10).join(', ')}`);
  await closeBrowser().catch(() => {});
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { probeAts, collectEntryPages, pageRoleOf, loadDict, DICT_PATH };
