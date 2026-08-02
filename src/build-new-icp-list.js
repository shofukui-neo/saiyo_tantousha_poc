'use strict';
/**
 * ICP適合 完全新規リスト ビルダー（ワンコマンド版）
 * =====================================================================
 * 「既存母集団(consolidated-all)＋納品台帳の外にいる × ICP適合 × 採用担当者名あり」の
 * 呼べる名指しリストを、コマンド1本で生成する。従来は未追跡スクラッチ
 * (_harvest_new.js → _finalize_new28.js → _enrich_outline.js → format-bales.js)を
 * env変数を差し替えながら手動で順に叩いていた。それを1プロセスに統合した。
 *
 * パイプライン（4フェーズ）:
 *   1. harvest : マイナビ現行卒年サイトを勝ち筋(非IT)キーワードで巡回し、pool/台帳に
 *                社名で載っていない企業だけをスクレイプ → data/recruiter-mynavi-new<gy>.csv
 *   2. map     : qualifiesForList(名+電話+新卒6名+従業員100-2000+非IT)で選別し、完全新規
 *                (pool/台帳になし)だけを consolidated スキーマへ写像 → mapped.csv
 *   3. enrich  : 会社概要(outline.html)を追加取得して 業種/都道府県/設立/従業員 を補完し、
 *                IT名/規模超(>2000)/非人名を除外（--skip-enrich でスキップ可）
 *   4. format  : format-bales.js で BALESCLOUD 取込構造(266列)へ整形し、納品台帳へ記録
 *
 * 使い方:
 *   node src/build-new-icp-list.js                 # 全フェーズ（マイナビ再スクレイプあり）
 *   node src/build-new-icp-list.js --skip-harvest  # 既存rawを使い、map以降だけ回す
 *   node src/build-new-icp-list.js --target 40 --grad-year 27 --out data/leads-new-icp.csv
 *   node src/build-new-icp-list.js --help
 *
 * ※ harvest/enrich は Playwright chromium が必要: npx playwright install chromium
 */
const P = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { readCsv, toCsv } = require('./csv');
const { createMatchIndex } = require('./company-match');
const { loadLedger, isDelivered } = require('./delivered-ledger');
const { qualifiesForList, proposalTier } = require('./icp-rules');
const { isPlausiblePersonName } = require('./jp-names');
const { MynaviScraper } = require('./scrape-mynavi');

const ROOT = P.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  console.log(`ICP適合 完全新規リスト ビルダー

使い方: node src/build-new-icp-list.js [options]

フェーズ: harvest → map → enrich → format

オプション:
  --target N          harvestの目標qualify社数（既定 60）
  --grad-year YY      マイナビ卒年サイト（既定 27＝最も成熟し担当者名の掲出率が高い。
                      28は季節初期で名前欠落が多い）
  --max-scrape N      harvestのスクレイプ上限社数（既定 1600）
  --keywords "a,b,c"  harvestキーワードを上書き（既定は勝ち筋・非ITの内蔵リスト）
  --out PATH          最終成果物パス（既定 data/leads-new-icp-<今日>.csv）
  --raw PATH          harvest中間CSV（既定 data/recruiter-mynavi-new<gy>.csv・再開可）
  --mapped PATH       map/enrich中間CSV（既定 data/leads-new-mynavi-mapped.csv）
  --skip-harvest      マイナビ再スクレイプを省き既存rawを使う
  --skip-enrich       outline補完（業種/都道府県）を省く
  --no-record         納品台帳への追記を省く（試し出力用）
  --help, -h          このヘルプ

必要環境: harvest/enrich は Playwright chromium（npx playwright install chromium）
`);
  process.exit(0);
}

const GY = getArg('--grad-year', process.env.MYNAVI_GRAD_YEAR || '27');
const TARGET_QUALIFY = parseInt(getArg('--target', '60'), 10);
const MAX_SCRAPE = parseInt(getArg('--max-scrape', '1600'), 10);
const DELAY = parseInt(process.env.MYNAVI_POLITE_MS || '1800', 10);
const PER_COMPANY_MS = 70000;
const RAW = P.resolve(getArg('--raw', P.join(ROOT, 'data', `recruiter-mynavi-new${GY}.csv`)));
const SEEN = RAW.replace(/\.csv$/, '') + '.seen.txt';
const MAPPED = P.resolve(getArg('--mapped', P.join(ROOT, 'data', 'leads-new-mynavi-mapped.csv')));
const today = new Date().toISOString().slice(0, 10);
const OUT = P.resolve(getArg('--out', P.join(ROOT, 'data', `leads-new-icp-${today}.csv`)));
const SKIP_HARVEST = has('--skip-harvest');
const SKIP_ENRICH = has('--skip-enrich') || has('--no-enrich');
const RECORD = !has('--no-record');

