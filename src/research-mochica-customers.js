'use strict';
/**
 * MOCHICA既存顧客 超詳細リサーチ
 *
 * 目的: 既存顧客428社の一社一社について「どんな会社か」を可能な限り多くの変数で確定させ、
 *       受注（＝MOCHICA顧客化）につながる企業特徴を後段で分析できる1本のワイドCSVにする。
 *
 * 変数の出所（すべて実データ。推測値は入れない）:
 *   A 契約   … MOCHICA顧客リスト本体（プラン/アップグレード/契約月/獲得年/申込コード）
 *   B メール … 登録Emailのドメイン・ローカル部（採用専用窓口か個人か＝担当者の職掌が読める）
 *   C SF     … セールスフォース全リード86,674件と社名突合（業種/従業員レンジ/採用人数/接触回数）
 *   D BALES  … BALESCLOUDリード22,892件と突合（流入経路/利用中ATS/エントリー数/検討時期/失注履歴）
 *   E gBiz   … gBizINFO実API（法人番号/所在地/従業員/男女別/補助金/認定/表彰/特許/職場情報）
 *   F マイナビ… 会社概要outline.htmlをHTTP実取得（業種/従業員数/本社/電話/過去3年の新卒採用実績）
 *   G 上場   … EDINETコードリスト突合
 *
 * 実行: node src/research-mochica-customers.js [--limit N] [--no-live]
 *   ライブ取得結果は data/mochica-research-cache.json に貯めるので中断・再開しても無駄打ちしない。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const cfg = require('./config');
const { readCsv, parseCsv, toCsv, normCompanyName } = require('./csv');
const { extractOutlineFacts } = require('./scrape-mynavi');
const { extractHireRecord } = require('./enrich-hire-record');
const { extractPhones, normalizeJpPhone } = require('./phone');

const ROOT = path.join(__dirname, '..');
const D = (f) => path.join(ROOT, 'data', f);
const CACHE = D('mochica-research-cache.json');
const OUT = D('mochica-customers-research.csv');
const UA = cfg.USER_AGENT || 'Mozilla/5.0 (compatible; research/1.0)';
const argv = process.argv.slice(2);
const LIMIT = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? parseInt(argv[i + 1], 10) : 0; })();
const LIVE = !argv.includes('--no-live');
const log = (s) => { process.stdout.write(s + '\n'); };

/* ------------------------------------------------------------------ 共通 */
const g = (r, k) => (r && r[k] != null ? String(r[k]).trim() : '');
const nk = (s) => normCompanyName(s || '');
const intOf = (s) => { const m = String(s == null ? '' : s).replace(/[^0-9]/g, ''); return m ? parseInt(m, 10) : null; };
const NOW = new Date();
const ymNum = (s) => { const m = String(s || '').match(/(\d{4})[\/\-年]?(\d{1,2})/); return m ? (+m[1]) * 12 + (+m[2]) : null; };
const nowYM = NOW.getFullYear() * 12 + (NOW.getMonth() + 1);

const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
const prefOf = (s) => PREFS.find((p) => String(s || '').includes(p)) || '';
const BLOCK = {
  北海道: '北海道', 青森県: '東北', 岩手県: '東北', 宮城県: '東北', 秋田県: '東北', 山形県: '東北', 福島県: '東北',
  茨城県: '関東', 栃木県: '関東', 群馬県: '関東', 埼玉県: '関東', 千葉県: '関東', 東京都: '関東', 神奈川県: '関東',
  新潟県: '甲信越北陸', 富山県: '甲信越北陸', 石川県: '甲信越北陸', 福井県: '甲信越北陸', 山梨県: '甲信越北陸', 長野県: '甲信越北陸',
  岐阜県: '東海', 静岡県: '東海', 愛知県: '東海', 三重県: '東海',
  滋賀県: '関西', 京都府: '関西', 大阪府: '関西', 兵庫県: '関西', 奈良県: '関西', 和歌山県: '関西',
  鳥取県: '中国四国', 島根県: '中国四国', 岡山県: '中国四国', 広島県: '中国四国', 山口県: '中国四国',
  徳島県: '中国四国', 香川県: '中国四国', 愛媛県: '中国四国', 高知県: '中国四国',
  福岡県: '九州沖縄', 佐賀県: '九州沖縄', 長崎県: '九州沖縄', 熊本県: '九州沖縄', 大分県: '九州沖縄', 宮崎県: '九州沖縄', 鹿児島県: '九州沖縄', 沖縄県: '九州沖縄',
};

// 従業員数 → 分析用バンド（MOCHICAの価格レンジに合わせた刻み）
function empBand(n) {
  if (n == null) return '';
  if (n < 50) return '1:～49名';
  if (n < 100) return '2:50-99名';
  if (n < 200) return '3:100-199名';
  if (n < 300) return '4:200-299名';
  if (n < 500) return '5:300-499名';
  if (n < 1000) return '6:500-999名';
  if (n < 2000) return '7:1000-1999名';
  return '8:2000名以上';
}
function hireBand(n) {
  if (n == null) return '';
  if (n <= 2) return '1:1-2名';
  if (n <= 5) return '2:3-5名';
  if (n <= 10) return '3:6-10名';
  if (n <= 20) return '4:11-20名';
  if (n <= 50) return '5:21-50名';
  return '6:51名以上';
}

