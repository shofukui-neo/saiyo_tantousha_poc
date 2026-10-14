'use strict';
// 商談カレンダー → 企業名/担当者名/電話番号/メールアドレス の抽出。
// 入力は Google Calendar API の events.list レスポンスJSON（{accessRole, summary, events:[...]}）。
// MCP の list_events が保存するダンプもこの形式なので、そのまま複数渡せる。
//
//   node src/build-calendar-deals.js --in a.json,b.json [--out data/leads-calendar-deals.csv]
//
// 商談予定の書式は2系統:
//   ① ISヒアリングシート … 「■基本情報 / 担当者名：/ メールアドレス：/ 電話番号：」。社名は件名側
//   ② 調整アポ自動登録   … 「会社名: / 氏名: / メールアドレス:」
// どちらでもない予定は、社外の電話かメールが取れたものだけ残す（社内MTGを落とす）。
// 出力は個人情報を含むためローカル data/ 専用。toCsv 経由で架電禁止ガードもかかる。
const fs = require('fs');
const path = require('path');
const { toCsv, normCompanyName } = require('./csv');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

const toHalf = (s) => String(s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');

function descText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|div)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// 「ラベル：値」の値（同じ行のみ）。ラベル後の括弧注記（名字だけでも可…）は読み飛ばす。
// 改行が落ちて「伊藤様メールアドレス：…電話番号：…」と1行に連なる書式もあるので、次のラベルで切る。
const NEXT_LABEL = /(メールアドレス|電話番号|商談日程|担当者名|氏名|会社名)[（(：:]/;
function labeled(text, labelRe) {
  const re = new RegExp('(?<!個人|代表者)(?:' + labelRe + ')(?:[（(][^）)\\n]*[）)])?[ \\t　]*[：:][ \\t　]*([^\\n]*)', 'm');
  const m = text.match(re);
  if (!m) return '';
  const v = m[1];
  const cut = v.search(NEXT_LABEL);
  return (cut >= 0 ? v.slice(0, cut) : v).trim();
}

const INTERNAL_MAIL = /@(neo-career\.co\.jp|receptionist\.jp|zoom\.us|miitel\.com|google\.com)$/i;
function pickEmail(text) {
  const lab = labeled(text, 'メールアドレス|メール|mail');
  const cands = [lab, text];
  for (const c of cands) {
    for (const m of toHalf(c).matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      if (!INTERNAL_MAIL.test(m[0])) return m[0].toLowerCase();
    }
  }
  return '';
}

function pickPhone(text) {
  // 「個人電話番号」は拾わない（会社リストとして部署/代表番号だけ残す）
  const lab = labeled(text, '電話番号|電話|TEL');
  if (!lab) return '';
  const v = toHalf(lab).replace(/[ー－―‐]/g, '-');
  const hit = v.match(/0\d{1,4}-?\d{1,4}-?\d{3,4}/);
  if (!hit) return '';
  const digits = hit[0].replace(/\D/g, '');
  return (digits.length === 10 || digits.length === 11) ? hit[0] : '';
}

function cleanPerson(s) {
  return toHalf(s).replace(/※.*$/, '').replace(/[:：].*$/, '').replace(/[（(].*?[）)]/g, '').replace(/[()（）]/g, '')
    .replace(/\s+\S*(課|部|係|室|チーム)\S*/g, '') // 「松浦 人事第二課」の部署だけ。姓の阿部/室は残す
    .replace(/(様|さま|さん|殿)/g, '').replace(/(男性|女性)/g, '').replace(/\s+/g, ' ').trim();
}

// 件名から先頭の運用マーカー（〇/リスケ/社長説明会/【新/ヒ】/[商談] 等）を落とす
function stripTitle(s) {
  let t = toHalf(s).trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/^[〇○◯●]\s*/, '')
      .replace(/^[【\[][^】\]]*[】\]]\s*/, '')
      .replace(/^[▼▲]\S*\s*/, '')
      .replace(/^(リスケ|キャンセル|デモ貸し|キャリミキ|社長説明会|LINE通知[:：]?|※要メール送付|\d+分開始|Lista\(新規\)取り込み)\s*/, '')
      .trim();
  } while (t !== prev);
  return t;
}

// 件名 → { company, person }。「社名：氏名様」「社名／氏名さん」「社名 氏名様」を想定
function parseTitle(summary) {
  const t = stripTitle(summary).replace(/[【\[][^】\]]*[】\]]/g, ' ').trim();
  let company = t, person = '';
  const sep = t.match(/^(.+?)\s*[:：／/_]\s*(.+)$/);
  const sp = t.match(/^(\S+)\s+(\S+?(?:様|さん)?)(?:\s|$)/);
  const glued = t.match(/^(.+?)([一-龥々]{1,3})(様|さん)$/); // 「株式会社ツインバード佐藤様」
  if (sep) { company = sep[1]; person = sep[2]; }
  else if (sp) { company = sp[1]; person = sp[2]; }
  else if (glued && CORP_LIKE.test(glued[1])) { company = glued[1]; person = glued[2]; }
  return { company: company.trim(), person: cleanPerson(person) };
}

