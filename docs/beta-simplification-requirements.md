# beta版 要件定義書 — 実装簡素化（機能の引き算）

- 対象ブランチ: `beta`
- 基準コミット: `c0e2e0cc`（= main / arufa版）
- 作成日: 2026-06-24
- 目的: arufa版（全部入り）から「コアの一気通貫」だけを残し、重複・案件固有・外部API依存・成果物の混入を削ぎ落として、保守可能な最小実装に収束させる。

---

## 0. 背景と全体像

arufa版は src 約 **10,923 行 / 80 ファイル**、npm script **35本超**、`.git` **228MB**（コミット23本に対し過大）まで肥大している。一方で本体の価値である「一気通貫の営業リスト生成」は、ごく一部のファイルに集約されている。

### コアの一気通貫パス（= 残すべき中核）

```
app.js
  └─ icp.js              （L1: ICP取得）
  └─ discovery.js        （L2: 発掘 — gBiz or Bing）
  └─ pipeline.js         （L3-5: 1社処理の司令塔）
        ├─ search.js     （公式URL発見）
        ├─ fetch.js      （取得・本文抽出 / Playwrightフォールバック）
        ├─ structured.js （JSON-LD/sitemap）
        ├─ robots.js     （robots遵守）
        ├─ phone.js + areacode.js（電話抽出）
        ├─ recruiter.js → extract.js + jp-names.js（担当者名抽出）
        └─ email.js      （メール推定）
  └─ master-io.js        （CSV出力 + 任意でSheets）
  └─ metrics.js / score.js（集計・Tier）
```

この **約18ファイル** が本体。残りの約60ファイルは「使い捨てバッチ」「実験プローブ」「案件固有ビルダー」「独立サブシステム」「外部API連携」のいずれかであり、引き算の対象になる。

---

## 1. 引き算の基本方針（設計原則）

1. **コア一気通貫を唯一の正とする** — `app.js → discovery → pipeline → master-io` から到達不能なコードは「削除/分離/オプション化」のいずれかに分類する。
2. **「外部AI API不使用・ローカル処理のみ」という当初コンセプトに回帰する** — Gemini / Hunter 等の課金AI/API依存は既定OFF（または削除）。正規表現＋辞書のローカル経路を標準とする。
3. **案件固有（mochica / telapo / 1000件）を本体から物理分離** — `projects/` 配下へ隔離し、`src/` は汎用基盤のみにする。
4. **重複ロジックは1箇所に集約** — 同一の正規表現/名前検証/ユーティリティの再実装を排除する。
5. **成果物（CSV・ログ・キャッシュ）はリポジトリから除外** — `.gitignore` 整備と追跡解除。
6. **削除は可逆** — arufa版は main に保全済み。beta では大胆に削ってよい。

---

## 2. 要件一覧（カテゴリ別）

優先度: **P0**=最優先（効果大・低リスク） / **P1**=推奨 / **P2**=任意・将来。

### カテゴリA: コア重複の統合

| ID | 要件 | 対象 | 優先 |
|----|------|------|------|
| A-1 | `discover.js` を `discovery.js` に統合し削除（happy pathは discovery 経由のみ。`extractCompanyNames*` は run1000 専用） | discover.js, discovery.js | P1 |
| A-2 | `merge-lists.js` を廃止し、`csv.js` の `parseCsv`/名寄せキーを再利用（CSVパーサ二重実装の解消） | merge-lists.js, csv.js | P1 |
| A-3 | スコアリングを一本化。`score-list.js` は `build-list.js --score-only` に統合して廃止 | score-list.js, build-list.js | P1 |
| A-4 | `withTimeout()` を共通ユーティリティ化（`build-media.js` と `scrape-pages.js` の完全重複を解消） | build-media.js, scrape-pages.js | P0 |
| A-5 | `humanClick/humanType/humanMove` を共通化（`scrape-base.js` と `scrape-mynavi.js` の重複） | scrape-base.js, scrape-mynavi.js | P1 |

### カテゴリB: 担当者名抽出クラスタの統合（最重要）

