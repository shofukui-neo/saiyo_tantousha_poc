'use strict';
/**
 * G-Chain OS v2.1 — 通話音声キャプチャ（FFmpeg / Windows dshow・堅牢版）。
 *
 * 左ch=マイク(自分) / 右ch=システム音声(相手) のステレオwav（16kHz）を録る。
 * 各入力を一旦モノラル化してから L/R に join するため、ステレオマイクでも安定。
 * → STTが各chを別々に文字起こしするので話者が確定する（ダイアライゼーション不要）。
 *
 * 前提: PCソフトフォン通話。システム音声取得には「ステレオミキサー」有効化 or VB-CABLE等。
 * 環境変数: GCHAIN_FFMPEG, GCHAIN_MIC, GCHAIN_SYS
 */
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const FFMPEG = process.env.GCHAIN_FFMPEG || 'ffmpeg';

function ffmpegAvailable() {
  try { return spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0; } catch (e) { return false; }
}

/** dshow のオーディオ入力デバイス一覧。 */
function listDevices() {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' });
  const out = (r.stderr || '') + (r.stdout || '');
  const devices = [];
  let audio = false;
  for (const line of out.split(/\r?\n/)) {
    if (/DirectShow audio devices/.test(line)) { audio = true; continue; }
    if (/DirectShow video devices/.test(line)) { audio = false; continue; }
    const m = line.match(/"([^"]+)"/);
    if (audio && m) devices.push(m[1]);
  }
  return devices;
}

/** デバイス指定の妥当性チェック。返り値 { ok, mic, sys, missing:[] }。 */
function validateDevices(opts) {
  const o = opts || {};
  const mic = o.mic || process.env.GCHAIN_MIC;
  const sys = o.system || process.env.GCHAIN_SYS;
  const missing = [];
  if (!mic) missing.push('GCHAIN_MIC(マイク)');
  if (!sys) missing.push('GCHAIN_SYS(システム音声)');
  let devs = [];
  try { devs = listDevices(); } catch (e) {}
  if (mic && devs.length && !devs.includes(mic)) missing.push(`マイク"${mic}"がデバイス一覧に無い`);
  if (sys && devs.length && !devs.includes(sys)) missing.push(`システム音声"${sys}"がデバイス一覧に無い`);
  return { ok: missing.length === 0, mic, sys, devices: devs, missing };
}

/**
 * ステレオ録音を開始。返り値 { proc, wav, stop() }。
 * mic を左ch、system を右chへ。stop() で正常終了し wav パスを resolve。
 */
function startRecording(wav, opts) {
  const v = validateDevices(opts);
  if (!v.ok) throw new Error('デバイス未設定/不一致: ' + v.missing.join(' / ') + '（voice devices で確認）');
  const args = [
    '-hide_banner', '-y',
    '-f', 'dshow', '-i', 'audio=' + v.mic,
    '-f', 'dshow', '-i', 'audio=' + v.sys,
    '-filter_complex',
    '[0:a]aresample=16000,aformat=channel_layouts=mono[a0];' +
    '[1:a]aresample=16000,aformat=channel_layouts=mono[a1];' +
    '[a0][a1]join=inputs=2:channel_layout=stereo[a]',
    '-map', '[a]', '-ac', '2', '-ar', '16000',
    wav,
  ];
  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

  return {
    proc, wav,
    stop() {
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, arg) => { if (done) return; done = true; fn(arg); };
        proc.on('close', () => {
          if (fs.existsSync(wav) && fs.statSync(wav).size > 1024) finish(resolve, wav);
          else finish(reject, new Error('録音ファイルが空です。デバイス/権限を確認してください。\n' + stderr.slice(-400)));
        });
        proc.on('error', (e) => finish(reject, e));
        // 正常終了要求 → だめなら SIGINT → 最後に SIGKILL
        try { proc.stdin.write('q'); } catch (e) { try { proc.kill('SIGINT'); } catch (_) {} }
        setTimeout(() => { try { proc.kill('SIGINT'); } catch (e) {} }, 2000);
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 6000);
      });
    },
  };
}

module.exports = { FFMPEG, ffmpegAvailable, listDevices, validateDevices, startRecording };
