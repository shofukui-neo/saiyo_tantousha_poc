'use strict';
/**
 * マイナビ合説の抽出結果（data/mynavi-events/*.csv）を
 * 「1つのスプレッドシート＝会場ごとに1シート」の xlsx に束ねる。
 *
 *   一覧        … 会場別の社数/取得率とシートへのリンク
 *   {会場}{日付} … 会場ごとの出展企業（スプシ「大阪10/2」形式の6列＋検証列）
 *   全会場      … 全イベント結合（イベント名/開催日つき）
 *
 * 使い方:
 *   node src/build-mynavi-event-book.js
 *   node src/build-mynavi-event-book.js --in data/mynavi-events --out data/mynavi-events/マイナビ合説出展企業.xlsx
 * 先に `npm run mynavi:event:all` 等で CSV を作っておくこと。
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { readCsv } = require('./csv');

const DEFAULT_IN = path.resolve(__dirname, '..', 'data', 'mynavi-events');

// 会場シートの列（先頭6列＝スプシ「大阪10/2」と同じ並び。以降は根拠/検証用）
const SHEET_COLS = [
  ['企業名', 34], ['電話番号', 16], ['採用人数', 22], ['従業員数', 11], ['メールアドレス', 34], ['担当者名', 22],
  ['担当部署', 26], ['業種', 24], ['ブース', 7], ['出展日', 9], ['掲載社名', 30], ['本社電話番号', 16], ['電話番号候補', 26],
  ['従業員数原文', 28], ['問合せ先原文', 60], ['マイナビURL', 46],
];
// 「全会場」シートは会場情報を先頭に足す
const ALL_COLS = [['イベント名', 26], ['開催日', 12], ['会場', 30], ['都道府県', 10], ...SHEET_COLS];

const NUM_COLS = new Set(['従業員数']);

// 「就職セミナー　大阪会場」→「大阪」。「就職セミナー合同面談会　札幌会場」→「札幌」。
function cityOf(rec) {
  const m = String(rec.イベント名 || '').match(/([^\s　]+?)会場/);
  if (m) return m[1];
  return String(rec.都道府県 || '').replace(/[都道府県]$/, '') || String(rec.イベントID || '');
}
// Excelのシート名制約: 31字以内・[ ] : * ? / \ 不可
function sheetNameFor(rec, used) {
  const d = String(rec.開催日 || '').split('/');
  const date = d.length === 3 ? `${Number(d[1])}月${Number(d[2])}日` : '';
  let base = `${cityOf(rec)}${date}`.replace(/[[\]:*?/\\]/g, '-').slice(0, 31) || `イベント${rec.イベントID}`;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 28)}(${i})`;
  used.add(name);
  return name;
}

function loadEventCsvs(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.csv') && f !== 'all-events.csv')
    .map((f) => path.join(dir, f));
  const events = [];
  for (const file of files) {
    const { records: recs } = readCsv(fs.readFileSync(file, 'utf8')); // readCsv は BOM を除去して {headers, records} を返す
    if (!recs.length) continue;
    const h = recs[0];
    events.push({
      file,
      eventId: h.イベントID || '',
      title: h.イベント名 || path.basename(file, '.csv'),
      date: h.開催日 || '',
      place: h.会場 || '',
      pref: h.都道府県 || '',
      rows: recs,
    });
  }
  // 開催日 → イベントID の順（一覧と同じ並びでシートを並べる）
  events.sort((a, b) => (a.date === b.date ? a.eventId.localeCompare(b.eventId) : a.date.localeCompare(b.date)));
  return events;
}

function styleHeader(ws, colCount) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.alignment = { vertical: 'middle' };
  row.height = 22;
  for (let c = 1; c <= colCount; c++) {
    row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5C8B' } };
    row.getCell(c).border = { bottom: { style: 'thin', color: { argb: 'FF9BB7CC' } } };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colCount } };
}

function fillSheet(ws, cols, records) {
  ws.columns = cols.map(([header, width]) => ({ header, key: header, width }));
  for (const rec of records) {
    const row = {};
    for (const [header] of cols) {
      let v = rec[header] == null ? '' : rec[header];
      if (NUM_COLS.has(header) && /^\d+$/.test(String(v))) v = Number(v);
      row[header] = v;
    }
    ws.addRow(row);
  }
  styleHeader(ws, cols.length);
  // 罫線・折返しはしない（貼り付け先での再加工を邪魔しない）。行の縞だけ付ける。
  for (let r = 2; r <= ws.rowCount; r++) {
    if (r % 2 === 0) ws.getRow(r).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F8FB' } };
  }
}

function buildBook(events, outFile) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'saiyo-tantousha-poc / scrape-mynavi-event';
  wb.created = new Date();

  const index = wb.addWorksheet('一覧');
  const used = new Set(['一覧', '全会場']);
  const named = events.map((ev) => ({ ...ev, sheet: sheetNameFor(ev.rows[0], used) }));

  // 一覧シート
  index.columns = [
    { header: 'シート', key: 'sheet', width: 16 }, { header: 'イベント名', key: 'title', width: 28 },
    { header: '開催日', key: 'date', width: 12 }, { header: '都道府県', key: 'pref', width: 10 },
    { header: '会場', key: 'place', width: 34 }, { header: '出展企業数', key: 'n', width: 11 },
    { header: '電話取得', key: 'phone', width: 10 }, { header: '担当者名取得', key: 'name', width: 12 },
    { header: 'メール取得', key: 'mail', width: 11 }, { header: 'イベントID', key: 'eventId', width: 11 },
  ];
  for (const ev of named) {
    const r = index.addRow({
      sheet: ev.sheet, title: ev.title, date: ev.date, pref: ev.pref, place: ev.place,
      n: ev.rows.length,
      phone: ev.rows.filter((x) => x.電話番号).length,
      name: ev.rows.filter((x) => x.担当者名).length,
      mail: ev.rows.filter((x) => x.メールアドレス).length,
      eventId: ev.eventId,
    });
    r.getCell('sheet').value = { text: ev.sheet, hyperlink: `#'${ev.sheet}'!A1` };
    r.getCell('sheet').font = { color: { argb: 'FF1155CC' }, underline: true };
  }
  const total = index.addRow({
    sheet: '合計', title: `${named.length}会場`, n: named.reduce((s, e) => s + e.rows.length, 0),
    phone: named.reduce((s, e) => s + e.rows.filter((x) => x.電話番号).length, 0),
    name: named.reduce((s, e) => s + e.rows.filter((x) => x.担当者名).length, 0),
    mail: named.reduce((s, e) => s + e.rows.filter((x) => x.メールアドレス).length, 0),
  });
  total.font = { bold: true };
  styleHeader(index, 10);

  // 会場ごとのシート
  for (const ev of named) fillSheet(wb.addWorksheet(ev.sheet), SHEET_COLS, ev.rows);

  // 全会場（結合）
  const allRows = [];
  for (const ev of named) for (const r of ev.rows) allRows.push(r);
  fillSheet(wb.addWorksheet('全会場'), ALL_COLS, allRows);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // useSharedStrings: 会場シートと「全会場」で重複する文字列を共有化しファイルを小さくする
  return wb.xlsx.writeFile(outFile, { useSharedStrings: true }).then(() => ({ named, allRows }));
}

async function main() {
  const argv = process.argv.slice(2);
  let inDir = DEFAULT_IN;
  let outFile = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') inDir = path.resolve(argv[++i]);
    else if (argv[i] === '--out') outFile = path.resolve(argv[++i]);
  }
  if (!outFile) outFile = path.join(inDir, 'マイナビ合説出展企業.xlsx');
  if (!fs.existsSync(inDir)) throw new Error(`入力ディレクトリがありません: ${inDir}（先に npm run mynavi:event:all）`);
  const events = loadEventCsvs(inDir);
  if (!events.length) throw new Error(`CSVが見つかりません: ${inDir}`);
  const { named, allRows } = await buildBook(events, outFile);
  console.log(`シート: 一覧 + ${named.length}会場 + 全会場`);
  for (const ev of named) console.log(`  ${ev.sheet}\t${ev.date}\t${ev.rows.length}社\t${ev.title}`);
  console.log(`全会場: ${allRows.length}行`);
  console.log(`→ ${outFile}`);
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });

module.exports = { loadEventCsvs, buildBook, sheetNameFor, cityOf, SHEET_COLS, ALL_COLS };
