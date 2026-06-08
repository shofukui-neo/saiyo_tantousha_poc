'use strict';
// 電話番号の抽出（正規表現＋tel:リンク）。LLM/外部APIは一切使わない純ロジック。
// 方針: tel: リンク＞TEL/電話/代表/お問い合わせ 近接の番号＞その他 の順で信頼度を付け、
//       FAX 近接は減点、日本の固定/携帯/フリーダイヤルの桁構成のみ採用する。
const cheerio = require('cheerio');
const cfg = require('./config');

// 全角数字・記号を半角へ
function toHalfWidth(s) {
  return String(s || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[（）－―ー‐‑–—]/g, (c) => ({ '（': '(', '）': ')' }[c] || '-'))
    .replace(/[‐-‒–—―ー]/g, '-');
}

// 桁構成から日本の電話番号として妥当か判定し、ハイフン正規化した表記を返す（不正なら null）
function normalizeJpPhone(raw) {
  const halfRaw = toHalfWidth(raw);
  const digits = halfRaw.replace(/[^\d+]/g, '').replace(/^\+81/, '0').replace(/[^\d]/g, '');
  if (!digits || digits[0] !== '0') return null;
  if (digits[1] === '0') return null; // 日本の電話番号は "00" で始まらない（登録番号等の誤検出を除外）

  // フリーダイヤル等（0120/0800）: 0120-xxx-xxx (10桁)
  if (/^(0120|0800)\d{6}$/.test(digits)) {
    return digits.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3');
  }
  // 携帯・IP・ポケベル系（070/080/090/050）: 11桁 3-4-4
  if (/^(070|080|090|050)\d{8}$/.test(digits)) {
    return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
  }
  // 固定電話: 合計10桁。市外局番の桁は地域で1〜4桁と可変だが、合計10桁を満たすことを必須とする。
  if (digits.length === 10) {
    // 元表記にハイフン/括弧があればその区切りを尊重、無ければ 0A-BBBB-CCCC 近似で整形
    const m = halfRaw.match(/0\d{1,4}[-(]\d{1,4}[-)]\d{3,4}/);
    if (m) {
      return toHalfWidth(m[0]).replace(/[()]/g, '-').replace(/-+/g, '-').replace(/-$/, '');
    }
    return digits.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3');
  }
  return null;
}

// 文字列 hay の position 周辺にヒント語があるか
function hasHintNear(hay, pos, len, hints) {
  const from = Math.max(0, pos - 18);
  const to = Math.min(hay.length, pos + len + 8);
  const window = hay.slice(from, to).toLowerCase();
  return hints.some((h) => window.toLowerCase().includes(String(h).toLowerCase()));
}

/**
 * HTML（任意）とテキストから電話番号候補を抽出・スコアリングし、最有力を返す。
 * @param {{html?:string, text?:string}} input
 * @returns {{phone:string|null, isFax:boolean, score:number, source:string, evidence:string, candidates:Array}}
 */
function extractPhones({ html = '', text = '' } = {}) {
  const candidates = [];

  // 1) tel: リンク（最も信頼できる）
  if (html) {
    try {
      const $ = cheerio.load(html);
      $('a[href^="tel:"], a[href^="TEL:"]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const norm = normalizeJpPhone(href.replace(/^tel:/i, ''));
        if (norm) {
          const label = ($(a).text() || '').replace(/\s+/g, ' ').trim();
          const isFax = cfg.PHONE_NEGATIVE_HINTS.some((h) => label.toLowerCase().includes(String(h).toLowerCase()));
          candidates.push({ phone: norm, isFax, score: (isFax ? 4 : 9), source: 'tel-link', evidence: ('tel: ' + (label || norm)).slice(0, 120) });
        }
      });
    } catch (_) { /* HTML解析失敗時はテキストへフォールバック */ }
  }

  // 2) 本文テキストの正規表現
  const hay = toHalfWidth(text || '');
  // 0始まり、区切りは - ( ) 空白。合計10〜11桁になりうる並び。
  // 前後を数字で挟まれた並び（法人番号・登録番号など長い数字列の一部）は除外する。
  const re = /(?<!\d)0\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}(?!\d)/g;
  let m;
  while ((m = re.exec(hay)) !== null) {
    const norm = normalizeJpPhone(m[0]);
    if (!norm) continue;
    const pos = m.index;
    const isFax = hasHintNear(hay, pos, m[0].length, cfg.PHONE_NEGATIVE_HINTS);
    const posHint = hasHintNear(hay, pos, m[0].length, cfg.PHONE_POSITIVE_HINTS);
    let score = 2;
    if (posHint) score += 3;
    if (isFax) score -= 5;
    const around = hay.slice(Math.max(0, pos - 16), pos + m[0].length + 8).replace(/\s+/g, ' ').trim();
    candidates.push({ phone: norm, isFax, score, source: posHint ? 'text+hint' : 'text', evidence: around.slice(0, 120) });
  }

  if (!candidates.length) {
    return { phone: null, isFax: false, score: 0, source: '', evidence: '', candidates: [] };
  }

  // 同一番号は最高スコアへ集約
  const byPhone = new Map();
  for (const c of candidates) {
    const prev = byPhone.get(c.phone);
    if (!prev || c.score > prev.score) byPhone.set(c.phone, c);
  }
  const merged = [...byPhone.values()];
  // FAXでない・高スコアを優先
  merged.sort((a, b) => (a.isFax - b.isFax) || (b.score - a.score));
  const best = merged[0];
  return { ...best, candidates: merged };
}

module.exports = { extractPhones, normalizeJpPhone, toHalfWidth };