// 法人格・組織型（ICP v5で最も効いた軸なので既存顧客側でも必ず取る）
function orgType(name) {
  const s = String(name || '');
  if (/(農業協同組合|農協)/.test(s)) return '農協';
  if (/生活協同組合|生協|コープ/.test(s)) return '生協';
  if (/信用金庫|信用組合|信金/.test(s)) return '信金・信組';
  if (/社会福祉法人/.test(s)) return '社会福祉法人';
  if (/医療法人/.test(s)) return '医療法人';
  if (/学校法人/.test(s)) return '学校法人';
  if (/(一般|公益)?財団法人/.test(s)) return '財団法人';
  if (/(一般|公益)?社団法人/.test(s)) return '社団法人';
  if (/独立行政法人|事業協同組合|協同組合|連合会|共済/.test(s)) return 'その他協同・公的';
  if (/有限会社/.test(s)) return '有限会社';
  if (/合同会社/.test(s)) return '合同会社';
  if (/株式会社|\(株\)|（株）/.test(s)) return '株式会社';
  return 'その他';
}

// 業種文字列 → マクロ分類（SF/BALES/マイナビで表記が割れるので1本に寄せる）
function macroIndustry(s0) {
  const s = String(s0 || '');
  if (!s) return '';
  if (/情報処理|ソフトウェア|インターネット|通信|システム|ＩＴ|IT|コンピュータ|情報サービス/.test(s)) return '情報通信・IT';
  if (/建設|工事|設備|住宅|不動産|建築|土木|プラント/.test(s)) return '建設・不動産';
  if (/食品|飲料|農林|水産|畜産/.test(s)) return '食品・農林水産';
  if (/機械|電機|電子|自動車|輸送用機器|金属|鉄鋼|非鉄|化学|医薬|繊維|窯業|印刷|製紙|ゴム|精密|半導体|プラスチック|メーカー|製造/.test(s)) return '製造（機械・素材）';
  if (/商社|卸|小売|百貨店|スーパー|コンビニ|専門店|流通|販売/.test(s)) return '商社・流通・小売';
  if (/銀行|信用金庫|証券|保険|金融|リース|クレジット/.test(s)) return '金融・保険';
  if (/運輸|物流|倉庫|鉄道|航空|海運|陸運|輸送/.test(s)) return '運輸・物流';
  if (/医療|福祉|介護|病院|薬局|保育|看護/.test(s)) return '医療・福祉・介護';
  if (/人材|派遣|紹介|教育|コンサル|専門サービス|士業|調査|広告|マスコミ|出版|放送/.test(s)) return '人材・専門・広告';
  if (/外食|フード|レストラン|ホテル|旅行|レジャー|理美容|ブライダル|サービス|警備|清掃|エネルギー|電力|ガス/.test(s)) return '生活・サービス';
  if (/官公庁|公社|団体|協同組合|農協|生協/.test(s)) return '公的・団体';
  return 'その他';
}

// メールのローカル部から「窓口の性格」を読む（採用専用アドレス＝採用が組織化されている強いシグナル）
function mailRole(local0) {
  const l = String(local0 || '').toLowerCase().split('+')[0];
  if (!l) return '';
  if (/(saiyo|saiyou|recruit|shinsotsu|newgrad|job|entry|career)/.test(l)) return '採用専用';
  if (/(jinji|jinnji|hr|soumu|somu|jimu|kanri|jinzai|soshiki)/.test(l)) return '人事・総務';
  if (/^(info|contact|mail|office|support|admin|master|webmaster|inquiry|honsha|company|desk)/.test(l)) return '代表・総合窓口';
  return '個人名・その他';
}
const FREE_DOMAINS = /^(gmail|yahoo|ymail|outlook|hotmail|icloud|me|live|msn|docomo|ezweb|au|softbank|nifty|biglobe|so-net|ocn|excite|infoseek|goo|aol)\./;

