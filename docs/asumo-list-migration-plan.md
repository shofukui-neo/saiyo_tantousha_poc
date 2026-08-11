# リスト作成機能 → asumo 移植計画書

> 対象: saiyo_tantousha_poc の「リスト作成」層一式 → asumo（`Desktop/new_asumo/asumo`, Next.js 16 / React 19 / Drizzle+better-sqlite3 / Fly nrt）
> 作成日: 2026-08-11
> 姉妹文書: [asumo-migration-spec.md](asumo-migration-spec.md)（G-Chain 音声分析の移植・別スコープ）／
> asumo側 [docs/icp-mochica-fit.md](../../../new_asumo/asumo/docs/icp-mochica-fit.md)（採点層は移植済み）

---

## 0. 結論（5行）

1. **採点層はすでに asumo にある。** `lib/icp/{mochica-fit,icp-rules,deps}.js` は poc からバイト単位で移植済み・golden vector 凍結済み。**今回移植するのはその手前＝「母集団を外から作る層」**。
2. **asumo の架電リストは現在“架空企業”で埋まっている。** `lib/jobs/prospect.ts`（`calllist-topup`・3時間毎・起動時実行）が `example.jp` のURLと連番生成の電話番号を持つ会社を作って積んでいる。**ここを実在企業の発掘に差し替えるのが本移植のゴール**。
3. **Fly shared-cpu-1x / 1GB / auto-suspend には Playwright を載せられない。** よって媒体実取得（マイナビ等）は poc 側バッチのまま残し、asumo には**静的取得(fetch+cheerio)と公式APIだけ**を載せる**ハイブリッド**を採る。
4. **DC-IP からの検索エンジンHTMLスクレイプ（DDG/Bing）は使わない。** 発掘は gBizINFO / 国税庁法人番号（公式API）と検索API（Google CSE/Brave/Serper・`koso-search.js` に実装済）へ寄せる。
5. **MVP** ＝ gBizINFO発掘 → 候補プール（customers を汚さない）→ 静的エンリッチ（電話・採用ページ）→ 既存の名寄せ/除外 → 既存のICP採点 → 合格分だけ customers へ昇格。**架空企業ジョブを停止できた時点で完了**。

---

## 1. 現状突き合わせ（何が既にあり、何が無いか）

| 層 | poc の実装 | asumo の現状 | 判定 |
|---|---|---|---|
| **① 母集団発掘** | `build-gbiz.js` / `build-fresh-list.js` / `discovery.js` / `search.js` / `mynavi-corpus.js` | **無し**（`prospect.ts` が架空企業を生成） | ★**最大の欠落。本移植の本体** |
| **② 実観測エンリッチ** | `build-telapo-1000.js`（HP巡回で電話100%）/ `scrape-media.js` / `enrich-recruitpage.js` | AI推定のみ（`jobs/enrich.ts` が Gemini に聞く） | **要移植**（推定と観測の分離） |
| **③ 担当者名ハーベスト** | `scrape-mynavi.js`（3パターン）/ `harvest-wantedly.js` / `harvest-all-media.js` | 無し | **poc残置**（Playwright依存） |
| **④ 名寄せ・重複排除** | `merge.js` / `consolidate-all.js` / `dedupe-approach.js` | **あり・上位互換**（`normalize.ts` K1〜K4 ＋ `company_identity_keys` の DB UNIQUE） | **asumo側を使う。移植不要** |
| **⑤ 除外** | `exclude-ng.js` / `listed-bango.json`(EDINET) / 既存顧客突合 | `sf_exclusions`（DNC・channel・期限・解除台帳つき）**上位互換**。ただし**上場除外・法人番号照合は無し** | **差分のみ移植** |
| **⑥ 採点** | `mochica-fit.js` / `icp-rules.js` | **移植済み**（`lib/icp/`・`tests/icp-fit.test.ts` で凍結） | **完了。触らない** |
| **⑦ 取込** | CSV読み書き | `list-import`（冪等・元行JSON保全・欠損0監査）**上位互換** | **asumo側を使う。feeder の受け口** |
| **⑧ 実行基盤** | 単発CLI＋ジャーナルで再開 | `lib/jobs/{harness,scheduler,registry}`（予算・AI上限・単一ライタ・`hasWork`・`deps`）**上位互換** | **asumo側に載せる** |
| **⑨ 出力/UI** | `dashboard.js` / `deliver.js` / `format-bales.js` | `/targeting` `/teleapo` `/companies` **上位互換** | **破棄**（CSV書出しのみ最小限で残す） |

