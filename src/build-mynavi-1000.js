'use strict';
/**
 * マイナビ ディスカバリ・ハーベスタ — 採用担当者名つき企業を1000件集める（3パターン抽出スキル駆動）
 * ============================================================================
 * 方針（Wantedly 1000件と同じ discovery-first）:
 *   固定リストを引くと大半が「マイナビ非掲載」で空振りする（掲載率~11%）。そこで、
 *   フリーワード検索の結果ページから「マイナビ掲載企業」を直接列挙し、その corpID に対して
 *   mynavi-name-extract の3パターン（① 伝言板の名乗り / ② インタビュー帰属 / ③ 問合せ先）を当てる。
 *   母集団を最初から掲載側に寄せるので担当者名の歩留まりが跳ね上がる。
 *
 * 特徴:
 *   - 再開可能: 出力CSV と seen(corpID) 台帳を読み直し、既処理はスキップ。
 *   - アトミック＆EPERM耐性: Desktop(OneDrive)のリネームロックを retry で吸収。
 *   - 目標到達で停止: 担当者名つき（採用担当者名 != ''）が --target 件に達したら終了。
 *
 * 使い方:
 *   node src/build-mynavi-1000.js --out data/recruiter-mynavi-1000.csv --target 1000 [--keywords data/mynavi-keywords.txt] [--max-companies 20000]
 *   MYNAVI_GRAD_YEAR=27（シーズンで更新）。MYNAVI_POLITE_MS で1社間隔を調整。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { MynaviScraper } = require('./scrape-mynavi');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const OUT = getArg('out', path.join('data', 'recruiter-mynavi-1000.csv'));
const TARGET = parseInt(getArg('target', '1000'), 10) || 1000;
const MAX_COMPANIES = parseInt(getArg('max-companies', '25000'), 10) || 25000;
const KEYWORDS_FILE = getArg('keywords', '');
const PER_COMPANY_MS = parseInt(getArg('company-timeout', '75000'), 10) || 75000;
const DELAY = parseInt(process.env.MYNAVI_POLITE_MS || '1500', 10);

// 掲載SMEを広く列挙するためのフリーワード群（業種×職種×地域）。各クエリで最大~100社の corpID が取れる。
// 重複は seen 台帳で自動排除。必要なら --keywords でファイル差し替え可。
const DEFAULT_KEYWORDS = [
  // 業種
  'メーカー', '食品', '自動車', '機械', '電機', '電子部品', '半導体', '化学', '医薬品', '化粧品',
  '金属', '鉄鋼', '繊維', '印刷', '紙', 'ガラス', 'ゴム', '住宅', '建設', '建築', '土木', '設備',
  '不動産', '商社', '専門商社', '卸売', '小売', 'スーパー', '百貨店', '専門店', 'アパレル', '外食',
  '飲食', 'ホテル', '旅行', 'ブライダル', '物流', '運輸', '倉庫', '陸運', '海運', '航空',
  'IT', 'ソフトウェア', 'システム', 'Web', 'ゲーム', '通信', 'インターネット', '広告', '出版', 'マスコミ',
  '金融', '銀行', '信用金庫', '証券', '保険', 'リース', 'コンサル', '人材', '教育', '福祉',
  '介護', '医療', '病院', '調剤', 'ドラッグ', '農業', '水産', '林業', '環境', 'エネルギー',
  '電力', 'ガス', '石油', '警備', 'ビルメンテナンス', '清掃', '自動車整備', '製造',
  // 職種軸
  '技術職', '営業職', '事務職', '施工管理', '生産技術', '品質管理', '研究開発', '設計', 'エンジニア',
  '販売職', '企画', 'マーケティング', 'デザイナー', '総合職',
  // 地域軸（掲載の地方SMEを掘る）
  '北海道 新卒', '東北 新卒', '仙台 新卒', '関東 新卒', '東京 新卒', '神奈川 新卒', '埼玉 新卒',
  '千葉 新卒', '名古屋 新卒', '愛知 新卒', '静岡 新卒', '大阪 新卒', '京都 新卒', '兵庫 新卒',
  '広島 新卒', '岡山 新卒', '福岡 新卒', '九州 新卒', '沖縄 新卒', '北陸 新卒', '新潟 新卒',
  '長野 新卒', '岐阜 新卒', '三重 新卒', '四国 新卒', '中国地方 新卒',
];

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); });
  });
}

// EPERM(Desktop/OneDriveのリネームロック)に強いアトミック書込。renameに失敗したら直書きへフォールバック。
function safeWrite(absPath, content) {
  const tmp = absPath + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, absPath); return; }
    catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(absPath, content); fs.unlinkSync(tmp); return; } catch (_) {} } }
  }
  try { fs.writeFileSync(absPath, content); fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
}

const HEADERS = ['企業名', 'corpID', 'マイナビ掲載', '採用担当者名', '担当者確度', 'パターン', '担当者根拠',
  '役職', '部署', 'メール', '電話番号', '従業員数', '募集職種', '採用予定人数', '卒年', '採用ページURL', '取得日'];

async function run() {
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  const SEENABS = OUTABS.replace(/\.csv$/, '') + '.seen.txt';

  // 再開: 既存出力と seen 台帳を読む
  const rows = [];
  const seen = new Set();
  if (fs.existsSync(OUTABS)) {
    try { for (const r of readCsv(fs.readFileSync(OUTABS, 'utf8')).records) { rows.push(r); if (r.corpID) seen.add(String(r.corpID)); } } catch (_) {}
  }
  if (fs.existsSync(SEENABS)) {
    try { for (const l of fs.readFileSync(SEENABS, 'utf8').split(/\r?\n/)) { const s = l.trim(); if (s) seen.add(s); } } catch (_) {}
  }
  let named = rows.filter((r) => r['採用担当者名']).length;
  log(`再開: 既存 ${rows.length}社（担当者名 ${named}）｜ seen ${seen.size}社`);

  const keywords = KEYWORDS_FILE && fs.existsSync(KEYWORDS_FILE)
    ? fs.readFileSync(KEYWORDS_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : DEFAULT_KEYWORDS;

  const flush = () => {
    safeWrite(OUTABS, toCsv(HEADERS, rows));
    safeWrite(SEENABS, [...seen].join('\n'));
  };

  const sc = new MynaviScraper();
  await sc.launch();
  let processed = 0;
  try {
    for (const kw of keywords) {
      if (named >= TARGET) break;
      if (seen.size >= MAX_COMPANIES) { log(`上限 ${MAX_COMPANIES}社に到達`); break; }
      const found = await sc.discoverCorpIds(kw);
      const fresh = found.filter((f) => !seen.has(String(f.id)));
      log(`🔍 "${kw}": 掲載 ${found.length}社（新規 ${fresh.length}社）｜ 累計担当者名 ${named}/${TARGET}`);
      for (const f of fresh) {
        if (named >= TARGET) break;
        seen.add(String(f.id));
        const r = await withTimeout(sc.scrapeByCorp(f.id, f.name), PER_COMPANY_MS, () => ({ 根拠: 'timeout', corpID: f.id, 企業名: f.name }));
        const row = { 企業名: r.企業名 || f.name, corpID: f.id, マイナビ掲載: r.マイナビ掲載 || '○',
          採用担当者名: r.採用担当者名 || '', 担当者確度: r.担当者確度 || '', パターン: r.パターン || '',
          担当者根拠: r.根拠 || '', 役職: r.役職 || '', 部署: r.部署 || '', メール: r.メール || '',
          電話番号: r.電話番号 || '', 従業員数: r.従業員数 || '', 募集職種: r.募集職種 || '', 採用予定人数: r.採用予定人数 || '',
          卒年: r.卒年 || '', 採用ページURL: r.採用ページURL || '', 取得日: new Date().toISOString().slice(0, 10) };
        rows.push(row);
        if (row.採用担当者名) named++;
        if (++processed % 10 === 0) {
          flush();
          log(`  処理 ${processed}｜ 掲載 ${rows.length}｜ 担当者名 ${named}（${(100 * named / Math.max(1, rows.length)).toFixed(1)}%）`);
        }
        await sleep(DELAY);
      }
      flush();
    }
  } finally {
    flush();
    await sc.close().catch(() => {});
  }
  named = rows.filter((r) => r['採用担当者名']).length;
  log(`完了: ${rows.length}社処理 ｜ 担当者名 ${named}件（${(100 * named / Math.max(1, rows.length)).toFixed(1)}%）`);
  log(`出力: ${OUTABS}`);
  // パターン別内訳
  const byPat = {};
  for (const r of rows) if (r['採用担当者名']) { const p = r['パターン'] || 'その他'; byPat[p] = (byPat[p] || 0) + 1; }
  log('パターン別: ' + JSON.stringify(byPat));
}

run().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