/* --------------------------------------------------------- ライブ取得層 */
function fetchUrl(url, redirects) {
  if (redirects == null) redirects = 3;
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve(''); }
    const req = https.get(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, timeout: 20000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume(); return resolve(fetchUrl(new URL(r.headers.location, u).href, redirects - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(''); }
      let b = ''; r.setEncoding('utf8');
      r.on('data', (c) => { b += c; if (b.length > 3e6) { req.destroy(); resolve(b); } });
      r.on('end', () => resolve(b));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}
const ent = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
function toText(h) {
  let t = String(h || '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '\n');
  t = ent(t).replace(/\n\s*\n+/g, '\n');
  return t.replace(/(\d)\s*名/g, '$1名').replace(/(\d)\s*%/g, '$1%');
}
function phoneFrom(html, t) {
  const raw = (t.match(/電話番号[^0-9０-９]{0,8}([0-9０-９][0-9０-９\-‐－―ー()（） ]{8,21})/) || [])[1] || '';
  let p = normalizeJpPhone(raw);
  if (p) return p;
  try {
    const pr = extractPhones({ html, text: t }) || {};
    const list = (pr.candidates && pr.candidates.length) ? pr.candidates : (pr.phone ? [pr] : []);
    for (const c of list) { if (c.isFax) continue; const nz = normalizeJpPhone(c.phone); if (nz) return nz; }
  } catch (e) {}
  return '';
}

// gBizINFO: 直列＋最小間隔（並列は429）
let gbizLast = 0;
async function gbizCall(pathStr) {
  if (!cfg.GBIZ_TOKEN) return null;
  const wait = gbizLast + 380 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  gbizLast = Date.now();
  const url = cfg.GBIZ_BASE + pathStr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'X-hojinInfo-api-token': cfg.GBIZ_TOKEN, Accept: 'application/json' } }); } catch (e) { return null; }
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (res.status >= 400) return null;
    try { return JSON.parse(await res.text()); } catch (e) { return null; }
  }
  return null;
}
async function gbizResearch(name) {
  const out = { hit: false };
  const j = await gbizCall('?name=' + encodeURIComponent(name) + '&limit=5&page=1');
  const arr = (j && j['hojin-infos']) || [];
  if (!arr.length) return out;
  // 正規化社名が完全一致する候補を優先。無ければ先頭。
  const want = nk(name);
  const best = arr.find((x) => nk(x.name) === want) || arr[0];
  if (!best || !best.corporate_number) return out;
  out.hit = true;
  out.corporateNumber = best.corporate_number;
  out.exact = nk(best.name) === want;
  const num = best.corporate_number;
  const pick = (o) => ((o && o['hojin-infos'] && o['hojin-infos'][0]) || null);
  const detail = pick(await gbizCall('/' + num));
  if (detail) Object.assign(out, {
    gbizName: detail.name || '', kana: detail.kana || '', location: detail.location || '',
    postal: detail.postal_code || '', employees: detail.employee_number != null ? detail.employee_number : null,
    male: detail.company_size_male != null ? detail.company_size_male : null,
    female: detail.company_size_female != null ? detail.company_size_female : null,
    capital: detail.capital_stock != null ? detail.capital_stock : null,
    founded: detail.date_of_establishment || detail.founding_year || '',
    businessSummary: detail.business_summary || '',
    businessItems: Array.isArray(detail.business_items) ? detail.business_items : [],
    companyUrl: detail.company_url || '', qualificationGrade: detail.qualification_grade || '',
  });
  const wp = pick(await gbizCall('/' + num + '/workplace'));
  if (wp && wp.workplace_info) {
    const w = wp.workplace_info;
    const b = w.base_infos || {}; const wa = w.women_activity_infos || {};
    out.avgTenure = b.average_continuous_service_years != null ? b.average_continuous_service_years : null;
    out.avgAge = b.average_age != null ? b.average_age : null;
    out.avgOvertime = b.month_average_predetermined_overtime_hours != null ? b.month_average_predetermined_overtime_hours : null;
    out.femaleRatio = wa.female_workers_proportion != null ? wa.female_workers_proportion : null;
    out.newHireBase = b.number_of_new_hire != null ? b.number_of_new_hire : null;
    out.workplaceRaw = JSON.stringify(w).slice(0, 400);
  }
  const sub = pick(await gbizCall('/' + num + '/subsidy'));
  const subsidies = (sub && sub.subsidy) || [];
  out.subsidyCount = subsidies.length;
  out.subsidyTitles = subsidies.slice(0, 3).map((s) => s.title || s.subsidy_resource || '').filter(Boolean).join(' / ');
  const cert = pick(await gbizCall('/' + num + '/certification'));
  const certs = (cert && cert.certification) || [];
  out.certCount = certs.length;
  out.certTitles = [...new Set(certs.map((c) => c.title || c.category || '').filter(Boolean))].slice(0, 4).join(' / ');
  const com = pick(await gbizCall('/' + num + '/commendation'));
  const coms = (com && com.commendation) || [];
  out.commendationCount = coms.length;
  out.commendationTitles = [...new Set(coms.map((c) => c.title || '').filter(Boolean))].slice(0, 3).join(' / ');
  const pat = pick(await gbizCall('/' + num + '/patent'));
  const pats = (pat && pat.patent) || [];
  out.patentCount = pats.length;
  out.patentTypes = [...new Set(pats.map((p) => p.patent_type || '').filter(Boolean))].join('/');
  const fin = pick(await gbizCall('/' + num + '/finance'));
  const f = (fin && fin.finance) || null;
  if (f) {
    out.hasFinance = (f.management_index && f.management_index.length) ? 'あり' : '';
    const mi = (f.management_index || [])[0];
    if (mi) { out.netSales = mi.net_sales != null ? mi.net_sales : null; out.ordinaryIncome = mi.ordinary_income != null ? mi.ordinary_income : null; }
    out.shareholders = (f.major_shareholders || []).length;
  }
  return out;
}

