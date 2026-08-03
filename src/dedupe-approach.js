'use strict';
/**
 * リスト重複照合・クレンジング（被りなしリスト生成）
 * =====================================================================
 * 「作成したリスト」（母集団）から、3つの照合対象に載っている企業を除外し、
 * 被りのない純新規（＝アプローチ可能）リストを1本にまとめて生成する。
 *
 *   ① アプローチ禁止リスト   … 社名テキスト（旧社名・前株/後株を吸収）      → 社名一致
 *   ② MOCHICA既存顧客リスト  … 法人番号JSON配列 or 社名/法人番号つきCSV     → 法人番号→社名
 *   ③ MOCHICA SFリードリスト … SFエクスポートCSV（Company/CorporateNumber__c…）→ 法人番号→社名
 *   ④ BALES既存CRM ＋ ⑤ 納品済み台帳 … exclusion-index.js（--no-bales で無効化）
 *      ※2026-07-30 追加。実測で被りの最大発生源はBALES既存CRM（納品40社中30社）だった。
 *
 * 突合キーは company-match.js と完全に同一（索引側・照合側で同じ関数を通す）:
 *   ① 法人番号(13桁) 一致 → 確度「確実」（最優先）
 *   ② 正規化社名／農協コア（JA別称）／表記ゆれ（旧字体・長音字種・カナ⇔かな・支店）／長音ゆれ
 * 禁止リストのみ社名一致（番号を持たないため。旧社名・前株後株は ng-index.js が吸収）。
 *
 * 1件が複数リストに当たった場合、除外理由の代表は「禁止 > 既存顧客 > SFリード」の順で1つ。
 * どのリストにも当たった全ソースは「一致リスト」列に併記する（監査用）。
 *
 * 出力（元ファイルは変更しない・ドライラン安全）:
 *   --out           被りなしリスト（純新規のみ・元の列構成のまま）
 *   --out-excluded  除外明細（除外理由/一致リスト/突合確度/一致キー ＋SF3列 を付与）
 *   標準出力        サマリ（母集団件数 / 理由別 / 重複率 / 残存 / 法人番号充足率）
 *
 * 使い方:
 *   node src/dedupe-approach.js \
 *     --list leads-mochica-named-consolidated.csv \
 *     --ng data/アプローチ禁止企業一覧.txt \
 *     --customers data/existing-bango.json \
 *     --sf sources/SF-leads.csv
 *
 *   ・存在しない/未指定の照合ソースは警告のうえスキップ（禁止だけ・既存だけでも動く）。
 *   ・既存顧客/SF は後日ファイルを差し込むだけ（--customers / --sf にパス指定）。
 */

const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv, normCorpNumber, normCompanyName } = require('./csv');
const { buildNgIndex, ngHit } = require('./ng-index');
const { keysOf } = require('./company-match');
const { buildExclusionIndex } = require('./exclusion-index');

// 社名の突合キー全系統（正規化社名／農協コア／表記ゆれ／長音ゆれ）。company-match と同一定義。
// 索引側・照合側の両方で同じ関数を通すことで、片側だけ表記が違って漏れる事故を防ぐ。
function nameKeys(name) {
  const k = keysOf(String(name || ''));
  return [k.name, k.core, k.loose, k.fuzzy].filter(Boolean);
}

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !String(v).startsWith('--')) ? v : true; }
  return def;
}

const LIST_CSV  = getArg('list', 'leads-mochica-named-consolidated.csv');
const NG_FILE   = getArg('ng', 'data/アプローチ禁止企業一覧.txt');
// 既存顧客はカンマ区切りで複数指定可（社名CSV＋法人番号JSONを合算＝安全側の既定）。
const CUST_FILE = getArg('customers',
  'data/MOCHICAの既存顧客リスト - mochica-companies-list.csv,data/existing-bango.json');
const SF_FILE   = getArg('sf', 'data/セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');
const NAME_COL  = getArg('name-col', '企業名');
const CORP_COL  = getArg('corp-col', '法人番号');

const listBase  = LIST_CSV.replace(/\.csv$/i, '');
const OUT_CLEAN = getArg('out', `${listBase}-clean.csv`);
const OUT_EXCL  = getArg('out-excluded', `${listBase}-excluded.csv`);

function resolveP(fp) { return path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp); }
function exists(fp) { return fp && fs.existsSync(resolveP(fp)); }
function readText(fp) { return fs.readFileSync(resolveP(fp), 'utf8'); }
function writeBom(fp, headers, recs) {
  fs.writeFileSync(resolveP(fp), '﻿' + toCsv(headers, recs).replace(/\n/g, '\r\n'), 'utf8');
}