// ICP勝ち筋(非IT)キーワード：流通小売/金融保険/介護医療/メーカー機電/商社 ＋ 地域新卒
const DEFAULT_KEYWORDS = [
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
const KEYWORDS = (getArg('--keywords', '') || '').trim()
  ? getArg('--keywords', '').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_KEYWORDS;

const REP = /代表|社長|会長|取締役|理事長|監査役|オーナー|創業|CEO|COO|CFO|President|Founder/i;
// 会社名の明白なITシグナル（業種scrapeは不正確なため、社名だけで判る分を絶対除外に回す）
const NAME_IT_RE = /ソフトウ|ソフト技研|システム開発|システムズ|システム・|ＳＩ|SIer|SES|情報処理|情報システム|ソリューションズ|テクノロジーズ|デジタル|ネットワーク|ウェブ|ソフトウェア/;
const intOf = (s) => { const m = String(s || '').replace(/[^0-9]/g, ''); return m ? parseInt(m, 10) : null; };
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
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

// pool(consolidated-all)＋納品台帳の社名索引（scrape前スキップ・完全新規判定に共用）
function loadPoolIndex() {
  const idx = createMatchIndex();
  const poolFile = P.join(ROOT, 'data/leads-consolidated-all.csv');
  for (const r of readCsv(fs.readFileSync(poolFile, 'utf8')).records) idx.addRecord(r, 'pool');
  const ledger = loadLedger();
  return { inPool: (name) => idx.has(name) || isDelivered(ledger, { 企業名: name }), size: idx.size };
}

// ── フェーズ1: harvest（マイナビ新規スクレイプ） ────────────────────────
function harvestQualifies(r) {
  if (!g(r, '採用担当者名')) return false;
  if (!g(r, '電話番号')) return false;
  const hire = intOf(g(r, '採用予定人数')); const emp = intOf(g(r, '従業員数'));
  if (hire == null || hire < 6) return false;
  if (emp == null || emp < 100 || emp > 2000) return false;
  if (REP.test(g(r, '役職'))) return false;
  return true;
}
const RAW_HEADERS = ['企業名', 'corpID', 'マイナビ掲載', '採用担当者名', '担当者確度', 'パターン', '担当者根拠',
  '役職', '部署', 'メール', '電話番号', '従業員数', '募集職種', '採用予定人数', '卒年', '採用ページURL', '取得日'];

async function phaseHarvest() {
  log(`▼ harvest: gy=${GY} / target ${TARGET_QUALIFY} qualify / max ${MAX_SCRAPE} scrape / ${KEYWORDS.length}キーワード`);
  const { inPool, size } = loadPoolIndex();
  log(`  社名索引: pool ${size}社 + 台帳`);

  const rows = []; const seen = new Set();
  if (fs.existsSync(RAW)) { try { for (const r of readCsv(fs.readFileSync(RAW, 'utf8')).records) { rows.push(r); if (r.corpID) seen.add(String(r.corpID)); } } catch (_) {} }
  if (fs.existsSync(SEEN)) { try { for (const l of fs.readFileSync(SEEN, 'utf8').split(/\r?\n/)) { const s = l.trim(); if (s) seen.add(s); } } catch (_) {} }
  let qualify = rows.filter(harvestQualifies).length;
  let scraped = rows.length;
  if (rows.length) log(`  再開: 既存 ${rows.length}社（qualify ${qualify}）｜ seen ${seen.size}`);

  const flush = () => { safeWrite(RAW, toCsv(RAW_HEADERS, rows)); safeWrite(SEEN, [...seen].join('\n')); };

  const sc = new MynaviScraper({ gradYear: GY });
  await sc.launch();
  try {
    for (const kw of KEYWORDS) {
      if (qualify >= TARGET_QUALIFY || scraped >= MAX_SCRAPE) break;
      const found = await sc.discoverCorpIds(kw);
      const cands = found.filter((f) => f.id && !seen.has(String(f.id)) && f.name && !inPool(f.name));
      log(`  🔍 "${kw}": 掲載 ${found.length}／新規候補 ${cands.length}｜ qualify ${qualify}/${TARGET_QUALIFY} scraped ${scraped}/${MAX_SCRAPE}`);
      for (const f of cands) {
        if (qualify >= TARGET_QUALIFY || scraped >= MAX_SCRAPE) break;
        seen.add(String(f.id));
        const r = await withTimeout(sc.scrapeByCorp(f.id, f.name), PER_COMPANY_MS, () => ({ 根拠: 'timeout', corpID: f.id, 企業名: f.name }));
        const canonical = r.企業名 || f.name;
        if (inPool(canonical)) continue; // スクレイプ後の正式社名で再突合（別corpIDの既存企業を除外）
        rows.push({ 企業名: canonical, corpID: f.id, マイナビ掲載: r.マイナビ掲載 || '○',
          採用担当者名: r.採用担当者名 || '', 担当者確度: r.担当者確度 || '', パターン: r.パターン || '',
          担当者根拠: r.根拠 || '', 役職: r.役職 || '', 部署: r.部署 || '', メール: r.メール || '',
          電話番号: r.電話番号 || '', 従業員数: r.従業員数 || '', 募集職種: r.募集職種 || '', 採用予定人数: r.採用予定人数 || '',
          卒年: r.卒年 || '', 採用ページURL: r.採用ページURL || '', 取得日: today });
        scraped++;
        if (harvestQualifies(rows[rows.length - 1])) qualify++;
        if (scraped % 10 === 0) { flush(); log(`    scraped ${scraped}｜ qualify ${qualify}`); }
        await sleep(DELAY);
      }
      flush();
    }
  } finally {
    flush();
    await sc.close().catch(() => {});
  }
  log(`  harvest完了: scraped ${scraped}｜ qualify ${qualify}｜ → ${P.relative(ROOT, RAW)}`);
}

// ── フェーズ2: map（qualifiesForList選別 → consolidatedスキーマ写像） ────
const NON_NAME_WHOLE_RE = /^(窓口|ご担当|担当者|採用担当|人事担当|総務担当|人事|総務|受付|不明|なし|未定|未記入|御中|担当)$/;
const NAME_JUNK_TOKEN_RE = /^(が|を|は|に|へ|と|の|も|で)?(聞く|聞き|問い合わせ|問合せ|について|に関する|宛|より|御中|窓口|係|様|さん|氏|殿)$/;
function cleanRecruiterName(name) {
  let n = String(name || '').replace(/　/g, ' ').trim();
  if (!n) return '';
  if (NON_NAME_WHOLE_RE.test(n)) return '';
  const toks = n.split(/\s+/).filter(Boolean).filter((t) => !NAME_JUNK_TOKEN_RE.test(t));
  n = toks.join(' ').trim();
  if (!n || NON_NAME_WHOLE_RE.test(n)) return '';
  return n;
}
const MAPPED_HEADERS = ['企業名', '法人番号', '採用担当者名', '氏名検証', '担当者確度', '役職', '部署', '代表者名', '架電宛名', '電話番号', 'メール', 'メール確度', '公式URL', '業種', '都道府県', '従業員数', '設立年', '補助金', '上場', '新卒フラグ', '採用予定人数', '採用職種', '掲載媒体', '求人件数', '採用ページURL', 'アポ期待度', '優先度', 'MOCHICA適合', '確信度', '提案プラン', 'セグメント区分', 'ICPランク', '既存被り', '呼べる条件', '根拠URL', '取得日', '統合ソース数', '統合元ファイル'];

function phaseMap() {
  log(`▼ map: ${P.relative(ROOT, RAW)} → 完全新規ICP適合を選別`);
  if (!fs.existsSync(RAW)) { console.error(`  入力rawがありません: ${P.relative(ROOT, RAW)}（--skip-harvest を外すか --raw で指定）`); process.exit(1); }
  const { inPool } = loadPoolIndex();
  const records = readCsv(fs.readFileSync(RAW, 'utf8')).records;

  const out = [];
  const seenName = new Set();
  let dropName = 0, dropQual = 0, dropIT = 0, dropPool = 0, dropDup = 0;
  for (const r of records) {
    const name = g(r, '企業名'); if (!name) continue;
    const recruiter = cleanRecruiterName(g(r, '採用担当者名'));
    if (!recruiter) { dropName++; continue; }
    const phone = g(r, '電話番号');
    const hire = intOf(g(r, '採用予定人数'));
    const emp = intOf(g(r, '従業員数'));
    const pos = g(r, '役職');
    const q = qualifiesForList({ contactName: recruiter, phone, hire, emp, industry: '' });
    if (!q.pass) { dropQual++; continue; }
    if (REP.test(pos)) { dropQual++; continue; }
    if (NAME_IT_RE.test(name)) { dropIT++; continue; } // IT・ソフトは絶対除外（enrichを省いても効く）
    if (inPool(name)) { dropPool++; continue; }
    const nk = name.replace(/\s+/g, '').toLowerCase();
    if (seenName.has(nk)) { dropDup++; continue; }
    seenName.add(nk);

    const tier = proposalTier(emp);
    const rec = {};
    for (const h of MAPPED_HEADERS) rec[h] = '';
    rec['企業名'] = name;
    rec['採用担当者名'] = recruiter;
    rec['担当者確度'] = g(r, '担当者確度');
    rec['役職'] = pos;
    rec['部署'] = g(r, '部署');
    rec['架電宛名'] = (g(r, '部署') + (pos ? ' ' + pos : '') + ' ' + recruiter + ' 様').trim();
    rec['電話番号'] = phone;
    rec['メール'] = g(r, 'メール');
    rec['公式URL'] = g(r, '採用ページURL');
    rec['従業員数'] = String(emp);
    rec['新卒フラグ'] = '1';
    rec['採用予定人数'] = String(hire);
    rec['掲載媒体'] = 'マイナビ' + (g(r, '卒年') || GY);
    rec['採用ページURL'] = g(r, '採用ページURL');
    rec['提案プラン'] = tier.plan;
    rec['セグメント区分'] = tier.segment;
    rec['呼べる条件'] = 'OK';
    rec['根拠URL'] = g(r, '採用ページURL');
    rec['取得日'] = g(r, '取得日') || today;
    rec['統合ソース数'] = '1';
    rec['統合元ファイル'] = P.basename(RAW);
    out.push(rec);
  }
  safeWrite(MAPPED, '﻿' + toCsv(MAPPED_HEADERS, out));
  log(`  map: 入力 ${records.length}件｜除外 名NG ${dropName}/ICP不適合 ${dropQual}/IT除外 ${dropIT}/pool被り ${dropPool}/名重複 ${dropDup}`);
  log(`  map完了: 完全新規ICP適合 ${out.length}件 → ${P.relative(ROOT, MAPPED)}`);
  return out.length;
}

// ── フェーズ3: enrich（会社概要で業種/都道府県/設立/従業員を補完） ────────
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
const prefOf = (s) => { for (const p of PREFS) if (String(s || '').includes(p)) return p; return ''; };

async function scrapeOutline(pg, url) {
  const info = { 業種: '', 本社所在地: '', 本社: '', 設立: '', 従業員: '', url: '' };
  await pg.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pg.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const data = await pg.evaluate(() => {
    const res = { pairs: [], homepage: '' };
    for (const dl of document.querySelectorAll('dl, table')) {
      for (const dt of dl.querySelectorAll('dt, th')) {
        const dd = dt.nextElementSibling;
        if (dd && /dd|td/i.test(dd.tagName)) {
          res.pairs.push([(dt.innerText || '').replace(/\s+/g, ' ').trim(), (dd.innerText || '').replace(/\s+/g, ' ').trim()]);
        }
      }
    }
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      if (/ホームページ|公式|コーポレート|会社概要/.test(a.innerText || '') && !/mynavi\.jp/.test(a.href)) { res.homepage = a.href; break; }
    }
    return res;
  }).catch(() => ({ pairs: [], homepage: '' }));
  for (const [k, v] of data.pairs) {
    if (!info.業種 && /^業種/.test(k)) info.業種 = v;
    if (!info.本社所在地 && /本社所在地/.test(k)) info.本社所在地 = v;
    if (!info.本社 && /^本社$/.test(k)) info.本社 = v;
    if (!info.設立 && /^設立/.test(k)) info.設立 = v;
    if (!info.従業員 && /^従業員/.test(k)) info.従業員 = v;
  }
  info.url = data.homepage || '';
  return info;
}

