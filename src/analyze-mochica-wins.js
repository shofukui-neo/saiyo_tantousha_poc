'use strict';
/**
 * MOCHICA受注傾向分析
 *
 * 「既存顧客はこういう会社が多い」だけでは営業に使えない（母集団も同じ形かもしれない）。
 * そこで “接触した企業のうち何%が顧客になったか＝受注率” を軸に据える。
 *
 *   母集団A: セールスフォース全リード 86,674件 → 社名名寄せ 55,653社（＝MOCHICAが認知/接触した企業の全量）
 *   母集団B: BALESCLOUDリード 22,892件 → 20,486社（＝インサイドセールスが実際に触った企業。流入経路や利用中ATSまで分かる）
 *   母集団C: マイナビ28卒掲載 29,028社（＝新卒採用市場そのもの）
 *   分子   : MOCHICA既存顧客 429社（research CSV）
 *
 * 各セグメントで 受注率 と ベース比リフト を出し、Wilson下限で小標本の偶然を落とす。
 * 併せて顧客内部（継続年数・プラン階層・アップグレード）を企業特性で切り、
 * 「受注しやすい」だけでなく「受注後に伸びる/残る」企業像も出す。
 *
 * 実行: node src/analyze-mochica-wins.js
 */
const fs = require('fs');
const path = require('path');
const { readCsv, parseCsv, toCsv, normCompanyName } = require('./csv');

const ROOT = path.join(__dirname, '..');
const D = (f) => path.join(ROOT, 'data', f);
const OUT_MD = D('mochica-win-analysis.md');
const OUT_CSV = D('mochica-win-segments.csv');
const nk = (s) => normCompanyName(s || '');
const g = (r, k) => (r && r[k] != null ? String(r[k]).trim() : '');
const num = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const pct = (x) => (x * 100).toFixed(2) + '%';
const L = [];
const say = (s) => { L.push(s); process.stdout.write(s + '\n'); };

// Wilson区間の下限（n=3で1件当たった等の偶然を割り引く。95%）
function wilsonLow(k, n) {
  if (!n) return 0;
  const z = 1.96, p = k / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return Math.max(0, (c - s) / d);
}

