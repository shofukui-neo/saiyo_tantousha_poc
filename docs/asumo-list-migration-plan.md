# リスト作成機構 → ASUMO 移植計画書

> 作成日: 2026-08-17 ／ 対象: poc（saiyo_tantousha_poc）の**架電リストを作る層すべて**
> 移植先: asumo（`projects/neocareer-sales/asumo` / Next.js 16・React 19・Drizzle+SQLite・Fly shared-cpu-1x/1GB）
> 先行文書: asumo `docs/リスト作成機能_移植_20260811.md`（第1次移植の実装記録）、
> [dedupe-architecture.md](dedupe-architecture.md)、[architecture-overview.md](architecture-overview.md)、
> [asumo-migration-spec.md](asumo-migration-spec.md)（音声分析側の移植・完了済み）

---

## 0. 結論（4行）

1. **骨格はすでに移植されている。** 第1次移植（2026-08-11）＋「リスト再実装」（08-17）で、
   *発掘 → 実観測 → 選別（昇格）* の背骨・`lib/fetchx`（polite/robots/cache/extract）・
   ICP採点コア（`mochica-fit.js` / `icp-rules.js` を**逐語**）が asumo 上で動いている。
2. 残っているのは、poc で**品質を作り込んでいた4つの層**——
   ① 突合キーの表記ゆれ段 ② 採用担当者名（名指し架電）③ 成果物側からの監査ゲート ④ gBiz 以外の母集団入口。
3. **最優先は①**。純関数・小さい・全経路に効く。poc は同じ穴が原因で、納品物の 80〜90% が既存企業だった
   （[dedupe-architecture.md §0](dedupe-architecture.md)）。asumo は現在 strict キー1段で走っている。
4. **Playwright を Fly に載せない**という第1次移植の判断は維持する。poc を「収穫ワーカー」として残し、
   feeder 契約（`prospect_candidates` 経由・4条件ゲートを必ず通す）で asumo に流す。

---

## 1. 現在地 ── 実装を読んで確認した移植済み範囲

| poc の層 | poc 実体 | asumo での実体 | 状態 |
|---|---|---|---|
| 母集団ビルダー（gBiz） | [build-gbiz.js](../src/build-gbiz.js) | `lib/prospect/gbiz.ts` ＋ `discoverStep()`（都道府県ラウンドロビン・カーソル再開） | ✅ 移植済（上位互換） |
| 電話100%の担保 | [build-telapo-1000.js](../src/build-telapo-1000.js) | `lib/prospect/observe.ts` ＋ `promote.ts` 条件④「電話を観測できている」 | ✅ 移植済 |
| 取得基盤 | [polite.js](../src/polite.js) / [robots.js](../src/robots.js) / [fetch.js](../src/fetch.js) | `lib/fetchx/{polite,robots,cache}.ts`（＋総量上限200MB・LRU） | ✅ 移植済（上位互換） |
| 電話抽出 | [phone.js](../src/phone.js) | `lib/fetchx/extract.ts`（cheerio非依存・正規表現版） | ✅ 移植済＋**golden vector 検証済**<br>5,156ページ中 5,155一致・番号の不一致0 |
| 上場/NG/既存顧客の除外 | [exclusion-index.js](../src/exclusion-index.js) の一部 | `list_exclusions` ＋ `sf_exclusions` ＋ `mochica_accounts` を横断する `lib/prospect/exclusion.ts` | ⚠️ 層は揃ったが**キーが1段**（§2 G1） |
| ICP ハードルール | [icp-rules.js](../src/icp-rules.js) | `lib/icp/icp-rules.js` | ✅ **逐語移植**（編集禁止） |
| アポ期待値採点 | [mochica-fit.js](../src/mochica-fit.js) | `lib/icp/mochica-fit.js`（30,133B → 30,458B＝移植注記4行の差のみ） | ✅ **逐語移植**・`tests/icp-fit.test.ts` で凍結 |
| 名寄せ（重複判定） | [company-match.js](../src/company-match.js) | `lib/normalize.ts` の `findDuplicate`（K1〜K4）＋ `company_identity_keys` | ⚠️ 軸は多いが**表記ゆれ段が無い**（§2 G1） |
| 作業単位の管理 | 出力CSV＋納品台帳 | `list_builds` / `prospect_candidates.build_id` / `list_build_members` | ✅ 移植済（上位互換） |
| ダッシュボード | [dashboard.js](../src/dashboard.js) | `/targeting`「候補プール」タブ・`/list-build`・`job_runs.detail` | ✅ 移植済（上位互換） |

