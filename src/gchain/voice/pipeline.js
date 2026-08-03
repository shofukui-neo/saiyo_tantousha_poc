'use strict';
/**
 * G-Chain OS v2.1 — 通話処理パイプライン（ports & adapters の合流点）。
 *
 * 移植のための境界：この関数は「純コア(analyze)」と「アダプタ(capture/stt/storage/llm)」を
 * 引数注入で合成する。別アプリへ移植する際は、各ポートを対象環境の実装に差し替えるだけで、
 * コア(metrics/feedback/weakness/analyze)はそのまま再利用できる。
 *
 * ポート契約（最小）:
 *   CapturePort:  start(meta) -> { stop(): Promise<audioRef> }
 *   SttPort:      transcribe(audioRef, opts) -> { segments, channels, attributed, backend }
 *   StoragePort:  saveCall(record) -> ref ;  loadCalls(opts) -> record[]
 *   LlmPort(任意): diagnose(text) -> diagnosis | null
 * これらを満たせば UI/OS/言語を問わず同じ分析結果になる（golden vectorで担保）。
 */
const analyzeMod = require('./analyze');
const weaknessMod = require('./weakness');

/**
 * 音声参照 → 通話レコード（capture済みの音声を処理）。
 * ports: { stt, storage }。meta: { company, started_at, call_id, ... }。
 */
function processAudio(audioRef, meta, ports, opts) {
  const o = opts || {};
  const { segments, channels, attributed, backend } = ports.stt.transcribe(audioRef, { allowMono: o.allowMono });
  const record = analyzeMod.analyzeCall(Object.assign({}, meta, { segments, audio_path: audioRef, attributed, useLLM: o.useLLM }));
  record.stt = { backend, channels, attributed };
  const ref = ports.storage ? ports.storage.saveCall(record) : null;
  return { record, ref };
}

/**
 * 録音 → 停止 → 分析（capture ポートも注入）。stopSignal は「停止して」を待つ Promise。
 * ports: { capture, stt, storage }。
 */
async function runCall(meta, ports, stopSignal, opts) {
  const session = ports.capture.start(meta);
  await stopSignal;                 // 呼び手が「停止」を解決する（UIのボタン等）
  const audioRef = await session.stop();
  return processAudio(audioRef, meta, ports, opts);
}

/** 蓄積 → 自己分析（storage ポートから履歴を読み core で集計）。 */
function report(ports, opts) {
  const calls = ports.storage.loadCalls(opts || {});
  return weaknessMod.aggregateWeakness(calls, opts || {});
}

module.exports = { processAudio, runCall, report };