### 1-1. 最重要の発見 — 架電リストが実在しない

`lib/jobs/prospect.ts:150-165` は次を生成して `customers` に積む：

```ts
const companyName = `${core}${suffix}`;              // "あさひ介護サービス株式会社" 等の合成
const phone = genPhone(seq);                          // 03-4821-6390（連番シードから算出）
url: `https://auto-${companyId.toLowerCase()}.example.jp`,
employeeCount: String(30 + (seq % 200)),             // 決定的な作り値
leadSource: AUTO_LEAD_SOURCE,                         // "自動生成リスト"
```

これが `runOnBoot: true` / 3時間間隔で未架電プールを常時100件に保つ。つまり**デモ用の骨格が本番ジョブとして回り続けている**。
poc のリスト作成を移植するというのは、実務上ここを置き換えることに等しい。移植完了の定義もここに置く（§9 P4）。

> 補足: `leadSource === "自動生成リスト"` で既存の合成行を機械的に隔離できる。移植時は削除ではなく
> `listStatus="棚卸し候補"` で退避し、実データ投入後に一括削除する（誤って実リードを消さないため）。

---

## 2. 制約と、そこから決まる設計判断

| 制約（実測・設定値） | 帰結する判断 |
|---|---|
| `fly.toml`: `shared-cpu-1x` / `memory 1gb` | **Playwright は不可**（Chromium 常駐で1GBを割る）。`scrape-base.js`/`scrape-mynavi.js`/`scrape-pages.js`/`fetch.js` のレンダリング経路は移植対象外 |
| `auto_stop_machines = "suspend"` / `min_machines_running = 0` | **長時間クロール不可**。1回50件・タイムアウト120秒のハーネス予算に載る**チャンク実行＋冪等トップアップ**へ書き換える |
| Fly の DC-IP から検索 | **DDG/Bing の HTMLスクレイプ（`search.js`）は封じられる前提**。発掘は公式API（gBizINFO・国税庁）と検索API（`koso-search.js`）へ寄せる |
| SQLite 単一ライタ | 発掘/エンリッチ系ジョブは `singleWriter: true`。取得(I/O)と書込を分離し、書込はバッチで短く |
| `DB_PATH=/data/data.db`（volume） | 取得キャッシュは**リポジトリ相対禁止**。`/data/scrape-cache` へ。TTL＋総量上限を必須化（poc は無制限） |
| `customers` に法人番号カラムが無い | 法人番号は `company_identity_keys`（`kind='corporateNumber'`, `confidence='strong'`）で持つ。poc の主キーである法人番号を捨てない |
| asumo は TS/ESM、poc は CommonJS JS | **純コアは icp と同じ作法**＝`.js` を verbatim コピー＋型付きバレル＋golden vector。**I/O層は TS で書き直す**（poc から移すのは仕様であってコードではない） |

### 2-1. ハイブリッド構成（Playwright をどう扱うか）

```
[poc（手元PC・Playwright可）]                    [asumo（Fly・静的のみ）]
 マイナビ corpus 列挙 / 3パターン担当者名 ──CSV──▶ list-import（既存・冪等・欠損0保証）
 Wantedly / 地方媒体ハーベスト                      │
                                                   ▼
                                    gBizINFO・国税庁・検索API・静的HP巡回
                                                   ▼
                                    候補プール → 除外 → 名寄せ → ICP採点 → customers
