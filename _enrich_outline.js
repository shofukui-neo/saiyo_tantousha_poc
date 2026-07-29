'use strict';
/**
 * 46社の会社概要(outline.html)を追加スクレイプして 業種/都道府県/設立/従業員 を補完し、
 * IT除外・規模上限(>2000除外)・氏名再検証(非人名除外) を適用して確定リストを出す。
 */
const P = require('path');
const fs = require('fs');
const R = (p) => require(P.join(__dirname, p));
const { chromium } = require('playwright');
const { readCsv, toCsv } = R('src/csv');
const { isExcludedIndustry } = R('src/icp-rules');
const { isPlausiblePersonName } = R('src/jp-names');

const IN = P.join(__dirname, 'data', 'leads-new-mynavi-mapped.csv');
const OUT = IN; // 上書き更新
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());
const intOf = (s) => { const m = String(s || '').replace(/[^0-9]/g, ''); return m ? parseInt(m, 10) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
function prefOf(s) { for (const p of PREFS) if (String(s || '').includes(p)) return p; return ''; }

async function scrapeOutline(pg, url) {
  const info = { 業種: '', 本社所在地: '', 本社: '', 設立: '', 従業員: '', url: '' };
  await pg.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pg.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const data = await pg.evaluate(() => {
    const res = { pairs: [], homepage: '' };
    for (const dl of document.querySelectorAll('dl, table')) {
      for (const dt of dl.querySelectorAll('dt, th')) {
        const dd = dt.nextElementSibling;
        if (dd && /dd|td/i.test(dd.tagName)) {
          res.pairs.push([(dt.innerText || '').replace(/\s+/g, ' ').trim(), (dd.innerText || '').replace(/\s+/g, ' ').trim()]);
        }
      }
    }
    // 企業ホームページの外部リンク
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      const t = (a.innerText || '') + ' ' + (a.getAttribute('href') || '');
      if (/ホームページ|公式|コーポレート|会社概要/.test(a.innerText || '') && !/mynavi\.jp/.test(a.href)) { res.homepage = a.href; break; }
    }
    return res;
  }).catch(() => ({ pairs: [], homepage: '' }));
  // 最初の該当ラベルを company 自身の値として採用（後半は類似/おすすめ企業なので無視）
  for (const [k, v] of data.pairs) {
    if (!info.業種 && /^業種/.test(k)) info.業種 = v;
    if (!info.本社所在地 && /本社所在地/.test(k)) info.本社所在地 = v;
    if (!info.本社 && /^本社$/.test(k)) info.本社 = v;
    if (!info.設立 && /^設立/.test(k)) info.設立 = v;
    if (!info.従業員 && /^従業員/.test(k)) info.従業員 = v;
  }
  info.url = data.homepage || '';
  return info;
}

async function main() {
  const { records } = readCsv(fs.readFileSync(IN, 'utf8'));
  const headers = Object.keys(records[0]);
  const b = await chromium.launch();
  const pg = await b.newPage();
  const kept = [];
  let dropIT = 0, dropBig = 0, dropName = 0, i = 0;
  for (const r of records) {
    i++;
    const name = g(r, '企業名');
    const recruiter = g(r, '採用担当者名');
    // 氏名再検証（非人名の断片を除外。姓のみは許容されるので緩め）
    if (!isPlausiblePersonName(recruiter) && recruiter.length <= 2 && /^(特徴|概要|詳細|会社|募集|採用|人事|総務|担当)$/.test(recruiter)) { dropName++; console.log(`  ✗名NG: ${name} / "${recruiter}"`); continue; }
    const url = g(r, '採用ページURL');
    let info = { 業種: '', 本社所在地: '', 本社: '', 設立: '', 従業員: '', url: '' };
    if (/^https?:\/\//.test(url)) { try { info = await scrapeOutline(pg, url); } catch (_) {} await sleep(1200); }
    // 従業員数: ハーベストの正規化済み整数を信頼。空ならoutlineの「先頭のN名」を採用。
    let emp = intOf(g(r, '従業員数'));
    if (emp == null) { const m = String(info.従業員 || '').match(/([\d,]+)\s*名/); if (m) emp = parseInt(m[1].replace(/,/g, ''), 10); }
    // 規模上限（ICP有効上限=2000超は自前/競合ATS濃厚で除外）
    if (emp != null && emp > 2000) { dropBig++; console.log(`  ✗規模超(>2000): ${name} / ${emp}名`); continue; }
    // 業種は「参考記録」のみ（スクレイプ不正確＝自動IT除外はしない）。会社名の明白なITシグナルのみ落とす。
    const gyoshu = info.業種 || '';
    const NAME_IT_RE = /ソフトウ|ソフト技研|システム開発|システムズ|システム・|ＳＩ|SIer|SES|情報処理|情報システム|ソリューションズ|テクノロジーズ|デジタル|ネットワーク|ウェブ|ソフトウェア/;
    if (NAME_IT_RE.test(name)) { dropIT++; console.log(`  ✗IT名除外: ${name}`); continue; }
    // 反映
    r['業種'] = gyoshu || g(r, '業種');
    const pref = prefOf(info.本社所在地) || prefOf(info.本社);
    r['都道府県'] = pref || g(r, '都道府県');
    if (emp != null) r['従業員数'] = String(emp);
    if (info.設立) r['設立年'] = (info.設立.match(/\d{4}/) || [''])[0];
    if (info.url) r['公式URL'] = info.url;
    console.log(`  ✓ ${name} | 従${emp||'?'} | ${pref||'?'} | 業種:${gyoshu||'?'}`);
    kept.push(r);
    if (i % 10 === 0) console.log(`  ...${i}/${records.length} 処理`);
  }
  await b.close();
  fs.writeFileSync(OUT, '﻿' + toCsv(headers, kept), 'utf8');
  console.log(`\n[enrich] ${records.length}社 → 確定 ${kept.length}社（IT除外 ${dropIT} / 規模超 ${dropBig} / 名NG ${dropName}）`);
}
main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exit(1); });
