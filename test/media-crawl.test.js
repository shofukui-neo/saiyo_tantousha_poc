'use strict';
// media-crawl / cli-util / harvest-all-media の純ロジック自己テスト（ネットワーク不要）。
// 媒体巡回のリンク分類は「企業母集団の入口」そのものなので、退行するとハーベストが静かに枯れる。
// 実行: npm run test:media
const assert = require('assert');
const { classifyLink, cleanUrl, LISTING_HINT, DETAIL_HINT } = require('../src/media-crawl');
const { getArg, getIntArg, hostOf } = require('../src/cli-util');
const { companyNameTier, selectTargets } = require('../src/harvest-all-media');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✔', name); }
  catch (e) { fail++; console.error('  x', name, '->', e.message); }
}

console.log('media-crawl リンク分類テスト');

t('外部の企業サイト＝company', () => {
  const r = classifyLink('https://www.example-corp.co.jp/recruit/', 'media.jp');
  assert.strictEqual(r.kind, 'company');
  assert.strictEqual(r.host, 'example-corp.co.jp');
  assert.strictEqual(r.reg, 'example-corp.co.jp');
});

t('媒体自身＝internal（wwwあり/なしを吸収）', () => {
  assert.strictEqual(classifyLink('https://www.media.jp/companies/1', 'media.jp').kind, 'internal');
  assert.strictEqual(classifyLink('https://media.jp/companies/1', 'media.jp').kind, 'internal');
});

t('媒体のサブドメイン＝internal', () => {
  assert.strictEqual(classifyLink('https://job.media.jp/list', 'media.jp').kind, 'internal');
});

t('既知の除外ドメイン（求人媒体/SNS）＝excluded', () => {
  // cfg.EXCLUDE_DOMAINS に載っている代表格。企業サイトとして拾ってはいけない。
  assert.strictEqual(classifyLink('https://twitter.com/foo', 'media.jp').kind, 'excluded');
  assert.strictEqual(classifyLink('https://job.mynavi.jp/27/pc/search/', 'media.jp').kind, 'excluded');
});

t('mailto/tel/相対不能＝invalid', () => {
  assert.strictEqual(classifyLink('mailto:a@b.jp', 'media.jp').kind, 'invalid');
  assert.strictEqual(classifyLink('javascript:void(0)', 'media.jp').kind, 'invalid');
  assert.strictEqual(classifyLink('not a url', 'media.jp').kind, 'invalid');
});

t('cleanUrl はクエリ/フラグメントを落とす', () => {
  assert.strictEqual(cleanUrl('https://a.jp/x?y=1#z'), 'https://a.jp/x');
});

t('LISTING_HINT は企業一覧パスに当たり、静的ページには当たらない', () => {
  assert.ok(LISTING_HINT.test('/companies/?page=2'));
  assert.ok(LISTING_HINT.test('/kigyo/area/tokyo'));
  assert.ok(!LISTING_HINT.test('/privacy'));
});

t('DETAIL_HINT はID付き詳細ページに当たる', () => {
  assert.ok(DETAIL_HINT.test('/interview/1234'));
  assert.ok(DETAIL_HINT.test('/company/detail'));
  assert.ok(!DETAIL_HINT.test('/terms'));
});

console.log('企業名アンカー判定テスト');

t('法人格つき＝strong', () => {
  assert.strictEqual(companyNameTier('株式会社サンプル製作所'), 'strong');
  assert.strictEqual(companyNameTier('Sample Co., Ltd'), 'strong');
});

t('法人格なしの短い社名＝weak（逆求人媒体の表記に対応）', () => {
  assert.strictEqual(companyNameTier('サイバーエージェント'), 'weak');
});

t('CTA/ノイズ文言は拾わない', () => {
  for (const s of ['詳細', 'もっと見る', 'エントリー', 'ログイン', '12345', 'ab', 'https://a.jp']) {
    assert.strictEqual(companyNameTier(s), null, `"${s}" を企業名として拾ってはいけない`);
  }
});

t('長すぎるアンカーは企業名扱いしない', () => {
  assert.strictEqual(companyNameTier('あ'.repeat(31)), null);
});

console.log('媒体ターゲット選定テスト');

const CATALOG = {
  media: [
    { name: 'ふつう媒体', url: 'https://a.jp', cat: '逆求人', strategy: 'crawl' },
    { name: 'ログイン壁', url: 'https://b.jp', cat: '逆求人', strategy: 'blocked-or-login' },
    { name: '到達不可', url: 'https://c.jp', cat: '逆求人', strategy: 'crawl', probe: { reachable: 'no' } },
    { name: 'ログイン likely', url: 'https://d.jp', cat: '逆求人', strategy: 'crawl', probe: { loginWall: 'likely' } },
    { name: 'マイナビ', url: 'https://e.jp', cat: '総合', strategy: 'sitemap-discovery' },
    { name: 'IT媒体', url: 'https://f.jp', cat: 'IT特化', strategy: 'crawl' },
    { name: 'URLなし', cat: '逆求人', strategy: 'crawl' },
  ],
};

t('ブロック/到達不可/ログイン壁/URLなし は除外', () => {
  const names = selectTargets(CATALOG, { limit: 99 }).map((m) => m.name);
  assert.deepStrictEqual(names, ['ふつう媒体', 'IT媒体']);
});

t('マイナビ等の専用経路は --include-structured で復活', () => {
  const names = selectTargets(CATALOG, { includeStructured: true, limit: 99 }).map((m) => m.name);
  assert.ok(names.includes('マイナビ'));
});

t('カテゴリ絞り込みが効く', () => {
  const names = selectTargets(CATALOG, { catRe: /IT特化/, limit: 99 }).map((m) => m.name);
  assert.deepStrictEqual(names, ['IT媒体']);
});

t('limit が効く', () => {
  assert.strictEqual(selectTargets(CATALOG, { limit: 1 }).length, 1);
});

console.log('cli-util テスト');

t('getArg: 値つき/フラグのみ/未指定', () => {
  const argv = ['node', 's.js', '--out', 'x.csv', '--deep', '--cats'];
  assert.strictEqual(getArg('out', 'def', argv), 'x.csv');
  assert.strictEqual(getArg('deep', false, argv), true);   // 次が別フラグ＝真偽フラグ扱い
  assert.strictEqual(getArg('cats', 'def', argv), true);   // 末尾＝真偽フラグ扱い
  assert.strictEqual(getArg('missing', 'def', argv), 'def');
});

t('getIntArg: 数値/不正値/未指定', () => {
  const argv = ['node', 's.js', '--n', '25', '--bad', 'abc', '--flag'];
  assert.strictEqual(getIntArg('n', 1, argv), 25);
  assert.strictEqual(getIntArg('bad', 7, argv), 7);
  assert.strictEqual(getIntArg('flag', 7, argv), 7);
  assert.strictEqual(getIntArg('missing', 7, argv), 7);
});

t('hostOf: www除去・小文字化・不正URLは空', () => {
  assert.strictEqual(hostOf('https://WWW.Example.co.jp/a'), 'example.co.jp');
  assert.strictEqual(hostOf('nonsense'), '');
});

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
