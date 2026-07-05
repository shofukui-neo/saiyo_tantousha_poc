# 代表者名・採用担当者名 充足 ランブック（正リスト enrichment）

正リスト `data/leads-mochica-target.csv`（651社・法人番号/電話/URL 100%保有）の
**架電宛名（担当者名）を充足**するための再現手順と、到達可能な上限の記録。

## 到達可能な上限（実測・全セッション）

| 指標 | 開始 | 到達 | 手段 | 上限の性質 |
|---|---|---|---|---|
| **代表者名（架電宛名）** | 59% | **88%** | web-crawl regex | 残り12%はweb到達不能＋gBiz欠落の硬い末端 |
| **採用担当者名（個人）** | 0.5% | **8%** | 既存リスト突合＋採用ページregex | 工業系SMEの母集団天井（既存harvest突合込み） |
| 新卒フラグ | 23% | 25% | 採用ページの新卒言及判定 | 大半は本当に新卒採用せず |
| 設立年 | 52% | 53% | gBiz法人番号直取り | gBiz欠落と相関で埋まらず |

## 再現コマンド

### 1) 代表者名（最大の実務価値・59%→88%）
空代表者名×URL有の社に web-crawl（Gemini/gBiz不要・robots遵守・約70分/269社）:
```bash
# 空代表者名社を抽出して harvest-named-plus を回す
node src/harvest-named-plus.js --in <空代表者名社リスト.csv> \
  --out data/recruiter-rep-full.csv --live --no-search --no-gbiz --concurrency 3
```
- `--no-search`: 検索起点discoveryは環境により不安定なため無効化（公式HP深掘りに集中）
- `--no-gbiz`: gBizは既存59%と相関し空欄を埋めないため不使用
- 抽出は会社概要の「代表取締役社長 氏名」等を regex（肩書きチェーン・改行分離・2字姓境界に対応）

### 2) gBiz代表者名（代表者名カラムの無い**新規**リスト向け・~80%）
```bash
node src/harvest-named-plus.js --in <新規リスト.csv> --out <out.csv> --gbiz-first --concurrency 2
# npm run names:gbiz でも可。法人番号があれば gbizGet 直取り（ミスマッチ皆無）
```
※この正リストには不要（既存59%がgBiz由来で、空欄はgBizも欠落）。

### 3) 採用担当者名 — 最優先: 既存リスト突合（~8%・スクレイピング不要）
**リポジトリに採用担当者名つき企業が数千社ある**(leads-mochica-named-consolidated 1902/A-names-from-cache 1170/recruiter-scored-all 1112/recruiter-wantedly 1000等)。
正リストを非マイナビの既存名リストと `normCompanyName` 突合し、`canonName`＋`isPlausiblePersonName`＋姓連結/ふりがな除去で濾過して充填する。
→ **採用ページregex(2%)より既存資産突合(8%)が効く**。43社を新規スクレイピング無しで充填。
※源データ品質注意: recruiter-scored-all等の旧harvestに「Microsoft Teams」等ゴミ・ふりがな誤取り(柴田シバタ)・姓連結(佐々木八幡)混入→必ず濾過する。

### 3b) 採用担当者名 — 採用ページ直接regex（~2%・補完）
```bash
npm run enrich:recruitpage   # 採用ページURL保有285社を regex収穫（栗城/古城/坪井/小田/佐々木/安部真理子）
```
公開している社のみ。工業系SMEは母集団の壁で~2%。突合(3)＋採用ページ(3b)込みで実務上限~8%。

### 4) 再スコア＋新卒フラグ補完（架電優先度の更新）
- 新卒フラグ補完: `scratchpad/exp/enrich-shinsotsu.js`（採用ページの新卒言及で+16社）
- 再スコア: mochica-fit の scoreMochica を全件適用 → 後回し246→188（58社が架電可能ティアへ）

## 重要な技術的教訓（ハマりどころ）

1. **融合の3連鎖バグ（production を過小評価させていた真因）**
   - probeSiteDeep末尾のGeminiバッチ遅延 → company-timeoutでregex結果ごと破棄 → 内部12s timeout で解決
   - source '公式HP' が classifySource 未分類 → デフォルト低重み0.75で閾値割れ → weight0.95バケット追加
   - 稀姓（樫畑/長友）が weakSingle ペナルティ＋低確度で棄却 → 高信頼源(weight≥0.9)は免除＋REP確度0.7
   - → 空代表者名社への充足が 0%→72% に回復。isolated(融合前)とproduction(融合後)の乖離に注意。

2. **Gemini無料枠(RPM~20)が採用担当個人名の律速**：pingチェック1回すら枠を消費。429サイレント劣化を可視化＋短絡済み(gemini.js)。バッチ化(1社1呼出)実装済(有料枠なら効率的)。

3. **gBizは正リストの空欄を埋められない**：既存の代表者名/設立年はgBiz由来で、空欄=gBiz自体の欠落（相関）。gBizは新規リスト作成・クロス検証用。

4. **氏名抽出の誤検出ガード**（canonName）：役職語(社長/会長)・社名・動詞(就任)・業種語(医療)・肩書き断片(取締役bleed「加藤 文隆取」)を除去。2字姓(西井/山友)はページの空白境界を辞書分割より優先。異体字は正規化(田邉→田辺)。

## 精度検証（独立照合済み）
- 代表者名 3/3・採用担当者名 7/7 が会社概要/採用ページの実テキストに一致＝**氏名フィールドは信頼できる**。
- 複数担当は先頭1名を採用（架電宛名として妥当）。

## 最終成果物
`data/leads-mochica-target-enriched.csv`（原本非破壊）＝ 代表者名88% + 採用担当者名2% + 新卒フラグ補完 + 再スコア。
補助: `data/recruiter-rep-full.csv`（代表者名）・`data/recruiter-saiyo-tantou.csv`（採用担当者名）。

## 天井を破るには（リソース判断＝自律範囲外）
- **Wantedly併用**（実証98%）／**Gemini有料枠**（採用担当個人名を全社試行）／**IT・サービス系母集団**（採用担当名の公開率が高い）
