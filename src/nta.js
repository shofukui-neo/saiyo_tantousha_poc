'use strict';
// L2: 国税庁 法人番号 Web-API v4（NTA_APP_ID がある時だけ有効）。
// 商号（企業名）から法人番号・所在地を名寄せする。レスポンスは XML（type=12）。
// アプリID未設定なら ntaAvailable()=false で、呼び出し側はスキップする。
const cfg = require('./config');

function ntaAvailable(c = cfg) { return !!(c && c.NTA_APP_ID); }

// 依存を増やさないため、単一タグの中身を正規表現で取り出す簡易XML抽出。
function xmlTag(xml, tag) {
  const m = String(xml || '').match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

/**
 * 企業名から法人番号を1件名寄せ（部分一致・登記閉鎖を除く）。
 * @returns {Promise<{corporateNumber:string,name:string,prefecture:string,city:string}|null>}
 */
async function ntaFindByName(name, c = cfg) {
  if (!ntaAvailable(c) || !name) return null;
  // type=12: XML / mode=2: 部分一致 / close=0: 登記閉鎖を除く
  const url = c.NTA_BASE + '/name'
    + '?id=' + encodeURIComponent(c.NTA_APP_ID)
    + '&name=' + encodeURIComponent(name)
    + '&type=12&mode=2&close=0';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), c.PER_PAGE_TIMEOUT_MS || 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const xml = await res.text();
    // 最初の <corporation> ブロックだけを対象に
    const block = (xml.match(/<corporation>[\s\S]*?<\/corporation>/) || [])[0];
    if (!block) return null;
    const corporateNumber = xmlTag(block, 'corporateNumber');
    if (!corporateNumber) return null;
    return {
      corporateNumber,
      name: xmlTag(block, 'name'),
      prefecture: xmlTag(block, 'prefectureName'),
      city: xmlTag(block, 'cityName'),
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { ntaAvailable, ntaFindByName, xmlTag };
