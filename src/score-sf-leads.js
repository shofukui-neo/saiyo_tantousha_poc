'use strict';
/**
 * SFリード（会社名＋担当者名＋連絡先＋リードID18）のICPスコアリング ── 2026-08 v1
 * =====================================================================
 * 「架電候補としてSFから抜いた数十件」を、そのまま架電順に並べ替えるための採点口。
 * 入力が持っているのは 社名/担当者名/電話/メール/リードID だけで、ICP判定に要る
 * 業種・従業員数・新卒採用人数を持っていない。ここでは以下の順で属性を回収してから採点する。
 *
 *   ① リードID18で SF全リード に直結        … 業種/従業員数レンジ/採用人数(選択リスト)/リード状況
 *   ② 社名で BALES既存CRM に突合            … 利用中ATS/アプローチ禁止/最終ステージ/検討開始時期/失注理由
 *   ③ 社名で 統合マスタ に突合              … 従業員数・採用予定人数の“実数”（レンジより精度が高い）
 *   ④ 社名で 公知テーブル(score-expo-leads) … 上場/著名企業の目安
 *
 * 判定は icp-rules（単一の真実源）のハードルールが先、スコアは mochica-fit（アポ取得期待値）。
 *   ハード除外 : 既存顧客/納品済み・アプローチ禁止・IT/ソフト・同業(媒体/ATS)・規模フロア・採用フロア
 *   スコア     : mochica-fit 0-100（規模/採用ファネル/到達性/業種/タイミング）
 *
 * 同名他社の事故を防ぐため、ID直結でない突合（社名突合）は電話番号の市外局番を突き合わせ、
 * 食い違う場合は「同名注意」として判定を要確認どまりに落とす（例: サンテック株式会社＝愛知/大阪）。
 *
 * 使い方:
 *   node src/score-sf-leads.js --in <leads.csv> [--out data/leads-sf-scored.csv]
 *   入力CSVの列: 会社名, 担当者名, 電話番号, メールアドレス, リードID（列名ゆれ吸収あり）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, parseCsv, toCsv, normCompanyName } = require('./csv');
const { indexPut, indexGet } = require('./company-match');
const { buildExclusionIndex, FILES } = require('./exclusion-index');
const { ICP, isExcludedIndustry, proposalTier } = require('./icp-rules');
const { scoreMochica } = require('./mochica-fit');
const { matchAreaCode, AREA_CODES } = require('./areacode');
const { KNOWN } = require('./score-expo-leads');

const ROOT = path.resolve(__dirname, '..');

// --- 同業・不適合の辞書 -----------------------------------------------------
// 求人媒体・ATSベンダー・RPOは「MOCHICAの買い手」ではなく競合/提携先。名指しで落とす。
const MEDIA_ATS_RE = /(マイナビ|リクルート|ディップ|エン・?ジャパン|パーソル|アルバイトタイムス|学情|文化放送キャリアパートナーズ|ジョブカン|sonar|DONUTS|ネオキャリア|ポート株式会社)/i;
// 人材紹介・派遣・研修は自社でも新卒を採るが、提携/競合の見極めが要る。落とさずスコアで沈める。
const HR_VENDOR_RE = /(人材|紹介|派遣|研修|キャリア|ヒューマンリソース|HR)/i;
// 法人実体が薄い先（屋号・個人）。フリーメール＋法人格なしの合わせ技でだけ効かせる。
const FREE_MAIL_RE = /@(gmail|yahoo|outlook|hotmail|icloud|nifty|ezweb|docomo|eonet|ocn|so-net|plala)\./i;
const CORP_FORM_RE = /(株式会社|有限会社|合同会社|医療法人|社会福祉法人|学校法人|公益財団|一般社団|協同組合|農業協同組合)/;
const MOBILE_RE = /^0[789]0/;

// --- 列名ゆれ ---------------------------------------------------------------
const COL = {
  name: ['会社名', '企業名', '会社名 / 取引先', '法人名'],
  person: ['担当者名', '採用担当者名', '姓', '担当者'],
  phone: ['電話番号', '電話', 'TEL'],
  mail: ['メールアドレス', 'メール', 'Email'],
  id: ['リードID(18桁)', 'リードID', 'リードID18', 'ID'],
};
const pick = (rec, cols) => {
  for (const c of cols) { const v = rec[c]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return '';
};

// 「6～10名」→6 / 「不明」→null（レンジは下限＝保守的に採る）
function parseHireRange(s) {
  const t = String(s || '').replace(/[～~－-]/g, '~');
  if (!t || /不明/.test(t)) return null;
  const m = t.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
// 「300～500人未満」→{lo:300,hi:500} / 「1千～2千人未満」→{lo:1000,hi:2000} / 「不明」→null
function parseEmpRange(s) {
  const t = String(s || '').replace(/[～~－-]/g, '~').replace(/(\d+)千/g, (_, d) => String(parseInt(d, 10) * 1000));
  if (!t || /不明/.test(t)) return null;
  const m = t.match(/(\d[\d,]*)\s*~\s*(\d[\d,]*)/);
  if (m) return { lo: parseInt(m[1].replace(/,/g, ''), 10), hi: parseInt(m[2].replace(/,/g, ''), 10) };
  const one = t.match(/(\d[\d,]*)/);
  return one ? { lo: parseInt(one[1].replace(/,/g, ''), 10), hi: null } : null;
}
function parseIntOrNull(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
// 固定電話→都道府県（市外局番長は1〜4桁と可変なので areacode テーブルで解く）。
// 携帯/フリーダイヤルは地域を含まないので空を返す＝地域照合の対象外。
function prefOfPhone(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  if (!d || MOBILE_RE.test(d) || /^0120|^0800|^0570/.test(d)) return '';
  const code = matchAreaCode(d);
  return code ? AREA_CODES[code] : '';
}
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}

// --- SF全リード（Salesforceレポート形式）をレコードとして読む ----------------
// 先頭に説明行が入るため、ヘッダ行は「会社名 / 取引先」を含む行を探して決める。
function readSfRecords(text) {
  const rows = parseCsv(text);
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    if (rows[i].some((c) => /会社名\s*\/\s*取引先/.test(String(c)))) { hi = i; break; }
  }
  if (hi < 0) return { records: [], headerFound: false };
  const headers = rows[hi].map((h) => String(h).trim());
  const records = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const rec = {};
    headers.forEach((h, j) => { if (h) rec[h] = rows[i][j] != null ? String(rows[i][j]).trim() : ''; });
    if (pick(rec, COL.name)) records.push(rec);
  }
  return { records, headerFound: true };
}

// --- マスタ読み込み ---------------------------------------------------------
function loadMasters() {
  // ハード除外に使うのは「既存顧客」と「納品済み台帳」だけ。
  // 入力はそもそもSFリード＝BALES/SF被りは除外理由にならない（既存接点として表示する）。
  const excl = buildExclusionIndex({ layers: ['customers', 'ledger'], quiet: true }).idx;

  // SF全リード: リードID18 と 社名 の両方で引けるようにする
  const sfById = new Map(); const sfByName = new Map();
  let sfRows = 0;
  if (fs.existsSync(FILES.sf)) {
    const { records, headerFound } = readSfRecords(fs.readFileSync(FILES.sf, 'utf8'));
    if (!headerFound) console.warn('[SF] ⚠ ヘッダ「会社名 / 取引先」を検出できず0件（形式変更の疑い）');
    sfRows = records.length;
    for (const r of records) {
      const id = pick(r, COL.id);
      if (id) sfById.set(id, r);
      const key = normCompanyName(pick(r, COL.name));
      if (!key) continue;
      // 同名複数リードは「情報量の多い1件」を残す
      const fill = (o) => ['採用人数(選択リスト)', '従業員数レンジ(ランスケ）', '業種', 'リード 状況']
        .reduce((s, c) => s + (o[c] && !/不明/.test(o[c]) ? 1 : 0), 0);
      const prev = sfByName.get(key);
      if (!prev || fill(r) > fill(prev)) sfByName.set(key, r);
    }
  }
  const sfName = new Map();
  for (const r of sfByName.values()) indexPut(sfName, pick(r, COL.name), r);

  // BALES既存CRM: 同一社の複数リードは「情報量の多い1件」
  const balesBest = new Map();
  let balesRows = 0;
  if (fs.existsSync(FILES.bales)) {
    for (const r of readCsv(fs.readFileSync(FILES.bales, 'utf8')).records) {
      const nm = r['会社情報：会社名'];
      const key = normCompanyName(nm);
      if (!key) continue;
      balesRows++;
      const cand = {
        industry: (r['会社情報：業種'] || '').trim(),
        emp: parseIntOrNull(r['会社情報：従業員規模']),
        hire: parseHireRange(r['カスタム情報：採用人数(選択リスト)']),
        entry: parseIntOrNull(r['カスタム情報：エントリー数']),
        stage: (r['リード関連情報：最終リードステージ'] || '').trim(),
        ats: (r['カスタム情報：利用中ATS'] || '').trim(),
        ban: (r['カスタム情報：アプローチ禁止の種類'] || '').trim(),
        kento: (r['カスタム情報：検討開始時期'] || '').trim(),
        lost: (r['カスタム情報：失注商談失注理由大'] || '').trim(),
        issue: (r['カスタム情報：顧客の課題感'] || '').trim(),
        pref: (r['会社情報：住所：都道府県'] || '').trim(),
        phone: (r['会社情報：電話'] || '').trim(),
      };
      const sc = (o) => (o.emp ? 2 : 0) + (o.hire ? 2 : 0) + (o.industry ? 1 : 0) + (o.ban ? 3 : 0) + (o.ats && o.ats !== '無し' ? 1 : 0) + (o.stage ? 1 : 0);
      const prev = balesBest.get(key);
      if (!prev || sc(cand) > sc(prev.cand)) balesBest.set(key, { name: nm, cand });
    }
  }
  const bales = new Map();
  for (const { name, cand } of balesBest.values()) indexPut(bales, name, cand);

  // 統合マスタ（従業員数・採用予定人数の“実数”補完）
  const cons = new Map();
  let consRows = 0;
  if (fs.existsSync(FILES.pool)) {
    const seen = new Set();
    for (const r of readCsv(fs.readFileSync(FILES.pool, 'utf8')).records) {
      const key = normCompanyName(r['企業名']);
      if (!key || seen.has(key)) continue;
      seen.add(key); consRows++;
      indexPut(cons, r['企業名'], {
        emp: parseIntOrNull(r['従業員数']),
        hire: parseIntOrNull(r['採用予定人数']),
        entry: parseIntOrNull(r['エントリー数']),
        industry: (r['業種'] || '').trim(),
        pref: (r['都道府県'] || '').trim(),
      });
    }
  }

  const known = Object.entries(KNOWN).reduce((m, [k, v]) => indexPut(m, k, v), new Map());
  return { excl, sfById, sfName, bales, cons, known, stats: { sfRows, balesRows, consRows } };
}

// --- 1社の判定 --------------------------------------------------------------
function judge(lead, M) {
  const warn = [];

  // ① リードID直結 → ② 社名突合（同名他社の疑いを電話の市外局番で見る）
  const leadPref = prefOfPhone(lead.phone);
  let sf = M.sfById.get(lead.id) || null;
  let sfVia = sf ? 'リードID' : '';
  let sameNameRisk = false;
  if (!sf) {
    const cand = indexGet(M.sfName, lead.name) || null;
    if (cand) {
      const p2 = prefOfPhone(pick(cand, COL.phone));
      // 社名突合は同名他社を掴む事故が起きる（例: サンテック株式会社＝愛知/大阪）。
      // 所在地が食い違ったら属性は一切採らない。誤った規模・採用人数でフロア判定するほうが危険。
      if (leadPref && p2 && leadPref !== p2) {
        sameNameRisk = true; sfVia = '突合なし(同名他社)';
        warn.push(`SF社名突合を棄却(入力${leadPref}/SF${p2})＝同名他社`);
      } else {
        sf = cand; sfVia = '社名突合';
        // 入力のリードIDがSFエクスポートに無い＝別リード/別スナップショット。属性は同名の別レコード由来。
        warn.push('入力のリードIDがSF側に無く社名で突合（属性は別リード由来）');
      }
    }
  }
  let b = indexGet(M.bales, lead.name) || {};
  if (b.phone || b.pref) {
    const p2 = b.pref || prefOfPhone(b.phone);
    if (leadPref && p2 && leadPref !== p2) {
      sameNameRisk = true;
      warn.push(`BALES社名突合を棄却(入力${leadPref}/BALES${p2})＝同名他社`);
      b = {};
    }
  }
  const cRaw = indexGet(M.cons, lead.name) || {};
  // 統合マスタは電話を持たない行が多く地域照合できない。同名他社の疑いが出た社では採らない。
  const c = sameNameRisk ? {} : cRaw;
  if (sameNameRisk && (cRaw.emp != null || cRaw.hire != null)) warn.push('統合マスタも同名他社の疑いのため不採用');
  const k = indexGet(M.known, lead.name) || {};

  const sfInd = sf ? (sf['業種'] || '').trim() : '';
  const sfEmp = sf ? parseEmpRange(sf['従業員数レンジ(ランスケ）'] || sf['従業員数レンジ(ランスケ)']) : null;
  const sfHire = sf ? parseHireRange(sf['採用人数(選択リスト)']) : null;
  const sfStatus = sf ? (sf['リード 状況'] || '').trim() : '';
  const sfTags = sf ? [sf['セミナーアンケート項目10'], sf['セミナーアンケート項目7']].filter(Boolean).join(' / ') : '';

  // 業種: BALES(CRM) > SF > 統合 > 公知
  const industry = b.industry || sfInd || c.industry || k.ind || '';
  const indSrc = b.industry ? 'BALES' : (sfInd ? 'SF' : (c.industry ? '統合マスタ' : (k.ind ? '公知' : '')));
  // 従業員数: 統合の実数 > BALES > SFレンジ下限 > 公知（レンジは下限を採り、フロア判定は「上限も下回る」時だけ効かせる）
  const emp = c.emp != null ? c.emp : (b.emp != null ? b.emp : (sfEmp ? sfEmp.lo : (k.emp != null ? k.emp : null)));
  const empSrc = c.emp != null ? '統合マスタ' : (b.emp != null ? 'BALES' : (sfEmp ? 'SFレンジ' : (k.emp != null ? '公知' : '')));
  const empHi = c.emp != null || b.emp != null ? emp : (sfEmp ? (sfEmp.hi != null ? sfEmp.hi : sfEmp.lo) : emp);
  const empLabel = empSrc === 'SFレンジ' ? `${sfEmp.lo}${sfEmp.hi ? '〜' + sfEmp.hi : '+'}` : (emp == null ? '' : String(emp));
  // 採用人数: BALES(最新CRM) > SF > 統合。食い違いは残して注記する（片方が陳腐化しているだけのことが多い）
  const hire = b.hire != null ? b.hire : (sfHire != null ? sfHire : (c.hire != null ? c.hire : null));
  const hireSrc = b.hire != null ? 'BALES' : (sfHire != null ? 'SF' : (c.hire != null ? '統合マスタ' : ''));
  const hires = [['BALES', b.hire], ['SF', sfHire], ['統合', c.hire]].filter(([, v]) => v != null);
  if (hires.length > 1 && new Set(hires.map(([, v]) => v)).size > 1) {
    warn.push('採用人数が出所で不一致(' + hires.map(([s, v]) => `${s}:${v}名`).join('/') + ')');
  }
  const entry = b.entry != null ? b.entry : (c.entry != null ? c.entry : null);

  // --- ハード除外 -----------------------------------------------------------
  const hard = [];
  const exLabel = M.excl.matchLabel(lead.name);
  if (exLabel) hard.push(exLabel);
  if (b.ban) hard.push('アプローチ禁止:' + b.ban);
  if (MEDIA_ATS_RE.test(lead.name)) hard.push('求人媒体/ATSベンダー＝同業');
  if (isExcludedIndustry(industry)) hard.push(`IT・ソフト(${industry})＝ICP絶対除外`);
  if (empHi != null && empHi < ICP.EMP_MIN) hard.push(`従業員${empLabel}名<${ICP.EMP_MIN}（規模フロア未満）`);
  if (hire != null && hire < ICP.HIRE_MIN) hard.push(`新卒${hire}名<${ICP.HIRE_MIN}（採用フロア未満・出所${hireSrc}）`);
  if (!lead.phone && !lead.mail) hard.push('連絡先なし');

  // --- ソフト（mochica-fit で採点） -----------------------------------------
  const rec = {
    '会社名': lead.name,
    '採用担当者名': lead.person,
    '電話番号': lead.phone,
    '業種': industry,
    '従業員数': emp == null ? '' : emp,
    '採用予定人数': hire == null ? '' : hire,
    'エントリー数': entry == null ? '' : entry,
    '競合ATS導入': b.ats && b.ats !== '無し' ? '1' : '',
    '来期検討': b.kento ? '1' : '',
  };
  const fit = scoreMochica(rec);
  let score = fit.total;
  const why = [];

  // 入力が持たない属性ぶんの上乗せ/減点（mochica-fit の外側で、根拠を明示して効かせる）
  if (HR_VENDOR_RE.test(lead.name) && !MEDIA_ATS_RE.test(lead.name)) { score -= 10; why.push('人材/研修系の社名＝提携・競合の見極め要'); }
  if (FREE_MAIL_RE.test(lead.mail) && !CORP_FORM_RE.test(lead.name)) { score -= 8; why.push('フリーメール×法人格なし＝法人実体が薄い疑い'); }
  else if (FREE_MAIL_RE.test(lead.mail)) { score -= 4; why.push('担当者がフリーメール＝小規模/個人窓口'); }
  if (MOBILE_RE.test(String(lead.phone).replace(/[^0-9]/g, ''))) { score -= 3; why.push('携帯番号のみ＝代表回線不明'); }
  if (b.ats && b.ats !== '無し') why.push('他社ATS導入:' + b.ats);
  if (b.kento) { score += 3; why.push('検討開始時期:' + b.kento); }
  if (b.lost) why.push('失注理由:' + b.lost);
  if (b.stage) why.push('BALES最終ステージ:' + b.stage);
  if (sfStatus) why.push('SFリード状況:' + sfStatus);
  if (emp == null) why.push('規模不明＝要エンリッチ');
  if (hire == null) why.push('新卒採用人数不明＝要エンリッチ');
  score = Math.max(0, Math.min(100, Math.round(score)));

  // --- 判定バンド -----------------------------------------------------------
  let rank;
  if (hard.length) rank = '除外';
  else if (score >= 70) rank = 'A';
  else if (score >= 55) rank = 'B';
  else if (score >= 40) rank = 'C';
  else rank = 'D';
  // 規模・採用人数のどちらかが未判明ならICP適合と言い切れない＝A/Bには入れない
  if ((emp == null || hire == null) && (rank === 'A' || rank === 'B')) {
    rank = 'C'; why.push('規模/採用人数が未判明のため要確認どまり');
  }
  if (warn.some((w) => /同名他社/.test(w)) && rank === 'A') { rank = 'C'; why.push('同名他社の疑いのため要確認どまり'); }

  const tier = proposalTier(emp);
  const next = hard.length ? '架電しない'
    : (emp == null || hire == null) ? '規模/新卒人数を裏取りしてから架電'
      : rank === 'A' ? '今週架電' : rank === 'B' ? '次点で架電' : 'ナーチャリング';

  return {
    判定: rank,
    スコア: score,
    確信度: fit.confidence,
    会社名: lead.name,
    担当者名: lead.person,
    電話番号: lead.phone,
    メール: lead.mail,
    リードID: lead.id,
    業種: industry,
    業種出所: indSrc,
    従業員数: empLabel,
    規模出所: empSrc,
    新卒採用人数: hire == null ? '' : hire,
    採用数出所: hireSrc,
    セグメント: tier.segment,
    提案プラン: tier.plan,
    SF突合: sfVia,
    SFリード状況: sfStatus,
    SFタグ: sfTags,
    BALES最終ステージ: b.stage || '',
    利用中ATS: b.ats || '',
    検討開始時期: b.kento || '',
    失注理由: b.lost || '',
    除外理由: hard.join(' / '),
    注意: warn.join(' / '),
    次アクション: next,
    根拠: why.concat(fit.why ? [fit.why] : []).join(' / '),
  };
}

function main() {
  const inFile = arg('in', '');
  const outFile = arg('out', path.join(ROOT, 'data', 'leads-sf-scored.csv'));
  if (!inFile || !fs.existsSync(inFile)) { console.error('--in <leads.csv> が必要です'); process.exit(1); }

  const { records } = readCsv(fs.readFileSync(inFile, 'utf8'));
  const leads = records.map((r) => ({
    name: pick(r, COL.name), person: pick(r, COL.person),
    phone: pick(r, COL.phone), mail: pick(r, COL.mail), id: pick(r, COL.id),
  })).filter((l) => l.name);

  const M = loadMasters();
  console.log(`マスタ: SF全リード${M.stats.sfRows}件 / BALES${M.stats.balesRows}行 / 統合${M.stats.consRows}社 / 除外索引${M.excl.size}キー`);

  const rows = leads.map((l) => judge(l, M));
  const order = { A: 0, B: 1, C: 2, D: 3, 除外: 4 };
  rows.sort((a, b) => (order[a.判定] - order[b.判定]) || (b.スコア - a.スコア));

  fs.writeFileSync(outFile, '﻿' + toCsv(Object.keys(rows[0]), rows), 'utf8');
  const tally = rows.reduce((m, r) => { m[r.判定] = (m[r.判定] || 0) + 1; return m; }, {});
  console.log('判定内訳: ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' / '));
  console.log('出力: ' + outFile + '\n');
  for (const r of rows) {
    console.log(`[${r.判定}] ${String(r.スコア).padStart(3)} ${r.会社名}（${r.担当者名}）`);
    console.log(`      業種:${r.業種 || '不明'}[${r.業種出所 || '-'}] 規模:${r.従業員数 || '不明'}[${r.規模出所 || '-'}] 新卒:${r.新卒採用人数 || '不明'}[${r.採用数出所 || '-'}]`);
    if (r.除外理由) console.log(`      除外: ${r.除外理由}`);
    if (r.注意) console.log(`      注意: ${r.注意}`);
    console.log(`      → ${r.次アクション} / ${r.根拠}`);
  }
}
if (require.main === module) main();
module.exports = { judge, loadMasters, readSfRecords, parseEmpRange, parseHireRange };
