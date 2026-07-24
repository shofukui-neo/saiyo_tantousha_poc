'use strict';
/**
 * 新規マイナビ収集(recruiter-mynavi-new28.csv) → consolidated-allスキーマ写像
 * ============================================================================
 * qualifies(名+電話+新卒6名+従業員100-2000+非代表)を満たし、かつ pool/台帳に
 * 社名で載っていない「完全新規」だけを consolidated スキーマに写像して出力する。
 * 出力は format-bales.js が --scope callable --icp-only でそのまま消費できる。
 */
const P = require('path');
const fs = require('fs');
const R = (p) => require(P.join(__dirname, p));
const { readCsv, toCsv } = R('src/csv');
const { createMatchIndex } = R('src/company-match');
const { loadLedger, isDelivered } = R('src/delivered-ledger');
const { qualifiesForList, proposalTier, isExcludedIndustry } = R('src/icp-rules');

// 複数のマイナビ収集ファイルを統合（gy=27 + gy=28）。存在するものだけ読む。
const IN_FILES = (process.env.HARVEST_INS || 'recruiter-mynavi-probe27.csv,recruiter-mynavi-new28.csv')
  .split(',').map((s) => s.trim()).filter(Boolean).map((f) => P.join(__dirname, 'data', f));
const OUT = P.join(__dirname, 'data', 'leads-new-mynavi-mapped.csv');
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());
const intOf = (s) => { const m = String(s || '').replace(/[^0-9]/g, ''); return m ? parseInt(m, 10) : null; };
const REP = /代表|社長|会長|取締役|理事長|監査役|オーナー|創業|CEO|COO|CFO|President|Founder/i;

// 氏名クリーニング（format-bales.js と同一ロジック）
const NON_NAME_WHOLE_RE = /^(窓口|ご担当|担当者|採用担当|人事担当|総務担当|人事|総務|受付|不明|なし|未定|未記入|御中|担当)$/;
const NAME_JUNK_TOKEN_RE = /^(が|を|は|に|へ|と|の|も|で)?(聞く|聞き|問い合わせ|問合せ|について|に関する|宛|より|御中|窓口|係|様|さん|氏|殿)$/;
function cleanRecruiterName(name) {
  let n = String(name || '').replace(/　/g, ' ').trim();
  if (!n) return '';
  if (NON_NAME_WHOLE_RE.test(n)) return '';
  const toks = n.split(/\s+/).filter(Boolean).filter((t) => !NAME_JUNK_TOKEN_RE.test(t));
  n = toks.join(' ').trim();
  if (!n || NON_NAME_WHOLE_RE.test(n)) return '';
  return n;
}

const HEADERS = ['企業名', '法人番号', '採用担当者名', '氏名検証', '担当者確度', '役職', '部署', '代表者名', '架電宛名', '電話番号', 'メール', 'メール確度', '公式URL', '業種', '都道府県', '従業員数', '設立年', '補助金', '上場', '新卒フラグ', '採用予定人数', '採用職種', '掲載媒体', '求人件数', '採用ページURL', 'アポ期待度', '優先度', 'MOCHICA適合', '確信度', '提案プラン', 'セグメント区分', 'ICPランク', '既存被り', '呼べる条件', '根拠URL', '取得日', '統合ソース数', '統合元ファイル'];

function main() {
  const idx = createMatchIndex();
  for (const r of readCsv(fs.readFileSync(P.join(__dirname, 'data/leads-consolidated-all.csv'), 'utf8')).records) idx.addRecord(r, 'pool');
  const ledger = loadLedger();
  const inPool = (name) => idx.has(name) || isDelivered(ledger, { 企業名: name });

  const records = [];
  for (const f of IN_FILES) {
    if (!fs.existsSync(f)) { console.log('  (入力なし・スキップ)', P.relative(__dirname, f)); continue; }
    const rs = readCsv(fs.readFileSync(f, 'utf8')).records;
    console.log('  入力', P.relative(__dirname, f), rs.length, '件');
    for (const r of rs) records.push(r);
  }
  if (!records.length) { console.error('入力レコードなし'); process.exit(1); }
  const out = [];
  const seenName = new Set();
  let dropQual = 0, dropPool = 0, dropDup = 0, dropName = 0;
  for (const r of records) {
    const name = g(r, '企業名'); if (!name) continue;
    const recruiter = cleanRecruiterName(g(r, '採用担当者名'));
    if (!recruiter) { dropName++; continue; }
    const phone = g(r, '電話番号');
    const hire = intOf(g(r, '採用予定人数'));
    const emp = intOf(g(r, '従業員数'));
    const pos = g(r, '役職');
    // ICP絶対条件
    const q = qualifiesForList({ contactName: recruiter, phone, hire, emp, industry: '' });
    if (!q.pass) { dropQual++; continue; }
    if (REP.test(pos)) { dropQual++; continue; } // 代表者名の流用除外
    // 完全新規（pool/台帳になし）
    if (inPool(name)) { dropPool++; continue; }
    const nk = name.replace(/\s+/g, '').toLowerCase();
    if (seenName.has(nk)) { dropDup++; continue; }
    seenName.add(nk);

    const tier = proposalTier(emp);
    const rec = {};
    for (const h of HEADERS) rec[h] = '';
    rec['企業名'] = name;
    rec['採用担当者名'] = recruiter;
    rec['担当者確度'] = g(r, '担当者確度');
    rec['役職'] = pos;
    rec['部署'] = g(r, '部署');
    rec['架電宛名'] = (g(r, '部署') + (pos ? ' ' + pos : '') + ' ' + recruiter + ' 様').trim();
    rec['電話番号'] = phone;
    rec['メール'] = g(r, 'メール');
    rec['公式URL'] = g(r, '採用ページURL');
    rec['従業員数'] = String(emp);
    rec['新卒フラグ'] = '1';
    rec['採用予定人数'] = String(hire);
    rec['掲載媒体'] = 'マイナビ' + (g(r, '卒年') || '28');
    rec['採用ページURL'] = g(r, '採用ページURL');
    rec['提案プラン'] = tier.plan;
    rec['セグメント区分'] = tier.segment;
    rec['既存被り'] = '';
    rec['呼べる条件'] = 'OK';
    rec['根拠URL'] = g(r, '採用ページURL');
    rec['取得日'] = g(r, '取得日');
    rec['統合ソース数'] = '1';
    rec['統合元ファイル'] = 'recruiter-mynavi-new28.csv';
    out.push(rec);
  }
  fs.writeFileSync(OUT, '﻿' + toCsv(HEADERS, out), 'utf8');
  console.log(`[finalize] 入力 ${records.length}件`);
  console.log(`[finalize] 除外: 名クリーンNG ${dropName} / ICP不適合 ${dropQual} / 既存pool被り ${dropPool} / 名重複 ${dropDup}`);
  console.log(`[finalize] 完全新規ICP適合: ${out.length}件 → ${P.relative(__dirname, OUT)}`);
}
main();
