'use strict';
/**
 * enrich-ats-all — 保有する全企業の「**新卒で使っているATS**」判定（フルスイープ）
 * =====================================================================
 * 手元のリスト（BALES／統合マスタ／ターゲット）に載っている企業を**全部**、
 * 公式サイトから採用ページ→新卒導線→エントリー先までたどって利用ATSを判定する。
 *
 * ■ 2026-09 改訂（目視監査34社で正解15/誤り15 だったため作り直し）
 *   旧: 「サイトのどこかに hrmos.co が出たらこの会社のATS」→ 中途採用のATSを大量に誤採用。
 *   新: 「**新卒の導線から辿り着いたATS**であることを確認できた時だけ採用」。
 *
 *   具体的に変えた点:
 *     1) 追跡の優先順位を新卒に寄せる（「新卒採用」リンク > 一般の採用リンク）
 *     2) ATSの参照ごとに **実URL** と **周辺文脈（直前の見出し・アンカー文言）** を保持
 *     3) 可能ならATSページ自体を1回取得して、新卒か中途かを本文で確かめる
 *     4) 採否は src/ats-scope.js の gradeEvidence() に一本化。
 *        確定＝新卒の直接証拠あり。それ以外（要確認/中途用/新卒採用なし）は **ATS列を空にする**。
 *        → 旧ロジックが確定扱いしていた「本文に製品名の文字列だけ（確度0.6）」は全部落ちる。
 *
 *   結果、ATS列が埋まる社数は減るが、埋まった行は新卒での利用が確認済みになる。
 *   落ちた分は data/ats-scan/ats-scan-要確認.csv に理由つきで出るので目視に回せる。
 *
 * ■ 1社あたりの手順（証拠が確定した時点で打ち切り）
 *   0) 既知URLがATSホストで、URL自体に新卒の印（卒年 /27/ 等）があれば取得せず確定
 *   1) 起点ページ取得 → ATS参照（iframe/script/a/form action）を文脈つきで収集
 *   2) 新卒採用ページを探して取得（「新卒」を含むリンクを最優先）
 *   3) 新卒ページ内のエントリー導線を1つ追い、ATSページ本文で新卒/中途を確かめる
 *
 * ■ 中断・再開
 *   1社1行の追記専用ジャーナル（data/ats-scan/journal.jsonl）に逐次書く。
 *   旧ロジックで書かれた行（判定グレード列が無い）は再スキャン対象に戻す。
 *   --rebuild でCSVだけ作り直す場合、旧行は「要確認（旧ロジック）」として出す（誤って出荷しない）。
 *
 * 使い方:
 *   node src/enrich-ats-all.js                      # 全社スイープ（数時間・バックグラウンド推奨）
 *   node src/enrich-ats-all.js --conc 16            # 並列数（既定12）
 *   node src/enrich-ats-all.js --limit 200          # 先頭N社だけ（試走）
 *   node src/enrich-ats-all.js --only-unknown       # CRMで利用中ATSが判明済みの社は飛ばす
 *   node src/enrich-ats-all.js --rebuild            # 取得せずジャーナルからCSVだけ作り直す
 *   node src/enrich-ats-all.js --keep-legacy        # 旧ロジックの行も再開スキップ対象にする
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { readCsv, toCsv } = require('./csv');
const { getArg, getIntArg, log, atomicWrite } = require('./cli-util');
const { detectAts, detectAtsByUrl, detectAtsByHtml, hostOfUrl, salesHint, normalizeAtsName, stripTags, atsPageUrl } = require('./ats');
const { scopeOf, gradeEvidence, extractGradYears, GRADE, SCOPE } = require('./ats-scope');
const { politeGet } = require('./polite');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUTDIR = path.resolve(String(getArg('outdir', path.join(DATA, 'ats-scan'))));
const JOURNAL = path.join(OUTDIR, 'journal.jsonl');
const OUT = path.join(OUTDIR, 'ats-scan-all.csv');
const OUT_CONFIRMED = path.join(OUTDIR, 'ats-scan-確定.csv');
const OUT_REVIEW = path.join(OUTDIR, 'ats-scan-要確認.csv');
const AUDIT = path.join(OUTDIR, 'ats-scan-要確認-CRM不一致.csv');
const CONC = Math.max(1, getIntArg('conc', 12));
const LIMIT = getIntArg('limit', 0);
const RESUME = !getArg('no-resume', false);
const ONLY_UNKNOWN = !!getArg('only-unknown', false);
const REBUILD = !!getArg('rebuild', false);
const KEEP_LEGACY = !!getArg('keep-legacy', false);   // 旧ロジック行を再スキャンしない
const MAX_FETCH = getIntArg('max-fetch', 4);          // 1社あたりの取得上限（ATSページ確認の1回分を含む）
const TARGETS = String(getArg('targets', '') || '');  // 母集団を差し替える（精度検証・部分再スキャン用）
const SCHEMA = 5;                                     // 判定ロジックの版。上げると旧行は再スキャンされる（5=中途URLを避けて深掘りする探索）
// 本文をどこまで読むか。HRMOSの求人一覧は4万字級で、「2027年3月卒業見込み」のような
// 決め手が後半に出る。2万字で切ると新卒の証拠を落として中途と誤判定するため広く取る。
const TEXT_MAX = 200000;

// ── 母集団の構築（3系統をホストで名寄せ）──────────────────────────
// 同じ会社が複数リストに出るので「ホスト1つ＝1社」に畳む。採用ページURLが分かっている行を優先。
const SOURCES = [
  { file: path.join(DATA, 'leads-consolidated-all.csv'), name: '企業名', url: '公式URL', recruit: '採用ページURL' },
  { file: path.join(DATA, 'leads-mochica-target.csv'), name: '企業名', url: '公式URL', recruit: '採用ページURL' },
];
/** BALESの最新エクスポート（ファイル名に日時が入るので固定できない）。 */
function latestBales() {
  const hit = fs.readdirSync(DATA).filter((f) => /BALESCLOUD.*leadList.*\.csv$/i.test(f)).sort();
  return hit.length ? path.join(DATA, hit[hit.length - 1]) : '';
}

