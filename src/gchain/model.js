'use strict';
/**
 * G-Chain OS v2.0 — 学習モデルの構築・永続化（運用の心臓）。
 *
 * バッチ分析(ingest-structured)で毎回リフトを再計算する代わりに、モデルを一度学習して
 * JSON へ保存 → 架電前ブリーフ/キューが「即座に(リアルタイムに)」スコアを引けるようにする。
 * モデルは特徴値→平滑化率の集約テーブルのみ（個社情報を含まない）。
 * 純ロジック＋任意のファイル永続化（trainedAt は引数注入で決定性を保つ）。
 */
const fs = require('fs');
const path = require('path');
const { outcome } = require('./index'); // buildLiftModel/liftByFeature/baseRate
const features = require('./features');

const MODEL_PATH = path.join(__dirname, '..', '..', 'data', 'gchain', 'model.json');
const LIFT_KEYS = ['icp_band', 'recruit_size', 'source', 'industry', 'current_ats', 'consider_timing', 'call_band', 'call_weekday'];

/**
 * モデル学習（設計書 §4.2, §5）。
 * enriched: [{ features, labels }]（called のみを渡す）
 * trainedAt: ISO文字列（呼出側が注入）。
 * 返り値: { version, trainedAt, n, appointment:liftModel, connection:liftModel,
 *           connection_by_band, base:{...} }
 */
function trainModel(calledEnriched, trainedAt) {
  const apptLabel = (e) => e.labels.appointment;
  const connLabel = (e) => e.labels.connected;
  const featFn = (e) => e.features;

  const appointment = outcome.buildLiftModel(calledEnriched, LIFT_KEYS, featFn, apptLabel, { minN: 50 });
  const connection = outcome.buildLiftModel(calledEnriched, ['call_band', 'call_weekday', 'icp_band', 'source'], featFn, connLabel, { minN: 50 });

  // 接続の時間帯ランキング（架電前ブリーフで「いつ架けるべきか」を出す）
  const bandRows = outcome.liftByFeature(calledEnriched, (e) => e.features.call_band, connLabel, { minN: 50 });

  return {
    version: '2.0',
    trainedAt: trainedAt || null,
    n: calledEnriched.length,
    lift_keys: LIFT_KEYS,
    base: {
      appointment: outcome.baseRate(calledEnriched, apptLabel).rate,
      connection: outcome.baseRate(calledEnriched, connLabel).rate,
    },
    appointment,
    connection,
    connection_by_band: bandRows.map((r) => ({ band: r.value, rate: r.smoothed_rate, n: r.n })),
  };
}

function saveModel(model, file) {
  const p = file || MODEL_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(model, null, 2));
  return p;
}

function loadModel(file) {
  const p = file || MODEL_PATH;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * 1リードのリアルタイム・スコアリング（ブリーフ/キュー共通）。
 * rec: BALESレコード。model: trainModel の返り値。today/refMonth: 任意。
 * 返り値: { appointment_score, connection_score, top_factors, best_bands, ats_signal }
 */
function scoreRecord(rec, model) {
  const { features: f } = features.extractFeatures(rec);
  const appt = require('./index').outcome.scoreLead(f, model.appointment);
  const conn = require('./index').outcome.scoreLead(f, model.connection);
  const atsTable = model.appointment.features.current_ats || {};
  const atsSignal = (f.current_ats && f.current_ats in atsTable)
    ? { ats: f.current_ats, rate: atsTable[f.current_ats], lift: round2(atsTable[f.current_ats] / model.base.appointment) }
    : null;
  const bestBands = [...(model.connection_by_band || [])].sort((a, b) => b.rate - a.rate).slice(0, 3);
  return {
    appointment_score: appt.score,
    connection_score: conn.score,
    top_factors: appt.contributions.slice(0, 4),
    best_bands: bestBands,
    ats_signal: atsSignal,
    features: f,
  };
}

function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

module.exports = { MODEL_PATH, LIFT_KEYS, trainModel, saveModel, loadModel, scoreRecord };
