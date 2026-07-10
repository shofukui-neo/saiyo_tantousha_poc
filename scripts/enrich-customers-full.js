'use strict';
/**
 * 既存顧客429社を「あらゆる変数」で拡充した新規スプレッドシート(CSV)を生成。
 * ソース: 顧客リスト(契約ライフサイクル) × SF全リード(業種/規模/採用/電話/獲得リスト) × gBiz(設立年/従業員/補助金/上場)。
 * 出力: data/mochica-customers-enriched-full.csv （Excel/Googleスプレッドシートで直接開ける）
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, normCompanyName, normCorpNumber } = require('../src/csv');
const { industryMacro, empBandLabel, hireBandLabel, emailAttrs, phoneToGeo, acquisitionChannel } = require('./lib-enrich');
const DATA = path.join(__dirname, '..', 'data');
const readText = (p) => fs.readFileSync(p, 'utf8');
const NOW = new Date('2026-07-01');

// ---- 顧客リスト ----
const cRows = parseCsv(readText(path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv')));
const cH = cRows[0].map((c) => String(c).trim());
const cg = (n) => cH.indexOf(n);
const customers = cRows.slice(1)
  .map((r) => { const o = {}; cH.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; }); return o; })
  .filter((r) => r['法人名'] && r['法人名'] !== '削除');

// ---- SF全リード → 名寄せインデックス ----
const sfRows = parseCsv(readText(path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv')));
const hIdx = sfRows.findIndex((r) => r.some((c) => String(c).includes('リードID18')));
const sfH = sfRows[hIdx].map((c) => String(c).trim());
const si = (name) => { let i = sfH.indexOf(name); if (i >= 0) return i; const w = name.replace(/[（）()]/g, ''); return sfH.findIndex((h) => h.replace(/[（）()]/g, '') === w); };
const S = { name: si('会社名 / 取引先'), phone: si('電話'), hire: si('採用人数(選択リスト)'), status: si('リード 状況'), emp: si('従業員数レンジ(ランスケ）'), ind: si('業種'), mail: si('メール'), s10: si('セミナーアンケート項目10'), s7: si('セミナーアンケート項目7') };
const sfByName = new Map();
for (const r of sfRows.slice(hIdx + 1)) {
  const nm = (r[S.name] || '').trim(); if (!nm) continue;
  const k = normCompanyName(nm); if (!k) continue;
  const rec = { name: nm, phone: (r[S.phone] || '').trim(), hire: (r[S.hire] || '').trim(), status: (r[S.status] || '').trim(), emp: (r[S.emp] || '').trim(), ind: (r[S.ind] || '').trim(), mail: (r[S.mail] || '').trim(), s10: (r[S.s10] || '').trim(), s7: (r[S.s7] || '').trim() };
  // 優先: 情報が多い方を残す
  const score = (x) => (x.ind ? 1 : 0) + (x.emp ? 1 : 0) + (x.hire ? 1 : 0) + (x.phone ? 1 : 0);
  if (!sfByName.has(k) || score(rec) > score(sfByName.get(k))) sfByName.set(k, rec);
}

// ---- gBiz(設立年/従業員/補助金) 名寄せ（候補プールに存在する顧客のみ）----
let gbizByName = new Map(), gbizByNum = new Map();
try {
  const g = JSON.parse(readText(path.join(DATA, 'gbiz-records.json')));
  for (const r of (Array.isArray(g) ? g : [])) {
    const k = normCompanyName(r['企業名'] || ''); if (k) gbizByName.set(k, r);
    const num = normCorpNumber(r['法人番号'] || ''); if (num) gbizByNum.set(num, r);
  }
} catch (e) { /* optional */ }

// ---- 上場企業名セット ----
let listedSet = new Set();
try {
  const ln = JSON.parse(readText(path.join(DATA, 'listed-names.json')));
  const names = Array.isArray(ln) ? ln : (ln.names || Object.keys(ln));
  for (const n of names) { const k = normCompanyName(n); if (k) listedSet.add(k); }
} catch (e) { /* optional */ }

// ---- 月パース ----
function ym(v) { const m = String(v || '').match(/(\d{4})[\/\-](\d{1,2})/); return m ? new Date(+m[1], +m[2] - 1, 1) : null; }
function yearOf(v) { const m = String(v || '').match(/(\d{4})/); return m ? +m[1] : null; }

