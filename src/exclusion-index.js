'use strict';
/**
 * 除外マスタ索引（「新規リストに出してはいけない企業」の単一情報源）── 2026-07 v1
 * =====================================================================
 * これまで各ビルダーが**それぞれ別の除外集合**を組んでいたため、経路によって
 * 突合するマスタが違い、被りが漏れていた（2026-07-30 実測）:
 *
 *   consolidate-all.js     : 顧客+BALES+SF を突合し「既存被り」列に**フラグだけ**付与
 *   format-bales.js        : 入力の「既存被り」列を**信用**＋台帳のみ突合 → 列が空の入力は無検証
 *   build-new-icp-list.js  : consolidated pool＋台帳のみ（**3マスタと突合していない**）
 *   score-expo-leads.js    : 顧客＋台帳のみ
 *   dedupe-approach.js     : 禁止+顧客+SF（BALES CRM なし・company-match 未使用）
 *
 * 結果、マイナビ由来の「完全新規」リストは3マスタ未突合のまま納品され、
 * 2026-07-24納品40社のうち34社(85%)、07-29納品15社のうち12社(80%)が既存だった。
 *
 * 本モジュールは除外集合の構築を1箇所に集約する。以後、新規リストを作る全経路は
 * これを使う（＝マスタを1つ足せば全経路に効く）。
 *
 * 除外レイヤ:
 *   masters : MOCHICA既存顧客（法人名+LINE登録名）/ BALES既存CRM / SF全リード
 *   ledger  : 納品済み台帳（このツールで過去作成した企業）
 *   pool    : 既存母集団 leads-consolidated-all.csv（“未納品だが既知”＝完全新規の判定に使う。任意）
 *
 * 使い方:
 *   const { buildExclusionIndex } = require('./exclusion-index');
 *   const ex = buildExclusionIndex();                       // masters + ledger
 *   const ex = buildExclusionIndex({ pool: true });          // + 既存母集団
 *   const d = ex.idx.matchDetail(row);                       // {matched,label,tier,master}
 *
 * CLI（統計とマスタ健全性の確認）:
 *   node src/exclusion-index.js
 */
const fs = require('fs');
const path = require('path');
const { readCsv, parseCsv } = require('./csv');
const { createMatchIndex } = require('./company-match');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const FILES = {
  customers: path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv'),
  bales: path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv'),
  sf: path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv'),
  ledger: path.join(DATA, '_delivered-ledger.csv'),
  pool: path.join(DATA, 'leads-consolidated-all.csv'),
};

// Salesforceレポート形式（先頭に説明行、ヘッダ行に「会社名 / 取引先」）から会社名を抽出
function parseSfReport(text) {
  const rows = parseCsv(text);
  let hi = -1, ci = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const j = rows[i].findIndex((c) => /会社名\s*\/\s*取引先/.test(String(c)));
    if (j >= 0) { hi = i; ci = j; break; }
  }
  if (hi < 0) return { names: [], headerFound: false };
  const names = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const c = String(rows[i][ci] || '').trim();
    if (c) names.push(c);
  }
  return { names, headerFound: true };
}

const cache = new Map(); // オプション組合せ -> 構築済み索引（同一プロセス内の再構築を避ける）

const ALL_LAYERS = ['customers', 'bales', 'sf', 'ledger', 'pool'];

/**
 * 除外索引を構築する。
 * @param {{masters?:boolean, ledger?:boolean, pool?:boolean, layers?:string[], fuzzy?:boolean,
 *          files?:Partial<typeof FILES>, quiet?:boolean, cache?:boolean}} [opts]
 *   layers を渡すと層を個別指定できる（'customers'|'bales'|'sf'|'ledger'|'pool'）。
 *   省略時は masters(=customers+bales+sf)/ledger/pool のフラグから決まる。
 * @returns {{idx:ReturnType<typeof createMatchIndex>, stats:object, missing:string[], layers:string[]}}
 */