/**
 * 母集団を任意のCSVで差し替える（--targets）。
 * 列は 企業名 / ホスト（無ければ 起点URL・公式URL・Webサイト）を見る。
 * 精度検証（data/ats-truth.csv の35社だけ回す）や、特定の社だけ取り直す時に使う。
 */
function targetsFromCsv(file) {
  const { records } = readCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  const byHost = new Map();
  for (const r of records) {
    // URLは深いもの（起点URL）を優先。ホストだけだと www 無しトップに落ちて取得に失敗する社がある。
    const url = String(r['起点URL'] || r['公式URL'] || r['会社情報：Webサイト'] || r['URL'] || '').trim();
    const h = hostOfUrl(url || r['ホスト']);
    if (!h || byHost.has(h)) continue;
    byHost.set(h, {
      host: h,
      name: String(r['企業名'] || r['会社名'] || r['会社情報：会社名'] || '').trim(),
      url: url || 'https://' + h,
      recruit: String(r['採用ページURL'] || '').trim(),
      crmAts: String(r['CRM利用中ATS'] || r['カスタム情報：利用中ATS'] || '').trim(),
      src: path.basename(file),
    });
  }
  return [...byHost.values()];
}

function buildTargets() {
  if (TARGETS) {
    const t = targetsFromCsv(TARGETS);
    log(`  母集団を差し替え: ${path.basename(TARGETS)} ${t.length}社（--targets）`);
    return t;
  }
  const byHost = new Map();
  const add = (name, url, recruit, crmAts, src) => {
    const h = hostOfUrl(recruit || url);
    if (!h) return;
    const cur = byHost.get(h);
    if (!cur) { byHost.set(h, { host: h, name: String(name || '').trim(), url: String(url || '').trim(), recruit: String(recruit || '').trim(), crmAts: String(crmAts || '').trim(), src }); return; }
    if (recruit && !cur.recruit) cur.recruit = String(recruit).trim();     // より深いURLを採用
    if (crmAts && !cur.crmAts) cur.crmAts = String(crmAts).trim();         // CRMの実測値も持ち回る
    if (!cur.name && name) cur.name = String(name).trim();
  };
  for (const s of SOURCES) {
    if (!fs.existsSync(s.file)) { log(`  （${path.basename(s.file)} が無いのでスキップ）`); continue; }
    const { records } = readCsv(fs.readFileSync(s.file, 'utf8'));
    for (const r of records) add(r[s.name], r[s.url], r[s.recruit], '', path.basename(s.file));
    log(`  ${path.basename(s.file)} ${records.length}行`);
  }
  const bales = latestBales();
  if (bales) {
    const { records } = readCsv(fs.readFileSync(bales, 'utf8'));
    for (const r of records) add(r['会社情報：会社名'], r['会社情報：Webサイト'], '', r['カスタム情報：利用中ATS'], 'BALES');
    log(`  ${path.basename(bales)} ${records.length}行`);
  }
  return [...byHost.values()];
}

// ── ページ取得 ───────────────────────────────────────────────────
/** ページ取得（1回）。robots拒否・失敗は理由つきで返す（黙って落とさない）。 */
async function fetchOnce(url) {
  try {
    const p = await politeGet(url, { render: 'static' });
    if (!p) return { err: 'no-response' };
    if (p.blocked) return { err: 'robots-disallow' };
    if (p.error) return { err: String(p.error).slice(0, 60) };
    if (!p.html) return { err: 'empty' };
    return { html: p.html, finalUrl: p.finalUrl || url };
  } catch (e) { return { err: String((e && e.message) || e).slice(0, 60) }; }
}

/**
 * ページ取得。`www.` 有無で片方しか応答しないサイトが一定数あるため、
 * 失敗したらもう一方を1回だけ試す（取得回数は1と数える。相手サーバへの負荷はDNS/接続1往復分）。
 */
async function fetchPage(url) {
  const first = await fetchOnce(url);
  if (!first.err || first.err === 'robots-disallow') return first;
  let alt = '';
  try {
    const u = new URL(url);
    u.hostname = /^www\./i.test(u.hostname) ? u.hostname.replace(/^www\./i, '') : 'www.' + u.hostname;
    alt = u.toString();
  } catch (_) { return first; }
  const second = await fetchOnce(alt);
  return second.err ? first : second;
}

