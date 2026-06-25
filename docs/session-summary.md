# 作業まとめ（セッション記録）— arufa版統合 / beta版 簡素化計画

- 日付: 2026-06-24〜25
- リポジトリ: `saiyo_tantousha_poc`
- 関連ドキュメント: [beta-simplification-requirements.md](./beta-simplification-requirements.md)（要件定義の本体）
- このファイルの目的: 本チャットで行った作業・分析・決定事項・今後の方針を1枚に集約した記録／引き継ぎ資料。

---

## 1. このセッションでやったこと（時系列）

1. **現行実装を main に統合し「arufa版」として確定**
   - `feat/gbiz-layer15-filters`（採用担当者名ハーベスター等の全実装）を main へ fast-forward マージ。
   - main を origin に push（`a9176f5a..c0e2e0cc`）。タグは付与せず（ユーザー指定）。
2. **beta版ブランチを作成**
   - main から `beta` ブランチを作成し push（追跡設定済み）。目的＝「機能の引き算」。
3. **実装全体の簡素化余地を徹底調査**
   - 7クラスタに分割し並行精査。結果を [beta-simplification-requirements.md](./beta-simplification-requirements.md) に要件35件（A〜H）としてまとめた。
4. **beta版の進め方を具体化（本まとめの §3〜§5）**
   - 「実装は残し表示だけ消す → リファクタ → 影響小から削除 → ver1.1 → 各ページ精査で ver1.2」という段階方針を受領。
5. **UI（ページ/フォーム）対象の調査と未確定事項の確認（§6）**
   - 「ページ／リスト作成／フォーム送信」が指すUIを特定するため候補を洗い出した（要・最終確認）。

### ブランチ状態

| ブランチ | コミット | 役割 |
|---|---|---|
| `main` | c0e2e0cc | arufa版（全機能入り） |
| `beta` | c0e2e0cc | 機能の引き算 作業ブランチ ← 現在ここ |

---

## 2. システム構成の理解（調査で判明した全体像）

規模: src 約 **10,923 行 / 80 ファイル**、npm script **35本超**、`.git` **228MB**。

### コアの一気通貫パス（＝残すべき中核・約18ファイル）

```
app.js
 ├ icp.js              L1 ICP取得
 ├ discovery.js        L2 発掘（gBiz or Bing）
 ├ pipeline.js         L3-5 1社処理の司令塔
 │   ├ search.js       公式URL発見
 │   ├ fetch.js        取得・本文抽出（Playwrightフォールバック）
 │   ├ structured.js   JSON-LD/sitemap
 │   ├ robots.js       robots遵守
 │   ├ phone.js+areacode.js  電話抽出
 │   ├ recruiter.js→extract.js+jp-names.js  担当者名抽出
 │   └ email.js        メール推定
 ├ master-io.js        CSV出力（+任意Sheets）
 └ metrics.js / score.js  集計・Tier
```

残り約60ファイルは「使い捨てバッチ」「実験プローブ」「案件固有ビルダー(mochica/telapo/1000)」「独立サブシステム(monitor)」「外部API連携」のいずれか＝引き算対象。

### UIに相当する層（今回の新方針に関係）

- **GASスプレッドシートアプリ**（`gas-prottype/`、`gas-bridge/gas-prottype/`）
  - カスタムメニュー「採用リスト」: ①初期セットアップ / ②APIキー設定 / 企業を発掘 / ③パイプライン実行 / ④30日鮮度リフレッシュ / 自動実行トリガー設置・削除。
- **`gas-bridge/Code.gs`**: スプレッドシート橋渡しの **JSON API**（`doGet`=list / `doPost`=書き戻し）。HTMLページUIではない。
- **`system-overview.html`**: 静的な「システム概要＆データフロー」説明ページ（フォーム無し）。
- **Node `src/` CLI**: 画面なし。`console.log` による実行サマリ表示のみ。

---

## 3. beta版 簡素化分析サマリ（要件 A〜H）

詳細は [beta-simplification-requirements.md](./beta-simplification-requirements.md)。以下は要約。

| カテゴリ | 核心 | 代表要件 |
|---|---|---|
| **A コア重複の統合** | discover.js↔discovery.js、merge-lists.js↔csv.js、withTimeout 完全重複、human操作の重複 | A-1〜A-5 |
| **B 担当者名抽出の統合（最重要）** | `extractRecruiterName` が scrape-base/scrape-mynavi でほぼ完全一致コピペ。人名判定が3重実装（looksLikePersonName / looksLikeJpName / validName）で精度不統一。Wantedly取得が build-names と harvest-wantedly で二重 | B-1〜B-5 |
| **C 実験プローブの整理** | probe-* / run-probe-* 4本が pipeline 未統合。recruit-page↔probe-recruit-page 重複。fetch.js↔polite.js の責務重複 | C-1〜C-3 |
| **D 外部API依存の削減** | Hunter / Gemini / Sheets / GAS / NTA が「外部AI API不使用」コンセプトと矛盾。既定OFFまたは削除 | D-1〜D-5 |
| **E 案件固有スクリプトの分離** | mochica/telapo/1000件のハードコードを `projects/` へ隔離 | E-1〜E-3 |
| **F monitor サブシステムの分離** | 12ファイルの独立エコシステム → `packages/` 分離 | F-1〜F-2 |
| **G config の削減** | SOURCE / SEARCH_ENGINE / DDG_* など未使用設定多数。.env.example 40項目を圧縮 | G-1〜G-8 |
| **H リポジトリ衛生** | scrape-cache 1.4GB・*.log・leads-*.csv がコミット済み。.gitignore 整備と追跡解除 | H-1〜H-6 |

