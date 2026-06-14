'use strict';
// 1000件フル取得ドライバ（バックグラウンド長時間ジョブ向け）
//  1) 業種×地域の多様なクエリで一意な企業名を 1000 社まで発掘（Bing一覧記事を巡回・APIキー不要）
//  2) 各社を processCompany でフル取得（公式URL→電話→採用担当者→メール→Tier）
//  3) 数件ごとに 担当者マスタCSV と 再開ジャーナル(JSON) を書き出し（クラッシュ/レート制限に耐える）
//  4) 進捗を run1000.log と標準出力へ
//
//   node src/run1000.js                 # 既定: 1000社・発掘並列3・取得並列6
//   node src/run1000.js --target 1000 --concurrency 6 --dconc 3 --out leads-1000.csv
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { normalizeIcp } = require('./icp');
const { discoverFromQuery } = require('./discover');
const { processCompany } = require('./pipeline');
const { fetchPage, extractText, closeBrowser } = require('./fetch');
const { writeMasterCsv } = require('./master-io');
const { companyCore } = require('./search');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

const TARGET = parseInt(getArg('target', '1000'), 10) || 1000;
const CONC = parseInt(getArg('concurrency', '6'), 10) || 6;
const DCONC = parseInt(getArg('dconc', '3'), 10) || 3;
const OUT = getArg('out', 'leads-1000.csv');
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const NAMES_JSON = path.join(DATA_DIR, 'names-1000.json');
const REC_JSON = path.join(DATA_DIR, 'records-1000.json');
const QDONE_JSON = path.join(DATA_DIR, 'queries-done.json');
const LOG = path.resolve(__dirname, '..', 'run1000.log');

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

// ---- 第1ジョブで実行済みのクエリ（再発掘で重複させない）----
const ORIG_REGIONS = ['東京', '大阪', '名古屋', '横浜', '福岡', '札幌', '神戸', '京都',
  '埼玉', '千葉', '仙台', '広島', '静岡', '新潟', '金沢'];
const ORIG_INDUSTRIES = ['IT', 'SaaS', 'システム開発', 'Web制作', '製造', 'メーカー', '機械', '電子部品',
  '建設', '不動産', '人材', '広告', '物流', '商社', '小売', '飲食', '食品', '医療機器',
  '介護', '教育', 'コンサルティング', '金融', 'アパレル', '印刷', '運輸', '化学', '環境'];

// ---- 拡張クエリの母集団（一覧記事の多様性を稼ぐ）----
const WARDS = ['渋谷区', '新宿区', '港区', '千代田区', '中央区', '品川区', '目黒区', '世田谷区',
  '文京区', '豊島区', '台東区', '墨田区', '江東区', '大田区', '杉並区', '中野区', '板橋区',
  '北区', '荒川区', '足立区', '葛飾区', '江戸川区', '練馬区', '横浜市', '川崎市', 'さいたま市',
  '千葉市', '堺市', '北九州市', '船橋市', '町田市', '立川市', '八王子市'];
const MORE_REGIONS = ['岡山', '熊本', '鹿児島', '長野', '岐阜', '三重', '滋賀', '奈良', '和歌山',
  '群馬', '栃木', '茨城', '山梨', '富山', '福井', '愛媛', '香川', '長崎', '大分', '宮崎',
  '青森', '岩手', '秋田', '山形', '福島', '宮城', '兵庫', '愛知', '神奈川', '北海道'];
const MORE_INDUSTRIES = ['ソフトウェア', 'アプリ開発', 'DX', 'AI', '通信', '半導体', '自動車部品',
  '精密機器', '鉄鋼', '繊維', '化粧品', '日用品', '玩具', '出版', '放送', 'ゲーム', 'エンタメ',
  'スポーツ', '警備', '清掃', 'リフォーム', '住宅', '設備工事', '卸売', '専門商社', '保険',
  '証券', 'リース', '会計事務所', '病院', '薬局', '保育', '学習塾', '専門学校', '農業',
  '水産', '観光', 'ホテル', '旅館', '航空', '鉄道', '倉庫', '飲料', '製薬', '電機'];
const QUALIFIERS = ['企業', '企業 一覧', 'ベンチャー', '中小企業', 'BtoB 企業', '優良企業', 'メーカー 一覧'];

// 既出（第1ジョブ）の正確な集合
function origQuerySet() {
  const s = new Set();
  for (const r of ORIG_REGIONS) for (const ind of ORIG_INDUSTRIES) s.add(`${r} ${ind} 企業`);
  return s;
}

// 拡張クエリ列（地域外ループ・業種内ループ。業種の開始位置を地域ごとにずらして多様化）。
function buildExpandedQueries() {
  const regions = [...WARDS, ...MORE_REGIONS, ...ORIG_REGIONS];
  const industries = [...MORE_INDUSTRIES, ...ORIG_INDUSTRIES];
  const out = [];
  regions.forEach((r, ri) => {
    industries.forEach((ind, ii) => {
      const q = QUALIFIERS[(ri + ii) % QUALIFIERS.length];
      out.push(`${r} ${ind} ${q}`.replace(/\s+/g, ' ').trim());
    });
  });
  // 地域×限定語（業種非依存の一覧記事も拾う）
  for (const r of regions) { out.push(`${r} ベンチャー企業 一覧`); out.push(`${r} 優良企業 ランキング`); }
  return [...new Set(out)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 並列プール（共有 index）
async function pool(items, n, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i], i); }
  });
  await Promise.all(runners);
}

