# アーカイブ: コールリスト整理（2026-06-21）

乱立していたコールリスト/中間生成物を本フォルダへ退避しました。
**運用の正リストは `poc/leads-mochica-target.csv` 1本のみ**です。

## 退避したファイル（13本）

| ファイル | 内容 | 役割 |
|---|---|---|
| leads-mochica.scored.csv | MOCHICA適合スコア済み1003社 | **target.csv の生成元**（`npm run mochica` で再生成可） |
| leads-telapo-1000.csv | 架電(電話)母集団1000社 | mochica の入力 (`--in`) |
| leads-daihyou-1000.csv | 代表者名つき1000社 | mochica の merge 入力 |
| leads-fresh-1000.csv | 上場除外・新規1000社 | 派生母集団 |
| leads-merged-unique.csv | 多系統マージ重複排除1489社 | 中間生成物 |
| leads.master.csv | build-list.js のマスタ出力 | 中間生成物 |
| leads-1000.csv / leads-1000.scored.csv | 旧1000社リスト/採点版 | 旧版 |
| leads.csv / leads.scored.csv | 初期サンプル | 旧版 |
| leads-telapo-smoke.csv | スモークテスト用 | テスト |
| companies.sample.csv / results.csv | サンプル/結果 | 旧版 |

> sources/・data/（gBiz・EDINET・Wantedly名簿・monitor等のパイプライン入力）は
> 退避していません。これらは正リスト再生成に必要なため温存しています。

## 正リスト `leads-mochica-target.csv` の作り方

`leads-mochica.scored.csv` を基盤に、`src/build-target-list.js` が以下を実施:

1. 採用担当者名を全名簿（Wantedly / cache / マイナビ / enrichment）から社名正規化キーで補完
2. 明確に軸外/人気業種（人材派遣・金融・銀行・商社・広告マスコミ・コンサル）を除外
3. 従業員100名以上に限定（空欄・100未満は除外）
4. 業種を MOCHICA セグメント定義（toC軸/不人気軸）で分類、ICPランク（A=300-1000）を付与
5. ICPランク → アポ期待度 の順でソート、新4列（ICPランク/セグメント区分/採用担当者名取得元/架電宛名）を追加

```
cd poc
npm run mochica        # ① leads-mochica.scored.csv を再生成（要 archive 復元 or 入力差し替え）
npm run target         # ② leads-mochica-target.csv を再生成
```

## 復元方法

`npm run mochica` 等の旧スクリプトは本フォルダ内の入力（leads-telapo-1000.csv 等）を参照します。
再生成する場合は必要ファイルを poc/ 直下へ戻してください:

```powershell
Copy-Item archive\call-lists-20260621\leads-telapo-1000.csv .
Copy-Item archive\call-lists-20260621\leads-daihyou-1000.csv .
Copy-Item archive\call-lists-20260621\leads-mochica.scored.csv .
```
