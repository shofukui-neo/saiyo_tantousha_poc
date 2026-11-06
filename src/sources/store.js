'use strict';
/**
 * 観測ストア ── ソースごとの観測スナップショット（JSONL・日付単位）
 * =====================================================================
 *   data/obs/<source_id>/<YYYY-MM-DD>.jsonl   1行=1観測。同じ日に再収集したら上書き
 *   data/obs-raw/<source_id>/<file>           ダウンロードした原本（再収集時のキャッシュ）
 *   data/obs/_kpi/history.jsonl               スコアカードの履歴
 *
 * 差分系のシグナル（新規掲載・件数増）は、同じソースの2つのスナップショットを比べて出す。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OBS_DIR = path.join(ROOT, 'data', 'obs');
const RAW_DIR = path.join(ROOT, 'data', 'obs-raw');

const ymd = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function atomicWrite(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function writeSnapshot(sourceId, observations, date = ymd()) {
  const p = path.join(OBS_DIR, sourceId, `${date}.jsonl`);
  atomicWrite(p, observations.map((o) => JSON.stringify(o)).join('\n') + (observations.length ? '\n' : ''));
  return p;
}

function listSnapshots(sourceId) {
  const dir = path.join(OBS_DIR, sourceId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(dir, f));
}

function readSnapshot(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 最新スナップショット（無ければ null）。 */
function latestSnapshot(sourceId) {
  const all = listSnapshots(sourceId);
  if (!all.length) return null;
  const p = all[all.length - 1];
  return { path: p, date: path.basename(p, '.jsonl'), observations: readSnapshot(p) };
}

function rawDir(sourceId) { return path.join(RAW_DIR, sourceId); }

function appendKpiHistory(entry) {
  const p = path.join(OBS_DIR, '_kpi', 'history.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  return p;
}

module.exports = { OBS_DIR, RAW_DIR, ymd, atomicWrite, writeSnapshot, listSnapshots, readSnapshot, latestSnapshot, rawDir, appendKpiHistory };
