'use strict';
/**
 * harvest-signals — 採用シグナルの素材集め（PR TIMES 主軸・無料・robots遵守）
 * =====================================================================
 * 「業界で狙う」のをやめて「出来事で狙う」ために、まず出来事の**発生**を毎日拾う。
 *
 * なぜ PR TIMES を主軸にするか（build-prtimes.js の発見をそのまま使う）:
 *   ・無料Webの最大の壁「社名→URL解決」を回避できる（会社概要が構造化されている）
 *   ・keyword topic ページがそのまま**シグナル別の入口**になる
 *       出店/新工場/M&A/資金調達/採用強化/外国人採用/採用DX …
 *   ・企業名・公式URL・代表者名・業種・所在地・電話が1本で揃う＝架電宛名まで到達できる
 *   ・リリースには日付がある＝ hot-signal の鮮度係数がそのまま効く
 *
 * 出力（追記型・URLで重複排除）:
 *   data/hot-signals/releases.jsonl
 *     {url, date, title, company, 公式URL, 業種, 都道府県, 電話番号, 代表者名, signals:[...], harvestedAt}
 *
 * 実行:
 *   node src/harvest-signals.js                       # 既定キーワード・目標300本
 *   node src/harvest-signals.js --target 800 --pages 5
 *   node src/harvest-signals.js --signals 新店舗OPEN,新工場OPEN,資金調達
 *   node src/harvest-signals.js --days 30             # 30日以内のリリースだけ残す
 *   node src/harvest-signals.js --recollect           # URLキューを捨ててトピック巡回をやり直す
 *
 * 中断しても安全（1本ごとに追記＋既取得URLはスキップして再開する）。
 * トピック巡回だけで10分以上かかるため、集めたURLは url-queue.json に12時間キャッシュし、
 * 再開時は本文判定から始める（`--queue-hours` で変更）。
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { detectSignals } = require('./hot-signal');
const { extractPressContact } = require('./press-contact');
const { parseCompanyProfile, trimBoilerplate } = require('./prtimes-parse');
const { appendAudit } = require('./signal-audit');
const { log, getIntArg, getArg } = require('./cli-util');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'hot-signals');
const JSONL = path.join(DIR, 'releases.jsonl');
const QUEUE = path.join(DIR, 'url-queue.json');

/**
 * シグナル種別 → PR TIMES の keyword topic。
 * hot-signal の SIGNALS と1:1ではない（1つの語で複数シグナルが釣れる方が効率が良い）。
 * ここは「網の投げ先」であって判定ではない。判定は必ず detectSignals が行う。
 */
const TOPICS = {
  大量求人開始: ['採用強化', '採用開始', '新卒採用', '大量採用', '採用計画', '中途採用', '積極採用'],
  新店舗OPEN: ['新店舗', '出店', 'オープン', '開業', '1号店', '旗艦店'],
  新工場OPEN: ['新工場', '工場', '生産拠点', '物流センター', '倉庫'],
  新拠点開設: ['拠点開設', '営業所', '支店', 'オフィス移転', '事業所'],
  'M&A・事業承継': ['M&A', '買収', '子会社化', '経営統合', '事業承継', '資本業務提携'],
  資金調達: ['資金調達', 'シリーズA', '第三者割当増資', 'ラウンド'],
  採用担当者募集: ['人事', '採用担当', '組織開発', '人事制度'],
  外国人採用開始: ['外国人材', '特定技能', '技能実習', '育成就労', 'グローバル人材'],
  採用サイト刷新: ['採用サイト', '採用ページ', '採用広報'],
  'ATS導入・採用DX': ['採用DX', '採用管理システム', 'HRtech', '採用ツール'],
  インターン募集: ['インターンシップ', 'インターン'],
  事業拡大: ['事業拡大', '新規事業', '過去最高', '大型受注'],
};

function parseArgs(argv) {
  const a = {
    target: getIntArg('target', 300),
    pages: getIntArg('pages', 4),
    days: getIntArg('days', 0),              // 0=制限なし
    out: getArg('out', JSONL),
    signals: null,
    fresh: argv.includes('--fresh'),
    recollect: argv.includes('--recollect'),   // キューを無視してトピック巡回をやり直す
    queueHours: getIntArg('queue-hours', 12),  // キューの再利用上限
  };
  const s = getArg('signals', '');
  if (s && s !== true) a.signals = String(s).split(',').map((x) => x.trim()).filter(Boolean);
  return a;
}

