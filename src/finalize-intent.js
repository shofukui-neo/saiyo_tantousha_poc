'use strict';
/**
 * 作業ファイルから最終CSVだけを作る（取得も採点もしない）
 * ============================================================================
 * intent-analyze.js は「取得 → 採点 → 作業ファイルに追記 → 最後に並べ替えて書き出し」
 * という順で動く。最後の書き出しだけが落ちた場合（メモリ不足など）、
 * 取得済みの作業ファイルは無傷で残っているので、ここから最終CSVを作り直せる。
 *
 * 90分かけた取得をやり直さずに済ませるための出口。
 *
 * 使い方:
 *   npm run intent:finalize
 *   node src/finalize-intent.js --work data/leads-intent-wide.work.csv --out data/leads-intent-wide.csv
 */
const fs = require('fs');
const path = require('path');
const { finalizeFromWork } = require('./intent/finalize');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);

const OUT = path.resolve(ROOT, getArg('out', 'data/leads-intent-wide.csv'));
const WORK = path.resolve(ROOT, getArg('work', OUT.replace(/\.csv$/i, '') + '.work.csv'));

async function main() {
  if (!fs.existsSync(WORK)) { log('作業ファイルがありません: ' + WORK); process.exitCode = 1; return; }
  log(`作業ファイル ${(fs.statSync(WORK).size / 1e6).toFixed(1)}MB → 並べ替えて書き出し`);
  const r = await finalizeFromWork(WORK, OUT);
  log(`${r.行数}行を書き出し` + (r.除外 ? `（架電禁止 ${r.除外}行を除外）` : ''));
  log('出力: ' + OUT);
  log('※ レポートは作りません。必要なら npm run intent:rescore（採点し直し＋レポート再生成）');
}

if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });
