'use strict';
/**
 * マイナビ「真の新規」ハーベスタ（1回きりの補充用・スクラッチ）
 * ============================================================================
 * 既存 pool(consolidated-all) と 納品台帳 に「社名」で載っていない企業だけをスクレイプする。
 * discovery で得た検索結果リンクの社名を先に突合し、既存社名は scrape せずスキップ（時間節約）。
 * gy=28（現行季節）。ICP勝ち筋業種キーワードで母集団を非ITへ寄せる。
 * 再開可: 出力CSV と .seen(corpID) を読み直す。
 */
const P = require('path');
const fs = require('fs');
const R = (p) => require(P.join(__dirname, p));
const { readCsv, toCsv } = R('src/csv');
const { createMatchIndex } = R('src/company-match');
const { loadLedger, isDelivered } = R('src/delivered-ledger');
const { MynaviScraper } = R('src/scrape-mynavi');

const GY = process.env.MYNAVI_GRAD_YEAR || '28';
const OUT = P.join(__dirname, 'data', process.env.HARVEST_OUT || 'recruiter-mynavi-new28.csv');
const SEEN = OUT.replace(/\.csv$/, '') + '.seen.txt';
const TARGET_QUALIFY = parseInt(process.env.TARGET_QUALIFY || '100', 10);
const MAX_SCRAPE = parseInt(process.env.MAX_SCRAPE || '1600', 10);
const DELAY = parseInt(process.env.MYNAVI_POLITE_MS || '1800', 10);
const PER_COMPANY_MS = 70000;

// ICP勝ち筋(非IT)キーワード：流通小売/金融保険/介護医療/メーカー機電/商社 ＋ 地域新卒
const KEYWORDS = [
  // 流通・小売・物販（40%）
  '小売', 'スーパー', '専門店', 'ドラッグストア', 'ホームセンター', 'アパレル', '百貨店', '量販店', '流通', '物販', '商業施設', 'カー用品', '家電量販',
  // 金融・保険（35%／信金は除外方針なので入れない）
  '金融', '銀行', '証券', '保険', '生命保険', '損害保険', 'リース', 'クレジット', '信販', 'ファイナンス',
  // 介護・医療（31%）
  '介護', '医療', '病院', '調剤薬局', 'ドラッグ', '福祉', '老人ホーム', 'デイサービス', '看護', '歯科',
  // メーカー機電（30%）
  '機械メーカー', '電機メーカー', '電子部品', '自動車部品', '産業機械', '精密機器', '電気機器', '半導体製造装置', '計測機器', '設備機器', '食品メーカー', '医薬品メーカー', '化粧品メーカー',
  // 商社（26%）
  '商社', '専門商社', '総合商社', '卸売', '貿易', '食品商社', '機械商社', '鉄鋼商社',
  // 地域新卒（地方中堅を掘る）
  '北海道 新卒', '仙台 新卒', '東北 新卒', '埼玉 新卒', '千葉 新卒', '神奈川 新卒', '静岡 新卒',
  '名古屋 新卒', '愛知 新卒', '新潟 新卒', '長野 新卒', '北陸 新卒', '京都 新卒', '兵庫 新卒',
  '岡山 新卒', '広島 新卒', '福岡 新卒', '九州 新卒', '四国 新卒', '沖縄 新卒',
];

const REP = /代表|社長|会長|取締役|理事長|監査役|オーナー|創業|CEO|COO|CFO|President|Founder/i;
const intOf = (s) => { const m = String(s || '').replace(/[^0-9]/g, ''); return m ? parseInt(m, 10) : null; };
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); });
  });
}
function safeWrite(abs, content) {
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, abs); return; }
    catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} } }
  }
  try { fs.writeFileSync(abs, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}
function qualifies(r) {
  if (!g(r, '採用担当者名')) return false;
  if (!g(r, '電話番号')) return false;
  const hire = intOf(g(r, '採用予定人数')); const emp = intOf(g(r, '従業員数'));
  if (hire == null || hire < 6) return false;
  if (emp == null || emp < 100 || emp > 2000) return false;
  if (REP.test(g(r, '役職'))) return false;
  return true;
}

const HEADERS = ['企業名', 'corpID', 'マイナビ掲載', '採用担当者名', '担当者確度', 'パターン', '担当者根拠',
  '役職', '部署', 'メール', '電話番号', '従業員数', '募集職種', '採用予定人数', '卒年', '採用ページURL', '取得日'];

async function run() {
  // 既存 pool + 台帳 の社名索引（scrape前スキップ用）
  const idx = createMatchIndex();
  for (const r of readCsv(fs.readFileSync(P.join(__dirname, 'data/leads-consolidated-all.csv'), 'utf8')).records) idx.addRecord(r, 'pool');
  const ledger = loadLedger();
  log(`社名索引: pool ${idx.size}社 + 台帳`);

  // 再開
  const rows = []; const seen = new Set();
  if (fs.existsSync(OUT)) { try { for (const r of readCsv(fs.readFileSync(OUT, 'utf8')).records) { rows.push(r); if (r.corpID) seen.add(String(r.corpID)); } } catch (_) {} }
  if (fs.existsSync(SEEN)) { try { for (const l of fs.readFileSync(SEEN, 'utf8').split(/\r?\n/)) { const s = l.trim(); if (s) seen.add(s); } } catch (_) {} }
  let qualify = rows.filter(qualifies).length;
  let scraped = rows.length;
  log(`再開: 既存 ${rows.length}社（qualify ${qualify}）｜ seen ${seen.size}`);

  const inPool = (name) => idx.has(name) || isDelivered(ledger, { 企業名: name });
  const flush = () => { safeWrite(OUT, toCsv(HEADERS, rows)); safeWrite(SEEN, [...seen].join('\n')); };

  const sc = new MynaviScraper({ gradYear: GY });
  await sc.launch();
  try {
    for (const kw of KEYWORDS) {
      if (qualify >= TARGET_QUALIFY || scraped >= MAX_SCRAPE) break;
      const found = await sc.discoverCorpIds(kw);
      // scrape前フィルタ: corpID未処理 かつ 社名が既存poolに無い
      const cands = found.filter((f) => f.id && !seen.has(String(f.id)) && f.name && !inPool(f.name));
      log(`🔍 "${kw}": 掲載 ${found.length}／新規候補(社名も新規) ${cands.length}｜ qualify ${qualify}/${TARGET_QUALIFY} scraped ${scraped}/${MAX_SCRAPE}`);
      for (const f of cands) {
        if (qualify >= TARGET_QUALIFY || scraped >= MAX_SCRAPE) break;
        seen.add(String(f.id));
        const r = await withTimeout(sc.scrapeByCorp(f.id, f.name), PER_COMPANY_MS, () => ({ 根拠: 'timeout', corpID: f.id, 企業名: f.name }));
        const canonical = r.企業名 || f.name;
        // スクレイプ後の正式社名で再度pool突合（別corpIDの既存企業を除外）
        if (inPool(canonical)) { continue; }
        const row = { 企業名: canonical, corpID: f.id, マイナビ掲載: r.マイナビ掲載 || '○',
          採用担当者名: r.採用担当者名 || '', 担当者確度: r.担当者確度 || '', パターン: r.パターン || '',
          担当者根拠: r.根拠 || '', 役職: r.役職 || '', 部署: r.部署 || '', メール: r.メール || '',
          電話番号: r.電話番号 || '', 従業員数: r.従業員数 || '', 募集職種: r.募集職種 || '', 採用予定人数: r.採用予定人数 || '',
          卒年: r.卒年 || '', 採用ページURL: r.採用ページURL || '', 取得日: new Date().toISOString().slice(0, 10) };
        rows.push(row); scraped++;
        if (qualifies(row)) qualify++;
        if (scraped % 10 === 0) { flush(); log(`  scraped ${scraped}｜ qualify ${qualify}`); }
        await sleep(DELAY);
      }
      flush();
    }
  } finally {
    flush();
    await sc.close().catch(() => {});
  }
  log(`完了: scraped ${scraped}｜ qualify ${qualify}｜ out ${OUT}`);
}
run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
