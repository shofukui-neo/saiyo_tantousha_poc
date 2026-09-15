'use strict';
// 公式LINE判定の純ロジックテスト（ネット不要）。
//   node test/line-official.test.js
const assert = require('assert');
const {
  normalizeLineId, classifyLineUrl, detectLineOnPage, summarizeLine, lineTalkGuide,
} = require('../src/line-official');
const { collectCandidatePages, pageRole, isMediaDomain } = require('../src/probe-line');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }
const sum = (html, opts, ctx) => summarizeLine(detectLineOnPage(html, opts || {}).signals, Object.assign({ pagesOk: 3 }, ctx || {}));

console.log('line-official / probe-line:');

// ---- ID正規化 ----
t('normalizeLineId が @/%40/大文字/末尾クエリを正規化', () => {
  assert.strictEqual(normalizeLineId('%40acme-hr'), '@acme-hr');
  assert.strictEqual(normalizeLineId('@Acme_HR'), '@acme_hr');
  assert.strictEqual(normalizeLineId('acme?from=page'), '@acme');
  assert.strictEqual(normalizeLineId('ja'), '');       // 言語パスはIDではない
  assert.strictEqual(normalizeLineId('@'), '');
  assert.strictEqual(normalizeLineId(''), '');
});

// ---- URL分類 ----
t('classifyLineUrl が確実証跡(level3)を@ID付きで拾う', () => {
  const a = classifyLineUrl('https://line.me/R/ti/p/%40123abcd');
  assert.strictEqual(a.kind, 'add-friend'); assert.strictEqual(a.level, 3); assert.strictEqual(a.id, '@123abcd');
  const b = classifyLineUrl('https://page.line.me/acme_corp');
  assert.strictEqual(b.kind, 'account-page'); assert.strictEqual(b.id, '@acme_corp');
  const c = classifyLineUrl('https://qr-official.line.me/gs/M_abc123_GW.png');
  assert.strictEqual(c.level, 3);
});
t('classifyLineUrl が短縮/LIFFを level2 に置く', () => {
  assert.strictEqual(classifyLineUrl('https://lin.ee/AbC1234').level, 2);
  assert.strictEqual(classifyLineUrl('https://liff.line.me/1656565252-abcXYZ').level, 2);
});
t('classifyLineUrl がシェアボタン/LINE WORKSを neg 扱いにする', () => {
  assert.strictEqual(classifyLineUrl('https://social-plugins.line.me/lineit/share?url=x').neg, true);
  assert.strictEqual(classifyLineUrl('https://line.me/R/msg/text/?%E3%83%86%E3%82%B9%E3%83%88').neg, true);
  assert.strictEqual(classifyLineUrl('https://line.worksmobile.com/jp/').neg, true);
  assert.strictEqual(classifyLineUrl('https://example.co.jp/product/lineup.html'), null);
});

// ---- ページ判定: 真の陽性 ----
t('フッターの友だち追加ボタン → 有(確実)・ID取得', () => {
  const html = `<html><body><footer>
    <p>LINE公式アカウントはじめました！最新情報をお届けします。</p>
    <a href="https://line.me/R/ti/p/%40acme001"><img alt="友だち追加" src="/img/line.png"></a>
  </footer></body></html>`;
  const r = sum(html, { pageUrl: 'https://acme.co.jp/' });
  assert.strictEqual(r.判定, '有');
  assert.strictEqual(r.ID, '@acme001');
  assert.ok(r.確度 >= 90, '確度=' + r.確度);
  assert.ok(/友だち追加リンク/.test(r.根拠));
});

t('採用ページのLINE導線 → 用途が採用と判定される', () => {
  const html = `<html><body><h1>新卒採用エントリー</h1>
    <p>選考の連絡は公式LINEでお送りします。友だち追加してください。</p>
    <a href="https://lin.ee/Xy12ab">エントリーはLINEから</a></body></html>`;
  const r = sum(html, { pageUrl: 'https://acme.co.jp/recruit/entry/', pageRole: '採用' });
  assert.strictEqual(r.判定, '有');
  assert.strictEqual(r.用途, '採用');
  assert.ok(/一斉配信/.test(lineTalkGuide(r.判定, r.用途)), '採用用途は役割差トークに割り当てる');
});

// 実データで踏んだ罠（ヤマト運輸）: 全ページ共通フッターのSNSアイコンが採用ページにも出るため、
// ページURLから用途を採ると「採用で公式LINE運用中」と誤断してしまう。フッター由来は用途の根拠にしない。
t('採用ページに出た共通フッターのSNSアイコンを「採用用途」にしない', () => {
  const html = `<html><body><h1>採用情報</h1>
    <div class="Footer__foot"><ul class="footer-sns__list">
      <li><a href="https://line.me/ti/p/%40acme_corp"><img alt="LINE" src="/sns.png"></a></li>
    </ul></div></body></html>`;
  const r = sum(html, { pageUrl: 'https://acme.co.jp/recruit/', pageRole: '採用' });
  assert.strictEqual(r.判定, '有');
  assert.strictEqual(r.用途, '不明', '共通フッター由来は用途を断定しない');
  assert.ok(/一問置き/.test(lineTalkGuide(r.判定, r.用途)), '用途不明なら確認質問から入る');
});

t('採用面の本文中のLINE導線は 採用用途 と判定する', () => {
  const html = `<html><body><section class="entry">
    <h2>エントリーはLINEから</h2>
    <p>選考のご案内は公式LINEでお送りします。</p>
    <a href="https://line.me/ti/p/%40acme_saiyo">友だち追加</a>
  </section></body></html>`;
  assert.strictEqual(sum(html, { pageUrl: 'https://acme.co.jp/recruit/', pageRole: '採用' }).用途, '採用');
});

