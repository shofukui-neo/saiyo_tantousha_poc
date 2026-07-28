'use strict';
/**
 * G-Chain OS v2.1 — 通話音声キャプチャ（FFmpeg / Windows dshow）。
 *
 * 左ch=マイク(自分) / 右ch=システム音声(相手) のステレオwavを録る。
 * → STTが各chを別々に文字起こしするため話者が確定する（ダイアライゼーション不要）。
 *
 * 前提: PCのソフトフォン/ブラウザ通話。システム音声取得には Windows「ステレオミキサー」有効化
 *       または仮想オーディオ(VB-CABLE等)が必要。デバイス名は listDevices() で確認。
 * 環境変数: GCHAIN_FFMPEG, GCHAIN_MIC（マイク名）, GCHAIN_SYS（システム音声デバイス名）
 */
const { spawn, spawnSync } = require('child_process');

const FFMPEG = process.env.GCHAIN_FFMPEG || 'ffmpeg';

/** dshow のオーディオ入力デバイス一覧を取得。 */
function listDevices() {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' });
  const out = (r.stderr || '') + (r.stdout || '');
  const devices = [];
  let audioSection = false;
  for (const line of out.split(/\r?\n/)) {
    if (/DirectShow audio devices/.test(line)) { audioSection = true; continue; }
    if (/DirectShow video devices/.test(line)) { audioSection = false; continue; }
    const m = line.match(/"([^"]+)"/);
    if (audioSection && m) devices.push(m[1]);
  }
  return devices;
}

function ffmpegAvailable() {
  try { return spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0; } catch (e) { return false; }
}

/**
 * ステレオ録音を開始。返り値 { proc, stop() }。
 * outWav: 出力先。opts: { mic, system }（省略時 env）。
 * mic を左、system を右へ join。stop() で 'q' を送り正常終了。
 */
function startRecording(outWav, opts) {
  const o = opts || {};
  const mic = o.mic || process.env.GCHAIN_MIC;
  const sys = o.system || process.env.GCHAIN_SYS;
  if (!mic || !sys) throw new Error('マイク/システム音声デバイス未指定（GCHAIN_MIC/GCHAIN_SYS か listDevices で確認）');
  const args = [
    '-hide_banner', '-y',
    '-f', 'dshow', '-i', 'audio=' + mic,
    '-f', 'dshow', '-i', 'audio=' + sys,
    '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]',
    '-map', '[a]', '-ac', '2', '-ar', '16000',
    outWav,
  ];
  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  return {
    proc,
    stop() {
      return new Promise((resolve) => {
        proc.on('close', () => resolve(outWav));
        try { proc.stdin.write('q'); } catch (e) { try { proc.kill('SIGINT'); } catch (_) {} }
      });
    },
  };
}

module.exports = { FFMPEG, listDevices, ffmpegAvailable, startRecording };
