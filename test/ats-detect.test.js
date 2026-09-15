'use strict';
// ATS未導入判定の純ロジックテスト（ネット不要）。
//   node test/ats-detect.test.js
const assert = require('assert');
const {
  classifyEntryLink, detectEntryOnPage, summarizeAts, atsTalkGuide,
  sameCompanyHost, registrableDomain, isMediaHost, isSocialHost,
} = require('../src/ats-detect');
const { collectEntryPages, pageRoleOf } = require('../src/probe-ats');
const { clusterFingerprints, normVendorLabel, stratify } = require('../src/learn-ats-fingerprints');

let pass = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { console.error('  ✗', msg, '\n    ', e.message); process.exitCode = 1; } }

// 自前辞書の代わりにテスト用の最小辞書を使う（本番辞書に依存しない＝テストが環境で揺れない）。
const DICT = {
  hosts: {
    'vendor-a.jp': { host: 'vendor-a.jp', side: 'ats', vendor: 'ベンダーA', companies: 12, level: 3 },
    'formsaas.jp': { host: 'formsaas.jp', side: 'diy', vendor: '', companies: 8, level: 3 },
  },
  scripts: { 'vendor-b.com/mypage.js': { side: 'ats', vendor: 'ベンダーB', level: 2 } },
};
const sum = (html, opts, ctx) => {
  const d = detectEntryOnPage(html, Object.assign({ pageUrl: 'https://acme.co.jp/recruit/', pageRole: '採用', dict: DICT }, opts || {}));
  return summarizeAts(d.signals, Object.assign({ pagesOk: 4 }, ctx || {}));
};

console.log('ats-detect / probe-ats / learn-ats-fingerprints:');

// ---- ドメイン同一性 ----
t('registrableDomain が co.jp の2段TLDを正しく畳む', () => {
  assert.strictEqual(registrableDomain('recruit.acme.co.jp'), 'acme.co.jp');
  assert.strictEqual(registrableDomain('www.acme.com'), 'acme.com');
  assert.strictEqual(registrableDomain('job.vendor-a.jp'), 'vendor-a.jp');
});
t('sameCompanyHost がサブドメイン差を同一企業とみなす', () => {
  assert.strictEqual(sameCompanyHost('recruit.acme.co.jp', 'www.acme.co.jp'), true);
  assert.strictEqual(sameCompanyHost('vendor-a.jp', 'acme.co.jp'), false);
});

