'use strict';
// 司令塔: 1社を全レイヤ（名寄せ→URL→巡回→電話/担当者→メール→Tier）に通し、
// 「担当者マスタ」レコードと、集計用の結果オブジェクトを返す。
// 各レイヤは利用可能なAPIキーに応じて自動で高精度/ローカル経路を選ぶ。
const cfg = require('./config');
const { getRobots, isAllowed } = require('./robots');
const { fetchPage, fetchText, discoverPages, guessContactPaths, extractText } = require('./fetch');
const { discoverUrl } = require('./search');
const { extractPhones, normalizeJpPhone } = require('./phone');
const structured = require('./structured');
const { extractRecruiterFromText } = require('./recruiter');
const { enrichEmail } = require('./email');
const { ntaAvailable, ntaFindByName } = require('./nta');
const { gbizAvailable, gbizGet } = require('./gbiz');
const { normalizeDomain, tierOf, callScript } = require('./score');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// LOCATE_PATHS をドメインに展開（既存 guessContactPaths と併用して候補ページを厚くする）
function locatePaths(homepageUrl, c) {
  try {
    const origin = new URL(homepageUrl).origin;
    return c.LOCATE_PATHS.map((p) => origin + p);
  } catch (_) { return []; }
}

/**
 * 1社を処理して { record（担当者マスタ）, result（集計用） } を返す。
 * @param {object} cand 候補企業（discovery.js の出力 or 入力企業）
 * @param {object} icp 正規化済みICP
 */