```

- **asumo に載せるのは「毎日自動で回り続ける必要がある層」**（発掘・電話/採用ページ観測・採点・昇格）。
- **poc に残すのは「たまに大量に走らせる層」**（媒体の全社列挙・担当者名ハーベスト）。既存の `list-import` が受け口なので新規配線は不要。
- 将来 Fly の VM を上げる（2GB以上）なら Playwright 経路を asumo へ移せるが、**MVP の前提には置かない**。

---

## 3. 移植分類表

| 区分 | poc ファイル | asumo での置き場 |
|---|---|---|
| **A. verbatim コピー（純関数・編集禁止）** | `phone.js` の判定部／`jp-names.js`（姓辞書）／`mynavi-name-extract.js`／`icp-rules.js`・`mochica-fit.js`（済） | `lib/prospect/*.js` ＋ 型付きバレル。`eslint.config.mjs` の globalIgnores に追加 |
| **B. TS で書き直し（仕様のみ移植）** | `polite.js`／`robots.js`／`gbiz.js`／`nta.js`／`koso-search.js`／`extract.js`／`recruiter.js`／`recruit-page.js`／`build-gbiz.js`／`build-telapo-1000.js`／`build-fresh-list.js` | `lib/fetchx/`（取得基盤）／`lib/prospect/`（発掘）／`lib/jobs/`（ジョブ） |
| **C. poc 残置（feeder）** | `scrape-base.js`／`scrape-mynavi.js`／`mynavi-corpus.js`／`harvest-*.js`／`scrape-pages.js` | 移植しない。CSV → asumo `list-import` |
| **D. 破棄（asumo が上位互換）** | `merge.js`／`consolidate-all.js`／`dedupe-approach.js`／`quality.js`／`dashboard.js`／`telapo-ui.js`／`deliver.js`／`master-io.js`／`csv.js` | — |

> **D の判断根拠**: 名寄せは asumo の `findDuplicate`（K1〜K4）＋`company_identity_keys` の DB UNIQUE のほうが強い（メモリ索引でなく型で守られる）。
> 品質採点も `jobs/{audit,freshness,accuracy}` が既に `qualityScore`/`qualityFlags`/`dedupOf` を書いている。poc の `quality.js`（4次元）は ICP採点と役割が重複するので持ち込まない。

---

## 4. データ設計（追加テーブル）

### 4-1. `prospect_candidates` — 候補プール（★中核）

**customers に直接入れないことが設計の肝。** 発掘は数万件規模で、未検証のまま営業マスタへ入れると
名寄せ・除外・採点の全部が汚れる（poc で「v1プールの19%がICP違反」だった教訓）。

```ts
// lib/db/schema.ts に追加
export const prospectCandidates = sqliteTable(
  "prospect_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 冪等鍵。法人番号があればそれ、無ければ companyNameKey(normalize.ts) */
    candidateKey: text("candidate_key").notNull().unique(),
    companyName: text("company_name").notNull(),
    corporateNumber: text("corporate_number"),      // gBiz/国税庁由来。customers に列が無いのでここで保持
    url: text("url"),
    phone: text("phone"),                            // 静的巡回で観測できたものだけ
    prefecture: text("prefecture"),
    industry: text("industry"),
    employeeCount: text("employee_count"),
    foundedYear: text("founded_year"),
    repName: text("rep_name"),                       // gBiz 代表者名（担当者名の代替到達手段）
    recruitPageUrl: text("recruit_page_url"),        // 静的巡回で見つけた採用ページ
    newGradSignal: text("new_grad_signal"),          // 新卒シグナルの根拠（文字列。無ければ null＝中立）

    /** 出所（KPI帰属の単位）。"gbiz" | "nta" | "search-api" | "feeder:mynavi" 等 */
    source: text("source").notNull(),
    sourceRef: text("source_ref"),                   // 発見元URL / 検索語（トレーサビリティ）
    discoveredAt: text("discovered_at").notNull(),
    enrichedAt: text("enriched_at"),

    /** new / excluded / dup / scored / promoted / rejected */
    status: text("status").notNull().default("new"),
    excludeReason: text("exclude_reason"),           // "上場" | "DNC" | "既存顧客" | "NG" | "IT絶対除外"
    dupOfCompanyId: text("dup_of_company_id"),       // findDuplicate が既存社に当てた場合

    // ICP採点の結果（lib/icp をそのまま使う。ロジックは書かない）
    icpTotal: integer("icp_total"),
    icpPriority: text("icp_priority"),
    icpConfidence: integer("icp_confidence"),
    icpWhy: text("icp_why"),

    promotedAt: text("promoted_at"),
    promotedCompanyId: text("promoted_company_id"),  // customers.company_id
  },
  (t) => ({
    byStatus: index("prospect_candidates_status").on(t.status, t.icpTotal),
    bySource: index("prospect_candidates_source").on(t.source),
  })
);
```

### 4-2. `list_exclusions` — 上場・NG（sf_exclusions で表現できない分だけ）

`sf_exclusions` は DNC/接触履歴の台帳で、**法人番号照合と「上場だから外す」を持てない**。差分だけ足す。

```ts
export const listExclusions = sqliteTable(
  "list_exclusions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),                    // "listed"(EDINET上場) | "ng"(アプローチ禁止) | "customer"(MOCHICA既存)
    corporateNumber: text("corporate_number"),
    nameKey: text("name_key"),                       // companyNameKey(normalize.ts)。旧社名も別行で展開
    note: text("note"),
    importedAt: text("imported_at").notNull(),
  },
  (t) => ({
    byBango: index("list_exclusions_bango").on(t.kind, t.corporateNumber),
    byName: index("list_exclusions_name").on(t.kind, t.nameKey),
  })
);
```

投入元: poc の `data/listed-bango.json`・`listed-names.json`・`data/ng-companies.txt`・MOCHICA既存顧客CSV
（`mochica_accounts` は既にあるので `kind="customer"` はそれを引く形でもよい）。

### 4-3. 取得キャッシュ

`/data/scrape-cache/<sha1(url)>.json`（TTL 7日・**総量上限 200MB・LRU 削除**）。
poc は無制限だったが、Fly の volume では容量事故になる。テーブルにはしない（単一ライタの書込圧を増やさないため）。

---

## 5. 実装モジュール（asumo 側の新規ファイル）

```
lib/fetchx/
  robots.ts        # robots.txt 取得・解析・判定（poc robots.js の仕様移植）
  polite.ts        # ★全Web取得の唯一の入口。robots遵守 + ホスト別直列化/最小間隔 + /data ディスクキャッシュ + 線形バックオフ
                   #   poc polite.js から Playwright 経路を落とし、fetch のみに縮退
  extract.ts       # cheerio による 電話 / 採用ページリンク / 会社属性 の抽出（poc extract.js・phone.js・recruit-page.js）
