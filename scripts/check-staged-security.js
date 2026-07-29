'use strict';
/**
 * pre-commit ガード: ステージされた変更に機密データ/個人情報/秘密情報が
 * 含まれていればコミットを中止する。SECURITY.md 参照。
 *
 * 導入:  npm run secure:setup   (git config core.hooksPath .githooks)
 * 迂回:  ALLOW_SENSITIVE_COMMIT=1 git commit ...   (誤検知時のみ)
 * 単体:  npm run secure:check
 */
const { execFileSync } = require('child_process');
const lib = require('./lib-sensitive');

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function stagedBlob(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], { maxBuffer: 128 * 1024 * 1024 });
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function main() {
  if (process.env.ALLOW_SENSITIVE_COMMIT === '1') {
    console.error('[secure] ALLOW_SENSITIVE_COMMIT=1 — 機密チェックをスキップしました。');
    return 0;
  }

  let files;
  try {
    files = stagedFiles();
  } catch (e) {
    console.error('[secure] ステージ一覧の取得に失敗しました:', e.message);
    return 0; // git 環境が無い等では素通し(コミット自体を壊さない)
  }

  const violations = [];
  for (const f of files) {
    if (lib.isSecretFile(f)) {
      violations.push([f, '秘密/認証情報ファイル(.env・鍵・サービスアカウント)']);
      continue;
    }
    if (lib.isSensitivePath(f)) {
      violations.push([f, '機密データパス(企業リスト/個人情報)']);
      continue;
    }
    const buf = stagedBlob(f);
    if (buf.length === 0 || buf.includes(0)) continue; // 空/バイナリはスキップ
    const text = buf.toString('utf8');

    const secrets = lib.scanSecrets(text);
    if (secrets.length) {
      violations.push([f, `秘密情報の埋め込み: ${secrets.join(', ')}`]);
      continue;
    }
    if (lib.looksLikeDataFile(f)) {
      const pii = lib.findPiiHeader(text);
      if (pii.length) {
        violations.push([f, `PII列ヘッダ検出(${pii[0].lineNo}行目): ${pii[0].tokens.join(' / ')}`]);
      }
    }
  }

  if (violations.length) {
    console.error('\n⛔  コミットを中止しました — 機密データ/秘密情報が含まれています。\n');
    for (const [f, why] of violations) console.error(`   ✗ ${f}\n       → ${why}`);
    console.error('\n  対応方法:');
    console.error('   • 企業リスト/個人情報は data/ 等に置く(既定で .gitignore 済み)。');
    console.error('   • 保存時暗号化が必要なら:  npm run encrypt:lists  (secure/vault/ へ)。');
    console.error('   • 秘密情報は .env(git-ignore)へ。.env.example はプレースホルダのみ。');
    console.error('   • 誤検知でどうしても通す場合のみ:  ALLOW_SENSITIVE_COMMIT=1 git commit ...\n');
    return 1;
  }
  return 0;
}

process.exit(main());
