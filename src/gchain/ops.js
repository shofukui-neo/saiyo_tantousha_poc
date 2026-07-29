'use strict';
/**
 * G-Chain OS v2.0 — 運用CLI（リアルタイム営業分析の操作面）。
 *
 * サブコマンド:
 *   train              BALESから学習しモデルを保存（日次/エクスポート更新時）
 *   brief "<会社名>"    架電前ブリーフ（1社を即座にスコア・最適時間帯・再活性化・NG警告）
 *   queue [--limit N]  本日のコールキュー（高スコア未架電＋再活性化到来）を出力
 *   watch              エクスポートCSVの更新を監視し自動で再学習（near-real-time）
 *
 * 使い方: node src/gchain/ops.js <cmd> [args]
 * BALESはAPI非公開のためCSVエクスポート起点（"リアルタイム"=モデル即時参照＋日次/監視再学習）。
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../csv');
const G = require('./index');
const model = require('./model');
const { buildExistingCustomerSet, NG_TYPES_BLOCK } = require('./ingest-wave0');

const DATA = path.join(__dirname, '..', '..', 'data');
const OUT = path.join(DATA, 'gchain', 'v2');
const F_BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const NOW_ISO = () => new Date().toISOString();
const TODAY = () => new Date().toISOString().slice(0, 10);

function loadBales() {
  const rows = parseCsv(fs.readFileSync(F_BALES, 'utf8'));
  const head = rows[0];
  const recs = [];
  for (let r = 1; r < rows.length; r++) {
    const o = {}; head.forEach((h, i) => { o[h] = rows[r][i]; }); recs.push(o);
  }
  return recs;
}
function enrich(rec) {
  const { features, leak } = G.features.extractFeatures(rec);
  const labels = G.outcome.extractLabels(rec);
  const called = (rec['コール結果1：結果'] || '').trim() !== '';
  return { rec, features, labels, called, leak };
}

// ---- train ----
function cmdTrain() {
  const recs = loadBales();
  const called = recs.map(enrich).filter((e) => e.called);
  const m = model.trainModel(called, NOW_ISO());
  const p = model.saveModel(m);
  console.log(`✓ 学習完了: ${called.length}件（架電済）から学習 → ${path.relative(process.cwd(), p)}`);
  console.log(`  ベースアポ率 ${(m.base.appointment * 100).toFixed(1)}% / ベース接続率 ${(m.base.connection * 100).toFixed(1)}%`);
  console.log(`  trainedAt ${m.trainedAt}`);
  return m;
}

// ---- brief ----
function cmdBrief(query) {
  if (!query) { console.error('usage: ops brief "<会社名>"'); process.exit(2); }
  let m = model.loadModel();
  if (!m) { console.log('モデル未学習 → train を実行します...'); m = cmdTrain(); }
  const recs = loadBales();
  const nq = G.normalize.normCompanyName(query);
  const matches = recs.filter((r) => {
    const n = G.normalize.normCompanyName(r['会社情報：会社名'] || '');
    return n && (n === nq || n.indexOf(nq) >= 0 || nq.indexOf(n) >= 0);
  });
  if (!matches.length) { console.log(`該当なし: "${query}"`); return; }
  const custSet = buildExistingCustomerSet();
  for (const rec of matches.slice(0, 5)) printBrief(rec, m, custSet);
}

function printBrief(rec, m, custSet) {
  const s = model.scoreRecord(rec, m);
  const company = (rec['会社情報：会社名'] || '').trim();
  const stage = (rec['リード関連情報：最終リードステージ'] || '').trim();
  const ng = (rec['カスタム情報：アプローチ禁止の種類'] || '').trim();
  const nname = G.normalize.normCompanyName(company);
  const lift = s.appointment_score / (m.base.appointment || 1);

  const L = [];
  L.push('');
  L.push('═'.repeat(58));
  L.push(`■ ${company}   [${stage || '—'}]`);
  L.push('─'.repeat(58));
  // 警告
  if (ng && NG_TYPES_BLOCK.has(ng)) L.push(`  ⛔ アプローチ禁止(${ng}) — 架電しない`);
  if (nname && custSet.has(nname)) L.push('  ⚠ 既存顧客(MOCHICA)の可能性 — 要確認');
  // スコア
  L.push(`  アポ期待値: ${(s.appointment_score * 100).toFixed(1)}%  (ベース比 ${lift.toFixed(2)}x)`);
  L.push(`  担当接続期待: ${(s.connection_score * 100).toFixed(1)}%`);
  L.push(`  属性: ${s.features.icp_band} / 採用${s.features.recruit_size || '?'} / ${s.features.industry || '業種?'} / ソース:${s.features.source}`);
  // ATS
  if (s.ats_signal) L.push(`  ★ATS=${s.ats_signal.ats}: アポ率${(s.ats_signal.rate * 100).toFixed(1)}% (${s.ats_signal.lift}x) — 強い訴求余地`);
  // 寄与要因
  if (s.top_factors.length) {
    L.push('  スコア寄与:');
    for (const f of s.top_factors) {
      const arrow = f.delta > 0 ? '↑' : '↓';
      L.push(`    ${arrow} ${f.key}=${f.value} (率${(f.rate * 100).toFixed(1)}%)`);
    }
  }
  // 最適時間帯
  if (s.best_bands.length) {
    const bandJp = { am: '午前', noon: '昼', pm: '午後', eve: '夕方' };
    L.push(`  推奨時間帯(接続率順): ${s.best_bands.map((b) => `${bandJp[b.band] || b.band} ${(b.rate * 100).toFixed(0)}%`).join(' > ')}`);
  }
  // 再活性化
  if (/リサイクル|ペンディング|失注|情報収集/.test(stage)) {
    const p = G.reactivation.reactivationPriority({
      consider_timing: rec['カスタム情報：検討開始時期'],
      renewal_month: rec['カスタム情報：現利用サービス更新予定月'],
      next_action_date: rec['カスタム情報：失注後次回アクション日'],
      loss_date: rec['カスタム情報：失注商談失注日'],
    }, { y: Number(TODAY().slice(0, 4)), m: Number(TODAY().slice(5, 7)), today: TODAY() });
    if (p.priority > 0) L.push(`  ♻ 再活性化 優先度${p.priority}: ${p.reasons.join('; ')}`);
  }
  // フォロー規律
  const d = G.discipline.recordDiscipline(rec, TODAY());
  if (d.overdue > 0) L.push(`  ⏰ 未消化フォロー ${d.overdue}件（期限超過）`);
  // 推奨
  L.push(`  → ${recommend(s, stage, ng, m)}`);
  console.log(L.join('\n'));
}

function recommend(s, stage, ng, m) {
  if (ng && NG_TYPES_BLOCK.has(ng)) return '架電対象外（アプローチ禁止）';
  const lift = s.appointment_score / (m.base.appointment || 1);
  const bandJp = { am: '午前', noon: '昼', pm: '午後', eve: '夕方' };
  const best = s.best_bands[0] ? bandJp[s.best_bands[0].band] : '午前';
  if (lift >= 1.5) return `優先架電。${best}に架電、ATS/課題で具体訴求`;
  if (lift >= 1.0) return `通常優先。${best}に架電`;
  if (/リサイクル|失注|情報収集/.test(stage)) return '再活性化キューで時期到来時に架電';
  return '優先度低。上位リードを先に';
}

// ---- queue ----
function cmdQueue(limit) {
  let m = model.loadModel();
  if (!m) { console.log('モデル未学習 → train...'); m = cmdTrain(); }
  const recs = loadBales();
  const today = TODAY();
  const ref = { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)), today };

  const scored = [];
  for (const rec of recs) {
    const called = (rec['コール結果1：結果'] || '').trim() !== '';
    const stage = (rec['リード関連情報：最終リードステージ'] || '').trim();
    const ng = (rec['カスタム情報：アプローチ禁止の種類'] || '').trim();
    if (ng && NG_TYPES_BLOCK.has(ng)) continue; // 禁止は除外
    const s = model.scoreRecord(rec, m);
    const react = G.reactivation.reactivationPriority({
      consider_timing: rec['カスタム情報：検討開始時期'],
      renewal_month: rec['カスタム情報：現利用サービス更新予定月'],
      next_action_date: rec['カスタム情報：失注後次回アクション日'],
      loss_date: rec['カスタム情報：失注商談失注日'],
    }, ref);
    // 対象: 未架電 or 再活性化到来。優先度 = アポ期待 + 再活性化ブースト
    const isReactivation = /リサイクル|ペンディング|失注|情報収集/.test(stage) && react.priority > 0;
    if (!called || isReactivation) {
      scored.push({
        company: (rec['会社情報：会社名'] || '').trim(),
        type: !called ? 'NEW' : 'REACTIVATE',
        appointment_score: s.appointment_score,
        reactivation_priority: react.priority,
        rank_score: s.appointment_score + react.priority / 200, // 再活性化を加点
        icp_band: s.features.icp_band, source: s.features.source, recruit_size: s.features.recruit_size,
        best_band: s.best_bands[0] ? s.best_bands[0].band : '',
        reason: react.priority > 0 ? react.reasons.join('; ') : (s.top_factors[0] ? s.top_factors[0].key + '=' + s.top_factors[0].value : ''),
      });
    }
  }
  scored.sort((a, b) => b.rank_score - a.rank_score);
  const lim = limit || 100;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'call-queue.csv');
  writeCsv(file, scored.slice(0, 2000).map((r) => ({
    company: r.company, type: r.type,
    appointment_score: r.appointment_score, reactivation_priority: r.reactivation_priority,
    best_band: r.best_band, icp_band: r.icp_band, source: r.source, recruit_size: r.recruit_size, reason: r.reason,
  })));
  console.log(`本日のコールキュー（上位${Math.min(lim, scored.length)} / 全${scored.length}件）`);
  console.log('順位 | 種別 | アポ期待 | 再活性 | 時間帯 | 会社 | 理由');
  scored.slice(0, lim).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(3)} | ${r.type.padEnd(10)} | ${(r.appointment_score * 100).toFixed(1)}% | ${String(r.reactivation_priority).padStart(3)} | ${(r.best_band || '-').padEnd(4)} | ${r.company} | ${r.reason}`);
  });
  console.log(`\n→ ${path.relative(process.cwd(), file)}（PIIのためローカル限定）`);
}

function writeCsv(file, rows) {
  if (!rows.length) { fs.writeFileSync(file, ''); return; }
  const head = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  fs.writeFileSync(file, [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n'));
}

// ---- watch ----
function cmdWatch() {
  console.log(`監視開始: ${path.basename(F_BALES)} の更新で自動再学習します（Ctrl+C で停止）`);
  cmdTrain();
  let timer = null;
  fs.watch(path.dirname(F_BALES), (ev, fname) => {
    if (!fname || fname.indexOf('BALESCLOUD') < 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`\n[${new Date().toLocaleTimeString()}] エクスポート更新検知 → 再学習`);
      try { cmdTrain(); cmdQueue(20); } catch (e) { console.error('再学習失敗:', e.message); }
    }, 2000); // デバウンス
  });
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'train': cmdTrain(); break;
    case 'brief': cmdBrief(rest.join(' ').replace(/^["']|["']$/g, '')); break;
    case 'queue': {
      const li = rest.indexOf('--limit');
      cmdQueue(li >= 0 ? Number(rest[li + 1]) : 50);
      break;
    }
    case 'watch': cmdWatch(); break;
    default:
      console.log('G-Chain OS v2.0 運用CLI\n  train | brief "<会社名>" | queue [--limit N] | watch');
  }
}

if (require.main === module) main();
module.exports = { loadBales, enrich, cmdTrain, cmdBrief, cmdQueue };
