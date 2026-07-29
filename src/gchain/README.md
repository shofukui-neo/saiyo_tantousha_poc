# G-Chain OS v1.5 — 実装（`src/gchain/`）

MOCHICA テレアポ統合分析システムの**決定的コアロジック**を純CommonJSで実装したもの。
仕様は [`docs/g-chain-os-v1.5-baseline.md`](../../docs/g-chain-os-v1.5-baseline.md)（単一正本）と
[`docs/g-chain-os-v1.5-detailed-design.md`](../../docs/g-chain-os-v1.5-detailed-design.md)（詳細設計）。

## 設計方針

- **単一正本**: ロジックは `src/gchain/*.js` に1本化。GAS へは `build-gas.js` が同一ソースをバンドル（二重実装しない）。
- **純関数**: 全モジュール外部I/O無し・`now` は引数注入 → Node で単体テスト可能。GAS へ無改変で移植。
- **事実／派生の分離**: 18（事実の正本）→ 01（生成ビュー）を `event-engine` が再生成。派生を直接編集しない。
- **既存資産の再利用**: `normalize.js` は `src/csv.js` の `normCompanyName`/`normCorpNumber` 規則を共有（詳細§5.2）。

## モジュール（詳細設計 §12 対応）

| ファイル | 責務 | 主関数 |
|---|---|---|
| `schema.js` | 19シート物理列・語彙の単一正本（§3） | `SHEETS`, `physicalColumns`, `persistentSheetKeys` |
| `config.js` | 00_設定 既定値・版解決（§3.3） | `DEFAULTS`, `resolveSetting`, `seedRows` |
| `normalize.js` | 正規化・冪等キー（§5.1-5.2, §2.3） | `normPhone`, `normDatetime`, `rowHash`, `idempotencyKey`, `matchKey` |
| `canonical.js` | canonical統合（§5.3-5.4） | `dedupKey`, `dedupeObservations`, `assertCanonicalUnique` |
| `event-engine.js` | 4状態判定・E8時間解決・path（§4） | `resolveCall`, `resolveE8Call`, `buildPathPattern` |
| `sampling.js` | 二枠選定・official分母ゲート（§6） | `selectTranscripts`, `isOfficialEligible`, `metricCoverage` |
| `scoring.js` | Q合成・cap・共通項目法（§8.2） | `computeQ`, `applyCaps`, `commonItemMethod` |
| `kpi.js` | 分母規則・KPI集計（§9） | `officialDenominator`, `runKpi`, `heldRate`, `funnel` |
| `experiment.js` | 割付・マスク・ITT/PP（§10） | `assignArm`, `isMasked`, `decideExperiment` |
| `llm-contract.js` | 盲検・L1/L2バリデーション（§7） | `buildBlindPaste`, `validateL1Json`, `validateL2Json` |
| `meta.js` | M1..M5・回帰ゲート（§11） | `m1`, `weightedKappa`, `capReliability`, `regressionGate` |
| `prompts/LCS-1.5.0.md` | 通話分析プロンプト正本（§7） | — |
| `gas/orchestration.gs` | Sheets/Drive I/O・SYNC-0..6・再生成（§2） | `gcSetup`, `gcRunSync`, `gcRegenerateAll` |
| `build-gas.js` | GASバンドラ（require→GChain.*） | `build` |
| `index.js` | Node バレル | — |

## 使い方

```bash
# 単体テスト（74件・外部I/O無し）
npm run gchain:test

# GAS 配布物を生成 → apps-script/gchain-os.gs
npm run gchain:build
```

Node から:

```js
const { eventEngine, canonical, kpi } = require('./src/gchain');
const canon = canonical.dedupeObservations(rawObservations, { bucketSec: 30 });
const call = eventEngine.resolveCall({ call_id, event_observability, canonicalEvents, ... });
```

## GAS 配備

1. `npm run gchain:build` → `apps-script/gchain-os.gs` を生成（`GChain.*` バンドル＋オーケストレーション）。
2. 対象スプレッドシートの Apps Script に `gchain-os.gs` を貼付。
3. メニュー **G-Chain OS → 初期セットアップ** で19シート＋取込面を生成し 00_設定 を投入。
4. 日次: **二枠選定を提示** → 選ばれた通話のみ MiiTel を貼付 → **日次同期 SYNC-0..6**。

> `orchestration.gs` の `_extractFields` / `_appendObservations` / `_write01` 等の Sheets I/O は
> Wave 0 実データで列マッピングを確定してから実装（詳細 付録A・未決事項）。ロジック層は確定済み。

## テスト対応（受入テスト §15）

| テスト | カバー |
|---|---|
| `gchain-core.test.js` | schema/normalize/canonical/event-engine/sampling（AT-0/1/2 のロジック面） |
| `gchain-eval.test.js` | scoring/kpi/experiment（AT-5・KPI分母規則） |
| `gchain-llm-meta.test.js` | llm-contract/meta（AT-3・AT-Q・回帰ゲート） |
