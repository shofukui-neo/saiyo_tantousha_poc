# Salesforce 連携 実装設計書

> ステータス: **設計のみ（未実装）** / 作成日: 2026-06-16
> ブロッカー: 依頼者にSF管理者権限なし・認証方式未定・現時点でSF画面にアクセス不可。
> このため本書は「認証情報が揃った瞬間に着手できる青写真」として残す。

---

## 0. 結論（先に要点）

- 現状、ライブAPI連携（jsforce直結）は **3方式すべて成立しない**（管理者権限・API有効化が未確認のため）。
- よって **2トラック構成**にする:
  - **Track A（接続不要・今すぐ可）**: SFからCSVエクスポート → 自前リストと法人番号で突合。
  - **Track B（接続必要・あとで点火）**: jsforce で Lead を直接取得。認証情報が揃ったら `.env` に入れるだけで動く形にしておく。
- 突合キーは既存実装と完全に同一: **法人番号優先・無ければ正規化社名**（[master-io.js](../src/master-io.js) の `keyOfRecord` 流儀）。これにより新モジュールは既存パイプラインへ自然に接続できる。

---

## 1. 目的とスコープ

### 目的
御社Salesforceの **Lead（リード）** 情報を、このPoCが外部公開ソース（gBizINFO・採用媒体等）から組み立てた営業リストと突合し、以下を実現する:

1. **重複除外**: SFに既に存在するリードを新規開拓リストから外す。
2. **補完**: SFにあるが情報が薄いリードへ、PoC側の代表者名・採用情報・公式URL等を補う。
3. （将来）**書き戻し**: 補完結果をSFのLeadへ反映（※本PoCの初期スコープ外。読み取り専用で開始）。

### 非スコープ（初期）
- SFへの書き込み（Upsert）。まずは **読み取り専用** で安全に開始。
- Lead以外のオブジェクト（Account/Contact/Opportunity）。必要になれば後続で拡張。
- 個人情報（氏名・電話・メール）の取り込み。突合には**法人番号と社名だけで足りる**ため、初期は法人軸の項目のみ扱い、PII最小化。

---

## 2. 認証方式の比較と判断

| 方式 | 必要なもの | 自前権限なしでの可否 | 推奨度 |
|------|-----------|----------------------|--------|
| **OAuth 2.0 接続アプリ** | 管理者がConnected App作成 → client_id/secret | ❌ 管理者依頼が必須 | ◎ 本番推奨 |
| ユーザー名+PW+セキュリティトークン | プロファイルで「API Enabled」+ 自分のトークン | △ API有効化は管理者設定 | △ 簡易検証のみ |
| セッションID流用 | 既存ログインのセッションID+インスタンスURL | △ 短命・不安定 | ✕ 本番不可 |

**判断**: 本番は **OAuth 2.0（JWT Bearer または Web Server Flow）** を採用。
- バッチ/無人実行を見据えるなら **JWT Bearer Flow**（証明書ベース、ユーザー操作なしでトークン取得）が最適。
- まず人手で動かす段階なら Username-Password Flow でも可（ただしPW平文管理になるため `.env` を必ず gitignore）。

### 管理者へ依頼する設定（Connected App 作成手順・依頼書テンプレ）
管理者ルートが見つかった場合、以下をそのまま渡す:

1. 設定 → アプリケーションマネージャ → 新規接続アプリケーション
2. 「API（OAuth設定の有効化）」をON
3. コールバックURL: `http://localhost:1717/callback`（Web Server Flow用。JWTなら不要）
4. OAuthスコープ:
   - `Manage user data via APIs (api)` … Lead読み取りに必須
   - `Perform requests at any time (refresh_token, offline_access)` … トークン更新用
5. （JWT Bearer採用時）「デジタル証明書」に自己署名証明書をアップロード
6. 発行された **Consumer Key (client_id)** と **Consumer Secret** を共有してもらう
7. 接続アプリのポリシーで、実行ユーザーのプロファイル/権限セットを事前承認

---

## 3. データモデルと項目マッピング

