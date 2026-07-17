'use strict';
/**
 * 納品済み台帳（delivered ledger）── 過去作成企業の重複防止層（2026-07 v1.1）
 * =====================================================================
 * 既存の「既存被り」判定は MOCHICA顧客 / BALES既存CRM / SF全リード の3マスタと
 * 突合するが、いずれも過去スナップショット。**このツールで作成・納品したリスト**
 * （BALES取込CSV／最終ICPリスト等）は含まれないため、母集団が同じである以上
 * 新規作成のたびに同じ最高品質企業が再選出され、過去納品分と被る。
 *
 * 本モジュールは「一度でも作成（＝納品）した企業」を台帳に累積し、
 * 新規作成時に自動除外する。突合は company-match に集約（法人番号/正規化社名/農協コア）。
 *
 * 台帳ファイル（既定 data/_delivered-ledger.csv）の列:
 *   企業名, 法人番号, バッチ, 作成日, 元ファイル
 * キーは読込時に company-match が 企業名/法人番号 から都度再計算（正規化の単一情報源）。
 *
 * CLI:
 *   node src/delivered-ledger.js seed <csv...>            # 既存納品物から台帳を初期化
 *   node src/delivered-ledger.js record <csv> [--batch b] # 1ファイルを台帳へ追記
 *   node src/delivered-ledger.js show                     # 台帳の統計を表示
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName, normCorpNumber } = require('./csv');
const { createMatchIndex, pickName, pickBango } = require('./company-match');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LEDGER = path.join(ROOT, 'data', '_delivered-ledger.csv');
const LEDGER_HEADERS = ['企業名', '法人番号', 'バッチ', '作成日', '元ファイル'];

/**
 * 台帳を読み込み、company-match の突合インデックスを返す。
 * @returns {ReturnType<typeof createMatchIndex>}
 */
function loadLedger(ledgerPath = DEFAULT_LEDGER) {
  const idx = createMatchIndex();
  if (!fs.existsSync(ledgerPath)) return idx;
  const { records } = readCsv(fs.readFileSync(ledgerPath, 'utf8'));
  for (const r of records) idx.addRecord(r);
  return idx;
}

// このレコードは過去に作成（納品）済みか。法人番号 → 正規化社名 → 農協コア の順で判定。
function isDelivered(idx, rec) { return idx.has(rec); }

/**
 * 台帳へレコード群を追記（既出キーはスキップ＝初回作成日/バッチを保持）。
 * @param {string} ledgerPath
 * @param {object[]} records 追記対象（会社名/法人番号を含む任意スキーマ）
 * @param {{batch?:string, source?:string, date?:string}} meta
 * @returns {{added:number, skipped:number, total:number}}
 */
function appendRecords(ledgerPath, records, meta = {}) {
  const idx = loadLedger(ledgerPath);          // 既存キー
  const date = meta.date || ymd(new Date());
  const batch = meta.batch || '';
  const source = meta.source || '';
  const fresh = [];
  for (const rec of records) {
    const name = pickName(rec);
    const bango = pickBango(rec);
    if (!normCompanyName(name) && !normCorpNumber(bango)) continue; // キー無し（社名も番号も無い）は記録不能
    if (idx.has(rec)) continue;                // 既出（既存台帳 or 今回バッチ内で追加済み）
    idx.addRecord(rec);                        // 今回バッチ内の重複も弾く
    fresh.push({ 企業名: name, 法人番号: bango, バッチ: batch, 作成日: date, 元ファイル: source });
  }
  if (fresh.length) {
    const exists = fs.existsSync(ledgerPath);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    if (!exists) {
      fs.writeFileSync(ledgerPath, '﻿' + toCsv(LEDGER_HEADERS, fresh) + '\n', 'utf8');
    } else {
      // 追記（ヘッダは書かない）。既存末尾の改行を保証してから連結。
      const prev = fs.readFileSync(ledgerPath, 'utf8');
      const sep = prev.endsWith('\n') ? '' : '\n';
      const body = fresh.map((rec) => LEDGER_HEADERS.map((h) => csvCell(rec[h])).join(',')).join('\n');
      fs.appendFileSync(ledgerPath, sep + body + '\n', 'utf8');
    }
  }
  return { added: fresh.length, skipped: records.length - fresh.length, total: idx.size };
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = {
  DEFAULT_LEDGER, LEDGER_HEADERS,
  loadLedger, isDelivered, appendRecords,
};

// ── CLI ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const ledger = path.resolve(getArg('--ledger', DEFAULT_LEDGER));
  const rel = (p) => path.relative(ROOT, p);

  if (cmd === 'seed' || cmd === 'record') {
    const files = argv.slice(1).filter((a) => !a.startsWith('--') &&
      argv[argv.indexOf(a) - 1] !== '--batch' && argv[argv.indexOf(a) - 1] !== '--ledger');
    if (!files.length) { console.error('ファイルを指定してください'); process.exit(1); }
    let grand = 0;
    for (const f of files) {
      const p = path.resolve(f);
      if (!fs.existsSync(p)) { console.warn(`  skip（存在しない）: ${f}`); continue; }
      const { records } = readCsv(fs.readFileSync(p, 'utf8'));
      const r = appendRecords(ledger, records, { batch: getArg('--batch', cmd === 'seed' ? 'seed' : path.basename(p, '.csv')), source: path.basename(p) });
      console.log(`  ${path.basename(p)}: 入力${records.length}行 → 追記${r.added}社 / 既出${r.skipped}社`);
      grand += r.added;
    }
    const idx = loadLedger(ledger);
    console.log(`\n台帳: ${rel(ledger)}｜今回追記 ${grand}社｜累計 ${idx.size}社（社名キー${idx.nameSize}/農協コア${idx.coreSize}/法人番号${idx.bangoSize}）`);
  } else if (cmd === 'show') {
    const idx = loadLedger(ledger);
    console.log(`台帳: ${rel(ledger)}`);
    console.log(`  累計 ${idx.size}社（社名キー${idx.nameSize} / 農協コア${idx.coreSize} / 法人番号${idx.bangoSize}）`);
  } else {
    console.log('usage: node src/delivered-ledger.js <seed|record|show> [csv...] [--batch b] [--ledger path]');
  }
}