function buildExclusionIndex(opts = {}) {
  const wanted = new Set(Array.isArray(opts.layers)
    ? opts.layers.filter((l) => ALL_LAYERS.includes(l))
    : [
      ...(opts.masters !== false ? ['customers', 'bales', 'sf'] : []),
      ...(opts.ledger !== false ? ['ledger'] : []),
      ...(opts.pool === true ? ['pool'] : []),
    ]);
  const useMasters = wanted.has('customers') || wanted.has('bales') || wanted.has('sf');
  const useLedger = wanted.has('ledger');
  const usePool = wanted.has('pool');
  const fuzzy = opts.fuzzy !== false;
  const quiet = opts.quiet === true;
  const files = Object.assign({}, FILES, opts.files || {});
  const ck = JSON.stringify([[...wanted].sort(), fuzzy, files]);
  if (opts.cache !== false && cache.has(ck)) return cache.get(ck);

  const idx = createMatchIndex({ fuzzy });
  const stats = {};
  const missing = [];
  const layers = [];
  const say = (m) => { if (!quiet) console.log(m); };

  const readOrMiss = (p, label) => {
    if (!fs.existsSync(p)) { missing.push(`${label}: ${path.relative(ROOT, p)}`); return null; }
    return fs.readFileSync(p, 'utf8');
  };

  if (useMasters) {
    layers.push([...wanted].filter((l) => l !== 'ledger' && l !== 'pool').join('+'));
    // MOCHICA既存顧客：法人名 と LINE登録名 の“両方”を索引（別称登録の取りこぼし防止）
    const t1 = wanted.has('customers') ? readOrMiss(files.customers, 'MOCHICA顧客') : null;
    if (t1 != null) {
      const { records } = readCsv(t1);
      for (const r of records) { idx.addName(r['法人名'], 'MOCHICA顧客'); idx.addName(r['LINEアカウント登録企業名'], 'MOCHICA顧客'); idx.addBango(r['法人番号'], 'MOCHICA顧客', r['法人名'] || ''); }
      stats['MOCHICA顧客'] = records.length;
    }
    // BALES既存CRM
    const t2 = wanted.has('bales') ? readOrMiss(files.bales, 'BALES既存CRM') : null;
    if (t2 != null) {
      const { records } = readCsv(t2);
      for (const r of records) idx.addName(r['会社情報：会社名'], 'BALES既存');
      stats['BALES既存'] = records.length;
    }
    // SF全リード
    const t3 = wanted.has('sf') ? readOrMiss(files.sf, 'SF全リード') : null;
    if (t3 != null) {
      const { names, headerFound } = parseSfReport(t3);
      if (!headerFound) missing.push('SF全リード: ヘッダ「会社名 / 取引先」を検出できず0件（形式変更の疑い）');
      for (const n of names) idx.addName(n, 'SFリード');
      stats['SFリード'] = names.length;
    }
  }
  if (useLedger) {
    layers.push('ledger');
    const t = readOrMiss(files.ledger, '納品済み台帳');
    if (t != null) {
      const { records } = readCsv(t);
      for (const r of records) idx.addRecord(r, '納品済み' + (r['バッチ'] ? `(${r['バッチ']})` : ''));
      stats['納品済み台帳'] = records.length;
    } else {
      // 台帳は初回実行時に存在しないのが正常。missing から降格させる。
      const i = missing.findIndex((m) => m.startsWith('納品済み台帳'));
      if (i >= 0) missing.splice(i, 1);
      stats['納品済み台帳'] = 0;
    }
  }
  if (usePool) {
    layers.push('pool');
    const t = readOrMiss(files.pool, '既存母集団pool');
    if (t != null) {
      const { records } = readCsv(t);
      for (const r of records) idx.addRecord(r, '既存母集団');
      stats['既存母集団pool'] = records.length;
    }
  }

  const result = { idx, stats, missing, layers };
  if (!quiet) {
    const parts = Object.entries(stats).map(([k, v]) => `${k} ${v}行`).join(' / ');
    say(`[除外索引] ${parts}`);
    say(`[除外索引] 突合キー: 社名${idx.nameSize} 表記ゆれ${idx.looseSize}` +
      `${idx.fuzzyEnabled ? ` 長音ゆれ${idx.fuzzySize}` : ' 長音ゆれOFF'} 農協${idx.coreSize} 法人番号${idx.bangoSize}`);
    for (const m of missing) console.warn(`[除外索引] ⚠ 未配置＝この層は突合されません → ${m}`);
  }
  if (opts.cache !== false) cache.set(ck, result);
  return result;
}

module.exports = { FILES, buildExclusionIndex, parseSfReport };

// ── CLI ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const ex = buildExclusionIndex({ pool: argv.includes('--pool'), fuzzy: !argv.includes('--no-fuzzy') });
  console.log(`\n除外対象ユニーク: ${ex.idx.size}社（層: ${ex.layers.join('+')}）`);
  if (ex.missing.length) process.exitCode = 1;
}
