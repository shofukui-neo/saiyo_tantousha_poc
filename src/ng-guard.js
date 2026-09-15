'use strict';
// 架電禁止リストの恒久ガード（無条件削除）。
//   「架電禁止正規化リスト」に載っている企業は、既存・新規を問わず
//   あらゆる成果物（CSV／シート）から無条件で落とす。
//
//   設計:
//     - 正リストは data/ng-companies.txt（1行1社名・UTF-8）。ng-sync.js で取込・更新する。
//     - 突合キーは ng-index.js（= csv.js の normCompanyName）。法人格・全半角・記号・
//       空白の揺れを吸収し、旧社名表記（（旧：○○）等）も展開して捕捉する。
//     - 既定は「素の社名が一致したら落とす」（前株/後株の位置は見ない）。
//       exclude-ng.js の既定（位置が逆なら別法人として残す）とは逆にしてある。
//       禁止リストは取りこぼし＝コンプライアンス事故なので、安全側に倒す。
//       NG_STRICT_CORP_POS=1 で位置判定あり（前後逆は別法人として残す）に切替。
//
//   出力側フック（ここを通せば全成果物が自動で守られる）:
//     - csv.js       toCsv()          … src配下のCSV出力ほぼ全て（100箇所）が経由
//     - master-io.js writeMasterCsv() / writeMasterSheet()
//     - clean-csv.js（行配列で再書き出しする修復ユーティリティ）
//
//   例外（ガードを外す）:
//     - NG明細そのものを書く出力（exclude-ng.js の .ng-excluded.csv、ng-sweep のレポート）
//       → toCsv(headers, recs, { ngGuard: false })
//     - 環境変数 NG_GUARD=off でプロセス全体を無効化（緊急時のみ）

const fs = require('fs');
const path = require('path');

const NG_FILE = process.env.NG_LIST_FILE
  || path.resolve(__dirname, '..', 'data', 'ng-companies.txt');

let _idx = null;      // buildNgIndex の結果（プロセス内キャッシュ）
let _warned = false;
const _stats = { removed: 0, byName: new Map() };

function enabled() { return String(process.env.NG_GUARD || '').toLowerCase() !== 'off'; }

// ---- 半角カナ → 全角カナ ----
// csv.js の normCompanyName は全角英数の半角化しかしない（＝「ﾋﾞｯｸｶﾒﾗ」と「ビックカメラ」が
// 別キーになる）。禁止判定は取りこぼしが致命的なので、突合の直前に両側を全角カナへ寄せる。
// 変換は ng-guard の内部だけで完結させ、名寄せキー本体（csv.js）の意味は変えない。
const KANA_BASE = {
  'ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ','ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ',
  'ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ','ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト',
  'ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ','ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ',
  'ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ','ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ',
  'ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ','ﾜ':'ワ','ｦ':'ヲ','ﾝ':'ン',
  'ｧ':'ァ','ｨ':'ィ','ｩ':'ゥ','ｪ':'ェ','ｫ':'ォ','ｬ':'ャ','ｭ':'ュ','ｮ':'ョ','ｯ':'ッ',
  'ｰ':'ー','｡':'。','｢':'「','｣':'」','､':'、','･':'・',
};
const KANA_DAKU = { 'ｶ':'ガ','ｷ':'ギ','ｸ':'グ','ｹ':'ゲ','ｺ':'ゴ','ｻ':'ザ','ｼ':'ジ','ｽ':'ズ','ｾ':'ゼ','ｿ':'ゾ',
  'ﾀ':'ダ','ﾁ':'ヂ','ﾂ':'ヅ','ﾃ':'デ','ﾄ':'ド','ﾊ':'バ','ﾋ':'ビ','ﾌ':'ブ','ﾍ':'ベ','ﾎ':'ボ','ｳ':'ヴ' };
const KANA_HANDAKU = { 'ﾊ':'パ','ﾋ':'ピ','ﾌ':'プ','ﾍ':'ペ','ﾎ':'ポ' };
function toWideKana(input) {
  const s = String(input == null ? '' : input);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (n === 'ﾞ' && KANA_DAKU[c]) { out += KANA_DAKU[c]; i++; continue; }
    if (n === 'ﾟ' && KANA_HANDAKU[c]) { out += KANA_HANDAKU[c]; i++; continue; }
    out += (KANA_BASE[c] || c);
  }
  return out;
}

// 正リストを読み込んで索引化（1回だけ）。無ければ空索引（＝素通し）＋警告。
function loadNg() {
  if (_idx) return _idx;
  const { buildNgIndex } = require('./ng-index');   // 遅延require（csv.js との循環回避）
  let text = '';
  try { text = fs.readFileSync(NG_FILE, 'utf8'); }
  catch (_) {
    if (!_warned) { _warned = true; console.warn(`⚠ 架電禁止リストが見つかりません: ${NG_FILE}（ガード無効のまま出力します）`); }
  }
  _idx = buildNgIndex(toWideKana(text));   // 禁止側も全角カナへ寄せて索引化
  return _idx;
}

function reload() { _idx = null; return loadNg(); }
function size() { return loadNg().byKey.size; }

