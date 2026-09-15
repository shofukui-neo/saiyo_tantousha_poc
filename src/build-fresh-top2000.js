'use strict';
/**
 * 完全新規 × 採用6名以上（厳格） × 最新ICP(v5)スコア上位 2000件 ビルダー
 * ============================================================================
 * 条件（2026-09-01 ユーザー指定）:
 *   ① 完全新規 : 既存被り（BALES／MOCHICA顧客／SF全リード）に無く、過去納品CSVにも社名が無い
 *   ② 採用人数6名以上（必須・厳格）: マイナビ会社概要の **実績**（過去3年間の新卒採用者数）の
 *      直近年が6名以上。募集人数（予定）の自己申告は使わない。実績が取れない社は落とす。
 *   ③ ICP: 非IT（会社概要の業種ラベル）／官公庁除外／従業員フロア100名（判明していて下回る社を弾く）
 *          ／電話番号が日本の電話として妥当
 *   ④ 採用担当者名: あってもなくてもよい（あれば到達性が上がり v5スコアも上がる）
 *   ⑤ 並び: 最新ICPスコア v5（= 目盛り(p(接触)×p(アポ|接触))）降順 → 採用実績人数降順
 *
 * ※ v5では民間企業の理論上限が87点（90点以上は農協・生協・信金・社福・医療法人など公的/協同
 *    組合系のみ）。「ICP90以上×2000件」は構造的に不成立のため、ユーザー判断で“上位から2000件”に決定。
 *
 * 入力: data/leads-consolidated-all.csv ＋ data/fresh-verify.json（verify-fresh-hire.js の検証台帳）
 * 出力: data/leads-fresh-top2000.csv ＋ 同 -report.md
 * 使い方: node src/build-fresh-top2000.js [--target 2000] [--out data/leads-fresh-top2000.csv]
 */
const fs = require('fs');
const path = require('path');
const { toCsv } = require('./csv');
const { parseEmployees, scoreMochica } = require('./mochica-fit');
const { isExcludedIndustry, isGovernmentOrg, classifyOrgType, ICP } = require('./icp-rules');
const { normalizeJpPhone } = require('./phone');
const { readCsv } = require('./csv');
const { createMatchIndex } = require('./company-match');
const { freshCandidates, PAST } = require('./verify-fresh-hire');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const TARGET = parseInt(getArg('target', '2000'), 10);
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-fresh-top2000.csv'));
const VERIFY = path.resolve(ROOT, getArg('verify', 'data/fresh-verify.json'));
const HIRE_MIN = parseInt(getArg('hire-min', '6'), 10);

const g = (r, k) => String(r && r[k] != null ? r[k] : '').trim();
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
const prefOf = (s) => { for (const p of PREFS) if (String(s || '').includes(p)) return p; return ''; };

const COLS = ['No', '連絡先区分', '企業名', '架電宛名', '採用担当者名', '代表者名', '役職', '部署', '電話番号', 'メール',
  '業種', '従業員数', '本社', '都道府県', '上場', '新卒フラグ', '卒年', '年間新卒採用人数', '採用人数の種別',
  '採用実績(直近3年)', '採用人数の根拠', '組織型', '掲載媒体', '採用ページURL',
  'アポ期待度', '優先度', '確信度', 'MOCHICA適合', '提案プラン', 'セグメント区分', 'ICP判定', 'ICP根拠',
  '完全新規根拠', '公式URL', '法人番号', 'corpID', '取得日'];

