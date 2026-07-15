/* ============================================================================
 * G-Chain OS v1.5 — GAS オーケストレーション層（詳細設計書 §2, §12）
 *
 * 上のバンドル部（GChain.*）は src/gchain/*.js の単一正本から build-gas.js が生成。
 * ここは Sheets/Drive I/O と SYNC-0..6・18→01再生成・保護を担う薄いGAS層。
 * 依存: SpreadsheetApp / DriveApp（会社Workspace）。外部API依存ゼロ（baseline §0.2）。
 * ========================================================================== */

var GC = GChain; // 短縮

/** メニュー（onOpen）。人手操作の入口。 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('G-Chain OS')
    .addItem('初期セットアップ（19シート生成）', 'gcSetup')
    .addItem('日次同期 SYNC-0..6', 'gcRunSync')
    .addItem('二枠選定を提示', 'gcProposeSampling')
    .addItem('01を18から再生成', 'gcRegenerateAll')
    .addToUi();
}

/** 初期セットアップ: schema から全シートを生成し、生成ビューを保護（詳細§1.2, §3）。 */
function gcSetup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = GC.schema.SHEETS;
  Object.keys(sheets).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = GC.schema.physicalColumns(name);
    if (sh.getLastRow() === 0) sh.appendRow(cols);
    if (GC.schema.isGenerated(name)) _protect(sh); // 直接編集禁止
  });
  // 00_設定 既定投入
  _seedSettings(ss);
  SpreadsheetApp.getUi().alert('G-Chain OS: 19シート＋取込面を生成しました。');
}

function _protect(sh) {
  var p = sh.protect().setDescription('generated view — GAS only');
  p.removeEditors(p.getEditors());
  p.setWarningOnly(true); // 誤編集警告（サービスアカウント運用時は false + editor限定）
}

function _seedSettings(ss) {
  var sh = ss.getSheetByName('00_設定');
  if (sh.getLastRow() > 1) return; // 既投入
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var rows = GC.config.seedRows(today);
  var out = rows.map(function (r) { return [r.key, r.value, r.valid_from, r.valid_until, '']; });
  if (out.length) sh.getRange(2, 1, out.length, 5).setValues(out);
}

/** 日次同期 SYNC-0..6（詳細§2.2）。冪等・batch状態遷移。 */
function gcRunSync() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var batchId = _newBatchId(ss);
  _setBatchState(ss, batchId, 'STARTED');
  try {
    var ingested = _sync4_normalizeAndIngest(ss, batchId); // 列認識・型変換・source_event_id・18投入
    _setBatchState(ss, batchId, 'NORMALIZED');
    _sync5_qualityReport(ss, batchId, ingested);            // 件数一致・重複・名寄せ率・metric_coverage
    gcRegenerateAll();                                      // 18→01再生成
    _setBatchState(ss, batchId, 'GENERATED');
    _sync6_snapshotAndClear(ss, batchId);                   // Drive保存→取込面クリア
    _setBatchState(ss, batchId, 'DONE');
  } catch (e) {
    _setBatchState(ss, batchId, 'FAILED');                  // 取込面はクリアしない（復旧のため）
    throw e;
  }
}

/** SYNC-4: 取込3面→正規化→18生観測投入（冪等キーで重複skip）。 */
function _sync4_normalizeAndIngest(ss, batchId) {
  var stats = { ingest_delta: 0, sources: {} };
  ['00_取込_BALES', '00_取込_SF', '00_取込_MiiTel'].forEach(function (src) {
    var rows = _readRows(ss, src);
    var existing = _existingIdempotencyKeys(ss);
    rows.forEach(function (row) {
      var fields = _extractFields(src, row);
      var key = GC.normalize.idempotencyKey(fields);
      if (existing[key]) return;          // 既存 → skip（増分ゼロ・詳細§2.3）
      _appendObservations(ss, src, batchId, fields, row);
      existing[key] = true;
      stats.ingest_delta++;
    });
    stats.sources[src] = rows.length;
  });
  return stats;
}

/** SYNC-5: 品質KPIを 12_データ品質 に記録（詳細§2.2）。 */
function _sync5_qualityReport(ss, batchId, stats) {
  var obs = _readRows(ss, '18_Eイベント明細');
  var deduped = GC.canonical.dedupeObservations(obs, { bucketSec: _setting(ss, 'dedup_time_bucket_sec') });
  var conflicts = GC.canonical.assertCanonicalUnique(deduped);
  var warnings = conflicts.length ? [{ code: 'CANONICAL_CONFLICT', detail: conflicts }] : [];
  _writeQuality(ss, batchId, {
    ingest_delta: stats.ingest_delta,
    warnings_json: JSON.stringify(warnings),
  });
}

