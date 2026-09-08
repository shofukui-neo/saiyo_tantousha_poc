'use strict';
// 既存成果物の一括掃除 — 架電禁止リスト掲載企業を全CSVから無条件で削除する。
//   これから作る成果物は csv.js/master-io.js のガードが自動で守るが、
//   ガード導入前に作られた既存ファイルはここで一度だけ洗う（以後も随時実行可）。
//
//   使い方:
//     node src/ng-sweep.js                 … ドライラン（どのファイルから何件消えるか表示）
//     node src/ng-sweep.js --apply         … 実際に書き換え（.ng-bak を1つだけ作成）
//     node src/ng-sweep.js --apply --all   … 参照マスタ（既存顧客/SF/禁止リスト原本）も対象
//     node src/ng-sweep.js --root data --root .   … 走査対象ディレクトリを指定
//
//   仕様:
//     - 社名列（企業名/会社名/法人名/社名/company_name、および「会社情報：会社名」等の接尾）
//       を自動判定。社名列が無いCSV（分析レポート等）は触らない。
//     - BOM・改行コード（CRLF/LF）は元ファイルの体裁を維持して書き戻す。
//     - 明細は data/ng-sweep-report.csv に出力（どのファイルの誰を消したか）。

const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv } = require('./csv');
const guard = require('./ng-guard');

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes('--' + f);
const APPLY = has('apply');
const ALL = has('all');
const ROOTS = (() => {
  const out = [];
  ARGV.forEach((a, i) => { if (a === '--root' && ARGV[i + 1]) out.push(ARGV[i + 1]); });
  return out.length ? out : ['.', 'data', 'archive', 'tmp'];
})();

// 参照マスタ／原本／除外明細 — 中身を削ると突合や監査ができなくなるので既定では触らない。
const SKIP = [
  /ng-companies\.txt$/i,
  /ng-source-/i,                        // 架電禁止リストの原本
  /\.ng-excluded\.csv$/i,               // 除外明細
  /ng-sweep-report\.csv$/i,
  /BALESCLOUD.*既存リスト/i,            // 参照マスタ：既存リード
  /MOCHICA.*既存顧客リスト/i,           // 参照マスタ：既存顧客
  /セールスフォース/i,                  // 参照マスタ：SF全リード
  /mochica-customers-/i,                // 既存顧客の分析データ（受注傾向の母集団）
  /\.ng-bak$/i, /\.bak$/i,
];
const isSkipped = (fp) => SKIP.some((re) => re.test(fp.split(path.sep).join('/')));

function listCsv() {
  const seen = new Set();
  for (const root of ROOTS) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) continue;
    const walk = (dir, depth) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (/^(node_modules|\.git|\.claude)$/.test(ent.name)) continue;
          if (depth > 0) walk(fp, depth - 1);
        } else if (/\.csv$/i.test(ent.name)) seen.add(fp);
      }
    };
    walk(abs, 3);
  }
  return [...seen].sort();
}

// data配下の .md（ランキング等の成果物）だけを列挙。docs/ は触らない。
function listMd() {
  const out = [];
  const root = path.resolve('data');
  if (!fs.existsSync(root)) return out;
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (/\.md$/i.test(ent.name)) out.push(fp);
    }
  })(root);
  return out.sort();
}