// ---- リンク単体の分類 ----
t('classifyEntryLink: Googleフォーム → google_form', () => {
  const c = classifyEntryLink('https://docs.google.com/forms/d/e/1FAIpQL/viewform', { baseHost: 'acme.co.jp' });
  assert.strictEqual(c.entry_type, 'google_form');
  assert.strictEqual(c.level, 3);
  assert.strictEqual(classifyEntryLink('https://forms.gle/abc123', { baseHost: 'acme.co.jp' }).entry_type, 'google_form');
});
t('classifyEntryLink: mailto → mail_direct / tel → phone_only', () => {
  assert.strictEqual(classifyEntryLink('mailto:saiyo@acme.co.jp', {}).entry_type, 'mail_direct');
  assert.strictEqual(classifyEntryLink('tel:03-1234-5678', {}).entry_type, 'phone_only');
  assert.strictEqual(classifyEntryLink('mailto:', {}), null);
});
t('classifyEntryLink: エントリーシートPDFだけを pdf_download にする', () => {
  const es = classifyEntryLink('/recruit/entrysheet.pdf', { baseHost: 'acme.co.jp', anchor: 'エントリーシートをダウンロード' });
  assert.strictEqual(es.entry_type, 'pdf_download');
  // 会社案内PDFは動線ではない
  assert.strictEqual(classifyEntryLink('/ir/report2026.pdf', { baseHost: 'acme.co.jp', anchor: '決算資料' }), null);
});
t('classifyEntryLink: 媒体は media_only / 自社ドメインは own_form', () => {
  assert.strictEqual(classifyEntryLink('https://job.mynavi.jp/28/pc/corpinfo/', { baseHost: 'acme.co.jp' }).entry_type, 'media_only');
  assert.strictEqual(classifyEntryLink('https://recruit.acme.co.jp/entry/', { baseHost: 'www.acme.co.jp', entryCtx: true }).entry_type, 'own_form');
});
t('classifyEntryLink: エントリー文脈の無い内部リンクは動線にしない（own_form の暴発防止）', () => {
  // これを許すと1ページ100件超の own_form が湧く（実サイトで確認済み）
  assert.strictEqual(classifyEntryLink('/company/history.html', { baseHost: 'acme.co.jp', entryCtx: false }), null);
});
t('classifyEntryLink: 辞書ヒットで ats_vendor / diy を出し分ける', () => {
  const a = classifyEntryLink('https://job.vendor-a.jp/acme/entry', { baseHost: 'acme.co.jp', dict: DICT });
  assert.strictEqual(a.entry_type, 'ats_vendor');
  assert.strictEqual(a.side, 'ats');
  assert.strictEqual(a.vendor, 'ベンダーA');
  const b = classifyEntryLink('https://formsaas.jp/f/xyz', { baseHost: 'acme.co.jp', dict: DICT });
  assert.strictEqual(b.entry_type, 'generic_form', 'フォームSaaSはATS扱いしない（未導入側）');
  assert.strictEqual(b.side, 'diy');
});
t('classifyEntryLink: 辞書に無い外部ホストは level2 の unknown に留める', () => {
  const c = classifyEntryLink('https://unknown-host.example/entry', { baseHost: 'acme.co.jp', dict: DICT });
  assert.strictEqual(c.entry_type, 'ats_vendor');
  assert.strictEqual(c.side, 'unknown');
  assert.strictEqual(c.level, 2);
});
t('classifyEntryLink: SNS/解析は動線として拾わない', () => {
  assert.strictEqual(classifyEntryLink('https://twitter.com/acme', { baseHost: 'acme.co.jp' }), null);
  assert.strictEqual(classifyEntryLink('https://www.googletagmanager.com/gtm.js', { baseHost: 'acme.co.jp' }), null);
  assert.strictEqual(isSocialHost('www.instagram.com'), true);
  assert.strictEqual(isMediaHost('job.mynavi.jp'), true);
  assert.strictEqual(isMediaHost('recruit.acme.co.jp'), false);
});

// ---- ページ判定: 未導入の各型 ----
t('Googleフォーム導線 → 未導入 / google_form', () => {
  const r = sum(`<html><body><main>
    <h1>2028年卒 新卒採用</h1>
    <p>エントリーは下記フォームよりお願いします。</p>
    <a href="https://docs.google.com/forms/d/e/1FAIpQLSxxxx/viewform">エントリーフォームはこちら</a>
  </main></body></html>`);
  assert.strictEqual(r.ATS判定, '未導入');
  assert.strictEqual(r.entry_type, 'google_form');
  assert.strictEqual(r.重症度, 4);
  assert.ok(r.確度 >= 70, `確度=${r.確度}`);
});
t('メール直記載（本文のみ・リンク無し） → 未導入 / mail_direct', () => {
  const r = sum(`<html><body><section>
    <h2>新卒採用エントリー</h2>
    <p>ご応募は採用担当 saiyo@acme.co.jp までメールにてお願いいたします。</p>
  </section></body></html>`);
  assert.strictEqual(r.ATS判定, '未導入');
  assert.strictEqual(r.entry_type, 'mail_direct');
});
t('エントリーシートPDF → 未導入 / pdf_download（最重症）', () => {
  const r = sum(`<html><body><div class="entry">
    <h2>応募方法</h2>
    <a href="/recruit/es2028.pdf">エントリーシート（PDF）をダウンロード</a>
    <p>ご記入の上、郵送してください。</p>
  </div></body></html>`);
  assert.strictEqual(r.entry_type, 'pdf_download');
  assert.strictEqual(r.重症度, 5);
});
t('説明会予約が電話のみ → 未導入 / phone_only', () => {
  const r = sum(`<html><body><div>
    <h2>会社説明会のご予約</h2>
    <p>説明会のご予約は お電話（03-1234-5678）にて受け付けております。</p>
  </div></body></html>`);
  assert.strictEqual(r.entry_type, 'phone_only');
  assert.strictEqual(r.重症度, 5);
});
t('お知らせ欄の代表電話は phone_only にしない（受付動詞が番号の近くに要る）', () => {
  // 実測の誤検出: 採用ページのニュース欄に日付と代表電話が並んでいるだけの社を phone_only にしていた
  const r = sum(`<html><body><section>
    <h2>エントリー受付について</h2>
    <p>お知らせ 2026年07月07日 【展示会を開催中です】 2026年07月03日 【カタログが新しくなりました】
    本社 03-1234-5678 お知らせ一覧 募集要項 現在募集は行っておりません</p>
  </section></body></html>`);
  assert.notStrictEqual(r.entry_type, 'phone_only', '根拠: ' + r.根拠);
});
t('電話は他の動線があれば主動線にしない（どのページにも電話はある）', () => {
  const r = sum(`<html><body>
    <p>説明会のご予約はお電話 03-1234-5678 まで</p>
    <a href="https://docs.google.com/forms/d/e/1FAI/viewform">エントリーはこちら</a>
  </body></html>`);
  assert.strictEqual(r.entry_type, 'google_form');
  assert.ok(/電話のみ/.test(r.動線内訳), '内訳には電話も残る: ' + r.動線内訳);
});
t('媒体リンクしか無い → 未導入 / media_only', () => {
  const r = sum(`<html><body><div>
    <h2>採用情報</h2>
    <a href="https://job.mynavi.jp/28/pc/search/corp123/outline.html">マイナビ2028のエントリーページへ</a>
  </div></body></html>`);
  assert.strictEqual(r.ATS判定, '未導入');
  assert.strictEqual(r.entry_type, 'media_only');
});

