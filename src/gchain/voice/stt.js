'use strict';
/**
 * G-Chain OS v2.1 — 文字起こし（STT）アダプタ（ハイブリッド）。
 *
 * 既定=ローカル whisper.cpp（音声を外部送信しない）。APIキーがあればクラウドSTTで高精度化。
 * ステレオwav（左ch=自分/右ch=相手）を各chで文字起こし → 話者確定のsegmentsに統合。
 *
 * 環境変数:
 *   GCHAIN_FFMPEG        ffmpegパス（既定 'ffmpeg'）
 *   GCHAIN_WHISPER_BIN   whisper-cli パス（whisper.cpp）
 *   GCHAIN_WHISPER_MODEL ggmlモデルパス（例 ggml-large-v3.bin）
 *   OPENAI_API_KEY       あればクラウドSTT（OpenAI互換 /audio/transcriptions）
 *   OPENAI_STT_URL/MODEL 既定 https://api.openai.com/v1 / whisper-1
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const https = require('https');

const FFMPEG = process.env.GCHAIN_FFMPEG || 'ffmpeg';

/** 利用可能なバックエンドを判定（cloud > whispercpp > none）。 */
function detectBackend() {
  if (process.env.OPENAI_API_KEY) return 'cloud';
  if (process.env.GCHAIN_WHISPER_BIN && process.env.GCHAIN_WHISPER_MODEL) return 'whispercpp';
  return 'none';
}

function hasFfmpeg() {
  try { return spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0; } catch (e) { return false; }
}

/** ステレオwavを左右chの2ファイルへ分離。返り値 { self, customer }。 */
function splitChannels(wavPath, tmpDir) {
  const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gchain-stt-'));
  const self = path.join(dir, 'self.wav');
  const cust = path.join(dir, 'customer.wav');
  run(FFMPEG, ['-y', '-i', wavPath, '-map_channel', '0.0.0', self, '-map_channel', '0.0.1', cust]);
  return { self, customer: cust, dir };
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} failed: ${(r.stderr || '').slice(-300)}`);
  return r.stdout;
}

/** whisper.cpp で1chを文字起こし → segments[{start,end,text}]。 */
function whisperCppChannel(wav) {
  const bin = process.env.GCHAIN_WHISPER_BIN;
  const model = process.env.GCHAIN_WHISPER_MODEL;
  const outBase = wav.replace(/\.wav$/, '');
  run(bin, ['-m', model, '-f', wav, '-l', 'ja', '-oj', '-of', outBase]);
  const j = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
  const segs = (j.transcription || j.segments || []).map((s) => ({
    start: toSec(s.offsets ? s.offsets.from : (s.t0 != null ? s.t0 * 10 : s.start)),
    end: toSec(s.offsets ? s.offsets.to : (s.t1 != null ? s.t1 * 10 : s.end)),
    text: (s.text || '').trim(),
  })).filter((s) => s.text);
  return segs;
}
function toSec(ms) { return ms == null ? 0 : Math.round(Number(ms) / 100) / 10; }

/** クラウドSTT（OpenAI互換 verbose_json）で1chを文字起こし。 */
function cloudChannel(wav) {
  const base = process.env.OPENAI_STT_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_STT_MODEL || 'whisper-1';
  const buf = fs.readFileSync(wav);
  const boundary = '----gchain' + Date.now();
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nja\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  parts.push(buf);
  push(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat(parts);
  const u = new URL(base + '/audio/transcriptions');
  const res = httpPost(u, body, {
    'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': body.length,
  });
  const j = JSON.parse(res);
  return (j.segments || []).map((s) => ({ start: s.start, end: s.end, text: (s.text || '').trim() })).filter((s) => s.text);
}

function httpPost(u, body, headers) {
  const { execFileSync } = require('child_process');
  // 依存を増やさず、同期HTTPSは https + deasync が無いため curl を利用（Windows同梱 or 要インストール）
  const tmp = path.join(os.tmpdir(), 'gchain-stt-body-' + Date.now() + '.bin');
  fs.writeFileSync(tmp, body);
  const args = ['-s', '-X', 'POST', u.toString()];
  for (const [k, v] of Object.entries(headers)) { if (k !== 'Content-Length') args.push('-H', `${k}: ${v}`); }
  args.push('--data-binary', '@' + tmp);
  try { return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

/** 1ch を選択バックエンドで文字起こし。 */
function transcribeChannel(wav, backend) {
  if (backend === 'cloud') return cloudChannel(wav);
  if (backend === 'whispercpp') return whisperCppChannel(wav);
  throw new Error('STTバックエンド未設定（OPENAI_API_KEY か GCHAIN_WHISPER_BIN/MODEL を設定、または --mock）');
}

/**
 * ステレオwav → 話者付きsegments。
 * opts: { backend, mock:[{speaker,start,end,text}] }
 * 返り値: { backend, segments:[{speaker,start,end,text}] }
 */
function transcribeStereo(wavPath, opts) {
  const o = opts || {};
  if (o.mock) return { backend: 'mock', segments: sortSegs(o.mock) };
  const backend = o.backend || detectBackend();
  if (backend === 'none') throw new Error('STT利用不可: ' + hint());
  if (!hasFfmpeg()) throw new Error('ffmpeg が見つかりません（GCHAIN_FFMPEG を設定）');
  const { self, customer, dir } = splitChannels(wavPath);
  try {
    const selfSegs = transcribeChannel(self, backend).map((s) => ({ ...s, speaker: 'self' }));
    const custSegs = transcribeChannel(customer, backend).map((s) => ({ ...s, speaker: 'customer' }));
    return { backend, segments: sortSegs([...selfSegs, ...custSegs]) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

function sortSegs(segs) {
  return [...segs].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
}
function hint() {
  return 'ローカル: GCHAIN_WHISPER_BIN と GCHAIN_WHISPER_MODEL を設定（whisper.cpp）。クラウド: OPENAI_API_KEY を設定。';
}

module.exports = { detectBackend, hasFfmpeg, splitChannels, transcribeChannel, transcribeStereo, hint };