// ---- フェーズ1: 発掘 ----
async function discoverNames() {
  const seen = new Set();
  const names = [];
  const add = (n) => {
    const key = companyCore(n).toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); names.push(n); return true; }
    return false;
  };

  // 既存の発掘結果を引き継ぐ
  if (fs.existsSync(NAMES_JSON)) {
    try { for (const n of JSON.parse(fs.readFileSync(NAMES_JSON, 'utf8'))) add(n); } catch (_) {}
  }
  log(`発掘: 既存 ${names.length}社 を引き継ぎ`);
  if (names.length >= TARGET) return names.slice(0, TARGET);

  // 実行済みクエリ（第1ジョブの405本＋ジャーナル）はスキップ
  const done = origQuerySet();
  if (fs.existsSync(QDONE_JSON)) {
    try { for (const q of JSON.parse(fs.readFileSync(QDONE_JSON, 'utf8'))) done.add(q); } catch (_) {}
  }

  const queries = buildExpandedQueries().filter((q) => !done.has(q));
  log(`発掘開始: 目標 ${TARGET}社 / 追加クエリ ${queries.length}本（並列${DCONC}）`);

  let stop = false;
  let persistCtr = 0;
  await pool(queries, DCONC, async (q) => {
    if (stop) return;
    let got = [];
    try { got = await discoverFromQuery(q, { fetchPage, extractText }, { limit: 60, pages: 3 }); }
    catch (e) { log(`  発掘失敗「${q}」: ${e.message}`); done.add(q); return; }
    let added = 0;
    for (const n of got) { if (add(n)) added++; if (names.length >= TARGET) break; }
    done.add(q);
    if (++persistCtr % 3 === 0 || added > 0) {
      fs.writeFileSync(NAMES_JSON, JSON.stringify(names));
      fs.writeFileSync(QDONE_JSON, JSON.stringify([...done]));
    }
    log(`  「${q}」 +${added}（累計 ${names.length}/${TARGET}）`);
    if (names.length >= TARGET) stop = true;
  });

  fs.writeFileSync(NAMES_JSON, JSON.stringify(names));
  fs.writeFileSync(QDONE_JSON, JSON.stringify([...done]));
  log(`発掘完了: ${names.length}社`);
  return names.slice(0, TARGET);
}

// ---- フェーズ2: フル取得 ----
async function main() {
  const t0 = Date.now();
  log(`===== 1000件フル取得ジョブ開始（target=${TARGET}, 取得並列=${CONC}, 発掘並列=${DCONC}）=====`);
  const icp = normalizeIcp({ source: 'manual' }, cfg);

  const names = await discoverNames();
  if (names.length < TARGET) log(`⚠ 発掘が目標未達: ${names.length}/${TARGET}（取得できた分で続行）`);

  // 再開: 既存ジャーナルから完了済みを読み込み
  const recordsByKey = new Map();
  if (fs.existsSync(REC_JSON)) {
    try {
      for (const r of JSON.parse(fs.readFileSync(REC_JSON, 'utf8'))) recordsByKey.set(String(r['企業名'] || '').trim(), r);
      log(`再開: 既存 ${recordsByKey.size}件をジャーナルから復元`);
    } catch (_) {}
  }

  const todo = names.filter((n) => !recordsByKey.has(String(n).trim()));
  log(`フル取得対象: ${todo.length}社（完了済み ${recordsByKey.size}社をスキップ）`);

  let done = recordsByKey.size;
  let hit = 0, url = 0;
  const total = names.length;
  let flushPending = 0;

  const flush = () => {
    const records = names.map((n) => recordsByKey.get(String(n).trim())).filter(Boolean);
    writeMasterCsv(OUT, records, cfg.MASTER_HEADERS);
    fs.writeFileSync(REC_JSON, JSON.stringify(records));
  };

  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const cand = { name: todo[idx++], corporateNumber: '', domain: '', websiteUrl: '',
        representativeName: '', prefecture: '', employees: null, industry: '', source: 'search' };
      try {
        const { record, result } = await processCompany(cand, icp, cfg);
        recordsByKey.set(String(cand.name).trim(), record);
        if (result.status === 'HIT') hit++;
        if (record['公式URL']) url++;
      } catch (e) {
        recordsByKey.set(String(cand.name).trim(), { '企業名': cand.name, 'Tier': 'D',
          '取得元媒体': 'ERROR', '根拠URL': '', '取得日': new Date().toISOString() });
        log(`  ✗ ${cand.name}: ${e.message}`);
      }
      done++;
      if (++flushPending >= 5) { flushPending = 0; flush(); }
      if (done % 10 === 0) {
        const el = (Date.now() - t0) / 1000;
        const rate = done / el;
        const eta = rate > 0 ? ((total - done) / rate / 60).toFixed(1) : '?';
        log(`進捗 ${done}/${total}（URL取得${url} / 担当者HIT${hit}）｜ETA約${eta}分`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, () => worker()));
  flush();
  await closeBrowser();

  const records = names.map((n) => recordsByKey.get(String(n).trim())).filter(Boolean);
  const tier = records.reduce((a, r) => { a[r.Tier] = (a[r.Tier] || 0) + 1; return a; }, {});
  log(`===== 完了: ${records.length}件 ｜ URL取得 ${url} ｜ 担当者HIT ${hit} =====`);
  log(`Tier内訳: A=${tier.A || 0} B=${tier.B || 0} C=${tier.C || 0} D=${tier.D || 0}`);
  log(`出力: ${path.resolve(OUT)}（所要 ${((Date.now() - t0) / 60000).toFixed(1)}分）`);
}

main().catch((e) => { log('FATAL ' + (e && e.stack ? e.stack : e)); closeBrowser().finally(() => process.exit(1)); });