担当者名取得が最も重複している。同名関数・同等ロジックが散在している。

| ID | 要件 | 根拠（重複） | 優先 |
|----|------|------|------|
| B-1 | `extractRecruiterName` を1モジュールに集約 | `scrape-base.js` L50-98 と `scrape-mynavi.js` L183 がほぼ完全一致 | P0 |
| B-2 | 人名判定を `jp-names.js` に一本化 | `extract.js`の`looksLikePersonName`、`harvest-wantedly.js`の`looksLikeJpName`、`scrape-mynavi.js`の`validName` が三重実装・精度不統一 | P0 |
| B-3 | Wantedly取得を単一アダプタに統合（`mode=search`/`mode=sitemap`） | `build-names.js`(company-first) と `harvest-wantedly.js`(discovery-first) が同一媒体を別実装 | P1 |
| B-4 | AI経路を `recruiter.js` に集約し、`extract.js` の Ollama 経路は recruiter 経由のみに整理 | recruiter→extract→ollama の冗長層 | P2 |
| B-5 | `enrich-targets.js`（手動マージ）は B-3 統合で自動マージ化し廃止検討 | 後処理の手作業 | P2 |

### カテゴリC: 実験プローブの整理（pipeline未統合）

以下は **app/pipeline から呼ばれない** 実験/単独スクリプト。本体に統合するか、`experiments/` へ隔離するか、削除する。

| ID | 要件 | 対象 | 優先 |
|----|------|------|------|
| C-1 | プローブ群を `experiments/` へ隔離 or 削除 | `probe-search.js`, `run-probe-search.js`, `probe-recruit-page.js`, `run-probe-recruit-page.js` | P1 |
| C-2 | `recruit-page.js`（採用ページ有無判定）の要否を判断し、`probe-recruit-page.js` と重複する `findRecruitLinks` を共通化 or 削除 | recruit-page.js | P2 |
| C-3 | `fetch.js` と `polite.js` の責務重複を整理（robotsチェック/キャッシュの二重実装）。pipelineは fetch.js、probeは polite.js という分裂を解消 | fetch.js, polite.js, robots.js | P1 |

### カテゴリD: 外部API依存の削減（コンセプト回帰）

| ID | 要件 | 効果 | 優先 |
|----|------|------|------|
| D-1 | Hunter.io 検証を削除（`email.js` の検証分岐）。メール確度はMX篩いのみに簡素化 | 課金API1本・キー設定1つ削減 | P0 |
| D-2 | Gemini を既定OFF（または削除）。担当者名は正規表現＋辞書を標準経路に | 「AI不使用」コンセプト適合 | P1 |
| D-3 | 出力をCSVに統一し `sheets.js` / `gas.js` を削除（相互排他で両方は不要）。Sheets連携が必要なら別ツール化 | googleapis依存・GAS運用の排除 | P1 |
| D-4 | `nta.js`（国税庁）の要否判断。入力に法人番号がある or gBizで取れるなら死コード | 条件付き削除 | P2 |
| D-5 | gBizINFO は「発掘」用途として残すが、pipeline内の代表者名補完は任意化（キー無しで完走を保証） | 既定で完全ローカル動作 | P1 |

### カテゴリE: 案件固有スクリプトの分離

mochica / telapo / 1000件 はハードコードされた特定案件向け。本体から物理分離する。

| ID | 要件 | 対象 | 優先 |
|----|------|------|------|
| E-1 | `projects/mochica/` を作り案件固有ビルダーを移設 | `build-telapo-1000.js`, `build-target-list.js`, `build-mochica-list.js`, `build-named-select.js`, `mochica-fit.js` | P1 |
| E-2 | `run1000.js` の固定クエリ母集団（地域×業種）を config か外部JSONに外出し（汎用化して残す） | run1000.js | P2 |
| E-3 | 案件固有の npm script（mochica/telapo/named系）を本体scriptsから分離 | package.json | P1 |

### カテゴリF: monitor サブシステムの分離

