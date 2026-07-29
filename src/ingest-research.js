'use strict';
// 半自動リサーチ補助（その2）: 人がログイン済みブラウザで集めた結果を取り込み、
// 既存の精度ゲート（姓辞書＋会社一致＋役割語）に通して名寄せ・重複排除し、成果CSVにする。
// 自動アクセスは一切しない。入力は「人が手で集めた／保存した」ファイルだけ。
//
// 入力モード:
//   1) ワークシートCSV（research-queue.js 出力に人が記入したもの）
//        企業名,…,採用担当者名,役職,根拠URL,見つかった媒体  を読み、姓辞書で検証して採用。
//   2) 行テキスト（--in xxx.txt）: 1行 = `企業名<TAB>タイトル文`
//        例: `株式会社サンプル<TAB>山田 太郎 - 株式会社サンプル 採用担当 | LinkedIn`
//        タイトル文を extractNameFromResult（scrape-social）に通す。
//   3) 単一社の保存HTML（--html page.html --company "社名"）:
//        ログイン済みで開いた検索結果ページを“人が保存”したファイルをオフライン解析。
//
//   node src/ingest-research.js --in sources/research-worksheet.csv --out sources/H-research-names.csv
//   node src/ingest-research.js --in collected.txt --out sources/H-research-names.csv
//   node src/ingest-research.js --html linkedin-saved.html --company "株式会社サンプル" --out sources/H-research-names.csv
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { firstFullName } = require('./scrape-names');
const { looksLikePersonName } = require('./extract');
const { extractNameFromResult, splitTitleSegments } = require('./scrape-social');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

const OUT_HEADERS = ['企業名', '法人番号', '採用担当者名', '役職', '部署',
  '取得元媒体', 'チャネル', '根拠URL', '担当者確度', '取得元', '取得日'];

// 人が記入したワークシートCSV → 行。氏名は姓辞書で検証（人手入力の表記揺れ・誤記を弾く）。
function fromWorksheet(records) {
  const out = [];
  for (const r of records) {
    const company = r['企業名'] || r['会社'] || '';
    const rawName = (r['採用担当者名'] || '').trim();
    if (!company || !rawName) continue;
    // 人手入力でも辞書ゲートを通す（「採用担当」等の役割語だけの記入を弾く）。役職等が混じれば剥がして検証。
    const name = firstFullName(rawName) || (looksLikePersonName(rawName.replace(/[ 　]/g, '')) ? rawName.replace(/[ 　]/g, '') : '');
    if (!name) continue;
    out.push({
      '企業名': company, '法人番号': r['法人番号'] || '',
      '採用担当者名': name, '役職': r['役職'] || '', '部署': r['部署'] || '',
      '取得元媒体': r['見つかった媒体'] || '手動リサーチ', 'チャネル': 'manual',
      '根拠URL': r['根拠URL'] || '', '担当者確度': 0.6,
      '取得元': 'worksheet', '取得日': new Date().toISOString().slice(0, 10),
    });
  }
  return out;
}

// 行テキスト（企業名<TAB>タイトル文）→ 行。タイトル文を既存の検索結果パーサに通す。
function fromLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const tab = s.indexOf('\t');
    if (tab < 0) continue;
    const company = s.slice(0, tab).trim();
    const title = s.slice(tab + 1).trim();
    if (!company || !title) continue;
    // URL がタイトル末尾に貼られていれば拾う
    const m = title.match(/https?:\/\/\S+/);
    const url = m ? m[0] : '';
    const got = extractNameFromResult({ title: title.replace(/https?:\/\/\S+/, ''), snippet: '', url, domain: '' },
      company, { requireRole: false });
    if (!got) continue;
    out.push({
      '企業名': company, '法人番号': '',
      '採用担当者名': got.name, '役職': got.role || '', '部署': '',
      '取得元媒体': '手動リサーチ', 'チャネル': 'manual', '根拠URL': url,
      '担当者確度': got.confidence, '取得元': 'lines', '取得日': new Date().toISOString().slice(0, 10),
    });
  }
  return out;
}

// 単一社の保存HTML → 行。アンカー/見出しテキストを擬似検索結果にして精度ゲートに通す。
function fromHtml(html, company) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const out = [];
  const seen = new Set();
  // プロフィール系リンク・見出しを候補に（媒体DOMに依存しすぎない緩い拾い方）
  $('a, h1, h2, h3, span, div').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!t || t.length > 80) return;
    if (!/[一-龥]/.test(t)) return; // 漢字を含む（日本語氏名の前提）
    const href = $(el).attr('href') || '';
    const got = extractNameFromResult({ title: t, snippet: '', url: href, domain: '' }, company, { requireRole: false });
    if (!got) return;
    if (seen.has(got.name)) return;
    seen.add(got.name);
    out.push({
      '企業名': company, '法人番号': '',
      '採用担当者名': got.name, '役職': got.role || '', '部署': '',
      '取得元媒体': '手動リサーチ(HTML)', 'チャネル': 'manual', '根拠URL': href,
      '担当者確度': got.confidence, '取得元': 'html', '取得日': new Date().toISOString().slice(0, 10),
    });
  });
  return out;
}

// 同一（正規化社名×氏名）で重複排除。確度の高いものを残す。
function dedup(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = normCompanyName(r['企業名']) + '|' + r['採用担当者名'];
    const prev = best.get(k);
    if (!prev || Number(r['担当者確度'] || 0) > Number(prev['担当者確度'] || 0)) best.set(k, r);
  }
  return [...best.values()];
}

function run() {
  const IN = getArg('in', '');
  const HTML = getArg('html', '');
  const COMPANY = getArg('company', '');
  const OUT = getArg('out', path.join('sources', 'H-research-names.csv'));

  let rows = [];
  if (HTML) {
    if (!COMPANY) throw new Error('--html には --company "社名" が必要です');
    rows = fromHtml(fs.readFileSync(path.resolve(HTML), 'utf8'), COMPANY);
  } else if (IN) {
    const raw = fs.readFileSync(path.resolve(IN), 'utf8');
    if (/\.csv$/i.test(IN)) rows = fromWorksheet(readCsv(raw).records);
    else rows = fromLines(raw);
  } else {
    throw new Error('--in <file.csv|file.txt> もしくは --html <page.html> --company "社名" を指定してください');
  }

  const deduped = dedup(rows);
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  fs.writeFileSync(OUTABS, toCsv(OUT_HEADERS, deduped));
  console.log(`[research:ingest] 取込 ${rows.length}件 → 重複排除後 ${deduped.length}件（姓辞書＋会社一致で検証済）`);
  console.log(`  出力: ${OUTABS}（系統D=ネットワーク/既存資産としてmanifestに登録可）`);
}

module.exports = { fromWorksheet, fromLines, fromHtml, dedup, OUT_HEADERS };

if (require.main === module) {
  try { run(); }
  catch (e) { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; }
}
