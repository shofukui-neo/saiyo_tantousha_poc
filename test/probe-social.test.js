'use strict';
// probe-social.js の抽出ガードの単体テスト（合成HTML・ネット不要）。node test/probe-social.test.js
const assert = require('assert');
const { extractCandidatesFromPage } = require('../src/probe-social');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }
const html = (body) => `<html><body>${body}</body></html>`;
const names = (cands) => cands.map((c) => c.name);

console.log('probe-social:');

// 「(名詞)です」の誤検出が復活していないこと（必要です/制作です/設計です → 人名化しない）
t('「〜が必要です」等を人名化しない', () => {
  const h = html('<p>株式会社テスト。高い品質が必要です。丁寧な制作です。緻密な設計です。</p>');
  const cands = extractCandidatesFromPage(h, '株式会社テスト', 'test.co.jp', { trustDomain: true });
  for (const bad of ['必要', '制作', '設計', '状態', '満載']) assert.ok(!names(cands).includes(bad), `${bad} を拾ってはいけない`);
});

// 代表取締役ラベル付きの実名は拾う
t('代表取締役ラベルの氏名を拾う', () => {
  const h = html('<p>会社概要。代表取締役　山田 太郎。設立2010年。</p>');
  const cands = extractCandidatesFromPage(h, '株式会社テスト', 'test.co.jp', { trustDomain: true });
  const rep = cands.find((c) => c.role === '代表');
  assert.ok(rep, '代表候補が出る');
  assert.strictEqual(rep.name, '山田 太郎');
});

// 自己名乗り「と申します」に混じる一般語（以上/担当）は人名化しない
t('「と申します」の一般語は拾わない', () => {
  const bad = extractCandidatesFromPage(html('<p>テスト社。以上と申します。</p>'), 'テスト社', 't.jp', { trustDomain: true });
  for (const w of ['以上', '担当', '当社']) assert.ok(!names(bad).includes(w), `${w} を拾ってはいけない`);
});

// trustDomain=false かつ社名が面に無ければ何も返さない（他社誤採用防止）
t('社名ゲート: trustDomain無し・社名不在なら空', () => {
  const cands = extractCandidatesFromPage(html('<p>代表取締役 山田 太郎</p>'), '別の会社', 'other.jp');
  assert.strictEqual(cands.length, 0);
});

console.log(`\nprobe-social: ${pass} 件パス`);
