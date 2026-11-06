'use strict';
/**
 * アダプタ: 介護サービス情報公表システム オープンデータ（厚労省）
 * =====================================================================
 * 公開ページ: https://www.mhlw.go.jp/stf/kaigo-kouhyou_opendata.html
 *   サービス種類ごとの CSV（jigyosho_<コード>_all_<出力日時>.csv）が年2回（6月末・12月末時点）出る。
 *   1行=1事業所。列: 事業所名 / 電話番号 / 法人番号（空が多い）/ 法人の名称 / 事業所番号 / URL / 都道府県名 …
 *
 * 1行1事業所を「運営法人」単位に畳んで観測にする。
 *   拠点数   = 事業所番号のユニーク数（規模の裏付け。10拠点以上で L1 に上がる）
 *   電話     = 最多の都道府県にある事業所のうち「本部・本社」を名乗る事業所、無ければ先頭の事業所
 *              （法人の代表番号ではない。付帯情報に「電話の種別=事業所」と残す）
 *   業種     = 介護・保育・医療法人等（INDUSTRY_LIFT +11 の勝ち筋ラベル）
 */
const fs = require('fs');
const { readCsv, normCorpNumber, normCompanyName } = require('../../csv');
const { politeGet } = require('../../polite');
const { downloadFile } = require('../download');

const INDEX_URL = 'https://www.mhlw.go.jp/stf/kaigo-kouhyou_opendata.html';
const LINK_RE = /\/content\/12300000\/jigyosho_(\d+)_all_(\d{14})\.csv/g;

/** 公開ページから、最新の出力回のCSVリンクをサービスコードごとに1本ずつ選ぶ。 */
function pickLatestLinks(html) {
  const byCode = new Map();
  for (const m of html.matchAll(LINK_RE)) {
    const [path, code, ts] = m;
    const prev = byCode.get(code);
    if (!prev || prev.ts < ts) byCode.set(code, { code, ts, url: new URL(path, INDEX_URL).href });
  }
  const links = [...byCode.values()];
  if (!links.length) return [];
  // 出力日（先頭8桁）が最新の回だけを使う。古い回の取り残しを混ぜない。
  const latestDay = links.map((l) => l.ts.slice(0, 8)).sort().pop();
  return links.filter((l) => l.ts.startsWith(latestDay)).sort((a, b) => a.code.localeCompare(b.code));
}

const mode = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };

/** 事業所の行（CSVレコード）を運営法人ごとの集計 ops に積む。ファイル単位で呼んでメモリを抑える。 */
function addRows(ops, rows, csvUrl = INDEX_URL) {
  for (const r of rows) {
    const name = String(r['法人の名称'] || '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const key = normCorpNumber(r['法人番号']) || normCompanyName(name);
    if (!key) continue;
    let o = ops.get(key);
    if (!o) {
      o = { names: new Map(), corp: '', sites: new Set(), services: new Map(), prefs: new Map(),
        cities: new Map(), urls: new Map(), offices: [], capacity: 0, evidence: csvUrl };
      ops.set(key, o);
    }
    bump(o.names, name);
    if (!o.corp) o.corp = normCorpNumber(r['法人番号']);
    o.sites.add(String(r['事業所番号'] || r['事業所名'] || '').trim());
    bump(o.services, String(r['サービスの種類'] || '').trim());
    const pref = String(r['都道府県名'] || '').trim();
    bump(o.prefs, pref);
    bump(o.cities, `${pref}\t${String(r['市区町村名'] || '').trim()}`);
    bump(o.urls, String(r['URL'] || '').trim());
    const cap = parseInt(String(r['定員'] || '').replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(cap)) o.capacity += cap;
    const phone = String(r['電話番号'] || '').trim();
    if (phone) o.offices.push({ pref, phone, office: String(r['事業所名'] || '').trim() });
  }
  return ops;
}

/** 集計 ops を観測レコードにする。 */
function finishOps(ops) {
  const out = [];
  for (const o of ops.values()) {
    const pref = mode(o.prefs);
    const city = (mode(new Map([...o.cities].filter(([k]) => k.startsWith(pref + '\t')))) || '').split('\t')[1] || '';
    const home = o.offices.filter((x) => x.pref === pref);
    const hq = home.find((x) => /(本部|本社|法人事務局)/.test(x.office)) || home[0] || o.offices[0];
    const services = [...o.services.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    out.push({
      company_name: mode(o.names), corp_no: o.corp, phone: hq ? hq.phone : '', pref, city,
      url: mode(o.urls), industry_raw: `介護サービス（${services.slice(0, 3).join('・')}${services.length > 3 ? ' 他' : ''}）`,
      industry: '介護・保育・医療法人等', sites: o.sites.size, evidence_url: o.evidence,
      extra: { 電話の種別: '事業所', 電話の事業所: hq ? hq.office : '', サービス種類数: services.length,
        都道府県数: o.prefs.size, 定員合計: o.capacity || '' },
    });
  }
  return out;
}

/** 事業所の行をまとめて運営法人単位に畳む（テスト用の近道）。 */
const foldByOperator = (rows, csvUrl) => finishOps(addRows(new Map(), rows, csvUrl));

/**
 * @param {{log:(m:string)=>void, args:object}} ctx args.maxFiles で取得ファイル数を絞れる（動作確認用）
 */
async function collect(ctx) {
  const page = await politeGet(INDEX_URL, { render: 'static' });
  if (!page || !page.html) throw new Error(`公開ページを取得できません: ${INDEX_URL}（${page && (page.reason || page.error)}）`);
  let links = pickLatestLinks(page.html);
  if (!links.length) throw new Error('CSVリンクが見つかりません（公開ページの構造が変わった可能性）');
  if (ctx.args.maxFiles) links = links.slice(0, parseInt(ctx.args.maxFiles, 10));
  ctx.log(`出力回 ${links[0].ts.slice(0, 8)} の ${links.length} ファイルを取得します`);

  const ops = new Map();
  let offices = 0;
  for (const l of links) {
    const f = await downloadFile(l.url, { sourceId: 'kaigo-kouhyou', maxAgeDays: 60 });
    const recs = readCsv(fs.readFileSync(f.path, 'utf8')).records;
    addRows(ops, recs, l.url);
    offices += recs.length;
    ctx.log(`  ${l.code}: ${recs.length.toLocaleString()} 事業所${f.cached ? '（キャッシュ）' : ''}`);
  }
  const observations = finishOps(ops);
  ctx.log(`事業所 ${offices.toLocaleString()} → 運営法人 ${observations.length.toLocaleString()}`);
  return { observations, meta: { files: links.length, offices, as_of: links[0].ts.slice(0, 8) } };
}

module.exports = { collect, pickLatestLinks, addRows, finishOps, foldByOperator, INDEX_URL };
