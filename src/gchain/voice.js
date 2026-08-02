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

const { spawnSync } = require('child_process');

// ---- doctor（環境自己診断） ----
function cmdDoctor() {
  const ok = (b) => (b ? '✓' : '✗');
  console.log('G-Chain OS v2.1 音声レイヤ 環境診断\n');
  const ffmpeg = recorder.ffmpegAvailable();
  console.log(`  ${ok(ffmpeg)} ffmpeg          ${ffmpeg ? '' : '→ 導入し GCHAIN_FFMPEG を設定（winget install Gyan.FFmpeg）'}`);
  const ffprobe = stt.hasFfprobe();
  console.log(`  ${ok(ffprobe)} ffprobe         ${ffprobe ? '' : '→ ffmpeg同梱。PATH/GCHAIN_FFPROBE を確認'}`);
  let devs = [];
  if (ffmpeg) { try { devs = recorder.listDevices(); } catch (e) {} }
  console.log(`  ${ok(devs.length)} 録音デバイス    ${devs.length ? devs.length + '件検出' : '→ 未検出'}`);
  const v = recorder.validateDevices({});
  console.log(`  ${ok(v.ok)} マイク/システム ${v.ok ? `mic="${v.mic}" sys="${v.sys}"` : '→ ' + v.missing.join(' / ')}`);
  const backend = stt.detectBackend();
  console.log(`  ${ok(backend !== 'none')} STTバックエンド ${backend === 'none' ? '→ ' + stt.hint() : backend}`);
  if (backend === 'whispercpp') {
    const model = process.env.GCHAIN_WHISPER_MODEL;
    console.log(`     whisperモデル ${ok(model && fs.existsSync(model))} ${model || '(未設定)'}`);
  }
  console.log(`  ${ok(llm.available())} LLM(Claude)     ${llm.available() ? 'あり（LCS診断で高精度化）' : 'なし（ルールベースで動作）'}`);
  const recReady = ffmpeg && v.ok && backend !== 'none';
  console.log(`\n  録音→分析: ${recReady ? '✓ 実行可能' : '✗ 上記✗を解消してください'}`);
  console.log(`  分析のみ（既存wav/mock）: ✓ 常に可能（npm run gchain:voice:demo）`);
  if (!recReady) console.log('\n  セットアップ手順: docs/g-chain-os-v2.1-voice.md');
}

// ---- selftest（合成wavでキャプチャ/分離の配線検証） ----
function cmdSelftest() {
  if (!recorder.ffmpegAvailable()) { console.log('✗ ffmpeg が無いため selftest 不可。doctor を参照。'); process.exit(1); }
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gchain-selftest-'));
  const wav = path.join(dir, 'stereo-test.wav');
  console.log('1) 合成ステレオwav生成（左440Hz/右880Hz）…');
  const gen = spawnSync(stt.FFMPEG, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]',
    '-map', '[a]', '-ac', '2', '-ar', '16000', wav,
  ], { encoding: 'utf8' });
  if (gen.status !== 0) { console.log('  ✗ 生成失敗: ' + (gen.stderr || '').slice(-300)); process.exit(1); }
  console.log('   ✓ ' + wav);
  const ch = stt.probeChannels(wav);
  console.log(`2) チャンネル数検出: ${ch === 2 ? '✓ 2ch(ステレオ)' : '✗ ' + ch}`);
  console.log('3) 左右ch分離…');
  const sp = stt.splitChannels(wav, dir);
  const ok = fs.existsSync(sp.self) && fs.existsSync(sp.customer);
  console.log(`   ${ok ? '✓' : '✗'} self.wav / customer.wav 生成`);
  const backend = stt.detectBackend();
  console.log(`4) STTバックエンド: ${backend === 'none' ? '未設定（実録音時に要設定）' : backend + ' 到達可能'}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n結果: キャプチャ配線 ${ok && ch === 2 ? '✓ 正常' : '✗ 要確認'}（録音本番は doctor が✓なら実行可能）`);
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
  const allowMono = process.argv.includes('--mono');
  const { segments, backend, channels, attributed } = stt.transcribeStereo(wav, { allowMono });
  console.log(`  文字起こし完了（${backend}・${channels}ch・${attributed ? '話者分離あり' : '話者分離なし(モノラル)'}・${segments.length}セグメント）`);
  const record = analyzeMod.analyzeCall({ ...meta, segments, audio_path: wav, attributed });
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
  const map = { doctor: cmdDoctor, selftest: cmdSelftest, devices: cmdDevices, record: cmdRecord, analyze: cmdAnalyze, demo: cmdDemo, report: cmdReport, list: cmdList };
  if (map[cmd]) return map[cmd]();
  console.log('G-Chain OS v2.1 音声CLI\n  doctor | selftest | devices | record --company X | analyze <wav> [--mono] | demo | report [--recent N] | list');
  console.log('  STT: ' + stt.detectBackend() + ' / LLM: ' + (llm.available() ? 'Claude' : 'なし(ルールベース)'));
}

if (require.main === module) main();
module.exports = { finalize, cmdDemo, cmdReport };
