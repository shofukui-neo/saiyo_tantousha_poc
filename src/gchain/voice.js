'use strict';
/**
 * G-Chain OS v2.1 — 通話音声 収集・分析 CLI（本システムの根幹）。
 *
 *   node src/gchain/voice.js devices          # 録音デバイス一覧
 *   node src/gchain/voice.js record --company "会社名"   # 録音→停止(Enter)→文字起こし→分析→保存
 *   node src/gchain/voice.js analyze <wav> --company "会社名"  # 既存wavを分析
 *   node src/gchain/voice.js demo             # ffmpeg/STT無しでもパイプライン実走（合成通話）
 *   node src/gchain/voice.js report [--recent N]  # 蓄積から自分の弱みを集計
 *   node src/gchain/voice.js list [--limit N]     # 直近の通話一覧
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const recorder = require('./voice/recorder');
const stt = require('./voice/stt');
const analyzeMod = require('./voice/analyze');
const store = require('./voice/store');
const weaknessMod = require('./voice/weakness');
const llm = require('./voice/llm');
const { DEMO_CALLS } = require('./voice/fixtures');

const AUDIO_DIR = path.join(store.CALLS_DIR, '..', 'audio');
const nowIso = () => new Date().toISOString();

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

// ---- devices ----
function cmdDevices() {
  if (!recorder.ffmpegAvailable()) { console.log('✗ ffmpeg が見つかりません。GCHAIN_FFMPEG を設定してください。'); return; }
  const d = recorder.listDevices();
  console.log('録音可能なオーディオデバイス:');
  d.forEach((x) => console.log('  · ' + x));
  console.log('\n設定例（PowerShell）:');
  console.log('  $env:GCHAIN_MIC="' + (d[0] || 'マイク名') + '"    # 自分（左ch）');
  console.log('  $env:GCHAIN_SYS="ステレオ ミキサー"   # 相手（右ch・要有効化 or VB-CABLE）');
}

// ---- record ----
async function cmdRecord() {
  const company = arg('--company', null);
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const started = nowIso();
  const id = store.newCallId(started, company);
  const wav = path.join(AUDIO_DIR, id + '.wav');
  console.log('● 録音開始… 通話が終わったら Enter で停止します。');
  const rec = recorder.startRecording(wav, {});
  await waitEnter();
  await rec.stop();
  console.log('■ 録音停止 → 文字起こし中…');
  finalize(wav, { company, started_at: started, call_id: id });
}

// ---- analyze existing wav ----
function cmdAnalyze() {
  const wav = process.argv[3];
  if (!wav || !fs.existsSync(wav)) { console.error('wav が見つかりません: ' + wav); process.exit(2); }
  finalize(wav, { company: arg('--company', null), started_at: nowIso() });
}

function finalize(wav, meta) {
  const { segments, backend } = stt.transcribeStereo(wav, {});
  console.log(`  文字起こし完了（${backend}・${segments.length}セグメント）`);
  const record = analyzeMod.analyzeCall({ ...meta, segments, audio_path: wav });
  const p = store.saveCall(record);
  printFeedback(record);
  console.log('\n保存: ' + path.relative(process.cwd(), p));
}

// ---- demo (mock, no ffmpeg/STT) ----
function cmdDemo() {
  console.log('=== デモ: 合成通話でパイプライン実走（ffmpeg/STT不要）===\n');
  const base = Date.UTC(2026, 6, 24, 9, 0, 0);
  for (const c of DEMO_CALLS) {
    const started = new Date(base + c.offsetMin * 60000).toISOString();
    const record = analyzeMod.analyzeCall({ company: c.company, started_at: started, segments: c.segments, useLLM: false });
    store.saveCall(record);
    printFeedback(record);
    console.log('');
  }
  console.log('— 蓄積された弱み —');
  cmdReport();
}

// ---- report (weakness) ----
function cmdReport() {
  const recent = Number(arg('--recent', 0)) || null;
  const calls = store.loadCalls();
  const w = weaknessMod.aggregateWeakness(calls, recent ? { recentN: recent } : {});
  if (!w.n) { console.log('通話データがありません。まず record か demo を実行してください。'); return; }
  console.log(`\n■ 自己分析（直近${w.n}件）  平均実行スコア ${w.avg_score ?? '—'}` + (w.score_trend != null ? `（トレンド ${w.score_trend > 0 ? '+' : ''}${w.score_trend}）` : ''));
  console.log('  指標平均: 自分の発話比 ' + pct(w.metrics.avg_talk_ratio_self) + ' / 質問 ' + w.metrics.avg_question_count + '件 / 打診率 ' + pct(w.metrics.proposal_rate) + ' / 最長独白 ' + w.metrics.avg_longest_monologue_sec + '秒');
  if (w.weaknesses.length) {
    console.log('  ▼ 弱み:');
    w.weaknesses.forEach((x) => console.log('    ・' + x.message));
  }
  if (w.strengths.length) {
    console.log('  ▲ 強み:');
    w.strengths.forEach((x) => console.log('    ・' + x.message));
  }
}

// ---- list ----
function cmdList() {
  const limit = Number(arg('--limit', 20));
  const calls = store.loadCalls({ limit });
  console.log(`直近 ${calls.length} 件:`);
  for (const c of calls) {
    console.log(`  ${(c.started_at || '').slice(0, 16).replace('T', ' ')} | ${String(c.feedback?.execution_score ?? '—').padStart(3)}点 | ${c.company || '(社名なし)'} | 打診${c.metrics?.proposal_made ? '○' : '×'} 質問${c.metrics?.question_count ?? '?'}`);
  }
}

function printFeedback(r) {
  const m = r.metrics, f = r.feedback;
  console.log(`■ ${r.company || '(社名なし)'}  実行スコア ${f.execution_score}点  ${r.connected ? '[担当接続]' : '[未接続]'}`);
  console.log(`  発話比 自分${pct(m.talk_ratio_self)} / 質問${m.question_count}件 / 打診${m.proposal_made ? '○' : '×'} / 最長独白${m.longest_monologue_sec}秒 / 冒頭${m.opening_customer_first_sec ?? '—'}秒`);
  if (f.good) console.log(`  ▲ GOOD: ${f.good.point}` + (f.good.quote ? `（「${trunc(f.good.quote)}」）` : ''));
  if (f.more) console.log(`  ▼ MORE: ${f.more.point}\n         → ${f.more.next_action || ''}`);
  if (f.next_ng) console.log(`  ⛔ 次NG: ${f.next_ng.stop_condition}`);
  if (r.llm) console.log(`  （LLM診断: ${r.llm.model}）`);
}

function waitEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
}
function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
function trunc(s) { return String(s).length > 24 ? String(s).slice(0, 24) + '…' : s; }

function main() {
  const cmd = process.argv[2];
  const map = { devices: cmdDevices, record: cmdRecord, analyze: cmdAnalyze, demo: cmdDemo, report: cmdReport, list: cmdList };
  if (map[cmd]) return map[cmd]();
  console.log('G-Chain OS v2.1 音声CLI\n  devices | record --company X | analyze <wav> | demo | report [--recent N] | list');
  console.log('  STT: ' + stt.detectBackend() + ' / LLM: ' + (llm.available() ? 'Claude' : 'なし(ルールベース)'));
}

if (require.main === module) main();
module.exports = { finalize, cmdDemo, cmdReport };