/** SYNC-6: raw を Drive 制限フォルダへ保存し取込面をクリア（詳細§2.2, §14）。 */
function _sync6_snapshotAndClear(ss, batchId) {
  var folder = _rawFolder();
  ['00_取込_BALES', '00_取込_SF', '00_取込_MiiTel'].forEach(function (src) {
    var sh = ss.getSheetByName(src);
    var data = sh.getDataRange().getValues();
    folder.createFile(batchId + '_' + src + '.json', JSON.stringify(data), 'application/json');
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  });
}

/** 二枠選定を提示（詳細§6.1）。人はGASが選んだ通話だけ MiiTel を貼る。 */
function gcProposeSampling() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var e2Calls = _todayE2Calls(ss);
  var sel = GC.sampling.selectTranscripts(e2Calls, {
    metricSize: _setting(ss, 'metric_sample_size'),
    diagnosticSize: _setting(ss, 'diagnostic_size'),
  });
  var lines = ['[METRIC] ' + sel.metric.join(', '), '[DIAGNOSTIC] ' + sel.diagnostic.join(', ')];
  SpreadsheetApp.getUi().alert('本日の文字起こし対象:\n' + lines.join('\n'));
}

/** 01 を 18(is_canonical) から全再生成（詳細§4）。生成ビューは常にここでのみ更新。 */
function gcRegenerateAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var obs = _readRows(ss, '18_Eイベント明細');
  var deduped = GC.canonical.dedupeObservations(obs, { bucketSec: _setting(ss, 'dedup_time_bucket_sec') });
  var byCall = {};
  deduped.filter(function (r) { return r.is_canonical; }).forEach(function (r) {
    (byCall[r.call_id] = byCall[r.call_id] || []).push(r);
  });
  var nowSec = Math.floor(Date.now() / 1000);
  var win = _setting(ss, 'e8_attribution_days');
  var out = [];
  Object.keys(byCall).forEach(function (callId) {
    var events = byCall[callId];
    var meta = _callMeta(ss, callId);
    var r = GC.eventEngine.resolveCall({
      call_id: callId,
      event_observability: meta.event_observability,
      canonicalEvents: events,
      createdE7Records: _createdE7Records(ss, callId),
      flags: meta.flags,
      nowSec: nowSec,
      e8WindowDays: win,
    });
    out.push(_toCallRow(callId, meta, r));
  });
  _write01(ss, out);
}

/* ---- 以下は Sheets I/O ヘルパ（実運用で列マッピングに合わせ実装） ---- */
function _readRows(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getDataRange().getValues();
  var head = values[0];
  return values.slice(1).map(function (row) {
    var o = {}; head.forEach(function (h, i) { o[h] = row[i]; }); return o;
  });
}
function _setting(ss, key) {
  var rows = _readRows(ss, '00_設定');
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var v = GC.config.resolveSetting(rows, key, today);
  return v != null ? v : GC.config.DEFAULTS[key];
}
function _newBatchId(ss) {
  var d = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var q = _readRows(ss, '12_データ品質').filter(function (r) { return String(r.batch_id).indexOf(d) === 0; });
  return d + '-' + String(q.length + 1).padStart(3, '0');
}
function _setBatchState(ss, batchId, state) { _writeQuality(ss, batchId, { batch_state: state }); }
function _rawFolder() {
  var name = 'GChainOS_raw_restricted';
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
// 実装未確定の I/O は Wave 0 実データで確定（詳細 付録A）。以下はプレースホルダ。
function _existingIdempotencyKeys(ss) { return {}; }
function _extractFields(src, row) { return row; }
function _appendObservations(ss, src, batchId, fields, row) { /* 18へ生観測追記 */ }
function _writeQuality(ss, batchId, patch) { /* 12へ upsert */ }
function _todayE2Calls(ss) { return []; }
function _callMeta(ss, callId) { return { event_observability: 'NONE', flags: {} }; }
function _createdE7Records(ss, callId) { return []; }
function _toCallRow(callId, meta, r) { return [callId].concat(Object.keys(r.states).map(function (k) { return r.states[k]; })); }
function _write01(ss, rows) { /* 01へ再生成書込（保護を一時解除して更新） */ }