// レコード（CSV由来 or JSONオブジェクト）から論理項目を、列名揺れを吸収して取り出す
const NAME_CANDS = ['企業名', '会社名', '会社', '取引先名', '会社名/取引先名', '会社名/取引先',
  '企業名/取引先名', '法人名', 'LINEアカウント登録企業名', 'Company', 'company', 'CompanyName', 'name'];
const CORP_CANDS = ['法人番号', 'CorporateNumber__c', '法人番号__c', 'Corporate Number',
  'corporate_number', 'corpNumber', '法人番号(13桁)', '法人番号（13桁）'];

// ヘッダ名の表記揺れ吸収（空白除去・小文字化）。'会社名 / 取引先'→'会社名/取引先'、'リード 状況'→'リード状況'
function normHeader(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }

// 候補列を優先順で探して値を返す（列名の空白揺れを吸収）
function pick(rec, cands) {
  const keys = Object.keys(rec);
  for (const cand of cands) {
    const nc = normHeader(cand);
    for (const k of keys) {
      if (normHeader(k) === nc) {
        const v = rec[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
    }
  }
  return '';
}

// プリアンブル付きCSV（SFレポート等）からヘッダ行を自動検出して {headers, records} を返す。
// wantCands のいずれかを含む最初の行をヘッダとみなし、それ以前（レポートのタイトル/日時/条件）は捨てる。
function readCsvSmart(text, wantCands) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [], headerRow: -1 };
  const want = wantCands.map(normHeader);
  let hi = 0;
  for (let i = 0; i < rows.length; i++) {
    const norm = rows[i].map(normHeader);
    if (want.some((w) => norm.includes(w))) { hi = i; break; }
  }
  const headers = rows[hi].map((h) => String(h).trim());
  const records = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const rec = {};
    headers.forEach((h, j) => { rec[h] = rows[i][j] != null ? rows[i][j] : ''; });
    records.push(rec);
  }
  return { headers, records, headerRow: hi };
}

// ---- ② 既存顧客リストの索引化（JSON配列 or CSV を自動判定・複数ファイル合算可）----
//   戻り: { byCorp:Set<13桁>, byName:Set<正規化社名>, raw:件数, hasName:社名索引が有効か, files:[] }
function buildCustomerIndex(files) {
  const byCorp = new Set();
  const byName = new Set();
  const used = [];
  let raw = 0;
  for (const fp of files) {
    if (!exists(fp)) continue;
    used.push(fp);
    if (/\.json$/i.test(fp)) {
      const arr = JSON.parse(readText(fp));
      for (const item of Array.isArray(arr) ? arr : []) {
        raw++;
        if (typeof item === 'string' || typeof item === 'number') {
          // 文字列/数値 … 13桁なら法人番号、それ以外は社名として扱う
          const cn = normCorpNumber(item);
          if (cn) byCorp.add(cn);
          else for (const k of nameKeys(item)) byName.add(k);
        } else if (item && typeof item === 'object') {
          const cn = normCorpNumber(pick(item, CORP_CANDS));
          if (cn) byCorp.add(cn);
          for (const k of nameKeys(pick(item, NAME_CANDS))) byName.add(k);
        }
      }
    } else {
      const { records } = readCsvSmart(readText(fp), NAME_CANDS.concat(CORP_CANDS));
      for (const r of records) {
        raw++;
        const cn = normCorpNumber(pick(r, CORP_CANDS));
        if (cn) byCorp.add(cn);
        for (const k of nameKeys(pick(r, NAME_CANDS))) byName.add(k);
      }
    }
  }
  return { byCorp, byName, raw, hasName: byName.size > 0, files: used };
}

// ---- ③ SFリードリストの索引化（法人番号 / 正規化社名）----
//   SF状態・所有者・リードIDも保持し、除外明細に注記できるようにする。
const SF_STATUS_CANDS = ['Status', 'リード状態', '状態', 'リードステータス', 'リード状況', 'リード 状況'];
const SF_OWNER_CANDS  = ['Owner.Name', 'Owner', 'リード所有者', '所有者', '所有者名', 'リード所有者名'];
const SF_ID_CANDS     = ['Id', 'リードID', 'Lead ID', 'リード ID', 'リードID18'];
function buildSfIndex(fp) {
  const byCorp = new Map();
  const byName = new Map();
  let raw = 0, withCorp = 0;
  // SFレポートは先頭にタイトル/日時/条件のメタ行が入る → ヘッダを自動検出
  const { records } = readCsvSmart(readText(fp), NAME_CANDS.concat(SF_ID_CANDS));
  for (const r of records) {
    const company = pick(r, NAME_CANDS);
    // 末尾の集計行（会社名列が数値のみ／IDが「合計」等）はスキップ
    if (!company || /^\d+$/.test(company) || pick(r, SF_ID_CANDS) === '合計') continue;
    raw++;
    const slim = {
      id: pick(r, SF_ID_CANDS),
      company,
      status: pick(r, SF_STATUS_CANDS),
      owner: pick(r, SF_OWNER_CANDS),
    };
    const cn = normCorpNumber(pick(r, CORP_CANDS));
    if (cn) { byCorp.set(cn, slim); withCorp++; }
    for (const k of nameKeys(company)) if (!byName.has(k)) byName.set(k, slim);
  }
  return { byCorp, byName, raw, withCorp, hasCorp: withCorp > 0 };
}