async function processCompany(cand, icp, c = cfg) {
  const t0 = Date.now();
  const result = {
    company: cand.name, status: 'MISS', resolved_url: '', phone: '',
    name: '', role: '', department: '', confidence: 0,
    pages_checked: 0, elapsed_ms: 0, error: '',
  };
  // 担当者マスタの素地（cand 由来の属性を引き継ぐ）
  const rec = {
    '企業名': cand.name, '法人番号': cand.corporateNumber || '',
    '採用担当者名': '', '役職': '', '部署': '',
    '代表者名': cand.representativeName || '', 'メール': '', 'メール確度': '',
    '担当者確度': '', '電話番号': '', '公式URL': '', 'Tier': 'D',
    '取得元媒体': '', '根拠URL': '', '架電呼称': '',
    '業種': cand.industry || '', '都道府県': cand.prefecture || '',
    '従業員数': cand.employees != null ? cand.employees : '',
    '補助金': cand.subsidyFlag || '', '設立年': cand.establishmentYear || '',
    '取得日': new Date().toISOString(),
  };

  try {
    // 1) 法人番号の名寄せ（国税庁・任意）
    if (!rec['法人番号'] && ntaAvailable(c)) {
      const nta = await ntaFindByName(cand.name, c);
      if (nta) { rec['法人番号'] = nta.corporateNumber; if (!rec['都道府県']) rec['都道府県'] = nta.prefecture || ''; }
    }
    // 2) gBizINFO で代表者名・HP・所在地を補完（任意）
    let domain = normalizeDomain(cand.domain || cand.websiteUrl || '');
    let homepageUrl = cand.websiteUrl || (domain ? 'https://' + domain : '');
    let addressHint = cand.prefecture || '';   // 同名取り違え防止に使う所在地ヒント
    if (rec['法人番号'] && gbizAvailable(c)) {
      const gb = await gbizGet(rec['法人番号'], c);
      if (gb) {
        if (!rec['代表者名']) rec['代表者名'] = gb.representativeName || '';
        if (gb.prefecture) addressHint = gb.prefecture; // gBizINFOの所在地（都道府県＋市区）
        if (!homepageUrl && gb.websiteUrl) { homepageUrl = gb.websiteUrl; domain = normalizeDomain(gb.websiteUrl); }
      }
    }

    // 3) 公式URLの確定（入力/補完が無ければ企業名から発見。所在地ヒントで同名取り違えを抑制）
    let urlSource = homepageUrl ? 'input' : '';
    if (!homepageUrl) {
      await sleep(c.SEARCH_DELAY_MS);
      const d = await discoverUrl(cand.name, { fetchPage, extractText }, { addressHint });
      if (!d.url) {
        result.status = 'NO_URL'; result.error = ('URL未発見: ' + (d.error || '')).slice(0, 200);
        return finalize(rec, result, t0, icp, c);
      }
      homepageUrl = d.url; urlSource = d.source; domain = normalizeDomain(homepageUrl);
    }
    result.resolved_url = homepageUrl;
    rec['公式URL'] = homepageUrl;

    // 4) サイト巡回（robots遵守）→ 電話番号＋採用担当者を収集
    const start = new URL(homepageUrl);
    const robots = await getRobots(start.origin);
    if (!isAllowed(robots, c.USER_AGENT, start.pathname)) {
      result.status = 'SKIP_ROBOTS';
      return finalize(rec, result, t0, icp, c);
    }

    const home = await fetchPage(homepageUrl);
    result.resolved_url = home.finalUrl || homepageUrl;
    rec['公式URL'] = result.resolved_url;
    if (!domain) domain = normalizeDomain(result.resolved_url);
    result.pages_checked++;
    const htmlByUrl = { [homepageUrl]: home.html };

    const discovered = discoverPages(homepageUrl, home.html);
    let sitemapPages = [];
    if (c.USE_SITEMAP) {
      try { sitemapPages = await structured.discoverFromSitemap(start.origin, { fetchText }); } catch (_) {}
    }
    const ordered = [homepageUrl, ...discovered, ...sitemapPages, ...guessContactPaths(homepageUrl), ...locatePaths(homepageUrl, c)];
    const candidates = [...new Set(ordered)].slice(0, c.MAX_PAGES_PER_SITE);

    let bestPhone = null;
    let recruiterHit = null;

    for (const url of candidates) {
      if (!htmlByUrl[url]) {
        let u;
        try { u = new URL(url); } catch (_) { continue; }
        if (!isAllowed(robots, c.USER_AGENT, u.pathname)) continue;
        await sleep(c.POLITE_DELAY_MS);
        try { const p = await fetchPage(url); htmlByUrl[url] = p.html; result.pages_checked++; }
        catch (_) { continue; }
      }
      const html = htmlByUrl[url];
      const text = extractText(html);
      if (!text || text.length < 40) continue;

      // 電話番号：JSON-LD(schema.org)の telephone を最優先（正規表現より正確）。
      if (c.USE_STRUCTURED) {
        const org = structured.extractOrganization(html);
        if (org && org.telephone) {
          const norm = normalizeJpPhone(org.telephone);
          if (norm && (!bestPhone || bestPhone.source !== 'json-ld')) {
            bestPhone = { phone: norm, score: 100, source: 'json-ld', evidence: ('JSON-LD telephone: ' + org.telephone).slice(0, 120), isFax: false, sourceUrl: url };
          }
        }
      }
      // 会社概要/お問い合わせ系ページは代表番号が載りやすいので加点して収集
      const pageBoost = /company|contact|about|corporate|profile|outline|会社|問い合わせ|問合/i.test(url) ? 2 : 0;
      const ph = extractPhones({ html, text, pageBoost });
      if (ph.phone && (!bestPhone || (bestPhone.source !== 'json-ld' && ph.score > bestPhone.score))) bestPhone = { ...ph, sourceUrl: url };

      // 採用担当者（HITで確定。以降は電話探索のみ継続）
      if (!recruiterHit) {
        const hit = await extractRecruiterFromText(text, cand, c);
        if (hit) { recruiterHit = { ...hit, sourceUrl: url }; }
      }
      if (recruiterHit && bestPhone) break;
    }

    if (recruiterHit) {
      result.status = 'HIT';
      result.name = recruiterHit.name; result.role = recruiterHit.role;
      result.department = recruiterHit.department; result.confidence = recruiterHit.confidence;
      rec['採用担当者名'] = recruiterHit.name; rec['役職'] = recruiterHit.role;
      rec['部署'] = recruiterHit.department; rec['担当者確度'] = recruiterHit.confidence;
      rec['取得元媒体'] = recruiterHit.engine === 'gemini' ? 'AI抽出' : '正規表現抽出';
      rec['根拠URL'] = recruiterHit.sourceUrl;
    }
    if (bestPhone) { result.phone = bestPhone.phone; rec['電話番号'] = bestPhone.phone; }

    // 5) メール推定
    const em = await enrichEmail({ domain, websiteUrl: result.resolved_url }, c);
    rec['メール'] = em.email; rec['メール確度'] = em.score;
  } catch (e) {
    result.status = 'ERROR';
    result.error = String(e && e.message ? e.message : e).slice(0, 200);
  }
  return finalize(rec, result, t0, icp, c);
}

// Tier・架電呼称・所要時間を確定して返す
function finalize(rec, result, t0, icp, c) {
  const hitScore = Number(rec['担当者確度'] || 0);
  const emailScore = Number(rec['メール確度'] || 0);
  rec['Tier'] = tierOf(hitScore, emailScore, !!rec['代表者名'], c);
  rec['架電呼称'] = callScript(icp, c);
  if (!rec['取得元媒体']) rec['取得元媒体'] = rec['代表者名'] ? '代表者フォールバック' : '非公開';
  result.elapsed_ms = Date.now() - t0;
  return { record: rec, result };
}

module.exports = { processCompany };