// 社名1件が架電禁止か → 一致エントリ（{display,posSet}）or null
function hit(name) {
  if (!enabled()) return null;
  const s = String(name == null ? '' : name).trim();
  if (!s) return null;
  const { ngHit } = require('./ng-index');
  const strictPos = String(process.env.NG_STRICT_CORP_POS || '') === '1';
  const ng = loadNg(), opt = { ignorePos: !strictPos };
  const direct = ngHit(toWideKana(s), ng, opt);
  if (direct) return direct;
  // 媒体由来のラベルが社名末尾にくっついた表記（「(株)ビックカメラ【東証プライム市場上場】PICK UP」）
  // を救う。マイナビ等の一覧から拾った社名に混じる。除去しても別法人にはならない語だけを対象にする。
  const bare = stripMediaLabel(s);
  return bare && bare !== s ? ngHit(toWideKana(bare), ng, opt) : null;
}

// 社名末尾の媒体ラベル（掲載ステータス等）を落とす。連続していても全部剥がす。
const MEDIA_SUFFIX = /[\s　]*(PICK\s*UP|PICKUP|NEW|急募|注目|おすすめ|掲載中|新着|必見|エントリー受付中|説明会開催中|選考中)[\s　]*$/i;
function stripMediaLabel(name) {
  let s = String(name == null ? '' : name).trim();
  let prev;
  do { prev = s; s = s.replace(MEDIA_SUFFIX, '').trim(); } while (s !== prev && s);
  return s;
}
function isNg(name) { return !!hit(name); }

// ---- 社名列の自動判定 ----
// 「企業名 / 会社名 / 法人名 / 社名 / company_name」およびその接尾（BALES の
// 「会社情報：会社名」等）を社名列とみなす。1つも無いCSV（分析レポート等）は素通し。
const NAME_COL_RE = /(企業名|会社名|法人名|社名|company[_\s-]?name|company)$/i;
function nameColumnsOf(headers) {
  return (headers || [])
    .map((h) => String(h || '').trim())
    .filter((h) => h && NAME_COL_RE.test(h));
}

// レコード配列から禁止企業を落とす。→ { kept, removed:[{name, ng}] }
function filterRecords(headers, records, opts = {}) {
  const recs = Array.isArray(records) ? records : [];
  if (!enabled() || opts.ngGuard === false) return { kept: recs, removed: [], cols: [] };
  const cols = opts.nameCols && opts.nameCols.length ? opts.nameCols : nameColumnsOf(headers);
  if (!cols.length || !size()) return { kept: recs, removed: [], cols };

  const kept = [], removed = [];
  for (const rec of recs) {
    let h = null, src = '';
    for (const c of cols) {
      const v = rec && rec[c];
      const m = hit(v);
      if (m) { h = m; src = String(v).trim(); break; }
    }
    if (h) removed.push({ name: src, ng: h.display, column: cols.find((c) => String(rec[c] || '').trim() === src) || cols[0] });
    else kept.push(rec);
  }
  return { kept, removed, cols };
}

// 行配列（[header, ...rows]）版。clean-csv.js のような行指向の書き出し用。
function filterRows(rows, opts = {}) {
  if (!enabled() || opts.ngGuard === false || !Array.isArray(rows) || rows.length < 2) {
    return { kept: rows || [], removed: [] };
  }
  const headers = rows[0].map((h) => String(h || '').trim());
  const idxs = headers.map((h, i) => (NAME_COL_RE.test(h) ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length || !size()) return { kept: rows, removed: [] };
  const kept = [rows[0]], removed = [];
  for (const r of rows.slice(1)) {
    let h = null, src = '';
    for (const i of idxs) { const m = hit(r[i]); if (m) { h = m; src = String(r[i]).trim(); break; } }
    if (h) removed.push({ name: src, ng: h.display }); else kept.push(r);
  }
  return { kept, removed };
}

// 出力フックから呼ぶ共通処理（落ちた件数を集計し、初回だけ標準エラーに知らせる）。
function note(removed, where) {
  if (!removed || !removed.length) return;
  _stats.removed += removed.length;
  for (const r of removed) _stats.byName.set(r.name, (_stats.byName.get(r.name) || 0) + 1);
  const sample = removed.slice(0, 3).map((r) => r.name).join(' / ');
  console.warn(`🚫 架電禁止 ${removed.length}件を除外${where ? `（${where}）` : ''}: ${sample}${removed.length > 3 ? ' …' : ''}`);
}

function guardRecords(headers, records, opts = {}) {
  const r = filterRecords(headers, records, opts);
  note(r.removed, opts.where);
  return r.kept;
}
function guardRows(rows, opts = {}) {
  const r = filterRows(rows, opts);
  note(r.removed, opts.where);
  return r.kept;
}
function stats() { return { removed: _stats.removed, names: [..._stats.byName.keys()] }; }

module.exports = {
  NG_FILE, enabled, loadNg, reload, size, hit, isNg, toWideKana,
  NAME_COL_RE, nameColumnsOf, stripMediaLabel, filterRecords, filterRows,
  guardRecords, guardRows, stats,
};
