'use strict';
/**
 * 採用媒体ページ 統一スクレイピング・ドライバ（Playwright）
 * =====================================================================
 * 企業リスト(CSV)を入力に、選択した媒体ページ（リクナビ/キャリタス/ONE CAREER/マイナビ）を
 * 1社ずつ実ブラウザで巡回し、各社の
 *   掲載媒体 / 採用予定人数 / 採用職種 / 従業員数 / 資本金 / 設立 / 電話番号 / メール / 採用担当者名
 * を1行に統合して sources/A-pages.csv に出力する（系統A=採用メディア起点のソース）。
 *
 * 堅牢化（build-media.js と同思想）:
 *   - 1社ごとに per-company timeout で必ず打ち切り（SPAの無限待ち/OOMで固まるのを防ぐ）
 *   - アトミック書き込み＋再開（既存出力の処理済みキーをスキップ）
 *   - 媒体ホストへは 1社ずつ・操作間に delay（polite）
 *
 * 使い方:
 *   node src/scrape-pages.js --in leads-daihyou-1000.csv --out sources/A-pages.csv \
 *        --sites rikunabi,careertasu --limit 50
 *   # 既定の媒体: rikunabi,careertasu（報告書の本命2サイト）
 *   # 利用可能: rikunabi | careertasu | onecareer | mynavi
 *   # 環境変数: SCRAPE_HEADFUL=1 SCRAPE_DEBUG=1 SCRAPE_PAGE_DELAY_MS=3000
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, truthy, mergeKey } = require('./csv');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

// 指定msで必ず解決するタイムアウトラッパ（未解決promiseでの無限待ちを防ぐ）
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(typeof onTimeout === 'function' ? onTimeout() : onTimeout), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout && onTimeout()); });
  });
}

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// 媒体レジストリ。新しい媒体スクレイパはここに足すだけで統合される。
const SITES = {
  rikunabi: { name: 'リクナビ', mod: './scrape-rikunabi', cls: 'RikunabiScraper', flag: 'リクナビ掲載' },
  careertasu: { name: 'キャリタス', mod: './scrape-careertasu', cls: 'CareertasuScraper', flag: 'キャリタス掲載' },
  onecareer: { name: 'ワンキャリア', mod: './scrape-onecareer', cls: 'OnecareerScraper', flag: 'ワンキャリア掲載' },
  mynavi: { name: 'マイナビ', mod: './scrape-mynavi', cls: 'MynaviScraper', flag: 'マイナビ掲載' },
};

const HEADERS = ['企業名', '法人番号', '新卒フラグ', '掲載媒体', '掲載媒体数',
  '採用予定人数', '採用職種', '従業員数', '資本金', '設立', '電話番号', 'メール',
  '採用担当者名', '役職', '部署', '媒体URL', '取得日', '根拠'];

// 各媒体スクレイパの結果（媒体ごとに掲載フラグ列名が違う）を共通スキーマに正規化
function normalizeResult(r, site) {
  const listed = truthy(r[site.flag]) || truthy(r.掲載);
  return {
    listed,
    採用予定人数: r.採用予定人数 || '',
    採用職種: r.募集職種 || r.採用職種 || '',
    従業員数: r.従業員数 || '',
    資本金: r.資本金 || '',
    設立: r.設立 || '',
    電話番号: r.電話番号 || '',
    メール: r.メール || '',
    採用担当者名: r.採用担当者名 || '',
    役職: r.役職 || '',
    部署: r.部署 || '',
    URL: r.採用ページURL || '',
    根拠: r.根拠 || '',
  };
}

// 空欄優先で値を採る（先に取れた媒体の値を尊重）
function fill(row, key, val) { if (val && !row[key]) row[key] = val; }

async function main() {
  const IN = getArg('in', 'leads-daihyou-1000.csv');
  const OUT = getArg('out', path.join('sources', 'A-pages.csv'));
  const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
  const PER_COMPANY_MS = parseInt(getArg('company-timeout', '120000'), 10) || 120000;
  const FRESH = process.argv.includes('--fresh');
  const siteKeys = String(getArg('sites', 'rikunabi,careertasu'))
    .split(/[,;]/).map((s) => s.trim().toLowerCase()).filter((s) => SITES[s]);
  if (!siteKeys.length) { console.error('有効な --sites がありません（rikunabi,careertasu,onecareer,mynavi）'); process.exit(1); }

  const INABS = path.resolve(IN);
  if (!fs.existsSync(INABS)) { console.error(`入力CSVが見つかりません: ${INABS}`); process.exit(1); }
  let { records } = readCsv(fs.readFileSync(INABS, 'utf8'));
  if (LIMIT) records = records.slice(0, LIMIT);

  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });

  // ── 再開: 既存出力の処理済みキーをスキップ ──
  const out = [];
  const doneKeys = new Set();
  if (!FRESH && fs.existsSync(OUTABS)) {
    try {
      for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) {
        const k = mergeKey(r); if (k) { doneKeys.add(k); out.push(r); }
      }
      if (doneKeys.size) log(`再開: 既存 ${doneKeys.size}社をスキップ`);
    } catch (_) {}
  }
  const todo = records.filter((r) => { const k = mergeKey(r); return !k || !doneKeys.has(k); });
  log(`対象 ${todo.length}社 × 媒体[${siteKeys.map((k) => SITES[k].name).join('/')}]（1社ずつ丁寧に）`);

  // ── 媒体スクレイパを起動（媒体ごとに1ブラウザを再利用）──
  const scrapers = [];
  for (const k of siteKeys) {
    const site = SITES[k];
    try {
      const Mod = require(site.mod);
      const Cls = Mod[site.cls];
      const sc = new Cls();
      await sc.launch();
      scrapers.push({ key: k, site, sc });
    } catch (e) {
      log(`  [警告] ${site.name} 起動失敗（スキップ）: ${String(e && e.message || e).slice(0, 80)}`);
    }
  }
  if (!scrapers.length) { console.error('媒体スクレイパを1つも起動できませんでした（playwright未導入？ npx playwright install chromium）'); process.exit(1); }

  const flush = () => { const tmp = OUTABS + '.tmp'; fs.writeFileSync(tmp, toCsv(HEADERS, out)); fs.renameSync(tmp, OUTABS); };
  let done = 0;

  try {
    for (const rec of todo) {
      const name = rec['企業名'] || rec['company_name'] || '';
      const row = {
        企業名: name, 法人番号: rec['法人番号'] || '', 新卒フラグ: '', 掲載媒体: '', 掲載媒体数: 0,
        採用予定人数: '', 採用職種: '', 従業員数: '', 資本金: '', 設立: '', 電話番号: '', メール: '',
        採用担当者名: '', 役職: '', 部署: '', 媒体URL: '', 取得日: new Date().toISOString().slice(0, 10), 根拠: '',
      };
      const hits = [];
      const evid = [];
      if (name) {
        for (const { site, sc } of scrapers) {
          const r = await withTimeout(
            sc.scrapeCompany(name).catch((e) => ({ 根拠: 'error:' + String(e && e.message || e).slice(0, 60) })),
            PER_COMPANY_MS,
            () => ({ 根拠: 'timeout' }),
          );
          const n = normalizeResult(r || {}, site);
          if (n.listed) {
            hits.push(site.name);
            if (n.URL && !row.媒体URL) row.媒体URL = n.URL;
          }
          fill(row, '採用予定人数', n.採用予定人数);
          fill(row, '採用職種', n.採用職種);
          fill(row, '従業員数', n.従業員数);
          fill(row, '資本金', n.資本金);
          fill(row, '設立', n.設立);
          fill(row, '電話番号', n.電話番号);
          fill(row, 'メール', n.メール);
          fill(row, '採用担当者名', n.採用担当者名);
          fill(row, '役職', n.役職);
          fill(row, '部署', n.部署);
          if (n.根拠) evid.push(`${site.name}:${n.根拠}`);
          await sleep(scrapers.length > 1 ? 500 : 0); // 媒体切替の小休止
        }
      }
      row.掲載媒体 = hits.join('/');
      row.掲載媒体数 = hits.length;
      if (hits.length || row.採用予定人数 || row.採用職種) row.新卒フラグ = '○';
      row.根拠 = evid.join(' | ').slice(0, 240);
      out.push(row);
      if (++done % 5 === 0) {
        flush();
        log(`  ${done}/${todo.length}（掲載ヒット ${out.filter((r) => r.掲載媒体数 > 0).length} / 担当者 ${out.filter((r) => r.採用担当者名).length}）`);
      }
    }
  } finally {
    flush();
    for (const { sc } of scrapers) await sc.close().catch(() => {});
  }

  const withMedia = out.filter((r) => Number(r.掲載媒体数) > 0).length;
  const withName = out.filter((r) => r.採用担当者名).length;
  const withEmp = out.filter((r) => r.従業員数).length;
  log(`完了: ${out.length}社 ｜ 媒体掲載 ${withMedia} ｜ 担当者名 ${withName} ｜ 従業員数 ${withEmp}`);
  log(`出力: ${OUTABS}`);
}

main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exit(1); });
