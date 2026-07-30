'use strict';
/**
 * fix-badnumber-phone — 「番号不備」リードの電話番号を正しい番号に直す
 * =====================================================================
 * build-badnumber-list.js が抽出した架電不能リード（既定＝区分「番号不備」）について、
 * 企業の**公式サイトから代表電話を取り直し**、旧番号（不備）と並べて出力する。
 *
 * ■ 番号の出所（外部AI API不使用・ローカル処理のみ）
 *   1) 公式URLの確定  … ①BALESの「会社情報：Webサイト」 ②担当者メールのドメイン
 *                        ③キーレス検索（search.js / Bing・DDG HTML）で発見＋社名一致検証
 *   2) ページ巡回      … トップ＋会社概要/お問い合わせ/アクセス系（robots.txt 遵守・礼儀待機）
 *   3) 電話抽出        … ①JSON-LD Organization.telephone ②tel:リンク ③「TEL/代表」近接の正規表現
 *                        FAX近接は減点、日本の桁構成に合わないものは不採用（phone.js）
 *   4) 検証            … 市外局番→都道府県（areacode.js）を BALES住所と突合し整合を表示
 *                        旧番号と同一なら「旧番号と同一（サイト側も同じ）」として区別
 *
 * ■ 出力の考え方
 *   自動で上書きせず、必ず「旧番号／新番号／根拠URL／確度」を並べて人が確認できる形にする。
 *   取込用CSVは 会社情報：電話 を新番号に差し替え済み（新番号が取れた行のみ）。
 *
 * 使い方:
 *   node src/fix-badnumber-phone.js                     # 区分「番号不備」を処理
 *   node src/fix-badnumber-phone.js --category 現在使われておりません
 *   node src/fix-badnumber-phone.js --category all      # 3区分すべて
 *   node src/fix-badnumber-phone.js --limit 20 --concurrency 4
 *   （--resume 既定ON: ジャーナルに残った済み企業はスキップ。中断・再実行して継続可）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const cfg = require('./config');
const { getRobots, isAllowed } = require('./robots');
const { fetchPage, discoverPages, guessContactPaths, extractText, closeBrowser } = require('./fetch');
const { runSearch, scoreCandidates, pageMatchesCompany, companyCore } = require('./search');
const cheerio = require('cheerio');
const { normalizeJpPhone, toHalfWidth } = require('./phone');
const { prefectureForNumber } = require('./areacode');
const structured = require('./structured');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const IN = path.resolve(getArg('--in', path.join(DATA, 'bales-架電不能-番号系.csv')));
const BALES = path.resolve(getArg('--bales', path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv')));
const CATEGORY = getArg('--category', '番号不備');
const OUT = path.resolve(getArg('--out', path.join(DATA, 'bales-番号不備-電話再取得.csv')));
const BALES_OUT = path.resolve(getArg('--bales-out', path.join(DATA, 'leads-bales-badnumber-fixed.csv')));
const JOURNAL = path.resolve(getArg('--journal', path.join(DATA, 'badnumber-phone.journal.json')));
const LOG = path.resolve(getArg('--log', path.join(DATA, 'badnumber-phone.run.log')));
const LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;
const CONC = parseInt(getArg('--concurrency', '4'), 10) || 4;
const MAX_PAGES = parseInt(getArg('--max-pages', '6'), 10) || 6;
const NO_RESUME = has('--no-resume');
const DEBUG = has('--debug');

const C = {
  id: 'システム管理情報：ID', no: 'システム管理情報：No', name: '会社情報：会社名',
  phone: '会社情報：電話', phone2: '担当者情報：電話', web: '会社情報：Webサイト',
  pref: '会社情報：住所：都道府県', city: '会社情報：住所：市区郡',
  sei: '担当者情報：姓', mei: '担当者情報：名', mail: '担当者情報：メール',
  url: 'システム管理情報：リードURL',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch (_) {} };
// undici の内部アサーション等でプロセスごと落ちないよう吸収（数件ごとにジャーナル保存済み）
process.on('uncaughtException', (e) => { try { log('⚠ uncaughtException(継続): ' + (e && e.message ? e.message : e)); } catch (_) {} });
process.on('unhandledRejection', (e) => { try { log('⚠ unhandledRejection(継続): ' + (e && e.message ? e.message : e)); } catch (_) {} });

const digits = (v) => String(v || '').replace(/[^0-9]/g, '');
const same = (a, b) => digits(a) && digits(a) === digits(b);

// 求人媒体・ポータル等は「自社の代表電話」を載せていないので公式サイト候補から外す
const NOT_OFFICIAL = /(mynavi|rikunabi|recruit\.|en-japan|doda|indeed|wantedly|type\.jp|green-japan|baitoru|townwork|hellowork|jobtalk|openwork|vorkers|facebook|twitter|x\.com|instagram|linkedin|youtube|note\.com|ameblo|hatena|wikipedia|goo\.ne|navit-j|alarm\.jp|houjin|baseconnect|salesnow|musubu|ekiten|itp\.ne|mapion|navitime|goo\.gl|google\.|yahoo\.|amazon|rakuten|jinjibu|hrpro|prtimes)/i;

function domainFromEmail(mail) {
  const m = String(mail || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/);
  if (!m) return '';
  const d = m[1].toLowerCase();
  // フリーメール/媒体ドメインは公式サイトの手掛かりにならない
  if (/(gmail|yahoo|outlook|hotmail|icloud|docomo|ezweb|softbank|au\.com|nifty|ocn\.ne|biglobe|so-net)\./.test(d)) return '';
  if (NOT_OFFICIAL.test(d)) return '';
  return d;
}

function locatePaths(homepageUrl) {
  try { const o = new URL(homepageUrl).origin; return (cfg.LOCATE_PATHS || []).map((p) => o + p); } catch (_) { return []; }
}
// 会社概要・お問い合わせ・アクセス系を先に見る（代表電話が載る確率が高い）
const PAGE_PRIORITY = /company|about|corporate|profile|outline|contact|inquiry|access|kaisya|gaiyou|会社|概要|問い合わせ|問合|連絡|アクセス/i;

// 社名照合（厳格）: 法人格・記号・空白を落とした「核」がページに出るかだけを見る。
// pageMatchesCompany の「トークン過半一致」は、親会社サイトを子会社の公式サイトと
// 誤認する（例: ALSOK新潟綜合警備保障 → alsok.co.jp）ため、検索経由では使わない。
const squash = (s) => String(s || '').toLowerCase().replace(/[\s　・･,，.。\-‐－ー"'"'()（）]/g, '');
function strictMatch(companyName, title, text) {
  const core = squash(companyCore(companyName));
  if (!core || core.length < 2) return false;
  return squash(title).includes(core) || squash(String(text || '').slice(0, 8000)).includes(core);
}

// 架電先としての望ましさ: 固定電話 ＞ ナビダイヤル ＞ 携帯/IP ＞ フリーダイヤル
// （0120はグループ共通のコールセンターに繋がることが多く、採用担当に辿り着けない）
function phoneTier(p) {
  const d = digits(p);
  if (/^(0120|0800)/.test(d)) return 1;
  if (/^(070|080|090|050)/.test(d)) return 2;
  if (/^0570/.test(d)) return 3;
  return 4;
}
const TIER_LABEL = { 4: '固定電話', 3: 'ナビダイヤル', 2: '携帯/IP', 1: 'フリーダイヤル' };

// ── TEL/FAX の判別 ───────────────────────────────────────────────
// 共有の extractPhones は番号の前後18文字を対称に見るため、
// 「TEL 0570-048121(代) FAX 0172-59-1055」のように TEL と FAX が並ぶ表記で
// **TEL側までFAX扱い**になってしまう。日本語の企業サイトではラベルは必ず番号の
// 直前に置かれるので、ここでは「直前のラベルが勝つ」規則で採り直す。
const TEL_BEFORE = /(TEL|Tel|ＴＥＬ|℡|☎|電話|でんわ|代表|直通|お問い?合わせ先)[^0-9０-９]{0,8}$/i;
const FAX_BEFORE = /(FAX|Fax|ＦＡＸ|ファックス|ファクシミリ)[^0-9０-９]{0,8}$/i;
const REP_BEFORE = /(代表|本社|本店|総務|人事|採用)[^0-9０-９]{0,12}$/;
// 問い合わせフォームの入力例（「例) 03-1234-5678」「記入例 0312345678」）を実在番号と取り違えない
const EXAMPLE_BEFORE = /(例|サンプル|記入|入力|半角|形式|placeholder|e\.?g\.?)[^0-9０-９]{0,10}$/i;
// 連番・ゾロ目はダミー表記（03-1234-5678 等）。実在の番号にはまず現れない。
function isDummyNumber(p) {
  const d = digits(p);
  return /0123456|1234567|2345678|3456789|4567890|9876543/.test(d) || /(\d)\1{6,}/.test(d);
}

function scanPhones(html, text, boost) {
  const out = [];
  // ① tel: リンク（最も確実）
  if (html) {
    try {
      const $ = cheerio.load(html);
      $('a[href^="tel:"], a[href^="TEL:"]').each((_, a) => {
        const n = normalizeJpPhone(String($(a).attr('href') || '').replace(/^tel:/i, ''));
        if (!n || isDummyNumber(n)) return;
        const label = ($(a).text() || '').replace(/\s+/g, ' ').trim();
        if (FAX_BEFORE.test(label + ' ') || /fax/i.test(label)) return;
        out.push({ phone: n, score: 9 + boost, source: 'tel:リンク', evidence: ('tel: ' + (label || n)).slice(0, 100) });
      });
    } catch (_) { /* HTML解析に失敗したらテキスト側で拾う */ }
  }
  // ② 本文テキスト（直前ラベル優先）
  const hay = toHalfWidth(String(text || ''));
  const re = /(?<!\d)0\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}(?!\d)/g;
  let m;
  while ((m = re.exec(hay)) !== null) {
    const n = normalizeJpPhone(m[0]);
    if (!n || isDummyNumber(n)) continue;
    const before = hay.slice(Math.max(0, m.index - 20), m.index);
    const after = hay.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (FAX_BEFORE.test(before)) continue;            // 直前がFAXラベル＝FAX番号
    if (EXAMPLE_BEFORE.test(before)) continue;        // フォームの入力例＝実在の番号ではない
    const isTel = TEL_BEFORE.test(before);
    const isRep = REP_BEFORE.test(before) || /\(代\)|（代）/.test(after);
    let score = 2 + boost;
    if (isTel) score += 4;
    if (isRep) score += 2;
    // ラベルが無く直後にFAX表記だけがある番号は、TELかFAXか判断できないので控えめに
    if (!isTel && !isRep && /FAX|ファックス/i.test(after)) score -= 2;
    out.push({ phone: n, score, source: isTel ? 'TEL表記' : (isRep ? '代表表記' : '本文'), evidence: (before + m[0] + after).replace(/\s+/g, ' ').trim().slice(0, 100) });
  }
  return out;
}