// ---- ページ判定: 導入済（除外）----
t('辞書確定ベンダーへ遷移 → 導入済（除外）', () => {
  const r = sum(`<html><body><div>
    <a href="https://job.vendor-a.jp/acme/entry/">新卒エントリー（マイページ登録）</a>
  </div></body></html>`);
  assert.strictEqual(r.ATS判定, '導入済');
  assert.strictEqual(r.entry_type, 'ats_vendor');
  assert.strictEqual(r.ベンダー, 'ベンダーA');
  assert.strictEqual(r.重症度, 0);
});
t('ベンダーJSの読み込みだけでも導入済の傍証になる（採用面のみ）', () => {
  const r = sum(`<html><head><script src="https://vendor-b.com/mypage.js"></script></head>
    <body><a href="/recruit/entry/">エントリー</a></body></html>`);
  assert.strictEqual(r.ATS判定, '導入済');
  assert.strictEqual(r.ベンダー, 'ベンダーB');
});
t('辞書に無い外部ホストは「要確認」で止める（未導入と誤って言い切らない）', () => {
  const r = sum(`<html><body><a href="https://unknown-ats.example/acme/entry">エントリーはこちら</a></body></html>`);
  assert.strictEqual(r.ATS判定, '要確認');
  assert.ok(/辞書/.test(r.根拠), r.根拠);
});
t('ベンダー導線と手作業導線が同居したら導入済を優先（誤って架電しない）', () => {
  const r = sum(`<html><body>
    <a href="mailto:saiyo@acme.co.jp">お問い合わせ・エントリーはこちら</a>
    <a href="https://job.vendor-a.jp/acme/entry/">新卒エントリー</a>
  </body></html>`);
  assert.strictEqual(r.ATS判定, '導入済');
});

// ---- フォーム送信先 ----
t('自社ドメインへPOSTするエントリーフォーム → own_form(level3)', () => {
  const r = sum(`<html><body><form action="/recruit/entry/confirm.php" method="post">
    <h2>エントリーフォーム</h2><input name="name"><button>応募する</button>
  </form></body></html>`);
  assert.strictEqual(r.ATS判定, '未導入');
  assert.strictEqual(r.entry_type, 'own_form');
});
t('検索フォームはエントリー動線として拾わない', () => {
  const d = detectEntryOnPage(`<html><body><form action="/search"><input name="q"><button>検索</button></form></body></html>`,
    { pageUrl: 'https://acme.co.jp/', pageRole: 'トップ', dict: DICT });
  assert.strictEqual(d.signals.filter((s) => s.source === 'form').length, 0);
});

// ---- 取得できなかった時 ----
t('1ページも取れなければ「不明」（未導入と言い切らない）', () => {
  const r = summarizeAts([], { pagesOk: 0 });
  assert.strictEqual(r.ATS判定, '不明');
  assert.strictEqual(r.確度, 0);
});
t('取れたが動線ゼロなら「不明」（確度は低いまま）', () => {
  const r = sum('<html><body><p>当社は〇〇を製造しています。</p></body></html>');
  assert.strictEqual(r.ATS判定, '不明');
  assert.ok(r.確度 <= 45, `確度=${r.確度}`);
});

