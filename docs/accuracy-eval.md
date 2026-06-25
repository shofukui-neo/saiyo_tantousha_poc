# 精度評価ハーネス — 採用担当者名 / ICP適合

リファクタ・簡素化で **「今の精度」を絶対に落とさない** ための回帰安全装置。
オフライン（`data/scrape-cache` の実HTML＋`data/gbiz-records.json` の実レコード・決定論）で動くため、何度回しても同じ結果＝前後比較が成立する。

## 何を測るか

| トラック | 指標 | 意味 |
|---|---|---|
| 氏名/Wantedly | 抽出率 | 募集ページのうち氏名が取れた割合（recall代理・高いほど良） |
| 氏名/Wantedly | 辞書フルネーム率 | 取れた氏名のうち姓辞書で姓＋名解決できた割合（precision質・高いほど良） |
| 氏名/Wantedly | ゴミ率 | 非姓・非フルネーム・フラグメントの混入率（**0であるべき**） |
| 氏名/会社ページ | ゴミ件数 | 本文テキスト経路の誤抽出（**0であるべき**） |
| ICP適合 | スコア完全一致 | `discoveryIcpScore` は決定論。**1件でもスコアが動いたら退行** |

## ベースライン（凍結基準）

`eval/baseline.json`（arufa版・リファクタ前）。

| 指標 | 値 |
|---|---|
| 氏名 抽出率(Wantedly) | 81.27%（1219/1500p） |
| 辞書フルネーム率 | 99.92% |
| ゴミ率(Wantedly) | 0% |
| 会社ページ ゴミ件数 | 0件 |
| ICP平均スコア | 66.73（1002件） |

## コマンド

```bash
npm run eval            # 評価して指標表示（履歴・ダッシュボード更新）
npm run eval:baseline   # 現状を新しい基準として凍結（意図的に精度を更新したとき）
npm run eval:gate       # 基準と比較。精度が下がっていたら exit 1（回帰ゲート）
npm run eval:dashboard  # eval/dashboard.html を履歴から再生成
npm run test:accuracy   # 軽量な不変条件テスト（npm test 同様・高速）
```

オプション: `--names-limit N`（既定1500・0で全件）/ `--icp-limit N`（既定0=全件）/ `--label "..."`。

## リファクタの進め方（精度を落とさないループ）

1. **着手前**: `npm run eval:gate` が PASS なのを確認（基準＝現状）。
2. 1つの改善（重複統合・削除など）を入れる。
3. **直後**: `npm run eval:gate` を実行。
   - **PASS** → 精度維持。コミットして次へ。
   - **FAIL** → どの指標が下がったか判定欄に出る。直すか、改善を取り消す。
4. 意図的に挙動を変えた（例: 抽出器を改良して結果が変わった）場合のみ、
   レビューの上 `npm run eval:baseline` で基準を更新し、`--label` に理由を残す。

> ゲートは「悪化」だけを止める。中立・改善はPASS。よって安全にコードを削れる。

## ダッシュボード

`eval/dashboard.html`（自己完結HTML・外部依存なし）。最新値カード＋基準との差分、
PASS/FAILバッジ、主要指標のスパークライン、直近20実行の履歴表を表示。
ブラウザで開くだけ。`history.jsonl` の各実行から再生成される。

## 構成ファイル

- `src/eval/evaluate.js` — 指標算出のコア（純関数・決定論）
- `src/eval/cli.js` — 実行/基準固定/ゲート/ダッシュボードのCLI
- `src/eval/dashboard.js` — 履歴→HTML生成
- `test/accuracy.test.js` — 高速な不変条件テスト
- `eval/baseline.json`（追跡）/ `eval/history.jsonl`（追跡）/ `eval/dashboard.html`（追跡）/ `eval/latest.json`（無視）

## 注意

- 評価は `data/scrape-cache/` のローカルキャッシュに依存する（リポジトリには含めない方針）。
  キャッシュが無い環境ではゲートは走らないが、`baseline.json`・`history`・`dashboard.html` は成果物として残る。
- `discoveryIcpScore` の設立年加点は実行年に依存する。基準とゲートは近い時期に回す前提（年跨ぎ時は再ベースライン）。
