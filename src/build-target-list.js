'use strict';
// MOCHICAターゲット精選リスト生成
// 方針: セグメント優先 ＋ 緩め(業種空欄は残す)
//  1) ベース = leads-mochica.scored.csv (MOCHICA適合スコア・業種・従業員数・代表者名・架電呼称を保持)
//  2) 採用担当者名を全名簿(Wantedly/cache/mynavi/enrichment)から社名正規化キーで補完
//  3) 明確に対象外の人気/軸外業種(人材派遣・金融・商社・広告マスコミ・コンサル)を除外
//  4) 従業員100名以上(既知のみ。空欄・100未満は除外)
//  5) 業種をユーザーのセグメント定義で分類し ICPランク(A=300-1000) を付与
//  出力: leads-mochica-target.csv
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');

const ROOT = path.join(__dirname, '..');
const load = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? readCsv(fs.readFileSync(p, 'utf8')) : { headers: [], records: [] };
};
const ne = (v) => String(v == null ? '' : v).trim() !== '';
const empNum = (v) => parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10) || 0;

// ---- 1) ベース ----
const base = load('leads-mochica.scored.csv');

// ---- 2) 採用担当者名マップ(社名正規化キー -> {name, src}) ----
const nameSources = [
  ['data/recruiter-wantedly.csv', 'Wantedly'],
  ['sources/A-names-from-cache.csv', 'cache'],
  ['sources/A-mynavi-names.csv', 'マイナビ'],
  ['sources/A-names-enrichment.csv', 'enrichment'],
];
const nameMap = new Map();
for (const [f, label] of nameSources) {
  for (const r of load(f).records) {
    if (!ne(r['採用担当者名'])) continue;
    const k = normCompanyName(r['企業名']);
    if (k && !nameMap.has(k)) nameMap.set(k, { name: String(r['採用担当者名']).trim(), src: label });
  }
}

// ---- 3) 業種分類器 ----
const EXCLUDE = [
  /派遣|人材|人財|紹介事業|転職エージェント/,
  /銀行|信用金庫|信用組合|証券|保険|生命保険|損害保険|リース業|クレジット|信販|金融商品|ファイナンス/,
  /商社/,
  /広告代理|広告業|マスコミ|出版|新聞|放送|テレビ局|ラジオ局/,
  /コンサルティング|シンクタンク|監査法人|税理士法人|法律事務所|弁護士/,
];
const TARGETS = [
  ['toC:小売', /小売|販売店|ストア|スーパー|百貨店|量販|通販|通信販売|アパレル|衣料|呉服|ショップ|ドラッグ|ホームセンター|家電量販/],
  ['toC:サービス', /外食|飲食|レストラン|フード|給食|ホテル|宿泊|旅館|レジャー|アミューズメント|遊技|観光|教育|スクール|学習塾|予備校|保育|美容|エステ|理容|サロン|ブライダル|冠婚葬祭/],
  ['toC:メーカー', /食品|製菓|菓子|飲料|製パン|酒|醸造|化粧品|繊維|紡績/],
  ['不人気:メーカー', /製造|メーカー|機械|電子|電気機器|半導体|化学|薬品|金属|鉄鋼|非鉄|自動車|車両|部品|精密|工業|製作所|製鋼|鋳造|プラスチック|樹脂|ゴム|金型|印刷|製缶|塗料|セラミック|ガラス|窯業|木材|製材|紙/],
  ['不人気:建設住宅設備', /建設|建築|土木|工務店|住宅|ハウス|設備|電気工事|管工事|空調|塗装|内装|リフォーム|プラント|サッシ|建材/],
  ['不人気:運輸物流', /運輸|運送|物流|配送|倉庫|貨物|ロジ|海運|陸運|トラック|輸送/],
  ['不人気:医療福祉', /医療|病院|クリニック|介護|福祉|看護|薬局|調剤|ヘルスケア|デイサービス/],
  ['不人気:ソフト通信', /ソフトウ|システム|ＳＩ|情報処理|情報通信|通信サービス|ＩＴ|ソリューション|ネットワーク|アプリ|デジタル|ＤＸ|データセンタ/],
];
function classify(industry) {
  const s = String(industry || '').trim();
  if (!s) return { seg: '業種空欄(緩め採用)', keep: true };
  // TARGET優先: 対象バケットに一致すれば、説明文に除外語(例: WEBコンサル)を含んでも採用
  for (const [seg, re] of TARGETS) if (re.test(s)) return { seg, keep: true };
  // 対象バケット非該当の場合のみ、軸外/人気業種を除外
  for (const re of EXCLUDE) if (re.test(s)) return { seg: '除外:軸外/人気業種', keep: false };
  return { seg: 'セグメント外判定(緩め採用)', keep: true };
}

