const { extractFromRecruitText } = require('./src/probe-recruit-page');
const { isPlausiblePersonName } = require('./src/jp-names');
const pad = 'これは採用ページの本文です。私たちと一緒に働きませんか。新卒採用を積極的に行っています。会社説明会も実施中です。';
const cases = [
  ['採用担当：田中 までお問い合わせください。','田中'],
  ['お問い合わせは採用担当者：鈴木 まで。人事部です。','鈴木'],
  ['人事部 採用担当 山田太郎 です。','山田 太郎'],
  ['新卒採用担当 佐々木・粟津 採用担当者からのメッセージ。','佐々木'],
  ['当社の採用担当は人事部の佐藤です。','佐藤'],
  ['当社の事業について 関東支店 営業所 地区 のご案内。','—(no name)'],
  ['代表取締役の田中太郎が挨拶します。事業内容のご紹介。','—(代表は採用担当でない)'],
];
for (const [t,exp] of cases) {
  const h = extractFromRecruitText(t+pad);
  const okGate = h&&h.name&&isPlausiblePersonName(h.name);
  console.log((h&&h.name)? `${okGate?'★':'gate✗'} ${h.name} (conf=${h.confidence})` : '— miss', '| expect', exp);
}