t('文言のみ（LINEでお問い合わせ）でも 有 と判定する', () => {
  const html = '<html><body><p>お問い合わせはお電話またはLINEでのご相談も承ります。</p></body></html>';
  const r = sum(html, { pageUrl: 'https://acme.co.jp/contact/' });
  assert.strictEqual(r.判定, '有');
  assert.ok(r.確度 < 90, 'URL証跡が無いので確度は控えめ');
});

// ---- ページ判定: 誤検知トラップ ----
t('LINEシェアボタンだけのページ → 無（自社アカウントではない）', () => {
  const html = `<html><body><article>お知らせ本文</article>
    <a href="https://social-plugins.line.me/lineit/share?url=https%3A%2F%2Facme.co.jp%2Fnews%2F1">LINEで送る</a>
    </body></html>`;
  const r = sum(html, { pageUrl: 'https://acme.co.jp/news/1' });
  assert.strictEqual(r.判定, '無');
  assert.ok(/シェアボタン/.test(r.根拠));
});

t('LINE WORKS（社内チャット）は証跡にしない', () => {
  const html = '<html><body><p>社内コミュニケーションにLINE WORKSを導入しています。</p></body></html>';
  assert.strictEqual(sum(html, { pageUrl: 'https://acme.co.jp/about/' }).判定, '無');
});

t('英単語のLINE（ONLINE/LINE UP/生産ライン）を拾わない', () => {
  const html = `<html><body>
    <p>ONLINE SHOP はこちら。商品のラインナップをご覧ください。</p>
    <p>PRODUCT LINE UP / 生産ラインの自動化に取り組んでいます。</p>
    <p>オンライン説明会のご予約はこちら</p></body></html>`;
  const r = sum(html, { pageUrl: 'https://acme.co.jp/' });
  assert.strictEqual(r.判定, '無', '根拠=' + r.根拠);
});

t('個人LINE ID(~)やLINEログインは 要確認 止まり', () => {
  const html = '<html><body><a href="https://line.me/ti/p/~acme-sales">LINE</a></body></html>';
  assert.strictEqual(sum(html, { pageUrl: 'https://acme.co.jp/' }).判定, '要確認');
});

// ---- 集約 ----
t('1ページも取れなければ 無 ではなく 不明', () => {
  const r = summarizeLine([], { pagesOk: 0, pagesFailed: 3 });
  assert.strictEqual(r.判定, '不明');
  assert.strictEqual(r.確度, 0);
});

t('検査ページ数が多いほど「無」の確度が上がる', () => {
  assert.ok(summarizeLine([], { pagesOk: 6 }).確度 > summarizeLine([], { pagesOk: 1 }).確度);
});

t('実在検証NG（page.line.meで不在）なら 有 → 要確認 に落とす', () => {
  const html = '<html><body><a href="https://line.me/R/ti/p/%40old999">友だち追加</a></body></html>';
  const ok = sum(html, { pageUrl: 'https://acme.co.jp/' }, { verified: true });
  const ng = sum(html, { pageUrl: 'https://acme.co.jp/' }, { verified: false });
  assert.strictEqual(ok.判定, '有'); assert.ok(ok.確度 >= 95);
  assert.strictEqual(ng.判定, '要確認'); assert.ok(ng.確度 < ok.確度);
});

t('トーク指針が判定ごとに分岐する', () => {
  assert.ok(/歩留/.test(lineTalkGuide('有', '採用')));
  assert.ok(/素地/.test(lineTalkGuide('有', '販促・顧客')));
  assert.ok(/一問置いて/.test(lineTalkGuide('要確認', '')));
  assert.ok(/LINEを主語にせず/.test(lineTalkGuide('無', '')));
});

// ---- 巡回対象ページの選定（probe-line の純ロジック）----
t('pageRole がLINE導線の置き場を優先度つきで分類', () => {
  assert.strictEqual(pageRole('/sns/ 公式SNS').role, 'SNS');
  assert.strictEqual(pageRole('/contact/ お問い合わせ').role, '問合せ');
  assert.strictEqual(pageRole('/recruit/ 採用情報').role, '採用');
  assert.strictEqual(pageRole('/product/spec 製品仕様'), null);
  assert.ok(pageRole('/sns/').w > pageRole('/company/').w, 'SNS面を先に見る');
});

t('collectCandidatePages が同一ドメインのみ・役割つきで集める', () => {
  const html = `
    <a href="/contact/">お問い合わせ</a>
    <a href="/recruit/entry/">新卒エントリー</a>
    <a href="https://other.example.com/contact">外部の問い合わせ</a>
    <a href="/ir/library.pdf">IR資料</a>`;
  const c = collectCandidatePages('https://acme.co.jp/', html);
  const urls = c.map((x) => x.url);
  assert.ok(urls.some((u) => /\/contact\//.test(u)));
  assert.ok(urls.some((u) => /\/recruit\/entry\//.test(u)));
  assert.ok(!urls.some((u) => /other\.example\.com/.test(u)), '他社ドメインは見に行かない');
});

t('求人媒体ドメインは種にしない（媒体自身のLINEを拾わないため）', () => {
  assert.strictEqual(isMediaDomain('job.mynavi.jp'), true);
  assert.strictEqual(isMediaDomain('www.wantedly.com'), true);
  assert.strictEqual(isMediaDomain('recruit.acme.co.jp'), false);
});

console.log(`  → ${pass} 件成功`);
