'use strict';
/**
 * G-Chain OS v2.0 — フロントエンド用 JSON API 層。
 * BALES/model をキャッシュし、queue/brief/analytics を JSON で返す純データ関数群。
 * server.js（Web）と ops.js（CLI）が共用。外部送信なし（localhost 前提）。
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../csv');
const G = require('./index');
const model = require('./model');
const balesMap = require('./bales-map');
const { buildExistingCustomerSet, NG_TYPES_BLOCK } = require('./ingest-wave0');

const DATA = path.join(__dirname, '..', '..', 'data');
const F_BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const RECYCLE_RE = /リサイクル|ペンディング|失注|情報収集/;

let _cache = null; // { balesMtime, modelMtime, recs, enriched, called, custSet, model, analytics }

function fileMtime(f) { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } }

function enrich(rec) {
  const { features, leak } = G.features.extractFeatures(rec);
  const labels = G.outcome.extractLabels(rec);
  const called = (rec['コール結果1：結果'] || '').trim() !== '';
  return { rec, features, labels, called, leak };
}

/** BALES/model をロード（mtime変化時のみ再読込）。 */
function context() {
  const bm = fileMtime(F_BALES);
  const mm = fileMtime(model.MODEL_PATH);
  if (_cache && _cache.balesMtime === bm && _cache.modelMtime === mm) return _cache;

  const rows = parseCsv(fs.readFileSync(F_BALES, 'utf8'));
  const head = rows[0];
  const recs = [];
  for (let r = 1; r < rows.length; r++) { const o = {}; head.forEach((h, i) => { o[h] = rows[r][i]; }); recs.push(o); }
  const enriched = recs.map(enrich);
  const called = enriched.filter((e) => e.called);
  let m = model.loadModel();
  if (!m) { m = model.trainModel(called, new Date().toISOString()); model.saveModel(m); }
  _cache = {
    balesMtime: bm, modelMtime: mm, recs, enriched, called,
    custSet: buildExistingCustomerSet(), model: m, analytics: null,
  };
  return _cache;
}

/** 再学習（Web/CLIのTrainボタン）。 */
function retrain() {
  const ctx = context();
  const m = model.trainModel(ctx.called, new Date().toISOString());
  model.saveModel(m);
  _cache.model = m; _cache.modelMtime = fileMtime(model.MODEL_PATH); _cache.analytics = null;
  return { trainedAt: m.trainedAt, n: m.n, base: m.base };
}

function refToday() {
  const today = new Date().toISOString().slice(0, 10);
  return { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)), today };
}

function reactivationOf(rec, ref) {
  return G.reactivation.reactivationPriority({
    consider_timing: rec['カスタム情報：検討開始時期'],
    renewal_month: rec['カスタム情報：現利用サービス更新予定月'],
    next_action_date: rec['カスタム情報：失注後次回アクション日'],
    loss_date: rec['カスタム情報：失注商談失注日'],
  }, ref);
}

/** 1レコード → ブリーフ JSON（フロントのスコアカード）。 */
function briefOf(rec, ctx) {
  const s = model.scoreRecord(rec, ctx.model);
  const company = (rec['会社情報：会社名'] || '').trim();
  const stage = (rec['リード関連情報：最終リードステージ'] || '').trim();
  const ng = (rec['カスタム情報：アプローチ禁止の種類'] || '').trim();
  const nname = G.normalize.normCompanyName(company);
  const ref = refToday();
  const react = RECYCLE_RE.test(stage) ? reactivationOf(rec, ref) : { priority: 0, reasons: [] };
  const disc = G.discipline.recordDiscipline(rec, ref.today);
  const lift = s.appointment_score / (ctx.model.base.appointment || 1);
  return {
    company, stage,
    ng_blocked: !!(ng && NG_TYPES_BLOCK.has(ng)), ng_type: ng,
    existing_customer: !!(nname && ctx.custSet.has(nname)),
    appointment_score: s.appointment_score, appointment_lift: round2(lift),
    connection_score: s.connection_score,
    base_appointment: ctx.model.base.appointment,
    icp_band: s.features.icp_band, recruit_size: s.features.recruit_size,
    industry: s.features.industry, source: s.features.source, current_ats: s.features.current_ats,
    ats_signal: s.ats_signal,
    factors: s.top_factors,
    best_bands: s.best_bands,
    reactivation_priority: react.priority, reactivation_reasons: react.reasons,
    overdue_followups: disc.overdue,
    phone: (rec['会社情報：電話'] || '').trim(),
    person: [(rec['担当者情報：姓'] || '').trim(), (rec['担当者情報：名'] || '').trim()].join(' ').trim(),
    recommendation: recommend(s, stage, ng, ctx.model),
  };
}

function recommend(s, stage, ng, m) {
  if (ng && NG_TYPES_BLOCK.has(ng)) return '架電対象外（アプローチ禁止）';
  const lift = s.appointment_score / (m.base.appointment || 1);
  const bandJp = { am: '午前', noon: '昼', pm: '午後', eve: '夕方' };
  const best = s.best_bands[0] ? bandJp[s.best_bands[0].band] : '午前';
  if (lift >= 1.5) return `優先架電。${best}に架電し、ATS/課題で具体訴求`;
  if (lift >= 1.0) return `通常優先。${best}に架電`;
  if (RECYCLE_RE.test(stage)) return '再活性化キューで時期到来時に架電';
  return '優先度低。上位リードを先に';
}

