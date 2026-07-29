'use strict';
/**
 * G-Chain OS v2.1 — 通話レコードの永続化（蓄積の土台）。
 * 1通話 = 1 JSON（data/gchain/calls/）。音声/文字起こしはローカルのみ（PII非送信）。
 */
const fs = require('fs');
const path = require('path');

const CALLS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'gchain', 'calls');

function ensureDir() { fs.mkdirSync(CALLS_DIR, { recursive: true }); }

/** call_id を生成（開始時刻＋連番的サフィックス）。startedAt は ISO 文字列。 */
function newCallId(startedAt, company) {
  const t = String(startedAt || '').replace(/[-:T.]/g, '').slice(0, 14) || 'call';
  const slug = (company || '').replace(/[^0-9A-Za-z一-龠ぁ-んァ-ヶ]/g, '').slice(0, 12);
  return `${t}${slug ? '-' + slug : ''}`;
}

function saveCall(record) {
  ensureDir();
  const id = record.call_id || newCallId(record.started_at, record.company);
  record.call_id = id;
  const p = path.join(CALLS_DIR, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify(record, null, 2));
  return p;
}

function loadCall(callId) {
  const p = path.join(CALLS_DIR, `${callId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 全通話を読み込み（started_at 降順）。opts.limit で上限。 */
function loadCalls(opts) {
  ensureDir();
  const o = opts || {};
  const files = fs.readdirSync(CALLS_DIR).filter((f) => f.endsWith('.json'));
  const recs = [];
  for (const f of files) {
    try { recs.push(JSON.parse(fs.readFileSync(path.join(CALLS_DIR, f), 'utf8'))); } catch (e) { /* skip broken */ }
  }
  recs.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  return o.limit ? recs.slice(0, o.limit) : recs;
}

module.exports = { CALLS_DIR, ensureDir, newCallId, saveCall, loadCall, loadCalls };