// ── リンク抽出（アンカー文言つき）───────────────────────────────
// 新卒か中途かはリンクの**文言**で決まるので、URLだけでなくテキストも持つ。
// recruit-page.js の findRecruitLinks はテキストを返さないため、ここで別に取る。
const RECRUIT_RE = /(採用|リクルート|recruit|careers?|求人|新卒|中途|エントリー|entry|募集|join)/i;
const ENTRY_RE = /(エントリー|応募|entry|apply|マイページ|プレエントリー|登録)/i;
const SHINSOTSU_LINK_RE = /(新卒|新卒採用|しんそつ|shinsotsu|newgrad|new-grad|newgraduate|freshers?|graduate|20[23]\d年卒|[23]\d卒)/i;
const CHUTO_LINK_RE = /(中途|キャリア採用|経験者|転職|chuto|midcareer|mid-career|experienced)/i;

// 採用サイトは別サブドメイン（recruit.example.co.jp）に切ってあることが多い。
// `host !== base.host` を「外部」とすると自社の採用サイトを辿れないので、
// 登録ドメイン（co.jp/ne.jp 等の2階層TLDを考慮）が同じなら自社扱いにする。
const TWO_LEVEL_TLD = /\.(co|ne|or|ac|go|gr|ed|lg)\.(jp|uk|kr|nz|za|il|in)$/i;
function regDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  const keep = TWO_LEVEL_TLD.test(h) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

/**
 * <a> を「新卒らしさ」で並べて返す。
 * @returns {Array<{url:string, text:string, context:string, external:boolean, recruit:boolean, entry:boolean, shinsotsu:boolean, chuto:boolean, score:number}>}
 */
function linksOf(baseUrl, html) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    let u;
    try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const text = ($(a).text() || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    // 見出し代わりの祖先（section/li/div）のテキストも文脈に入れる。
    // 「新卒採用」の見出しの下にあるボタンは文言が「エントリー」だけのことが多い。
    const around = $(a).closest('li,section,article,div').first().text().replace(/\s+/g, ' ').trim().slice(0, 300);
    let dpath = u.pathname + u.search;
    try { dpath = decodeURIComponent(dpath); } catch (_) { /* 不正な%エスケープはそのまま */ }
    const self = key.replace(/\/$/, '') === String(baseUrl).split('#')[0].replace(/\/$/, '');
    if (self) return;                                   // 自分自身へのリンク（ロゴ等）は辿っても無駄
    const label = text + ' ' + around;
    const recruit = RECRUIT_RE.test(dpath) || RECRUIT_RE.test(label);
    const entry = ENTRY_RE.test(dpath) || ENTRY_RE.test(text);
    if (!recruit && !entry) return;
    const shinsotsu = SHINSOTSU_LINK_RE.test(dpath) || SHINSOTSU_LINK_RE.test(text);
    const chuto = (CHUTO_LINK_RE.test(dpath) || CHUTO_LINK_RE.test(text)) && !shinsotsu;
    // パス一致はテキスト一致より強い手がかり（`/recruit/` は確実に採用ページ、
    // 「採用情報」というテキストはトップのロゴやパンくずにも付く）。
    // サイトのルート（`/`）は採用ページではないので下げる。
    const score = (shinsotsu ? 8 : 0)
      + (SHINSOTSU_LINK_RE.test(around) && !shinsotsu ? 2 : 0)
      + (ENTRY_RE.test(dpath) ? 4 : entry ? 2 : 0)
      + (RECRUIT_RE.test(dpath) ? 3 : recruit ? 1 : 0)
      - (chuto ? 8 : 0)
      - (CHUTO_LINK_RE.test(around) && !chuto && !shinsotsu ? 2 : 0)
      - (u.pathname === '/' ? 4 : 0);
    const sameSite = regDomain(u.hostname) === regDomain(base.hostname);
    out.push({ url: key, text, context: [text, around].filter(Boolean).join(' | '),
      external: !sameSite, sameSite, recruit, entry, shinsotsu, chuto, score });
  });
  return out.sort((a, b) => b.score - a.score);
}

// ── 1社の判定 ────────────────────────────────────────────────────
/**
 * ページから「ATS参照」を文脈つきで全部集める。
 * 埋め込み（iframe/script/form action）とリンク（<a href>）の両方を見る。
 * @returns {Array<{det:object, atsUrl:string, context:string, fromUrl:string}>}
 */
function collectAtsRefs(pageUrl, html) {
  const refs = [];
  for (const h of detectAtsByHtml(html, pageUrl)) {
    refs.push({ det: h, atsUrl: h.url || '', context: h.context || '', fromUrl: pageUrl });
  }
  // <a href> がATSホストへ直接飛ぶ場合（最も多い形）。アンカー文言が最良の文脈になる。
  for (const l of linksOf(pageUrl, html)) {
    if (!l.external) continue;
    const d = detectAtsByUrl(l.url);
    if (!d) continue;
    refs.push({ det: { ...d, source: 'link', confidence: 0.9, evidence: `リンク先 ${hostOfUrl(l.url)}` }, atsUrl: l.url, context: l.context, fromUrl: pageUrl });
  }
  return refs;
}