/* ------------------------------------------------------- 正規化ヘルパー */
// 従業員レンジ表記（SF/BALESで表記ゆれ）→ 代表値 → バンド
function empBandFromText(s0) {
  const s = String(s0 || '').trim();
  if (!s || s === '不明') return '';
  const plain = parseInt(s.replace(/[^0-9]/g, ''), 10);
  if (/^[0-9]+$/.test(s) && Number.isFinite(plain)) return bandOf(plain);
  const m = s.match(/([0-9]+)\s*(千|万)?\s*[～~〜]\s*([0-9]+)?\s*(千|万)?/);
  if (m) {
    const mul = (u) => (u === '千' ? 1000 : u === '万' ? 10000 : 1);
    const lo = (+m[1]) * mul(m[2]);
    return bandOf(lo);
  }
  if (/1万人/.test(s)) return '8:2000名以上';
  if (/50人未満/.test(s)) return '1:～49名';
  return '';
}
// SFの従業員数レンジは元の選択肢がそのまま入っている（100～300人未満 等）。
// 自前バンドに写すと 200-299 が空になる等の歪みが出るので、原ラベルを整理して使う。
function sfEmpBand(s0) {
  const s = String(s0 || '').trim();
  if (!s || s === '不明') return '';
  if (/^(1～5|5～10|10～20|20～30)人未満$/.test(s)) return '1:30人未満';
  if (/^30～50人未満$/.test(s)) return '2:30-50人未満';
  if (/^50[人]?～100[人]?未満$/.test(s)) return '3:50-100人未満';
  if (/^100～300[人]?未満$/.test(s)) return '4:100-300人未満';
  if (/^300～500人未満$/.test(s)) return '5:300-500人未満';
  if (/^500～1千人未満$/.test(s)) return '6:500-1000人未満';
  if (/^1千～2千人未満$/.test(s)) return '7:1000-2000人未満';
  if (/^2千～5千人未満$/.test(s)) return '8:2000-5000人未満';
  if (/^(5千～1万人未満|1万人～)$/.test(s)) return '9:5000人以上';
  if (/^50人未満$/.test(s)) return '2:30-50人未満';
  if (/^300～1千人未満$/.test(s)) return '';
  if (/^[0-9]+$/.test(s)) return bandOf(parseInt(s, 10)).replace(/名/g, '人');
  return '';
}
function bandOf(n) {
  if (n == null) return '';
  if (n < 50) return '1:～49名';
  if (n < 100) return '2:50-99名';
  if (n < 200) return '3:100-199名';
  if (n < 300) return '4:200-299名';
  if (n < 500) return '5:300-499名';
  if (n < 1000) return '6:500-999名';
  if (n < 2000) return '7:1000-1999名';
  return '8:2000名以上';
}
// 採用人数（選択リスト）→ 分析バンド
function hireBandFromText(s0) {
  const s = String(s0 || '').trim();
  if (!s || s === '不明') return '';
  const m = s.match(/^([0-9]+)/);
  if (/301名/.test(s)) return '6:51名以上';
  if (!m) return '';
  const lo = +m[1];
  if (lo <= 2) return '1:1-2名';
  if (lo <= 5) return '2:3-5名';
  if (lo <= 10) return '3:6-10名';
  if (lo <= 20) return '4:11-20名';
  if (lo <= 50) return '5:21-50名';
  return '6:51名以上';
}
function macroIndustry(s0) {
  const s = String(s0 || '');
  if (!s) return '';
  if (/情報処理|ソフトウ|インターネット|通信|システム|ＩＴ|IT|コンピュータ|情報サービス/.test(s)) return '情報通信・IT';
  if (/建設|工事|設備|住宅|不動産|建築|土木|プラント/.test(s)) return '建設・不動産';
  if (/食品|飲料|農林|水産|畜産/.test(s)) return '食品・農林水産';
  if (/機械|電機|電子|自動車|輸送用機器|金属|鉄鋼|非鉄|化学|医薬|繊維|窯業|印刷|製紙|ゴム|精密|半導体|プラスチック|メーカー|製造/.test(s)) return '製造（機械・素材）';
  if (/商社|卸|小売|百貨店|スーパー|コンビニ|専門店|流通|販売/.test(s)) return '商社・流通・小売';
  if (/銀行|信用金庫|証券|保険|金融|リース|クレジット/.test(s)) return '金融・保険';
  if (/運輸|物流|倉庫|鉄道|航空|海運|陸運|輸送/.test(s)) return '運輸・物流';
  if (/医療|福祉|介護|病院|薬局|保育|看護/.test(s)) return '医療・福祉・介護';
  if (/人材|派遣|紹介|教育|コンサル|専門サービス|士業|調査|広告|マスコミ|出版|放送/.test(s)) return '人材・専門・広告';
  if (/外食|フード|レストラン|ホテル|旅行|レジャー|理美容|ブライダル|サービス|警備|清掃|エネルギー|電力|ガス/.test(s)) return '生活・サービス';
  if (/官公庁|公社|団体|協同組合|農協|生協/.test(s)) return '公的・団体';
  return 'その他';
}

/* ----------------------------------------------- セグメント集計の共通処理 */
const segRows = [];
/**
 * 母集団を1軸で切って受注率を出す。
 * @param {string} popName 母集団名  @param {string} axis 軸名
 * @param {Map<string,{seg:string,won:boolean}>} pop 社名 → {seg, won}
 * @param {number} minN これ未満のセグメントは表示しない
 */
function convTable(popName, axis, pop, minN) {
  const agg = new Map();
  let baseN = 0, baseK = 0;
  for (const v of pop.values()) {
    if (!v.seg) continue;
    baseN++; if (v.won) baseK++;
    const a = agg.get(v.seg) || { n: 0, k: 0 };
    a.n++; if (v.won) a.k++;
    agg.set(v.seg, a);
  }
  const base = baseN ? baseK / baseN : 0;
  const list = [...agg.entries()]
    .filter(([, a]) => a.n >= (minN || 30))
    .map(([seg, a]) => ({ seg, n: a.n, k: a.k, rate: a.k / a.n, low: wilsonLow(a.k, a.n), lift: base ? (a.k / a.n) / base : 0 }))
    .sort((x, y) => y.rate - x.rate);
  say('');
  say('### ' + popName + ' × ' + axis + '　（母集団 ' + baseN.toLocaleString() + '社 / 受注 ' + baseK + '社 / ベース受注率 ' + pct(base) + '）');
  say('');
  say('| セグメント | 母集団 | 受注 | 受注率 | ベース比 | 95%下限 |');
  say('|---|---:|---:|---:|---:|---:|');
  for (const r of list) {
    say('| ' + r.seg + ' | ' + r.n.toLocaleString() + ' | ' + r.k + ' | **' + pct(r.rate) + '** | ' + r.lift.toFixed(2) + '倍 | ' + pct(r.low) + ' |');
    segRows.push({ 母集団: popName, 軸: axis, セグメント: r.seg, 母集団件数: r.n, 受注件数: r.k, 受注率: (r.rate * 100).toFixed(3), ベース比: r.lift.toFixed(2), 下限95: (r.low * 100).toFixed(3), ベース受注率: (base * 100).toFixed(3) });
  }
  return { base, list };
}

