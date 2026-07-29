'use strict';
/**
 * 企業同定マッチャ（重複除去の単一情報源）── 2026-07 v1
 * =====================================================================
 * 「この企業は既存顧客/既納品リストに含まれるか」を判定する層。
 * consolidate-all.js（既存被り判定）と delivered-ledger.js（納品済み台帳）が共用し、
 * マッチ規則を1箇所に集約する（＝仕様のブレ・突合ミスの再発をゼロにする）。
 *
 * 突合キー（いずれか一致で「同一」と判定）:
 *   1) 法人番号（13桁完全一致）           … 最優先・誤りなし
 *   2) 正規化社名（csv.normCompanyName）    … 注釈括弧/法人格/記号/空白を除去した基本キー
 *   3) 農協コア（companyCore）              … JA○○ ⇔ ○○農業協同組合/○○農協 の別称同一視
 *
 * 農協コアの安全ガード: 連合会/中央会（信連・経済連・共済連・厚生連・中央会）は
 * 都道府県を共有する“別法人”のため collapse しない（誤マッチ防止）。
 */
const { normCompanyName, normCorpNumber } = require('./csv');

// 会社名として拾う列（内部スキーマ／BALES 266列／Google出力/MOCHICA顧客の揺れを吸収）
const NAME_COLS = ['会社情報：会社名', '企業名', '会社名', '法人名', 'LINEアカウント登録企業名', 'company_name'];
const BANGO_COLS = ['法人番号'];

function pickName(rec) {
  for (const c of NAME_COLS) { const v = rec[c]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}
function pickBango(rec) {
  for (const c of BANGO_COLS) { const v = rec[c]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}

/**
 * 農協系の別称コアを返す（無ければ ''）。JA○○ と ○○農業協同組合/○○農協 を同一視するためのキー。
 * ・連合会/中央会 を含む名称は別法人なので collapse しない（'' を返す）。
 * ・末尾「農業協同組合」/「農協」除去、先頭「ja」除去でコアを得る。コア長 < 2 は無効。
 */
function companyCore(name) {
  const s = normCompanyName(name); // 注釈除去・記号除去・小文字化済み（漢字は残る）
  if (!s) return '';
  if (/連合会|中央会/.test(s)) return ''; // 信連/経済連/共済連/厚生連/中央会 は collapse しない
  let core = s;
  let isCoop = false;
  if (/農業協同組合$/.test(core)) { core = core.replace(/農業協同組合$/, ''); isCoop = true; }
  else if (/農協$/.test(core)) { core = core.replace(/農協$/, ''); isCoop = true; }
  if (/^ja/.test(core)) { core = core.replace(/^ja/, ''); isCoop = true; }
  core = core.trim();
  if (!isCoop || core.length < 2) return '';
  return 'coop:' + core;
}

// レコード（または社名文字列）→ 突合キー群 { bango, name, core }
function keysOf(recOrName) {
  const isStr = typeof recOrName === 'string';
  const name = isStr ? recOrName : pickName(recOrName);
  const bango = isStr ? '' : pickBango(recOrName);
  return { bango: normCorpNumber(bango), name: normCompanyName(name), core: companyCore(name) };
}

/**
 * マッチインデックス。マスタ側（顧客/既納品）を add し、候補側を matchLabel/has で判定。
 * ラベルを保持し「どのマスタに一致したか」を返せる。
 */
function createMatchIndex() {
  const byBango = new Map(); // 13桁 -> label
  const byName = new Map();  // 正規化社名 -> label
  const byCore = new Map();  // 農協コア -> label
  let added = 0;

  function addName(name, label = '') {
    const k = keysOf(typeof name === 'string' ? name : pickName(name));
    let touched = false;
    if (k.name && !byName.has(k.name)) { byName.set(k.name, label); touched = true; }
    if (k.core && !byCore.has(k.core)) { byCore.set(k.core, label); touched = true; }
    if (touched) added++;
  }
  function addBango(bango, label = '') {
    const b = normCorpNumber(bango);
    if (b && !byBango.has(b)) { byBango.set(b, label); }
  }
  function addRecord(rec, label = '') { addBango(pickBango(rec), label); addName(pickName(rec), label); }

  // 一致したマスタのラベルを返す（無ければ ''）。法人番号 → 社名 → 農協コア の順。
  function matchLabel(recOrName) {
    const k = keysOf(recOrName);
    if (k.bango && byBango.has(k.bango)) return byBango.get(k.bango) || 'match';
    if (k.name && byName.has(k.name)) return byName.get(k.name) || 'match';
    if (k.core && byCore.has(k.core)) return byCore.get(k.core) || 'match';
    return '';
  }
  const has = (recOrName) => matchLabel(recOrName) !== '';

  return {
    addName, addBango, addRecord, matchLabel, has,
    get size() { return added; },
    get bangoSize() { return byBango.size; },
    get nameSize() { return byName.size; },
    get coreSize() { return byCore.size; },
    _byName: byName, _byCore: byCore, _byBango: byBango, // テスト/監査用
  };
}

module.exports = {
  NAME_COLS, BANGO_COLS, pickName, pickBango, companyCore, keysOf, createMatchIndex,
};