/** 会社名で検索 → ブリーフ配列。 */
function search(q, limit) {
  const ctx = context();
  const nq = G.normalize.normCompanyName(q || '');
  if (!nq) return [];
  const out = [];
  for (const rec of ctx.recs) {
    const n = G.normalize.normCompanyName(rec['会社情報：会社名'] || '');
    if (n && (n === nq || n.indexOf(nq) >= 0 || nq.indexOf(n) >= 0)) {
      out.push(briefOf(rec, ctx));
      if (out.length >= (limit || 20)) break;
    }
  }
  return out;
}

/** 本日のコールキュー（NEW＋REACTIVATE）JSON。 */
function queue(opts) {
  const o = opts || {};
  const ctx = context();
  const ref = refToday();
  const rows = [];
  for (const rec of ctx.recs) {
    const called = (rec['コール結果1：結果'] || '').trim() !== '';
    const stage = (rec['リード関連情報：最終リードステージ'] || '').trim();
    const ng = (rec['カスタム情報：アプローチ禁止の種類'] || '').trim();
    if (ng && NG_TYPES_BLOCK.has(ng)) continue;
    const react = RECYCLE_RE.test(stage) ? reactivationOf(rec, ref) : { priority: 0, reasons: [] };
    const isReact = react.priority > 0 && RECYCLE_RE.test(stage);
    if (called && !isReact) continue;
    const s = model.scoreRecord(rec, ctx.model);
    rows.push({
      company: (rec['会社情報：会社名'] || '').trim(),
      type: !called ? 'NEW' : 'REACTIVATE',
      appointment_score: s.appointment_score,
      reactivation_priority: react.priority,
      rank_score: s.appointment_score + react.priority / 200,
      best_band: s.best_bands[0] ? s.best_bands[0].band : '',
      icp_band: s.features.icp_band, source: s.features.source, recruit_size: s.features.recruit_size,
      industry: s.features.industry,
      phone: (rec['会社情報：電話'] || '').trim(),
      reason: react.priority > 0 ? react.reasons.join('; ') : (s.top_factors[0] ? s.top_factors[0].key + '=' + s.top_factors[0].value : ''),
    });
  }
  rows.sort((a, b) => b.rank_score - a.rank_score);
  let filtered = rows;
  if (o.type && o.type !== 'ALL') filtered = filtered.filter((r) => r.type === o.type);
  if (o.q) {
    const nq = G.normalize.normCompanyName(o.q);
    filtered = filtered.filter((r) => G.normalize.normCompanyName(r.company).indexOf(nq) >= 0);
  }
  return { total: rows.length, shown: Math.min(o.limit || 100, filtered.length), rows: filtered.slice(0, o.limit || 100) };
}

/** 全体分析 JSON（接続ファネル・リフト・失注・規律）。キャッシュ。 */
function analytics() {
  const ctx = context();
  if (ctx.analytics) return ctx.analytics;
  const called = ctx.called;
  const apptLabel = (e) => e.labels.appointment;
  const base = ctx.model.base;

  const liftFor = (key) => G.outcome.liftByFeature(called, (e) => e.features[key], apptLabel, { minN: 50, base: base.appointment }).slice(0, 12);

  // 接続ファネル（結果分類から直接カウント）
  const funnel = { E0: c(), E1: c(), E2: c() };
  function c() { return { TRUE: 0, FALSE: 0, UNKNOWN: 0 }; }
  for (const e of called) {
    const parsed = balesMap.toObservations(e.rec, { callId: 'x', observationBase: 'x' });
    const m = parsed.meta;
    tally(funnel.E0, m.e0); tally(funnel.E1, m.e1); tally(funnel.E2, m.e2);
  }
  function tally(o, v) { if (v === true) o.TRUE++; else if (v === false) o.FALSE++; else o.UNKNOWN++; }

  // 失注
  const lost = called.filter((e) => e.labels.lost).map((e) => e.rec);
  const loss = G.lossIntel.summarizeLoss(lost, (r) => (r['カスタム情報：失注商談失注理由大'] || '').trim());

  // 規律（所有者別）
  const disc = G.discipline.disciplineByOwner(ctx.recs, refToday().today, (r) => (r['リード関連情報：リード所有者'] || '').trim()).slice(0, 12);

  const result = {
    quality: { total: ctx.recs.length, called: called.length, uncalled: ctx.recs.length - called.length, trainedAt: ctx.model.trainedAt },
    base,
    funnel,
    lift: {
      source: liftFor('source'), current_ats: liftFor('current_ats'),
      recruit_size: liftFor('recruit_size'), call_band: liftFor('call_band'),
      industry: liftFor('industry'),
    },
    loss,
    discipline: disc,
  };
  ctx.analytics = result;
  return result;
}

function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

module.exports = { context, retrain, briefOf, search, queue, analytics };
