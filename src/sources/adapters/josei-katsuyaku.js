'use strict';
/**
 * アダプタ: 女性の活躍推進企業データベース オープンデータ（厚労省）── 手動ファイル取込
 * =====================================================================
 * 公開ページ: https://positive-ryouritsu.mhlw.go.jp/positivedb/opendata/index.html
 *   このサイトは bot の User-Agent を 403 で拒否するため、自動では取りに行かない（偽装しない）。
 *   ブラウザで「全体版」の ZIP（CSV・UTF-8 BOM付き）を落として渡す:
 *     node src/source-run.js collect josei-katsuyaku --file "<ダウンロードしたZIPかCSV>"
 *
 * 列名は実ファイルで未確認（登録簿 status=unverified）。社名・法人番号・都道府県・業種・労働者数は
 * 見出しの語で拾い、「採用」を含む列は付帯情報にそのまま残す。新卒採用人数は見出しが
 * 「新卒…採用…(人数|数)」と読める列があるときだけ使う（当て推量で別の数字を入れない）。
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { readCsv } = require('../../csv');
const { mapIndustry } = require('../industry-map');

const INDEX_URL = 'https://positive-ryouritsu.mhlw.go.jp/positivedb/opendata/index.html';

async function readInput(file) {
  if (/\.zip$/i.test(file)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const csvs = Object.values(zip.files).filter((f) => !f.dir && /\.csv$/i.test(f.name));
    if (!csvs.length) throw new Error(`ZIPの中にCSVがありません: ${file}`);
    // 全体版を想定して最大のCSVを読む
    const sized = await Promise.all(csvs.map(async (f) => ({ f, text: await f.async('string') })));
    sized.sort((a, b) => b.text.length - a.text.length);
    return { text: sized[0].text, inner: sized[0].f.name };
  }
  return { text: fs.readFileSync(file, 'utf8'), inner: path.basename(file) };
}

/** 見出しから列を決める。テストからも呼ぶ。 */
function detectColumns(headers) {
  const find = (re, not) => headers.find((h) => re.test(h) && !(not && not.test(h))) || '';
  return {
    name: find(/(企業名|会社名|法人名|事業主名)/),
    corp: find(/法人番号/),
    pref: find(/都道府県/),
    city: find(/市区町村/),
    industry: find(/業種/),
    employees: find(/(常時雇用する労働者|労働者数|従業員数)/, /(女性|男性|割合|比率)/),
    hire: find(/新卒.*採用.*(人数|数)|採用.*新卒.*(人数|数)/, /(女性|男性|割合|比率|競争倍率)/),
    hireCols: headers.filter((h) => /採用/.test(h)),
  };
}

function toObservations(records, col, evidence) {
  const out = [];
  for (const r of records) {
    const name = String(r[col.name] || '').trim();
    if (!name) continue;
    const extra = {};
    for (const h of col.hireCols) if (String(r[h] || '').trim()) extra[h] = String(r[h]).trim();
    out.push({
      company_name: name, corp_no: r[col.corp] || '', pref: r[col.pref] || '', city: r[col.city] || '',
      industry_raw: r[col.industry] || '', industry: mapIndustry(r[col.industry]),
      employees: col.employees ? r[col.employees] : null,
      hire_newgrad: col.hire ? r[col.hire] : null,
      evidence_url: evidence, extra,
    });
  }
  return out;
}

async function collect(ctx) {
  const file = ctx.args.file;
  if (!file || file === true) {
    throw new Error(`このソースは手動ファイル取込です。ブラウザで ${INDEX_URL} から全体版ZIPを落として --file で渡してください`);
  }
  const { text, inner } = await readInput(file);
  const { headers, records } = readCsv(text);
  const col = detectColumns(headers);
  if (!col.name) throw new Error(`社名の列が見つかりません。見出し: ${headers.slice(0, 20).join(' / ')}`);
  ctx.log(`列の対応: 社名=${col.name} 法人番号=${col.corp || '—'} 業種=${col.industry || '—'} 労働者数=${col.employees || '—'} 新卒採用=${col.hire || '—（付帯情報のみ）'}`);
  const observations = toObservations(records, col, INDEX_URL);
  return { observations, meta: { file: path.basename(file), inner, columns: col } };
}

module.exports = { collect, detectColumns, toObservations, INDEX_URL };
