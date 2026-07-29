'use strict';
/**
 * 適応クロールの自己再起動ランナー
 * =====================================================================
 * harvest-adaptive.js は undici(Node20)の非同期assertで稀にプロセスごと落ちるが、
 * journal/CSV/state を永続化しているため再実行でそのまま再開できる。
 * このランナーは「正常完了(exit0)まで」子プロセスを再起動し続ける（クラッシュ=exit1で再開）。
 *
 *   node src/run-adaptive-loop.js -- [--target 1000] [--max-pages 15] ...
 *   引数は harvest-adaptive.js にそのまま渡す。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const passthru = process.argv.slice(2).filter((a) => a !== '--');
const MAX_RESTARTS = parseInt(process.env.ADAPTIVE_MAX_RESTARTS || '500', 10);
const child = path.join(__dirname, 'harvest-adaptive.js');

for (let i = 0; i <= MAX_RESTARTS; i++) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`\n[runner ${t}] 起動 #${i + 1}: node harvest-adaptive.js ${passthru.join(' ')}`);
  const r = spawnSync(process.execPath, [child, ...passthru], { stdio: 'inherit' });
  if (r.error) { console.log(`[runner] spawn error: ${r.error.message}`); break; }
  if (r.status === 0) { console.log('[runner] 正常完了（母集団走破 or 目標到達）。終了。'); break; }
  console.log(`[runner] 子プロセス異常終了(exit ${r.status})。journalから再開して再起動します…`);
}
