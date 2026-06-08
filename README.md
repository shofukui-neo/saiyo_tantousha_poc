# 企業情報 自動取得 PoC（企業名起点）

**企業名を起点に、①公式HPのURL・②電話番号・③採用担当者名 を自動取得する**最小実装です。
URLが分かっていればそれを使い、無ければ**企業名から公式URLを自動発見**してからサイトを巡回します。
入出力は **Google スプレッドシート / GAS / ローカルCSV**。スクレイピング本体はGASでは動かせないため Node＋Playwright で実行し、**リストの読み込みと結果の書き戻し**をスプレッドシートが担います。シートが「処理待ち→結果」の作業台になります。

## 設計方針（外部AI API 不使用・ローカル処理のみ）
**Anthropic 等の外部AI APIは一切呼び出しません。** 課金もネットワーク先での処理も発生しません。全項目をローカルの正規表現・スコアリング・人名判定で取得します。
- **URL発見**：Bing の検索結果HTML（**APIキー不要・無料**）から候補を取得 → 求人媒体・SNS・企業DBを除外 → 「公式コーポレートサイトらしさ」をスコアリング → 上位を実際に取得して**企業名一致を検証**してから採用。
- **電話番号**：`tel:` リンク＋正規表現で抽出。`TEL/代表/お問い合わせ` 近接で加点、`FAX` 近接は減点、法人番号・登録番号など長い数字列の誤検出を除外。
- **採用担当者名**：本文の正規表現（「採用担当：氏名」等）＋**人名らしさ判定**（役割語・組織語・見出し語を除外）で抽出。

## なぜ媒体が「公式企業サイト」なのか
- **合法性が最も安全**：企業自身の公開ページを robots.txt 遵守・低速で読むだけ。第三者プラットフォームのアンチボットや認証回避を伴わない。
- **信号が強い**：電話番号・採用/人事担当の氏名が「お問い合わせ」「採用情報」「会社概要」に載りやすい。
- **技術的に扱いやすい**：多くは静的HTMLで取得でき、必要時のみブラウザ描画にエスカレーションすればよい。

## スプレッドシートの列レイアウト
1行目はヘッダ。**A列（企業名）を用意するだけ**で動きます。B列（URL）は任意で、空なら企業名から自動発見します。C列以降は本ツールが自動で書き戻します。

| 列 | 内容 | 記入者 |
|---|---|---|
| A | company_name（企業名・**必須**） | あなた |
| B | homepage_url（公開トップページURL・**任意**） | あなた（空欄なら自動発見。分かっていれば入れると高速・確実） |
| C〜R | status / resolved_url / phone / name / role / department / confidence / url_source / phone_source_url / name_source_url / evidence / engine / pages_checked / elapsed_ms / error / updated_at | ツールが書き戻し |

- `status` は **採用担当者名** の HIT / MISS（加えて NO_URL / SKIP_ROBOTS / ERROR）。URL・電話の取得可否は `resolved_url` / `phone` 列の有無で分かります。
- `url_source` は URL の出所：`input`（入力）/ `search+verified`（検索＋企業名一致を確認）/ `search(unverified)`（検索のみ・要目視確認）。
- 再実行時に `ONLY_PENDING=true` にすると **status空欄の行だけ**処理します（差分更新・再開に便利）。

## 接続方式は2つ（どちらか選択）

### 方式①：Google Sheets API（サービスアカウント）— 自動実行向き・推奨
1. GCPでプロジェクト作成 → **Google Sheets API を有効化**
2. **サービスアカウント**を作成 → 鍵（JSON）を作成・ダウンロード（例：`service-account.json` をプロジェクト直下に置く）
3. 対象スプレッドシートを、サービスアカウントのメール（`xxxx@xxxx.iam.gserviceaccount.com`）に **「編集者」で共有**
4. `.env` に設定：
   ```
   SOURCE=sheet
   SHEET_ID=<スプレッドシートID>      # URLの /d/ と /edit の間
   SHEET_TAB=Sheet1
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
   ```

### 方式②：GASウェブアプリ橋渡し — GCP不要（GAS運用に慣れている場合）
1. 対象スプレッドシートを開く → **拡張機能 → Apps Script**
2. `gas-bridge/Code.gs` を貼り付け（必要なら `TAB` をシート名に変更）
3. **デプロイ → 新しいデプロイ → ウェブアプリ**（実行＝自分／アクセス＝全員）
4. 発行された `/exec` のURLを `.env` に設定：
   ```
   SOURCE=gas
   GAS_URL=https://script.google.com/macros/s/XXXXX/exec
   ```

## セットアップ
```bash
npm install
npx playwright install chromium      # 動的ページ対応（RPA）。静的サイトのみなら省略可
cp ".env copy" .env                  # 出力先（Sheets/GAS/CSV）の接続方式を設定するだけ。AI APIキーは不要
```

## 実行
```bash
# スプレッドシートを入出力に使用（.env の SOURCE に従う）
node src/index.js

# 方式を明示的に指定
node src/index.js --source sheet
node src/index.js --source gas

# status空欄の行だけ処理（差分更新・再開）
node src/index.js --only-pending

# 主なオプション
node src/index.js --limit 50 --concurrency 3

# ローカルCSVで動作確認（企業名だけのCSVでOK）
node src/index.js --source csv --input companies.sample.csv
```

入力CSVは `company_name`（必須）と `homepage_url`（任意）の2列。URL列が空なら企業名から自動発見します。