// 既に取得済みのURL（再開用）
function loadSeen(file) {
  const seen = new Set();
  if (!fs.existsSync(file)) return seen;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j.url) seen.add(j.url); } catch (_) { /* 壊れた行は無視 */ }
  }
  return seen;
}

/**
 * リリースHTML → 企業レコード＋本文。
 * 会社概要ブロックの取り方は build-prtimes.js の parseRelease と同じ流儀
 * （PR TIMES はラベル連結のプレーンテキストで会社概要を出す）。
 */
function parseRelease(html, url) {
  const $ = cheerio.load(html);
  const title = ($('title').text() || '').split(/[|｜]/)[0].trim();
  const rec = { url, title, company: '', 公式URL: '', 業種: '', 都道府県: '', 電話番号: '', 代表者名: '', 上場: '', date: '' };
  rec.company = (($('title').text() || '').split(/[|｜]/).slice(-1)[0] || '').replace(/のプレスリリース.*$/, '').trim();

  const t = $('body').text().replace(/[ \t　]+/g, ' ');
  Object.assign(rec, parseCompanyProfile(t));

  // 配信日時（メタ優先。PR TIMES は article:published_time を持つ）
  rec.date = ($('meta[property="article:published_time"]').attr('content') || '').slice(0, 10)
    || (t.match(/(20\d{2})年\s?(\d{1,2})月\s?(\d{1,2})日/) || []).slice(1, 4).join('-').replace(/-(\d)(?=-|$)/g, '-0$1');

  // タグ欄・関連リンク・会社概要を落としてから判定に回す。
  // ここを削らないと、商品リリースの末尾タグ「新工場」だけで新工場OPENが立つ（実測の誤爆源）。
  const body = ($('article').first().text() || $('main').first().text() || $('body').text()).replace(/[ \t　]+/g, ' ');
  rec.text = trimBoilerplate(body).slice(0, 6000);
  const contact = extractPressContact(body);
  if (contact && contact.name) { rec.採用担当者名 = contact.name; rec.担当役職 = contact.role || contact.dept || ''; }
  return rec;
}

/**
 * 収集済みURLキューの読み書き。
 * トピック巡回は1回12分ほどかかる一方、本文判定は途中終了しやすい。キューを残さないと
 * 再開のたびに同じ巡回をやり直すことになるため、一定時間はキューを再利用する。
 */
function loadQueue(topics, maxAgeH) {
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
    const ageH = (Date.now() - new Date(q.collectedAt).getTime()) / 3600000;
    if (ageH > maxAgeH) return null;
    if (q.topics.join('|') !== topics.join('|')) return null;   // 対象トピックが違えば作り直す
    log(`URLキューを再利用（${q.urls.length}本・${ageH.toFixed(1)}時間前に収集）`);
    return q.urls;
  } catch (_) { return null; }
}
function saveQueue(topics, urls) {
  fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
  fs.writeFileSync(QUEUE, JSON.stringify({ collectedAt: new Date().toISOString(), topics, urls }), 'utf8');
}

/** keyword topic を辿ってリリースURLを集める（ページング・robots遵守）。 */
async function collectReleaseUrls(topics, { target, pages }) {
  const urls = new Set();
  const enc = encodeURIComponent;
  for (const kw of topics) {
    if (urls.size >= target * 3) break;      // 判定で大半が落ちるので多めに集める
    for (let pg = 1; pg <= pages; pg++) {
      const u = `https://prtimes.jp/topics/keywords/${enc(kw)}` + (pg > 1 ? `?page=${pg}` : '');
      const r = await politeGet(u, { render: 'static' }).catch(() => null);
      if (!r || r.blocked || !r.html) break;
      const before = urls.size;
      for (const m of r.html.matchAll(/\/main\/html\/rd\/p\/[0-9.]+\.html/g)) urls.add('https://prtimes.jp' + m[0]);
      if (urls.size === before) break;       // このキーワードは打ち止め
    }
    log(`  「${kw}」まで 累計リリースURL ${urls.size}`);
  }
  return [...urls];
}

