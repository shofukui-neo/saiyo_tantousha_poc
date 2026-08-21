# gBizINFO 非依存 運用の詳細設計書

> 作成日: 2026-08-19 ／ 対象: poc（saiyo_tantousha_poc）の**リスト作成経路すべて** ＋ 移植先 asumo
> 関連: [asumo-list-migration-plan.md](asumo-list-migration-plan.md)（§7 リスク#1「`GBIZ_TOKEN` が本番未設定」への回答）、
> [dedupe-architecture.md](dedupe-architecture.md)、[architecture-overview.md](architecture-overview.md)、
> [rep-name-enrichment-runbook.md](rep-name-enrichment-runbook.md)

---

## 0. 結論（4行）

1. **動いている。** 本リポジトリの実行環境に `GBIZ_TOKEN` は設定されておらず、gBiz 生成物
   （`data/gbiz-records.json` / `gbiz-candidates.json`）も存在しない。それでも現行の納品経路
   （SF-fresh / 母集団課題 / 番号不備 / 新規ICP / マイナビ発掘）は**gBiz を1行も import していない**。
2. gBiz は「**あれば速い構造化発掘**」の任意アクセラレータであり、`gbizAvailable()` 1関数のゲートで
   全呼び出しが**例外を投げずに空を返して縮退**する設計になっている（[gbiz.js](../src/gbiz.js)）。
3. 縮退で本当に失うのは **①全国網羅の無差別母集団入口** と **②法人番号・代表者名・設立年の一括付与**。
   ①は媒体入口（27媒体）で代替し、②は NTA API ＋ 会社概要 hop で部分代替する。
   代表者名は納品仕様上そもそも捨てている（`--exclude-rep`）ので実害がない。
4. ただし **gBiz なし運用では「法人番号がほぼ無い」ことが前提になる**ため、名寄せは tier2〜4
   （社名／農協コア／表記ゆれ）だけで戦うことになる。＝移植計画の **P1（表記ゆれ突合）は
   「あると良い」ではなく前提条件**に格上げされる。ここが本設計の最重要点。

---

## 1. 検証 ── 何をもって「動いている」と言うか

