'use strict';
/**
 * G-Chain OS v2.1 — 文字起こし（STT）アダプタ（ハイブリッド・堅牢版）。
 *
 * 既定=ローカル whisper.cpp（音声を外部送信しない）。APIキーがあればクラウドSTTで高精度化。
 * ステレオwav（左ch=自分/右ch=相手）を各chで文字起こし → 話者確定のsegmentsに統合。
 *
 * 環境変数:
 *   GCHAIN_FFMPEG / GCHAIN_FFPROBE   ffmpeg/ffprobe パス（既定 'ffmpeg'/'ffprobe'）
 *   GCHAIN_WHISPER_BIN / _MODEL       whisper.cpp の whisper-cli と ggmlモデル
 *   GCHAIN_WHISPER_LANG               言語（既定 ja）
 *   OPENAI_API_KEY / OPENAI_STT_URL / OPENAI_STT_MODEL  クラウドSTT（OpenAI互換）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const FFMPEG = process.env.GCHAIN_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.GCHAIN_FFPROBE || 'ffprobe';
const WHISPER_TIMEOUT_MS = Number(process.env.GCHAIN_WHISPER_TIMEOUT_MS || 30 * 60 * 1000);
const MAXBUF = 128 * 1024 * 1024;

function detectBackend() {
  if (process.env.OPENAI_API_KEY) return 'cloud';
  if (process.env.GCHAIN_WHISPER_BIN && process.env.GCHAIN_WHISPER_MODEL) return 'whispercpp';
  return 'none';
}
function toolOk(bin, args) {
  try { return spawnSync(bin, args || ['-version'], { encoding: 'utf8' }).status === 0; } catch (e) { return false; }
}
function hasFfmpeg() { return toolOk(FFMPEG); }
function hasFfprobe() { return toolOk(FFPROBE); }

function run(bin, args, opts) {
  const r = spawnSync(bin, args, Object.assign({ encoding: 'utf8', maxBuffer: MAXBUF }, opts));
  if (r.error) throw new Error(`${path.basename(bin)} 実行失敗: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${path.basename(bin)} エラー(code=${r.status}): ${(r.stderr || '').slice(-400)}`);
  return r.stdout;
}

/** wav の音声チャンネル数を取得（ffprobe）。取得不能なら null。 */
function probeChannels(wavPath) {
  if (!hasFfprobe()) return null;
  try {
    const out = run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', wavPath]);
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}

/** ステレオwavを左右chの2ファイルへ分離（channelsplit・堅牢）。 */
function splitChannels(wavPath, tmpDir) {
  const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gchain-stt-'));
  const self = path.join(dir, 'self.wav');
  const cust = path.join(dir, 'customer.wav');
  run(FFMPEG, [
    '-hide_banner', '-y', '-i', wavPath,
    '-filter_complex', '[0:a]channelsplit=channel_layout=stereo[l][r]',
    '-map', '[l]', '-ac', '1', '-ar', '16000', self,
    '-map', '[r]', '-ac', '1', '-ar', '16000', cust,
  ]);
  return { self, customer: cust, dir };
}

/** wav を 16kHz mono へ正規化（whisper入力の安定化）。 */
function toMono16k(wavPath, tmpDir) {
  const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gchain-stt-'));
  const out = path.join(dir, 'mono.wav');
  run(FFMPEG, ['-hide_banner', '-y', '-i', wavPath, '-ac', '1', '-ar', '16000', out]);
  return { out, dir };
}

/* ---------------- パーサ（純関数・テスト対象） ---------------- */

/** "HH:MM:SS,mmm" / "HH:MM:SS.mmm" → 秒(float)。 */
function parseTimestamp(ts) {
  const m = String(ts).match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] + '00').slice(0, 3)) / 1000;
}

/**
 * whisper.cpp の -oj 出力 → segments[{start,end,text}]（秒）。
 * transcription[].offsets は「ミリ秒」（← 以前の実装は/100で10倍ずれるバグがあった）。
 * 他形式（timestamps文字列 / segments t0,t1[センチ秒] / start,end[秒]）も許容。
 */
function parseWhisperJson(obj) {
  const list = (obj && (obj.transcription || obj.segments)) || [];
  const out = [];
  for (const s of list) {
    let start = null, end = null;
    if (s.offsets && s.offsets.from != null) { start = Number(s.offsets.from) / 1000; end = Number(s.offsets.to) / 1000; } // ms
    else if (s.timestamps && s.timestamps.from) { start = parseTimestamp(s.timestamps.from); end = parseTimestamp(s.timestamps.to); }
    else if (s.t0 != null) { start = Number(s.t0) / 100; end = Number(s.t1) / 100; } // centisec
    else if (s.start != null) { start = Number(s.start); end = Number(s.end); } // sec
    const text = String(s.text || '').trim();
    if (text) out.push({ start: round2(start), end: round2(end), text });
  }
  return out;
}