> **確認方法**: asumo `lib/prospect/build-run.ts`・`lib/prospect/{observe,promote,exclusion,repo}.ts`・
> `lib/list-build.ts`・`lib/db/schema.ts`（`prospect_candidates` / `list_builds` / `list_exclusions`）・
> `lib/icp/*` を実読。バイト数比較で採点コアの逐語性を確認。

---

## 2. ギャップ ── 何が残っているか

| # | ギャップ | asumo の現状 | 効いてくる場所 | 実測の根拠 |
|---|---|---|---|---|
| **G1** | **突合キーが strict 1段**。旧字体・長音の字種・カナ⇔かな・支店/拠点・農協別称を吸収しない | `companyNameKey` = `validate.normalizeCompanyName`（法人格/記号/空白除去・小文字化）の1段。K1〜K4・`list_exclusions.name_key`・`mochica_accounts.identity_key`・SF除外がすべてこの1本 | 除外台帳の**取りこぼし**（上場/NG/既存顧客/DNC へ架電）／昇格時の二重登録／取込時の統合漏れ | マスタ110,426行で、strictキーが分離していた同一法人の別表記が **848組(1.5%)**（旧字体30・長音字種76・カナ405・支店等327）。poc は再検証導入で出力 1,389→1,248（**約10%が被ったまま**渡っていた） |
| **G2** | **採用担当者名が空**。名指し架電が成立しない | 昇格時 `contactName` は空。`repName`（gBiz代表者名）は候補プールに保持のみ | ICP の到達性次元（重み0.18）が満点にならない。MOCHICA の刺さり方＝「採用担当者を名指し」なので実質のアポ率に直結 | 個人名が媒体ページ自体に出るのは **106媒体中1〜2**（マイナビ問合せ先・Wantedly投稿者）。マイナビ卒年サイトの氏名取得率は **27卒28.3% / 28卒4.8%**（季節で激変）。SME採用ページへ外部リンクする媒体経由の hop は **24〜33%** |
| **G3** | **成果物側からの監査ゲートが無い** | 昇格時（`promote.ts`）には判定するが、**出来上がったリストを外から再突合する経路が無い**。`/list-import` は `findDuplicate` は通すが**除外台帳を見ない** | ビルダーのバグ・列の取り違え・取込経路の穴は、ビルダー内の検査では原理的に見えない | poc はこのゲート（[audit-leak.js](../src/audit-leak.js)）で、納品済み40社中 **36社(90%)** が既存企業だったことを事後検出した |
| **G4** | **母集団の入口が gBiz 1本** | `prospect-discover` は gBizINFO のみ。`GBIZ_TOKEN` 未設定だと候補は1社も増えない | gBiz は「**新卒採用しているか**」を持たない → intent（重み0.30）が観測頼みの弱いティアに固定される。媒体入口なら「新卒募集中」が構造的に保証される | poc の `media-catalog.json` 110媒体を probe 較正済み。静的に企業外部リンクを出す媒体（にいがた型）だけが有効と実測で判明 |
| **G5** | **自社の架電履歴からの再アプローチ層が無い** | `recruit-needs.ts` / `call-loss.ts` / `call-memo-infer.ts` はあるが、「母集団課題を自ら語った企業を抽出して再架電リストにする」経路は無い | 発掘コスト0の**温かい層**。poc の実績は母集団課題741社・検討時期922件・番号不備1,477件 | poc [boshudan-needs.js](../src/boshudan-needs.js)・[build-badnumber-list.js](../src/build-badnumber-list.js)。判定は**純関数**（自由記述＋ピックリストの規則ベース） |
| **G6** | BALES 266列への納品エクスポートが無い | 無し | BALES 併用期間中のみ必要 | [format-bales.js](../src/format-bales.js) |