`src/monitor/` (12ファイル) は状態永続化・自律ブレイン・差分検知・ランキング出力まで自己完結した別エコシステム。本体の「初期選定」とは目的（鮮度追跡）が異なる。

| ID | 要件 | 優先 |
|----|------|------|
| F-1 | `src/monitor/` を `packages/monitor/`（or 別リポジトリ）へ分離。本体 app.js とは独立起動のまま | P1 |
| F-2 | 接点が必要なら「監視結果を intent ソースとして build-list に合流」する1点のみに限定 | P2 |

### カテゴリG: 設定（config.js）の削減

未使用・決め打ちの設定項目を削除し、認知負荷を下げる。

| ID | 削除/統合候補 | 状態 | 優先 |
|----|------|------|------|
| G-1 | `SOURCE` / `ONLY_PENDING` | 参照されない | P1 |
| G-2 | `SHEET_TAB`（`MASTER_TAB`と重複） | 統合 | P1 |
| G-3 | `GAS_URL`（D-3でgas削除に伴い） | 削除 | P1 |
| G-4 | `SEARCH_ENGINE` / `DDG_HTML_URL` / `SEARCH_MAX_CANDIDATES` / `SEARCH_VERIFY_TOP` | Bing決め打ちで未参照 | P1 |
| G-5 | `DISCOVER_LIMIT` / `DISCOVER_PAGES` / `DISCOVER_FETCH_TOP` | discover.js専用（A-1で整理） | P2 |
| G-6 | `CONFIDENCE_THRESHOLD`（`SCORE_THRESHOLD`と二重） | 統合 | P2 |
| G-7 | `QUALITY_WEIGHTS` | quality.js へ局所化 | P2 |
| G-8 | `.env.example` を上記削減に合わせて40項目→必要最小限に圧縮 | — | P1 |

### カテゴリH: リポジトリ衛生

| ID | 要件 | 詳細 | 優先 |
|----|------|------|------|
| H-1 | `.gitignore` 整備 | `*.log` / `leads-*.csv` / `data/scrape-cache/`（1.4GB）/ `data/**/*.json`中間物 / `*.bak.csv` を除外 | P0 |
| H-2 | 追跡解除 | `git rm --cached` でコミット済みキャッシュ・ログ・出力CSVをindexから外す | P0 |
| H-3 | `archive/`（3MB）の扱い | README.md以外のCSVスナップショットを除外 | P1 |
| H-4 | `gas-prottype/`（プロトタイプ）を整理 | `gas-bridge/`（稼働版）と重複。archive送りor削除 | P1 |
| H-5 | README.md（43KB）を分割 | クイックスタートを残し、詳細は `docs/` へ | P2 |
| H-6 | `.git` 履歴の肥大化 | 必要なら BFG / filter-repo で過去の大型バイナリを除去（破壊的・要合意） | P2 |

---

## 3. 目標アーキテクチャ（簡素化後）

```
src/                         ← 汎用コアのみ（約18-22ファイル）
  app.js                     エントリ（--only-discover等の補助分岐は整理）
  icp.js  discovery.js  pipeline.js
  search.js  fetch.js  structured.js  robots.js
  phone.js  areacode.js
  recruiter.js  extract.js  jp-names.js  romaji-name.js  validate.js
  email.js
  master-io.js  csv.js  metrics.js  score.js
  merge.js  build-list.js  source-kpi.js   ← 汎用ビルド層
  scrape-base.js  scrape-{rikunabi,careertasu,onecareer,mynavi}.js  scrape-pages.js  build-media.js
  utils/
    timeout.js               withTimeout（A-4）
    humanops.js              human操作（A-5）
    text-extract.js          extractRecruiterName 集約（B-1）

projects/mochica/            ← 案件固有（E-1）
  build-telapo-1000.js  build-target-list.js  build-mochica-list.js
  build-named-select.js  mochica-fit.js  exclude-ng.js  sf-merge.js

packages/monitor/            ← 独立サブシステム（F-1）
  run.js  autonomy.js  snapshot.js  diff.js  heat.js  report.js
  store.js  media-catalog.js  probe-media.js  probe-variants.js  sheets-sink.js

experiments/                 ← 実験プローブ（C-1）。将来削除候補
  probe-search.js  run-probe-search.js  probe-recruit-page.js  run-probe-recruit-page.js
```