// ICPランク(ユーザー定義: A=300-1000 中堅コア)
function icpRank(emp) {
  if (emp >= 300 && emp <= 1000) return 'A(300-1000)';
  if (emp >= 100 && emp < 300) return 'B(100-299)';
  if (emp > 1000) return 'C(1000超/大手寄り)';
  return '';
}

// ---- 4) & 5) フィルタ＋付与 ----
const stats = { total: base.records.length, drop_emp_blank: 0, drop_emp_lt100: 0, drop_industry: 0, kept: 0, name_hit: 0 };
const segCount = {};
const out = [];
for (const r of base.records) {
  const emp = empNum(r['従業員数']);
  if (!emp) { stats.drop_emp_blank++; continue; }
  if (emp < 100) { stats.drop_emp_lt100++; continue; }
  const cls = classify(r['業種']);
  if (!cls.keep) { stats.drop_industry++; continue; }

  const rec = Object.assign({}, r);
  // 採用担当者名の補完
  const hit = nameMap.get(normCompanyName(r['企業名']));
  let nameSrc = '';
  if (hit) { rec['採用担当者名'] = hit.name; nameSrc = hit.src; stats.name_hit++; }
  rec['ICPランク'] = icpRank(emp);
  rec['セグメント区分'] = cls.seg;
  rec['採用担当者名取得元'] = nameSrc;
  rec['架電宛名'] = ne(rec['採用担当者名']) ? `${rec['採用担当者名']} 様` : (rec['架電呼称'] || '人事部 ご採用ご担当者様');
  out.push(rec);
  segCount[cls.seg] = (segCount[cls.seg] || 0) + 1;
  stats.kept++;
}

// ---- 並び替え: ICP A → B → C, 各内で アポ期待度 desc ----
const rankOrder = { 'A(300-1000)': 0, 'B(100-299)': 1, 'C(1000超/大手寄り)': 2, '': 3 };
out.sort((a, b) => {
  const ra = rankOrder[a['ICPランク']] ?? 9, rb = rankOrder[b['ICPランク']] ?? 9;
  if (ra !== rb) return ra - rb;
  return (parseInt(b['アポ期待度'], 10) || 0) - (parseInt(a['アポ期待度'], 10) || 0);
});

const headers = base.headers.concat(['ICPランク', 'セグメント区分', '採用担当者名取得元', '架電宛名']);
const outPath = path.join(ROOT, 'leads-mochica-target.csv');
fs.writeFileSync(outPath, toCsv(headers, out), 'utf8');

console.log('=== MOCHICAターゲット精選リスト 生成完了 ===');
console.log(`出力: leads-mochica-target.csv  (${stats.kept}社)`);
console.log(`\n[フィルタ内訳] 入力${stats.total}社から:`);
console.log(`  除外 従業員数空欄      : ${stats.drop_emp_blank}`);
console.log(`  除外 従業員100名未満   : ${stats.drop_emp_lt100}`);
console.log(`  除外 軸外/人気業種     : ${stats.drop_industry}`);
console.log(`  → 残存               : ${stats.kept}`);
console.log(`  うち採用担当者名 判明  : ${stats.name_hit}社 (残りは代表者名/人事部宛で架電可)`);
const icpAgg = {};
for (const r of out) icpAgg[r['ICPランク']] = (icpAgg[r['ICPランク']] || 0) + 1;
console.log(`\n[ICPランク分布]`, JSON.stringify(icpAgg));
console.log(`\n[セグメント区分分布]`);
for (const [k, v] of Object.entries(segCount).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