**概算削減**: コアファイル -70%（分離込み）、コア行数 -15〜20%、npm script -75%、追跡サイズ大幅減。

---

## 4. beta版の進め方（ユーザー指示の段階方針）

> 「実装クオリティが低いものは…実装が十分なものは、実装内容はあったまま、表示だけしない方針でやってください。リスト作成、フォーム送信は表示消して。次に実装内容をリファクタリングしてください。その後影響の少ないものから順番に削除していってください。一通り削除したら ver1.1 として、各ページごとにシンプル化・統合・自動化できる部分を精査して ver1.2 に向けて進める。」

これを実行手順に分解すると以下。

### ステップ1: 「表示だけ非表示」（実装は残す）
- 低クオリティ／不十分な機能は **コードを消さず、UI上の表示・導線だけ隠す**。
- **「リスト作成」「フォーム送信」の表示を消す**（＝該当UI項目を非表示化）。
- 実装本体は温存するため、後から復活可能。

### ステップ2: リファクタリング
- 残す機能の実装内容を整理（§3のA・B重複統合を中心に、挙動を変えないリファクタ）。

### ステップ3: 影響の少ない順に削除
- 依存が少なく到達不能なものから段階削除（実験プローブ→案件固有→外部API分岐 など）。

### ステップ4: ver1.1 として確定
- 一通り削除し終えたらタグ／節目を `ver1.1` とする。

### ステップ5: ver1.2 へ（各ページ精査）
- 各ページ（画面）単位で「シンプル化・統合・自動化」できる箇所を精査して ver1.2 に向ける。

---

## 5. 推奨実施順（要件マッピング）

| フェーズ | 内容 | 対応要件 |
|---|---|---|
| **ステップ1（表示非表示）** | リスト作成/フォーム送信のUI導線を隠す。低品質機能をメニュー/出力から外す | （UI特定後に確定。§6参照） |
| **ステップ2（リファクタ）** | 抽出・人名判定・共通ユーティリティの集約 | B-1,B-2,A-4,A-5 |
| **ステップ3（削除：影響小→大）** | 実験プローブ隔離→案件分離→外部API削減→コア重複統合→config削減 | C-1,E-1,E-3,D-1,D-3,A-1,A-2,A-3,F-1,G-* |
| **ver1.1** | 上記完了で節目タグ | — |
| **ステップ5（ver1.2）** | 各ページのシンプル化/統合/自動化を精査 | 新規精査 |

### 受け入れ条件（Done）
1. `node src/app.js`（および `--input`）が **APIキーなしで完走**しCSV出力。
2. `npm test`（selftest.js）が通る。
3. 外部API（Gemini/Hunter/NTA/gBiz/Sheets）はすべて任意で、未設定でもクラッシュしない。
4. `src/` から案件固有名（mochica/telapo/1000）が消える。
5. `data/scrape-cache/` 等の生成物が追跡されない。
6. 担当者名抽出の重複関数が1箇所に集約。

---

## 6. 未確定事項（着手前に要確認）

### ★最重要: 「ページ／リスト作成／フォーム送信」が指すUIの特定
調査の結果、このリポジトリ内に **「複数ページ＋フォーム送信」を持つWeb UIは見当たらなかった**。候補は以下。どれを対象に「表示非表示・削除」を行うか確定が必要。

- **(a) GASスプレッドシートアプリ**（`gas-prottype/`）— メニュー「採用リスト」の各項目（≒ページ／ステップ）。最有力だが「フォーム送信」に厳密一致する項目は未確認。
- **(b) リポジトリ外の別Webアプリ** — このリポジトリには無いフロントエンド。場所の共有が必要。
- **(c) system-overview.html** — 静的説明ページ（フォーム無し）。
- **(d) Node src/ CLI** — 「ページ/フォーム」をCLI機能・出力表示と読み替える解釈。

→ 次アクション: 上記のどれか（または別物）をユーザーに確定してもらう。

### その他（要件定義書 §7 より）
1. **D-2 Gemini**: 「削除」か「既定OFFで残す」か（担当者名精度の許容ライン）。
2. **D-3 Sheets/GAS**: 完全削除可か（運用でスプレッドシート連携を使っているか）。
3. **D-4 nta / E-2 run1000 / B-5 enrich-targets**: 実運用頻度次第で残すか。
4. **H-6 git履歴クリーニング**: 破壊的操作（BFG/filter-repo）を許可するか。
5. **分離先**: monitor/案件固有を同一リポの `packages/`・`projects/` でよいか、別リポジトリにするか。

---

## 7. 成果物（このセッションで作成/更新したファイル）

- `docs/beta-simplification-requirements.md` — beta版 要件定義書（要件35件 A〜H、目標アーキテクチャ、受け入れ条件）。
- `docs/session-summary.md` — 本ファイル（セッション全体のまとめ）。
- Git: `main` を arufa版として更新・push、`beta` ブランチ作成・push。

---

## 8. 次の一手

1. §6★ の「対象UIの特定」を確定する。
2. 確定後、ステップ1（リスト作成/フォーム送信の表示非表示）から着手。
3. 以降は §5 のフェーズ順に進め、削除完了で ver1.1、続いて各ページ精査で ver1.2 へ。
