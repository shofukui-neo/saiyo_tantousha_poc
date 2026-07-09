'use strict';
/**
 * リポジトリのセキュリティ・ガードレールを有効化する。
 * git のフックパスを .githooks に向け、pre-commit で機密混入を自動ブロックする。
 * フックは clone で配布されないため、clone 直後に一度だけ実行が必要。
 *   npm run secure:setup
 */
const { execFileSync } = require('child_process');

function run(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

try {
  run(['rev-parse', '--is-inside-work-tree']);
} catch (_) {
  console.error('[secure] gitリポジトリ内で実行してください。');
  process.exit(1);
}

try {
  run(['config', 'core.hooksPath', '.githooks']);
  const cur = run(['config', '--get', 'core.hooksPath']);
  console.log('[secure] ✅ core.hooksPath =', cur);
  console.log('[secure] 以後、機密データ/個人情報/秘密情報を含むコミットは自動的にブロックされます。');
  console.log('[secure] 迂回が必要な誤検知時のみ:  ALLOW_SENSITIVE_COMMIT=1 git commit ...');
} catch (e) {
  console.error('[secure] hooksPath の設定に失敗:', e.message);
  process.exit(1);
}