lib/prospect/
  gbiz.ts          # gBizINFO REST（検索/詳細）。700ms 直列スロットル・429 リトライは poc 実測値を踏襲
  nta.ts           # 国税庁法人番号API
  search-api.ts    # Google CSE / Brave / Serper（poc koso-search.js のプラガブル層）
  exclusion.ts     # list_exclusions + sf_exclusions + mochica_accounts を横断した除外判定
  promote.ts       # 候補 → customers 昇格（findDuplicate → identity keys → boardRows/boardSteps）
  names.js         # (verbatim) jp-names.js 姓辞書 + isPlausiblePersonName
lib/jobs/
  prospect-discover.ts   # 新規ジョブ: 発掘
  prospect-observe.ts    # 新規ジョブ: 静的エンリッチ（電話・採用ページ）
  prospect-promote.ts    # 新規ジョブ: 除外→採点→昇格
```

**`polite.ts` は例外なく全取得の入口にする。** poc で合法性・安定性を担保していたのはこの1点であり、
迂回する取得コードを1本でも書いた時点で設計が崩れる（robots無視・レート超過・キャッシュ無しが混入する）。

---

## 6. ジョブ設計（`lib/jobs/registry.ts` への追加）

| key | label | 間隔 | maxPerRun | deps | hasWork | 役割 |
|---|---|---|---|---|---|---|
| `prospect-discover` | 母集団発掘 | 6h | 200 | — | プール残が閾値未満か | gBiz/国税庁/検索APIで候補を `prospect_candidates` に追加（冪等・`candidateKey` UNIQUE） |
| `prospect-observe` | 候補の実観測 | 2h | 30 | `prospect-discover` | `status='new'` かつ `enrichedAt IS NULL` | HPを `polite` で巡回し**電話・採用ページ・新卒シグナル**を観測。取れた分だけ埋める |
| `prospect-promote` | 除外・採点・昇格 | 3h | 100 | `prospect-observe` | `enrichedAt IS NOT NULL` かつ `status IN ('new')` | 除外判定→`findDuplicate`→`scoreMochica`→合格分を customers へ |
| ~~`calllist-topup`~~ | 架電リスト自動補充 | — | — | — | — | **P4 で `prospect-promote` に置換して削除** |

設計上の約束：

- **1回の実行で完結させない。** すべて冪等トップアップ。suspend で途中終了しても次のティックが続きから進む（poc のジャーナル再開と同じ思想を、ハーネスの予算機構で実現する）。
- **AI は使わない。** 発掘・観測・採点はすべて決定的。`ctx.ai` は消費しない（`enrich.ts` の AI 推定とは責務を分ける）。
- **観測値と推定値を混ぜない。** `prospect-observe` が書くのは**観測できた事実だけ**。埋まらない項目は空のままにし、`enrich.ts` の AI 推定（`company_attributes` の `source="ai"`）とは別レイヤに置く。ここを混ぜると ICP の確信度が意味を失う。
- **昇格の条件**（`prospect-promote`）: 除外に当たらない ∧ `findDuplicate` が `fresh` ∧ `passesIcpFloor()` 通過 ∧ 電話が妥当。**満たさない候補は customers に入れない**（プールに残して理由を記録）。

---

## 7. UI

新規画面は作らない。既存に載せる。

| 画面 | 追加するもの |
|---|---|
| `/targeting` | 「候補プール」タブ: 発掘件数・除外内訳・昇格待ち・ICP分布。営業が「なぜこの会社が上がってこないか」を見られるようにする |
| `/settings`（ジョブ状態） | 新規3ジョブの最終実行・処理件数・`job_runs.detail`（`discovered` / `observed` / `phoneFound` / `excluded` / `promoted`） |
| `/companies` | `leadSource` に出所（`gbiz` 等）を出し、KPI帰属を追えるようにする |

CSV書出し（BALES納品形式）は `format-bales.js` の列定義だけを移し、`/targeting` のエクスポートに一本化する。

---

## 8. 正しさの担保（golden vector）

icp 移植で確立した作法をそのまま使う。

| テスト | 対象 | 凍結する内容 |
|---|---|---|
| `tests/prospect-extract.test.ts` | `lib/fetchx/extract.ts` | poc の実HTMLフィクスチャ（`data/scrape-cache` から数十件採取）→ 抽出結果（電話・採用ページURL）を `deepEqual` で凍結 |
| `tests/prospect-names.test.ts` | `lib/prospect/names.js` | poc `test/name-fusion.test.ts` の姓判定ケースを移送。**辞書外姓の救済と住所の却下**が両方通ること |
| `tests/prospect-exclusion.test.ts` | `lib/prospect/exclusion.ts` | 上場・NG・既存顧客・DNC の各1件が確実に落ちること。旧社名表記の展開も |
| `tests/prospect-promote.test.ts` | `lib/prospect/promote.ts` | 同一企業を2経路から流しても customers が1行であること（identity keys の UNIQUE が効く） |
| `tests/icp-fit.test.ts`（既存） | — | **変更しない。** 落ちたら移植が採点に手を入れた合図 |

---

## 9. フェーズ計画

### P0 — 契約と土台（1〜2日）
- [ ] `prospect_candidates` / `list_exclusions` を Drizzle に追加 → `npm run db:generate` → `db:migrate`
- [ ] `lib/fetchx/{robots,polite,extract}.ts` を実装（Playwright 経路なし・キャッシュは `/data`・総量上限つき）
- [ ] `tests/prospect-extract.test.ts` を poc の実HTMLフィクスチャで凍結
- **完了判定**: 任意の企業HPを1件 `politeGet` して電話が取れ、2回目がキャッシュヒットする

### P1 — 発掘（2〜3日）★本体
- [ ] `lib/prospect/{gbiz,nta,search-api}.ts`（429スロットル・キー未設定時は無効化して落ちない）
- [ ] `lib/jobs/prospect-discover.ts` ＋ registry 登録
- [ ] `GBIZ_TOKEN` 等を `.env.example` と `fly secrets` に追加
- **完了判定**: 1実行で実在企業200社が `prospect_candidates` に入り、再実行しても重複0

### P2 — 除外・昇格（2日）
- [ ] `list_exclusions` へ EDINET上場・NG・既存顧客を投入するスクリプト（`scripts/import-exclusions.ts`）
- [ ] `lib/prospect/{exclusion,promote}.ts` ＋ `lib/jobs/prospect-promote.ts`
- [ ] 既存 `findDuplicate` / `upsertIdentityKeys` を経由することを必須化（独自名寄せを書かない）
- **完了判定**: 上場企業・既存顧客・DNC がそれぞれ `excludeReason` つきで止まり、customers に1件も漏れない

### P3 — 実観測エンリッチ（2〜3日）
- [ ] `lib/jobs/prospect-observe.ts`（HP巡回 → 電話・採用ページ・新卒シグナル）
- [ ] `job_runs.detail` に `phoneFound` / `recruitPageFound` を記録（poc の「電話が取れた社だけ採用」を可視化）
- **完了判定**: 昇格した社の**電話番号充足率100%**（poc の telapo と同じ構造的保証）

### P4 — 架空企業の廃止（0.5日）★移植完了の定義
- [ ] `leadSource="自動生成リスト"` の既存行を `listStatus="棚卸し候補"` へ退避
- [ ] `calllist-topup` を registry から削除、`lib/jobs/prospect.ts` を削除
- [ ] `/targeting` に候補プールタブを追加
- **完了判定**: 架電プール100件が**すべて実在企業**で維持される

### P5 — feeder 接続（1日・任意）
- [ ] poc の担当者名ハーベスト出力（`data/leads-named-mochica-max.csv` 等）を `list-import` の列マッピングに合わせる
- [ ] 取込手順を `docs/operations-runbook.md` に追記
- **完了判定**: マイナビ由来の担当者名つきリードが asumo 上で名指し架電可能になる

**総見積: 8〜12日**（P0-P4 が必須で 7.5〜10.5日、P5 は任意）

---

## 10. リスク

| リスク | 影響 | 対応 |
|---|---|---|
| gBizINFO の 429 | 発掘が止まる | poc 実測の 700ms 直列＋過剰収集を踏襲。`maxPerRun` で1実行を短く切る |
| 検索API のコスト（CSE 無料100件/日） | 発掘深度が出ない | **発掘の主経路は gBiz にする**。検索APIは新卒シグナル確認の補助に限定 |
| Fly の egress から採用媒体へアクセスしてブロック | 観測が失敗 | `polite` の robots 遵守と間隔厳守。媒体直叩きは asumo に載せない（§2-1） |
| volume がキャッシュで満杯 | DB書込が失敗しうる | 総量上限＋LRU を P0 で最初から実装（後付けにしない） |
| 候補プールが customers を汚す | 営業マスタの信頼が落ちる | 昇格条件（除外なし∧fresh∧ICPフロア∧電話妥当）を `promote.ts` の1か所に集約し、他経路から customers へ書かない |
| 移植中に ICP採点へ手が入る | 較正が壊れる | `lib/icp/*.js` は編集禁止。`tests/icp-fit.test.ts` が落ちたら即差し戻し |
| 公開情報とはいえ企業情報の大量収集 | 法務・レピュテーション | robots遵守・公開ページのみ・認証回避なしを維持。取得元URLを `sourceRef` に必ず残す |

---

## 11. 移植しないもの（明示）

- **Playwright 依存の媒体実取得**（マイナビ3パターン・Wantedly・地方媒体）→ poc に残す（§2-1）
- **`search.js` の DDG/Bing HTMLスクレイプ** → DC-IP で機能しない前提。検索APIに置換
- **poc の名寄せ・品質採点・ダッシュボード・CSV納品パイプライン** → asumo が上位互換（§3-D）
- **`data/` の成果物CSV 73本** → 移植対象外。必要な分だけ `list-import` で取り込む

---

## 12. 着手前に確認したい2点（非ブロッキング）

1. **gBizINFO のトークンは asumo 本番（Fly）でも使えるか。** poc の `.env` にあるものを `fly secrets` に移すだけでよいか、法人単位の利用条件があるか。無ければ P1 は国税庁法人番号API主体に組み替える（代表者名・従業員数が落ちるぶん ICP の確信度は下がる）。
2. **架空企業（`leadSource="自動生成リスト"`）の既存行を最終的に削除してよいか。** 商談履歴や架電ログが紐づいている行があると単純削除できない。P4 では退避までに留め、削除は実データ投入後に別途判断する想定。

どちらも P0-P1 の着手は妨げない。
