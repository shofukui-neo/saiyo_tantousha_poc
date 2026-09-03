'use strict';
/**
 * インテント観測台帳（層2の“履歴”）— data/intent/ 配下のJSONに永続化
 * ============================================================================
 * 「新設／切り替え」は前回観測との差分でしか言えない。ここが無いと
 * 採用専用メールの“新設”も採用ページの“リニューアル”も永久に「保有」止まりになる。
 *
 *  observations.json … 社ごとの最新観測（メール一覧/採用ページの指紋/LINE/インターン件数/採用予定人数）
 *                      ＋ シグナルの検知履歴（初回検知日・最終検知日・回数）
 *  runs/<ts>.json    … 1サイクルの結果（監査用。監視層 monitor/store.js と同じ思想）
 *
 * 名寄せキーは csv.js の mergeKey と同じ思想（法人番号 → 正規化社名）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normCorpNumber, normCompanyName } = require('../csv');

const DIR = path.resolve(__dirname, '..', '..', 'data', 'intent');
const RUN_DIR = path.join(DIR, 'runs');
const OBS = path.join(DIR, 'observations.json');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return def; } }
// アトミック書き込み（既存ビルダと同じ tmp→rename。Windows の EPERM はフォールバック）
function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  const body = JSON.stringify(obj, null, 1);
  fs.writeFileSync(tmp, body);
  try { fs.renameSync(tmp, p); return; } catch (e) { /* fallthrough */ }
  try { fs.writeFileSync(p, body); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
}

// 社の同定キー: 法人番号 > corpID（マイナビ） > 正規化社名
function companyKey(rec) {
  const cn = normCorpNumber(rec['法人番号']);
  if (cn) return 'C:' + cn;
  const corp = String(rec.corpID || rec['corpID'] || '').trim();
  if (corp) return 'M:' + corp;
  const nm = normCompanyName(rec['企業名'] || rec.企業名 || '');
  return nm ? 'N:' + nm : null;
}

function loadObservations() {
  const st = readJson(OBS, null);
  if (st && st.companies) return st;
  return { version: 1, updatedAt: null, companies: {} };
}
function saveObservations(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(OBS, state);
  return OBS;
}
function saveRun(run) {
  const ts = String(run.cycle || new Date().toISOString()).replace(/[:.]/g, '-');
  const p = path.join(RUN_DIR, ts + '.json');
  writeJson(p, run);
  return p;
}