## 出力（4項目）
- **企業名 → 公式URL → 電話番号 → 採用担当者名** を各行 C〜R列に直接書き戻し（出所・根拠・取得日時付き）
- コンソールに **公式URL発見率 / 電話番号取得率 / 採用担当者名取得率**、平均確度・処理時間を集計表示
- 書き戻しに失敗した場合は `results.fallback.csv` に退避（結果を失わない）

→ セグメント（業種・規模・ベンチャー比率）ごとにシート／タブを分けて回すと、**セグメント別の各取得率**がそのまま取れます。

## セルフテスト（ネットワーク・APIキー不要）
```bash
npm test
```
抽出→検証→集計に加え、**スプレッドシートI/Oの純粋ロジック**（行番号マッピング、ONLY_PENDING抽出、結果整形）を検証します。

## 処理の流れ（1社あたり）
1. **URL発見** `src/search.js`：入力URLがあれば使用。無ければ企業名でBing検索 → 候補スコアリング → 上位を取得して企業名一致を検証。
2. **巡回** `src/fetch.js`：トップを取得し、ナビから会社概要/お問い合わせ/採用ページを発見。リンクが無ければ定番パス（/company, /contact, /recruit …）と corp. サブドメインを推測補完。
3. **抽出** `src/phone.js`（電話・正規表現）＋ `src/extract.js`（担当者名・正規表現＋人名判定。**外部AI API不使用**）。
4. **検証ゲート** `src/validate.js`：担当者名は人名らしさ＋採用/人事ロール＋確度閾値を通過したものだけHIT。
5. **集計・書き戻し** `src/metrics.js` / `src/io-common.js` ＋ 各I/Oアダプタ。

## 設計との対応
| 要素 | 本PoCの実装 |
|---|---|
| URL発見（企業名→公式HP・APIキー不要） | `src/search.js` Bing検索HTML → 除外/スコアリング → 企業名一致を検証 |
| 電話番号抽出（API不要） | `src/phone.js` `tel:`リンク＋正規表現。TEL/代表近接で加点・FAX減点・登録番号誤検出を除外 |
| 入出力＝スプレッドシート | `src/sheets.js`（Sheets API）/ `src/gas.js`＋`gas-bridge/Code.gs`（GAS橋渡し）/ `src/io-common.js`（共通ロジック） |
| RPA（動的ページ対応） | `src/fetch.js` 静的取得→`looksJsRendered`→Playwright描画にエスカレーション。ページ発見＋定番パス推測 |
| 担当者名抽出（外部AI API不使用） | `src/extract.js` 本文の正規表現＋人名らしさ判定（役割語・組織語・見出し語を除外） |
| 検証ゲート（担当者名HIT判定） | `src/validate.js` 人名らしさ＋採用/人事ロール＋確度閾値 |
| 取得率の実測 | `src/metrics.js` 公式URL発見率／電話番号取得率／担当者名HIT率・平均確度 |
| 礼儀正しいクロール | `robots.js` 遵守、`POLITE_DELAY_MS`、説明的User-Agent |

## 法令・マナー（重要）
- robots.txt と各サイト規約を尊重し、**公開ページのみ**を対象にする（認証回避はしない）。
- 取得した担当者名は**個人情報**。利用目的の特定・適正取得・オプトアウト対応を前提に運用すること。
- `.env` の `USER_AGENT` を連絡先付きに設定し、`POLITE_DELAY_MS`/`CONCURRENCY` を過負荷にならない値で。
- 本コードは検証用であり、**法的助言ではありません**。運用前に規約・関連法令の最終確認を。

## 精度の限界（重要・既知）
- **同名企業の取り違え**：企業名だけでは、よく似た社名の別企業の公式サイトを掴むことがあります。`url_source` が `search(unverified)` の行や、規模に対して不自然なドメインは**目視確認**を推奨。確実な行はB列にURLを入れて再実行してください。
- **担当者名の精度**：氏名抽出はローカルの正規表現＋人名判定で行うため、定型的な表記（「採用担当：氏名」等）は拾えますが、文章中に埋もれた氏名や独特なレイアウトは取り逃すことがあります（**外部AI APIは使いません**）。
- **大企業のコーポレート分離**：採用/会社情報が別サブドメイン（例 corp.example.co.jp）にある場合に対応済みですが、巡回ページ数 `MAX_PAGES_PER_SITE` 内で見つからないと電話を取り逃すことがあります。

## チューニング
- `SEARCH_ENGINE`：`bing`（既定）/ `duckduckgo`。環境により片方が弾かれることがあるので切替可能。
- `MAX_PAGES_PER_SITE`：巡回ページ数。増やすと電話/担当者の取得率↑・所要時間↑。
- `CONFIDENCE_THRESHOLD`：上げると担当者名の精度↑/取りこぼし↑。
- 担当者名の語彙（役割語・非人名ブロックリスト）は `src/extract.js` / `src/config.js` で調整可能。

## 次のステップ（Phase 1）
1. 同名企業対策：所在地・業種などの補助シグナルで候補を絞り込み、取り違えを低減。
2. 媒体ワーカーを追加（PR TIMES / Wantedly 等）し、**並列レース＋first-validated-hit cancel** 化。
3. Discovery層（法人番号/gBizINFO＋採用シグナル）と接続し、入力リストを自動生成。
4. 全MISS時の**架電確認→スプレッドシート書き戻し→次サイクル昇格**ループを実装。
