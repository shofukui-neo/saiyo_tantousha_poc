'use strict';
/**
 * SF MOCHICA参照リスト「採用担当者がわからない」社の 採用担当者名 収集 → 新規リスト化
 * =====================================================================
 * セールスフォースMOCHICA参照（全リード）には「姓」列があるが、その約4割は
 *   「担当者」「採用担当者」「[未指定]」「[[Unknown]]」…（＝人名でないプレースホルダ）
 * で、実際の採用担当者名が不明。本スクリプトはその“不明社”だけを対象に氏名を回収し、
 * 収集できた社を新規リストへ逐次書き出す（ユーザー指定 2026-07）。
 *
 * 回収は2段:
 *   ① 突合パス（無料・ブラウザ不要）: 既存の「氏名判明リスト」と社名突合し、判っている社は即回収。
 *   ② マイナビ収集パス（中断再開可）: 残りを MynaviScraper.scrapeCompany で氏名探索。
 *      .journal.json に社名キーで結果を保存し、再実行で続きから。成功のみ永続、失敗は
 *      --retry-empty のとき再試行（過渡的失敗の救済）。
 *
 * 出力（毎イテレーション書き直し＝“作成していく”）:
 *   data/leads-mochica-sf-recovered-names.csv  … 氏名を回収できた社（build-named-consolidated に流せる列並び）
 *
 * 使い方:
 *   node scripts/collect-sf-unknown-names.js                 # 突合→マイナビ収集（全件・再開）
 *   node scripts/collect-sf-unknown-names.js --limit 50      # マイナビ収集は先頭50社だけ（動作確認）
 *   node scripts/collect-sf-unknown-names.js --xref-only     # 突合パスのみ（ブラウザ起動しない）
 *   node scripts/collect-sf-unknown-names.js --no-xref       # 突合を飛ばしてマイナビ収集のみ
 *   node scripts/collect-sf-unknown-names.js --status 01     # リード状況が「01」を含む社に限定
 * 環境変数: MYNAVI_GRAD_YEAR(既定28) / MYNAVI_POLITE_MS(既定3500) / MYNAVI_HEADFUL=1
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, readCsv, toCsv, normCompanyName, normCorpNumber } = require('../src/csv');
const { isFullName, isKnownSurname } = require('../src/jp-names');
const { MynaviScraper } = require('../src/scrape-mynavi');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : true) : d; };
const flag = (k) => args.includes(k);

const IN = path.resolve(ROOT, opt('--in', 'data/セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv'));
const OUT = path.resolve(ROOT, opt('--out', 'data/leads-mochica-sf-recovered-names.csv'));
const JOURNAL = OUT.replace(/\.csv$/, '') + '.journal.json';
const LIMIT = opt('--limit', null) ? parseInt(opt('--limit'), 10) : null;
const XREF_ONLY = flag('--xref-only');
const NO_XREF = flag('--no-xref');
const RETRY_EMPTY = flag('--retry-empty');
const STATUS_FILTER = opt('--status', null);

// ── 採用担当者「不明」判定: 人名でないプレースホルダ（SFの「姓」列に頻出）＋空欄 ──
const PLACEHOLDER = /^(担当者?|採用ご?担当者?様?|人事(部|課|担当)?ご?担当?者?様?|ご?担当者?様?|\[未指定\]|\[?\[?unknown\]?\]?|未指定|不明|なし|無し|―+|ー+|[-.．・]+|テスト\d*|test\d*|サンプル|ダミー|dummy)$/i;
const isUnknownName = (s) => { const v = String(s || '').trim(); return !v || PLACEHOLDER.test(v); };
// テスト企業（社名側）は母集団から除外
const isTestCompany = (name) => /テスト|ﾃｽﾄ|\btest\b|ダミー|dummy|サンプル|sample|検証用|練習/i.test(String(name || ''));

// 回収氏名の氏名検証（統合器の nameConfirmed と同基準）
const validName = (n) => { const s = String(n || '').trim(); if (!s) return false; return isFullName(s) || isKnownSurname(s) || /^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(s); };

// リード状況の優先度（アクティブなほど先に収集）
const STATUS_RANK = (st) => {
  const s = String(st || '');
  if (/03|コネクト/.test(s)) return 0;
  if (/02|未接触/.test(s)) return 1;
  if (/01|新規|New/i.test(s)) return 2;
  if (/04|ジャッジ/.test(s)) return 3;
  if (/05|コンバート/.test(s)) return 4;
  if (/89|リサイクル/.test(s)) return 6;
  if (/99|アーカイブ/.test(s)) return 7;
  return 5;
};

// ─────────────────────────────────────────────────────────────────────────
// SF参照CSVローダ: 前段のレポート見出しを飛ばし、データ見出し行から列を索引で拾う
function loadSfUnknowns() {
  const raw = fs.readFileSync(IN, 'utf8');
  const lines = raw.split(/\r?\n/);
  const hi = lines.findIndex((l) => l.includes('リードID18') && l.includes('会社名'));
  if (hi < 0) throw new Error('SF参照CSVのデータ見出し行（リードID18/会社名）が見つかりません: ' + IN);
  const rows = parseCsv(lines.slice(hi).join('\n'));
  const H = rows[0].map((h) => String(h).trim());
  const col = (needle) => H.findIndex((h) => h.includes(needle));
  const iID = col('リードID18'), iComp = col('会社名'), iPhone = H.findIndex((h) => h === '電話'),
    iSur = H.findIndex((h) => h === '姓'), iNum = col('採用人数'), iStatus = col('状況'),
    iEmp = col('従業員数'), iMail = col('メール'), iInd = col('業種');

  // 同一社（正規化社名）で名寄せ。プレースホルダ社のみ採用。電話/メール/採用数が濃い行を代表に。
  const map = new Map();
  let rawRows = 0, unknownRows = 0, testRows = 0;
  for (const r of rows.slice(1)) {
    const comp = String(r[iComp] || '').trim();
    if (!comp) continue;
    rawRows++;
    const sur = String(r[iSur] || '').trim();
    if (!isUnknownName(sur)) continue;              // 氏名が既知の社は対象外
    unknownRows++;
    if (isTestCompany(comp) || isTestCompany(sur)) { testRows++; continue; }
    const key = normCompanyName(comp);
    if (!key) continue;
    const cand = {
      企業名: comp,
      リードID: String(r[iID] || '').trim(),
      SF元姓: sur,
      電話番号: String(r[iPhone] || '').trim(),
      メール: String(r[iMail] || '').trim(),
      従業員数: String(r[iEmp] || '').trim(),
      採用予定人数: String(r[iNum] || '').trim(),
      業種: String(r[iInd] || '').trim(),
      リード状況: String(r[iStatus] || '').trim(),
      _key: key,
    };
    const cur = map.get(key);
    if (!cur) { map.set(key, cand); continue; }
    // 補完マージ（既存優先・空欄補完）＋ より濃い代表へ
    for (const f of ['電話番号', 'メール', '従業員数', '採用予定人数', '業種', 'リード状況', 'リードID']) {
      if (!cur[f] && cand[f]) cur[f] = cand[f];
    }
    const richness = (x) => (x.電話番号 ? 2 : 0) + (x.メール ? 1 : 0) + (x.採用予定人数 ? 1 : 0);
    if (richness(cand) > richness(cur)) { cand._key = key; map.set(key, { ...cand, ...pickFilled(cur, cand) }); }
  }
  return { candidates: [...map.values()], rawRows, unknownRows, testRows };
}
// cur の非空値で cand を補完（代表差し替え時の取りこぼし防止）
function pickFilled(cur, cand) {
  const out = {};
  for (const f of ['電話番号', 'メール', '従業員数', '採用予定人数', '業種', 'リード状況', 'リードID']) {
    out[f] = cand[f] || cur[f] || '';
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 突合パス用: 既存の「氏名判明」リストから 正規化社名 → 氏名情報 の索引を作る
const XREF_SOURCES = [
  'leads-mochica-named-consolidated.csv',
  'data/leads-mochica-mynavi-named.csv',
  'data/leads-mochica-named-callable.csv',
  'data/leads-mochica-named-select.csv',
  'data/leads-recruiter-acquired-1000.csv',
  'data/leads-mochica-mynavi-callable.csv',
  'data/leads-mochica-target-namedonly.csv',
];
function buildKnownIndex() {
  const idx = new Map();
  for (const rel of XREF_SOURCES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    let recs;
    try { recs = readCsv(fs.readFileSync(p, 'utf8')).records; } catch (_) { continue; }
    for (const r of recs) {
      const nm = String(r['採用担当者名'] || '').trim();
      const comp = String(r['企業名'] || '').trim();
      if (!comp || !validName(nm)) continue;
      const key = normCompanyName(comp);
      if (!key || idx.has(key)) continue;           // 先勝ち（SOURCES上位＝濃い）
      idx.set(key, {
        採用担当者名: nm,
        役職: String(r['役職'] || '').trim(),
        部署: String(r['部署'] || '').trim(),
        電話番号: String(r['電話番号'] || r['電話'] || '').trim(),
        メール: String(r['メール'] || '').trim(),
        公式URL: String(r['公式URL'] || '').trim(),
        根拠URL: String(r['根拠URL'] || '').trim(),
        取得元: '既存リスト突合(' + rel.replace(/^data\//, '') + ')',
      });
    }
  }
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────
const OUT_HEADERS = [
  '企業名', '採用担当者名', '氏名検証', '担当者確度', '役職', '部署',
  '電話番号', 'メール', '従業員数', '採用予定人数', '業種', '法人番号', '新卒フラグ',
  '公式URL', 'リード状況', 'SF元姓', 'リードID', '取得元', '根拠', '根拠URL',
];
// 回収結果（cand + 収集した氏名情報）→ 出力行
function toRow(cand, hit) {
  const nm = String(hit.採用担当者名 || '').trim();
  return {
    企業名: cand.企業名,
    採用担当者名: nm,
    氏名検証: validName(nm) ? 'OK' : '要確認',
    担当者確度: hit.担当者確度 != null ? hit.担当者確度 : '',
    役職: hit.役職 || '',
    部署: hit.部署 || '',
    電話番号: cand.電話番号 || hit.電話番号 || '',
    メール: cand.メール || hit.メール || '',
    従業員数: cand.従業員数 || '',
    採用予定人数: cand.採用予定人数 || '',
    業種: cand.業種 || '',
    法人番号: normCorpNumber(cand.法人番号 || '') || '',
    新卒フラグ: hit.マイナビ掲載 || '',
    公式URL: hit.公式URL || hit.採用ページURL || '',
    リード状況: cand.リード状況 || '',
    SF元姓: cand.SF元姓 || '',
    リードID: cand.リードID || '',
    取得元: hit.取得元 || 'マイナビ(scrapeCompany)',
    根拠: hit.根拠 || '',
    根拠URL: hit.採用ページURL || hit.根拠URL || '',
  };
}

function loadJournal() { try { return JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch (_) { return {}; } }
function saveJournal(j) { fs.writeFileSync(JOURNAL, JSON.stringify(j, null, 0)); }
function writeOut(rows) {
  rows.sort((a, b) => (b.氏名検証 === 'OK') - (a.氏名検証 === 'OK') || a.企業名.localeCompare(b.企業名, 'ja'));
  fs.writeFileSync(OUT, '﻿' + toCsv(OUT_HEADERS, rows), 'utf8');
}

async function main() {
  const L = '──────────────────────────────────────────────';
  let { candidates, rawRows, unknownRows, testRows } = loadSfUnknowns();
  if (STATUS_FILTER) candidates = candidates.filter((c) => c.リード状況.includes(STATUS_FILTER));
  // アクティブ・架電可を先に
  candidates.sort((a, b) => STATUS_RANK(a.リード状況) - STATUS_RANK(b.リード状況)
    || (b.電話番号 ? 1 : 0) - (a.電話番号 ? 1 : 0)
    || a.企業名.localeCompare(b.企業名, 'ja'));

  console.log(L);
  console.log('  SF参照「採用担当者わからない」社の氏名収集');
  console.log(L);
  console.log(`  SFデータ行(社名あり)        : ${rawRows}`);
  console.log(`  ├ 氏名プレースホルダ(不明)  : ${unknownRows}`);
  console.log(`  ├ テスト社を除外            : ${testRows}`);
  console.log(`  └ 名寄せ後ユニーク対象社    : ${candidates.length}${STATUS_FILTER ? `（--status ${STATUS_FILTER} 絞込後）` : ''}`);
  console.log(L);

  const journal = loadJournal();
  const recovered = new Map();   // key -> row（正規化社名で一意）

  // ── ① 突合パス（ブラウザ不要）──
  let xrefHit = 0;
  if (!NO_XREF) {
    const known = buildKnownIndex();
    for (const c of candidates) {
      const hit = known.get(c._key);
      if (!hit) continue;
      recovered.set(c._key, toRow(c, hit));
      journal[c._key] = { 採用担当者名: hit.採用担当者名, 役職: hit.役職, 部署: hit.部署, メール: hit.メール, 電話番号: hit.電話番号, 採用ページURL: hit.根拠URL, 取得元: hit.取得元, xref: 1 };
      xrefHit++;
    }
    if (xrefHit) { saveJournal(journal); writeOut([...recovered.values()]); }
    console.log(`  ① 突合パス: 既存リスト索引 ${known.size}社 → 回収 ${xrefHit}社`);
  }

  // ジャーナルに既にある成功も回収済みとして取り込む（再開時）
  for (const c of candidates) {
    if (recovered.has(c._key)) continue;
    const j = journal[c._key];
    if (j && j.採用担当者名) {
      recovered.set(c._key, toRow(c, { ...j, 採用ページURL: j.採用ページURL, 取得元: j.取得元 || 'マイナビ(scrapeCompany)' }));
    }
  }

  if (XREF_ONLY) {
    writeOut([...recovered.values()]);
    console.log(L);
    console.log(`  回収済み合計: ${recovered.size}社 → ${path.relative(ROOT, OUT)}（--xref-only のためマイナビ収集は未実行）`);
    console.log(L);
    return;
  }

  // ── ② マイナビ収集パス（中断再開可）──
  //   未回収 かつ 未成功（--retry-empty なら失敗も再試行）の社をキューに
  const queue = candidates.filter((c) => {
    if (recovered.has(c._key)) return false;
    const j = journal[c._key];
    if (j && j.採用担当者名) return false;           // 過去に成功
    if (j && !RETRY_EMPTY) return false;             // 過去に失敗（再試行しない）
    return true;
  });
  const pool = LIMIT ? queue.slice(0, LIMIT) : queue;
  console.log(`  ② マイナビ収集: 未回収 ${queue.length}社 / 今回対象 ${pool.length}社`
    + `（卒年${process.env.MYNAVI_GRAD_YEAR || '28'} / 間隔${process.env.MYNAVI_POLITE_MS || '3500'}ms）`);
  console.log(L);

  if (!pool.length) {
    writeOut([...recovered.values()]);
    console.log(`  収集対象なし。回収済み合計 ${recovered.size}社 → ${path.relative(ROOT, OUT)}`);
    return;
  }

  const sc = new MynaviScraper({ gradYear: process.env.MYNAVI_GRAD_YEAR || '28' });
  await sc.launch();
  let done = 0, hit = 0;
  try {
    for (const c of pool) {
      done++;
      process.stdout.write(`[${done}/${pool.length}] ${c.企業名} … `);
      let res;
      try { res = await sc.scrapeCompany(c.企業名); } catch (e) { res = { 根拠: 'error:' + String(e && e.message || e).slice(0, 60) }; }
      const nm = String(res.採用担当者名 || '').trim();
      journal[c._key] = nm
        ? { 採用担当者名: nm, 担当者確度: res.担当者確度, 役職: res.役職, 部署: res.部署, メール: res.メール, 電話番号: res.電話番号, マイナビ掲載: res.マイナビ掲載, 採用ページURL: res.採用ページURL, 根拠: res.根拠 }
        : { 採用担当者名: '', 根拠: res.根拠 || 'マイナビ氏名なし' };
      saveJournal(journal);
      if (nm) {
        recovered.set(c._key, toRow(c, res));
        writeOut([...recovered.values()]);          // 収集できたら即リスト更新（“作成していく”）
        hit++;
        console.log(`✓ ${nm}${res.担当者確度 ? `(${res.担当者確度})` : ''}`);
      } else {
        console.log(`— ${res.根拠 || '氏名なし'}`);
      }
      await new Promise((r) => setTimeout(r, parseInt(process.env.MYNAVI_POLITE_MS || '3500', 10)));
    }
  } finally {
    await sc.close();
  }

  writeOut([...recovered.values()]);
  const okCount = [...recovered.values()].filter((r) => r.氏名検証 === 'OK').length;
  console.log(L);
  console.log(`  今回マイナビ収集: ${done}社処理 / 氏名回収 ${hit}社`);
  console.log(`  回収済み合計: ${recovered.size}社（氏名検証OK ${okCount} / 突合${xrefHit}）→ ${path.relative(ROOT, OUT)}`);
  console.log(`  残り未収集: ${queue.length - done}社（再実行で続きから）`);
  console.log(L);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
