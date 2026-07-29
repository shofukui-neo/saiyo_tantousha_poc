# セキュリティ / データ取扱ガイド

本リポジトリは採用担当者リストを生成するため、**個人情報**と**企業リスト**を扱う。
これらを外部に漏洩させないための設計・運用ルールを定める。**新規cloneした人は最初に「導入」を実行すること。**

---

## 1. データ分類

| 区分 | 例 | 取り扱い |
|---|---|---|
| **PII（個人情報）** | 採用担当者名・氏名・役職・部署・電話番号・メール・代表者名 | git追跡禁止。ローカル `data/` 等に置き、共有は暗号化ボールト経由のみ |
| **企業リスト/派生データ** | リード一覧・スコア・法人番号・既存顧客・NG(禁止)・SFリード・モニタ出力 | 同上（git追跡禁止） |
| **秘密情報** | `.env`・`service-account*.json`・APIキー・秘密鍵 | git追跡禁止。`.env.example` にはプレースホルダのみ |
| **公開可** | ソースコード・設定(`sources/manifest.json`)・辞書(`data/media-catalog.json`)・テストフィクスチャ・ドキュメント | 追跡可 |

**原則: `data/` `sources/` `archive/` `eval/` `secure/` 配下および ルート直下の `*.csv`/`*.log` は「既定で機密」。** 追跡してよいのは `.gitignore` の allowlist（`!` 行）に明記された非PIIファイルのみ。

---

## 2. 三層防御（多重の漏洩対策）

1. **`.gitignore`（allowlist方式）** — データは既定で全除外。非PIIの設定/辞書/フィクスチャだけを `!` で再包含。
   `data/`(末尾スラッシュ)ではなく `data/**` を使うのは、前者だと `!` 再包含が効かないため。
2. **pre-commit ガード** — `.githooks/pre-commit` → `scripts/check-staged-security.js`。
   機密パス・秘密パターン(APIキー/秘密鍵)・PII列ヘッダを検出したコミットを**自動中止**。
3. **保存時暗号化ボールト** — `data/` 等の機密を AES-256-GCM + scrypt で `secure/vault/` に暗号化。
   平文・暗号文とも既定でコミットしない（Privateリポでも二重防御）。

判定ロジックは `scripts/lib-sensitive.js` に集約し、ガードと暗号化で共通利用（定義のズレを防ぐ）。

---

## 3. 導入（clone直後に一度だけ）

git のフックは clone で配布されないため、各自で有効化が必要。

```bash
npm install
npm run secure:setup      # git config core.hooksPath .githooks
```

これ以降、機密データ/秘密情報を含むコミットは自動的にブロックされる。

---

## 4. 暗号化ボールトの運用

```bash
# パスフレーズを環境変数で渡す（リポジトリ・CIログに絶対に書かない）
export LISTS_PASSPHRASE='…'           # Windows: set LISTS_PASSPHRASE=…
#   もしくは リポ外の鍵ファイルを指定:  export LISTS_PASSPHRASE_FILE=/secure/keys/lists.key

npm run encrypt:lists                 # 全機密を secure/vault/ へ暗号化
npm run encrypt:lists -- --dry        # 対象一覧だけ確認
npm run decrypt:lists                 # secure/plain/ に復号（ローカル閲覧用）
npm run decrypt:lists -- --restore    # 元の場所へ復元
```

- 暗号: **AES-256-GCM**（認証付き＝改ざん検知）／鍵導出: **scrypt**（N=2^15, r=8, p=1）。ファイル毎にランダム salt/iv、AADにファイルパス。
- パスフレーズは**秘密管理サービス**（Azure Key Vault / AWS Secrets Manager / 1Password 等）で管理し、定期的にローテーションして再暗号化する。
- 暗号文を他者へ共有する場合も、パスフレーズは**別経路**で渡す。

---

## 5. やってはいけないこと

- `git add -f` で `.gitignore` を回避して機密を追加しない。
- 秘密情報（キー・鍵）をソースや `.env.example` に書かない。実値は `.env`（追跡外）へ。
- パスフレーズをコミットメッセージ・ログ・issue・チャットに貼らない。
- ガードの回避（`ALLOW_SENSITIVE_COMMIT=1`）は**誤検知時のみ**。使う前に本当に非機密か確認する。

---

## 6. 万一コミットしてしまったら（インシデント対応）

1. **まだ push していない**: 直前コミットを修正。`git rm --cached <file>` → `.gitignore` 追記 → `git commit --amend`。
2. **push 済み**: そのデータは**漏洩したものとして扱う**。
   - git履歴からの完全除去（`git filter-repo --invert-paths --path <file>` → `git push --force-with-lease`）。
   - 既存clone/フォーク/ホスティングのキャッシュには残り得るため、共同作業者は**再clone必須**。
   - 秘密情報だった場合は**即失効・ローテーション**（鍵の再発行）。
   - 個人情報の場合、社内規程・個人情報保護法に沿って必要な報告・対応を行う。
3. リポジトリは **Private を維持**する。

---

## 7. 関連ファイル

- `.gitignore` — allowlist方式の除外定義
- `.githooks/pre-commit` / `scripts/check-staged-security.js` — コミット時ガード
- `scripts/lib-sensitive.js` — 機密判定の一元定義
- `scripts/encrypt-lists.js` / `decrypt-lists.js` / `scripts/lib-crypto.js` — 暗号化ボールト
- `secure/README.md` — ボールトのクイックリファレンス