async function phaseEnrich() {
  log('▼ enrich: 会社概要(outline)で業種/都道府県/設立/従業員を補完＋IT名・規模超を除外');
  const { records } = readCsv(fs.readFileSync(MAPPED, 'utf8'));
  if (!records.length) { log('  (対象0件・スキップ)'); return; }
  const headers = Object.keys(records[0]);
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  const pg = await b.newPage();
  const kept = [];
  let dropIT = 0, dropBig = 0, dropName = 0, i = 0;
  try {
    for (const r of records) {
      i++;
      const name = g(r, '企業名');
      const recruiter = g(r, '採用担当者名');
      if (!isPlausiblePersonName(recruiter) && recruiter.length <= 2 && /^(特徴|概要|詳細|会社|募集|採用|人事|総務|担当)$/.test(recruiter)) { dropName++; continue; }
      const url = g(r, '採用ページURL');
      let info = { 業種: '', 本社所在地: '', 本社: '', 設立: '', 従業員: '', url: '' };
      if (/^https?:\/\//.test(url)) { try { info = await scrapeOutline(pg, url); } catch (_) {} await sleep(1200); }
      let emp = intOf(g(r, '従業員数'));
      if (emp == null) { const m = String(info.従業員 || '').match(/([\d,]+)\s*名/); if (m) emp = parseInt(m[1].replace(/,/g, ''), 10); }
      if (emp != null && emp > 2000) { dropBig++; continue; } // 規模上限（>2000は自前/競合ATS濃厚）
      if (NAME_IT_RE.test(name)) { dropIT++; continue; }     // 業種scrapeは不正確→会社名の明白なITシグナルのみ落とす
      r['業種'] = info.業種 || g(r, '業種');
      const pref = prefOf(info.本社所在地) || prefOf(info.本社);
      r['都道府県'] = pref || g(r, '都道府県');
      if (emp != null) r['従業員数'] = String(emp);
      if (info.設立) r['設立年'] = (info.設立.match(/\d{4}/) || [''])[0];
      if (info.url) r['公式URL'] = info.url;
      kept.push(r);
      if (i % 10 === 0) log(`  ...${i}/${records.length}社`);
    }
  } finally {
    await b.close().catch(() => {});
  }
  safeWrite(MAPPED, '﻿' + toCsv(headers, kept));
  log(`  enrich完了: ${records.length}社 → 確定 ${kept.length}社（IT除外 ${dropIT}/規模超 ${dropBig}/名NG ${dropName}）`);
}

// ── フェーズ4: format（BALES構造へ整形＋台帳記録） ───────────────────────
function phaseFormat() {
  log(`▼ format: BALESCLOUD構造へ整形 → ${P.relative(ROOT, OUT)}`);
  const fmtArgs = ['src/format-bales.js', '--scope', 'callable', '--exclude-rep', '--icp-only', '--clean-names',
    '--in', MAPPED, '--out', OUT];
  if (!RECORD) fmtArgs.push('--no-record');
  const res = spawnSync(process.execPath, fmtArgs, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) { console.error('  format-bales.js が失敗しました'); process.exit(res.status || 1); }
}

// ── オーケストレーション ──────────────────────────────────────────────
async function main() {
  console.log('=== ICP適合 完全新規リスト ビルダー ===');
  if (!SKIP_HARVEST) await phaseHarvest();
  else log('▼ harvest: スキップ（--skip-harvest／既存rawを使用）');
  const n = phaseMap();
  if (n === 0) { log('完全新規ICP適合が0件のため終了（母集団拡張＝キーワード増/卒年切替、または条件緩和が必要）'); return; }
  if (!SKIP_ENRICH) await phaseEnrich();
  else log('▼ enrich: スキップ（--skip-enrich）');
  phaseFormat();
  console.log('\n✓ 完了。成果物はダウンロードフォルダへ移動して納品してください。');
  console.log(`  最終成果物: ${P.relative(ROOT, OUT)}`);
}
main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