// テキストの指紋（採用ページの作り替え検知に使う。空白差では動かないよう正規化してから取る）
function fingerprint(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

// 前回観測（signals.detectAll の prev に渡す形）
function prevOf(state, key) {
  const c = state.companies[key];
  if (!c) return null;
  return {
    メール: Array.isArray(c.メール) ? c.メール : null,
    採用予定人数: c.採用予定人数 != null ? c.採用予定人数 : null,
    採用ページ: c.採用ページ || null,
    LINE: c.LINE || null,
    インターン: c.インターン || null,
    合説: c.合説 || null,
    シグナル: c.シグナル || {},
    最終観測: c.最終観測 || null,
    観測回数: c.観測回数 || 0,
  };
}

/**
 * 今回の検知シグナルと、前回まで生きているシグナルを合成する。
 *   - 今回検知 → 最終検知日を今日に更新（＝減衰リセット）
 *   - 今回未検知でも過去に検知済 → 過去の検知日のまま持ち越し（時間で自然に減衰して消える）
 *   - 減衰が weakFloor を下回ったものは落とす（4半減期＝約6%で消える）
 */
function mergeSignals(prevSignals, hits, { now = new Date(), weakFloor = 0.06 } = {}) {
  const out = {};
  const today = now.toISOString().slice(0, 10);
  for (const [id, s] of Object.entries(prevSignals || {})) {
    const half = s.半減期日 || 60;
    const days = Math.max(0, (now.getTime() - new Date(s.最終検知日 || s.初回検知日 || today).getTime()) / 86400000);
    if (Math.pow(0.5, days / half) < weakFloor) continue; // 賞味期限切れ
    out[id] = { ...s, 継続: false };
  }
  for (const h of hits || []) {
    const prev = out[h.signal];
    out[h.signal] = {
      signal: h.signal, 名称: h.名称, 列: h.列, weight: h.weight, 半減期日: h.半減期日,
      level: h.level, strength: h.strength, 根拠: h.根拠, 詳細: h.詳細,
      初回検知日: (prev && prev.初回検知日) || h.検知日,
      最終検知日: h.検知日,
      検知回数: ((prev && prev.検知回数) || 0) + 1,
      継続: !!prev,
    };
  }
  return out;
}

// 台帳に保存されたシグナル群を、scoreIntent が食える hit 配列に戻す
function signalsToHits(signals) {
  return Object.values(signals || {}).map((s) => ({
    signal: s.signal, 名称: s.名称, 列: s.列, weight: s.weight, 半減期日: s.半減期日,
    level: s.level, strength: s.strength, 根拠: s.根拠, 詳細: s.詳細 || {},
    検知日: s.最終検知日 || s.初回検知日,
  }));
}

/**
 * 1社ぶんの観測を台帳に書き込む。戻り値は合成後のシグナル群。
 * @param {object} state loadObservations() の状態
 * @param {string} key companyKey()
 * @param {object} ev collect.js のエビデンス
 * @param {Array} hits signals.detectAll の結果
 */
function record(state, key, ev, hits, { now = new Date() } = {}) {
  const iso = now.toISOString();
  const cur = state.companies[key] || { 初回観測: iso, 観測回数: 0, シグナル: {} };
  const merged = mergeSignals(cur.シグナル, hits, { now });

  state.companies[key] = {
    企業名: ev.企業名 || cur.企業名 || '',
    corpID: ev.corpID || cur.corpID || '',
    初回観測: cur.初回観測 || iso,
    最終観測: iso,
    観測回数: (cur.観測回数 || 0) + 1,
    // 次サイクルの差分に必要な“状態”だけを持つ（本文は持たない＝台帳が太らない）
    // メールは「今回1件も取れなかった系統」で上書きしない（jobs だけの追い足し実行で
    // 過去に集めたアドレス一覧を消すと、次回の“新設”判定が壊れる）。
    メール: (ev.メール && ev.メール.length) ? ev.メール.map((e) => (typeof e === 'string' ? e : e.email)) : (cur.メール || null),
    採用予定人数: ev.採用予定人数 != null && ev.採用予定人数 !== '' ? ev.採用予定人数 : (cur.採用予定人数 != null ? cur.採用予定人数 : null),
    採用ページ: ev.採用ページ || cur.採用ページ || null,
    LINE: ev.LINE || cur.LINE || null,
    インターン: ev.インターン件数 != null ? { 件数: ev.インターン件数 } : (cur.インターン || null),
    合説: ev.合説出展 != null ? { 出展: !!ev.合説出展 } : (cur.合説 || null),
    シグナル: merged,
  };
  return merged;
}

// 既存資産から baseline を敷く（初回から「新設」を言えるようにするための種まき）。
// 例: 統合マスタのメール列を「前回観測のメール」として入れておくと、
//     今回そこに無い採用アドレスが見つかった社は初回から“新設”として立つ。
function seedBaseline(state, rows, { source = 'seed', now = new Date() } = {}) {
  const iso = now.toISOString();
  let n = 0;
  for (const r of rows || []) {
    const key = companyKey(r);
    if (!key || state.companies[key]) continue; // 既に観測がある社は触らない
    const mail = String(r['メール'] || '').trim().toLowerCase();
    const page = String(r['採用ページURL'] || '').trim();
    state.companies[key] = {
      企業名: r['企業名'] || '', corpID: String(r.corpID || '').trim(),
      初回観測: iso, 最終観測: null, 観測回数: 0, baseline: source,
      // メールは「実際に載っていた行」だけを baseline にする。空配列で敷くと
      // “当時は未収集だっただけ”の社が全部「新設」に化けるため、欠測は null（履歴なし）のまま置く。
      メール: mail ? [mail] : null,
      採用予定人数: null,
      採用ページ: page && !/job\.mynavi\.jp/.test(page) ? { url: page, hash: '', 長さ: 0 } : null,
      LINE: null, インターン: null, 合説: null, シグナル: {},
    };
    n++;
  }
  return n;
}

module.exports = {
  DIR, OBS, RUN_DIR,
  loadObservations, saveObservations, saveRun,
  companyKey, prevOf, record, mergeSignals, signalsToHits, seedBaseline, fingerprint,
};