### 削除候補（統合により消滅）
`discover.js`(A-1) / `merge-lists.js`(A-2) / `score-list.js`(A-3) / `sheets.js`,`gas.js`(D-3) / `enrich-targets.js`(B-5,条件付) / `nta.js`(D-4,条件付)

---

## 4. 受け入れ条件（Done の定義）

引き算後も、以下が成立することを保証する。

1. **`node src/app.js`（およびCSV入力 `--input`）が APIキーなしで完走** し、URL/電話/担当者名/メール/Tier 列のCSVを出力する。
2. **`npm test`（`test/selftest.js`）が通る** — 24前後のローカルテスト（fetch/extract/validate/score/phone/person-name）を回帰として維持。`monitor.test.js` は monitor 分離先で維持。
3. **外部API（Gemini/Hunter/NTA/gBiz/Sheets）はすべて任意** — 未設定でもクラッシュせず劣化動作する。
4. **`src/` から案件固有名（mochica/telapo/1000）が消える**（projects へ移設済み）。
5. **`git status` がクリーンで、`data/scrape-cache/` 等の生成物が追跡されない**。
6. **担当者名抽出の重複関数が1箇所に集約**され、姓辞書の更新が1ファイル（jp-names.js）で完結する。

### 非機能・リスク
- スクレイパの抽出精度は arufa版と同等を維持（B統合は挙動を変えないリファクタとして実施。統合前後で抽出結果CSVを差分比較）。
- Gemini削除は担当者名の確度低下を伴う（D-2）。許容範囲かを `audit-names.js` で計測してから確定。
- `.git` 履歴クリーニング（H-6）は破壊的。実施は別途合意の上で。

---

## 5. 推奨実施順（フェーズ）

- **Phase 1（P0・低リスク・即効）**: H-1/H-2（gitignore・追跡解除）、A-4（withTimeout）、B-1/B-2（抽出・人名判定の集約）、D-1（Hunter削除）。
- **Phase 2（P1・構造整理）**: E-1/E-3（案件分離）、F-1（monitor分離）、C-1（実験隔離）、A-1/A-2/A-3（コア重複統合）、D-3（CSV統一・sheets/gas削除）、G-1〜G-4・G-8（config/env削減）。
- **Phase 3（P2・仕上げ）**: B-3/B-4/B-5、C-2/C-3、D-2/D-4、E-2、G-5〜G-7、H-3/H-4/H-5、（合意の上で）H-6。

---

## 6. 概算削減効果

| 項目 | arufa版 | beta目標 | 削減 |
|------|---------|----------|------|
| src 実行ファイル | 80 | コア約22 + projects/monitor/experiments へ分離 | コア -70% |
| src 行数（コア） | 10,923 | 重複統合で約 -1,500〜2,000行 | 約 -15〜20% |
| npm script | 35+ | コア約8（残りは projects/monitor 側へ） | 約 -75% |
| 外部APIキー（必須） | 実質0だが分岐多数 | 0（全任意・分岐簡素化） | 認知負荷大幅減 |
| リポジトリ追跡物 | scrape-cache 1.4GB 等を含む | 生成物すべて除外 | 追跡サイズ大幅減 |

---

## 7. 未確定事項（要判断）

実装着手前に以下を確定したい（各要件の確定条件）:

1. **D-2 Gemini**: 「削除」か「既定OFFで残す」か（担当者名の精度許容ライン）。
2. **D-3 Sheets/GAS**: 完全削除してよいか（運用でスプレッドシート連携を使っているか）。
3. **D-4 nta / E-2 run1000 / B-5 enrich-targets**: 残す価値があるか（実運用頻度）。
4. **H-6 git履歴クリーニング**: 破壊的操作を許可するか。
5. **monitor / projects**: 同一リポジトリ内の `packages/`・`projects/` 分離でよいか、別リポジトリに切り出すか。