// ---- 拡充 ----
const out = [];
let matchSf = 0, matchGbiz = 0;
for (const c of customers) {
  const name = c['法人名'];
  const key = normCompanyName(name);
  const sf = sfByName.get(key) || null; if (sf) matchSf++;
  const gb = gbizByName.get(key) || null; if (gb) matchGbiz++;

  // プラン/契約
  const planBase = c['基本年間プラン'] || '';
  const planNow = c['現在利用プラン'] || '';
  const planPrev = c['更新前プラン'] || '';
  const upgraded = String(c['アップグレードプラン①'] || '').trim() ? 'あり' : '';
  const planChanged = planPrev && planPrev !== planNow ? 'あり' : '';
  const paidStart = ym(c['有料開始月']); const paidEnd = ym(c['有料終了月']);
  const tenureM = paidStart ? Math.round(((paidEnd || NOW) - paidStart) / (1000 * 3600 * 24 * 30.4)) : '';
  const cohort = yearOf(c['作成日']) || '';
  const trial = String(c['無料開始月'] || '').trim() ? 'あり' : '';
  const nextRenewal = c['有料終了月'] || '';

  // メール
  const em = emailAttrs(c['Email']);

  // firmographics（SF優先→gBiz補完）
  const industry = sf ? sf.ind : '';
  const empRange = sf ? sf.emp : (gb && gb['従業員数'] ? String(gb['従業員数']) + '名(gBiz)' : '');
  const hire = sf ? sf.hire : '';
  const phone = (sf && sf.phone) || (gb && gb['電話番号']) || '';
  const geo = phoneToGeo(phone);
  const leadStatus = sf ? sf.status : '';
  const channel = sf ? acquisitionChannel(sf.s10, sf.s7) : '';

  // gBiz/上場
  const founded = (gb && gb['設立年']) || '';
  const foundedAge = founded ? (2026 - yearOf(founded)) : '';
  const subsidy = gb && String(gb['補助金'] || '').trim() ? 'あり' : '';
  const listed = listedSet.has(key) ? '上場' : '';

  // LINE名不一致
  const lineName = c['LINEアカウント登録企業名'] || '';
  const lineMismatch = (lineName && normCompanyName(lineName) !== key) ? 'あり' : '';

  out.push({
    法人名: name,
    業種: industry,
    業種マクロ: industryMacro(industry),
    従業員数レンジ: empRange,
    従業員数バンド: empBandLabel(empRange),
    年間新卒採用数: hire,
    採用数バンド: hireBandLabel(hire),
    都道府県: geo.pref,
    地域ブロック: geo.region,
    電話: phone,
    上場: listed,
    設立年: founded,
    社齢: foundedAge,
    補助金採択: subsidy,
    基本プラン: planBase,
    現在プラン: planNow,
    更新前プラン: planPrev,
    プラン変更: planChanged,
    アップグレード: upgraded,
    無料トライアル経由: trial,
    有料開始月: c['有料開始月'] || '',
    次回更新月: nextRenewal,
    テナー月数: tenureM,
    獲得コホート年: cohort,
    獲得チャネル: channel,
    SFリード状況: leadStatus,
    メールドメイン: em.domain,
    ドメイン種別: em.domainType,
    メール担当種別: em.mailboxType,
    LINE名不一致: lineMismatch,
    SF突合: sf ? '○' : '',
    gBiz突合: gb ? '○' : '',
  });
}

const COLS = Object.keys(out[0]);
const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = '﻿' + [COLS.join(',')].concat(out.map((r) => COLS.map((c) => esc(r[c])).join(','))).join('\n');
const outPath = path.join(DATA, 'mochica-customers-enriched-full.csv');
fs.writeFileSync(outPath, csv);

console.log('顧客(有効):', customers.length, '| SF突合:', matchSf, `(${(100 * matchSf / customers.length).toFixed(0)}%)`, '| gBiz突合:', matchGbiz);
console.log('列数:', COLS.length, '→', COLS.join(', '));
console.log('保存:', path.relative(path.join(__dirname, '..'), outPath));
// JSONも保存（分析用）
fs.writeFileSync(path.join(DATA, 'mochica-customers-enriched-full.json'), JSON.stringify(out, null, 1));
