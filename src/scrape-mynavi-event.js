'use strict';
/**
 * マイナビ 合同説明会（就職セミナー/EXPO）出展企業スクレイパ
 * ===============================================================
 * イベントページ → 出展企業一覧 → 各社のマイナビ企業ページ を辿り、
 * スプレッドシート「大阪10/2」形式（企業名/電話番号/採用人数/従業員数/メールアドレス/担当者名）で出力する。
 *
 * ── 実DOMフロー（2026-09 実地調査で確定）──────────────────────────
 *   0. イベント一覧: https://job.mynavi.jp/conts/2027/event/ は JS 描画。
 *      データ本体は  /conts/event/2027/kanri/event_data.js（var EVENT_DATA=[...]）にある。
 *   1. イベント詳細: /conts/event/2027/{eventId}/index.html（出展企業は「一部抜粋」のみ）
 *   2. 出展企業一覧(全件): https://jobevent.mynavi.jp/conts/event/2027list/list.php?ev={eventId}
 *      → <em class="result-area-corp-name">社名</em> と corp{ID}/outline.html リンク（50件/頁）
 *   3. 企業ページ（静的HTMLで取得可）
 *      outline.html    … <h1>掲載社名</h1>, <dt>従業員</dt><dd>, <dt>募集人数</dt><dd>, 会社データ表の本社電話番号
 *      employment.html … 募集コースへのリンク displayEmployment/index/?corpId=&recruitingCourseId=
 *      displayEmployment … td#accessInfoListDescText110 (問合せ先: 部署/担当者/TEL/MAIL/住所), td#accessInfoListDescText130 (E-MAIL)
 *
 * 使い方:
 *   node src/scrape-mynavi-event.js --event https://job.mynavi.jp/conts/event/2027/11032/index.html
 *   node src/scrape-mynavi-event.js --event 11032,10509
 *   node src/scrape-mynavi-event.js --all            # event_data.js の全イベント
 *   node src/scrape-mynavi-event.js --list-events    # イベント一覧を表示するだけ
 * 出力: data/mynavi-events/{eventId}_{会場}_{開催日}.csv（BOM付きUTF-8）＋ all-events.csv
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { toCsv } = require('./csv');
const { normalizeJpPhone, toHalfWidth } = require('./phone');
const { prefectureForNumber } = require('./areacode');
const { splitName, isFullName, completeSurname, isNonPersonWord, isPlausiblePersonName, stripNonName } = require('./jp-names');

// ── 較正ポイント（実DOMに合わせてここだけ直す）─────────────────────
const CONFIG = {
  gradYear: process.env.MYNAVI_GRAD_YEAR || '27',                 // 企業ページの卒年（job.mynavi.jp/27/...）
  contsYear: process.env.MYNAVI_CONTS_YEAR || '2027',             // イベントコンテンツの年（/conts/event/2027/...）
  eventDataUrl: (cy) => `https://job.mynavi.jp/conts/event/${cy}/kanri/event_data.js`,
  eventDetailUrl: (cy, id) => `https://job.mynavi.jp/conts/event/${cy}/${id}/index.html`,
  exhibitListUrl: (cy, id) => `https://jobevent.mynavi.jp/conts/event/${cy}list/list.php?ev=${id}`,
  outlineUrl: (gy, id) => `https://job.mynavi.jp/${gy}/pc/search/corp${id}/outline.html`,
  employmentUrl: (gy, id) => `https://job.mynavi.jp/${gy}/pc/search/corp${id}/employment.html`,
  courseLinkRe: /\/corpinfo\/displayEmployment\/index\/?\?corpId=(\d+)&(?:amp;)?recruitingCourseId=(\d+)/g,
  maxCoursesPerCorp: parseInt(process.env.MYNAVI_MAX_COURSES || '6', 10),
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  delayMs: parseInt(process.env.MYNAVI_EVENT_DELAY_MS || '1500', 10),
  cacheDir: path.resolve(__dirname, '..', 'data', 'mynavi-event-cache'),
  cacheTtlMs: parseInt(process.env.MYNAVI_EVENT_CACHE_TTL_MS || String(3 * 24 * 3600 * 1000), 10),
  outDir: path.resolve(__dirname, '..', 'data', 'mynavi-events'),
};

// スプレッドシート「大阪10/2」と同じ先頭6列。以降は検証用の補助列。
const SHEET_HEADERS = ['企業名', '電話番号', '採用人数', '従業員数', 'メールアドレス', '担当者名'];
const EXTRA_HEADERS = ['担当部署', '問合せ先原文', '本社電話番号', '電話番号候補', '従業員数原文', '掲載社名', '業種', 'ブース', '出展日',
  'マイナビURL', 'corpId', 'イベントID', 'イベント名', '開催日', '会場', '都道府県', '取得日'];
const HEADERS = [...SHEET_HEADERS, ...EXTRA_HEADERS];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 取得（ディスクキャッシュ＋間隔＋リトライ）──────────────────────
let lastFetchAt = 0;
async function fetchHtml(url, { noCache = false } = {}) {
  fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const file = path.join(CONFIG.cacheDir, key + '.html');
  if (!noCache && fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < CONFIG.cacheTtlMs) return fs.readFileSync(file, 'utf8');
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = CONFIG.delayMs - (Date.now() - lastFetchAt);
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, 'Accept-Language': 'ja,en;q=0.8' }, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      fs.writeFileSync(file, html);
      return html;
    } catch (e) {
      lastErr = e;
      await sleep(2000 * (attempt + 1));
    } finally { clearTimeout(t); }
  }
  throw new Error(`fetch failed ${url}: ${lastErr && lastErr.message}`);
}

// ── イベント一覧（event_data.js）──────────────────────────────────
async function loadEventData(opts = {}) {
  const src = await fetchHtml(CONFIG.eventDataUrl(CONFIG.contsYear), opts);
  let arr;
  try { arr = new Function(src + ';return EVENT_DATA;')(); } catch (e) { throw new Error('event_data.js の解析に失敗: ' + e.message); }
  return arr.map((e) => ({
    eventId: String(e.event_id),
    title: e.title || '',
    pref: e.pref || '',
    city: e.city || '',
    series: e.series || '',
    status: e.status || '',
    date: e.date1 ? fmtDate(new Date(e.date1)) : '',
    place: e.place || '',
    detailUrl: e.detail_url ? new URL(e.detail_url, 'https://job.mynavi.jp/').href : CONFIG.eventDetailUrl(CONFIG.contsYear, e.event_id),
    exhibitListUrl: e.exhibit_list_url || '',
  }));
}
function fmtDate(d) {
  // 日本時間の日付（date1 は JST 0:00 のepoch）
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}/${String(j.getUTCMonth() + 1).padStart(2, '0')}/${String(j.getUTCDate()).padStart(2, '0')}`;
}

function eventIdFrom(input) {
  const s = String(input || '').trim();
  const m = s.match(/event\/\d{4}\/(\d+)\b/) || s.match(/[?&]ev=(\d+)/) || s.match(/^(\d{3,6})$/);
  return m ? m[1] : '';
}

// イベント詳細ページから題名・会場などを補完（event_data に無いイベントID向けフォールバック）
async function fetchEventMeta(eventId, opts) {
  const html = await fetchHtml(CONFIG.eventDetailUrl(CONFIG.contsYear, eventId), opts);
  const $ = cheerio.load(html);
  const title = ($('meta[property="og:title"]').attr('content') || $('title').text() || '').replace(/\s*-\s*マイナビ\d{4}\s*$/, '').trim();
  const text = $('body').text().replace(/\s+/g, ' ');
  const dm = text.match(/(\d{1,2})月(\d{1,2})日/);
  return { eventId, title, pref: '', date: dm ? `${CONFIG.contsYear}/${dm[1].padStart(2, '0')}/${dm[2].padStart(2, '0')}` : '', place: '', detailUrl: CONFIG.eventDetailUrl(CONFIG.contsYear, eventId) };
}

// ── 出展企業一覧（list.php、50件/頁）─────────────────────────────
async function fetchExhibitors(eventId, opts) {
  const first = CONFIG.exhibitListUrl(CONFIG.contsYear, eventId);
  const seenUrl = new Set();
  const queue = [first];
  const out = [];
  const seenCorp = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);
    $('table tr').each((_, tr) => {
      const $tr = $(tr);
      const link = $tr.find('a[href*="/outline.html"]').attr('href') || '';
      const m = link.match(/corp(\d+)\/outline\.html/);
      const tds = $tr.find('td');
      const name = $tr.find('.result-area-corp-name').first().text().replace(/\s+/g, ' ').trim();
      if (!name) return;
      // 「詳細を見る」が btn-disabled（マイナビ企業ページ未公開）の出展社は社名のみで保持する
      const corpId = m ? m[1] : '';
      const catchCopy = $tr.find('.result-area-corp-name').first().parent().find('div').first().text().replace(/\s+/g, ' ').trim();
      const booth = tds.eq(0).text().replace(/\s+/g, ' ').trim();
      const area = tds.eq(1).text().replace(/\s+/g, ' ').trim();
      const day = tds.eq(2).text().replace(/\s+/g, ' ').trim();
      // 業種: 社名セルの次の td
      let industry = '';
      tds.each((i, td) => { if ($(td).find('.result-area-corp-name').length) industry = tds.eq(i + 1).text().replace(/\s+/g, ' ').trim(); });
      const key = corpId || 'name:' + name;
      if (seenCorp.has(key)) return;
      seenCorp.add(key);
      out.push({ corpId, 掲載社名: name, キャッチ: catchCopy, ブース: booth, エリア: area, 出展日: day, 業種: industry, outlineUrl: link });
    });
    // ページャ（次の50件）のリンクを辿る
    $('a[href*="list.php"]').each((_, a) => {
      const href = $(a).attr('href');
      try { const u = new URL(href, url).href; if (!seenUrl.has(u) && /[?&]ev=/.test(u)) queue.push(u); } catch (_) {}
    });
  }
  return out;
}

// ── 社名→corpId（フリーワード検索。一覧に企業ページリンクが無い出展社向けフォールバック）──
function normName(s) {
  return toHalfWidth(String(s || '')).replace(/【[^】]*】|〈[^〉]*〉|＜[^＞]*＞|\[[^\]]*\]|[（(][^）)]*[）)]/g, '')
    .replace(/株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|医療法人|学校法人|NPO法人|特定非営利活動法人/g, '')
    .replace(/[\s　・･\-－‐/／、,，]/g, '').toLowerCase();
}
async function searchCorpId(name, opts) {
  const q = normName(name).slice(0, 30);
  if (!q) return '';
  const url = `https://job.mynavi.jp/${CONFIG.gradYear}/pc/corpinfo/searchCorpListByGenCond/index?actionMode=searchFw&srchWord=${encodeURIComponent(q)}`;
  let html;
  try { html = await fetchHtml(url, opts); } catch (_) { return ''; }
  const $ = cheerio.load(html);
  const hits = [];
  $('a[href*="/outline.html"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/corp(\d+)\/outline\.html/);
    const t = normName($(a).text());
    if (m && t && (t === q || t.includes(q) || q.includes(t))) hits.push({ id: m[1], exact: t === q });
  });
  const ids = [...new Set(hits.filter((h) => h.exact).map((h) => h.id))];
  if (ids.length === 1) return ids[0];
  const any = [...new Set(hits.map((h) => h.id))];
  return any.length === 1 ? any[0] : '';
}

// ── 企業ページ ─────────────────────────────────────────────────
function textOf($el) {
  // <br> を改行として残しつつテキスト化
  const html = ($el.html() || '').replace(/<br\s*\/?>/gi, '\n');
  return cheerio.load('<div>' + html + '</div>')('div').text().replace(/[ \t　]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function fetchCorp(corpId, opts) {
  const gy = CONFIG.gradYear;
  const r = { corpId, 掲載社名: '', 従業員数原文: '', 募集人数: '', 本社電話番号: '', 本社所在地: '', courses: [], マイナビURL: CONFIG.outlineUrl(gy, corpId) };
  // outline.html
  try {
    const html = await fetchHtml(CONFIG.outlineUrl(gy, corpId), opts);
    const $ = cheerio.load(html);
    r.掲載社名 = $('h1').first().text().replace(/\s+/g, ' ').trim();
    $('dl').each((_, dl) => {
      const dt = $(dl).find('dt').first().text().trim();
      const dd = $(dl).find('dd').first().text().replace(/\s+/g, ' ').trim();
      if (dt === '従業員' && !r.従業員数原文) r.従業員数原文 = dd;
      if (dt === '募集人数' && !r.募集人数) r.募集人数 = dd;
    });
    $('th[id^="corpDescDtoListDescTitle"]').each((_, th) => {
      const k = $(th).text().trim();
      const v = $(th).next('td').text().replace(/\s+/g, ' ').trim();
      if (k === '本社電話番号') r.本社電話番号 = v;
      if (k === '本社所在地') r.本社所在地 = v;
      if (k === '従業員' && !r.従業員数原文) r.従業員数原文 = v;
    });
  } catch (e) { r.error = 'outline: ' + e.message; }
  // employment.html → 各募集コース
  try {
    const html = await fetchHtml(CONFIG.employmentUrl(gy, corpId), opts);
    const ids = new Set();
    let m;
    const re = new RegExp(CONFIG.courseLinkRe.source, 'g');
    while ((m = re.exec(html))) if (m[1] === String(corpId)) ids.add(m[2]);
    for (const courseId of [...ids].slice(0, CONFIG.maxCoursesPerCorp)) {
      const url = `https://job.mynavi.jp/${gy}/pc/corpinfo/displayEmployment/index/?corpId=${corpId}&recruitingCourseId=${courseId}`;
      try {
        const ch = await fetchHtml(url, opts);
        const $ = cheerio.load(ch);
        const contact = textOf($('#accessInfoListDescText110'));
        const email = $('#accessInfoListDescText130').text().trim();
        let hire = '';
        // 募集コース面: <td class="heading">募集人数</td><td class="sameSize">101～200名</td>（th/dt の旧レイアウトも許容）
        $('td.heading, th, dt').each((_, el) => {
          if ($(el).text().trim() === '募集人数' && !hire) hire = ($(el).is('dt') ? $(el).next('dd') : $(el).next('td')).text().replace(/\s+/g, ' ').trim();
        });
        r.courses.push({ courseId, url, 問合せ先: contact, メール: email, 募集人数: hire });
      } catch (e) { r.courses.push({ courseId, url, error: e.message }); }
    }
  } catch (e) { r.error = (r.error ? r.error + ' / ' : '') + 'employment: ' + e.message; }
  return r;
}

// ── 整形 ───────────────────────────────────────────────────────
// 掲載社名「(株)システムリサーチ【東証プライム上場】」→「株式会社システムリサーチ」
const CORP_ABBR = { '株': '株式会社', '有': '有限会社', '同': '合同会社', '合': '合資会社', '医': '医療法人', '社': '社会福祉法人', '学': '学校法人', '財': '財団法人', '一財': '一般財団法人', '公財': '公益財団法人', '一社': '一般社団法人', '公社': '公益社団法人', '福': '社会福祉法人', '独': '独立行政法人', '宗': '宗教法人', '協': '協同組合', '農': '農業協同組合', '特非': '特定非営利活動法人', 'N': 'NPO法人' };
function formalCompanyName(raw) {
  let s = String(raw || '').replace(/【[^】]*】|〈[^〉]*〉|＜[^＞]*＞|\[[^\]]*\]/g, '').replace(/\s+/g, '').trim();
  const head = s.match(/^[（(]([^）)]{1,3})[）)]/);
  if (head && CORP_ABBR[head[1]]) s = CORP_ABBR[head[1]] + s.slice(head[0].length);
  const tail = s.match(/[（(]([^）)]{1,3})[）)]$/);
  if (tail && CORP_ABBR[tail[1]]) s = s.slice(0, s.length - tail[0].length) + CORP_ABBR[tail[1]];
  return s;
}

function employeeCount(raw) {
  const t = toHalfWidth(String(raw || '')).replace(/，/g, ',');
  const m = t.match(/([0-9][0-9,]{0,8})\s*[名人]/) || t.match(/([0-9][0-9,]{0,8})/);
  if (!m) return '';
  const n = m[1].replace(/,/g, '');
  return /^\d+$/.test(n) ? n : '';
}

const PHONE_RE = /0\d{1,4}[-‐－―ー()（）]?\d{1,4}[-‐－―ー()（）]?\d{3,4}/g;
function phonesIn(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (/FAX|Fax|fax|ファックス|ＦＡＸ/.test(line) && !/TEL|Tel|tel|電話|ＴＥＬ/.test(line)) continue;
    const half = toHalfWidth(line);
    for (const m of half.match(PHONE_RE) || []) {
      const n = normalizeJpPhone(m);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}
// 電話番号の選定: 問合せ先TEL（イベント県の市外局番 > 固定 > フリーダイヤル > 携帯） > 本社電話番号
function pickPhone(candidates, hqPhone, pref) {
  const rank = (p) => {
    let s = 0;
    if (/^(0120|0800)/.test(p)) s += 20; else if (/^0[5789]0/.test(p)) s += 30;
    if (pref && prefectureForNumber(p) === pref) s -= 100;
    return s;
  };
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
  if (sorted.length) return sorted[0];
  const hq = phonesIn(hqPhone);
  return hq[0] || '';
}

// 問合せ先テキストから 部署＋担当者名 を取り出す
const NON_INFO_LINE = /^[【\[（(]?\s*(MAIL|Mail|mail|E-?MAIL|E-?mail|e-?mail|メール|TEL|Tel|tel|電話|ＴＥＬ|FAX|Fax|ＦＡＸ|Free|フリーダイヤル|住所|所在地|URL|HP|ホームページ|受付時間|営業時間|〒|アクセス|最寄)/;
const DEPT_HINT = /人事|採用|総務|管理|人材|人財|労務|経営|企画|広報|教育|事務局|本部|本社|部|課|室|グループ|チーム|センター|係|担当/;
const NAME_SPLIT = /[・･、,，／/&＆]|\s+|および|及び|または|又は/;
const NON_NAME_WORD = /^(部署|担当|平日|土日|祝日|本社|支社|支店|代表|直通|受付|窓口|時間|係|以外|不在|各位|御中|人事|採用|総務|管理|営業|事務|本部|部門|内線|携帯|留守|電話|連絡|問合|返信|対応)$/;
function parseContact(text, companyName = '') {
  const out = { 担当者名: '', 担当部署: '' };
  const coNorm = normName(companyName);
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const names = [];
  const depts = [];
  for (let line of lines) {
    if (NON_INFO_LINE.test(line)) continue;
    // メール/電話/URL/ラベルを剥がしてから評価（「人事総務部 野崎瑠美 03-xxxx saiyo@…」型の1行問合せ先に対応）
    let body = toHalfWidth(line)
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(PHONE_RE, ' ')
      .replace(/【[^】]*】|\[[^\]]*\]/g, ' ')
      .replace(/(TEL|Tel|tel|FAX|Fax|fax|MAIL|Mail|mail|E-?MAIL|E-?mail|URL)\s*[:：]?/g, ' ')
      .replace(/[（(][^）)]{0,4}[）)]/g, ' ')                                                 // 短い注記 (株)(代)(本社) は除去
      .replace(/[（(）)]/g, ' ・ ')                                                           // 長い括弧「総務部（渡辺・村越）」は区切りとして残す
      .replace(/\s+/g, ' ').trim();
    if (body.replace(/[^一-龥々ぁ-んァ-ヶ]/g, '').length < 2) continue;                      // 番号/記号だけの行
    if (/^〒|[都道府県].{0,12}[市区郡町村].*\d/.test(body) && !/担当/.test(body)) continue;   // 住所行
    // 「採用担当：吉本・黒川・石浦」「人事部 田中」「総務部　渡邊」「担当/山田まで」
    // 部署: 役割語の前まで
    const dm = body.match(/^(.*?(?:部|課|室|グループ|チーム|センター|係|本部|事務局|担当窓口|担当者?|担当))\s*[:：／/]?\s*(.*)$/);
    let deptPart = '', namePart = body;
    if (dm) { deptPart = dm[1].trim(); namePart = dm[2].trim(); }
    const anchored = /担当|人事|採用|総務|管理|人材|人財|部|課|室/.test(deptPart) || /担当/.test(body);
    if (deptPart && DEPT_HINT.test(deptPart)) depts.push(deptPart.replace(/[:：]$/, ''));
    for (const tok of namePart.split(NAME_SPLIT).map((t) => t.trim()).filter(Boolean)) {
      const nm = cleanNameToken(tok, anchored);
      if (!nm || names.includes(nm)) continue;
      const nmNorm = normName(nm);
      if (coNorm && nmNorm && (coNorm === nmNorm || coNorm.includes(nmNorm) && nmNorm.length >= 2 && coNorm.length <= nmNorm.length + 4)) continue; // 社名（池田ハルク/佐藤信）を人名にしない
      names.push(nm);
    }
  }
  out.担当者名 = names.join('・');
  out.担当部署 = [...new Set(depts)].join(' / ');
  return out;
}
function cleanNameToken(tok, anchored) {
  let s = String(tok || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s/g, '');
  s = s.replace(/(様|さん|殿|氏|まで|宛|宛て|迄)$/g, '').replace(/^(ご?担当者?[:：]?)/, '');
  s = stripNonName(s).replace(/\s/g, '');
  if (!s || s.length < 2 || s.length > 6) return '';
  if (!/^[一-龥々ぁ-んァ-ヶー]+$/.test(s)) return '';
  if (/^[ぁ-んァ-ヶー]+$/.test(s)) return '';                       // かな/カナだけの語（グループ/チーム等）
  if (NON_NAME_WORD.test(s) || isNonPersonWord(s) || !isPlausiblePersonName(s)) return '';
  if (/(部|課|室|係|科|局|店|所|社|会|法人|センター|グループ|チーム|窓口|事務|本部|支店|営業所)$/.test(s)) return '';
  // 2〜3字は「姓のみ」を優先（南出/小山田/渡邊 を 南 出/小山 田/渡辺 に壊さない。表記は原文のまま返す）
  if (s.length <= 3 && completeSurname(s)) return s;
  if (s.length === 2) return /^[一-龥々]{2}$/.test(s) && (anchored || completeSurname(s)) ? s : ''; // 2字は分割しない
  // 氏名は原文表記のまま（スプシも「野崎瑠美」形式。小山田→小山 田 のような誤分割も避ける）
  if (isFullName(s) || completeSurname(s)) return s;
  if (anchored && /^[一-龥々]{2,4}$/.test(s)) return s;              // 構造アンカー付きなら辞書外姓も許容
  return '';
}

function buildRow(ev, ex, corp) {
  const contacts = corp.courses.filter((c) => c.問合せ先);
  const contactText = [...new Set(contacts.map((c) => c.問合せ先))].join('\n---\n');
  const parsed = parseContact(contactText, corp.掲載社名 || ex.掲載社名);
  const phoneCands = [];
  for (const c of contacts) for (const p of phonesIn(c.問合せ先)) if (!phoneCands.includes(p)) phoneCands.push(p);
  const emails = [];
  for (const c of corp.courses) {
    for (const e of [c.メール, ...(String(c.問合せ先 || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])]) {
      const v = String(e || '').trim().toLowerCase();
      if (v && !emails.includes(v)) emails.push(v);
    }
  }
  // 採用人数: outline の「募集人数」。「※各募集コースをご参照ください。」等（数字なし）の時は各コースの値を結合
  const hasNum = (v) => /[0-9０-９]/.test(String(v || ''));
  const courseHires = [...new Set(corp.courses.map((c) => c.募集人数).filter(hasNum))];
  const hire = hasNum(corp.募集人数) ? corp.募集人数 : courseHires.join(' / ');
  return {
    企業名: formalCompanyName(corp.掲載社名 || ex.掲載社名),
    電話番号: pickPhone(phoneCands, corp.本社電話番号, ev.pref),
    採用人数: hire,
    従業員数: employeeCount(corp.従業員数原文),
    メールアドレス: emails.join(' / '),
    担当者名: parsed.担当者名,
    担当部署: parsed.担当部署,
    問合せ先原文: contactText.replace(/\n/g, ' | '),
    本社電話番号: phonesIn(corp.本社電話番号)[0] || corp.本社電話番号,
    電話番号候補: phoneCands.join(' / '),
    従業員数原文: corp.従業員数原文,
    掲載社名: corp.掲載社名 || ex.掲載社名,
    業種: ex.業種,
    ブース: ex.ブース,
    出展日: ex.出展日,
    マイナビURL: corp.マイナビURL,
    corpId: corp.corpId,
    イベントID: ev.eventId,
    イベント名: ev.title,
    開催日: ev.date,
    会場: ev.place,
    都道府県: ev.pref,
    取得日: new Date().toISOString().slice(0, 10),
  };
}

function safeFileName(s) { return String(s || '').replace(/[\\/:*?"<>|\s　]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''); }

async function scrapeEvent(ev, opts = {}) {
  const log = opts.log || ((...a) => console.error(...a));
  log(`[event ${ev.eventId}] ${ev.title} ${ev.date} ${ev.place}`);
  const exhibitors = await fetchExhibitors(ev.eventId, opts);
  log(`  出展企業: ${exhibitors.length}社`);
  const rows = [];
  for (let i = 0; i < exhibitors.length; i++) {
    const ex = exhibitors[i];
    if (!ex.corpId) ex.corpId = await searchCorpId(ex.掲載社名, opts);
    const corp = ex.corpId
      ? await fetchCorp(ex.corpId, opts)
      : { corpId: '', 掲載社名: ex.掲載社名, 従業員数原文: '', 募集人数: '', 本社電話番号: '', courses: [], マイナビURL: '', error: 'マイナビ企業ページなし（一覧の詳細リンクが無効・検索でも特定不能）' };
    const row = buildRow(ev, ex, corp);
    rows.push(row);
    log(`  ${String(i + 1).padStart(3)}/${exhibitors.length} ${row.企業名} | ${row.電話番号} | ${row.採用人数} | ${row.従業員数} | ${row.メールアドレス} | ${row.担当者名}${corp.error ? ' | ERR ' + corp.error : ''}`);
  }
  return rows;
}

function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '﻿' + toCsv(HEADERS, rows) + '\n');
}

function parseArgs(argv) {
  const a = { events: [], all: false, list: false, noCache: false, out: CONFIG.outDir, combined: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--event' || k === '-e') a.events.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    else if (k === '--all') a.all = true;
    else if (k === '--list-events') a.list = true;
    else if (k === '--no-cache') a.noCache = true;
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--combined') a.combined = path.resolve(argv[++i]);
    else if (k === '--delay') CONFIG.delayMs = parseInt(argv[++i], 10);
    else if (k === '--help' || k === '-h') { a.help = true; }
    else a.events.push(k);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.events.length && !a.all && !a.list)) {
    console.log(`使い方:
  node src/scrape-mynavi-event.js --event <イベントURL|イベントID>[,<ID>...]   指定イベントを抽出
  node src/scrape-mynavi-event.js --all                                        event_data.js の全イベントを抽出
  node src/scrape-mynavi-event.js --list-events                                イベント一覧を表示
オプション: --out <dir> (既定 data/mynavi-events) --combined <file> --no-cache --delay <ms>`);
    return;
  }
  const opts = { noCache: a.noCache };
  let events = [];
  try { events = await loadEventData(opts); } catch (e) { console.error('WARN event_data.js 取得失敗:', e.message); }
  if (a.list) {
    for (const e of events) console.log([e.eventId, e.date, e.pref, e.title, e.place, e.detailUrl].join('\t'));
    return;
  }
  let targets = [];
  if (a.all) targets = events;
  else {
    for (const inp of a.events) {
      const id = eventIdFrom(inp);
      if (!id) { console.error('イベントIDを判別できません:', inp); continue; }
      const known = events.find((e) => e.eventId === id);
      targets.push(known || await fetchEventMeta(id, opts));
    }
  }
  const all = [];
  const summary = [];
  for (const ev of targets) {
    try {
      const rows = await scrapeEvent(ev, opts);
      const file = path.join(a.out, `${ev.eventId}_${safeFileName(ev.title)}_${(ev.date || '').replace(/\//g, '')}.csv`);
      writeCsv(file, rows);
      all.push(...rows);
      summary.push({ ev, n: rows.length, file, phone: rows.filter((r) => r.電話番号).length, name: rows.filter((r) => r.担当者名).length, mail: rows.filter((r) => r.メールアドレス).length });
      console.error(`  → ${file}`);
    } catch (e) { console.error(`[event ${ev.eventId}] FAILED:`, e.message); summary.push({ ev, error: e.message }); }
  }
  if (targets.length > 1 || a.combined) {
    const file = a.combined || path.join(a.out, 'all-events.csv');
    writeCsv(file, all);
    console.error(`  → ${file} (${all.length}行)`);
  }
  console.log('\nイベント\t開催日\t社数\t電話\t担当者名\tメール\tファイル');
  for (const s of summary) console.log(s.error ? `${s.ev.eventId} ${s.ev.title}\tERROR ${s.error}` : `${s.ev.eventId} ${s.ev.title}\t${s.ev.date}\t${s.n}\t${s.phone}\t${s.name}\t${s.mail}\t${s.file}`);
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });

module.exports = { CONFIG, HEADERS, SHEET_HEADERS, loadEventData, fetchExhibitors, fetchCorp, searchCorpId, buildRow, scrapeEvent, parseContact, cleanNameToken, formalCompanyName, employeeCount, phonesIn, pickPhone, eventIdFrom };