/** ATS種別の参照だけ、確度降順で。 */
const atsOnly = (refs) => refs.filter((r) => r.det.kind === 'ats').sort((a, b) => b.det.confidence - a.det.confidence);

/**
 * 1社スキャン。
 * 収集した参照を最後にまとめて gradeEvidence() にかけ、**確定が1つでもあればそれを採用**。
 * 無ければ 中途用／新卒採用なし／要確認 のいずれかを理由つきで残す。
 */
async function scanCompany(t) {
  const trail = [];
  let fetches = 0;
  const start = t.recruit || t.url;
  if (!start) return { ...blank(t), 判定経路: '起点URLなし' };

  const refs = [];              // 集めたATS参照
  const others = new Map();     // 併用（媒体・フォーム）
  let pageScope = null;         // 一番「新卒らしい」ページのスコープ
  let hasShinsotsu;             // 採用ページに新卒の記載があったか（未取得なら undefined）
  let atsPageText = '';         // ATSページ本文（取れた時だけ）
  let atsPageSeen = '';         // その本文を取ったURL
  let probedRef = null;         // 本文を取った参照（本文はこの参照にだけ効かせる）
  const chutoSeen = new Map();  // 中途だと確認できたATS（id -> 判定）
  const pageYears = new Set();  // 参照元ページで見えた卒年（27/28…）

  const noteOthers = (list) => { for (const o of list) if (o.kind !== 'ats' && !others.has(o.id)) others.set(o.id, o.name); };
  const absorb = (pageUrl, html) => {
    const found = detectAtsByHtml(html, pageUrl);
    noteOthers(found);
    refs.push(...collectAtsRefs(pageUrl, html));
    const text = stripTags(html).slice(0, TEXT_MAX);
    // 採用ページ側に出る卒年（「27卒 エントリー受付中」）も拾う。
    // ATSのURL/ページに卒年が無くても、どの卒年で動いているかはここに書いてある。
    for (const y of extractGradYears({ text })) pageYears.add(y);
    const sc = scopeOf({ text, url: pageUrl });
    if (!pageScope || sc.shinsotsu > pageScope.shinsotsu) pageScope = sc;
    if (sc.shinsotsu >= 3) hasShinsotsu = true;
    else if (hasShinsotsu === undefined) hasShinsotsu = false;
  };

  // 0) 起点URL自体がATSホスト。URLに新卒の印があれば取得せず確定できる
  const byUrl = detectAtsByUrl(start);
  if (byUrl && byUrl.kind === 'ats') {
    const g0 = gradeEvidence({ kind: 'ats', source: 'url', atsUrl: start, linkContext: '' });
    if (g0.grade === GRADE.CONFIRMED) {
      return { ...pack(t, byUrl, g0, start, []), 判定経路: 'URLホストのみ（取得なし）', 取得回数: '0' };
    }
    refs.push({ det: byUrl, atsUrl: start, context: '', fromUrl: start });
  }

  // 1) 起点ページ
  const p1 = await fetchPage(start); fetches++;
  if (p1.err) return { ...blank(t), 判定経路: `起点取得失敗（${p1.err}）`, 取得回数: String(fetches) };
  trail.push(t.recruit ? '採用ページ' : 'トップ');
  absorb(p1.finalUrl, p1.html);
  // リダイレクト先がATSなら参照に足す
  if (p1.finalUrl && hostOfUrl(p1.finalUrl) !== hostOfUrl(start)) {
    const dr = detectAtsByUrl(p1.finalUrl);
    if (dr) refs.push({ det: { ...dr, source: 'redirect', evidence: `リダイレクト先 ${hostOfUrl(p1.finalUrl)}` }, atsUrl: p1.finalUrl, context: '', fromUrl: start });
  }

  // 2) 新卒の採用ページへ（「新卒」を含むリンクを最優先。中途リンクは追わない）
  let page = { url: p1.finalUrl, html: p1.html };
  const links1 = linksOf(p1.finalUrl, p1.html);
  const nextRecruit = links1.find((l) => l.shinsotsu && l.sameSite) || links1.find((l) => l.recruit && !l.chuto && l.sameSite);
  if (nextRecruit && fetches < MAX_FETCH && !t.recruit) {
    const p2 = await fetchPage(nextRecruit.url); fetches++;
    if (!p2.err) {
      trail.push(nextRecruit.shinsotsu ? '新卒採用ページ' : '採用ページ');
      page = { url: p2.finalUrl, html: p2.html };
      absorb(p2.finalUrl, p2.html);
    }
  } else if (t.recruit && fetches < MAX_FETCH) {
    // 起点が採用ページの時は、その中の「新卒」リンクを1つだけ深掘りする
    const deeper = links1.find((l) => l.shinsotsu && l.sameSite);
    if (deeper) {
      const p2 = await fetchPage(deeper.url); fetches++;
      if (!p2.err) { trail.push('新卒採用ページ'); page = { url: p2.finalUrl, html: p2.html }; absorb(p2.finalUrl, p2.html); }
    }
  }

  // 3) 「新卒の入口にあるATS」を探して確かめる。
  //    「hrmos.co を見つけた」で止めず、そのページが新卒かを本文で読む。ここが改訂の肝。
  //
  //    降りる → 確かめる を交互に回す。ポイントは2つ。
  //     (a) 中途と分かっているURL（career-cloud.asia/**mid**/… 等）は**確かめに行かない**。
  //         そこに着地しただけで「中途用」と結論すると、新卒と中途で同じベンダーを
  //         使い分けている会社を落とす（監査の取りこぼし6社中4社がこれ）。
  //     (b) 有望な候補が無ければサイトを1段降りる。日本のコーポレートサイトは
  //         「トップ→採用トップ→新卒採用→エントリー」の3段が普通で、ATSは最下層にしか出ない。
  //         「エントリー」という文言のリンクだけを追うと、`新卒採用` と書かれた中間ページを飛ばす。
  const probed = new Set();
  const visited = new Set([start, page && page.url].filter(Boolean));
  /** 確かめに行く価値のあるATS参照（未取得かつ、URLが中途と断定できないもの）。 */
  const promising = () => atsOnly(refs).filter((r) => r.atsUrl
    && !probed.has(atsPageUrl(r.atsUrl))
    && scopeOf({ url: r.atsUrl, atsHost: true }).strongC < 3);

  while (fetches < MAX_FETCH) {
    const cands = promising().sort((a, b) => probeRank(b) - probeRank(a));
    if (!cands.length) {
      // 候補なし → 1段降りる（新卒リンク優先。中途リンクは追わない）
      const next = page && linksOf(page.url, page.html)
        .find((l) => !l.chuto && (l.shinsotsu || l.entry) && !visited.has(l.url));
      if (!next) break;
      visited.add(next.url);
      const pn = await fetchPage(next.url); fetches++;
      if (pn.err) continue;
      trail.push(next.shinsotsu ? '新卒ページ' : 'エントリーページ');
      page = { url: pn.finalUrl, html: pn.html };
      absorb(pn.finalUrl, pn.html);
      continue;
    }
    const target = cands[0];
    // 埋め込みで拾えるのは embed.js のようなアセットが多いので、読める求人ページへ寄せる
    const probe = atsPageUrl(target.atsUrl);
    probed.add(probe);
    const p3 = await fetchPage(probe); fetches++;
    if (p3.err) continue;
    trail.push('ATSページ確認');
    atsPageText = stripTags(p3.html).slice(0, TEXT_MAX);
    atsPageSeen = probe;
    probedRef = target;
    // ATSページ内から更に別ATSが見えることがある（媒体経由の中継など）
    noteOthers(detectAtsByHtml(p3.html, p3.finalUrl));
    const g = gradeEvidence({ kind: 'ats', source: target.det.source, atsUrl: target.atsUrl,
      linkContext: target.context, atsPageText, pageScope, pageHasShinsotsu: hasShinsotsu });
    if (g.grade === GRADE.CONFIRMED) break;
    atsPageText = ''; atsPageSeen = ''; probedRef = null;   // 確定しなかった本文は他の参照に流用しない
    if (g.grade === GRADE.CHUTO) chutoSeen.set(target.det.id, { det: target.det, g, url: target.atsUrl });
  }

  // 4) 採否を決める
  const graded = atsOnly(refs).map((r) => ({
    ref: r,
    g: gradeEvidence({
      kind: 'ats', source: r.det.source, atsUrl: r.atsUrl, linkContext: r.context,
      atsPageText: (probedRef && r === probedRef) ? atsPageText : '',
      pageScope, pageHasShinsotsu: hasShinsotsu,
    }),
  }));
  const otherNames = [...others.values()];
  const confirmed = graded.find((x) => x.g.grade === GRADE.CONFIRMED);
  if (confirmed) {
    // 卒年はATS側の証拠を優先し、無ければ採用ページで見えた卒年で補う
    const years = confirmed.g.years && confirmed.g.years.length ? confirmed.g.years : [...pageYears].sort();
    return { ...pack(t, confirmed.ref.det, { ...confirmed.g, years }, confirmed.ref.atsUrl, otherNames, graded), 判定経路: trail.join('→'), 取得回数: String(fetches) };
  }

  for (const [, c] of chutoSeen) {
    if (!graded.some((x) => x.ref.det.id === c.det.id && x.g.grade === GRADE.CONFIRMED)) {
      graded.push({ ref: { det: c.det, atsUrl: c.url, context: '', fromUrl: '' }, g: c.g });
    }
  }
  const chuto = graded.find((x) => x.g.grade === GRADE.CHUTO);
  if (chuto) return { ...pack(t, null, chuto.g, chuto.ref.atsUrl, otherNames, graded, chuto.ref.det.name), 判定経路: trail.join('→'), 取得回数: String(fetches) };

  const review = graded[0];
  if (review) return { ...pack(t, null, review.g, review.ref.atsUrl, otherNames, graded, '', review.ref.det.name), 判定経路: trail.join('→'), 取得回数: String(fetches) };

  // ATS参照が1つも無い。新卒の記載も無ければ「新卒採用なし」として残す
  const g = hasShinsotsu === false && pageScope && pageScope.chuto >= 3
    ? { grade: GRADE.NO_SHINSOTSU, reason: '採用ページに新卒の記載なし（中途のみ）', scope: SCOPE.CHUTO }
    : { grade: GRADE.NONE, reason: 'ATSの参照が見つからない', scope: SCOPE.UNKNOWN };
  return { ...pack(t, null, g, '', otherNames, []), 判定経路: trail.join('→') || '—', 取得回数: String(fetches) };
}