PoC側マスタ項目（[config.js](../src/config.js) `MASTER_HEADERS`）:
`企業名, 法人番号, 採用担当者名, 役職, 部署, 代表者名, メール, メール確度, 担当者確度, 電話番号, 公式URL, Tier, 取得元媒体, 根拠URL, 架電呼称, 業種, 都道府県, 従業員数, 補助金, 設立年, 取得日`

### SF Lead 標準項目 → PoCマスタ のマッピング

| Salesforce Lead 項目 | API名 | PoCマスタ列 | 備考 |
|----------------------|-------|-------------|------|
| 会社名 | `Company` | 企業名 | 突合フォールバックキー |
| 法人番号(カスタム想定) | `CorporateNumber__c` 等 | 法人番号 | **第一突合キー**。SFにこの項目が無い可能性大→§6参照 |
| 業種 | `Industry` | 業種 | |
| 都道府県 | `State` | 都道府県 | |
| 従業員数 | `NumberOfEmployees` | 従業員数 | |
| Webサイト | `Website` | 公式URL | |
| 状態 | `Status` | （新規列 `SF状態`） | 重複判定の文脈に使用 |
| 所有者 | `Owner.Name` | （新規列 `SF所有者`） | 既存リードの担当営業 |
| リードID | `Id` | （新規列 `SFリードID`） | 書き戻し時のリンクキー |
| 作成日 | `CreatedDate` | （新規列 `SF作成日`） | |

> 突合の出力には `SFリードID / SF状態 / SF所有者` の3列を追加し、「SF既存か」「誰が持っているか」を一目で分かるようにする。

### 突合キー生成（既存と同一ロジック）
```js
// master-io.js の keyOfRecord と同じ
const corp = String(rec['法人番号'] || '').trim();
const key  = corp ? 'c:' + corp : 'n:' + normalizeName(rec['企業名']);
```
- 社名正規化（`normalizeName`）は、株式会社/(株)/全半角/スペース揺れを吸収する関数を別途用意（既存に名寄せ用の正規化があれば再利用、無ければ新設）。

---

## 4. モジュール設計（ファイル構成）

```
poc/src/
  sf-client.js     … L0 認証＋クエリ層。jsforce ラッパ。トークン取得・SOQL実行のみ。
  sf-fetch-leads.js… L1 取得層。Lead を SOQL で全件/条件取得し sources/SF-leads.csv に保存。
  sf-merge.js      … L2 突合層。SF-leads.csv と自前リストを法人番号/社名で突合し、
                     除外フラグ・補完・SF三列付与を行う。
docs/
  sf-integration-design.md … 本書
```

> 設計方針: **L0(認証) と L2(突合ロジック) を分離**。Track A（CSV手動エクスポート）では L0 を飛ばして、もらったCSVを直接 L2 に食わせられる。＝認証が無い今でも突合機能だけ先に完成・テスト可能。

### sf-client.js（Track B・認証あり時のみ）
```
- 依存: jsforce（新規 npm 依存。package.json に追加）
- 環境変数（.env）:
    SF_LOGIN_URL       = https://login.salesforce.com  (Sandboxは test.salesforce.com)
    SF_CLIENT_ID       = <Consumer Key>
    SF_CLIENT_SECRET   = <Consumer Secret>
    SF_USERNAME        = <実行ユーザー>            (Username-Password / JWT)
    SF_PASSWORD        = <PW + セキュリティトークン> (Username-Password時のみ)
    SF_PRIVATE_KEY     = <JWT用秘密鍵パス>          (JWT時のみ)
- 公開関数:
    connect() -> conn        … 方式を環境変数から自動判定して接続
    queryLeads(soql) -> rows  … SOQL実行（ページング自動・2000件超も取得）
- フェイルセーフ: 認証情報が無ければ明示エラーで「Track A(CSV)を使え」と案内。
```

### sf-fetch-leads.js（Track B）
```
- 既定SOQL:
    SELECT Id, Company, Industry, State, NumberOfEmployees, Website,
           Status, Owner.Name, CreatedDate, CorporateNumber__c
    FROM Lead
    WHERE IsConverted = false
- 出力: sources/SF-leads.csv（MASTER_HEADERS互換 + SF三列）
- CLI: node src/sf-fetch-leads.js --out sources/SF-leads.csv [--where "Status='Open'"]
```