// ---- 母集団1行を各ソースと突合。全ヒットを集め、代表理由を1つ決める ----
// 戻り: { hits:[{source,conf,key,sf?}], primary:hit|null }
function matchRow(name, corp, ctx) {
  const cn = normCorpNumber(corp);
  const nks = nameKeys(name); // 正規化社名／農協コア／表記ゆれ／長音ゆれ
  const hits = [];
  const findName = (m) => { for (const k of nks) if (m.has(k)) return k; return ''; };

  // ① 禁止（社名一致のみ・旧社名/前後株は ng-index が吸収）
  if (ctx.ng) {
    const e = ngHit(name, ctx.ng);
    if (e) hits.push({ source: '禁止', conf: '社名一致', key: e.display });
  }
  // ② 既存顧客（法人番号→社名）
  if (ctx.cust) {
    const hk = findName(ctx.cust.byName);
    if (cn && ctx.cust.byCorp.has(cn)) hits.push({ source: '既存顧客', conf: '確実', key: `法人番号:${cn}` });
    else if (hk) hits.push({ source: '既存顧客', conf: '推定', key: `社名:${name}` });
  }
  // ③ SFリード（法人番号→社名）
  if (ctx.sf) {
    const hk = findName(ctx.sf.byName);
    if (cn && ctx.sf.byCorp.has(cn)) hits.push({ source: 'SFリード', conf: '確実', key: `法人番号:${cn}`, sf: ctx.sf.byCorp.get(cn) });
    else if (hk) hits.push({ source: 'SFリード', conf: '推定', key: `社名:${name}`, sf: ctx.sf.byName.get(hk) });
  }
  // ④ BALES既存CRM / ⑤ 納品済み台帳（2026-07-30 追加。被りの最大発生源はBALES既存CRMだった）
  if (ctx.extra) {
    const d = ctx.extra.matchDetail({ 企業名: name, 法人番号: corp || '' });
    if (d.matched) hits.push({ source: /台帳|納品/.test(d.label) ? '納品済み' : 'BALES既存', conf: d.tier, key: `${d.tier}:${d.master}` });
  }

  // 代表理由の優先順位: 禁止 > 既存顧客 > BALES既存 > SFリード > 納品済み
  const order = { '禁止': 0, '既存顧客': 1, 'BALES既存': 2, 'SFリード': 3, '納品済み': 4 };
  const primary = hits.length ? hits.slice().sort((a, b) => order[a.source] - order[b.source])[0] : null;
  return { hits, primary };
}