### G1 について、誇張しないための注記

asumo の `findDuplicate` は poc に無かった軸（**URL・ドメイン・電話**）を持つ。したがって
「asumo でも10%漏れる」とは言えない。正確には次の2点：

- **社名しか持たない相手**——`list_exclusions`（上場・NG・既存顧客）、`mochica_accounts`、SF除外——は
  **name key 一本での照合**なので、表記ゆれ段が無いぶんそのまま取りこぼす。上場企業や架電禁止先への
  架電は1件でも損失が桁違いなので、ここは**確率ではなく性質の問題**として塞ぐ。
- 昇格経路（gBiz）は法人番号を持つので二重登録は起きにくい。**取込経路（feeder / list-import）**は
  法人番号を持たない行が主なので、G1 の影響を最も強く受ける。G2 の feeder を開くなら G1 が先。

---

## 3. フェーズ計画

### P1 — 突合キーの表記ゆれ段を足す（最優先・1〜2人日）

**やること**: poc [company-match.js](../src/company-match.js) の純関数部（`stripAnnotations` / `stripBranch` /
`companyCore` / `looseKey` / `fuzzyKey`）を asumo `lib/match-keys.ts` として移植する。

**設計の要**（既存を壊さない形にする）:

- `companyNameKey` は**変えない**。既存の索引・`list_exclusions.name_key`・`mochica_accounts.identity_key`
  はこのキーで永続化済みで、変えるとマイグレーションが要る。
- 代わりに `matchKeysOf(rec) → { bango, name, core, loose, fuzzy }` を返す**追加キー層**を作り、
  索引側（`CustomerIndex` / `ProspectExclusionIndex`）に `byCore` / `byLoose` / `byFuzzy` を足す。
- 判定は上から順（法人番号 → 社名 → 農協 → 表記ゆれ → 長音ゆれ）。**当たった tier を必ず返す**。
- **`fuzzy`（長音ゆれ）は自動統合に使わない**。poc の実測で「ファミリー/ファミリ」のような別法人衝突を
  含む唯一の段。asumo の `DUP_CONFIDENCE` に合わせて **`weak`（候補どまり）**へ落とす。
  除外判定では当てる（保守的側に倒す＝`lib/prospect/exclusion.ts` の既定方針と一致）。
- 安全ガードは**必ず一緒に移す**: 農協の連合会/中央会は collapse しない／ホールディングス・HD は
  別法人として落とさない／1文字キーは作らない。

**受け入れ条件**:
- `tests/match-keys.test.ts` が poc [test/company-match.test.ts](../test/company-match.test.ts) の
  78チェック相当を通る（旧字体・カナ・拠点・連合会ガード・衝突監査）。
- `tests/prospect-exclusion.test.ts` に「`髙安株式会社` の台帳で `高安株式会社` が落ちる」
  「`能登わかば農業協同組合【JA能登わかば】` ⇔ `能登ワカバ農業協同組合`」を追加して緑。
- 既存の `tests/{prospect-promote,call-pipeline,icp-fit}.test.ts` が**無改変で通る**。

---

### P2 — 監査ゲート（成果物側からの再突合）（1人日）

**やること**: poc [audit-leak.js](../src/audit-leak.js) 相当を asumo に置く。

- `scripts/list-audit.ts`（CLI）＋ `lib/jobs/audit.ts` への1チェック追加。
- 対象単位: `list_builds.build_id` / `import_batches.batch_id` / 任意CSV。
- 検出: ① マスタ被り（層別・**tier別**の内訳）② 自己重複 ③ 突合キー無し行 ④ 除外台帳ヒット。
- **silent drop を作らない**——落ちたものは必ず明細に出す（poc が `<out>.excluded.csv` でやっていること）。
- 被りが1件でもあれば exit≠0（＝CI・納品前ゲートとして使える）。