/**
 * どのATS URLから確かめに行くかの優先度。
 *   +6 URL自体が新卒（卒年 /27/・shinsotsu）
 *   +3 リンク周辺の文言が新卒
 *   -6 URL自体が中途（/mid/・chuto）→ 最後に回す
 *   +1 <a href>由来（埋め込みアセットより実ページに近い）
 */
function probeRank(r) {
  const u = scopeOf({ url: r.atsUrl, atsHost: true });
  const c = scopeOf({ text: r.context });
  let s = 0;
  if (u.strongS >= 3) s += 6;
  if (u.strongC >= 3) s -= 6;
  if (c.shinsotsu > c.chuto && c.shinsotsu >= 3) s += 3;
  if (c.chuto > c.shinsotsu && c.chuto >= 3) s -= 3;
  if (r.det.source === 'link' || r.det.source === 'url') s += 1;
  return s;
}

// ── 出力行 ───────────────────────────────────────────────────────
const HEADERS = ['企業名', 'ホスト', 'ATS', 'ATSベンダー', 'ATS種別', 'ATS確度', 'ATS根拠',
  '判定グレード', '卒年', '新卒根拠', '用途', 'ATS URL', '中途ATS', '候補ATS', 'ATS併用',
  '営業メモ', 'CRM利用中ATS', 'CRMとの一致', '判定経路', '取得回数', '起点URL', '判定日', 'スキーマ'];