// www有り／無しを取り違えると fetch ごと失敗するので、両方試す
function wwwVariant(u) {
  try {
    const x = new URL(u);
    x.hostname = /^www\./i.test(x.hostname) ? x.hostname.replace(/^www\./i, '') : 'www.' + x.hostname;
    return x.toString();
  } catch (_) { return ''; }
}

/** 1社クロールして代表電話の候補を集め、最良を返す */
async function crawlPhone(homepageUrl, companyName, prefHint) {
  const start = (() => { try { return new URL(homepageUrl); } catch (_) { return null; } })();
  if (!start) return null;
  const robots = await getRobots(start.origin).catch(() => null);
  if (robots && !isAllowed(robots, cfg.USER_AGENT, start.pathname)) return { blocked: true };

  let home;
  try { home = await fetchPage(homepageUrl); } catch (_) { home = null; }
  if (!home || !home.html) {
    const alt = wwwVariant(homepageUrl);
    if (!alt) return null;
    try { home = await fetchPage(alt); homepageUrl = alt; } catch (_) { return null; }
    if (!home || !home.html) return null;
  }
  const html0 = home.html || '';
  const text0 = extractText(html0);
  const title0 = (html0.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  let matched = strictMatch(companyName, title0, text0);
  let loose = pageMatchesCompany(companyName, title0, text0);

  // 巡回候補: トップ → ページ内リンクの会社概要/問い合わせ系 → 定番パス（同一オリジンのみ）→ 残り
  // corp.* 等の存在しないサブドメインで枠を潰さないよう、同一オリジンに限定する。
  // 判定は**リダイレクト後**のオリジンで行う（http://www.x.jp → https://x.jp で全リンクが弾かれるのを防ぐ）。
  if (home.finalUrl && home.finalUrl !== homepageUrl) homepageUrl = home.finalUrl;
  const origin = (() => { try { return new URL(homepageUrl).origin; } catch (_) { return start.origin; } })();
  const sameOrigin = (u) => { try { return new URL(u).origin === origin; } catch (_) { return false; } };
  // 実在リンク（ページ内から拾ったURL）を推測パスより優先する。
  // 推測パスは soft-404（同じ「ページがありません」HTMLを200で返す）で枠を潰しがち。
  const links = [...new Set(discoverPages(homepageUrl, html0).filter(sameOrigin))].filter((u) => u !== homepageUrl);
  const guessed = [...new Set([...guessContactPaths(homepageUrl), ...locatePaths(homepageUrl)].filter(sameOrigin))]
    .filter((u) => u !== homepageUrl && !links.includes(u));
  const queue = [
    homepageUrl,
    ...links.filter((u) => PAGE_PRIORITY.test(u)),
    ...guessed.filter((u) => PAGE_PRIORITY.test(u)),
    ...links.filter((u) => !PAGE_PRIORITY.test(u)),
    ...guessed.filter((u) => !PAGE_PRIORITY.test(u)),
  ];

  const htmlByUrl = { [homepageUrl]: html0, [home.finalUrl || homepageUrl]: html0 };
  const found = new Map(); // phone -> {phone, method, url, score}
  const put = (c) => { const prev = found.get(c.phone); if (!prev || c.score > prev.score) found.set(c.phone, c); };

  // 404等の空振りで枠を使い切らないよう、「解析できたページ数」で上限を数える
  let analyzed = 0, attempts = 0, softNotFound = 0;
  const seenText = new Set();
  for (const url of queue) {
    if (analyzed >= MAX_PAGES || attempts >= MAX_PAGES * 2 + 4) break;
    if (!htmlByUrl[url]) {
      let u; try { u = new URL(url); } catch (_) { continue; }
      if (robots && !isAllowed(robots, cfg.USER_AGENT, u.pathname)) continue;
      attempts++;
      await sleep(cfg.POLITE_DELAY_MS);
      try { const p = await fetchPage(url); htmlByUrl[url] = p.html; } catch (_) { continue; }
    }
    const html = htmlByUrl[url];
    const text = extractText(html);
    if (!text || text.length < 40) continue;
    // soft-404: 存在しないパスに同一の「見つかりません」本文を200で返すサイト。
    // 同じ本文が繰り返されたら、そのサイトでの推測パス巡回は無意味なので打ち切る。
    const sig = text.length + '|' + text.slice(0, 120);
    if (seenText.has(sig)) { if (++softNotFound >= 2) break; continue; }
    seenText.add(sig);
    analyzed++;
    // 会社概要ページ等でも社名照合を試す（トップがロゴ画像だけの場合の救済）
    if (!matched) matched = strictMatch(companyName, '', text);

    if (cfg.USE_STRUCTURED) {
      const org = structured.extractOrganization(html);
      const n = org && org.telephone ? normalizeJpPhone(org.telephone) : null;
      if (n) put({ phone: n, method: 'JSON-LD', url, score: 12, evidence: 'schema.org Organization.telephone' });
    }
    const boost = PAGE_PRIORITY.test(url) ? 2 : 0;
    for (const c of scanPhones(html, text, boost)) {
      put({ phone: c.phone, method: c.source, url, score: c.score, evidence: c.evidence });
    }
    // 固定電話が十分な確度で取れたら早期終了（無駄な巡回をしない）
    if ([...found.values()].some((c) => phoneTier(c.phone) === 4 && c.score >= 8)) break;
  }

  if (DEBUG) log(`    [debug] ${companyName} @${homepageUrl} queue=${queue.length} analyzed=${analyzed} found=${[...found.keys()].join(',') || 'なし'}`);
  // 支店一覧ページ等で複数番号が並ぶとき、BALES登録の所在地と市外局番が合う番号を優先する
  // （親会社サイトの別支店番号を掴むのを防ぐ）
  for (const c of found.values()) {
    if (prefHint && prefectureForNumber(c.phone) === prefHint) c.score += 3;
  }
  const all = [...found.values()].sort((a, b) => (phoneTier(b.phone) - phoneTier(a.phone)) || (b.score - a.score));
  const base = { matched, loose, finalUrl: home.finalUrl || homepageUrl };
  if (!all.length) return { ...base, phone: null };
  return { ...base, ...all[0], others: all.slice(1, 4).map((c) => c.phone) };
}

const searchHits = new Map(); // 検索が返したURL -> 回数（汚染検知）

// Bing の HTML エンドポイントは日本語社名を分かち書きしてしまい、解決できない社名では
// 「株式会社」だけにマッチした一般解説ページを返す。この定番セットが出たら結果は無効とみなす。
const POISON = /(ht-tax\.or\.jp\/kigyou-guide|mizuhobank\.co\.jp\/corporate\/account\/tips|wikipedia\.org\/wiki\/%E6%A0%AA%E5%BC%8F%E4%BC%9A%E7%A4%BE|yayoi-kk\.co\.jp\/kigyo)/i;
const isPoisoned = (results) => results.slice(0, 3).filter((r) => POISON.test(r.url || '')).length >= 2;

/**
 * 公式サイトを検索で特定する（社名がページに出ることを確認してから返す）。
 * クエリは「社名そのまま」→「法人格を外した社名」の順。修飾語を足すと Bing の
 * 分かち書きが悪化して無関係な結果になるため、余計な語は付けない。
 */
async function findOfficialSite(name) {
  const core = companyCore(name);
  const queries = [name, core && core !== name ? core : ''].filter(Boolean);
  let results = [];
  for (const q of queries) {
    let r = [];
    try { r = await runSearch(q); } catch (_) { r = []; }
    if (r.length && !isPoisoned(r)) { results = r; break; }
    await sleep(cfg.SEARCH_DELAY_MS);
  }
  if (!results.length) return null;

  const scored = scoreCandidates(results.slice(0, cfg.SEARCH_MAX_CANDIDATES), name) || [];
  for (const cand of scored.slice(0, cfg.SEARCH_VERIFY_TOP)) {
    let origin;
    try { origin = new URL(cand.url).origin; } catch (_) { continue; }
    if (NOT_OFFICIAL.test(origin) || POISON.test(origin)) continue;
    const c = (searchHits.get(origin) || 0) + 1;
    searchHits.set(origin, c);
    if (c >= 4) continue; // 別会社でも同じサイトが出続ける＝検索結果が壊れている
    try {
      const p = await fetchPage(origin);
      const text = extractText(p.html || '');
      const title = (String(p.html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
      if (strictMatch(name, title, text)) return { url: p.finalUrl || origin };
    } catch (_) { /* 次の候補へ */ }
    await sleep(cfg.SEARCH_DELAY_MS);
  }
  return null;
}

/** 公式URL候補を順に試して電話を取る（社名の裏取りができない番号は採らない） */
async function resolveCompany(row) {
  const name = row[C.name];
  const tried = [];
  const candidates = [];
  const web = String(row[C.web] || '').trim();
  if (web && !NOT_OFFICIAL.test(web)) candidates.push({ url: /^https?:\/\//i.test(web) ? web : 'https://' + web, via: 'BALESのWebサイト列' });
  const d = domainFromEmail(row[C.mail]);
  if (d && !candidates.some((c) => c.url.includes(d))) candidates.push({ url: 'https://' + d, via: '担当者メールのドメイン' });
  // メールが recruit@sub.example.co.jp のような下位ドメインなら親ドメインも候補に
  const parent = d && d.split('.').length > 3 ? d.split('.').slice(1).join('.') : '';
  if (parent && !candidates.some((c) => c.url.includes(parent))) candidates.push({ url: 'https://' + parent, via: '担当者メールの親ドメイン' });

  // ①②はCRM側に「この会社のサイト/メール」として記録がある＝身元の裏付けがある経路
  for (const c of candidates) {
    tried.push(c.url);
    const r = await crawlPhone(c.url, name, row[C.pref]).catch(() => null);
    if (r && r.phone) return { ...r, via: c.via, tried };
  }
  // ③検索経由は身元の裏付けが無いので、社名照合を通ったサイトしか使わない
  let hit = null;
  try { hit = await findOfficialSite(name); } catch (_) {}
  if (hit && hit.url && !tried.includes(hit.url)) {
    tried.push(hit.url);
    const r = await crawlPhone(hit.url, name, row[C.pref]).catch(() => null);
    if (r && r.phone) return { ...r, via: '検索で発見（社名照合OK）', tried };
    return { phone: null, tried, rejected: `公式サイト ${hit.url} は特定できたが電話番号の記載が見つからず` };
  }
  return { phone: null, tried, rejected: tried.length ? '' : '公式サイトを特定できず（検索で社名照合が通るサイトなし）' };
}

// ── 対象読み込み ─────────────────────────────────────────────────
if (!fs.existsSync(IN)) { console.error(`[fixphone] ✗ 入力が見つかりません: ${IN}\n  → 先に node src/build-badnumber-list.js を実行してください。`); process.exit(1); }
const { records: listRows } = readCsv(fs.readFileSync(IN, 'utf8'));
const targetsRaw = listRows.filter((r) => CATEGORY === 'all' || r['区分'] === CATEGORY);
if (!targetsRaw.length) { console.error(`[fixphone] ✗ 区分「${CATEGORY}」の行がありません`); process.exit(1); }

// BALES原本を ID で引けるようにする（266列の取込用CSVを出すため）
const { headers: BH, records: baleRecs } = readCsv(fs.readFileSync(BALES, 'utf8'));
const byId = new Map(baleRecs.map((r) => [String(r[C.id] || '').trim(), r]));

// レビューCSVの列名 → BALES列名 に合わせた作業レコード
const targets = targetsRaw.map((r) => ({
  [C.id]: r['リードID'], [C.name]: r['会社名'], [C.phone]: r['電話'], [C.web]: r['Webサイト'],
  [C.mail]: r['メール'], [C.pref]: r['都道府県'], [C.city]: r['市区郡'],
  [C.sei]: r['担当者姓'], [C.mei]: r['担当者名'], [C.url]: r['リードURL'],
  区分: r['区分'], 根拠テキスト: r['根拠テキスト'],
})).slice(0, LIMIT || undefined);

// ── ジャーナル（再開可）────────────────────────────────────────
let done = new Map();
if (!NO_RESUME && fs.existsSync(JOURNAL)) {
  try { for (const r of JSON.parse(fs.readFileSync(JOURNAL, 'utf8'))) done.set(String(r.リードID), r); } catch (_) {}
}

function classify(row, res, areaPref) {
  const old = row[C.phone];
  if (!res || !res.phone) return '取得できず';
  if (same(res.phone, old)) return '旧番号と同一（要現地確認）';
  // CRM記録のサイト/メールドメインから取れたが、そのページに社名が出ていないケース。
  // 共有ポータル（例: 販売店共通サイト）を掴んでいる可能性があるので取込対象から外す。
  if (!res.matched) return '要確認（社名照合NG）';
  // 市外局番の地域がBALES登録の所在地と食い違う＝親会社/別支店の番号を掴んだ可能性
  if (areaPref && row[C.pref] && areaPref !== row[C.pref]) return '要確認（所在地と市外局番が不一致）';
  return old ? '新番号を取得（要差し替え）' : '新規に電話を取得';
}

function flush() {
  const rows = [...done.values()];
  const H = ['判定', '区分', '会社名', '旧電話（不備）', '新電話', '確度', '社名照合', '番号種別', '抽出方式', '抽出箇所', '到達経路', '根拠URL',
    '市外局番の都道府県', 'BALES都道府県', '住所整合', '他の候補番号', '担当者姓', '担当者名', 'メール', '旧Webサイト', '確定サイト',
    '不備の記録', '不採用の理由', 'リードURL', 'リードID'];
  const order = { '新番号を取得（要差し替え）': 0, '新規に電話を取得': 1, '要確認（所在地と市外局番が不一致）': 2, '要確認（社名照合NG）': 3, '旧番号と同一（要現地確認）': 4, '取得できず': 5 };
  rows.sort((a, b) => (order[a.判定] - order[b.判定]) || String(a.会社名).localeCompare(String(b.会社名), 'ja'));
  fs.writeFileSync(OUT, '﻿' + toCsv(H, rows.map((r) => { const o = {}; H.forEach((h) => { o[h] = r[h] == null ? '' : r[h]; }); return o; })), 'utf8');
  fs.writeFileSync(JOURNAL, JSON.stringify(rows), 'utf8');

  // BALES 266列（社名照合まで通った新番号のみ・会社情報：電話を差し替え済み）
  const fixed = rows.filter((r) => r.新電話 && (r.判定 === '新番号を取得（要差し替え）' || r.判定 === '新規に電話を取得'));
  const outRecs = [];
  fixed.forEach((r, i) => {
    const src = byId.get(String(r.リードID));
    if (!src) return;
    const o = {};
    for (const h of BH) o[h] = src[h] == null ? '' : src[h];
    o[C.phone] = r.新電話;
    if (r['確定サイト'] && !o[C.web]) o[C.web] = r['確定サイト'];
    o[C.no] = String(outRecs.length + 1);
    outRecs.push(o);
  });
  fs.writeFileSync(BALES_OUT, '﻿' + toCsv(BH, outRecs), 'utf8');
  return { rows, fixedCount: outRecs.length };
}

// ── 実行 ─────────────────────────────────────────────────────────
async function main() {
  const todo = targets.filter((t) => !done.has(String(t[C.id])));
  log(`===== 番号不備の電話再取得 開始 ｜ 対象${targets.length}社（未処理${todo.length}／済${targets.length - todo.length}） ｜ 並列${CONC} =====`);
  let i = 0, n = 0;
  const t0 = Date.now();

  async function worker() {
    while (i < todo.length) {
      const row = todo[i++];
      const name = row[C.name];
      let res = null;
      try { res = await resolveCompany(row); } catch (e) { log(`  ✗ ${name}: ${e && e.message}`); }
      const areaPref = res && res.phone ? (prefectureForNumber(res.phone) || '') : '';
      const balesPref = row[C.pref] || '';
      const judged = classify(row, res, areaPref);
      done.set(String(row[C.id]), {
        判定: judged,
        区分: row.区分,
        会社名: name,
        '旧電話（不備）': row[C.phone],
        新電話: (res && res.phone) || '',
        確度: res && res.phone ? (res.method === 'JSON-LD' ? '高（構造化データ）' : (res.score >= 8 ? '高' : res.score >= 4 ? '中' : '低')) : '',
        社名照合: res && res.phone ? (res.matched ? '一致' : (res.loose ? '部分一致（要確認）' : '照合不可（要確認）')) : '',
        番号種別: res && res.phone ? TIER_LABEL[phoneTier(res.phone)] : '',
        抽出方式: (res && res.method) || '',
        '抽出箇所': (res && res.evidence) || '',
        到達経路: (res && res.via) || (res && res.tried && res.tried.length ? '候補サイトから電話取得できず' : '公式サイト未特定'),
        根拠URL: (res && res.url) || '',
        '市外局番の都道府県': areaPref,
        BALES都道府県: balesPref,
        住所整合: !areaPref || !balesPref ? '—' : (areaPref === balesPref ? '一致' : `不一致（${areaPref}）`),
        '他の候補番号': (res && res.others && res.others.join(' / ')) || '',
        担当者姓: row[C.sei], 担当者名: row[C.mei], メール: row[C.mail],
        旧Webサイト: row[C.web], 確定サイト: (res && res.finalUrl) || '',
        '不備の記録': row.根拠テキスト,
        '不採用の理由': (res && res.rejected) || '',
        リードURL: row[C.url], リードID: row[C.id],
      });
      n++;
      if (n % 5 === 0) flush();
      if (n % 10 === 0 || n === todo.length) {
        const got = [...done.values()].filter((r) => r.新電話).length;
        const el = (Date.now() - t0) / 1000;
        const eta = n ? Math.round((el / n) * (todo.length - n) / 60) : 0;
        log(`  進捗 ${n}/${todo.length}｜取得済 ${got}社（${Math.round(got / done.size * 100)}%）｜残り約${eta}分`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, todo.length)) }, () => worker()));

  const { rows, fixedCount } = flush();
  try { await closeBrowser(); } catch (_) {}

  const t = (fn) => { const m = {}; for (const r of rows) { const k = fn(r) || '(なし)'; m[k] = (m[k] || 0) + 1; } return m; };
  const byJudge = t((r) => r.判定);
  const got = rows.filter((r) => r.新電話).length;
  console.log(`\n─────────────────────────────────────────────`);
  console.log(`[fixphone] 番号不備リードの電話再取得 結果`);
  console.log(`─────────────────────────────────────────────`);
  console.log(`  対象                          ${rows.length}社（区分: ${CATEGORY}）`);
  for (const [k, v] of Object.entries(byJudge).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}社  ${k}`);
  console.log(`\n  電話取得率                    ${got}/${rows.length}（${Math.round(got / rows.length * 100)}%）`);
  console.log(`  確度内訳                      ${Object.entries(t((r) => r.確度)).filter(([k]) => k !== '(なし)').map(([k, v]) => `${k}:${v}`).join(' / ') || '—'}`);
  console.log(`  社名照合                      ${Object.entries(t((r) => r.社名照合)).filter(([k]) => k !== '(なし)').map(([k, v]) => `${k}:${v}`).join(' / ') || '—'}`);
  console.log(`  番号種別                      ${Object.entries(t((r) => r.番号種別)).filter(([k]) => k !== '(なし)').map(([k, v]) => `${k}:${v}`).join(' / ') || '—'}`);
  console.log(`  到達経路                      ${Object.entries(t((r) => r.到達経路)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
  console.log(`  住所整合（市外局番×都道府県） ${Object.entries(t((r) => r.住所整合)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
  console.log(`\n[fixphone] out: ${path.relative(ROOT, OUT)}（レビュー用・旧番号と新番号を並記）`);
  console.log(`[fixphone] out: ${path.relative(ROOT, BALES_OUT)}（${BH.length}列・電話差し替え済み ${fixedCount}社・BALES取込用）`);
}

main().catch((e) => { log('✗ ' + (e && e.stack ? e.stack : e)); process.exit(1); });