// マイナビ会社概要（corpID既知の社だけ。1枚で業種/従業員/本社/電話/新卒採用実績が取れる）
async function mynaviResearch(corpID, gy, wantName) {
  const out = { hit: false };
  const url = 'https://job.mynavi.jp/' + gy + '/pc/search/corp' + corpID + '/outline.html';
  const html = await fetchUrl(url);
  if (!html) return out;
  const t = toText(html);
  const h1 = ent(((html.match(/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  if (h1 && wantName && nk(h1) !== nk(wantName)) return out; // corpIDの取り違え防止
  const facts = extractOutlineFacts(t);
  const rec = extractHireRecord(t);
  out.hit = true;
  out.url = url; out.gy = gy;
  out.industry = facts.業種 || '';
  out.employees = intOf(facts.従業員数);
  out.hq = facts.本社 || '';
  out.listedBadge = facts.上場 || '';
  out.phone = phoneFrom(html, t);
  if (rec) { out.hireLatest = rec.人数; out.hireYear = rec.年; out.hire3y = rec.系列.map((x) => x.年 + '年' + x.人数 + '名').join('/'); }
  const cap = t.match(/\n資本金\n([^\n]{1,40})/); if (cap) out.capital = cap[1].trim();
  const sales = t.match(/\n売上高\n([^\n]{1,60})/); if (sales) out.sales = sales[1].trim();
  const est = t.match(/\n(?:設立|創業|創立)\n([^\n]{1,40})/); if (est) out.established = est[1].trim();
  const off = t.match(/\n(?:事業所|営業所|拠点)\n([^\n]{1,80})/); if (off) out.offices = off[1].trim();
  const pres = t.match(/\n(?:代表者|代表取締役|社長)\n([^\n]{1,40})/); if (pres) out.president = pres[1].trim();
  return out;
}

/* ------------------------------------------------------------ 索引の構築 */
function buildIndexes() {
  log('索引を構築中…');
  const ix = {};

  // SF 全リード（ヘッダ行を自動検出）
  const sfRows = parseCsv(fs.readFileSync(D('セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv'), 'utf8'));
  let hi = 0; for (let i = 0; i < 20; i++) if ((sfRows[i] || []).includes('リード 状況')) { hi = i; break; }
  const sh = sfRows[hi];
  const c = (n) => sh.indexOf(n);
  const SF = { name: c('会社名 / 取引先'), tel: c('電話'), sei: c('姓'), hire: c('採用人数(選択リスト)'), st: c('リード 状況'), emp: c('従業員数レンジ(ランスケ）'), q10: c('セミナーアンケート項目10'), q7: c('セミナーアンケート項目7'), mail: c('メール'), ind: c('業種') };
  ix.sf = new Map();
  for (let i = hi + 1; i < sfRows.length; i++) {
    const r = sfRows[i]; const n = nk(r[SF.name]); if (!n) continue;
    if (!ix.sf.has(n)) ix.sf.set(n, []);
    ix.sf.get(n).push({ hire: r[SF.hire] || '', st: r[SF.st] || '', emp: r[SF.emp] || '', ind: r[SF.ind] || '', q10: r[SF.q10] || '', q7: r[SF.q7] || '', mail: r[SF.mail] || '', sei: r[SF.sei] || '', tel: r[SF.tel] || '' });
  }
  log('  SF: ' + ix.sf.size + '社名 / ' + (sfRows.length - hi - 1) + 'リード');

  // BALES
  const bRows = parseCsv(fs.readFileSync(D('BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv'), 'utf8'));
  const bh = bRows[0];
  const bi = (n) => bh.indexOf(n);
  const srcCols = []; const tagCols = [];
  bh.forEach((h, i) => {
    if (/^リードソース：/.test(h)) { const nm = h.replace('リードソース：', ''); srcCols.push([nm, i, bh.indexOf('リード流入日時：' + nm)]); }
    if (/^タグ：/.test(h)) tagCols.push([h.replace('タグ：', ''), i]);
  });
  const B = {
    name: bi('会社情報：会社名'), tel: bi('会社情報：電話'), web: bi('会社情報：Webサイト'), ind: bi('会社情報：業種'),
    emp: bi('会社情報：従業員規模'), pref: bi('会社情報：住所：都道府県'), city: bi('会社情報：住所：市区郡'),
    dept: bi('担当者情報：部署'), title: bi('担当者情報：役職'), sei: bi('担当者情報：姓'),
    stage: bi('リード関連情報：最終リードステージ'), created: bi('システム管理情報：リード作成日時'),
    genjo: bi('カスタム情報：顧客の現状'), kadai: bi('カスタム情報：顧客の課題感'),
    ats: bi('カスタム情報：利用中ATS'), koushin: bi('カスタム情報：現利用サービス更新予定月'),
    hire: bi('カスタム情報：採用人数(選択リスト)'), entry: bi('カスタム情報：エントリー数'),
    kento: bi('カスタム情報：検討開始時期'), lostBig: bi('カスタム情報：失注商談失注理由大'),
    lostMid: bi('カスタム情報：失注商談失注理由中'), lostDate: bi('カスタム情報：失注商談失注日'),
    lostRival: bi('カスタム情報：失注商談バッティング負け競合'), memo: bi('カスタム情報：活動メモ'),
  };
  ix.bales = new Map(); ix.balesTel = new Map(); ix.balesB = B;
  for (let i = 1; i < bRows.length; i++) {
    const r = bRows[i]; const n = nk(r[B.name]); if (!n) continue;
    const rec = {};
    for (const k of Object.keys(B)) rec[k] = B[k] >= 0 ? String(r[B[k]] || '').trim() : '';
    rec.sources = srcCols.filter(([, i2]) => String(r[i2] || '').trim()).map(([nm, , di]) => ({ name: nm, at: di >= 0 ? String(r[di] || '').trim() : '' }));
    rec.tags = tagCols.filter(([, i2]) => String(r[i2] || '').trim()).map(([nm]) => nm);
    if (!ix.bales.has(n)) ix.bales.set(n, []);
    ix.bales.get(n).push(rec);
    const tel = String(rec.tel || '').replace(/[^0-9]/g, '');
    if (tel.length >= 9) { if (!ix.balesTel.has(tel)) ix.balesTel.set(tel, []); ix.balesTel.get(tel).push(rec); }
  }
  log('  BALES: ' + ix.bales.size + '社名 / ' + (bRows.length - 1) + 'リード');

  // 上場（EDINET）
  ix.listed = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(D('listed-names.json'), 'utf8'));
    for (const x of (Array.isArray(j) ? j : Object.keys(j))) { const n = nk(typeof x === 'string' ? x : (x && x.name)); if (n) ix.listed.add(n); }
  } catch (e) {}
  log('  上場: ' + ix.listed.size);

  // マイナビ掲載（28卒 / 27卒）
  ix.mynavi = new Map();
  for (const [f, gy] of [[D('mynavi-2028-corpus.csv'), '28'], [D('mynavi-2027-corpus.csv'), '27']]) {
    if (!fs.existsSync(f)) continue;
    for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) {
      const n = nk(r['企業名']); if (!n) continue;
      const cur = ix.mynavi.get(n) || { gy: [], corpID: '' };
      if (!cur.gy.includes(gy)) cur.gy.push(gy);
      if (gy === '28') { cur.corpID28 = String(r.corpID || '').trim(); cur.corpID = cur.corpID28 || cur.corpID; }
      if (gy === '27') { cur.corpID27 = String(r.corpID || '').trim(); if (!cur.corpID) cur.corpID = cur.corpID27; }
      ix.mynavi.set(n, cur);
    }
  }
  log('  マイナビ掲載社名: ' + ix.mynavi.size);

  // 統合マスタ（法人番号・業種・電話の補完源）
  ix.master = new Map();
  try {
    for (const r of readCsv(fs.readFileSync(D('leads-consolidated-all.csv'), 'utf8')).records) {
      const n = nk(r['企業名']); if (!n || ix.master.has(n)) continue;
      ix.master.set(n, r);
    }
  } catch (e) {}
  log('  統合マスタ: ' + ix.master.size);
  return ix;
}

/* ------------------------------------------------------------------ 本体 */
async function main() {
  const { records: moc } = readCsv(fs.readFileSync(D('MOCHICAの既存顧客リスト - mochica-companies-list.csv'), 'utf8'));
  const ix = buildIndexes();
  let cache = {};
  if (fs.existsSync(CACHE)) { try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {}; } catch (e) {} }
  let cacheDirty = 0;
  const saveCache = () => { fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8'); cacheDirty = 0; };

  const rows = [];
  const targets = moc.filter((r) => g(r, '法人名') && g(r, '法人名') !== '削除');
  const list = LIMIT ? targets.slice(0, LIMIT) : targets;
  log('\n対象 ' + list.length + '社 の詳細調査を開始（ライブ取得=' + (LIVE ? 'ON' : 'OFF') + '）\n');

  let i = 0;
  for (const r of list) {
    i++;
    const name = g(r, '法人名');
    const key = nk(name);
    const o = {};

    /* ---- A 契約プロファイル ---- */
    o['会社ID'] = g(r, '会社ID');
    o['法人名'] = name;
    o['組織型'] = orgType(name);
    o['LINE登録企業名'] = g(r, 'LINEアカウント登録企業名');
    o['LINE名不一致'] = nk(g(r, 'LINEアカウント登録企業名')) === key ? '' : 'あり';
    o['基本年間プラン'] = g(r, '基本年間プラン');
    o['現在利用プラン'] = g(r, '現在利用プラン');
    o['更新前プラン'] = g(r, '更新前プラン');
    // プラン改称に注意: 旧「ライト/ライトプラン500」＝現ミニマムプラン、旧「ライトプラン700/900」＝現ミドルプラン。
    // 同ランクを与えないと改称187件が丸ごと「ダウングレード」に化ける。データ利用プランは料金階層の外なのでランク無し。
    const planRank = { 'ミニマムプラン': 1, 'ライト': 1, 'ライトプラン500': 1, 'ライトプラン700': 2, 'ライトプラン900': 2, 'ミドルプラン': 2, 'スタンダード': 3 };
    const pNow = planRank[o['現在利用プラン']]; const pPrev = planRank[o['更新前プラン']];
    o['現プラン階層'] = pNow == null ? '' : String(pNow);
    o['プラン遷移'] = (pPrev == null || pNow == null) ? '' : (pNow > pPrev ? 'アップグレード' : pNow < pPrev ? 'ダウングレード' : '据置');
    o['プラン改称のみ'] = (g(r, '更新前プラン') && g(r, '更新前プラン') !== o['現在利用プラン'] && o['プラン遷移'] === '据置') ? 'あり' : '';
    o['アップグレード有無'] = g(r, 'アップグレードプラン①') ? 'あり' : '';
    o['アップグレード先'] = g(r, 'アップグレードプラン①');
    o['アップグレード開始月'] = g(r, 'アップグレード①開始月');
    o['無料トライアル経由'] = g(r, '無料開始月') ? 'あり' : '';
    o['無料開始月'] = g(r, '無料開始月');
    const freeYM = ymNum(g(r, '無料開始月')); const payYM = ymNum(g(r, '有料開始月'));
    o['無料→有料転換月数'] = (freeYM && payYM) ? String(payYM - freeYM) : '';
    o['有料開始月'] = g(r, '有料開始月');
    o['有料終了月'] = g(r, '有料終了月');
    const endYM = ymNum(g(r, '有料終了月'));
    o['現契約残月数'] = endYM ? String(endYM - nowYM) : '';
    o['アカウント作成日'] = g(r, '作成日');
    const cy = (g(r, '作成日').match(/^(\d{4})/) || [])[1] || '';
    o['獲得年'] = cy;
    o['獲得コホート'] = cy ? (+cy <= 2020 ? '2018-2020(初期)' : +cy <= 2022 ? '2021-2022' : +cy <= 2024 ? '2023-2024' : '2025-2026(直近)') : '';
    o['継続年数'] = cy ? String(NOW.getFullYear() - (+cy)) : '';
    o['アカウント納品'] = g(r, 'アカウント納品');
    const cD = Date.parse(g(r, '作成日').replace(/\//g, '-')); const dD = Date.parse(g(r, 'アカウント納品日').replace(/\//g, '-'));
    o['納品リードタイム日数'] = (cD && dD && dD >= cD) ? String(Math.round((dD - cD) / 86400000)) : '';
    const memo = g(r, '備考欄');
    const mo = memo.match(/(\d{4})(\d{2})(\d{2})MO(\d{3})/);
    o['申込コード'] = mo ? mo[0] : '';
    o['申込日'] = mo ? (mo[1] + '/' + mo[2] + '/' + mo[3]) : '';
    o['申込月内連番'] = mo ? mo[4] : '';
    o['紙申込'] = /紙申/.test(memo) ? 'あり' : '';
    o['備考欄'] = memo;

    /* ---- B メール窓口 ---- */
    const email = g(r, 'Email');
    const at = email.split('@');
    const dom = (at[1] || '').toLowerCase();
    o['メールドメイン'] = dom;
    o['ドメイン種別'] = !dom ? '' : FREE_DOMAINS.test(dom) ? 'フリーメール' : /\.(lg|go)\.jp$/.test(dom) ? '公的ドメイン' : /\.(ac|ed)\.jp$/.test(dom) ? '教育ドメイン' : /\.or\.jp$/.test(dom) ? '団体ドメイン(or.jp)' : /\.co\.jp$/.test(dom) ? '法人ドメイン(co.jp)' : '独自ドメイン(その他)';
    o['メール窓口種別'] = mailRole(at[0]);

    /* ---- C SF突合 ---- */
    const sf = ix.sf.get(key) || [];
    const pickFirst = (arr, f2) => { for (const x of arr) { const v = f2(x); if (v) return v; } return ''; };
    o['SF突合'] = sf.length ? '○' : '';
    o['SFリード件数'] = String(sf.length);
    o['SF業種'] = pickFirst(sf, (x) => x.ind);
    o['SF従業員レンジ'] = pickFirst(sf, (x) => x.emp);
    o['SF採用人数'] = pickFirst(sf, (x) => x.hire);
    o['SF最終状況'] = pickFirst(sf, (x) => x.st);
    o['SFコンバート有'] = sf.some((x) => /コンバート/.test(x.st)) ? 'あり' : '';
    o['SFセミナー回答'] = sf.some((x) => x.q10 || x.q7) ? 'あり' : '';

    /* ---- D BALES突合 ---- */
    let bl = ix.bales.get(key) || [];
    o['BALES突合'] = bl.length ? '○' : '';
    o['BALESリード件数'] = String(bl.length);
    o['BALES業種'] = pickFirst(bl, (x) => x.ind);
    o['BALES従業員規模'] = pickFirst(bl, (x) => x.emp);
    o['BALES都道府県'] = pickFirst(bl, (x) => x.pref);
    o['BALES市区'] = pickFirst(bl, (x) => x.city);
    o['担当部署'] = pickFirst(bl, (x) => x.dept);
    o['担当役職'] = pickFirst(bl, (x) => x.title);
    o['利用中ATS'] = pickFirst(bl, (x) => x.ats);
    o['他社ATS痕跡'] = bl.some((x) => x.ats || (x.tags || []).some((t) => /他社ATS/.test(t))) ? 'あり' : '';
    o['採用人数(BALES)'] = pickFirst(bl, (x) => x.hire);
    o['エントリー数'] = pickFirst(bl, (x) => x.entry);
    o['検討開始時期'] = pickFirst(bl, (x) => x.kento);
    o['顧客の課題感'] = pickFirst(bl, (x) => x.kadai).replace(/\s+/g, ' ').slice(0, 120);
    o['顧客の現状'] = pickFirst(bl, (x) => x.genjo).replace(/\s+/g, ' ').slice(0, 120);
    o['過去失注有'] = bl.some((x) => x.lostBig || x.lostDate) ? 'あり' : '';
    o['過去失注理由'] = pickFirst(bl, (x) => x.lostBig);
    o['競合バッティング'] = pickFirst(bl, (x) => x.lostRival);
    const allSrc = []; for (const x of bl) for (const s of (x.sources || [])) allSrc.push(s);
    const srcNames = [...new Set(allSrc.map((s) => s.name))];
    o['流入経路数'] = String(srcNames.length);
    o['流入経路'] = srcNames.slice(0, 6).join(' / ');
    const dated = allSrc.filter((s) => s.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    o['初回流入経路'] = dated.length ? dated[0].name : (allSrc[0] ? allSrc[0].name : '');
    o['初回流入日'] = dated.length ? String(dated[0].at).slice(0, 10) : '';
    const inbound = /Mochicaサイト|問い合わせフォーム|ホワイトペーパー|セミナー|メルマガ|イベント|EXPO|日本の人事部|HR-NOTE|BOXIL|ITトレンド|アスピック|起業ログ|一括|アイミツ|採用支援ポータル|Google AdWords|yahoo|facebook|HRプロ|＠人事|STRATE|オンリーストーリー|ウレル|フリープラン|電話問い合わせ|CRM|NCコーポレートサイト/;
    const outbound = /アウトバウンド|ディグロス|soraプロジェクト|X-log|WizBiz|ListA|Lista|Sitoke|BPO/;
    const partner = /紹介|代理店|パートナー|顧問|内部取引|他部署案件共有/;
    o['流入区分'] = !srcNames.length ? '' : srcNames.some((s) => inbound.test(s)) ? 'インバウンド' : srcNames.some((s) => partner.test(s)) ? '紹介・パートナー' : srcNames.some((s) => outbound.test(s)) ? 'アウトバウンド' : 'その他';
    o['BALESタグ'] = [...new Set([].concat(...bl.map((x) => x.tags || [])))].slice(0, 6).join(' / ');
    const firstAt = bl.map((x) => x.created).filter(Boolean).sort()[0] || '';
    o['BALES初回登録日'] = firstAt.slice(0, 10);
    const bD = Date.parse(String(firstAt).slice(0, 10));
    o['初回接触→受注日数'] = (bD && cD && cD >= bD) ? String(Math.round((cD - bD) / 86400000)) : '';

    /* ---- G 上場・統合マスタ ---- */
    o['上場(EDINET)'] = ix.listed.has(key) ? '上場' : '';
    const mst = ix.master.get(key);
    o['法人番号(内部)'] = mst ? g(mst, '法人番号') : '';
    o['統合マスタ業種'] = mst ? g(mst, '業種') : '';
    o['統合マスタ従業員'] = mst ? g(mst, '従業員数') : '';
    o['統合マスタ電話'] = mst ? g(mst, '電話番号') : '';

    /* ---- マイナビ掲載 ---- */
    const mv = ix.mynavi.get(key);
    o['マイナビ掲載'] = mv ? mv.gy.map((x) => x + '卒').join('/') : '';
    o['マイナビ28卒掲載'] = mv && mv.gy.includes('28') ? '○' : '';
    o['マイナビ27卒掲載'] = mv && mv.gy.includes('27') ? '○' : '';
    o['corpID'] = mv ? (mv.corpID || '') : '';

    /* ---- ライブ取得（キャッシュ） ---- */
    const ce = cache[key] || {};
    if (LIVE && !ce.gbizDone) {
      try { ce.gbiz = await gbizResearch(name); } catch (e) { ce.gbiz = { hit: false, error: String(e && e.message) }; }
      ce.gbizDone = true; cacheDirty++;
    }
    if (LIVE && mv && mv.corpID && !ce.mynaviDone) {
      try {
        const primaryId = mv.corpID28 || mv.corpID27 || mv.corpID;
        const primaryGy = mv.corpID28 ? '28' : '27';
        let m = await mynaviResearch(primaryId, primaryGy, name);
        if (!m.hit || !m.hireLatest) {
          const altGy = primaryGy === '28' ? '27' : '28';
          const altId = (altGy === '27' ? (mv.corpID27 || primaryId) : (mv.corpID28 || primaryId));
          const m2 = await mynaviResearch(altId, altGy, name);
          if (m2.hit) {
            if (!m.hit) m = m2;
            else { if (!m.hireLatest && m2.hireLatest) { m.hireLatest = m2.hireLatest; m.hireYear = m2.hireYear; m.hire3y = m2.hire3y; } if (!m.phone) m.phone = m2.phone; if (!m.employees) m.employees = m2.employees; }
          }
        }
        ce.mynavi = m;
      } catch (e) { ce.mynavi = { hit: false, error: String(e && e.message) }; }
      ce.mynaviDone = true; cacheDirty++;
    }
    cache[key] = ce;
    if (cacheDirty >= 10) saveCache();

    /* ---- gBiz 展開 ---- */
    const gb = ce.gbiz || {};
    o['gBiz突合'] = gb.hit ? (gb.exact ? '○(完全一致)' : '△(部分一致)') : '';
    o['法人番号'] = gb.corporateNumber || o['法人番号(内部)'] || '';
    o['gBiz正式社名'] = gb.gbizName || '';
    o['所在地'] = gb.location || '';
    o['郵便番号'] = gb.postal || '';
    o['gBiz従業員数'] = gb.employees != null ? String(gb.employees) : '';
    o['男性従業員数'] = gb.male != null ? String(gb.male) : '';
    o['女性従業員数'] = gb.female != null ? String(gb.female) : '';
    o['資本金(gBiz)'] = gb.capital != null ? String(gb.capital) : '';
    o['設立日(gBiz)'] = gb.founded || '';
    o['事業概要'] = String(gb.businessSummary || '').replace(/\s+/g, ' ').slice(0, 200);
    o['営業品目'] = (gb.businessItems || []).slice(0, 5).join(' / ');
    o['公式URL(gBiz)'] = gb.companyUrl || '';
    o['平均勤続年数'] = gb.avgTenure != null ? String(gb.avgTenure) : '';
    o['平均年齢(gBiz)'] = gb.avgAge != null ? String(gb.avgAge) : '';
    o['女性比率'] = gb.femaleRatio != null ? String(gb.femaleRatio) : '';
    o['新卒採用数(職場情報)'] = gb.newHireBase != null ? String(gb.newHireBase) : '';
    o['補助金採択件数'] = gb.subsidyCount != null ? String(gb.subsidyCount) : '';
    o['補助金名'] = gb.subsidyTitles || '';
    o['認定件数'] = gb.certCount != null ? String(gb.certCount) : '';
    o['認定内容'] = gb.certTitles || '';
    o['表彰件数'] = gb.commendationCount != null ? String(gb.commendationCount) : '';
    o['表彰内容'] = gb.commendationTitles || '';
    o['特許商標件数'] = gb.patentCount != null ? String(gb.patentCount) : '';
    o['特許種別'] = gb.patentTypes || '';
    o['財務情報有'] = gb.hasFinance || '';
    o['売上高(gBiz)'] = gb.netSales != null ? String(gb.netSales) : '';

    /* ---- マイナビ会社概要 展開 ---- */
    const my = ce.mynavi || {};
    o['マイナビ会社概要取得'] = my.hit ? '○' : '';
    o['マイナビ業種'] = my.industry || '';
    o['マイナビ従業員数'] = my.employees != null ? String(my.employees) : '';
    o['マイナビ本社'] = my.hq || '';
    o['マイナビ上場表記'] = my.listedBadge || '';
    o['代表電話'] = my.phone || o['統合マスタ電話'] || '';
    o['新卒採用実績(直近)'] = my.hireLatest != null ? String(my.hireLatest) : '';
    o['新卒採用実績年'] = my.hireYear != null ? String(my.hireYear) : '';
    o['新卒採用実績3年'] = my.hire3y || '';
    o['資本金(マイナビ)'] = my.capital || '';
    o['売上高(マイナビ)'] = my.sales || '';
    o['設立(マイナビ)'] = my.established || '';
    o['事業所(マイナビ)'] = my.offices || '';
    o['代表者名'] = my.president || '';
    o['マイナビ会社概要URL'] = my.url || '';

    /* ---- 統合ビュー（分析はここを使う） ---- */
    const empFinal = my.employees != null ? my.employees
      : (gb.employees != null ? gb.employees
        : (intOf(o['統合マスタ従業員']) != null ? intOf(o['統合マスタ従業員']) : null));
    o['従業員数_確定'] = empFinal != null ? String(empFinal) : '';
    o['従業員数_出所'] = empFinal == null ? '' : (my.employees != null ? 'マイナビ' : gb.employees != null ? 'gBiz' : '統合マスタ');
    o['従業員数バンド'] = empBand(empFinal);
    const hireFinal = my.hireLatest != null ? my.hireLatest : (gb.newHireBase != null ? gb.newHireBase : null);
    o['新卒採用数_確定'] = hireFinal != null ? String(hireFinal) : '';
    o['採用数バンド'] = hireBand(hireFinal);
    const indFinal = my.industry || o['SF業種'] || o['BALES業種'] || o['統合マスタ業種'] || o['事業概要'];
    o['業種_確定'] = String(indFinal || '').replace(/\s+/g, ' ').slice(0, 60);
    o['業種マクロ'] = macroIndustry(indFinal);
    const prefFinal = prefOf(my.hq) || prefOf(gb.location) || o['BALES都道府県'] || '';
    o['都道府県_確定'] = prefFinal;
    o['地域ブロック'] = BLOCK[prefFinal] || '';
    const estY = (String(my.established || '').match(/(\d{4})/) || [])[1] || (String(gb.founded || '').match(/(\d{4})/) || [])[1] || '';
    o['設立年_確定'] = estY;
    o['社齢'] = estY ? String(NOW.getFullYear() - (+estY)) : '';
    o['上場_確定'] = (o['上場(EDINET)'] || my.listedBadge) ? '上場' : '';
    o['新卒採用比率%'] = (hireFinal != null && empFinal) ? (Math.round((hireFinal / empFinal) * 1000) / 10).toFixed(1) : '';

    rows.push(o);
    if (i % 10 === 0 || i === list.length) {
      log('  ' + i + '/' + list.length + ' ' + name + ' | 従' + (o['従業員数_確定'] || '?') + ' | ' + (o['業種マクロ'] || '?') + ' | 採用' + (o['新卒採用数_確定'] || '?') + ' | gBiz' + (o['gBiz突合'] || '×') + ' | マイナビ' + (o['マイナビ会社概要取得'] || '×'));
    }
  }
  saveCache();

  const headers = Object.keys(rows[0]);
  fs.writeFileSync(OUT, '﻿' + toCsv(headers, rows), 'utf8');
  log('\n[完了] ' + rows.length + '社 × ' + headers.length + '変数 → ' + path.relative(ROOT, OUT));
  const cnt = (k) => rows.filter((x) => x[k]).length;
  log('  充足率: 従業員数 ' + cnt('従業員数_確定') + ' / 業種 ' + cnt('業種_確定') + ' / 都道府県 ' + cnt('都道府県_確定')
    + ' / 新卒採用実績 ' + cnt('新卒採用数_確定') + ' / 法人番号 ' + cnt('法人番号') + ' / 流入経路 ' + cnt('流入経路'));
}
main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exit(1); });