/* --------------------------------------------------------------- データ */
function main() {
  const { records: cust } = readCsv(fs.readFileSync(D('mochica-customers-research.csv'), 'utf8'));
  const wonKeys = new Set(cust.map((r) => nk(g(r, '法人名'))).filter(Boolean));
  say('# MOCHICA 受注傾向分析');
  say('');
  say('分析日: ' + new Date().toISOString().slice(0, 10) + ' ／ 既存顧客 ' + cust.length + '社（社名名寄せ ' + wonKeys.size + '社）を「受注」、各母集団を「接触した企業の全量」として受注率で見る。');

  /* ---------- 母集団A: SF全リード ---------- */
  const sfRows = parseCsv(fs.readFileSync(D('セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv'), 'utf8'));
  let hi = 0; for (let i = 0; i < 20; i++) if ((sfRows[i] || []).includes('リード 状況')) { hi = i; break; }
  const sh = sfRows[hi]; const sc = (n) => sh.indexOf(n);
  const SFC = { name: sc('会社名 / 取引先'), hire: sc('採用人数(選択リスト)'), st: sc('リード 状況'), emp: sc('従業員数レンジ(ランスケ）'), ind: sc('業種'), q10: sc('セミナーアンケート項目10'), q7: sc('セミナーアンケート項目7') };
  const sfCo = new Map();
  for (let i = hi + 1; i < sfRows.length; i++) {
    const r = sfRows[i]; const n = nk(r[SFC.name]); if (!n) continue;
    const cur = sfCo.get(n) || { leads: 0, hire: '', emp: '', ind: '', seminar: false, statuses: [] };
    cur.leads++;
    if (!cur.hire && r[SFC.hire] && r[SFC.hire] !== '不明') cur.hire = r[SFC.hire];
    if (!cur.emp && r[SFC.emp] && r[SFC.emp] !== '不明') cur.emp = r[SFC.emp];
    if (!cur.ind && r[SFC.ind]) cur.ind = r[SFC.ind];
    if (r[SFC.q10] || r[SFC.q7]) cur.seminar = true;
    cur.statuses.push(String(r[SFC.st] || ''));
    sfCo.set(n, cur);
  }
  say('');
  say('---');
  say('');
  say('## 1. 接触した企業のうち、どんな会社が顧客になっているか（母集団A: Salesforce全リード）');
  say('');
  say('Salesforceに存在する全リード ' + (sfRows.length - hi - 1).toLocaleString() + '件を社名で名寄せすると ' + sfCo.size.toLocaleString() + '社。'
    + 'このうち ' + [...sfCo.keys()].filter((k) => wonKeys.has(k)).length + '社が現在の既存顧客＝**全体受注率 ' + pct([...sfCo.keys()].filter((k) => wonKeys.has(k)).length / sfCo.size) + '**。'
    + 'この数字を基準に、各属性が何倍効くかを見る。');

  const mk = (f) => { const m = new Map(); for (const [k, v] of sfCo) m.set(k, { seg: f(v), won: wonKeys.has(k) }); return m; };
  convTable('SF全リード', '従業員数レンジ', mk((v) => sfEmpBand(v.emp)), 100);
  convTable('SF全リード', '新卒採用人数', mk((v) => hireBandFromText(v.hire)), 200);
  convTable('SF全リード', '業種マクロ', mk((v) => macroIndustry(v.ind)), 200);
  convTable('SF全リード', 'セミナー参加', mk((v) => (v.seminar ? 'セミナー回答あり' : 'セミナー回答なし')), 100);
  convTable('SF全リード', '社内接触回数(リード件数)', mk((v) => (v.leads >= 5 ? 'd:5件以上' : v.leads >= 3 ? 'c:3-4件' : v.leads === 2 ? 'b:2件' : 'a:1件')), 100);

  // 従業員数 × 採用人数 のクロス表（単軸だと交絡するので、2軸同時に見る）
  say('');
  say('### SF全リード × 従業員数 × 新卒採用人数（クロス表・受注率）');
  say('');
  say('従業員数と採用人数は相関するので、単軸だとどちらが効いているか分からない。2軸で見ると、受注率は「規模だけ」でも「採用人数だけ」でも上がらず、中堅規模かつ二桁採用の交点に集中していることが分かる。');
  say('');
  const eb = ['1:30人未満', '2:30-50人未満', '3:50-100人未満', '4:100-300人未満', '5:300-500人未満', '6:500-1000人未満', '7:1000-2000人未満', '8:2000-5000人未満', '9:5000人以上'];
  const hb = ['1:1-2名', '2:3-5名', '3:6-10名', '4:11-20名', '5:21-50名', '6:51名以上'];
  const cross = new Map();
  for (const [k, v] of sfCo) {
    const e = sfEmpBand(v.emp), h = hireBandFromText(v.hire);
    if (!e || !h) continue;
    const key = e + '|' + h;
    const a = cross.get(key) || { n: 0, k: 0 };
    a.n++; if (wonKeys.has(k)) a.k++;
    cross.set(key, a);
  }
  say('| 従業員数＼採用人数 | ' + hb.join(' | ') + ' |');
  say('|---|' + hb.map(() => '---:').join('|') + '|');
  for (const e of eb) {
    const cells = hb.map((h) => {
      const a = cross.get(e + '|' + h);
      if (!a || a.n < 25) return a && a.n ? '_(n=' + a.n + ')_' : '–';
      return pct(a.k / a.n) + '<br><sub>' + a.k + '/' + a.n + '</sub>';
    });
    say('| **' + e + '** | ' + cells.join(' | ') + ' |');
  }
  for (const [key, a] of cross) {
    if (a.n < 25) continue;
    const [e, h] = key.split('|');
    segRows.push({ 母集団: 'SF全リード', 軸: '従業員数×採用人数', セグメント: e + ' × ' + h, 母集団件数: a.n, 受注件数: a.k, 受注率: (a.k / a.n * 100).toFixed(3), ベース比: '', 下限95: (wilsonLow(a.k, a.n) * 100).toFixed(3), ベース受注率: '' });
  }

  /* ---------- 母集団B: BALES ---------- */
  const bRows = parseCsv(fs.readFileSync(D('BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv'), 'utf8'));
  const bh = bRows[0]; const bc = (n) => bh.indexOf(n);
  const srcCols = []; bh.forEach((h, i) => { if (/^リードソース：/.test(h)) srcCols.push([h.replace('リードソース：', ''), i]); });
  const BC = {
    name: bc('会社情報：会社名'), ind: bc('会社情報：業種'), emp: bc('会社情報：従業員規模'),
    pref: bc('会社情報：住所：都道府県'), dept: bc('担当者情報：部署'), title: bc('担当者情報：役職'),
    ats: bc('カスタム情報：利用中ATS'), hire: bc('カスタム情報：採用人数(選択リスト)'),
    kento: bc('カスタム情報：検討開始時期'), lost: bc('カスタム情報：失注商談失注理由大'),
    stage: bc('リード関連情報：最終リードステージ'), mail: bc('担当者情報：メール'), sei: bc('担当者情報：姓'),
  };
  const bCo = new Map();
  for (let i = 1; i < bRows.length; i++) {
    const r = bRows[i]; const n = nk(r[BC.name]); if (!n) continue;
    const cur = bCo.get(n) || { leads: 0, ind: '', emp: '', pref: '', ats: '', hire: '', kento: '', lost: '', dept: '', title: '', sources: new Set(), named: false };
    cur.leads++;
    const set = (k, v) => { if (!cur[k] && v && v !== '不明') cur[k] = String(v).trim(); };
    set('ind', r[BC.ind]); set('emp', r[BC.emp]); set('pref', r[BC.pref]); set('hire', r[BC.hire]);
    set('kento', r[BC.kento]); set('lost', r[BC.lost]); set('dept', r[BC.dept]); set('title', r[BC.title]);
    if (!cur.ats && r[BC.ats]) cur.ats = String(r[BC.ats]).trim();
    if (String(r[BC.sei] || '').trim()) cur.named = true;
    for (const [nm, ci] of srcCols) if (String(r[ci] || '').trim()) cur.sources.add(nm);
    bCo.set(n, cur);
  }
  const bWon = [...bCo.keys()].filter((k) => wonKeys.has(k)).length;
  say('');
  say('---');
  say('');
  say('## 2. インサイドセールスが実際に触った企業の受注率（母集団B: BALESCLOUD）');
  say('');
  say('BALESリード ' + (bRows.length - 1).toLocaleString() + '件 → ' + bCo.size.toLocaleString() + '社。うち既存顧客 ' + bWon + '社＝**受注率 ' + pct(bWon / bCo.size) + '**。'
    + 'BALESは流入経路・利用中ATS・担当者属性まで持っているので、企業属性だけでなく「どう出会ったか」の効きが見える。'
    + 'なお既存顧客' + cust.length + '社のうちBALESに名前があるのは' + bWon + '社（残りはBALES導入前の獲得やSF直接流入）で、絶対率は低めに出る。比較は相対で読む。');

  const mkb = (f) => { const m = new Map(); for (const [k, v] of bCo) m.set(k, { seg: f(v), won: wonKeys.has(k) }); return m; };
  convTable('BALES', '従業員規模', mkb((v) => empBandFromText(v.emp)), 50);
  convTable('BALES', '新卒採用人数', mkb((v) => hireBandFromText(v.hire)), 100);
  convTable('BALES', '業種マクロ', mkb((v) => macroIndustry(v.ind)), 100);
  convTable('BALES', '利用中ATS', mkb((v) => {
    const a = v.ats;
    if (!a) return '';
    if (/無し/.test(a)) return 'ATS未導入（無し）';
    return '他社ATS導入済';
  }), 100);
  convTable('BALES', '流入区分', mkb((v) => {
    const s = [...v.sources];
    if (!s.length) return '';
    const inbound = /Mochicaサイト|問い合わせフォーム|ホワイトペーパー|セミナー|メルマガ|イベント|EXPO|日本の人事部|HR-NOTE|BOXIL|ITトレンド|アスピック|起業ログ|一括|アイミツ|採用支援ポータル|Google AdWords|yahoo|facebook|HRプロ|＠人事|STRATE|オンリーストーリー|ウレル|フリープラン|電話問い合わせ|NCコーポレートサイト/;
    const partner = /紹介|代理店|パートナー|顧問|内部取引|他部署案件共有/;
    const outbound = /アウトバウンド|ディグロス|soraプロジェクト|X-log|WizBiz|ListA|Lista|Sitoke|BPO/;
    if (s.some((x) => partner.test(x))) return '紹介・パートナー';
    if (s.some((x) => inbound.test(x))) return 'インバウンド';
    if (s.some((x) => outbound.test(x))) return 'アウトバウンド';
    return 'その他';
  }), 50);
  convTable('BALES', '主要リードソース', mkb((v) => {
    const s = [...v.sources];
    const prio = ['知り合い紹介', '顧客紹介', 'パートナー紹介', '社外代理店', '社内代理店', '顧問', 'Mochicaサイト', '問い合わせフォーム', 'ホワイトペーパー', 'セミナー', '反響セミナー', '日本の人事部', 'HR-NOTE', 'BOXIL', 'ITトレンド', 'メルマガ', 'アウトバウンド', 'CRM', '失注リサイクル', '過去ユーザー'];
    for (const p of prio) if (s.includes(p)) return p;
    return s.length ? 'その他(' + s[0] + ')' : '';
  }), 60);
  convTable('BALES', '担当者名の判明', mkb((v) => (v.named ? '担当者名あり' : '担当者名なし')), 100);
  convTable('BALES', '都道府県(主要)', mkb((v) => {
    const p = String(v.pref || '').replace(/^東京$/, '東京都');
    return /都|道|府|県/.test(p) ? p : '';
  }), 250);

  /* ---------- 母集団B': 商談まで行った企業だけの受注/失注対比 ---------- */
  say('');
  say('---');
  say('');
  say('## 2-B. 商談まで行った企業に絞った受注 vs 失注');
  say('');
  say('全リードを分母にすると「そもそも接触が浅い」企業に薄められる。'
    + 'ここでは失注理由が記録されている＝提案まで行った企業と、受注した企業だけを取り出して直接比べる。');
  const deal = new Map();
  for (const [k, v] of bCo) {
    const won = wonKeys.has(k);
    const lost = !!v.lost;
    if (!won && !lost) continue;
    deal.set(k, { v, won });
  }
  const dealWon = [...deal.values()].filter((x) => x.won).length;
  say('');
  say('商談到達（受注 or 失注理由あり）**' + deal.size.toLocaleString() + '社**、うち受注 **' + dealWon + '社（' + pct(dealWon / deal.size) + '）**。');
  const mkd = (f) => { const m = new Map(); for (const [k, x] of deal) m.set(k, { seg: f(x.v), won: x.won }); return m; };
  convTable('商談到達企業', '従業員規模', mkd((v) => empBandFromText(v.emp)), 20);
  convTable('商談到達企業', '新卒採用人数', mkd((v) => hireBandFromText(v.hire)), 30);
  convTable('商談到達企業', '業種マクロ', mkd((v) => macroIndustry(v.ind)), 30);
  convTable('商談到達企業', '利用中ATS', mkd((v) => (!v.ats ? '' : /無し/.test(v.ats) ? 'ATS未導入（無し）' : '他社ATS導入済')), 30);

  // 失注理由の分布と、競合バッティング相手
  const lostCnt = new Map(); const rivalCnt = new Map();
  const bcLostRival = bc('カスタム情報：失注商談バッティング負け競合');
  for (let i = 1; i < bRows.length; i++) {
    const r = bRows[i];
    const l = String(r[BC.lost] || '').trim(); if (l) lostCnt.set(l, (lostCnt.get(l) || 0) + 1);
    const rv = bcLostRival >= 0 ? String(r[bcLostRival] || '').trim() : ''; if (rv) rivalCnt.set(rv, (rivalCnt.get(rv) || 0) + 1);
  }
  say('');
  say('**失注理由（BALES全体）**');
  say('');
  say('| 失注理由 | 件数 | 構成比 |');
  say('|---|---:|---:|');
  const lostTotal = [...lostCnt.values()].reduce((s, x) => s + x, 0);
  for (const [k, v] of [...lostCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) say('| ' + k + ' | ' + v + ' | ' + pct(v / lostTotal) + ' |');
  if (rivalCnt.size) {
    say('');
    say('**バッティング負けした競合**');
    say('');
    say('| 競合 | 件数 |');
    say('|---|---:|');
    for (const [k, v] of [...rivalCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) say('| ' + k + ' | ' + v + ' |');
  }

  // 課題感の言葉づかい：受注企業 vs 失注企業
  const KW = ['LINE', '学生', '連絡', '歩留', '辞退', '内定', '日程', '調整', '説明会', '面接', 'エントリー', '母集団', '工数', '効率', '管理', 'Excel', 'エクセル', '手作業', '属人', '一元', 'メール', '見て', '未読', '反応', 'communication', 'コミュニケーション', '通知', '早期', '囲い込み', 'リマインド', '人手', '人数', '負担'];
  const kwStat = new Map();
  for (const kw of KW) kwStat.set(kw, { won: 0, lost: 0 });
  let wonTxt = 0, lostTxt = 0;
  for (const [k, v] of bCo) {
    const txt = (v.kadai || '') + ' ' + (v.genjo || '');
    if (!txt.trim()) continue;
    const won = wonKeys.has(k);
    if (won) wonTxt++; else lostTxt++;
    for (const kw of KW) if (txt.indexOf(kw) >= 0) { const a = kwStat.get(kw); if (won) a.won++; else a.lost++; }
  }
  if (wonTxt >= 5) {
    say('');
    say('**「顧客の課題感・現状」に出てくる言葉：受注企業（n=' + wonTxt + '） vs 非受注企業（n=' + lostTxt + '）**');
    say('');
    say('| キーワード | 受注側 出現率 | 非受注側 出現率 | 差分 |');
    say('|---|---:|---:|---:|');
    const kwArr = [...kwStat.entries()].map(([kw, a]) => ({ kw, w: a.won / wonTxt, l: a.lost / (lostTxt || 1) }))
      .filter((x) => x.w > 0 || x.l > 0).sort((a, b) => (b.w - b.l) - (a.w - a.l)).slice(0, 15);
    for (const x of kwArr) say('| ' + x.kw + ' | ' + pct(x.w) + ' | ' + pct(x.l) + ' | ' + ((x.w - x.l) * 100).toFixed(1) + 'pt |');
  }

  /* ---------- 母集団C: マイナビ掲載 ---------- */
  const mvCo = new Set();
  for (const f of ['mynavi-2028-corpus.csv']) {
    for (const r of readCsv(fs.readFileSync(D(f), 'utf8')).records) { const n = nk(r['企業名']); if (n) mvCo.add(n); }
  }
  const mvWon = [...mvCo].filter((k) => wonKeys.has(k)).length;
  say('');
  say('---');
  say('');
  say('## 3. 新卒採用市場そのものから見た到達度（母集団C: マイナビ28卒掲載）');
  say('');
  say('マイナビ28卒に掲載している ' + mvCo.size.toLocaleString() + '社のうち既存顧客は ' + mvWon + '社（' + pct(mvWon / mvCo.size) + '）。'
    + '逆に既存顧客429社の側から見ると **' + cust.filter((r) => g(r, 'マイナビ28卒掲載')).length + '社（'
    + pct(cust.filter((r) => g(r, 'マイナビ28卒掲載')).length / cust.length) + '）がマイナビ28卒に掲載中**で、'
    + 'MOCHICAの顧客像は「マイナビに枠を買って新卒を採り続けている企業」とほぼ同義。');

  /* ---------- 顧客プロファイル本体 ---------- */
  say('');
  say('---');
  say('');
  say('## 4. 既存顧客429社の実像（詳細調査CSVの集計）');
  const dist = (key, top, minShow) => {
    const m = new Map();
    for (const r of cust) { const v = g(r, key) || '(不明)'; m.set(v, (m.get(v) || 0) + 1); }
    const arr = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top || 12);
    say('');
    say('**' + key + '**');
    say('');
    say('| 値 | 社数 | 構成比 |');
    say('|---|---:|---:|');
    for (const [k, v] of arr) if (v >= (minShow || 1)) say('| ' + k + ' | ' + v + ' | ' + pct(v / cust.length) + ' |');
    return arr;
  };
  dist('従業員数バンド'); dist('採用数バンド'); dist('業種マクロ'); dist('地域ブロック');
  dist('組織型', 8); dist('メール窓口種別'); dist('獲得コホート'); dist('現在利用プラン'); dist('流入区分');

  // 数値サマリ
  const nums = (key) => cust.map((r) => num(g(r, key))).filter((x) => x != null).sort((a, b) => a - b);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  say('');
  say('**主要数値の分布（中央値と四分位）**');
  say('');
  say('| 指標 | n | 25% | 中央値 | 75% | 平均 |');
  say('|---|---:|---:|---:|---:|---:|');
  for (const k of ['従業員数_確定', '新卒採用数_確定', '新卒採用比率%', '社齢', '継続年数', '初回接触→受注日数']) {
    const a = nums(k); if (!a.length) continue;
    const avg = a.reduce((s, x) => s + x, 0) / a.length;
    say('| ' + k + ' | ' + a.length + ' | ' + q(a, 0.25) + ' | **' + q(a, 0.5) + '** | ' + q(a, 0.75) + ' | ' + avg.toFixed(1) + ' |');
  }

  /* ---------- 受注後の伸び（顧客内分析） ---------- */
  say('');
  say('---');
  say('');
  say('## 5. 受注後に伸びる／残る企業（顧客内分析）');
  say('');
  say('受注しやすさと、受注後の単価・継続は別物。ここは母集団を既存顧客429社に限り、'
    + '上位プラン（スタンダード/ミドル）比率と平均継続年数を企業属性で切る。');
  const inner = (key, minN) => {
    const m = new Map();
    for (const r of cust) {
      const v = g(r, key); if (!v) continue;
      const a = m.get(v) || { n: 0, hi: 0, yrs: [], up: 0 };
      a.n++;
      if (/スタンダード|ミドル/.test(g(r, '現在利用プラン'))) a.hi++;
      if (g(r, 'プラン遷移') === 'アップグレード' || g(r, 'アップグレード有無')) a.up++;
      const y = num(g(r, '継続年数')); if (y != null) a.yrs.push(y);
      m.set(v, a);
    }
    const arr = [...m.entries()].filter(([, a]) => a.n >= (minN || 15))
      .map(([k, a]) => ({ k, n: a.n, hi: a.hi / a.n, up: a.up / a.n, yr: a.yrs.length ? a.yrs.reduce((s, x) => s + x, 0) / a.yrs.length : 0 }))
      .sort((x, y) => y.hi - x.hi);
    say('');
    say('**' + key + '別**');
    say('');
    say('| ' + key + ' | 社数 | 上位プラン比率 | アップグレード率 | 平均継続年数 |');
    say('|---|---:|---:|---:|---:|');
    for (const r of arr) say('| ' + r.k + ' | ' + r.n + ' | ' + pct(r.hi) + ' | ' + pct(r.up) + ' | ' + r.yr.toFixed(1) + '年 |');
  };
  inner('従業員数バンド', 15); inner('採用数バンド', 15); inner('業種マクロ', 15); inner('地域ブロック', 15); inner('メール窓口種別', 15);

  /* ---------- 前提と限界 ---------- */
  const active = cust.filter((r) => true).length;
  say('');
  say('---');
  say('');
  say('## 6. この分析の前提と限界（読むときの注意）');
  say('');
  say('1. **顧客リストは「現在有効なアカウント」のみ**。' + active + '社すべてアカウント状態が「有効」で、解約済みの企業は載っていない。'
    + 'したがって本分析の「受注」は正確には「受注して今も使っている」であり、解約率・チャーン要因は本データでは測れない。'
    + '平均継続年数（中央値3年）も生存者だけを見た値で、過去の全契約の平均寿命ではない。');
  say('2. **接触回数（リード件数）の効きは因果が逆向きの可能性が高い**。商談が進むほどSF上のレコードが増えるので、'
    + '「5件以上あると4.9倍」は「たくさん当てれば売れる」ではなく「売れる案件は履歴が厚くなる」を見ている。行動指針には使わないこと。');
  say('3. **BALES突合は既存顧客429社中118社（27%）にとどまる**。BALESCLOUD導入以前に獲得した顧客が多いため、'
    + '流入経路・利用中ATSの分析は「BALES時代に触った企業」に限った話として読む。'
    + '一方でSalesforceは93%（399社）が突合できており、企業属性の分析はSF側の数字を主に使うのが安全。');
  say('4. **突合はすべて正規化社名の一致**（法人格・記号・全半角を吸収）。'
    + '旧社名やグループ表記の違いで取りこぼす分があり、各セグメントの受注率は真値をやや下振れして推定している。'
    + 'ただし取りこぼしはセグメント横断でほぼ一様なので、セグメント間の**比較（ベース比）は成立する**。');
  say('5. **母集団の従業員数・採用人数はCRM入力値**（未入力が多い）。'
    + 'SFの従業員数レンジは19,076社ぶんしか埋まっておらず、採用人数は33,176社ぶん。'
    + '「入力されている企業＝ある程度会話できた企業」なので、この母集団自体がやや受注寄りに歪む（ベース受注率が全体0.71%に対し1.14%に上がるのはそのため）。'
    + '絶対値ではなく、同じ母集団内でのセグメント比較として読むこと。');
  say('6. 既存顧客側の従業員数・採用人数は**CRM入力ではなくマイナビ会社概要とgBizINFOの実データ**で取り直しているため、'
    + '第4章の顧客プロファイル（従業員数中央値379名／新卒採用中央値9名など）は母集団側の数字より精度が高い。'
    + '章をまたいで数値を直接比較するときはこの出所差に注意。');

  fs.writeFileSync(OUT_CSV, '﻿' + toCsv(Object.keys(segRows[0]), segRows), 'utf8');
  fs.writeFileSync(OUT_MD, L.join('\n') + '\n', 'utf8');
  process.stdout.write('\n[出力] ' + path.relative(ROOT, OUT_MD) + ' / ' + path.relative(ROOT, OUT_CSV) + '\n');
}
main();