**なぜ P1 の直後か**: P1 で新しい tier を入れた瞬間、「今まで通っていた行が落ちる／落ちなかった行が落ちる」が
起きる。その差分を**目で確認できる状態**を先に作らないと、正しく効いたのか誤爆したのか判断できない。

**受け入れ条件**: 現在の `customers` 全件に対して監査を1回流し、tier別の内訳が出る。
検出件数がゼロでない場合、明細CSVを目視して誤爆（特に `長音ゆれ` tier）が無いことを確認する。

---

### P3 — feeder 契約（採用担当者名の流し込み）（2〜3人日）

**やること**: poc を「収穫ワーカー」として残し、その成果物を asumo が**4条件ゲートを通して**取り込む口を作る。

```
[poc（手元PC・Playwright可）]
  mynavi:1000 / harvest-all-media / names:wantedly
        ↓  feeder CSV（下の契約）
[asumo] scripts/import-feeder.ts
        ↓  prospect_candidates（source="feeder:mynavi" 等）
        ↓  ★ promote.ts の4条件をそのまま通す（除外→名寄せ→ICP→電話）
     customers ＋ contacts（担当者名はここ）＋ company_identity_keys
```

**なぜ `/list-import` を使わないか**: 現在の `/list-import` は `findDuplicate` は通すが
**除外台帳（上場/NG/既存顧客/DNC）を見ずに `customers` へ直接書く**。判定は `promote.ts` の1か所だけが
持つ、という第1次移植の原則（実装記録 §0-2）を守るなら、feeder は候補プール経由にする。

**feeder CSV の契約**（poc 側の出力を1本に揃える）:

| 列 | 必須 | asumo での行き先 | 備考 |
|---|---|---|---|
| `企業名` | ● | `prospect_candidates.company_name` | 冪等鍵の材料 |
| `法人番号` | | `corporate_number` → 昇格時 `company_identity_keys(kind='corp_no')` | 空なら NTA API で補完可 |
| `公式URL` | | `url` | |
| `電話番号` | ● | `phone` | **観測値のみ**。推定を入れない |
| `採用担当者名` | ● | `contacts.display_name`（姓名分割は asumo 側） | **非人名語ゲート通過後の値だけ**を出すこと |
| `役職` / `部署` | | `contacts.title` / `contacts.dept` | 代表・社長・取締役系は poc 側で除外済み |
| `メール` | | `contact_channels(kind='email')` | |
| `従業員数` / `業種` / `都道府県` / `設立年` | | 同名列 | ICP採点の入力 |
| `採用予定人数` / `卒年` / `掲載媒体` | | `new_grad_signal` ＋ `company_attributes` | intent の最強ティアの根拠 |
| `取得元` / `根拠URL` / `取得日` | ● | `source` / `source_ref` / `discovered_at` | KPI帰属とトレーサビリティ |

**poc 側でやること（asumo に持ち込まない責任）**:
- **非人名語ゲート**（`isNonPersonWord`: 面接／任用／次長／験申込書 等の誤抽出）を通した値だけを出す。
  過去に成果物へ混入した実績があり、再スクレイプのたびに `remediate-recruiter-names.js` が必要だった層。
- 代表者名の担当欄への流用（`--exclude-rep` 相当）を除去済みにする。

**受け入れ条件**:
- 同じ feeder CSV を2回取り込んでも `customers` が増えない（冪等）。
- 除外台帳に載る企業が feeder 経由で `customers` に入らない（`tests/import-feeder.test.ts`）。
- 昇格した企業に `contacts` が1件付き、`/teleapo` で名指しの架電先として出る。

---

### P4 — 既存の架電履歴からの再アプローチ層（3〜4人日）

**やること**: poc [boshudan-needs.js](../src/boshudan-needs.js)（母集団課題ニーズの強/中判定・
充足/テンプレ/中途のガード付き）と [build-badnumber-list.js](../src/build-badnumber-list.js) の判定規則を
asumo の**自前データ**に対して回す。

