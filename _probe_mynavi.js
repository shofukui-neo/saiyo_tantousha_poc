const fs = require('path').resolve;
const P = require('path');
const R = (p) => require(P.join(__dirname, p));
const fsx = require('fs');
const { MynaviScraper } = R('src/scrape-mynavi');
const seen = new Set(fsx.readFileSync(P.join(__dirname, 'data/recruiter-mynavi-1000.seen.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
const kws = ['小売', '介護', '食品', '専門商社'];
(async () => {
  for (const gy of ['27', '28']) {
    const sc = new MynaviScraper({ gradYear: gy });
    await sc.launch();
    let total = 0, fresh = 0;
    for (const kw of kws) {
      const found = await sc.discoverCorpIds(kw);
      const nf = found.filter((f) => !seen.has(String(f.id)));
      total += found.length; fresh += nf.length;
      console.log(`gy=${gy} "${kw}": found ${found.length}, fresh ${nf.length}`);
    }
    console.log(`>>> gy=${gy} TOTAL found ${total}, fresh ${fresh}`);
    await sc.close().catch(() => {});
  }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
