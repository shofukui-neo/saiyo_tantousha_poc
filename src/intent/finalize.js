'use strict';
/**
 * 作業ファイル → 最終CSV（並べ替えて書き出す）
 * ============================================================================
 * 素直に readCsv して records を sort すると、2万行でヒープが約1.9GB要る
 * （実測: 5,358行で484MB → 20,928行で約1,892MB）。取得に90分かけた後の
 * 最後の一手でOOMするのが一番もったいないので、行をオブジェクトに開かずに並べ替える。
 *
 * やり方: 引用符の状態だけ見て「行の範囲」を切り出し、
 *   並べ替えキー（総合優先度・インテントスコア）と行の文字列の位置だけを持つ。
 * 行の中身は最後に元テキストから切り出して書くだけなので、
 * ピークは「元テキスト＋インデックス」で済む（実測200MB前後）。
 *
 * No 列は作業ファイル側では空のまま書いてあり、並べ替え後にここで採番する。
 * 先頭列なので、行頭に番号を足すだけでよい（行文字列は "," で始まる）。
 */
const fs = require('fs');
const ngGuard = require('../ng-guard');

// 引用符の中の改行で行を切らないスキャナ。行の [開始, 終了) を順に返す。
function* rowRanges(text, from = 0) {
  let i = from; let start = from; let q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') i++; else q = false; }
    } else if (c === '"') q = true;
    else if (c === '\n') {
      let end = i;
      if (end > start && text[end - 1] === '\r') end--;
      if (end > start) yield [start, end];
      start = i + 1;
    }
    i++;
  }
  if (start < text.length) yield [start, text.length];
}

// 1行ぶんの文字列から n 番目のフィールドを取り出す（必要な列だけ読む）
function fieldAt(row, n) {
  let i = 0; let f = 0; let out = ''; let q = false;
  while (i < row.length) {
    const c = row[i];
    if (q) {
      if (c === '"') { if (row[i + 1] === '"') { out += '"'; i++; } else q = false; }
      else out += c;
    } else if (c === '"') q = true;
    else if (c === ',') { if (f === n) return out; f++; out = ''; }
    else out += c;
    i++;
  }
  return f === n ? out : '';
}

/**
 * @param {string} workPath 作業ファイル（1行目ヘッダ・No列は空）
 * @param {string} outPath  最終CSV
 * @param {{sortBy?:string[], noColumn?:string}} opts
 * @returns {{行数:number}}
 */
function finalizeFromWork(workPath, outPath, opts = {}) {
  const text = fs.readFileSync(workPath, 'utf8');
  const it = rowRanges(text);
  const first = it.next();
  if (first.done) { fs.writeFileSync(outPath, ''); return { 行数: 0 }; }
  const header = text.slice(first.value[0], first.value[1]);
  const cols = header.split(',').map((c) => c.replace(/^"|"$/g, ''));
  const [k1, k2] = opts.sortBy || ['総合優先度', 'インテントスコア'];
  const i1 = cols.indexOf(k1); const i2 = cols.indexOf(k2);
  const iNo = cols.indexOf(opts.noColumn || 'No');

  // 架電禁止の最終防波堤。行は追記時にも toCsv のガードを通っているが、
  // 最後の書き出しでもう一度見るのが既存の設計（src/ng-guard.js）。ここを省くと関所が1枚減る。
  const iName = cols.indexOf(opts.nameColumn || '企業名');
  const index = [];
  let ng = 0;
  for (const [s, e] of it) {
    const row = text.slice(s, e);
    if (iName >= 0 && ngGuard.hit(fieldAt(row, iName))) { ng++; continue; }
    index.push({ s, e, a: parseFloat(fieldAt(row, i1)) || 0, b: parseFloat(fieldAt(row, i2)) || 0 });
  }
  if (ng) console.log(`[ng-guard] ${outPath}: 架電禁止 ${ng}行を落とした`);
  index.sort((x, y) => (y.a - x.a) || (y.b - x.b));

  const out = fs.createWriteStream(outPath);
  out.write(header + '\n');
  let buf = '';
  for (let i = 0; i < index.length; i++) {
    const { s, e } = index[i];
    const row = text.slice(s, e);
    // No は先頭列で作業ファイルでは空。行頭に採番を足すだけでよい。
    buf += (iNo === 0 ? String(i + 1) + row : row) + '\n';
    if (buf.length > 4e6) { out.write(buf); buf = ''; }
  }
  if (buf) out.write(buf);
  return new Promise((resolve) => out.end(() => resolve({ 行数: index.length, 除外: ng })));
}

module.exports = { finalizeFromWork, rowRanges, fieldAt };
