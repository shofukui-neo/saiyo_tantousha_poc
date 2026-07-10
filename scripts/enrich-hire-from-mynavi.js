'use strict';
/**
 * 採用予定人数 エンリッチ（マイナビ 採用データ＝各募集コース面から集計）
 * =====================================================================
 * 「担当者名あり・電話あり」だが採用人数が“不明”な企業について、マイナビの
 * 前年度採用データ(employment.html)から各募集コース(displayEmployment)の
 * 「募集人数」を集計し、年間新卒採用予定（下限和）を埋める。
 * これにより「採用6名以上」を絶対条件に据えても、未エンリッチ企業を取りこぼさない
 * （ユーザー指定 2026-07: 不明社は落とさず“取得の方法を考える”）。
 *
 * 使い方:
 *   node scripts/enrich-hire-from-mynavi.js --in data/leads-mochica-named-callable.csv \
 *        --out data/leads-mochica-named-callable.hire.csv [--limit 50] [--empty-only]
 * オプション:
 *   --limit N        先頭N社のみ（動作確認）
 *   --empty-only     採用人数が既にある行はスキップ（既定ON）
 *   --all            採用人数がある行も再取得
 * 環境変数: MYNAVI_GRAD_YEAR(既定28) / MYNAVI_POLITE_MS(既定3500) / MYNAVI_HEADFUL=1
 * 中断に強い: --out と同じ場所に .journal.json を書き、再実行で続きから。
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('../src/csv');
const { MynaviScraper } = require('../src/scrape-mynavi');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const IN = path.resolve(ROOT, opt('--in', 'data/leads-mochica-named-callable.csv'));
const OUT = path.resolve(ROOT, opt('--out', IN.replace(/\.csv$/, '.hire.csv')));
const LIMIT = opt('--limit', null) ? parseInt(opt('--limit'), 10) : null;
const ALL = !!opt('--all', false);
const JOURNAL = OUT.replace(/\.csv$/, '') + '.journal.json';

const HIRE_COLS = ['採用予定人数', '採用人数', '採用数', '採用予定数'];
const firstHire = (rec) => { for (const c of HIRE_COLS) if (String(rec[c] || '').trim()) return String(rec[c]).trim(); return ''; };
const hasPhone = (rec) => !!String(rec['電話番号'] || rec['電話'] || '').trim();

function loadJournal() { try { return JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch (_) { return {}; } }
function saveJournal(j) { fs.writeFileSync(JOURNAL, JSON.stringify(j, null, 0)); }

async function main() {
  const { headers, records } = readCsv(fs.readFileSync(IN, 'utf8'));
  // 出力に採用人数の列を必ず持たせる
  const outHeaders = headers.slice();
  for (const c of ['採用予定人数', '採用予定人数レンジ', '募集コース数', '採用人数取得元']) if (!outHeaders.includes(c)) outHeaders.push(c);

  // 対象＝電話あり かつ 採用人数が空（--all なら全件）
  const targets = records.filter((r) => hasPhone(r) && (ALL || !firstHire(r)));
  const pool = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`入力 ${records.length}社 / 電話あり&採用人数不明 ${targets.length}社 / 今回対象 ${pool.length}社`);
  console.log(`卒年マイナビ${process.env.MYNAVI_GRAD_YEAR || '28'} / 間隔${process.env.MYNAVI_POLITE_MS || '3500'}ms`);

  const journal = loadJournal();
  const sc = new MynaviScraper({ gradYear: process.env.MYNAVI_GRAD_YEAR || '28' });
  await sc.launch();
  let filled = 0, hit6 = 0, done = 0;
  try {
    for (const rec of pool) {
      const name = String(rec['企業名'] || '').trim();
      done++;
      let res = journal[name];
      if (!res) {
        process.stdout.write(`[${done}/${pool.length}] ${name} … `);
        res = await sc.scrapeHireByName(name);
        journal[name] = { 採用予定人数: res.採用予定人数, レンジ: res.採用予定人数レンジ, コース: res.募集コース数, 掲載: res.マイナビ掲載, 根拠: res.根拠 };
        saveJournal(journal);
        console.log(res.採用予定人数 ? `${res.採用予定人数レンジ}(${res.募集コース数}コース)` : `— ${res.根拠}`);
        await new Promise((r) => setTimeout(r, parseInt(process.env.MYNAVI_POLITE_MS || '3500', 10)));
      }
      if (res.採用予定人数) {
        rec['採用予定人数'] = res.採用予定人数;
        rec['採用予定人数レンジ'] = res.レンジ || '';
        rec['募集コース数'] = res.コース || '';
        rec['採用人数取得元'] = 'マイナビ採用データ';
        filled++;
        if (parseInt(res.採用予定人数, 10) >= 6) hit6++;
      }
    }
  } finally {
    await sc.close();
  }
  fs.writeFileSync(OUT, '﻿' + toCsv(outHeaders, records), 'utf8');
  console.log(`\n埋まった ${filled}社 / うち採用6名以上 ${hit6}社 → ${OUT}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
