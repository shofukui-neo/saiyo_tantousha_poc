'use strict';
// email-harvest.js の純ロジック単体テスト（ネットワーク/DNS無し）。node test/email-harvest.test.js
const assert = require('assert');
const {
  extractEmailsFromPage, isValidEmail, classifyRole, roleLabel,
  isOwnDomain, isFreemail, parseMailto, deobfuscate, priorityScore,
} = require('../src/email-harvest');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

console.log('email-harvest:');

// ---- isValidEmail: 本物とプレースホルダ/アセットの弁別 ----
t('実在メールは有効', () => {
  assert.ok(isValidEmail('recruit@example.co.jp') === true || isValidEmail('recruit@neo.co.jp'));
  assert.strictEqual(isValidEmail('saiyo@neocareer.co.jp'), true);
});
t('プレースホルダ/アセット/断片を弾く', () => {
  assert.strictEqual(isValidEmail('info@example.com'), false);     // プレースホルダ
  assert.strictEqual(isValidEmail('logo@2x.png'), false);          // 画像アセット
  assert.strictEqual(isValidEmail('a@sentry.wixpress.com'), false); // 埋め込みツール
  assert.strictEqual(isValidEmail('noatsign.co.jp'), false);       // @なし
  assert.strictEqual(isValidEmail('a@@b.jp'), false);              // 二重@
  assert.strictEqual(isValidEmail('a@b'), false);                  // TLDなし
  assert.strictEqual(isValidEmail('.a@b.jp'), false);              // 先頭ドット
});

// ---- classifyRole: ローカル部からの種別推定 ----
t('採用系ローカル部を recruit に分類', () => {
  assert.strictEqual(classifyRole('recruit@x.jp'), 'recruit');
  assert.strictEqual(classifyRole('saiyo@x.jp'), 'recruit');
  assert.strictEqual(classifyRole('jinji@x.jp'), 'recruit');
});
t('問い合わせ系を contact、営業系を sales、その他は other', () => {
  assert.strictEqual(classifyRole('info@x.jp'), 'contact');
  assert.strictEqual(classifyRole('contact@x.jp'), 'contact');
  assert.strictEqual(classifyRole('sales@x.jp'), 'sales');
  assert.strictEqual(classifyRole('taro.yamada@x.jp'), 'other');
  assert.strictEqual(roleLabel('recruit'), '採用/人事');
});

// ---- 自社/フリーメール判定 ----
t('自社ドメイン判定（登録可能ドメイン一致）', () => {
  assert.strictEqual(isOwnDomain('info@corp.example.co.jp', 'www.example.co.jp'), true);
  assert.strictEqual(isOwnDomain('info@other.co.jp', 'example.co.jp'), false);
});
t('フリーメール判定', () => {
  assert.strictEqual(isFreemail('foo@gmail.com'), true);
  assert.strictEqual(isFreemail('foo@example.co.jp'), false);
});

// ---- parseMailto / deobfuscate ----
t('mailto: からアドレスのみ抽出（subject/複数宛先除去）', () => {
  assert.deepStrictEqual(parseMailto('mailto:info@x.jp?subject=hi'), ['info@x.jp']);
  assert.deepStrictEqual(parseMailto('mailto:a@x.jp,b@y.jp'), ['a@x.jp', 'b@y.jp']);
});
t('保守的な難読化復元（＠と[at]/[dot]のみ）', () => {
  assert.ok(deobfuscate('info＠example.co.jp').includes('info@example.co.jp'));
  assert.ok(deobfuscate('info [at] neo [dot] jp').includes('info@neo.jp'));
});

// ---- extractEmailsFromPage: mailto と本文の両取り・自社加点 ----
t('mailtoリンクと本文メールを抽出し、自社ドメインを加点', () => {
  const html = `<html><body>
    <a href="mailto:recruit@neocareer.co.jp?subject=応募">採用担当宛</a>
    <p>お問い合わせ: info@neocareer.co.jp / 個人: someone@gmail.com</p>
    <img src="logo@2x.png">
    <a href="mailto:info@example.com">dummy</a>
  </body></html>`;
  const got = extractEmailsFromPage(html, 'https://neocareer.co.jp/contact', 'neocareer.co.jp');
  const emails = got.map((g) => g.email).sort();
  assert.deepStrictEqual(emails, ['info@neocareer.co.jp', 'recruit@neocareer.co.jp', 'someone@gmail.com']);
  const recruit = got.find((g) => g.email === 'recruit@neocareer.co.jp');
  assert.strictEqual(recruit.source, 'mailto');
  assert.strictEqual(recruit.ownDomain, true);
  const free = got.find((g) => g.email === 'someone@gmail.com');
  assert.strictEqual(free.freemail, true);
  // 自社mailto採用アドレスはフリーメールより確度が高い
  assert.ok(recruit.confidence > free.confidence);
});

// ---- priorityScore: 採用系・実在・自社を上位に ----
t('並び替えスコアは採用系＞問い合わせ、実在＞推測', () => {
  const recruit = { role: 'recruit', source: 'mailto', ownDomain: true, confidence: 0.9 };
  const contact = { role: 'contact', source: 'mailto', ownDomain: true, confidence: 0.9 };
  const guess = { role: 'recruit', source: 'guess', ownDomain: true, confidence: 0.4 };
  assert.ok(priorityScore(recruit) > priorityScore(contact));
  assert.ok(priorityScore(recruit) > priorityScore(guess));
});

console.log(`  → ${pass} 件パス`);