### sf-merge.js（Track A/B 共通・本体）
```
- 入力:
    --sf   sources/SF-leads.csv     (手動エクスポート or sf-fetch-leads.js の出力)
    --list leads-daihyou-1000.csv   (自前リスト)
- 処理:
    1. 両者を keyOfRecord でインデックス化
    2. 自前リスト各行に対し SF突合を判定:
         - ヒット   → SF既存。SFリードID/状態/所有者 を付与。--mode で除外 or 補完を選択
         - 非ヒット → 純新規。そのまま残す
    3. （補完モード）SF側の空き項目を PoC側の値で埋めた補完候補列を生成
- 出力:
    --out-new      leads.new-only.csv   (SF未登録の純新規だけ)
    --out-annotated leads.sf-annotated.csv (全件 + SF三列、除外フラグ付き)
- CLI例:
    node src/sf-merge.js --sf sources/SF-leads.csv --list leads-daihyou-1000.csv \
      --mode exclude --out-new leads.new-only.csv --out-annotated leads.sf-annotated.csv
- レポート: 突合件数 / 新規件数 / 重複率 を標準出力にKPIとして表示（source-kpi.js の流儀）。
```

---

## 5. セキュリティ設計

- 認証情報は **`.env` のみ**に置き、リポジトリへコミットしない（`.gitignore` に `.env` を確認/追加）。
- パスワード方式は最終手段。採用する場合もログ・エラー出力にPW/トークンを**絶対に出さない**。
- 初期は **読み取り専用**。書き戻し（Upsert）は別フェーズで、ドライラン必須の設計にする。
- PII最小化: 突合に不要な氏名・電話・メールはSOQL/CSVから**取得しない**運用を既定にする。
- SOQLは固定文字列＋ホワイトリスト化したパラメータのみ（`--where` は限定的に検証）。SOQLインジェクション回避。

---

## 6. 既知のリスク・未確定事項

1. **法人番号がSF Leadに無い可能性が高い**。標準Lead項目に法人番号は無く、カスタム項目（`CorporateNumber__c`）が作られていなければ、突合は **社名正規化のみ**に劣化する。
   - 対策: 社名正規化のマッチ精度を上げる（株式会社表記・前株後株・全半角・法人格揺れの吸収）。突合は「確実(法人番号一致)／推定(社名一致)」の2段階信頼度で出力。
2. 管理者権限・API有効化が取れない場合、**Track B は永続的に保留**。その場合は Track A（CSV）が唯一の経路。
3. SF項目のAPI名（特にカスタム項目）は組織依存。実接続時に `describe` で実項目を確認してマッピングを確定する。
4. Lead件数が大きい場合のページング（jsforce の `autoFetch`/`maxFetch`）と、APIコール上限に注意。

---

## 7. 実装着手チェックリスト（認証情報が揃ったら）

- [ ] `npm install jsforce` を追加し package.json に記載
- [ ] `.env` に SF_* を設定、`.gitignore` で除外確認
- [ ] `sf-merge.js` を**先に**実装（Track A・認証不要でテスト可能）
- [ ] サンプルCSV（手動エクスポート or ダミー）で突合の正当性を検証
- [ ] `sf-client.js` / `sf-fetch-leads.js` を実装（Track B）
- [ ] SFの実際のLead項目を `describe` で確認しマッピング確定（特に法人番号カスタム項目）
- [ ] 突合KPI（重複率・新規率）を出力し、source-kpi.js と整合
- [ ] package.json に `"sf:fetch"` `"sf:merge"` スクリプトを追加

---

## 8. 当面の推奨アクション

1. 依頼者がSF画面に入れるようになったら、まず **検証①（CSVエクスポート可否）** と **検証②（管理者ルート有無）** を確認。
2. CSVが1本でも取れたら、`sf-merge.js` を実装して**今日中に突合成果**を出せる。
3. その成果を根拠に、管理者へ **Track B（Connected App）** を依頼する、という順序が最も通りやすい。