| # | 検証項目 | 方法 | 結果 |
|---|---|---|---|
| V1 | トークンが無いこと | `node -e "require('dotenv').config(); console.log(process.env.GBIZ_TOKEN)"` | `""`（`.env` 自体が無い。`.env copy` にも GBIZ 行なし） |
| V2 | 発掘経路の実際の分岐 | [discovery.js:147](../src/discovery.js#L147) `gbizAvailable(c)` | false → `discoverViaSearch`（検索経路）へ |
| V3 | gBiz が1度も走っていないこと | `data/gbiz-records.json` / `gbiz-candidates.json` | **不在**（[build-gbiz.js](../src/build-gbiz.js) の必須出力） |
| V4 | 純ロジックの健全性 | `company-match` / `boshudan-needs` / `koso-signal` / `name-fusion` | 全て緑（78 checks / 19 cases / 9 passed / 7 件） |
| V5 | 除外マスタが実データで載ること | `company-match.test.js` 内の索引構築ログ | MOCHICA顧客 **430** / BALES既存 **23,152** / SFリード **86,674** |
| V6 | 現行納品経路の依存 | `grep gbiz src/build-{sf-fresh,boshudan,badnumber,new-icp,icp-fresh}-*.js` | **全て 0 件** |

> **注**: `data/leads-mochica-target-enriched.csv`（651社）だけは法人番号100%・代表者名88%を持つが、
> これは過去にトークンがあった期間の遺産（[rep-name-enrichment-runbook.md](rep-name-enrichment-runbook.md)）。
> 統合マスタ全体では法人番号 **1,329/28,137（4.7%）**・代表者名 **2,470（8.8%）** にとどまる。
> ＝ **gBiz 由来の属性はマスタの1割未満**であり、現在のリスト品質を支えている本体ではない。

---

## 2. 依存棚卸し ── 経路別の縮退マトリクス

`gbizAvailable()` の戻り値で挙動が3種類に分かれる。**どれも「落ちる」ことはなく、止まるか迂回するか**。

### 2.1 必須（トークン無しでは実行できない＝意図的に停止する）

| 実体 | npm script | 無トークン時の挙動 | 位置づけ |
|---|---|---|---|
| [build-gbiz.js](../src/build-gbiz.js) | **無し** | `GBIZ_TOKEN 未設定。中止。` → exit 1（[:101](../src/build-gbiz.js#L101)） | package.json に導線が無い＝運用から外れている |
| [build-fresh-list.js](../src/build-fresh-list.js) | **無し** | 同上（[:130](../src/build-fresh-list.js#L130)） | 同上 |
| [enrich-fresh-rep.js](../src/enrich-fresh-rep.js) | `icp:fresh:rep` | `実行不可` → exitCode 1（[:52](../src/enrich-fresh-rep.js#L52)） | 代表者名の後追い補完。納品仕様では捨てる列 |
| [harvest-named-plus.js](../src/harvest-named-plus.js) `--gbiz-first` | `names:gbiz` / `names:gbiz:live` | `gbizRepFallback` が null を返し、**web 経路のみで続行**（[:167](../src/harvest-named-plus.js#L167)） | 停止はしない。収量が落ちるだけ |

**設計上の意味**: 停止する3本はいずれも「gBiz そのものが目的」のツール。**リスト生成の本線には1本も入っていない。**

### 2.2 任意（自動で代替経路に切り替わる）

| 実体 | 切替点 | トークンありの経路 | トークン無しの経路 |
|---|---|---|---|
| [discovery.js](../src/discovery.js) | `discover()` [:147](../src/discovery.js#L147) | `discoverViaGbiz`（業種×地域の構造化検索） | `discoverViaSearch`（検索エンジン・API不要） |
| [pipeline.js](../src/pipeline.js) | `processCompany()` [:63](../src/pipeline.js#L63) | 法人番号→`gbizGet`で代表者名/HP/所在地を補完 | ステップを飛ばし、`discoverUrl` で公式URL特定へ |
| [app.js](../src/app.js) | `describeEngines()` [:66](../src/app.js#L66) | `発掘: gBizINFO（構造化）` と表示 | `発掘: Bing検索（API不要）` と表示 |
| [build-telapo-1000.js](../src/build-telapo-1000.js) | [:179](../src/build-telapo-1000.js#L179) | 目標未達分を gBiz で追い足し | 追い足し無しで既存母集団のみ |
| [build-koso-list.js](../src/build-koso-list.js) | [:208](../src/build-koso-list.js#L208) `--no-gbiz` | 高卒求人企業の属性を gBiz 補完 | 補完なしで出力（フラグで明示的に切れる） |

### 2.3 非依存（現在の主力・gBiz を import していない）

`sf:fresh` / `boshudan` / `badnumber` / `new-list` / `icp:fresh` / `mynavi:1000` / `bales:format:*` /
`dedupe` / `audit:leak` / `excl:show` / `ledger:*` / `telapo*` / `emails` / `enrich:recruitpage` /
`names:wantedly` / `harvest-all-media`

**＝ 直近3ヶ月に実際に納品したリストは、すべてこの群から出ている。**

---

## 3. gBiz が供給していた情報と、その代替（フィールド単位の詳細設計）

| フィールド | gBiz での取得 | 代替経路 | 実測充足率（無トークン時） | 採点への影響 |
|---|---|---|---|---|
| **法人番号** | `hojin-infos.corporate_number`（発掘と同時に100%） | [nta.js](../src/nta.js) 国税庁法人番号API v4（`NTA_APP_ID`・商号部分一致） | マスタ全体 4.7%。NTA も未設定なら 0% | 直接は無し。**名寄せ tier1 が使えなくなる**（→ §4.4） |
| **代表者名** | `representative_name` | web-crawl regex（[harvest-named-plus.js](../src/harvest-named-plus.js)）で 59%→**88%** | 88%（ただし納品では `--exclude-rep` で**捨てる**） | 無し（架電宛名は採用担当者名に一本化済み） |
| **従業員数** | `employee_number`（＋レンジ検索できる） | マイナビ会社概要の構造抽出（[scrape-mynavi.js:216](../src/scrape-mynavi.js#L216)） | **87.2%**（17,704/20,299） | `size` 重み **0.22**。満たされている |
| **公式URL** | `company_url` | [search.js](../src/search.js) `discoverUrl` ＋ 媒体からの外部リンク hop | 経路による（媒体 hop は 24〜33%） | `reach` の入口 |
| **電話番号** | 持たない | [phone.js](../src/phone.js) のサイト巡回抽出 | **98.3%**（19,954/20,299） | `reach` 重み **0.18**。gBiz では**そもそも埋まらない** |
| **都道府県 / 業種 / 設立年** | `location` / `business_items` / `date_of_establishment` | 会社概要 hop（`new-list` の enrich フェーズ） | enrich 済 651社で 都道府県100% / 業種91% / 設立年52.5% | `trust`（0.04）と業種除外ゲート |
| **新卒採用インテント** | **持たない** | 媒体掲載そのものが実取得シグナル | 媒体経由なら定義上100% | `intent` 重み **0.30**＝**最大**。ここは媒体入口が gBiz に勝つ |
| **補助金採択フラグ** | `source=4` の追加検索 | **代替なし（捨てる）** | 0% | `trust` 0.04 の一部。無視可能 |

**この表の要点**: MOCHICA のアポ期待値採点（[mochica-fit.js](../src/mochica-fit.js) の重み
`intent .30 / size .22 / reach .18 / funnel .16 / timing .10 / trust .04`）で、
**上位3次元のうち intent と reach（合計 0.48）は gBiz が原理的に供給できない情報**である
（intent は項目自体を持たず、reach の主材料である電話も持たない）。gBiz が単独で埋められるのは
size（0.22）だけ。gBiz の本質的価値は「**採点材料**」ではなく
「**全国の法人を機械的に列挙できる入口**」の一点にある。

---

## 4. gBizなし版アーキテクチャ ── 詳細設計

### 4.1 層構成

```
L0 除外・台帳層  exclusion-index.js（MOCHICA顧客430 / BALES 23,152 / SF 86,674 / 納品台帳1,601 / 既存母集団28,137）
        │  ※ 全経路がここを必ず経由する。除外集合を各ビルダーが自作しないことが唯一の規律
        ▼
L1 母集団入口   ┌ gBiz（任意・未設定なら不在）
   （発掘）     ├ 媒体カタログ 27媒体   … media-crawl.js / harvest-all-media.js   ← gBiz の代替本線
                ├ マイナビ卒年サイト     … scrape-mynavi.js（intent 最強・氏名も出る）
                ├ SF 全リード 86,674     … build-sf-fresh-list.js（発掘コスト0）
                └ BALES 履歴 22,892      … boshudan / badnumber（温かい再アプローチ層）
        ▼
L2 実観測層     polite.js / robots.js / fetch.js → phone.js（電話）／ probe-recruit-*.js（担当者名）
        │  ※「観測値のみを載せる。推定を入れない」
        ▼
L3 選別層       icp-rules.js: qualifiesForList（名+電話+新卒6名+従業員100-2000+非IT）
        ▼
L4 採点層       mochica-fit.js: scoreMochica（6次元・重み固定・env で上書き可）
        ▼
L5 出力・監査   format-bales.js（266列）／ delivered-ledger.js（台帳）／ audit-leak.js（成果物側から再突合）
```

**gBiz は L1 の中の1スロットにすぎない。** 縮退しても層は1つも欠けない。

### 4.2 発掘層の設計（gBiz スロットに何を差すか）

現状 [discovery.js](../src/discovery.js) の分岐は **gBiz か検索かの2択**でハードコードされている。
gBiz なしを常態とするなら、ここを**ソース・レジストリ**に一般化する。

```js
// src/discovery.js（改修案）
const SOURCES = [
  { id: 'gbiz',   available: (c) => gbizAvailable(c),        run: discoverViaGbiz   },
  { id: 'media',  available: (c) => c.MEDIA_CATALOG_ENABLED, run: discoverViaMedia  },  // ← 新設
  { id: 'mynavi', available: (c) => c.MYNAVI_ENABLED,        run: discoverViaMynavi },
  { id: 'search', available: () => true,                     run: discoverViaSearch },  // 最終フォールバック
];
// discover() は available な source を優先順に回し、target を満たすまで積む。
// 返り値は既存の候補オブジェクト契約を変えない:
//   { name, corporateNumber, domain, websiteUrl, representativeName,
//     prefecture, employees, industry, icpScore, source }
```

**`discoverViaMedia` の詳細設計**（新規・[media-crawl.js](../src/media-crawl.js) の上に薄く載せる）:

| 項目 | 仕様 | 根拠 |
|---|---|---|
| 入力カタログ | `data/media-catalog.json`（**106媒体**・全件 probe 較正済み） | 実測済み |
| 対象の絞り込み | `probe.companyLinks >= 10` かつ `probe.robots === 'allow'` かつ `strategy !== 'blocked-or-login'` | 該当 **27媒体**。robots allow は106中98、login wall 2、`blocked-or-login` 戦略 24 |
| 巡回 | `crawlMedia(media, maxPages)` → `classifyLink` で `company`（外部＝企業公式候補）だけ拾う | 純関数分類はテスト済み（[test/media-crawl.test.js](../test/media-crawl.test.js)） |
| 出力 | 候補オブジェクト（`source: 'media:<媒体名>'`・`websiteUrl` は確定・`employees` は null） | 属性は L2 で観測して埋める |
| やらないこと | JSレンダ／検索フォーム／外部ATSサブドメインの裏側 | 実測で母集団0。費用対効果が急落する裾野 |

`probe.nameLikely > 0` の媒体は **106中1**。＝「媒体ページから氏名を取る」のは例外的経路であり、
**媒体は母集団入口として使い、氏名は企業サイトへ hop して取る**のが正しい一般化
（[harvest-all-media.js](../src/harvest-all-media.js) が既にこの形で実装済み）。

### 4.3 モジュール契約（縮退の規律）

| 規律 | 実装 | 理由 |
|---|---|---|
| **アダプタは例外を投げない** | `gbizSearch` → `[]`、`gbizGet` → `null`、`gbizSubsidyNumbers` → 空Set | 呼び出し側に `if (token)` を書かせない。分岐点が増えると縮退時の経路が検証不能になる |
| **可用性は1関数に集約** | `gbizAvailable(c)` / `ntaAvailable(c)` | 「どの外部APIが点火しているか」を1箇所で答えられる（`describeEngines()` が画面表示に使う） |
| **設定注入は引数経由** | 全関数が第2引数 `c = cfg` を取る | テストで空トークンの config を差し込める |
| **縮退を画面に出す** | `app.js` の `describeEngines()` が毎回1行で出力 | 「なぜ母集団が増えないのか」を運用者が即答できる |

### 4.4 gBizなし前提で**必ず**成立させる不変条件

| # | 不変条件 | なぜ gBizなしだと重要になるか |
|---|---|---|
| **I1** | 名寄せは **tier2〜4（社名／農協コア／表記ゆれ）だけで成立する**こと | gBiz が無い＝法人番号がほぼ無い＝ **tier1（13桁完全一致）が事実上死ぬ**。マスタ110,426行の実測で、strict キーが分離していた同一法人が **848組(1.5%)**（旧字体30・長音字種76・カナ405・支店等327）。ここを吸収する段が無いと既存企業がすり抜ける |
| **I2** | すべての発掘経路が `buildExclusionIndex()` を経由すること | 経路が gBiz 1本から4本に増える＝除外集合を自作する誘惑が4倍になる。poc が納品物の80〜90%を既存企業にした原因はこれ |
| **I3** | 電話は**観測値のみ**（推定禁止） | gBiz は電話を持たないので、無トークン運用では電話は100%が自前観測。ここに推定が混じると `reach` 次元が嘘になる |
| **I4** | 落とした行は必ず明細に出す（silent drop 禁止） | 経路が増えるほど「なぜ消えたか」が追えなくなる。`<out>.excluded.csv` を全ビルダーの契約にする |
| **I5** | 従業員数は媒体の自己申告である前提で上限を弾く | gBiz は登記/届出ベース、媒体は自己申告。`EMP_MAX=2000` 超の弾き（[icp-rules.js](../src/icp-rules.js)）と >1000名ペナルティ（−20点）を必ず通す |

---

## 5. 層ごとの入出力仕様

| 層 | 入力 | 主要関数 | 出力 | gBiz縮退点 |
|---|---|---|---|---|
| L0 除外 | 4マスタCSV＋台帳 | `buildExclusionIndex({pool})` / `idx.matchDetail(row)` | `{matched,label,tier,master}` | **無し**（完全非依存） |
| L1 発掘 | ICP（業種×地域×規模） | `discover(icp, deps, opt, c)` | 候補オブジェクト配列＋`source` | `gbizAvailable()` false → media/mynavi/search |
| L2 観測 | 候補の社名 or URL | `discoverUrl` → `fetchPage` → `extractPhones` / `probeRecruitDeep` | 電話・担当者名・根拠URL | 代表者名の gBiz 直取りが飛ぶだけ |
| L3 選別 | 観測済みレコード | `qualifiesForList({contactName,phone,hire,emp,industry})` | `{pass, reasons[]}` | **無し** |
| L4 採点 | 属性つきレコード | `scoreMochica(rec)` | `{total, dims, priority, confidence, why, flags}` | `trust` の補助金加点が常に0になるだけ（重み0.04の一部） |
| L5 出力 | 選別済みリスト | `format-bales.js` → `delivered-ledger.record` → `audit-leak` | 266列CSV＋台帳＋監査結果 | **無し** |

---

## 6. asumo への適用

移植計画（[asumo-list-migration-plan.md](asumo-list-migration-plan.md)）は §7 リスク#1 で
「`GBIZ_TOKEN` 未設定のあいだ母集団が増えない」を未決事項に置いている。本設計はその回答である。

| 計画上の位置づけ | gBizなしを常態とした場合の改訂 |
|---|---|
| **P0 `/list-import` 除外ゲート**（0.5人日） | **変更なし**。むしろ入口が増えるので先に必須 |
| **P1 表記ゆれ突合**（1〜1.5人日） | **必須条件に格上げ**。gBiz が無い＝法人番号が無い＝ `findDuplicate` の強い軸（法人番号）が使えず、社名キー1本で 848組の表記ゆれを踏む（§4.4 I1） |
| **P2 監査ゲート**（1人日） | 変更なし |
| **P3 feeder（担当者名）**（2〜3人日） | **母集団入口を兼ねる**。poc を収穫ワーカーとして残す判断が、そのまま「gBiz の代わりに母集団を供給する経路」になる。＝ P3 完了時点で **gBiz 無しでもリストが回る** |
| **P5 媒体入口 27媒体**（3〜5人日） | **「任意」から「gBiz代替の本線」へ格上げ**。ただし着手前に **Fly の DC-IP から数媒体を probe し直す**（poc は手元PCからの較正値。検索系は IP で挙動が変わった実例がある） |
| `prospect-discover`（gBiz単一） | §4.2 のソース・レジストリ形に一般化し、`source` 列で入口を識別できるようにする（`media:<媒体名>` / `feeder:mynavi` / `icp` / `gbiz`） |
| 画面表示 | `describeEngines()` と同じ思想で「発掘: 媒体27 ／ gBiz: 未設定」を `/targeting` に常時表示する。**母集団が増えない理由が画面で完結すること** |

**結論**: asumo 側も **P0+P1+P2+P3（5〜7人日）で gBiz 非依存のまま「呼べる名指しリスト」が成立する**。
gBiz トークンは届いたら L1 にスロットを1つ足すだけで、他の層に一切変更が要らない。

---

## 7. 失うもの・リスクと緩和

| # | 失う能力 | 影響 | 緩和 | 判断 |
|---|---|---|---|---|
| R1 | 全国法人の無差別列挙（都道府県ラウンドロビン） | 母集団の**総量**が減る | 媒体入口は「新卒採用を実施中」に限定される＝**母数は小さいが intent が最強ティア**。ICP的にはむしろ濃い | **許容**。MOCHICA の勝ち筋は網羅ではなく intent |
| R2 | 法人番号の一括付与 | 名寄せ tier1 が死ぬ | P1 の表記ゆれ段（tier2〜4）／必要なら `NTA_APP_ID` を取得して [nta.js](../src/nta.js) を点火 | **要対応**（§4.4 I1） |
| R3 | 収量の季節依存 | マイナビ卒年サイトの氏名取得率は **27卒28.3% / 28卒4.8%** | 運用手順に「成熟した卒年サイトを使う」を明記。卒年切替期は媒体入口へ重心を移す | 運用で吸収 |
| R4 | 従業員数の出所が自己申告 | `size`（0.22）の信頼度が下がる | `EMP_MAX=2000` 超の弾き＋>1000名ペナルティ＋`confidence` に反映 | 実装済み |
| R5 | 補助金採択フラグ | `trust`（0.04）の一部が常に0 | なし（捨てる） | **無視** |
| R6 | 代表者名の一括付与 | 架電宛名の候補が減る | 納品では元々 `--exclude-rep` で捨てている。web-crawl で 88% まで取れる実績もある | 影響なし |

---

## 8. 受け入れ条件（「gBizなし」を仕様として凍結する）

1. `GBIZ_TOKEN=''` の環境で `npm run test:all` が緑（現在 4本を個別確認済み: company-match 78 checks /
   boshudan 19 cases / koso 9 / name-fusion 7）。
2. `test/discovery.test.js`（**新設**）で、`gbizAvailable()` が false のとき
   `discover()` が例外を投げず・空配列も返さず・`source !== 'gBizINFO'` の候補を返すことを固定する。
3. トークン必須の3本（`build-gbiz` / `build-fresh-list` / `icp:fresh:rep`）は
   **明示的に exit 1 する**現状を維持し、package.json の導線に載せない。
4. `npm run audit:leak` を gBizなし出力に対して流し、マスタ被り **0件**。
5. `npm run excl:show` が4マスタ（顧客430 / BALES 23,152 / SF 86,674 / 台帳1,601）を毎回ロードできること
   ＝どれか1つでも欠けたら**即座に停止**（マスタ欠落は「既存企業が新規として出る」に直結する）。

---

## 9. 運用手順

### 9.1 gBizなしの標準ワークフロー

```bash
npm run excl:show          # 0. 除外マスタが4層とも載っているか（毎回・欠けたら止める）
npm run new-list           # 1. 新規発掘（マイナビ卒年サイト → 選別 → enrich → BALES266列）
#   または
npm run sf:fresh           # 1'. SF 86,674リードから BALES未登録×非既存顧客を抜く（発掘コスト0）
npm run boshudan           # 1''. BALES履歴から「母集団課題」を語った企業を再アプローチ層として抽出
npm run audit:leak         # 2. 成果物側から再突合（被り1件でも exit≠0）
npm run ledger:record      # 3. 納品台帳に記録（次回以降の重複防止）
```

### 9.2 トークンが届いたら変わること（差分のみ）

| 変わる | 変わらない |
|---|---|
| `discover()` の source が `gBizINFO` になる | 候補オブジェクトの契約 |
| `build-gbiz` / `build-fresh-list` / `icp:fresh:rep` が実行可能になる | L0/L2/L3/L4/L5 のすべて |
| `pipeline.processCompany` が代表者名/HP/所在地を先に埋める | 除外索引・選別規則・採点重み・出力形式 |
| 母集団の総量が増える（intent は弱いティアのまま） | 納品物の列構成 |

**＝ `.env` に1行足すだけで切り替わる。コード変更は不要。** これが本設計の到達点。

---

## 付録: gBiz 参照箇所の全一覧

| ファイル | 行 | 種別 |
|---|---|---|
| [gbiz.js](../src/gbiz.js) | 全体 | アダプタ本体（`gbizAvailable` / `gbizSearch` / `gbizGet` / `gbizSubsidyNumbers`） |
| [config.js](../src/config.js) | 111-124 | 設定（`GBIZ_TOKEN` / `GBIZ_BASE` / `GBIZ_CORPORATE_TYPE` / フィルタ群） |
| [discovery.js](../src/discovery.js) | 9, 40-66, 147 | 発掘の分岐（**縮退の主戦場**） |
| [pipeline.js](../src/pipeline.js) | 14, 63-70 | 1社処理での属性補完 |
| [app.js](../src/app.js) | 21, 66 | 可用性の画面表示 |
| [build-gbiz.js](../src/build-gbiz.js) | 全体 | gBiz 専用ビルダー（**必須**・導線なし） |
| [build-fresh-list.js](../src/build-fresh-list.js) | 全体 | 同上（**必須**・導線なし） |
| [enrich-fresh-rep.js](../src/enrich-fresh-rep.js) | 15, 37-52 | 代表者名補完（**必須**） |
| [harvest-named-plus.js](../src/harvest-named-plus.js) | 45, 153-186, 223-233 | 代表者名フォールバック（任意） |
| [build-telapo-1000.js](../src/build-telapo-1000.js) | 179-200 | 目標未達分の追い足し（任意） |
| [build-koso-list.js](../src/build-koso-list.js) | 93-208 | 高卒リストの属性補完（`--no-gbiz` で明示的に切れる） |