function main() {
  if (!exists(LIST_CSV)) { console.error(`✗ 母集団リストが見つかりません: ${resolveP(LIST_CSV)}`); process.exit(1); }
  const list = readCsvSmart(readText(LIST_CSV), [NAME_COL, CORP_COL, ...NAME_CANDS]);
  if (!list.headers.includes(NAME_COL)) {
    console.error(`✗ 母集団に「${NAME_COL}」列がありません。--name-col で指定してください。`);
    process.exit(1);
  }
  const hasCorpCol = list.headers.includes(CORP_COL);

  // 照合ソースを構築（無いものはスキップ）
  const ctx = { ng: null, cust: null, sf: null, extra: null };
  const skipped = [];
  if (exists(NG_FILE)) ctx.ng = buildNgIndex(readText(NG_FILE));
  else skipped.push(`禁止リスト(${NG_FILE})`);
  const custFiles = String(CUST_FILE).split(',').map((s) => s.trim()).filter(Boolean);
  if (custFiles.some(exists)) ctx.cust = buildCustomerIndex(custFiles);
  else skipped.push(`既存顧客(${CUST_FILE})`);
  if (exists(SF_FILE)) ctx.sf = buildSfIndex(SF_FILE);
  else if (SF_FILE) skipped.push(`SFリード(${SF_FILE})`);
  else skipped.push('SFリード(未指定)');
  // ④⑤ BALES既存CRM＋納品済み台帳（exclusion-index に集約）。--no-bales で無効化。
  let extraInfo = null;
  if (!process.argv.includes('--no-bales')) {
    const ex = buildExclusionIndex({ layers: ['bales', 'ledger'], quiet: true });
    ctx.extra = ex.idx;
    extraInfo = ex;
    for (const m of ex.missing) skipped.push(m);
  } else {
    skipped.push('BALES既存CRM/納品済み台帳(--no-bales)');
  }

  if (!ctx.ng && !ctx.cust && !ctx.sf && !ctx.extra) {
    console.error('✗ 照合ソースが1つもありません。--ng / --customers / --sf のいずれかを指定してください。');
    process.exit(1);
  }

  // 除外明細の追加列
  const EXTRA = ['除外理由', '一致リスト', '突合確度', '一致キー', 'SF状態', 'SF所有者', 'SFリードID'];
  const exclHeaders = [...list.headers, ...EXTRA];

  const clean = [];
  const excluded = [];
  const cnt = { 禁止: 0, 既存顧客: 0, SFリード: 0, BALES既存: 0, 納品済み: 0 };   // ソース別（重複カウントあり）
  let withCorpNum = 0;

  for (const rec of list.records) {
    const corp = hasCorpCol ? rec[CORP_COL] : '';
    if (normCorpNumber(corp)) withCorpNum++;
    const { hits, primary } = matchRow(rec[NAME_COL], corp, ctx);
    if (!primary) { clean.push(rec); continue; }

    for (const h of hits) cnt[h.source]++;
    const sfHit = hits.find((h) => h.source === 'SFリード' && h.sf);
    excluded.push({
      ...rec,
      除外理由: primary.source,
      一致リスト: hits.map((h) => h.source).join(','),
      突合確度: primary.conf,
      一致キー: primary.key,
      SF状態: sfHit ? sfHit.sf.status : '',
      SF所有者: sfHit ? sfHit.sf.owner : '',
      SFリードID: sfHit ? sfHit.sf.id : '',
    });
  }

  writeBom(OUT_CLEAN, list.headers, clean);
  writeBom(OUT_EXCL, exclHeaders, excluded);

  const total = list.records.length;
  const uniqExcl = excluded.length;
  const dupRate = total ? ((uniqExcl / total) * 100).toFixed(1) : '0.0';
  const corpRate = total ? ((withCorpNum / total) * 100).toFixed(1) : '0.0';

  console.log('==== リスト重複照合・クレンジング（被りなしリスト生成）====');
  console.log(`母集団（作成したリスト）: ${total} 件  ［法人番号あり ${withCorpNum} 件 / ${corpRate}%］`);
  console.log('---- 照合ソース ----');
  if (ctx.ng)   console.log(`  ① アプローチ禁止 : ユニーク社名 ${ctx.ng.byKey.size} 件`);
  if (ctx.cust) console.log(`  ② 既存顧客       : 法人番号 ${ctx.cust.byCorp.size} 件 / 社名 ${ctx.cust.byName.size} 件${ctx.cust.hasName ? '' : '（社名なし＝法人番号でのみ突合）'}`);
  if (ctx.sf)   console.log(`  ③ SFリード       : ${ctx.sf.raw} 件（うち法人番号あり ${ctx.sf.withCorp} 件）${ctx.sf.hasCorp ? '' : '（法人番号なし＝社名でのみ突合）'}`);
  if (extraInfo) console.log(`  ④⑤ BALES既存CRM＋納品台帳: ${Object.entries(extraInfo.stats).map(([k, v]) => `${k} ${v}`).join(' / ')}（ユニーク ${ctx.extra.size}社）`);
  if (skipped.length) console.log(`  ※ スキップ: ${skipped.join(' / ')}`);
  console.log('---- 突合結果（ソース別・重複カウントあり）----');
  if (ctx.ng)   console.log(`  ① 禁止一致     : ${cnt.禁止} 件`);
  if (ctx.cust) console.log(`  ② 既存顧客一致 : ${cnt.既存顧客} 件`);
  if (ctx.sf)   console.log(`  ③ SFリード一致 : ${cnt.SFリード} 件`);
  if (ctx.extra) console.log(`  ④ BALES既存一致: ${cnt.BALES既存} 件\n  ⑤ 納品済み一致 : ${cnt.納品済み} 件`);
  console.log('---- 集計 ----');
  console.log(`  重複除外（ユニーク）: ${uniqExcl} 件（重複率 ${dupRate}%）`);
  console.log(`  被りなし（純新規）  : ${clean.length} 件`);
  console.log('---- 出力 ----');
  console.log(`  被りなしリスト : ${resolveP(OUT_CLEAN)}`);
  console.log(`  除外明細       : ${resolveP(OUT_EXCL)}`);
}

main();