/** OpenAI互換 verbose_json → segments（start/end は秒）。 */
function parseOpenAiJson(obj) {
  return (obj.segments || []).map((s) => ({ start: round2(s.start), end: round2(s.end), text: String(s.text || '').trim() })).filter((s) => s.text);
}

function round2(n) { return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100; }

/* ---------------- バックエンド ---------------- */

function whisperCppChannel(wav) {
  const bin = process.env.GCHAIN_WHISPER_BIN;
  const model = process.env.GCHAIN_WHISPER_MODEL;
  const lang = process.env.GCHAIN_WHISPER_LANG || 'ja';
  if (!fs.existsSync(model)) throw new Error(`whisperモデルが見つかりません: ${model}`);
  const outBase = wav.replace(/\.wav$/i, '') + '.out';
  run(bin, ['-m', model, '-f', wav, '-l', lang, '-oj', '-of', outBase], { timeout: WHISPER_TIMEOUT_MS });
  const jsonPath = outBase + '.json';
  if (!fs.existsSync(jsonPath)) throw new Error('whisper出力JSONが生成されませんでした');
  const obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  try { fs.unlinkSync(jsonPath); } catch (e) {}
  return parseWhisperJson(obj);
}

function cloudChannel(wav) {
  const base = process.env.OPENAI_STT_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_STT_MODEL || 'whisper-1';
  const u = new URL(base.replace(/\/$/, '') + '/audio/transcriptions');
  const out = run('curl', [
    '-s', '--fail-with-body', '-X', 'POST', u.toString(),
    '-H', 'Authorization: Bearer ' + process.env.OPENAI_API_KEY,
    '-F', 'model=' + model, '-F', 'language=ja', '-F', 'response_format=verbose_json',
    '-F', 'file=@' + wav,
  ]);
  const obj = JSON.parse(out);
  if (obj.error) throw new Error('クラウドSTTエラー: ' + (obj.error.message || JSON.stringify(obj.error)));
  return parseOpenAiJson(obj);
}

function transcribeChannel(wav, backend) {
  if (backend === 'cloud') return cloudChannel(wav);
  if (backend === 'whispercpp') return whisperCppChannel(wav);
  throw new Error('STTバックエンド未設定: ' + hint());
}

/**
 * ステレオwav → 話者付きsegments。
 * opts: { backend, mock, allowMono }
 * 返り値: { backend, channels, segments, attributed }
 */
function transcribeStereo(wavPath, opts) {
  const o = opts || {};
  if (o.mock) return { backend: 'mock', channels: 2, attributed: true, segments: sortSegs(o.mock) };
  const backend = o.backend || detectBackend();
  if (backend === 'none') throw new Error('STT利用不可: ' + hint());
  if (!hasFfmpeg()) throw new Error('ffmpeg が見つかりません（GCHAIN_FFMPEG を設定）');
  if (!fs.existsSync(wavPath)) throw new Error('音声ファイルがありません: ' + wavPath);

  const ch = probeChannels(wavPath);
  // ステレオ（話者分離あり）
  if (ch === 2 || ch == null) {
    let split;
    try { split = splitChannels(wavPath); }
    catch (e) {
      if (ch == null) return transcribeMono(wavPath, backend, o); // 分離失敗かつ不明→モノラル扱い
      throw e;
    }
    try {
      const selfSegs = transcribeChannel(split.self, backend).map((s) => ({ ...s, speaker: 'self' }));
      const custSegs = transcribeChannel(split.customer, backend).map((s) => ({ ...s, speaker: 'customer' }));
      return { backend, channels: 2, attributed: true, segments: sortSegs([...selfSegs, ...custSegs]) };
    } finally { rmDir(split.dir); }
  }
  // モノラル（話者分離不可）
  if (!o.allowMono) {
    throw new Error(`モノラル録音です（${ch}ch）。話者分離には左=自分/右=相手のステレオ録音が必要です。当システムのrecorderはステレオで録ります。インポート音声は allowMono で暫定分析可。`);
  }
  return transcribeMono(wavPath, backend, o);
}

function transcribeMono(wavPath, backend, o) {
  const { out, dir } = toMono16k(wavPath);
  try {
    const segs = transcribeChannel(out, backend).map((s) => ({ ...s, speaker: 'unknown' }));
    return { backend, channels: 1, attributed: false, segments: sortSegs(segs) };
  } finally { rmDir(dir); }
}

function sortSegs(segs) { return [...segs].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)); }
function rmDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
function hint() { return 'ローカル: GCHAIN_WHISPER_BIN と GCHAIN_WHISPER_MODEL（whisper.cpp）。クラウド: OPENAI_API_KEY。'; }

module.exports = {
  FFMPEG, FFPROBE, detectBackend, hasFfmpeg, hasFfprobe, probeChannels,
  splitChannels, toMono16k, parseTimestamp, parseWhisperJson, parseOpenAiJson,
  transcribeChannel, transcribeStereo, transcribeMono, hint,
};