const TODAY = new Date().toISOString().slice(0, 10);

function blank(t) {
  return { 企業名: t.name, ホスト: t.host, ATS: '', ATSベンダー: '', ATS種別: '', ATS確度: '', ATS根拠: '',
    判定グレード: GRADE.NONE, 卒年: '', 新卒根拠: '', 用途: '', 'ATS URL': '', 中途ATS: '', 候補ATS: '', ATS併用: '',
    営業メモ: '判定不能（要目視）', CRM利用中ATS: t.crmAts || '', CRMとの一致: crmCompare(t.crmAts, '', ''),
    判定経路: '', 取得回数: '0', 起点URL: t.recruit || t.url, 判定日: TODAY, スキーマ: String(SCHEMA) };
}

/**
 * 出力行を作る。
 * **ATS列は grade が「確定」の時だけ埋める**。ここが誤出荷を止める唯一の場所。
 * @param {object|null} det   確定したATS（確定でなければ null）
 * @param {object} g          gradeEvidence の戻り
 * @param {string} atsUrl     根拠となったATSのURL
 * @param {string[]} others   併用（媒体・フォーム）
 * @param {Array} graded      全参照の採点（候補ATS列に理由つきで出す）
 * @param {string} chutoName  中途で使っていると判定したATS名
 * @param {string} reviewName 要確認どまりのATS名
 */
function pack(t, det, g, atsUrl, others = [], graded = [], chutoName = '', reviewName = '') {
  const confirmed = !!det && g.grade === GRADE.CONFIRMED;
  const cands = graded.map((x) => `${x.ref.det.name}(${x.g.grade}:${x.g.reason})`).join(' / ');
  return {
    企業名: t.name, ホスト: t.host,
    ATS: confirmed ? det.name : '',
    ATSベンダー: confirmed ? det.vendor : '',
    ATS種別: confirmed ? det.kindLabel : '',
    ATS確度: confirmed ? (g.confidence || det.confidence || 0).toFixed(2) : '',
    ATS根拠: confirmed ? det.evidence : '',
    判定グレード: g.grade,
    卒年: (g.years || []).map((y) => y + '卒').join('/'),
    新卒根拠: g.reason || '',
    用途: g.scope || '',
    'ATS URL': atsUrl || '',
    中途ATS: chutoName,
    候補ATS: cands,
    ATS併用: others.join(' / '),
    営業メモ: memo(confirmed ? det : null, g, chutoName, reviewName),
    CRM利用中ATS: t.crmAts || '',
    CRMとの一致: crmCompare(t.crmAts, confirmed ? det.name : '', confirmed ? det.kind : ''),
    起点URL: t.recruit || t.url, 判定日: TODAY, スキーマ: String(SCHEMA),
  };
}

/** 営業が読む一言。確定していない時は「使うな」と分かる文言にする。 */
function memo(det, g, chutoName, reviewName) {
  if (det) {
    if (det.own) return '既存顧客（MOCHICA導入済み）';
    return `新卒で競合ATS導入済み（${det.vendor}）＝リプレイス提案`;
  }
  if (g.grade === GRADE.CHUTO) return `中途のみ${chutoName ? `（${chutoName}）` : ''}＝新卒は別。新卒の運用を要ヒアリング`;
  if (g.grade === GRADE.NO_SHINSOTSU) return '新卒採用の記載なし＝対象外の可能性';
  if (g.grade === GRADE.REVIEW) return `要目視${reviewName ? `（${reviewName}の疑い・証拠不十分）` : ''}`;
  return '判定不能（要目視）';
}

