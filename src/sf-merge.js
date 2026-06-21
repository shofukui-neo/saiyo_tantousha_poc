'use strict';
// Salesforce 連携 Track A（接続不要）: SFからエクスポートしたLead CSVと、
// 自前リスト(MASTER_HEADERS形式)を法人番号/正規化社名で突合する。
//
//  - 接続も認証も不要。SF画面の「レポート/リストビュー → エクスポート(CSV)」で
//    落としたファイルをそのまま食わせる。
//  - 突合キーは csv.js の名寄せ基盤と完全に同一:
//      ① 法人番号(13桁) を最優先 → 一致は「確実」
//      ② 無ければ正規化社名     → 一致は「推定」
//    SF側に法人番号列が無い/自前側に無い、という非対称も両インデックスで吸収する。
//  - 出力2本:
//      --out-new       : SF未登録の「純新規」だけ（重複除外済み）
//      --out-annotated : 全件 + SF三列(SFリードID/SF状態/SF所有者) + 突合確度
//
//  使い方:
//    node src/sf-merge.js --sf sources/SF-leads.csv --list leads-daihyou-1000.csv \
//      --out-new leads.new-only.csv --out-annotated leads.sf-annotated.csv
//
//  SFエクスポートCSVのヘッダは組織ロケール依存。英語/日本語の代表的な列名を
//  自動判定する(下の SF_COLMAP)。想定外の列名は --map で上書きできる(後日)。

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { readCsv, toCsv, normCorpNumber, normCompanyName } = require('./csv');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !String(v).startsWith('--')) ? v : true; }
  return def;
}

const SF_CSV   = getArg('sf', 'sources/SF-leads.csv');
const LIST_CSV  = getArg('list', 'leads-daihyou-1000.csv');
const OUT_NEW   = getArg('out-new', 'leads.new-only.csv');
const OUT_ANNO  = getArg('out-annotated', 'leads.sf-annotated.csv');

// SFエクスポート列名 → 内部キー。複数候補(英語API名/日本語表示名)を許容。
const SF_COLMAP = {
  id:       ['Id', 'リードID', 'Lead ID', 'リード ID'],
  company:  ['Company', '会社名', '会社', '会社名/取引先名'],
  corpnum:  ['CorporateNumber__c', '法人番号', 'Corporate Number', '法人番号__c'],
  status:   ['Status', 'リード状態', '状態', 'リードステータス'],
  owner:    ['Owner.Name', 'Owner', 'リード所有者', '所有者', '所有者名', 'リード所有者名'],
};

// SFレコードから論理項目を取り出す(列名揺れ吸収)
function sfGet(rec, logical) {
  for (const cand of SF_COLMAP[logical]) {
    if (rec[cand] != null && String(rec[cand]).trim() !== '') return String(rec[cand]).trim();
  }
  return '';
}

function loadCsvFile(fp) {
  const abs = path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp);
  if (!fs.existsSync(abs)) {
    console.error(`✗ ファイルが見つかりません: ${abs}`);
    process.exit(1);
  }
  return readCsv(fs.readFileSync(abs, 'utf8'));
}

// ---- SF Lead を2系統でインデックス化(法人番号 / 正規化社名) ----
function indexSfLeads(sfRecords) {
  const byCorp = new Map(); // 13桁法人番号 -> {id,company,status,owner}
  const byName = new Map(); // 正規化社名     -> 同上
  let withCorp = 0;
  for (const r of sfRecords) {
    const slim = {
      id: sfGet(r, 'id'),
      company: sfGet(r, 'company'),
      status: sfGet(r, 'status'),
      owner: sfGet(r, 'owner'),
    };
    const cn = normCorpNumber(sfGet(r, 'corpnum'));
    if (cn) { byCorp.set(cn, slim); withCorp++; }
    const nm = normCompanyName(slim.company);
    if (nm && !byName.has(nm)) byName.set(nm, slim);
  }
  return { byCorp, byName, withCorp };
}

// 自前リスト1行をSFと突合 → {hit, conf, sf}
function matchOne(rec, idx) {
  const cn = normCorpNumber(rec['法人番号']);
  if (cn && idx.byCorp.has(cn)) return { hit: true, conf: '確実', sf: idx.byCorp.get(cn) };
  const nm = normCompanyName(rec['企業名']);
  if (nm && idx.byName.has(nm)) return { hit: true, conf: '推定', sf: idx.byName.get(nm) };
  return { hit: false, conf: '', sf: null };
}

function main() {
  const sf = loadCsvFile(SF_CSV);
  const list = loadCsvFile(LIST_CSV);
  const idx = indexSfLeads(sf.records);

  const annoHeaders = [...cfg.MASTER_HEADERS, 'SF突合', 'SFリードID', 'SF状態', 'SF所有者'];
  const annotated = [];
  const newOnly = [];
  let matched = 0, byCorp = 0, byName = 0;

  for (const rec of list.records) {
    const m = matchOne(rec, idx);
    const out = { ...rec };
    if (m.hit) {
      matched++;
      if (m.conf === '確実') byCorp++; else byName++;
      out['SF突合'] = m.conf;
      out['SFリードID'] = m.sf.id;
      out['SF状態'] = m.sf.status;
      out['SF所有者'] = m.sf.owner;
    } else {
      out['SF突合'] = 'なし';
      out['SFリードID'] = out['SF状態'] = out['SF所有者'] = '';
      newOnly.push(rec); // 純新規は元の列構成のまま出す
    }
    annotated.push(out);
  }

  // BOM+CRLF で Excel 日本語の文字化け回避(master-io と同じ流儀)
  const writeBom = (fp, headers, recs) =>
    fs.writeFileSync(path.resolve(process.cwd(), fp), '﻿' + toCsv(headers, recs).replace(/\n/g, '\r\n'), 'utf8');

  writeBom(OUT_NEW, cfg.MASTER_HEADERS, newOnly);
  writeBom(OUT_ANNO, annoHeaders, annotated);

  const total = list.records.length;
  const dupRate = total ? ((matched / total) * 100).toFixed(1) : '0.0';
  console.log('==== Salesforce 突合 (Track A / 接続不要) ====');
  console.log(`SF Lead入力      : ${sf.records.length} 件 (うち法人番号あり ${idx.withCorp} 件)`);
  if (idx.withCorp === 0) {
    console.log('  ⚠ SF側に法人番号列が無い → 社名正規化のみで突合(精度は「推定」止まり)。');
    console.log('    SFに法人番号カスタム項目があればエクスポート列に加えると確度が上がる。');
  }
  console.log(`自前リスト入力   : ${total} 件`);
  console.log(`SF既存と一致     : ${matched} 件 (重複率 ${dupRate}%)`);
  console.log(`  ├ 確実(法人番号一致): ${byCorp} 件`);
  console.log(`  └ 推定(社名一致)    : ${byName} 件`);
  console.log(`純新規(SF未登録) : ${newOnly.length} 件`);
  console.log('---- 出力 ----');
  console.log(`新規のみ   : ${path.resolve(process.cwd(), OUT_NEW)}`);
  console.log(`全件+SF注記: ${path.resolve(process.cwd(), OUT_ANNO)}`);
}

main();
