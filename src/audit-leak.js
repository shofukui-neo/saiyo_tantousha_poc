'use strict';
/**
 * 納品リストの被り監査（リーク検出ゲート）── 2026-07 v1
 * =====================================================================
 * 出来上がったCSVを**成果物側から**再突合し、「既存顧客/既存CRM/SFリード/納品済み」が
 * 混入していないかを検証する。ビルダーのバグでも列の取り違えでも、ここで必ず露見する。
 *
 * 検出するもの:
 *   ① マスタ被り  : MOCHICA顧客 / BALES既存CRM / SFリード（層別・tier別に内訳表示）
 *   ② 台帳被り    : 過去このツールで作成・納品した企業
 *   ③ 自己重複    : 同一ファイル内で同じ企業が複数行
 *   ④ キー無し行  : 社名も法人番号も無く**突合不能**（＝新規と誤認される行）
 *
 * 使い方:
 *   node src/audit-leak.js data/leads-new-icp-2026-07-30.csv
 *   node src/audit-leak.js ~/Downloads/*.csv --out data/leak-report.csv
 *   node src/audit-leak.js x.csv --ignore-ledger      # 自分自身が台帳記録済みの再検査時
 *   node src/audit-leak.js x.csv --no-fuzzy           # 長音ゆれ(tier5)を無効化
 *   node src/audit-leak.js x.csv --report-only        # 被りがあっても exit 0
 *   node src/audit-leak.js x.csv --layers customers,ledger
 *        # 突合する層を指定（既定 customers,bales,sf,ledger）。母集団が元々BALES既存リード
 *        #（例 母集団課題ニーズリスト）の場合は bales/sf を外して監査する。
 *
 * 終了コード: 被り（①②③）が1件でもあれば 1（CI/納品前ゲートとして使える）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { buildExclusionIndex } = require('./exclusion-index');
const { createMatchIndex, pickName, pickBango, hasKey } = require('./company-match');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);

const NAME_COL = getArg('--name-col', '');
const OUT = getArg('--out', '');
const LAYERS = getArg('--layers', '');
const FUZZY = !flag('--no-fuzzy');
const USE_LEDGER = !flag('--ignore-ledger');
const USE_POOL = flag('--pool');
const REPORT_ONLY = flag('--report-only');
const files = argv.filter((a, i) => !a.startsWith('--') && !['--name-col', '--out', '--layers'].includes(argv[i - 1]));

if (!files.length) {
  console.log('usage: node src/audit-leak.js <csv...> [--name-col 列名] [--out report.csv] [--layers customers,bales,sf,ledger,pool] [--pool] [--ignore-ledger] [--no-fuzzy] [--report-only]');
  process.exit(1);
}

const ex = LAYERS
  ? buildExclusionIndex({ layers: LAYERS.split(',').map((s) => s.trim()).filter(Boolean), fuzzy: FUZZY })
  : buildExclusionIndex({ pool: USE_POOL, ledger: USE_LEDGER, fuzzy: FUZZY });
const detail = [];
let grandLeak = 0;

for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) { console.warn(`skip（存在しない）: ${f}`); continue; }
  const { records } = readCsv(fs.readFileSync(p, 'utf8'));
  const nameOf = (r) => (NAME_COL ? String(r[NAME_COL] || '').trim() : pickName(r));
  const selfIdx = createMatchIndex({ fuzzy: FUZZY });
  const byLabel = new Map();  // 一致マスタ -> 件数
  const byTier = new Map();   // 突合tier   -> 件数
  let leak = 0, selfDupe = 0, noKey = 0;

  records.forEach((r, i) => {
    const name = nameOf(r);
    const rec = NAME_COL ? { 企業名: name, 法人番号: pickBango(r) } : r;
    if (!hasKey(rec)) { noKey++; detail.push({ ファイル: path.basename(p), 行: i + 2, 企業名: name, 種別: 'キー無し', 一致マスタ: '', 突合tier: '', 一致相手: '' }); return; }
    const d = ex.idx.matchDetail(rec);
    if (d.matched) {
      leak++;
      byLabel.set(d.label, (byLabel.get(d.label) || 0) + 1);
      byTier.set(d.tier, (byTier.get(d.tier) || 0) + 1);
      detail.push({ ファイル: path.basename(p), 行: i + 2, 企業名: name, 種別: '被り', 一致マスタ: d.label, 突合tier: d.tier, 一致相手: d.master });
    }
    const s = selfIdx.matchDetail(rec);
    if (s.matched) {
      selfDupe++;
      detail.push({ ファイル: path.basename(p), 行: i + 2, 企業名: name, 種別: '自己重複', 一致マスタ: '同ファイル', 突合tier: s.tier, 一致相手: s.master });
    } else {
      selfIdx.addRecord(rec, name);
    }
  });

  const pct = (n) => (records.length ? ` (${(n / records.length * 100).toFixed(1)}%)` : '');
  console.log(`\n══ ${path.basename(p)}  ${records.length}行`);
  console.log(`   被り        : ${leak}${pct(leak)}`);
  if (byLabel.size) console.log('     マスタ別  : ' + [...byLabel.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '));
  if (byTier.size) console.log('     tier別    : ' + [...byTier.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '));
  console.log(`   自己重複    : ${selfDupe}`);
  console.log(`   キー無し行  : ${noKey}`);
  grandLeak += leak + selfDupe;
}

if (OUT) {
  const headers = ['ファイル', '行', '企業名', '種別', '一致マスタ', '突合tier', '一致相手'];
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), '﻿' + toCsv(headers, detail), 'utf8');
  console.log(`\n明細: ${path.relative(ROOT, path.resolve(OUT))}（${detail.length}行）`);
}
console.log(`\n${'─'.repeat(58)}`);
if (grandLeak === 0) console.log('リーク監査 PASS ✓（被り・自己重複ゼロ）');
else console.log(`リーク監査 FAIL ✗ 被り+自己重複 ${grandLeak}件${REPORT_ONLY ? '（--report-only のため exit 0）' : ''}`);
process.exitCode = (grandLeak && !REPORT_ONLY) ? 1 : 0;