/**
 * CRMの手入力値とURL判定を突き合わせる。
 * 媒体リンク（マイナビ等）はATSの証拠にならないので、ATS種別の時だけ「一致/不一致」を判定する。
 * それ以外は事実だけ書き、CRMが古いのかURLが弱いのかを人が読んで分けられるようにする。
 */
function crmCompare(crmRaw, detected, kind) {
  const crm = normalizeAtsName(crmRaw);
  const isAts = kind === 'ats';
  if (crm.status === 'empty') {
    if (isAts) return `CRM未記入→新卒利用を確認（${detected}）`;
    return '';
  }
  if (crm.status === 'none') {
    if (isAts) return `要確認：CRMは「無し」だが新卒で${detected}を確認`;
    return 'CRM「無し」・新卒ATSは未確認';
  }
  // CRMにツール名がある
  if (isAts) return crm.name === detected ? '一致' : `要確認：不一致（CRM:${crm.name}／新卒実測:${detected}）`;
  return 'CRMのみ（新卒での利用は未確認）';
}

// ── ジャーナル（追記専用・再開可能）──────────────────────────────
/**
 * ジャーナル読込。旧スキーマ（判定グレード列なし）の行は
 * 「要確認（旧ロジック）」に書き換えて返す。放置すると誤判定のまま出荷されるため。
 * @returns {{rows:Map, legacy:number}}
 */
function loadJournal() {
  const rows = new Map();
  let legacy = 0;
  if (!fs.existsSync(JOURNAL)) return { rows, legacy };
  for (const line of fs.readFileSync(JOURNAL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }     // 壊れ行は捨てる
    if (!o || !o.ホスト) continue;
    if (Number(o.スキーマ || 0) < SCHEMA) { legacy++; o = demoteLegacy(o); }
    rows.set(o.ホスト, o);
  }
  return { rows, legacy };
}

/** 旧ロジックの行を「要確認（旧ロジック）」に落とす。ATS列は空にする。 */
function demoteLegacy(o) {
  const had = o.ATS || '';
  return {
    ...blankFromRow(o),
    判定グレード: had ? GRADE.REVIEW : GRADE.NONE,
    新卒根拠: had ? `旧ロジックの判定（${had}／${o.ATS根拠 || ''}）＝新卒での利用は未確認` : '',
    候補ATS: had ? `${had}(要確認:旧ロジック)` : '',
    ATS併用: o.ATS併用 || '',
    営業メモ: had ? `要目視（${had}の疑い・旧ロジック）` : '判定不能（要目視）',
    判定経路: o.判定経路 || '', 取得回数: o.取得回数 || '0',
    レガシー: '1',
  };
}
function blankFromRow(o) {
  return { 企業名: o.企業名 || '', ホスト: o.ホスト || '', ATS: '', ATSベンダー: '', ATS種別: '', ATS確度: '', ATS根拠: '',
    判定グレード: GRADE.NONE, 卒年: '', 新卒根拠: '', 用途: '', 'ATS URL': '', 中途ATS: '', 候補ATS: '', ATS併用: '',
    営業メモ: '', CRM利用中ATS: o.CRM利用中ATS || '', CRMとの一致: '', 判定経路: '', 取得回数: '0',
    起点URL: o.起点URL || '', 判定日: o.判定日 || TODAY, スキーマ: '1' };
}

function writeCsv(rows) {
  const all = [...rows.values()];
  atomicWrite(OUT, '﻿' + toCsv(HEADERS, all));
  // 新卒での利用が確認できた行だけ。リスト生成に使うのはこれ。
  atomicWrite(OUT_CONFIRMED, '﻿' + toCsv(HEADERS, all.filter((r) => r.判定グレード === GRADE.CONFIRMED)));
  // 証拠不十分。目視に回す作業リスト。
  atomicWrite(OUT_REVIEW, '﻿' + toCsv(HEADERS, all.filter((r) => r.判定グレード === GRADE.REVIEW)));
  // CRMの手入力とURL判定が食い違う分（CRM更新の作業リスト）
  atomicWrite(AUDIT, '﻿' + toCsv(HEADERS, all.filter((r) => /^要確認/.test(r['CRMとの一致'] || ''))));
}

// ── 既知クラッシュの握りつぶし ───────────────────────────────────
// undici（Node標準fetchの実装）がレスポンス終端で稀に投げるアサーション。
// ソケットのイベントハンドラから飛んでくるので await の try/catch では捕まえられず、
// そのままプロセスが落ちる（実測: 1万社スイープの1,350社目で死亡）。
// この既知例外だけ握りつぶして走り続ける。取得中のリクエストは fetchStatic の
// AbortController（15秒）が必ず落とすので、ワーカーが永久に止まることはない。
let undiciSkips = 0;
function guardUndiciCrash() {
  process.on('uncaughtException', (e) => {
    const s = String((e && e.stack) || e);
    if (e && e.code === 'ERR_ASSERTION' && /undici/.test(s)) { undiciSkips++; return; }
    throw e;   // それ以外は落とす（壊れた状態のまま走らせない）
  });
}