// ---- 深掘り候補 ----
t('collectEntryPages が同一企業ドメインのみ・エントリー面を最優先で拾う', () => {
  const html = `
    <a href="/recruit/">採用情報</a>
    <a href="/recruit/entry/">エントリー</a>
    <a href="/recruit/youkou/">募集要項</a>
    <a href="https://other.example.com/entry">他社のエントリー</a>
    <a href="/ir/report.pdf">IR資料</a>`;
  const c = collectEntryPages('https://acme.co.jp/', html);
  assert.strictEqual(c[0].role, 'エントリー', '最優先はエントリー面: ' + JSON.stringify(c[0]));
  assert.ok(!c.some((x) => /other\.example\.com/.test(x.url)), '他社ドメインは見に行かない');
  assert.ok(!c.some((x) => /\.pdf$/.test(x.url)), 'PDFは巡回対象にしない');
  assert.strictEqual(pageRoleOf('/recruit/entry/ エントリー').role, 'エントリー');
});

// ---- 指紋学習 ----
t('clusterFingerprints: 多テナント＋ラベル多数決で side=ats を立てる', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      name: `A社${i}`, label: 'sonarATS',
      signals: [{ entry_type: 'ats_vendor', host: `job.sonar-x.jp`, entry_ctx: true, level: 2, side: 'unknown' }],
      learn: { scripts: [] },
    });
  }
  const { hosts } = clusterFingerprints(rows);
  assert.strictEqual(hosts['sonar-x.jp'].side, 'ats');
  assert.strictEqual(hosts['sonar-x.jp'].vendor, 'sonarATS');
  assert.strictEqual(hosts['sonar-x.jp'].companies, 5);
});
t('clusterFingerprints: 申告「無し」ばかりのホストは diy（＝未導入側）に落とす', () => {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push({
      name: `B社${i}`, label: '無し',
      signals: [{ entry_type: 'ats_vendor', host: 'form-tool.jp', entry_ctx: true, level: 2, side: 'unknown' }],
      learn: { scripts: [] },
    });
  }
  const { hosts } = clusterFingerprints(rows);
  assert.strictEqual(hosts['form-tool.jp'].side, 'diy');
});
t('clusterFingerprints: 1社でしか見ていないホストは辞書に載せない', () => {
  const rows = [{
    name: 'C社', label: '',
    signals: [{ entry_type: 'ats_vendor', host: 'acme-recruit-site.jp', entry_ctx: true, level: 2, side: 'unknown' }],
    learn: { scripts: [] },
  }];
  const { hosts } = clusterFingerprints(rows);
  assert.strictEqual(hosts['acme-recruit-site.jp'], undefined);
});
t('normVendorLabel が自社データ内の表記ゆれを寄せる', () => {
  assert.strictEqual(normVendorLabel('SONAR'), 'sonarATS');
  assert.strictEqual(normVendorLabel('sonarATS'), 'sonarATS');
  assert.strictEqual(normVendorLabel('キャリタスコンタクト'), 'キャリタスContact');
  assert.strictEqual(normVendorLabel('管理くん'), '採用一括かんりくん');
});
t('stratify がベンダー別に均等に取る（1ベンダーで辞書を埋めない）', () => {
  const items = [...Array(20)].map((_, i) => ({ label: i < 15 ? 'X' : 'Y' }));
  const picked = stratify(items, 6, (x) => x.label);
  assert.strictEqual(picked.filter((x) => x.label === 'Y').length, 3, '少数ベンダーも均等に入る');
});

// ---- トーク指針 ----
t('atsTalkGuide が entry_type ごとに違う入口を返す', () => {
  const pdf = atsTalkGuide('未導入', 'pdf_download', '');
  const tel = atsTalkGuide('未導入', 'phone_only', '');
  assert.ok(/手作業|最重症/.test(pdf), pdf);
  assert.ok(/夜間|取りこぼ/.test(tel), tel);
  assert.ok(/除外|乗り換え/.test(atsTalkGuide('導入済', 'ats_vendor', 'ベンダーA')));
});

console.log(`  → ${pass} 件成功`);
