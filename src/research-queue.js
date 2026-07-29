'use strict';
// 半自動リサーチ補助（その1）: ターゲット各社について「人が自分でログインして調べる」ための
// 検索URL束（ワークシート）を生成する。自動アクセスはしない＝各媒体の規約・robotsの範囲内で、
// 認証下の閲覧は人間が行い、ツールはURL生成と結果整理(ingest-research.js)に徹する。
//
//   node src/research-queue.js --in leads-mochica-target.csv --out sources/research-worksheet.csv --limit 200
//   出力: CSV（機械処理用）＋ Markdown（クリックして回す用）
//
// 設計意図: LinkedIn/X/Facebook 等は認証下スクレイピング禁止。だが「人が手で検索する」のは正規。
//   そこで“どこを・何で検索すればよいか”を社名×ロール語で先回りして組み立て、リサーチを高速化する。
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// 役割語（採用窓口に当たりやすいキーワード）。検索クエリに添えて担当者ヒット率を上げる。
const ROLE_TERMS = '採用 OR 人事 OR recruiter OR "talent acquisition"';

// 各媒体の「人手検索」URL。q=社名（＋ロール語）を渡すだけ。ログインは人間が済ませている前提。
//   note: ここで生成するのは“検索ページ”のURLであり、ツールがアクセスするわけではない（人がクリックする）。
const CHANNELS = [
  {
    key: 'linkedin',
    label: 'LinkedIn',
    // 人物検索（キーワード）。ログイン済みブラウザで開く。
    url: (name) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name + ' 採用 人事')}`,
  },
  {
    key: 'x',
    label: 'X(Twitter)',
    url: (name) => `https://x.com/search?q=${encodeURIComponent(name + ' (採用 OR 人事 OR 採用担当)')}&f=user`,
  },
  {
    key: 'facebook',
    label: 'Facebook',
    url: (name) => `https://www.facebook.com/search/people/?q=${encodeURIComponent(name + ' 採用 人事')}`,
  },
  {
    key: 'wantedly',
    label: 'Wantedly',
    // robots許可・SSRで個人名が出る正規経路（自動取得も可能だが、ここでは人手導線として併記）。
    url: (name) => `https://www.wantedly.com/projects?q=${encodeURIComponent(name)}`,
  },
  {
    key: 'eight',
    label: 'Eight',
    url: (name) => `https://8card.net/search?q=${encodeURIComponent(name)}`,
  },
  {
    key: 'google',
    label: 'Google',
    // 公開ページ横断（インタビュー記事/プレス/採用note等に氏名が出ることがある）。
    url: (name) => `https://www.google.com/search?q=${encodeURIComponent(`"${name}" (${ROLE_TERMS})`)}`,
  },
];

function buildRow(companyName, corpNo) {
  const row = { '企業名': companyName, '法人番号': corpNo || '' };
  for (const ch of CHANNELS) row[ch.label] = ch.url(companyName);
  // 調べた結果を書き戻す欄（人手で埋める→ingest-research.jsで取り込み）
  row['採用担当者名'] = '';
  row['役職'] = '';
  row['根拠URL'] = '';
  row['見つかった媒体'] = '';
  return row;
}

function toMarkdown(rows) {
  const lines = ['# リサーチ・ワークシート', '',
    '各社の検索リンク。ご自身のログイン済みブラウザで開いて担当者を確認し、',
    '`採用担当者名/役職/根拠URL` を CSV 側に書き戻してください（→ `npm run research:ingest`）。', ''];
  for (const r of rows) {
    lines.push(`## ${r['企業名']}`);
    const links = CHANNELS.map((ch) => `[${ch.label}](${r[ch.label]})`).join(' ・ ');
    lines.push(links, '');
  }
  return lines.join('\n');
}

function run() {
  const IN = getArg('in', 'leads-mochica-target.csv');
  const OUT = getArg('out', path.join('sources', 'research-worksheet.csv'));
  const LIMIT = parseInt(getArg('limit', '0'), 10) || 0;
  const MD = getArg('md', OUT.replace(/\.csv$/i, '.md'));

  const text = fs.readFileSync(path.resolve(IN), 'utf8');
  let { records } = readCsv(text);
  if (LIMIT) records = records.slice(0, LIMIT);

  const rows = records
    .map((r) => buildRow(r['企業名'] || r['company_name'] || '', r['法人番号'] || ''))
    .filter((r) => r['企業名']);

  const headers = ['企業名', '法人番号', ...CHANNELS.map((c) => c.label),
    '採用担当者名', '役職', '根拠URL', '見つかった媒体'];
  const OUTABS = path.resolve(OUT);
  fs.mkdirSync(path.dirname(OUTABS), { recursive: true });
  fs.writeFileSync(OUTABS, toCsv(headers, rows));
  fs.writeFileSync(path.resolve(MD), toMarkdown(rows));

  console.log(`[research:queue] ${rows.length}社のワークシートを生成`);
  console.log(`  CSV: ${OUTABS}`);
  console.log(`  MD : ${path.resolve(MD)}（クリックして回す用）`);
  console.log(`  → ログイン済みブラウザで各リンクを開き、担当者を CSV に書き戻し → npm run research:ingest`);
}

module.exports = { buildRow, toMarkdown, CHANNELS };

if (require.main === module) {
  try { run(); }
  catch (e) { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; }
}