function main() {
  const ngCount = guard.size();
  if (!ngCount) { console.error('✗ 架電禁止リストが空です。先に `npm run ng:sync -- "<リスト.csv>"` を実行してください。'); process.exit(1); }
  console.log(`架電禁止リスト: ${ngCount} 社（${guard.NG_FILE}）`);
  console.log(`走査: ${ROOTS.join(' / ')}  モード: ${APPLY ? '★書き換え' : 'ドライラン'}${ALL ? '（参照マスタも対象）' : ''}\n`);

  const report = [];
  let touched = 0, removedTotal = 0, scanned = 0, skipped = 0;

  for (const fp of listCsv()) {
    const rel = path.relative(process.cwd(), fp);
    if (!ALL && isSkipped(fp)) { skipped++; continue; }
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    const rows = parseCsv(raw);
    if (rows.length < 2) continue;
    const { headers, records } = rowsToRecords(rows);
    const cols = guard.nameColumnsOf(headers);
    if (!cols.length) continue;
    scanned++;

    const { kept, removed } = guard.filterRecords(headers, records);
    if (!removed.length) continue;
    touched++; removedTotal += removed.length;
    console.log(`  ${removed.length ? '🚫' : '  '} ${rel}  ${records.length} → ${kept.length} 行（-${removed.length}）`);
    for (const r of removed) report.push({ ファイル: rel, 列: r.column, 削除した社名: r.name, 禁止リスト表記: r.ng });

    if (APPLY) {
      const bom = /^﻿/.test(raw) ? '﻿' : '';
      const crlf = /\r\n/.test(raw);
      const bak = fp + '.ng-bak';
      if (!fs.existsSync(bak)) fs.copyFileSync(fp, bak);   // 初回だけ退避
      let body = toCsv(headers, kept, { ngGuard: false });  // 既にガード済み
      if (crlf) body = body.replace(/\n/g, '\r\n');
      fs.writeFileSync(fp, bom + body + (crlf ? '\r\n' : '\n'), 'utf8');
    }
  }

  // ---- Markdown成果物（ランキング表など）----
  // データ配下の .md が対象。docs/ の設計文書は触らない（本文中の社名まで消さない）。
  // 判定はCSVと同じ「社名列だけ」。表のヘッダ行から社名列（企業名/会社名/…）を特定し、
  // その列のセルだけを突合する。全セルを見ると「NEXT」「東海」のような
  // 指標セルが同名の禁止企業に当たって分析表を壊すため。
  let mdTouched = 0, mdRemoved = 0;
  for (const fp of listMd()) {
    const rel = path.relative(process.cwd(), fp);
    if (!ALL && isSkipped(fp)) continue;
    const raw = fs.readFileSync(fp, 'utf8');
    const crlfMd = raw.includes('\r\n');
    const lines = raw.split(/\r?\n/);
    const kept = [];
    let removed = 0;
    let nameIdx = -1;      // 現在の表の社名列インデックス（-1 = 社名列なし＝触らない）
    let nameCol = '';      // その列名（明細表示用）
    let inTable = false;
    const cellsOf = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    for (const line of lines) {
      if (!/^\s*\|/.test(line)) { inTable = false; nameIdx = -1; nameCol = ''; kept.push(line); continue; }
      const cells = cellsOf(line);
      if (!inTable) {                                   // 表の1行目＝ヘッダ
        inTable = true;
        nameIdx = cells.findIndex((c) => guard.NAME_COL_RE.test(c));
        nameCol = nameIdx >= 0 ? cells[nameIdx] : '';
        kept.push(line);
        continue;
      }
      if (nameIdx >= 0) {
        const cell = cells[nameIdx] || '';
        const h = guard.hit(cell);
        if (h) {
          removed++;
          report.push({ ファイル: rel, 列: `Markdown表:${nameCol}`, 削除した社名: cell, 禁止リスト表記: h.display });
          continue;
        }
      }
      kept.push(line);
    }
    if (!removed) continue;
    mdTouched++; mdRemoved += removed;
    console.log(`  🚫 ${rel}  表の ${removed} 行を削除`);
    if (APPLY) {
      const bak = fp + '.ng-bak';
      if (!fs.existsSync(bak)) fs.copyFileSync(fp, bak);
      fs.writeFileSync(fp, kept.join(crlfMd ? '\r\n' : '\n'), 'utf8');
    }
  }

  const rp = path.resolve('data', 'ng-sweep-report.csv');
  if (report.length) {
    fs.writeFileSync(rp, '﻿' + toCsv(['ファイル', '列', '削除した社名', '禁止リスト表記'], report, { ngGuard: false }).replace(/\n/g, '\r\n'), 'utf8');
  }

  console.log(`\n── 結果 ─────────────────────────────`);
  console.log(`  社名列ありCSV: ${scanned} 本（参照マスタ等スキップ: ${skipped} 本）`);
  console.log(`  禁止企業を含む: ${touched} 本 / 削除対象行: ${removedTotal} 行`);
  console.log(`  Markdown成果物: ${mdTouched} 本 / 表の ${mdRemoved} 行`);
  if (report.length) console.log(`  明細: ${path.relative(process.cwd(), rp)}`);
  console.log(APPLY
    ? '  ✓ 書き換え済み（元ファイルは .ng-bak に退避）'
    : '  ※ ドライラン。実行するには: npm run ng:sweep:apply');
}

main();
