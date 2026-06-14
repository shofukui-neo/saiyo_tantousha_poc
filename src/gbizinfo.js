'use strict';
// gBizINFO（経済産業省 法人活動データ）連携。無料トークン（メール登録のみ）で利用可。
// 用途: 企業名 → 正式名称・所在地・企業HP・法人番号 を「公的データ」で確定し、
//       同名企業の取り違えを防ぎ、発見・URL精度を底上げする。
// トークン（.env の GBIZINFO_TOKEN）が無い場合はすべて no-op（従来動作にフォールバック）。
const cfg = require('./config');
const { companyCore } = require('./search');

function enabled() { return !!cfg.GBIZINFO_TOKEN; }

// APIレスポンス(JSON)から正規化済みレコード配列へ
function parseResponse(json) {
  const arr = (json && (json['hojin-infos'] || json.hojinInfos || json.hojin_infos)) || [];
  return arr.map(normalizeRecord).filter(r => r.name);
}

function normalizeRecord(it) {
  it = it || {};
  return {
    corporateNumber: String(it.corporate_number || it.corporateNumber || '').trim(),
    name: String(it.name || '').trim(),
    location: String(it.location || '').trim(),               // 例: 東京都千代田区...
    postalCode: String(it.postal_code || '').trim(),
    url: String(it.company_url || it.homepage || '').trim(),  // 公式HP（あれば）
    prefecture: prefectureOf(String(it.location || '')),
  };
}

// 所在地文字列から都道府県名を粗く抽出（同名照合・市外局番整合に使用）
function prefectureOf(location) {
  const m = String(location || '').match(/(北海道|東京都|京都府|大阪府|.{2,3}県)/);
  return m ? m[1] : '';
}

// 候補群から、与えた企業名に最も合致する1件を選ぶ（完全一致＞核一致＞先頭）
function pickBest(items, name) {
  if (!items || !items.length) return null;
  const target = companyCore(name).toLowerCase();
  const exact = items.find(r => r.name === name);
  if (exact) return exact;
  const coreEq = items.find(r => companyCore(r.name).toLowerCase() === target);
  if (coreEq) return coreEq;
  const coreIncl = items.find(r => {
    const c = companyCore(r.name).toLowerCase();
    return c && (c.includes(target) || target.includes(c));
  });
  return coreIncl || items[0];
}

async function call(params) {
  const url = cfg.GBIZINFO_BASE + '?' + new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.PER_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-hojinInfo-api-token': cfg.GBIZINFO_TOKEN, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('gBizINFO HTTP ' + res.status);
    return parseResponse(await res.json());
  } finally {
    clearTimeout(t);
  }
}

/**
 * 企業名で照会し、最も合致する1件（正式名称・所在地・HP・法人番号）を返す。
 * @returns {Promise<object|null>}
 */
async function lookup(name, opt = {}) {
  if (!enabled() || !name) return null;
  const params = { name, limit: '10', exist_flg: 'true' };
  if (opt.prefecture || cfg.GBIZINFO_PREFECTURE) params.prefecture = opt.prefecture || cfg.GBIZINFO_PREFECTURE;
  try {
    const items = await call(params);
    return pickBest(items, name);
  } catch (_) {
    return null; // 失敗時は静かにフォールバック
  }
}

/**
 * キーワード（社名の一部）＋任意の都道府県で企業名を発見する。
 * @returns {Promise<string[]>}
 */
async function discoverNames(keyword, opt = {}) {
  if (!enabled() || !keyword) return [];
  const limit = opt.limit || cfg.DISCOVER_LIMIT;
  const params = { name: keyword, limit: String(Math.min(limit, 100)), exist_flg: 'true' };
  if (opt.prefecture || cfg.GBIZINFO_PREFECTURE) params.prefecture = opt.prefecture || cfg.GBIZINFO_PREFECTURE;
  try {
    const items = await call(params);
    return items.map(r => r.name).slice(0, limit);
  } catch (_) {
    return [];
  }
}

module.exports = { enabled, lookup, discoverNames, parseResponse, normalizeRecord, pickBest, prefectureOf };