const CORP_LIKE = /(株式会社|有限会社|合同会社|法人|財団|組合|連合会|金庫|協会|連合|役所|役場|議会|庁|局|病院|学園|大学|銀行|㈱|㈲|\([株有福]\)|ホールディングス|工業|商事|建設)/;

// 1予定 → 抽出レコード（対象外は null）
function parseDealEvent(ev, calendarId) {
  const summary = ev.summary || '';
  if (/議事録投入|テスト/.test(summary)) return null; // 集約メモ（他予定の写し・複数社混在）と社内テスト
  const text = descText(ev.description);
  if ((text.match(/■基本情報/g) || []).length > 1) return null;

  const email = pickEmail(text);
  const phone = pickPhone(text);
  if (!email && !phone) return null; // 社外の連絡先が無い＝社内MTG扱い

  const fromTitle = parseTitle(summary);
  let company = cleanCompany(labeled(text, '会社名|企業名|社名') || fromTitle.company);
  let person = cleanPerson(labeled(text, '担当者名|氏名') || '') || fromTitle.person;
  // 調整アポで先方が「氏名」「会社名」欄を取り違えて入力するケース
  if (CORP_LIKE.test(person) && !CORP_LIKE.test(company)) [company, person] = [cleanCompany(person), cleanPerson(company)];
  // 法人格らしさが無く極端に短い/長い値は件名が社内向け（「玲耶 / 康晴」等）と見て落とす
  if (!company || (!CORP_LIKE.test(company) && (company.length <= 3 || company.length > 40))) return null;

  const route = /■基本情報|担当者名/.test(text) ? 'ISヒアリング'
    : /receptionist|会社名[:：]/.test(text) ? '調整アポ' : '件名/本文';
  const start = (ev.start && (ev.start.dateTime || ev.start.date)) || '';
  return {
    企業名: company, 担当者名: person, 電話番号: phone, メールアドレス: email,
    商談日: start.slice(0, 10), 社内担当: String(calendarId || '').split('@')[0], 取得元: route,
  };
}

function cleanCompany(s) {
  return toHalf(s).replace(/[（(](男性|女性)[）)]/g, '').replace(/\s+(男性|女性)$/, '').trim();
}

// 同一企業（正規化社名）を1行に寄せる。値は最新の商談日のものを優先し、担当者名は併記
function mergeByCompany(recs) {
  const by = new Map();
  for (const r of recs.sort((a, b) => b.商談日.localeCompare(a.商談日))) {
    const k = normCompanyName(r.企業名);
    if (!k) continue;
    const cur = by.get(k);
    if (!cur) { by.set(k, { ...r, 最終商談日: r.商談日, 商談件数: 1, _p: new Set(r.担当者名 ? [r.担当者名] : []), _o: new Set([r.社内担当]) }); continue; }
    cur.商談件数++;
    for (const f of ['電話番号', 'メールアドレス']) if (!cur[f] && r[f]) cur[f] = r[f];
    if (r.担当者名) cur._p.add(r.担当者名);
    cur._o.add(r.社内担当);
  }
  return [...by.values()].map((r) => ({
    ...r, 担当者名: [...r._p].join('／'), 社内担当: [...r._o].join('／'),
  }));
}

function run() {
  const inputs = String(getArg('in', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const OUT = path.resolve(__dirname, '..', getArg('out', path.join('data', 'leads-calendar-deals.csv')));
  if (!inputs.length) { console.error('--in にカレンダーJSONを指定してください'); process.exit(1); }

  const recs = [];
  let events = 0;
  for (const f of inputs) {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const seen = new Set();
    for (const ev of raw.events || []) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      events++;
      const r = parseDealEvent(ev, raw.summary);
      if (r) recs.push(r);
    }
  }
  const rows = mergeByCompany(recs);
  const headers = ['企業名', '担当者名', '電話番号', 'メールアドレス', '最終商談日', '商談件数', '社内担当', '取得元'];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '﻿' + toCsv(headers, rows, { where: path.basename(OUT) }));

  const n = (f) => rows.filter((r) => r[f]).length;
  console.log(`予定 ${events} 件 → 商談として抽出 ${recs.length} 件 → 企業 ${rows.length} 社`);
  console.log(`  担当者名 ${n('担当者名')} / 電話番号 ${n('電話番号')} / メール ${n('メールアドレス')} / 4項目そろい ${rows.filter((r) => r.担当者名 && r.電話番号 && r.メールアドレス).length}`);
  console.log(`  → ${path.relative(process.cwd(), OUT)}`);
}

module.exports = { parseDealEvent, parseTitle, mergeByCompany };
if (require.main === module) run();