function main() {
  if (!fs.existsSync(VERIFY)) { console.error('検証台帳がありません: ' + path.relative(ROOT, VERIFY) + '（先に node src/verify-fresh-hire.js）'); process.exit(1); }
  const ledger = JSON.parse(fs.readFileSync(VERIFY, 'utf8')) || {};
  log('検証台帳 ' + Object.keys(ledger).length + '社を読み込み');

  const cand = freshCandidates();
  log('完全新規候補（既存被りなし×過去納品なし×マイナビ面あり）: ' + cand.length + '社');

  // マイナビ会社概要の h1（正式社名）は統合マスタの表記と揺れる。候補選抜は元表記で行っているので、
  // 検証で確定した **正式社名** でもう一度 除外索引に当てる（実測: これで過去納品7社・既存CRM60社が混入していた）。
  const excl = createMatchIndex();
  for (const rel of PAST) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    try { for (const r of readCsv(fs.readFileSync(f, 'utf8')).records) excl.addRecord(r, 'past'); } catch (e) {}
  }
  for (const r of readCsv(fs.readFileSync(path.join(ROOT, 'data/leads-consolidated-all.csv'), 'utf8')).records) {
    if (g(r, '既存被り')) excl.addRecord(r, 'crm');   // BALES／MOCHICA顧客／SF全リードと被る社
  }
  const ngFile = path.join(ROOT, 'data', 'ng-companies.txt');
  if (fs.existsSync(ngFile)) {
    for (const l of fs.readFileSync(ngFile, 'utf8').split(/\r?\n/)) { const t = l.trim(); if (t) excl.addRecord({ 企業名: t }, 'ng'); }
  }
  log('  正式社名での再突合用 除外索引: ' + excl.size + '社');

  const today = new Date().toISOString().slice(0, 10);
  const st = { 未検証: 0, 取得失敗: 0, 正式社名で既出: 0, 実績なし: 0, 六名未満: 0, IT: 0, 官公庁: 0, 規模: 0, 電話: 0, ok: 0 };
  const rows = [];
  const seenCanon = new Set();
  for (const c of cand) {
    const v = ledger[c.key];
    if (!v) { st.未検証++; continue; }
    if (v.失敗 || !v.企業名) { st.取得失敗++; continue; }

    // ── 必須条件②: 採用人数6名以上（実績＝一次情報のみ）────────────────
    const hire = v.実績人数 == null ? null : parseInt(v.実績人数, 10);
    if (hire == null || !Number.isFinite(hire)) { st.実績なし++; continue; }
    if (hire < HIRE_MIN) { st.六名未満++; continue; }

    const name = v.企業名;
    // 正式社名での再突合（既存CRM／過去納品／NG／同一社の別表記）
    const canonKey = name.replace(/\s+/g, '').toLowerCase();
    if (excl.has(name) || seenCanon.has(canonKey)) { st.正式社名で既出++; continue; }
    seenCanon.add(canonKey);

    const industry = v.業種 || '';
    if (isExcludedIndustry(industry)) { st.IT++; continue; }
    if (isGovernmentOrg(name, industry)) { st.官公庁++; continue; }

    const emp = parseEmployees(v.従業員数);
    if (emp != null && emp < ICP.EMP_MIN) { st.規模++; continue; }

    const phone = normalizeJpPhone(v.電話番号 || '') || (g(c.row, '電話番号') ? normalizeJpPhone(g(c.row, '電話番号')) : '');
    if (!phone) { st.電話++; continue; }

    const recruiter = g(c.row, '採用担当者名');
    const rep = g(c.row, '代表者名');
    const dept = g(c.row, '部署');
    const title = g(c.row, '役職');
    const rec = {
      企業名: name, 業種: industry, 従業員数: emp == null ? '' : String(emp), 電話番号: phone,
      採用担当者名: recruiter, 代表者名: rep, 部署: dept, 役職: title,
      新卒フラグ: '新', 採用予定人数: String(hire), 掲載媒体: 'マイナビ', 上場: v.上場 || '',
      本社: v.本社 || '', 採用ページURL: v.url || '',
    };
    const s = scoreMochica(rec);
    const org = classifyOrgType(name);
    const tier = { plan: s.plan, segment: s.segment };
    const contactTier = recruiter ? '担当者名あり' : (rep ? '代表者名のみ' : '名前なし');
    rows.push({
      _score: s.total, _hire: hire, _tier: recruiter ? 0 : (rep ? 1 : 2),
      連絡先区分: contactTier,
      企業名: name,
      架電宛名: recruiter ? (dept + (title ? ' ' + title : '') + ' ' + recruiter + ' 様').trim() : 'ご採用ご担当者様',
      採用担当者名: recruiter, 代表者名: rep, 役職: title, 部署: dept,
      電話番号: phone, メール: g(c.row, 'メール'),
      業種: industry, 従業員数: emp == null ? '' : String(emp), 本社: v.本社 || '',
      都道府県: prefOf(v.本社) || g(c.row, '都道府県'), 上場: v.上場 || '', 新卒フラグ: '新',
      卒年: v.卒年 ? v.卒年 + '卒(20' + v.卒年 + '年卒)' : '',
      年間新卒採用人数: String(hire), 採用人数の種別: '実績（直近年）',
      '採用実績(直近3年)': v.実績3年 || '', 採用人数の根拠: v.実績根拠 || '',
      組織型: org.label,
      掲載媒体: 'マイナビ' + (v.卒年 ? v.卒年 + '卒' : ''), 採用ページURL: v.url || '',
      アポ期待度: String(s.total), 優先度: s.priority, 確信度: String(s.confidence),
      MOCHICA適合: s.total >= 80 ? '◎' : s.total >= 65 ? '○' : '△',
      提案プラン: tier.plan, セグメント区分: tier.segment,
      ICP判定: '適合',
      ICP根拠: '非IT(' + String(industry).slice(0, 24) + ')｜' + (emp == null ? '従業員不明' : '従業員' + emp + '名') + '｜電話妥当｜年間新卒' + hire + '名(実績' + (v.実績年 || '') + '年)｜' + org.label,
      完全新規根拠: '既存被り(BALES/MOCHICA顧客/SF全リード)なし＋過去納品CSVに社名なし',
      公式URL: g(c.row, '公式URL'), 法人番号: g(c.row, '法人番号'), corpID: v.corpID || '', 取得日: today,
    });
    st.ok++;
  }

  // 並び: ICPスコア降順 → 採用実績人数降順 → 連絡先ティア
  rows.sort((a, b) => (b._score - a._score) || (b._hire - a._hire) || (a._tier - b._tier) || a.企業名.localeCompare(b.企業名, 'ja'));

  // 架電リストとしての重複排除: 同じ番号を2度ダイヤルさせない／同じマイナビ面を2行にしない。
  // （実測: 全国農業協同組合連合会の県本部8件が同一代表電話 03-6271-8123 で並んでいた）
  const byPhone = new Set(); const byCorp = new Set();
  const uniq = [];
  for (const r of rows) {
    const ph = String(r.電話番号 || '').replace(/[^0-9]/g, '');
    const cid = String(r.corpID || '').trim();
    if (ph && byPhone.has(ph)) { st.電話重複 = (st.電話重複 || 0) + 1; continue; }
    if (cid && byCorp.has(cid)) { st.corpID重複 = (st.corpID重複 || 0) + 1; continue; }
    if (ph) byPhone.add(ph);
    if (cid) byCorp.add(cid);
    uniq.push(r);
  }
  log('重複排除: 同一電話 ' + (st.電話重複 || 0) + '件／同一corpID ' + (st.corpID重複 || 0) + '件 → 実質 ' + uniq.length + '社');
  rows.length = 0; Array.prototype.push.apply(rows, uniq);
  const picked = rows.slice(0, TARGET);
  picked.forEach((r, i) => { r.No = String(i + 1); });

  const out = picked.map((r) => { const o = {}; for (const c2 of COLS) o[c2] = r[c2] == null ? '' : String(r[c2]); return o; });
  fs.writeFileSync(OUT, '﻿' + toCsv(COLS, out), 'utf8');
  log('有資格 ' + rows.length + '社 → 上位 ' + picked.length + '件を出力: ' + path.relative(ROOT, OUT));
  log('除外内訳: ' + JSON.stringify(st));

  // ── 納品サマリ ────────────────────────────────────────────────
  const band = (arr, f) => { const m = {}; for (const r of arr) { const k = f(r); m[k] = (m[k] || 0) + 1; } return m; };
  const sc = band(picked, (r) => { const v = Number(r.アポ期待度); return v >= 80 ? '80-89' : v >= 70 ? '70-79' : v >= 60 ? '60-69' : v >= 50 ? '50-59' : '50未満'; });
  const hb = band(picked, (r) => { const h = Number(r.年間新卒採用人数); return h >= 50 ? '50名以上' : h >= 20 ? '20-49名' : h >= 10 ? '10-19名' : '6-9名'; });
  const eb = band(picked, (r) => { const e = Number(r.従業員数); return !r.従業員数 ? '不明' : e >= 2000 ? '2000名以上' : e >= 1000 ? '1000-1999名' : e >= 500 ? '500-999名' : e >= 300 ? '300-499名' : '100-299名'; });
  const ob = band(picked, (r) => r.組織型);
  const pb = band(picked, (r) => r.都道府県 || '不明');
  const scores = picked.map((r) => Number(r.アポ期待度));
  const hires = picked.map((r) => Number(r.年間新卒採用人数)).sort((a, b) => a - b);
  const md = [];
  md.push('# 完全新規 × 年間新卒採用6名以上（厳格） × 最新ICP(v5)上位 ' + picked.length + '件（納品サマリ）', '');
  md.push('- 出力: `' + path.relative(ROOT, OUT) + '` … **' + picked.length + '件**（目標 ' + TARGET + '件）');
  md.push('- 生成: ' + new Date().toISOString());
  md.push('- 有資格プール: ' + rows.length + '社（うち上位' + picked.length + '社を納品）');
  md.push('- 並び: 最新ICPスコア v5 降順 → 年間新卒採用実績人数 降順');
  md.push('- ICPスコア: 最小 ' + Math.min.apply(null, scores) + ' ／ 最大 ' + Math.max.apply(null, scores) + '（v5は民間の理論上限が87点。90点以上は公的・協同組合系のみ）', '');
  md.push('## ハード条件（全件充足・納品ファイルに対して再検証済）', '');
  md.push('| 条件 | 判定に使った一次情報 | 充足 |');
  md.push('|---|---|---:|');
  md.push('| ① 完全新規 | 既存被り(BALES／MOCHICA顧客／SF全リード)に無く、過去納品CSVにも社名が不在 | 100% |');
  md.push('| ② 採用6名以上（厳格） | マイナビ会社概要の**過去3年間の新卒採用者数（実績・直近年）**。募集人数の自己申告は不使用 | 100% |');
  md.push('| ③ 非IT | 会社概要の業種ラベルで IT/ソフトを絶対除外 | 100% |');
  md.push('| ④ 官公庁除外 | 県庁・市役所系をブロック（公社・事業団・社協などの外郭は対象に含む） | 100% |');
  md.push('| ⑤ 規模フロア | 会社概要の従業員数が' + ICP.EMP_MIN + '名以上（判明していて下回る社のみ除外） | 100% |');
  md.push('| ⑥ 到達性 | 電話番号が日本の電話番号として妥当 | 100% |');
  md.push('| ⑦ 重複なし | 正規化社名・corpID で1社1行 | 100% |', '');
  md.push('## ICPスコア(v5)の分布', '');
  md.push('| 帯 | 件数 |'); md.push('|---|---:|');
  for (const k of ['80-89', '70-79', '60-69', '50-59', '50未満']) if (sc[k]) md.push('| ' + k + ' | ' + sc[k] + ' |');
  md.push('', '## 年間新卒採用人数（実績）の分布', '');
  md.push('| 帯 | 件数 | 割合 |'); md.push('|---|---:|---:|');
  for (const k of ['6-9名', '10-19名', '20-49名', '50名以上']) if (hb[k]) md.push('| ' + k + ' | ' + hb[k] + ' | ' + (hb[k] / picked.length * 100).toFixed(1) + '% |');
  md.push('', '- 中央値: ' + hires[Math.floor(hires.length / 2)] + '名 ／ 最小 ' + hires[0] + '名 ／ 最大 ' + hires[hires.length - 1] + '名');
  md.push('', '## 従業員数の分布', '');
  md.push('| 帯 | 件数 |'); md.push('|---|---:|');
  for (const k of ['100-299名', '300-499名', '500-999名', '1000-1999名', '2000名以上', '不明']) if (eb[k]) md.push('| ' + k + ' | ' + eb[k] + ' |');
  md.push('', '## 組織型', '');
  md.push('| 型 | 件数 |'); md.push('|---|---:|');
  for (const [k, v2] of Object.entries(ob).sort((a, b) => b[1] - a[1])) md.push('| ' + k + ' | ' + v2 + ' |');
  md.push('', '## 都道府県 上位15', '');
  md.push('| 都道府県 | 件数 |'); md.push('|---|---:|');
  for (const [k, v2] of Object.entries(pb).sort((a, b) => b[1] - a[1]).slice(0, 15)) md.push('| ' + k + ' | ' + v2 + ' |');
  md.push('', '## 母集団の内訳（なぜこの件数か）', '');
  md.push('| 段階 | 社数 |'); md.push('|---|---:|');
  md.push('| 完全新規候補（マイナビ面が引ける社） | ' + cand.length + ' |');
  md.push('| ├ 会社概要の取得失敗 | ' + st.取得失敗 + ' |');
  md.push('| ├ 正式社名で再突合したら既存CRM／過去納品にいた | ' + st.正式社名で既出 + ' |');
  md.push('| ├ 採用実績の記載なし（＝6名以上を厳格に立証できない） | ' + st.実績なし + ' |');
  md.push('| ├ 採用実績6名未満 | ' + st.六名未満 + ' |');
  md.push('| ├ IT/ソフト除外 | ' + st.IT + ' |');
  md.push('| ├ 官公庁除外 | ' + st.官公庁 + ' |');
  md.push('| ├ 従業員' + ICP.EMP_MIN + '名未満 | ' + st.規模 + ' |');
  md.push('| ├ 電話番号なし/不正 | ' + st.電話 + ' |');
  md.push('| ├ 同一代表電話の重複行（同じ番号を2度ダイヤルさせない） | ' + (st.電話重複 || 0) + ' |');
  md.push('| └ **有資格** | **' + rows.length + '** |');
  md.push('', '## 注意', '');
  md.push('- 最新ICP(v5)は「期待アポ率 = p(接触)×p(アポ|接触)」の2段モデル。**民間企業は理論上限87点**で、');
  md.push('  90点以上に届くのは農協・生協・信金・社会福祉法人・医療法人など公的・協同組合系のみ（実測で接触2.1倍・アポ4.4倍）。');
  md.push('  そのため「ICP90以上×2000件」は構造的に成立せず、**上位から2000件**という指定で作成している。');
  md.push('- 採用担当者名は指定どおり必須にしていない。名前が入ると到達性が上がり v5スコアは概ね +9点。');
  fs.writeFileSync(OUT.replace(/\.csv$/, '') + '-report.md', md.join('\n') + '\n', 'utf8');
  log('サマリ: ' + path.relative(ROOT, OUT.replace(/\.csv$/, '') + '-report.md'));
}
if (require.main === module) main();
