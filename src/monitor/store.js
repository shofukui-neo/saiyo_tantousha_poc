'use strict';
// モニタリングの状態永続化層。すべて data/monitor/ 配下のJSONに置く。
//  - スナップショット: 1サイクルの観測結果。snapshots/<ts>.json に保存し、last-snapshot.json で直前を指す。
//  - 熱量状態:        heat-state.json（社ごとの heat と履歴。減衰・加点はここに蓄積）。
//  - クエリ状態:      queries.json（自律ブレインが増殖/撤退を管理）。
// ディスク永続なので、--once を cron で叩いても --watch 常駐でも中断・再開して継続できる。
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', 'data', 'monitor');
const SNAP_DIR = path.join(DIR, 'snapshots');
const LAST = path.join(DIR, 'last-snapshot.json');
const HEAT = path.join(DIR, 'heat-state.json');
const QUERIES = path.join(DIR, 'queries.json');

function ensureDir() { fs.mkdirSync(SNAP_DIR, { recursive: true }); }
function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return def; } }
// アトミック書き込み（クラッシュ時の途中切れ防止）。既存ビルダと同じ tmp→rename。
function writeJson(p, obj) {
  ensureDir();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// ---- スナップショット ----
function saveSnapshot(snap) {
  ensureDir();
  const safe = String(snap.cycle).replace(/[:.]/g, '-');
  writeJson(path.join(SNAP_DIR, safe + '.json'), snap);
  writeJson(LAST, snap);
}
function loadLastSnapshot() { return readJson(LAST, null); }

// ---- 熱量状態 ----
function loadHeatState() { return readJson(HEAT, {}); }
function saveHeatState(state) { writeJson(HEAT, state); }

// ---- クエリ状態（自律ブレイン用） ----
function loadQueryState() { return readJson(QUERIES, null); }
function saveQueryState(state) { writeJson(QUERIES, state); }

module.exports = {
  DIR, SNAP_DIR,
  saveSnapshot, loadLastSnapshot,
  loadHeatState, saveHeatState,
  loadQueryState, saveQueryState,
};
