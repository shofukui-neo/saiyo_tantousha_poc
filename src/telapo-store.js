'use strict';
/**
 * telapo-store — 架電台帳・録音の永続化層
 * =====================================================================
 * テレアポ分析システムの記録層。依存なし（Node標準fsのみ）。
 *
 * ■ 保存先（いずれも .gitignore の data/** で既定コミット対象外＝機微データ保護）
 *   - 台帳     : data/telapo/calls.jsonl   … 1架電=1行のJSON（追記のみ／堅牢）
 *   - 録音     : data/recordings/<id>.<ext> … 通話音声（マイク録音 or アップロード）
 *
 * ■ 台帳レコード（1架電）
 *   {
 *     id, ts,                      // 一意ID・記録時刻(ISO)
 *     company, operator, phone,    // 架電先/架電者/電話番号
 *     industry, empSize, ats,      // 業種/従業員規模/利用中ATS（属性別分析の軸）
 *     durationSec, audioFile,      // 通話秒数・録音ファイル名（無ければ空）
 *     result,                      // コール結果（RESULT_OPTIONS）
 *     transcript, memo,            // 文字起こし（手入力）・補足メモ
 *     refusalReason,               // 断り理由カテゴリ（お断り時）
 *     talkElements,                // アポ獲得トーク要素（配列）
 *     nextAction, pending          // 次アクション・ペンディング理由（任意）
 *   }
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 既定は data/。テスト等では TELAPO_DATA_DIR で保存先を差し替え可能（実データを汚さない）。
const DATA = process.env.TELAPO_DATA_DIR ? path.resolve(process.env.TELAPO_DATA_DIR) : path.join(ROOT, 'data');
const TELAPO_DIR = path.join(DATA, 'telapo');
const LEDGER = path.join(TELAPO_DIR, 'calls.jsonl');
const REC_DIR = path.join(DATA, 'recordings');

// 音声MIME → 拡張子（ブラウザMediaRecorderは環境によりwebm/ogg/mp4を出す）
const EXT_BY_MIME = {
  'audio/webm': 'webm', 'audio/webm;codecs=opus': 'webm',
  'audio/ogg': 'ogg', 'audio/ogg;codecs=opus': 'ogg',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
};
const ALLOWED_EXT = new Set(['webm', 'ogg', 'm4a', 'aac', 'mp3', 'wav']);

function ensureDirs() {
  fs.mkdirSync(TELAPO_DIR, { recursive: true });
  fs.mkdirSync(REC_DIR, { recursive: true });
}

// 一意ID（時刻ソート可能な字句順・衝突回避のランダム尾部）。Date/乱数は実行時のみ使用。
function newId() {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); // YYYYMMDDhhmmss
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${t}-${rnd}`;
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  return EXT_BY_MIME[m] || EXT_BY_MIME[String(mime || '').toLowerCase()] || '';
}

// 録音バイナリを保存し、保存ファイル名を返す（サブディレクトリ脱出は不可）。
function saveRecording(id, buffer, mimeOrExt) {
  ensureDirs();
  let ext = extFromMime(mimeOrExt);
  if (!ext) ext = String(mimeOrExt || '').replace(/^\./, '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) ext = 'webm';
  const safeId = String(id).replace(/[^0-9a-zA-Z_-]/g, '');
  const file = `${safeId}.${ext}`;
  fs.writeFileSync(path.join(REC_DIR, file), buffer);
  return file;
}

// 録音の絶対パス（存在チェック＋ディレクトリ脱出防止）。無ければ null。
function recordingPath(file) {
  const base = path.basename(String(file || '')); // パストラバーサル防止
  if (!base) return null;
  const p = path.join(REC_DIR, base);
  return fs.existsSync(p) ? p : null;
}

// 台帳へ1架電を追記（追記のみ＝並行/クラッシュに強い）。整形済みレコードを返す。
function appendCall(rec) {
  ensureDirs();
  const row = normalizeRecord(rec);
  fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

// 入力を台帳スキーマへ整形（欠損は空/既定で埋める）。
function normalizeRecord(rec = {}) {
  const s = (v) => (v == null ? '' : String(v).trim());
  return {
    id: s(rec.id) || newId(),
    ts: s(rec.ts) || new Date().toISOString(),
    company: s(rec.company),
    operator: s(rec.operator),
    phone: s(rec.phone),
    industry: s(rec.industry),
    empSize: s(rec.empSize),
    ats: s(rec.ats),
    durationSec: Number.isFinite(+rec.durationSec) ? Math.max(0, Math.round(+rec.durationSec)) : 0,
    audioFile: s(rec.audioFile),
    result: s(rec.result),
    transcript: s(rec.transcript),
    memo: s(rec.memo),
    refusalReason: s(rec.refusalReason),
    talkElements: Array.isArray(rec.talkElements) ? rec.talkElements.map(s).filter(Boolean) : [],
    nextAction: s(rec.nextAction),
    pending: s(rec.pending),
  };
}

// 台帳を全読込（壊れた行はスキップ）。新しい順（ts降順）で返す。
function readCalls() {
  if (!fs.existsSync(LEDGER)) return [];
  const lines = fs.readFileSync(LEDGER, 'utf8').split('\n');
  const out = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* 壊れた行は無視 */ }
  }
  // 同一idは後勝ち（更新/削除tombstoneを反映）。
  const byId = new Map();
  for (const r of out) {
    if (r && r.id) byId.set(r.id, r);
  }
  const live = [...byId.values()].filter((r) => !r._deleted);
  live.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return live;
}

// 既存架電を部分更新（追記=後勝ちで反映）。見つからなければ null。
function updateCall(id, patch) {
  const cur = readCalls().find((r) => r.id === id)
    || (fs.existsSync(LEDGER) ? findRaw(id) : null);
  if (!cur) return null;
  const merged = normalizeRecord(Object.assign({}, cur, patch, { id, ts: cur.ts }));
  fs.appendFileSync(LEDGER, JSON.stringify(merged) + '\n', 'utf8');
  return merged;
}

// tombstone追記で論理削除（録音ファイルも掃除）。
function deleteCall(id) {
  const cur = findRaw(id);
  if (!cur) return false;
  if (cur.audioFile) { try { fs.unlinkSync(path.join(REC_DIR, path.basename(cur.audioFile))); } catch (_) {} }
  fs.appendFileSync(LEDGER, JSON.stringify({ id, ts: cur.ts, _deleted: true }) + '\n', 'utf8');
  return true;
}

function findRaw(id) {
  if (!fs.existsSync(LEDGER)) return null;
  const lines = fs.readFileSync(LEDGER, 'utf8').split('\n');
  let found = null;
  for (const ln of lines) {
    const t = ln.trim(); if (!t) continue;
    try { const r = JSON.parse(t); if (r && r.id === id) found = r; } catch (_) {}
  }
  return found && !found._deleted ? found : null;
}

module.exports = {
  paths: { DATA, TELAPO_DIR, LEDGER, REC_DIR },
  EXT_BY_MIME, ALLOWED_EXT,
  ensureDirs, newId, extFromMime,
  saveRecording, recordingPath,
  appendCall, normalizeRecord, readCalls, updateCall, deleteCall,
};