// ── メイン ───────────────────────────────────────────────────────
async function run() {
  guardUndiciCrash();
  fs.mkdirSync(OUTDIR, { recursive: true });
  log('母集団を構築中…');
  const targets = buildTargets();
  log(`ユニークホスト ${targets.length}社`);

  const { rows: done, legacy } = RESUME ? loadJournal() : { rows: new Map(), legacy: 0 };
  if (done.size) log(`ジャーナルから ${done.size}社を読込`);
  if (legacy) log(`  うち ${legacy}社は旧ロジック（スキーマ<${SCHEMA}）＝「要確認」に降格${KEEP_LEGACY ? '（--keep-legacy: 再スキャンしない）' : '・再スキャン対象'}`);
  if (REBUILD) { writeCsv(done); log(`ジャーナルからCSVを再生成: ${OUT}（${done.size}社）`); return summarize(done); }

  // 旧ロジック行は既定で再スキャンする（降格したままにしない）
  const isDone = (h) => { const r = done.get(h); return r && (KEEP_LEGACY || r.レガシー !== '1'); };
  let queue = targets.filter((t) => !isDone(t.host));
  if (ONLY_UNKNOWN) {
    const before = queue.length;
    queue = queue.filter((t) => normalizeAtsName(t.crmAts).status !== 'known');
    log(`CRMで判明済みの ${before - queue.length}社を除外（--only-unknown）`);
  }
  if (LIMIT) queue = queue.slice(0, LIMIT);
  log(`今回の対象 ${queue.length}社 ／ 並列${CONC}・1社最大${MAX_FETCH}取得`);
  if (!queue.length) { writeCsv(done); return summarize(done); }

  const jfd = fs.openSync(JOURNAL, 'a');
  const t0 = Date.now();
  let idx = 0, processed = 0, confirmedN = 0, chutoN = 0, reviewN = 0;

  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= queue.length) return;
      const t = queue[my];
      let row;
      try { row = await scanCompany(t); }
      catch (e) { row = { ...blank(t), 判定経路: 'エラー:' + String((e && e.message) || e).slice(0, 40) }; }
      done.set(t.host, row);
      fs.writeSync(jfd, JSON.stringify(row) + '\n');   // 1社ごとに追記＝いつ落ちても失わない
      if (row.判定グレード === GRADE.CONFIRMED) confirmedN++;
      else if (row.判定グレード === GRADE.CHUTO) chutoN++;
      else if (row.判定グレード === GRADE.REVIEW) reviewN++;
      if (++processed % 50 === 0) {
        writeCsv(done);
        const rate = processed / ((Date.now() - t0) / 60000);
        const eta = (queue.length - processed) / Math.max(rate, 0.01);
        log(`  ${processed}/${queue.length}（確定 ${confirmedN}・中途 ${chutoN}・要確認 ${reviewN}）｜${rate.toFixed(1)}社/分・残り約${Math.round(eta)}分`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  fs.closeSync(jfd);
  writeCsv(done);
  log(`完了: ${processed}社を判定（新卒確定 ${confirmedN}・中途のみ ${chutoN}・要確認 ${reviewN}）／累計 ${done.size}社`);
  if (undiciSkips) log(`  （undiciの既知アサーションを ${undiciSkips}回スキップ）`);
  summarize(done);
}

function summarize(rows) {
  const tally = new Map(), grade = new Map(), mismatch = [];
  for (const r of rows.values()) {
    grade.set(r.判定グレード || '—', (grade.get(r.判定グレード || '—') || 0) + 1);
    if (r.判定グレード === GRADE.CONFIRMED) tally.set(r.ATS, (tally.get(r.ATS) || 0) + 1);
    if (/^要確認/.test(r.CRMとの一致 || '')) mismatch.push(r);
  }
  console.log('\n[ats-scan] 判定グレード内訳');
  for (const [k, n] of [...grade.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
  console.log('\n[ats-scan] 新卒で確定したツール（上位25）');
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  console.log(`\n[ats-scan] CRMと実測の食い違い ${mismatch.length}社（CRMが古い可能性・監査対象）`);
  for (const r of mismatch.slice(0, 10)) console.log(`    ${r.企業名}：${r.CRMとの一致}`);
  console.log(`\n[ats-scan] 出力（全件）     ${OUT}`);
  console.log(`  新卒確定（これを使う）     ${OUT_CONFIRMED}`);
  console.log(`  要確認（目視に回す）       ${OUT_REVIEW}`);
  console.log(`  CRM要確認の抽出            ${AUDIT}`);
  console.log(`  ジャーナル ${JOURNAL}（再開可能。--rebuild でCSVだけ作り直し）`);
}

if (require.main === module) run().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exitCode = 1; });
module.exports = { scanCompany, buildTargets, targetsFromCsv, crmCompare, linksOf, collectAtsRefs, demoteLegacy, HEADERS, SCHEMA };