- 入力は BALES ではなく asumo が持つもの: `call_logs` / `teleapo_call_logs` のコメント・
  `call_analysis` / `company_events` / `followups`。**BALES より入力が良い**（自分で書いた履歴なので
  列の意味が確定している）。
- 判定は純関数なので `lib/recruit-needs.ts` の隣に `lib/needs-signal.ts` として置ける。

**着手前に必ずやること**: asumo の `recruit-needs.ts` / `call-loss.ts` / `call-memo-infer.ts` と
**重複していないかを先に調べる**。同じことを2か所に書くと、どちらが正かが誰にも分からなくなる。
重なっていれば「poc の規則を既存モジュールへ足す」形にする。

**受け入れ条件**: 判定の強/中と根拠（引用）が画面に出る。ガード（充足・テンプレ文・中途採用の話）が
効いていることをテストで凍結する。

---

### P5 — 母集団の入口を増やす（媒体カタログ）（3〜5人日・任意）

**やること**: `data/media-catalog.json`（110媒体・probe較正済み）を asumo に持ち込み、
**静的に企業の外部リンクを出す媒体だけ**を企業母集団の入口として使う（poc [media-crawl.js](../src/media-crawl.js)
の `crawlMediaForCompanies` 相当）。

- 実装は `a[href]` の抽出だけで足りる ＝ **cheerio 不要**（第1次移植の「DOMパーサを本番イメージに足さない」
  判断と整合）。
- `prospect_candidates.source = "media:<媒体名>"` で積み、以降は既存の observe → promote に合流。
- **JS レンダ・検索フォーム・外部ATSサブドメインの裏にある媒体は対象外**（poc の実測で母集団0）。
  ここを頑張ると費用対効果が急落する長い裾野なので、最初から線を引く。

**なぜやる価値があるか**: gBiz 由来の候補は「新卒を採っているか」が分からない。媒体入口なら
掲載そのものが新卒採用の実取得シグナルになり、ICP の intent 次元（重み0.30）が**最強ティア**に乗る。

---

### P6 — BALES 266列エクスポート（0.5人日・必要になったら）

asumo が正本になるなら不要。BALES 併用期間中だけ、`scripts/export-bales.ts` として
[format-bales.js](../src/format-bales.js) の列マッピング（住所分解・規模ブラケット・姓名分割）を移す。
**ただし除外の最終ゲートは P2 の監査に一本化する**——poc では format-bales が最終ゲートを兼ねていたが、
asumo では判定を `promote.ts`、監査を P2 に分けてあるので、エクスポータに判定を持たせない。

---

## 4. 工数と着手順

| 順 | フェーズ | 規模 | 前提 | 効果 |
|---|---|---|---|---|
| 1 | **P1 表記ゆれ突合** | 1〜2人日 | なし | 全経路に効く。除外の取りこぼしを塞ぐ |
| 2 | **P2 監査ゲート** | 1人日 | P1 | P1 の効き方を目で確認できる。以後の全変更の安全網 |
| 3 | **P3 feeder（担当者名）** | 2〜3人日 | P1・P2 | 名指し架電が成立する＝アポ率に直結 |
| 4 | **P4 再アプローチ層** | 3〜4人日 | 重複調査 | 発掘コスト0の温かい層 |
| 5 | P5 媒体入口 | 3〜5人日 | P1〜P3 | intent 最強ティアの母集団 |
| 6 | P6 BALESエクスポート | 0.5人日 | 必要時 | 併用期間の橋渡し |

**合計 10〜16人日**（P5 まで）。P1+P2+P3 の **4〜6人日で「呼べる名指しリストが正しく作れる」状態**に到達する。

---

## 5. 正しさの担保（golden vector）

移植の正しさは「同じ入力から同じ出力が出るか」でしか確認できない。poc 側のテストが**そのまま契約**になる。

