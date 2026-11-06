'use strict';
/**
 * ソース登録簿（src/sources/registry.json）の読込と検証
 * =====================================================================
 * リードの発生源はすべてここに1行ずつ登録する。パイプラインは登録簿を通らないソースを受け付けない。
 * 収集してよいかの判断（法務区分・規約の確認日）を、コードではなく登録簿の値で強制するための層。
 *
 *   const reg = require('./registry');
 *   reg.list()                 // 全ソース
 *   reg.get('kaigo-kouhyou')   // 1ソース（無ければ例外）
 *   reg.assertRunnable(src)    // 収集してよいか（T3・規約未確認・アダプタ無しは例外）
 *
 * 新卒媒体カタログの各媒体（src/sources/media.json）も、1媒体＝1ソースとしてここに合流する。
 */
const fs = require('fs');
const path = require('path');

const REGISTRY = path.join(__dirname, 'registry.json');
const TIERS = new Set(['T1', 'T2', 'T3']);

let cached = null;
function load() {
  if (!cached) cached = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  return cached;
}

function list() { return [...load().sources, ...require('./media-registry').entries()]; }

function get(id) {
  const s = list().find((x) => x.id === id);
  if (!s) throw new Error(`登録簿に無いソースです: ${id}（src/sources/registry.json に追加してください）`);
  return s;
}

/**
 * 登録内容の不備を列挙する（空配列なら健全）。
 * @param {object} s 登録簿の1行
 */
function problemsOf(s) {
  const p = [];
  if (!s.id) p.push('id が空');
  if (!TIERS.has(s.legal_tier)) p.push(`legal_tier が不正（${s.legal_tier}）`);
  if (s.adapter && !s.tos_checked_at) p.push('アダプタがあるのに tos_checked_at（規約の確認日）が空');
  if (s.adapter && !(s.reliability > 0 && s.reliability <= 1)) p.push('reliability は 0〜1');
  return p;
}

/**
 * 収集してよいか。だめなら理由つきで例外を投げる。
 * T3 は登録簿に載っていても収集しない（ログイン壁・規約禁止・robots不可）。
 */
function assertRunnable(s) {
  const p = problemsOf(s);
  if (p.length) throw new Error(`[${s.id}] 登録簿の不備: ${p.join(' / ')}`);
  if (s.legal_tier === 'T3') throw new Error(`[${s.id}] T3（${s.note || '収集不可'}）は収集しません`);
  if (s.status === 'excluded') throw new Error(`[${s.id}] 対象外のソースです（${s.note || ''}）`);
  if (!s.adapter) throw new Error(`[${s.id}] アダプタ未実装です（status=${s.status}）`);
}

function adapterOf(s) {
  assertRunnable(s);
  return require(`./adapters/${s.adapter}`);
}

module.exports = { REGISTRY, list, get, problemsOf, assertRunnable, adapterOf };
