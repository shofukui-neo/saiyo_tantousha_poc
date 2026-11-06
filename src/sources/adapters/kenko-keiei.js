'use strict';
/**
 * アダプタ: 健康経営優良法人 認定法人一覧（経産省・認定事務局ポータル）
 * =====================================================================
 * 公開ページ: https://kenko-keiei.jp/houjin_list/
 *   nintei<年>_daikibo<日付>.xlsx（大規模法人部門）／ nintei<年>_chusho<日付>.xlsx（中小規模法人部門）
 *   各シートの見出し行: No. / (小規模特例認定) / 認定法人名 / 法人番号 / 加入保険者 / 都道府県 / 市区町村 / 業種
 *
 * 法人番号と業種が全件に付いているので、既存母集団の業種の穴埋め（名寄せで合流）にも効く。
 *
 * 規模の扱い:
 *   大規模法人部門は、中小企業基本法の従業員基準（製造業その他300人・卸売/サービス100人・小売50人）を
 *   超える法人の部門。そこから「従業員数下限(推定)」を置く。実数ではないので「従業員数」には入れない。
 *   中小規模法人部門は上限しか分からないため、規模の裏付けにしない（L0 のまま、エンリッチ待ち）。
 */
const ExcelJS = require('exceljs');
const { politeGet } = require('../../polite');
const { downloadFile } = require('../download');
const { mapIndustry } = require('../industry-map');

const INDEX_URL = 'https://kenko-keiei.jp/houjin_list/';
const LINK_RE = /https?:\/\/[^"'\s]*\/nintei(\d{4})_(daikibo|chusho)(\d*)\.xlsx/g;

/** 公開ページから、部門ごとに最新の Excel を1本ずつ選ぶ。 */
function pickLatestLinks(html) {
  const best = new Map();
  for (const m of html.matchAll(LINK_RE)) {
    const [url, year, kind, stamp] = m;
    const key = `${year}${stamp}`;
    const prev = best.get(kind);
    if (!prev || prev.key < key) best.set(kind, { kind, year, key, url });
  }
  return [...best.values()];
}

/** 大規模法人部門の従業員数下限（推定）。業種で基準が違う。 */
function minEmployeesForLarge(industryRaw) {
  const s = String(industryRaw || '');
  if (/小売/.test(s)) return 51;
  if (/(卸売|サービス|医療|福祉|宿泊|飲食|教育|学習|娯楽|生活関連)/.test(s)) return 101;
  return 301;
}

const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text || v.result || (v.richText ? v.richText.map((t) => t.text).join('') : '') || '');
  return String(v);
};

/** シート1枚から行を読む。見出し行（「認定法人名」を含む行）を探して列位置を決める。テストからも呼ぶ。 */
function rowsOfSheet(rows, kind, sheetName, url) {
  let col = null;
  const out = [];
  for (const values of rows) {
    const cells = Array.from(values, cellText); // ExcelJS の行は穴あき配列（map だと穴が残る）
    // 見出し行はシートの途中にも繰り返し出る。そのたびに列位置を取り直し、行としては読まない。
    const at = (label) => cells.findIndex((c) => c.replace(/\s+/g, '') === label);
    if (at('認定法人名') >= 0) {
      col = { name: at('認定法人名'), corp: at('法人番号'), pref: at('都道府県'), city: at('市区町村'), ind: at('業種'), small: at('小規模特例認定') };
      continue;
    }
    if (!col) continue;
    const name = (cells[col.name] || '').trim();
    if (!name) continue;
    const industryRaw = col.ind >= 0 ? cells[col.ind].trim() : '';
    out.push({
      company_name: name,
      corp_no: col.corp >= 0 ? cells[col.corp] : '',
      pref: col.pref >= 0 ? cells[col.pref].trim() : '',
      city: col.city >= 0 ? cells[col.city].trim() : '',
      industry_raw: industryRaw,
      industry: mapIndustry(industryRaw, name),
      employees_band: kind === 'daikibo' ? '健康経営 大規模法人部門' : '健康経営 中小規模法人部門',
      employees_min: kind === 'daikibo' ? minEmployeesForLarge(industryRaw) : null,
      evidence_url: url,
      extra: { 認定区分: sheetName, 小規模特例: col.small >= 0 && cells[col.small] ? '1' : '' },
    });
  }
  return out;
}

async function readWorkbook(path, kind, url) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out = [];
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1)));
    out.push(...rowsOfSheet(rows, kind, ws.name, url));
  }
  return out;
}

async function collect(ctx) {
  const page = await politeGet(INDEX_URL, { render: 'static' });
  if (!page || !page.html) throw new Error(`公開ページを取得できません: ${INDEX_URL}（${page && (page.reason || page.error)}）`);
  const links = pickLatestLinks(page.html);
  if (!links.length) throw new Error('認定法人一覧のExcelが見つかりません（公開ページの構造が変わった可能性）');
  const observations = [];
  for (const l of links) {
    const f = await downloadFile(l.url, { sourceId: 'kenko-keiei', maxAgeDays: 60 });
    const obs = await readWorkbook(f.path, l.kind, l.url);
    ctx.log(`  ${l.kind}（${l.year}）: ${obs.length.toLocaleString()} 法人${f.cached ? '（キャッシュ）' : ''}`);
    observations.push(...obs);
  }
  return { observations, meta: { files: links.map((l) => l.url) } };
}

module.exports = { collect, pickLatestLinks, rowsOfSheet, minEmployeesForLarge, INDEX_URL };