| 対象 | poc の凍結物 | asumo で通すもの |
|---|---|---|
| 突合キー（P1） | [test/company-match.test.ts](../test/company-match.test.ts)（78チェック） | `tests/match-keys.test.ts` |
| 電話抽出 | [src/phone.js](../src/phone.js) ＋ 取得キャッシュ5,156ページ | **検証済**（5,155一致・番号不一致0） |
| ICP採点 | [test/accuracy.test.ts](../test/accuracy.test.ts) 他 | `tests/icp-fit.test.ts`（既存・**落ちたら採点に手が入った合図**） |
| ニーズ判定（P4） | [test/boshudan-needs.test.ts](../test/boshudan-needs.test.ts) | `tests/needs-signal.test.ts` |
| 昇格の4条件 | —（asumo 固有） | `tests/prospect-promote.test.ts`（既存） |

**規律**（第1次移植から引き継ぐ）:
1. `lib/icp/*.js` は編集しない。仕様を変えるときは poc と両方を変え、凍結値を更新する。
2. 純コアに I/O を足さない（時刻は引数注入）。
3. 閾値・重みは env / config に置き、コードへ直書きしない。
4. 新しいリスト作成経路を足すとき、**除外集合を自分で組まない**。`buildProspectExclusionIndex()` を呼ぶ。
   （poc がこの規律を破って80〜90%の被りを出した。asumo で同じことを起こさない）

---

## 6. 移植しないもの（意図的な非目標）

| 対象 | 理由 |
|---|---|
| Playwright 依存の媒体実取得（マイナビ3パターン・Wantedly・地方媒体） | Fly shared-cpu-1x/1GB に Chromium は載らない。**poc に残し、feeder で流す**（P3） |
| DDG/Bing の HTML スクレイプ（[search.js](../src/search.js)） | DC-IP から静かに0件になる。公式API・検索APIに限定 |
| [quality.js](../src/quality.js) の汎用4次元採点 | `mochica-fit.js` が上位互換。2つの採点が並ぶと「どちらが正か」が消える |
| [merge.js](../src/merge.js) / [dashboard.js](../src/dashboard.js) / [deliver.js](../src/deliver.js) | asumo の `normalize.ts` ＋ `company_identity_keys` ／ `/targeting` ／ DB が上位互換 |
| 納品済み台帳（[delivered-ledger.js](../src/delivered-ledger.js)） | asumo では `customers` そのものが台帳。CSV納品という概念が無くなる |
| poc の CSV 中間ファイル群 | DB が正本になるので、中間CSVは feeder の受け渡しだけに限定する |

---

## 7. 未決事項・リスク

| # | 事項 | 影響 | 判断が要るタイミング |
|---|---|---|---|
| 1 | **`GBIZ_TOKEN` が本番未設定** | 未設定のあいだ `prospect-discover` は毎回スキップし、母集団は増えない（画面は理由を表示する） | P5 より前。これが無いと gBiz 経路の評価自体ができない |
| 2 | **P4 の重複** | `recruit-needs.ts` 等と機能が重なる可能性 | P4 着手前に調査（本計画に組み込み済み） |
| 3 | **`長音ゆれ` tier の誤爆** | 別法人を同一視して機会損失 | P1 実装時に `weak` へ落とす方針で回避。P2 の明細で毎回確認 |
| 4 | **feeder の鮮度** | poc の収穫は手元PC実行のため、asumo 側から「いつのデータか」が見えない | P3 で `discovered_at` 必須にし、`lib/jobs/freshness.ts` の対象に入れる |
| 5 | **担当者名の季節変動** | マイナビの氏名取得率は 27卒28.3% / 28卒4.8%。**卒年サイトの選び方で収量が6倍変わる** | P3 の運用手順に「成熟した卒年サイトを使う」を明記する |

---

## 8. 実装後にやること

第1次移植と同じ形で、asumo 側に**実装記録**を残す（本書は計画、あちらは記録）。
`asumo/docs/リスト作成機能_移植_20260811.md` に追記するか、`リスト作成機構_移植第2次_<日付>.md` を新設し、
`npm run docs:check` / `devlog:sync` を通す。