async function run() {
  const a = parseArgs(process.argv);
  fs.mkdirSync(DIR, { recursive: true });
  const OUT = path.resolve(a.out);
  if (a.fresh && fs.existsSync(OUT)) fs.unlinkSync(OUT);
  const seen = loadSeen(OUT);
  if (seen.size) log(`再開: 取得済み ${seen.size}本をスキップ`);

  const keys = a.signals || Object.keys(TOPICS);
  const unknown = keys.filter((k) => !TOPICS[k]);
  if (unknown.length) { console.error(`不明なシグナル種別: ${unknown.join(', ')}\n選択肢: ${Object.keys(TOPICS).join(', ')}`); process.exit(1); }
  const topics = [...new Set(keys.flatMap((k) => TOPICS[k]))];

  log(`シグナル収集: 種別${keys.length} / トピック${topics.length} / 目標${a.target}本`);
  let all = a.recollect ? null : loadQueue(topics, a.queueHours);
  if (!all) { all = await collectReleaseUrls(topics, a); saveQueue(topics, all); }
  const urls = all.filter((u) => !seen.has(u));
  log(`未取得リリース ${urls.length}本 → 本文を判定`);

  const today = new Date().toISOString().slice(0, 10);
  // 1本ごとに同期追記する。createWriteStream はバッファに溜めるため、
  // 途中で止めると数十本ぶんが丸ごと消える（＝再開の意味がなくなる）。
  const append = (obj) => fs.appendFileSync(OUT, JSON.stringify(obj) + '\n', 'utf8');
  let hit = 0, done = 0;
  const tally = {};
  const rejected = {};
  // 判定は1件ずつ監査ログにも残す。画面のサマリは流れて消えるが、監査ログは残るので
  // 「規則をいじった結果、採択率がどう動いたか」を後から測れる（src/signal-audit.js）。
  const audit = [];
  for (const u of urls) {
    if (hit >= a.target) break;
    const r = await politeGet(u, { render: 'static' }).catch(() => null);
    done++;
    if (!r || !r.html) continue;
    const rec = parseRelease(r.html, u);
    if (!rec.company) continue;
    const det = detectSignals({ title: rec.title, text: rec.text, company: rec.company, industry: rec.業種, date: rec.date, url: u });
    if (!det.signals.length) {
      rejected[det.rejected] = (rejected[det.rejected] || 0) + 1;
      audit.push({ source: 'PR TIMES', url: u, company: rec.company, decision: 'reject', reason: det.rejected });
      continue;
    }
    // 鮮度フィルタ（--days）。日付不明は落とさない（PR TIMES は稀に取れない）。
    if (a.days > 0) {
      const d = det.signals[0].days;
      if (d != null && d > a.days) {
        rejected['too-old'] = (rejected['too-old'] || 0) + 1;
        audit.push({ source: 'PR TIMES', url: u, company: rec.company, decision: 'reject', reason: 'too-old' });
        continue;
      }
    }
    delete rec.text;                                        // 本文は保存しない（根拠は evidence に凝縮済み）
    append({ ...rec, signals: det.signals, harvestedAt: today });
    hit++;
    for (const s of det.signals) tally[s.key] = (tally[s.key] || 0) + 1;
    audit.push({ source: 'PR TIMES', url: u, company: rec.company, decision: 'accept', signals: det.signals.map((s) => s.key) });
    if (hit % 25 === 0) log(`  ${hit}/${a.target}本（判定 ${done}本）`);
  }

  appendAudit(audit);
  log(`収集完了: シグナル検出 ${hit}本 / 判定 ${done}本（採択率 ${done ? (hit / done * 100).toFixed(1) : '0.0'}%）`);
  console.log('\n  シグナル別');
  for (const [k, v] of Object.entries(tally).sort((x, y) => y[1] - x[1])) console.log(`    ${String(v).padStart(4)}本  ${k}`);
  console.log('\n  不採用の内訳');
  for (const [k, v] of Object.entries(rejected).sort((x, y) => y[1] - x[1])) console.log(`    ${String(v).padStart(4)}本  ${k}`);
  console.log(`\n[harvest-signals] out: ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { TOPICS, parseRelease, collectReleaseUrls, loadSeen, JSONL };
