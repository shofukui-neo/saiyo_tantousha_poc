# 機密データの暗号化ボールト

企業リスト・個人情報を **AES-256-GCM + scrypt** で暗号化して保管する仕組み。
全体のデータ取扱ルールは、リポジトリ直下の **[SECURITY.md](../SECURITY.md)** を参照。

## 原則
- `data/` 等の平文は **git追跡しない**（`.gitignore` で除外済み）。
- 暗号文は `secure/vault/` に出力。復号平文は `secure/plain/` に限定（どちらも git-ignore）。
- **本フォルダで追跡されるのはこの README のみ**（`secure/**` は除外、`!secure/README.md` で例外）。
- パスフレーズはリポジトリ・CIログに保存しない。秘密管理サービスを推奨。

## クイック使用

```bash
# パスフレーズ（環境変数 or リポ外の鍵ファイル）
export LISTS_PASSPHRASE='…'                 # Windows: set LISTS_PASSPHRASE=…
# export LISTS_PASSPHRASE_FILE=/secure/keys/lists.key

npm run encrypt:lists            # 全機密ファイルを自動選定して暗号化 → secure/vault/
npm run encrypt:lists -- --dry   # 対象一覧だけ表示（暗号化しない）
npm run decrypt:lists            # secure/plain/ へ復号（閲覧用）
npm run decrypt:lists -- --restore   # 元の場所へ復元
```

## 仕様
- 暗号: AES-256-GCM（認証付き＝改ざん検知）。ファイル毎にランダム salt(16B)/iv(12B)、AAD＝元パス。
- 鍵導出: scrypt（N=2^15, r=8, p=1, 32byte鍵）。旧 v1（PBKDF2）payload も復号互換。
- 対象選定: `scripts/lib-sensitive.js` の機密判定を共有（`.gitignore` の allowlist と一致）。
- payload: `{ v, alg, kdf, kdfParams, relpath, salt, iv, tag, ciphertext }`（base64）。

## セキュリティ注意
- パスフレーズをリポジトリ／CIログに残さない。共有時は暗号文と鍵を**別経路**で。
- 定期的にパスフレーズをローテーションし再暗号化する。
- 誤って平文をコミットした場合の対応は [SECURITY.md](../SECURITY.md) の「インシデント対応」を参照。
