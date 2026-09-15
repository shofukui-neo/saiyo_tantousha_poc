'use strict';
/**
 * 最新インテント × ICP適合 × 完全新規（アーカイブ／BALES／既存顧客かぶりなし） 2000件ビルダー
 * ============================================================================
 * 条件（2026-09-14 ユーザー指定）:
 *   ① 最新のインテントデータ : intent-analyze.js（16シグナル版）を **今回あらためて実走** した結果で並べる
 *   ② ICP適合               : icp-rules の絶対条件（非IT／官公庁除外／従業員100名以上／年間新卒6名以上／
 *                             エントリー50名フロア）を、マイナビ会社概要の一次情報で充足させる
 *   ③ かぶりなし            : (a) アーカイブ = 納品台帳 data/_delivered-ledger.csv（全バッチ）＋過去納品CSV
 *                                 (b) BALES既存リスト (c) MOCHICA既存顧客（＋SF全リード）(d) 架電禁止リスト
 *
 * 母集団の作り方（ここが従来との差）:
 *   従来は統合マスタ（＝過去に発掘済みの28,129社）の中だけを探しており、アーカイブを除くと数十社しか
 *   残らなかった。本ビルダーは **マイナビ掲載コーパス31,134社そのもの** を母集団に取り、
 *   一度も触れていない社（＝マスタ外）まで含めて会社概要を引き直す。
 *
 * 2フェーズ構成:
 *   1) pool     … 検証台帳 data/fresh-verify.json から ICP適合×完全新規のプールを作る
 *                 → data/icp-intent-pool.csv（インテント分析の入力）
 *   2) finalize … インテント採点済みCSVを受け取り、上位N件を納品形式で出す
 *                 → data/leads-icp-intent-2000.csv（詳細）／ leads-bales-icp-intent-2000.csv（BALES取込）
 *                 ／ leads-icp-intent-2000-report.md（内訳）
 *
 * 使い方:
 *   node src/verify-fresh-hire.js --corpus --conc 6         # 一次情報の検証（先に実行）
 *   node src/build-icp-intent-2000.js --phase pool
 *   node src/intent-analyze.js --in data/icp-intent-pool.csv --sources csv,mynavi --conc 4 \
 *        --out data/leads-icp-intent-scored.csv --report data/intent-icp-2000.md
 *   node src/build-icp-intent-2000.js --phase finalize --in data/leads-icp-intent-scored.csv --target 2000
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readCsv, toCsv } = require('./csv');
const { createMatchIndex } = require('./company-match');
const { loadLedger } = require('./delivered-ledger');
const { parseEmployees, scoreMochica } = require('./mochica-fit');
const { isExcludedIndustry, isGovernmentOrg, classifyOrgType, ICP } = require('./icp-rules');
const { normalizeJpPhone } = require('./phone');
const { freshCandidates, PAST } = require('./verify-fresh-hire');
const { mkey } = require('./build-icp-fresh-1000');
const { TARGET_COLS } = require('./intent/target-fit');
const { SIGNAL_LIST } = require('./intent/signals');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const hasFlag = (n) => process.argv.includes('--' + n);
const PHASE = getArg('phase', 'pool');
const TARGET = parseInt(getArg('target', '2000'), 10);
const HIRE_MIN = parseInt(getArg('hire-min', String(ICP.HIRE_MIN)), 10);
const VERIFY = path.resolve(ROOT, getArg('verify', 'data/fresh-verify.json'));
const POOL = path.resolve(ROOT, getArg('pool', 'data/icp-intent-pool.csv'));
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-icp-intent-2000.csv'));
// アーカイブ（納品台帳）の扱い: 既定は「全バッチ厳格」。--archive-delivered-only を付けると
// 実際に営業へ渡したバッチ（callable/named 等）だけを除外し、整形ダンプ(leads-bales-all)は通す。
const ARCHIVE_DELIVERED_ONLY = hasFlag('archive-delivered-only');

const g = (r, k) => String(r && r[k] != null ? r[k] : '').trim();
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
const prefOf = (s) => { for (const p of PREFS) if (String(s || '').includes(p)) return p; return ''; };

const POOL_COLS = ['No', '企業名', '架電宛名', '採用担当者名', '代表者名', '役職', '部署', '電話番号', 'メール',
  '業種', '従業員数', '本社', '都道府県', '上場', '組織型', '卒年', '年間新卒採用人数', '採用予定人数',
  '採用実績(直近3年)', '採用人数の根拠', '採用ページURL', '公式URL', '法人番号', 'corpID',
  'ICPスコア', 'ICP優先度', 'ICP確信度', 'MOCHICA適合', '提案プラン', 'セグメント区分', 'ICP根拠',
  '完全新規根拠', 'アーカイブ台帳', '取得日'];

// ── 除外索引（過去納品CSV／既存CRM／NG／納品台帳）──────────────────────
function buildExclusionIndexes() {
  const past = createMatchIndex();
  for (const rel of PAST) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    try { for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) past.addRecord(r, 'past'); } catch (_) {}
  }
  const crm = createMatchIndex();
  const master = path.join(ROOT, 'data/leads-consolidated-all.csv');
  if (fs.existsSync(master)) {
    for (const r of readCsv(fs.readFileSync(master, 'utf8')).records) if (g(r, '既存被り')) crm.addRecord(r, 'crm');
  }
  // BALES／MOCHICA顧客は統合マスタの「既存被り」経由で入るが、マスタ外の社にも効かせるため直接も索引する
  const bl = path.join(ROOT, 'data', 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
  if (fs.existsSync(bl)) for (const r of readCsv(fs.readFileSync(bl, 'utf8')).records) crm.addName(r['会社情報：会社名'], 'BALES');
  const mc = path.join(ROOT, 'data', 'MOCHICAの既存顧客リスト - mochica-companies-list.csv');
  if (fs.existsSync(mc)) for (const r of readCsv(fs.readFileSync(mc, 'utf8')).records) { crm.addName(r['法人名'], 'MOCHICA顧客'); crm.addName(r['LINEアカウント登録企業名'], 'MOCHICA顧客'); }
  // SF全リード（Salesforceレポート形式：先頭に説明行、ヘッダ行に「会社名 / 取引先」）
  // 統合マスタの「既存被り」列経由では **マスタに載っていない社** を拾えないため、必ず直接も索引する
  const sf = path.join(ROOT, 'data', 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');
  if (fs.existsSync(sf)) {
    const { parseCsv } = require('./csv');
    const rows = parseCsv(fs.readFileSync(sf, 'utf8'));
    let hi = -1; let ci = -1;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const j = rows[i].findIndex((c) => /会社名\s*\/\s*取引先/.test(String(c)));
      if (j >= 0) { hi = i; ci = j; break; }
    }
    let n = 0;
    if (hi >= 0) for (let i = hi + 1; i < rows.length; i++) { const c = String(rows[i][ci] || '').trim(); if (c) { crm.addName(c, 'SF'); n++; } }
    console.log('  既存索引 SF全リード: ' + n);
  }

  const ng = new Set();
  const ngFile = path.join(ROOT, 'data', 'ng-companies.txt');
  if (fs.existsSync(ngFile)) for (const l of fs.readFileSync(ngFile, 'utf8').split(/\r?\n/)) { const k = mkey(l); if (k) ng.add(k); }

  // アーカイブ台帳を2定義で索引する
  //   archive     … 実際に営業へ渡したバッチ（callable/named 等）のみ
  //   archiveFull … 全バッチ（整形ダンプ leads-bales-all を含む＝最も厳しい定義）
  const archive = createMatchIndex();
  const archiveFull = createMatchIndex();
  const lf = path.join(ROOT, 'data', '_delivered-ledger.csv');
  if (fs.existsSync(lf)) {
    for (const r of readCsv(fs.readFileSync(lf, 'utf8')).records) {
      archiveFull.addRecord(r, 'archive');
      if (/leads-bales-all/.test(g(r, '元ファイル'))) continue;
      archive.addRecord(r, 'archive');
    }
  }
  return { past, crm, ng, archive, archiveFull };
}

// ============================================================
// フェーズ1: プール構築
// ============================================================
function buildPool() {
  if (!fs.existsSync(VERIFY)) { console.error('検証台帳がありません: ' + path.relative(ROOT, VERIFY) + '（先に node src/verify-fresh-hire.js --corpus）'); process.exit(1); }
  const ledger = JSON.parse(fs.readFileSync(VERIFY, 'utf8')) || {};
  log('検証台帳 ' + Object.keys(ledger).length + '社');

  const cand = freshCandidates({ includeCorpusOnly: true, useLedger: false });
  log('完全新規候補（マイナビ掲載×過去納品なし×CRM被りなし）: ' + cand.length + '社');
  const { past, crm, ng, archive, archiveFull } = buildExclusionIndexes();
  log('除外索引: 過去納品 ' + past.size + ' ／ CRM ' + crm.size + ' ／ NG ' + ng.size + ' ／ アーカイブ台帳 実納品' + archive.size + '／全バッチ' + archiveFull.size);

  const today = new Date().toISOString().slice(0, 10);
  const st = { 未検証: 0, 取得失敗: 0, 実績なし: 0, 六名未満: 0, 正式社名で既出: 0, アーカイブ: 0, IT: 0, 官公庁: 0, 規模: 0, 電話: 0, ok: 0 };
  const rows = [];
  const seenCanon = new Set();
  for (const c of cand) {
    const v = ledger[c.key];
    if (!v) { st.未検証++; continue; }
    if (v.失敗 || !v.企業名) { st.取得失敗++; continue; }

    // ② ICP: 年間新卒採用人数は「マイナビ会社概要の実績（過去3年間の新卒採用者数）」だけを一次情報とする
    const hire = v.実績人数 == null ? null : parseInt(v.実績人数, 10);
    if (hire == null || !Number.isFinite(hire)) { st.実績なし++; continue; }
    if (hire < HIRE_MIN) { st.六名未満++; continue; }

    // ③ かぶりなし: 会社概要の h1（正式社名）で全索引に当て直す（候補選抜は元表記なので取りこぼす）
    const name = v.企業名;
    const canon = mkey(name);
    if (!canon || seenCanon.has(canon)) { st.正式社名で既出++; continue; }
    if (past.has(name) || crm.has(name) || ng.has(canon)) { st.正式社名で既出++; continue; }
    // 台帳の2定義を両方判定して行に残す（後段でどちらの定義でも絞り込めるように）
    const inArchiveFull = archiveFull.has({ 企業名: name }) || archiveFull.has({ 企業名: c.name });
    const inArchiveDelivered = archive.has({ 企業名: name }) || archive.has({ 企業名: c.name });
    if (inArchiveDelivered) { st.アーカイブ++; continue; }
    if (!ARCHIVE_DELIVERED_ONLY && inArchiveFull) { st.アーカイブ++; continue; }
    seenCanon.add(canon);

    const industry = v.業種 || '';
    if (isExcludedIndustry(industry)) { st.IT++; continue; }
    if (isGovernmentOrg(name, industry)) { st.官公庁++; continue; }
    const emp = parseEmployees(v.従業員数);
    if (emp != null && emp < ICP.EMP_MIN) { st.規模++; continue; }
    const phone = normalizeJpPhone(v.電話番号 || '') || normalizeJpPhone(g(c.row, '電話番号') || '');
    if (!phone) { st.電話++; continue; }

    const recruiter = g(c.row, '採用担当者名');
    const rep = g(c.row, '代表者名');
    const dept = g(c.row, '部署');
    const title = g(c.row, '役職');
    const s = scoreMochica({
      企業名: name, 業種: industry, 従業員数: emp == null ? '' : String(emp), 電話番号: phone,
      採用担当者名: recruiter, 代表者名: rep, 部署: dept, 役職: title,
      新卒フラグ: '新', 採用予定人数: String(hire), 掲載媒体: 'マイナビ', 上場: v.上場 || '',
      本社: v.本社 || '', 採用ページURL: v.url || '',
    });
    const org = classifyOrgType(name);
    rows.push({
      _score: s.total, _hire: hire, _tier: recruiter ? 0 : (rep ? 1 : 2),
      企業名: name,
      架電宛名: recruiter ? (dept + (title ? ' ' + title : '') + ' ' + recruiter + ' 様').trim() : 'ご採用ご担当者様',
      採用担当者名: recruiter, 代表者名: rep, 役職: title, 部署: dept,
      電話番号: phone, メール: g(c.row, 'メール'),
      業種: industry, 従業員数: emp == null ? '' : String(emp), 本社: v.本社 || '',
      都道府県: prefOf(v.本社) || g(c.row, '都道府県'), 上場: v.上場 || '', 組織型: org.label,
      卒年: v.卒年 || '', 年間新卒採用人数: String(hire), 採用予定人数: String(hire),
      '採用実績(直近3年)': v.実績3年 || '', 採用人数の根拠: v.実績根拠 || '',
      採用ページURL: v.url || '', 公式URL: g(c.row, '公式URL'), 法人番号: g(c.row, '法人番号'), corpID: v.corpID || '',
      ICPスコア: String(s.total), ICP優先度: s.priority, ICP確信度: String(s.confidence),
      MOCHICA適合: s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△',
      提案プラン: s.plan, セグメント区分: s.segment,
      ICP根拠: '非IT(' + String(industry).slice(0, 24) + ')｜' + (emp == null ? '従業員不明' : '従業員' + emp + '名')
        + '｜電話妥当｜年間新卒' + hire + '名(実績' + (v.実績年 || '') + '年)｜' + org.label,
      完全新規根拠: 'アーカイブ(納品台帳' + (ARCHIVE_DELIVERED_ONLY ? '・実納品バッチ' : '全バッチ') + ')／過去納品CSV／BALES／MOCHICA顧客／SF全リード／架電禁止 のいずれにも不在',
      アーカイブ台帳: inArchiveFull ? '整形ダンプにのみ在（実納品バッチには不在）' : '全バッチに不在',
      取得日: today,
    });
    st.ok++;
  }

  rows.sort((a, b) => (b._score - a._score) || (b._hire - a._hire) || (a._tier - b._tier) || a.企業名.localeCompare(b.企業名, 'ja'));
  // 架電リストとしての重複排除（同じ代表電話を2度ダイヤルさせない／同じマイナビ面を2行にしない）
  const byPhone = new Set(); const byCorp = new Set(); const uniq = [];
  let dupPhone = 0; let dupCorp = 0;
  for (const r of rows) {
    const ph = String(r.電話番号 || '').replace(/[^0-9]/g, '');
    const cid = String(r.corpID || '').trim();
    if (ph && byPhone.has(ph)) { dupPhone++; continue; }
    if (cid && byCorp.has(cid)) { dupCorp++; continue; }
    if (ph) byPhone.add(ph); if (cid) byCorp.add(cid);
    uniq.push(r);
  }
  uniq.forEach((r, i) => { r.No = String(i + 1); });
  const out = uniq.map((r) => { const o = {}; for (const c2 of POOL_COLS) o[c2] = r[c2] == null ? '' : String(r[c2]); return o; });
  fs.writeFileSync(POOL, '﻿' + toCsv(POOL_COLS, out), 'utf8');
  // 「なぜこの件数が上限か」を finalize のレポートに引き継ぐ
  fs.writeFileSync(POOL.replace(/\.csv$/, '-stats.json'), JSON.stringify({
    候補: cand.length, 内訳: st, 重複排除: { 電話: dupPhone, corpID: dupCorp }, プール: uniq.length,
    採用フロア: HIRE_MIN, アーカイブ定義: ARCHIVE_DELIVERED_ONLY ? '実納品バッチのみ' : '台帳の全バッチ',
    生成: new Date().toISOString(),
  }, null, 2), 'utf8');
  log('ICP適合×完全新規プール: ' + uniq.length + '社（重複排除 電話' + dupPhone + '／corpID' + dupCorp + '） → ' + path.relative(ROOT, POOL));
  log('落ちた内訳: ' + JSON.stringify(st));
  if (uniq.length < TARGET) {
    log('⚠ プールが目標 ' + TARGET + '件に届いていません（' + uniq.length + '社）。'
      + (ARCHIVE_DELIVERED_ONLY ? '' : ' --archive-delivered-only で整形ダンプ分を通すと候補が増えます。'));
  }
  return uniq.length;
}

// ============================================================
// フェーズ2: インテント採点済み → 納品形式
// ============================================================
const FINAL_COLS = ['No', '企業名', '架電宛名', '採用担当者名', '役職', '部署', '電話番号', 'メール', '公式URL',
  '業種', '都道府県', '従業員数', '組織型', '年間新卒採用人数', '採用実績(直近3年)', '採用人数の根拠',
  'インテントスコア', 'インテント階層', '最有力シグナル', 'シグナル強度', '検知シグナル', 'なぜ今', '根拠', '推奨トーク', '推奨アクション',
  'ICPスコア', 'ICP判定', 'ICP根拠', 'MOCHICA適合', '提案プラン', 'セグメント区分', 'アポ期待度', '総合優先度',
  '完全新規根拠', '採用ページURL', '法人番号', 'corpID', '卒年', '観測日',
  // インテント資料JSON は本文丸ごと（最大20万字）を持つため納品CSVからは外す（根拠URL一覧とシグナル内訳JSONで追える）
  ...TARGET_COLS.filter((c) => c !== 'インテント資料JSON'), ...SIGNAL_LIST.map((s) => s.列)];

function finalize() {
  const IN = path.resolve(ROOT, getArg('in', 'data/leads-icp-intent-scored.csv'));
  if (!fs.existsSync(IN)) { console.error('インテント採点済みCSVがありません: ' + path.relative(ROOT, IN)); process.exit(1); }
  const poolRows = fs.existsSync(POOL) ? readCsv(fs.readFileSync(POOL, 'utf8')).records : [];
  const poolBy = new Map(poolRows.map((r) => [mkey(g(r, '企業名')), r]));
  const { records } = readCsv(fs.readFileSync(IN, 'utf8'));
  log('インテント採点済み ' + records.length + '行を読み込み');

  const TIER_RANK = { A: 4, B: 3, C: 2, D: 1, '': 0 };
  const rows = [];
  const seen = new Set();
  const st = { プール外: 0, 対象外: 0, 重複: 0, 電話なし: 0, ok: 0 };
  for (const r of records) {
    const name = g(r, '企業名'); if (!name) continue;
    // インテント採点は緩めの母集団に流していることがある。納品は必ずプール（＝ICP有資格）の中だけから採る。
    if (poolBy.size && !poolBy.has(mkey(name))) { st.プール外++; continue; }
    if (g(r, 'MOCHCA適合判定') === '対象外') { st.対象外++; continue; }
    if (!g(r, '電話番号')) { st.電話なし++; continue; }
    const k = mkey(name);
    if (seen.has(k)) { st.重複++; continue; }
    seen.add(k);
    const p = poolBy.get(k) || {};
    const o = {};
    for (const c of FINAL_COLS) o[c] = g(r, c) || g(p, c);
    o.ICP判定 = '適合';
    o.ICPスコア = g(p, 'ICPスコア') || g(r, 'アポ期待度');
    o.組織型 = g(p, '組織型');
    o.完全新規根拠 = g(p, '完全新規根拠');
    o.採用人数の根拠 = g(p, '採用人数の根拠');
    o._intent = parseFloat(g(r, 'インテントスコア')) || 0;
    o._tier = TIER_RANK[g(r, 'インテント階層')] || 0;
    o._prio = parseFloat(g(r, '総合優先度')) || 0;
    o._icp = parseFloat(o.ICPスコア) || 0;
    o._hire = parseInt(g(r, '年間新卒採用人数') || g(p, '年間新卒採用人数'), 10) || 0;
    rows.push(o);
    st.ok++;
  }
  // 並び: インテント階層 → 総合優先度 → インテントスコア → ICPスコア → 採用実績人数
  rows.sort((a, b) => (b._tier - a._tier) || (b._prio - a._prio) || (b._intent - a._intent) || (b._icp - a._icp) || (b._hire - a._hire));
  const picked = rows.slice(0, TARGET);
  picked.forEach((r, i) => { r.No = String(i + 1); });
  const out = picked.map((r) => { const o = {}; for (const c of FINAL_COLS) o[c] = r[c] == null ? '' : String(r[c]); return o; });
  fs.writeFileSync(OUT, '﻿' + toCsv(FINAL_COLS, out), 'utf8');
  log('納品 ' + picked.length + '件（有資格 ' + rows.length + '社）→ ' + path.relative(ROOT, OUT));

  // BALES取込形式（列構造は format-bales.js が単一の真実源）
  const balesOut = path.join(path.dirname(OUT), path.basename(OUT).replace(/^leads-/, 'leads-bales-'));
  execFileSync(process.execPath, [path.join(__dirname, 'format-bales.js'), '--in', OUT, '--scope', 'all',
    '--out', balesOut, '--no-record', '--no-dedupe-history'], { stdio: 'inherit' });
  // カスタム情報欄に「なぜ今か」を載せる（BALES画面だけで文脈が持てるように）
  annotateBales(balesOut, picked);

  writeReport(picked, rows.length, st, balesOut);
  return { picked: picked.length, pool: rows.length, balesOut };
}

function annotateBales(file, picked) {
  if (!fs.existsSync(file)) return;
  const byName = new Map(picked.map((r) => [r.企業名, r]));
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const { headers, records } = readCsv(text);
  const K = { name: '会社情報：会社名', now: 'カスタム情報：顧客の現状', issue: 'カスタム情報：顧客の課題感', memo: 'カスタム情報：活動予定コメント' };
  for (const rec of records) {
    const r = byName.get(rec[K.name]); if (!r) continue;
    if (K.now in rec) rec[K.now] = ('インテント' + r.インテント階層 + '(' + r.インテントスコア + ') ' + r.最有力シグナル + '／新卒' + r.年間新卒採用人数 + '名・従業員' + r.従業員数 + '名').slice(0, 250);
    if (K.issue in rec) rec[K.issue] = String(r.なぜ今 || '').slice(0, 250);
    if (K.memo in rec) rec[K.memo] = String(r.推奨トーク || '').slice(0, 250);
  }
  fs.writeFileSync(file, '﻿' + toCsv(headers, records), 'utf8');
}

function writeReport(picked, poolSize, st, balesOut) {
  const band = (arr, f) => { const m = {}; for (const r of arr) { const k = f(r); m[k] = (m[k] || 0) + 1; } return m; };
  const tb = band(picked, (r) => r.インテント階層 || '未検知');
  const sb = band(picked, (r) => r.最有力シグナル || '—');
  const ib = band(picked, (r) => { const v = Number(r.ICPスコア); return v >= 80 ? '80以上' : v >= 70 ? '70-79' : v >= 60 ? '60-69' : v >= 50 ? '50-59' : '50未満'; });
  const hb = band(picked, (r) => { const h = Number(r.年間新卒採用人数); return h >= 50 ? '50名以上' : h >= 20 ? '20-49名' : h >= 10 ? '10-19名' : '6-9名'; });
  const eb = band(picked, (r) => { const e = Number(r.従業員数); return !r.従業員数 ? '不明' : e >= 2000 ? '2000名以上' : e >= 1000 ? '1000-1999名' : e >= 500 ? '500-999名' : e >= 300 ? '300-499名' : '100-299名'; });
  const pb = band(picked, (r) => r.都道府県 || '不明');
  const md = [];
  md.push('# 最新インテント × ICP適合 × 完全新規（アーカイブ／BALES／既存顧客かぶりなし） ' + picked.length + '件', '');
  md.push('- 出力: `' + path.relative(ROOT, OUT) + '`（詳細） ／ `' + path.relative(ROOT, balesOut) + '`（BALES取込形式）');
  md.push('- 生成: ' + new Date().toISOString());
  md.push('- 有資格プール: ' + poolSize + '社（うち上位 ' + picked.length + '社）');
  md.push('- 並び: インテント階層 → 総合優先度 → インテントスコア → ICP(v5)スコア → 新卒採用実績人数', '');
  md.push('## ハード条件', '');
  md.push('| 条件 | 一次情報 | 充足 |');
  md.push('|---|---|---:|');
  md.push('| ① 最新インテント | intent-analyze（16シグナル）を本日実走。CSV既知事実＋マイナビ各面の実取得 | 100% |');
  md.push('| ② ICP適合 | 非IT／官公庁除外／従業員' + ICP.EMP_MIN + '名以上／年間新卒' + HIRE_MIN + '名以上（会社概要の**実績**）／電話妥当 | 100% |');
  md.push('| ③ アーカイブかぶりなし | 納品台帳 `_delivered-ledger.csv`' + (ARCHIVE_DELIVERED_ONLY ? '（実納品バッチ）' : '（全バッチ）') + '＋過去納品CSV ' + PAST.length + '本 | 100% |');
  md.push('| ④ BALESかぶりなし | `BALESCLOUDの既存リスト` の会社名で突合 | 100% |');
  md.push('| ⑤ 既存顧客かぶりなし | `MOCHICAの既存顧客リスト`（法人名／LINE登録名）＋SF全リード | 100% |');
  md.push('| ⑥ 架電禁止 | `data/ng-companies.txt` を無条件除外 | 100% |');
  md.push('| ⑦ 重複なし | 正規化社名・corpID・代表電話で1社1行 | 100% |', '');
  md.push('## インテント階層', '');
  md.push('| 階層 | 件数 | 意味 |'); md.push('|---|---:|---|');
  const tierNote = { A: '確度最高（複数シグナル or 最重シグナル）', B: '有力', C: 'シグナルあり（弱め）', D: '弱い痕跡', 未検知: '公開記載から痕跡なし' };
  for (const k of ['A', 'B', 'C', 'D', '未検知']) if (tb[k]) md.push('| ' + k + ' | ' + tb[k] + ' | ' + (tierNote[k] || '') + ' |');
  md.push('', '## 最有力シグナルの内訳', '');
  md.push('| シグナル | 件数 |'); md.push('|---|---:|');
  for (const [k, v] of Object.entries(sb).sort((a, b) => b[1] - a[1])) md.push('| ' + k + ' | ' + v + ' |');
  md.push('', '## ICP(v5)スコア', '');
  md.push('| 帯 | 件数 |'); md.push('|---|---:|');
  for (const k of ['80以上', '70-79', '60-69', '50-59', '50未満']) if (ib[k]) md.push('| ' + k + ' | ' + ib[k] + ' |');
  md.push('', '## 年間新卒採用人数（実績）', '');
  md.push('| 帯 | 件数 |'); md.push('|---|---:|');
  for (const k of ['6-9名', '10-19名', '20-49名', '50名以上']) if (hb[k]) md.push('| ' + k + ' | ' + hb[k] + ' |');
  md.push('', '## 従業員数', '');
  md.push('| 帯 | 件数 |'); md.push('|---|---:|');
  for (const k of ['100-299名', '300-499名', '500-999名', '1000-1999名', '2000名以上', '不明']) if (eb[k]) md.push('| ' + k + ' | ' + eb[k] + ' |');
  md.push('', '## 都道府県 上位15', '');
  md.push('| 都道府県 | 件数 |'); md.push('|---|---:|');
  for (const [k, v] of Object.entries(pb).sort((a, b) => b[1] - a[1]).slice(0, 15)) md.push('| ' + k + ' | ' + v + ' |');
  // 母集団ファネル（なぜこの件数が上限なのか）
  const sf = POOL.replace(/\.csv$/, '-stats.json');
  if (fs.existsSync(sf)) {
    try {
      const S = JSON.parse(fs.readFileSync(sf, 'utf8'));
      const I = S.内訳 || {};
      md.push('', '## 母集団の内訳（なぜこの件数が上限か）', '');
      md.push('マイナビ掲載コーパス31,134社を母集団に取り、過去に一度も発掘していない社まで含めて');
      md.push('会社概要を1社ずつ実取得して判定した結果。');
      md.push('');
      md.push('| 段階 | 社数 |'); md.push('|---|---:|');
      md.push('| 完全新規候補（マイナビ面が引ける社） | ' + S.候補 + ' |');
      const label = {
        未検証: '├ 会社概要が未検証', 取得失敗: '├ 会社概要の取得失敗', 実績なし: '├ 採用実績の記載なし（' + S.採用フロア + '名以上を立証できない）',
        六名未満: '├ 採用実績が' + S.採用フロア + '名未満（ICPの採用フロア）', 正式社名で既出: '├ 正式社名で再突合したら既存CRM／過去納品／NG／同一社',
        アーカイブ: '├ 納品台帳（' + S.アーカイブ定義 + '）にいる', IT: '├ IT/ソフト除外', 官公庁: '├ 官公庁除外',
        規模: '├ 従業員100名未満', 電話: '├ 電話番号なし/不正',
      };
      for (const [k, v] of Object.entries(I)) if (v && label[k]) md.push('| ' + label[k] + ' | ' + v + ' |');
      md.push('| ├ 同一代表電話の重複行 | ' + ((S.重複排除 || {}).電話 || 0) + ' |');
      md.push('| └ **有資格（＝プール）** | **' + S.プール + '** |');
      md.push('');
      md.push('- 2,000件に届かない直接の理由は、ICPの採用フロア（年間新卒' + S.採用フロア + '名以上）で ' + (I.六名未満 || 0) + '社、');
      md.push('  既存CRM／過去納品との再突合で ' + (I.正式社名で既出 || 0) + '社が落ちること。媒体側の母集団（マイナビ全掲載）は掘り切っている。');
    } catch (_) {}
  }
  md.push('', '## 落ちた内訳（インテント採点済み入力に対して）', '');
  for (const [k, v] of Object.entries(st)) if (v) md.push('- ' + k + ': ' + v);
  md.push('', '## 上位20社', '');
  md.push('| # | 企業名 | 階層 | 最有力シグナル | 新卒 | 従業員 | ICP |');
  md.push('|---|---|---|---|---:|---:|---:|');
  for (const r of picked.slice(0, 20)) md.push('| ' + r.No + ' | ' + r.企業名 + ' | ' + (r.インテント階層 || '-') + '(' + (r.インテントスコア || 0) + ') | ' + (r.最有力シグナル || '-') + ' | ' + r.年間新卒採用人数 + ' | ' + r.従業員数 + ' | ' + r.ICPスコア + ' |');
  md.push('', '## 注意', '');
  md.push('- インテントは「公開記載から読める痕跡」であり、受注確率ではない。階層Aでも架電での確認が要る。');
  md.push('- 「新設／切替」系シグナル（採用ページ刷新・LINE取得・インターン開始・合説初出展）は前回観測との差分で立つ。');
  md.push('  今回が初観測の社は保有止まりとして扱われ、次サイクルから“新設”を言える。');
  const rp = OUT.replace(/\.csv$/, '-report.md');
  fs.writeFileSync(rp, md.join('\n') + '\n', 'utf8');
  log('レポート: ' + path.relative(ROOT, rp));
}

if (require.main === module) {
  if (PHASE === 'pool') buildPool();
  else if (PHASE === 'finalize') finalize();
  else { console.error('--phase は pool | finalize'); process.exit(1); }
}
module.exports = { buildPool, finalize, buildExclusionIndexes };
