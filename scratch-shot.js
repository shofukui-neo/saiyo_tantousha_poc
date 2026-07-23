const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await p.goto('http://localhost:5178/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const rowCount = await p.$$eval('#tb tr', rs => rs.length);
  const countTxt = await p.$eval('#count', el => el.textContent);
  const kTotal = await p.$eval('#k-total', el => el.textContent);
  await p.screenshot({ path: 'scratch-dashboard.png', fullPage: false });
  console.log('rows描画:', rowCount, '| count:', countTxt, '| KPI total:', kTotal);
  console.log('JSエラー:', errs.length ? errs.join(' || ') : 'なし');
  await b.close();
})();
