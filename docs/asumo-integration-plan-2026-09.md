# poc → ASUMO 第3次統合 計画書

> 作成日: 2026-09-24 ／ 対象: 前回統合（2026-08-17）以降に poc（saiyo_tantousha_poc）へ入った変更
> 差分範囲: `0af80457..eb2a6401`（23コミット・163ファイル・+52,117/−119行。src新規71・改修17／test新規15／docs新規16）
> 移植先: asumo（`projects/neocareer-sales/asumo`）
> 先行文書: [asumo-list-migration-plan.md](asumo-list-migration-plan.md)（第2次計画）／
> [asumo-list-migration-answers.md](asumo-list-migration-answers.md)／
> asumo `docs/リスト作成機能_移植_20260811.md`・`docs/リスト作成機構_移植第2次_確認事項_20260817.md`

---

## 0. 結論（5行）

1. **第2次計画（P0〜P6）のうち P0・P1 は asumo 側で完了している**。`lib/import-gate.ts`（取込の除外ゲート）と
   `lib/normalize.ts` の `companyNameLooseKey`（旧字体・長音・カナ・支店の吸収）＋ `byLoose` 索引が入っている。
   **P2（成果物側からの再突合監査）は未着手**、P3 は asumo 独自の形（候補→承認）で部分的に実装済み。
2. **今回の本丸は ICP コアの乖離**。「逐語移植・編集禁止」としていた `lib/icp/*.js` が
   asumo は **v3（2026-07）**、poc は **v5.1（2026-09-18）**。凍結の前提そのものが崩れている。
3. ただし **v5 の係数表は asumo 側が `lib/icp/local-calibration.ts` で独自に実装済みで、値は poc と一致**
   （接触19.6%×組織型1.67/0.84…／アポ4.68%×1.29/0.86／採用21名+×1.50／目盛り 0.05-0.15-0.44-3.0）。
   足りないのは **v5.1 の追加分（採用構成）とゲート群**であって、採点モデルの作り直しではない。
4. 新規クラスタは8つ（インテントS1〜S30／ATS判定／公式LINE／NGガード／ホットリード／合説スクレイプ／
   SFリード採点／リスト生成パイプライン）。**このうち Playwright 依存は1つも無い**＝Fly に載る。
   ただし3モジュールが cheerio に依存していて asumo は cheerio を持たない（`lib/fetchx/extract.ts` 側で書き直す）。
5. **全部は移さない**。asumo にはすでに差分シグナルエンジン（`lib/signals/*`・9トリガー）があり、
   poc の S1〜S30 と目的が重なる。丸ごと足すと「どちらが本当の優先順位か」が消える。§4 で線を引く。

---

## 1. 前回計画（P0〜P6）の現況 ── asumo の実装を読んで確認

| | 第2次計画の項目 | asumo の現状 | 判定 |
|---|---|---|---|
| P0 | `/list-import` に除外台帳ゲート | `lib/import-gate.ts` ＋ `list-import.impl.ts:470-594` で `buildProspectExclusionIndex`/`checkProspectExclusion` を通す。落とした行は `import_rows` に理由付きで残る。`tests/import-gate.test.ts` で凍結 | ✅ 完了 |
| P1 | 突合キーの表記ゆれ段 | `lib/normalize.ts` に `companyNameStrictKey` / `companyNameLooseKey`（旧字体辞書・`BRANCH_PLAIN`・カナ）、`CustomerIndex.byLoose`、`namesLookRelated` ガード | ✅ 完了（計画どおり tier5 は未搭載） |
| P2 | **成果物側からの再突合監査（audit-leak 相当）** | `scripts/import-audit.ts` はあるが**役割が違う**（取込原本と DB の件数照合）。「出来上がったリストを外からマスタ・除外台帳に当て直す」経路は無い | ❌ **未着手** |
| P3 | feeder 契約（担当者名の流し込み） | asumo 独自に「候補として積み、承認の瞬間だけ台帳へ入れる」動線を実装（`tests/prospect-contact-name.test.ts`）。**poc からの feeder 取込口は無い** | ⚠️ 半分 |
| P4 | 架電履歴からの再アプローチ層 | `lib/call-memo-infer.ts` に充足・中途・テンプレの規則あり。poc の充足規則8本／自社プロダクトガードとの突き合わせは未 | ⚠️ 半分 |
| P5 | 媒体カタログ入口 | `lib/prospect/sources.ts` は gbiz / search / nta の3エンジン。媒体入口は無し（`lib/media-kb` は提案資料用で別物） | ❌ 未着手 |
| P6 | BALES 266列エクスポート | 無し（`docs/BALESCLOUD併用_解決策_20260902.md` で別途整理） | ー |

**この表の含意**: 前回「最優先」とした2件はもう閉じている。今回の計画は
**「P2 を回収しつつ、ICP コアの乖離を解消し、新規8クラスタから asumo に無い価値だけを足す」**になる。

---

## 2. 最重要ギャップ ── ICP 採点コアの乖離

### 2-1. 事実

| ファイル | poc | asumo | 差 |
|---|---|---|---|
| `icp-rules.js` | 23,463B・v5（2026-08-31） | 6,828B・v3（2026-07） | diff 355行。**関数が4→13に増えている** |
| `mochica-fit.js` | 36,387B・v5.1 入口 | 30,458B・v4（6次元加重和が本線） | diff 182行 |
| v5 係数表 | `src/icp-score-v5.js`（新規205行） | `lib/icp/local-calibration.ts`（490行・2026-08-27） | **係数は一致**。実装場所と v5.1 分だけが違う |

poc 側で増えた `icp-rules.js` の関数と、asumo での有無:

| 関数 | 役割 | asumo |
|---|---|---|
| `classifyOrgType` | 公的・協同組合系／民間（v5 で両段に効く唯一の共通係数） | ✅ `lib/icp/org-type.ts` に TS 版あり（**要 golden 照合**） |
| `isGovernmentOrg` | 官公庁の3出口ブロック | ✅ `lib/gov-exclusion.ts`＋`tests/gov-exclusion.test.ts` |
| `isNegativeLiftIndustry` | 第1段の業種係数（負リフト群 ×0.83） | ⚠️ `local-calibration.ts` 内に相当ロジック（**関数として切り出されていない**） |
| `passesEntryFloor` | エントリー50名フロア（**未取得は通す**） | ❌ 無し |
| `classifyHiringMix` / `passesNewgradCentric` / `MIX` | 新卒中心／併用／中途中心の判定＋ゲート | ❌ 無し |
| `resolveIcpInputs` | 入力CSVが空の emp/hire を掲載面（マイナビ会社概要）で埋める | ❌ 無し |
| `qualifiesForList` | v5 のリスト掲載資格（担当者名＋電話＋新卒6＋従業員100＋非IT＋非官公庁、**採用人数不明は落とさずエンリッチ行き**） | ⚠️ v3 版（担当者名・電話・hire・emp・industry のみ） |

### 2-2. なぜ放置できないか

- asumo `lib/icp/index.ts` と `org-type.ts` のコメントは「lib/icp/*.js は poc からロジック不変で移植。編集禁止」
  と書いてある。**その前提が今は事実でない**。読んだ人が「凍結されているから安全」と判断して
  上流（poc）の変更に気づかない。ドキュメントの嘘は、コードのバグより見つかるのが遅い。
- `qualifiesForList` が v3 のままだと、asumo のリスト生成は
  **官公庁ブロックと採用構成ゲートを通っていない母集団**を出す。官公庁は `lib/gov-exclusion.ts` が
  別経路で塞いでいるので実害は出ていないが、**同じ判断が2か所にある**状態になっている。

### 2-3. 方針（R1 で実施）

**poc の `icp-rules.js` / `mochica-fit.js` / `icp-score-v5.js` を asumo へ逐語で入れ直す**。そのうえで:

- asumo 独自の `org-type.ts` / `gov-exclusion.ts` / `local-calibration.ts` は**消さずに残し、
  中身を `lib/icp/*.js` への薄い委譲に変える**。asumo 側のコメント（実測7,768架電での検証・
  なぜ組織型が効くか）は asumo 固有の資産なので、委譲先を指すだけにして保存する。
- 委譲に変える前に **golden 照合**を1回走らせる。asumo `customers` 全件を
  ①現行 `scoring.ts`（v3コア＋local-calibration）と ②新 `icp-score-v5.js` の両方で採点し、
  **点が動いた企業の一覧を出す**。動かない想定（係数が一致しているため）で、動いたら原因を特定してから進む。
- v5.1 の採用構成（×1.15/1.00/0.55/0.30）は **`ICP_V5_MIX` で切れる**ことを維持する。
  これは実測フィットではなく製品適合の仮説であり、他の係数と性質が違う。`factors.仮説` の分離も維持。

---

## 3. 新規クラスタ ── 何が増えたか・asumo に何が無いか

| # | クラスタ | poc の実体 | asumo の現状 | 移植価値 |
|---|---|---|---|---|
| **C1** | **ICP v5.1**（§2） | `icp-rules.js` / `icp-score-v5.js` / `mochica-fit.js` / `test/icp-v5.test.js` | v3コア＋独自v5較正層 | **最高**。全経路の並び順の根拠 |
| **C2** | **インテント S1〜S30** | `src/intent/` 10ファイル3,241行（signals / score / collect / face / failure / budget / opportunity / mix / store / target-fit）＋ `intent-analyze.js` | `lib/signals/*` の**差分エンジン9トリガー**（observed/inferred の分離あり）。半減期・トーク・S番号体系は無い | **高**（ただし全部ではない。§4） |
| **C3** | **ATS判定** | `ats.js`（ベンダー判定）/ `ats-detect.js`（未導入の動線6分類）/ `ats-scope.js`（**新卒か中途か**）/ `learn-ats-fingerprints.js`（自前指紋学習）/ `enrich-ats-all.js` / `build-ats-shinsotsu-list.js` | ATSは**ヒアリング項目**として持つだけ（`hearing-schema.ts`・`company-facts.ts`）。判定エンジンは無い | **高**。受注ドライバ実測1位が「他社ATS未導入」 |
| **C4** | **公式LINE判定** | `line-official.js`（URL証跡＋文言証跡・シェアボタン/LINE WORKS/英単語LINEの3誤検知を落とす）/ `probe-line.js` | `site-read.ts` 等に文字列がある程度。判定は無い | **中**。接続後お断り理由2位（445件・7.2%）のトーク分岐 |
| **C5** | **NGガード** | `ng-guard.js` / `ng-sync.js` / `ng-sweep.js`。`toCsv()` など出力の関所で無条件削除 | `list_exclusions` に NG 台帳はあり、`import-gate` / `promote` で判定 | **低〜中**。台帳はある。**出口側の関所が無い**ぶんだけ差がある |
| **C6** | **ホットリード** | `hot-signal.js`（テキスト＋差分の2系統）/ `harvest-signals.js`（PR TIMES）/ `signal-store.js` / `signal-audit.js` | 差分は `lib/signals` にあり。PR TIMES 等の外部出来事は**意図的に不採用**（`docs/インテントシグナル_リスト設計_20260820.md §4`） | **低**。asumo 側に不採用の判断が既にある |
| **C7** | **マイナビ合説スクレイプ** | `scrape-mynavi-event.js` ＋ `build-mynavi-event-book.js` ＋ skill。出展企業→電話/採用人数/従業員/メール/担当者 | 無し | **中**。新卒採用が構造的に保証された母集団＋担当者名 |
| **C8** | **SFリード採点／受注分析** | `score-sf-leads.js` / `research-mochica-customers.js` / `analyze-mochica-wins.js` | `lib/sf-exclusion.ts`・`jobs/sf-sync.ts`（除外同期のみ） | **低**。分析成果はすでに C1 の係数に織り込み済み |

**依存の実測**: C2〜C7 に **Playwright 依存は無い**（確認済み）。cheerio 依存は
`intent/collect.js`・`ats-detect.js`・`line-official.js` の3本のみ。第1次移植の
「DOMパーサを本番イメージに足さない」判断を維持するなら、この3本は `lib/fetchx/extract.ts`
（正規表現版・電話抽出で 5,156ページ中5,155一致の実績あり）の上で書き直す。

---

## 4. インテント層の線引き（C2）── ここが判断の要る唯一の場所

asumo はすでに「**属性ではなく出来事で探す**」という同じ結論に独立して到達していて、
`lib/signals/triggers.ts` に9トリガー（recruitFailed / ownerChanged / planExpanded / cycleStarted /
newInvestment / renewalWindow / thinHrTeam / toolFriendly / movement）を持つ。
poc の S1〜S30 を丸ごと足すと、**同じ企業に2つの優先順位が付く**。

### 移す（asumo に無い、かつ効く）

| 移すもの | 理由 |
|---|---|
| **半減期による減衰**（`intent/score.js`） | 「二次募集30日／採用数増120日」のように賞味期限が違う。asumo の `freshness()` は鮮度ラベルであって減衰ではない |
| **A/B/C/D の階層**（40/22/10点） | 架電オペレーションの入口。asumo の `/teleapo` の並びに直結する |
| **根拠テキストの引用義務** | asumo の observed/inferred と同じ思想。poc は引用文そのものを返すので**架電中に読める** |
| **失敗シグナル S22〜S25**（`failure-signals.js`） | 若者雇用促進法の開示欄（3年分の採用者数・離職者数・定着率）を読む。asumo の `recruitFailed` は差分由来で、**掲載面の開示数値は見ていない** |
| **資金シグナル／資金リスク S26〜S29**（`budget-signals.js`） | 加点と減点を**別方向に分けた**設計。「リスクが多いほど点が伸びる」を避ける。asumo に相当なし |
| **採用構成 S30**（`mix-signals.js`） | C1 の `classifyHiringMix` と同じ関数を使う＝ゲートと並び順が同じ定義 |
| **卒年面シグナル S17〜S21**（`face-signals.js`） | 27卒面と28卒面を同時に取ることで**履歴ゼロでも前年比が言える**。asumo の差分エンジンは1周待たないと言えない |

### 移さない

| 移さないもの | 理由 |
|---|---|
| `intent/store.js` の JSON 永続化 | `company_snapshots` が上位互換（`is_current` / `fail_count` / `last_checked_at` を持つ）。観測値はそちらへ合流させる |
| `intent/collect.js` の求人検索エンジン経路（jobs / midjobs） | DC-IP から静かに0件になる層（`search.js` の実例）。**Fly から数社 probe して poc と突き合わせてから**判断する |
| `harvest-signals.js`（PR TIMES） | asumo が調査のうえ不採用と判断済み。覆すなら先にその文書を更新する |
| S番号体系そのもの | asumo の `TriggerKind` に**マッピング表**を作って吸収する。番号を2系統持たない |

**合流のかたち**: poc の各シグナルを asumo の `TriggerKind` に写像する表を1枚作り
（`lib/signals/intent-map.ts`）、poc 側に無いトリガー種別だけ `TRIGGERS` に足す。
点は asumo 側の1本に統一する。

---

## 5. フェーズ計画

### R1 — ICP コアの再同期（v3 → v5.1）｜2〜3人日｜**最優先**

**やること**
1. poc `src/icp-rules.js` / `src/mochica-fit.js` / `src/icp-score-v5.js` を
   `lib/icp/` へ**逐語**コピー（移植注記のみ追記可）。
2. `lib/icp/index.ts` に v5 の型（`scoreV5` の戻り・`factors.仮説`・`hiringMix`）を追加。
3. `lib/icp/org-type.ts` / `lib/gov-exclusion.ts` / `lib/icp/local-calibration.ts` を
   **委譲に置き換える**。asumo 側の検証コメントは残す。
4. `lib/icp/from-customer.ts` に `resolveIcpInputs` の入力（掲載面の emp/hire）を配線。
   asumo 側のソースは `company_attributes` / `company_facts`。

**受け入れ条件**
- `tests/icp-v5.test.ts`（poc [test/icp-v5.test.js](../test/icp-v5.test.js) 相当）が通る。
- `tests/icp-fit.test.ts` / `tests/icp-local-calibration.test.ts` / `tests/gov-exclusion.test.ts` /
  `tests/icp-org-type.test.ts` が**無改変で通る**。通らない場合、落ちた項目ごとに
  「仕様が変わった／移植を間違えた」のどちらかを明記してから凍結値を更新する。
- **golden 照合**: `customers` 全件を新旧で採点し、差分レポートを出す。
  点が動いた企業が0でない場合、1社ずつ理由を説明できること。
- `ICP_V5_MIX=off` で v5.0 の点に戻る。

**先に決めること（ブロッカーではないが R1 の途中で判断が要る）**
- `passesEntryFloor`（エントリー50名）の入力を asumo のどこから取るか。
  現状 `エントリー` の文字列は `list-build.impl.ts` / `targeting.impl.ts` にあるが、
  ICP 入力としては配線されていない。**未取得は通す**フロアなので、取れないうちは常に通る＝安全。

---

### R2 — P2 の回収：成果物側からの再突合監査｜1人日

第2次計画から持ち越し。`scripts/list-audit.ts` ＋ `lib/jobs/audit.ts` への1チェック追加。

- 対象単位: `list_builds.build_id` / `import_batches.batch_id` / 任意CSV。
- 検出: ①マスタ被り（層別・**キー tier 別**）②自己重複 ③突合キー無し行 ④除外台帳ヒット。
- **silent drop を作らない**。落ちたものは必ず明細に出す。
- 被りが1件でもあれば exit≠0。

**なぜ R1 の直後か**: R1 で `qualifiesForList` が v5 になる＝**母集団の境界が動く**。
その差分を目で確認できる状態を先に作らないと、正しく効いたのか誤爆したのか判断できない。

**受け入れ条件**: `customers` 全件に1回流し、tier 別内訳が出る。検出ゼロでなければ明細を目視する。

---

### R3 — ATS判定エンジン（C3）｜3〜4人日

**やること**
1. `ats.js`（ベンダー判定）・`ats-detect.js`（未導入の動線6分類）・`ats-scope.js`（新卒/中途スコープ）を
   `lib/ats/` として移植。**cheerio 依存は `lib/fetchx/extract.ts` へ差し替え**。
2. 指紋辞書（`learn-ats-fingerprints.js` の出力）は**成果物だけ持ち込む**。
   学習そのものは BALES 22,892件のラベルが要るので poc 側に残す。辞書は JSON でバージョン付きに。
3. 観測は既存の `lib/jobs/prospect-observe.ts` に相乗り（新規ジョブを足さない）。
4. 結果は `company_attributes` に `ats_vendor` / `ats_scope` / `entry_type` / `ats_evidence` で保存。

**必ず一緒に移すもの（ここが本体）**: `ats-scope.js` の新卒証拠ゲート。
旧ロジック（ホスト検出＝導入済み）は適合率45.7%で、中途ATSを掴んで誤爆していた。
**確定行だけを出荷する**規律ごと移す。これを外すと架電が空振りする。

**受け入れ条件**
- `tests/ats-detect.test.ts` / `tests/ats-scope.test.ts`（poc の280行・151行相当）が通る。
- `data/ats-truth.csv` に対して `ats:eval` 相当を回し、poc と同じ適合率が出る。
- 「証拠が弱い行（確度0.6の本文文字列のみ）」が**確定として出ない**ことをテストで凍結。

---

### R4 — インテント層の合流（C2）｜4〜6人日

§4 の線引きに従う。**新エンジンを作るのではなく、既存 `lib/signals` を厚くする**。

1. `lib/signals/intent-map.ts` … poc の S番号 → asumo `TriggerKind` の写像表。
2. `lib/signals/decay.ts` … 半減期による減衰と A/B/C/D 階層（`intent/score.js` 相当）。
3. `lib/signals/failure.ts` / `budget.ts` / `face.ts` / `mix.ts` … 純関数を移植（ネットワーク非依存）。
4. 観測値は `company_snapshots` に合流。`intent/store.js` は移さない。
5. トーク文（`*_TALK`）は asumo の `triggerTalk` 系に載せる。

**受け入れ条件**
- `tests/intent-signals.test.ts` 系（poc 6ファイル相当）が通る。
- **否定文の打ち消し**（「二次募集は行っておりません」）がテストで凍結されている。
- 同じ企業に対して `lib/signals` の階層が1つだけ返る（2系統の優先順位が並ばない）。
- 資金リスクが**加点側に入っていない**ことをテストで凍結。

---

### R5 — 合説スクレイプの feeder 化（C7）＋ P3 の完成｜2〜3人日

第2次計画 P3 の feeder 契約をここで実装する。C7 は**その最初の供給元**にちょうどいい
（新卒採用が構造的に保証され、担当者名まで取れる）。

- poc 側: `mynavi:event` の出力を feeder CSV 契約（第2次計画 §P3 の列表）に揃える。
  **非人名語ゲート**（`isNonPersonWord`: 面接／任用／次長／験申込書）通過後の値だけを出す。
- asumo 側: `scripts/import-feeder.ts` → `prospect_candidates`（`source="feeder:mynavi-event"`）
  → **`promote.ts` の4条件をそのまま通す**。`/list-import` は使わない。
- 担当者名は asumo の既存動線（候補として積み、承認の瞬間だけ台帳へ）に乗せる。氏名は必ず人が1度見る。

**受け入れ条件**
- 同じ feeder CSV を2回取り込んでも `customers` が増えない（冪等）。
- 除外台帳に載る企業が feeder 経由で入らない（`tests/import-feeder.test.ts`）。
- `discovered_at` が必須で、`lib/jobs/freshness.ts` の対象に入る。

---

### R6 — 公式LINE判定（C4）｜1〜1.5人日｜任意

`line-official.js` を `lib/ats/` と同じ要領で移植（cheerio → `extract.ts`）。
**3つの誤検知落とし（シェアボタン／LINE WORKS／英単語LINE）を必ず一緒に移す**。ここが本体。
出力は `company_attributes.line_official` ＋ 用途（採用／販促）。
架電トークの分岐（持っている＝役割差で切り込む／持っていない＝LINEを主語にしない）を
`lib/signals` のトーク側に出す。

---

### R7 — NGガードの出口側（C5）｜0.5人日｜要判断

asumo は台帳も判定も持っているので、足りないのは**出口の関所**だけ。
CSV/シートを外に出す経路（架電リストのダウンロード・BALES 併用期間のエクスポート）に
`checkProspectExclusion` を最終ゲートとして1枚かける。

**ただし**: 第2次計画 §P6 で「エクスポータに判定を持たせない。監査は R2 に一本化する」と決めている。
R2 が入ったあとに、**本当に出口ゲートが要るのかを測ってから**決める。
poc が出口ガードを置いたのは CSV が正本だったからで、asumo は DB が正本である。

---

## 6. 着手順と工数

| 順 | フェーズ | 規模 | 前提 | 効果 |
|---|---|---|---|---|
| 1 | **R1 ICP コア再同期（v3→v5.1）** | 2〜3人日 | なし | 全経路の並び順の根拠が1本になる。**凍結の嘘を消す** |
| 2 | **R2 監査ゲート（P2の回収）** | 1人日 | R1 | R1 の効き方が目で見える。以後の全変更の安全網 |
| 3 | **R3 ATS判定** | 3〜4人日 | R1 | 受注ドライバ実測1位。母集団の質が変わる |
| 4 | **R4 インテント合流** | 4〜6人日 | R1・R2 | 「今週架電」の順番が根拠付きで決まる |
| 5 | R5 合説feeder＋P3完成 | 2〜3人日 | R2 | 名指し架電が成立する母集団の供給路 |
| 6 | R6 公式LINE | 1〜1.5人日 | R3 | 断り理由2位への事前分岐 |
| 7 | R7 NG出口ゲート | 0.5人日 | R2 後に要否判断 | ー |

**合計 13.5〜19人日**。**R1+R2+R3 の 6〜8人日で「v5.1 の順番で、ATS未導入が分かっているリスト」に到達する**。

※ 工数は poc 側の実装行数と asumo の既存構造からの見積もりで、実測ではない。

---

## 7. 正しさの担保（golden vector）

| 対象 | poc の凍結物 | asumo で通すもの |
|---|---|---|
| ICP v5 採点 | [test/icp-v5.test.js](../test/icp-v5.test.js)（128行） | `tests/icp-v5.test.ts`（新設） |
| ICP × 採用構成 | [test/intent-mix-icp.test.js](../test/intent-mix-icp.test.js)（178行） | 同上に同梱 |
| ATS 動線分類 | [test/ats-detect.test.js](../test/ats-detect.test.js)（280行） | `tests/ats-detect.test.ts` |
| ATS 新卒スコープ | [test/ats-scope.test.js](../test/ats-scope.test.js)（151行） | `tests/ats-scope.test.ts` |
| インテント S1〜S30 | `test/intent-*.test.js` 6本（約1,160行） | `tests/intent-*.test.ts` |
| 公式LINE | [test/line-official.test.js](../test/line-official.test.js)（181行） | `tests/line-official.test.ts` |
| 突合キー | [test/company-match.test.js](../test/company-match.test.js)（78チェック） | ✅ 実装済（P1） |
| 既存の凍結 | ー | `tests/{icp-fit,prospect-promote,import-gate,gov-exclusion,call-pipeline}.test.ts` が**無改変で通る** |

**規律**（第1次・第2次から引き継ぐ。今回1つ追加）:
1. `lib/icp/*.js` は編集しない。仕様を変えるときは poc と両方を変え、凍結値を更新する。
2. 純コアに I/O を足さない（時刻は引数注入）。
3. 閾値・重みは env / config に置き、コードへ直書きしない。
4. 新しいリスト作成経路を足すとき、除外集合を自分で組まない。`buildProspectExclusionIndex()` を呼ぶ。
5. **★新規**: 逐語移植した .js の**同期日と poc 側のコミットハッシュをファイル冒頭に書く**。
   今回の乖離（v3 のまま約2か月・「編集禁止」とだけ書いてあった）は、同期日が書かれていなかったことで
   誰も気づけなかった。`scripts/icp-sync-check.ts` でバイト数・関数名の一覧を突き合わせ、
   ズレたら `npm test` で落とす。

---

## 8. 移植しないもの（意図的な非目標）

| 対象 | 理由 |
|---|---|
| `harvest-signals.js`（PR TIMES 等の外部出来事） | asumo が調査のうえ不採用と判断済み（`docs/インテントシグナル_リスト設計_20260820.md §4`）。覆すなら先にその文書を更新する |
| `intent/store.js`（JSON 台帳） | `company_snapshots` が上位互換 |
| `learn-ats-fingerprints.js`（指紋の学習そのもの） | BALES 22,892件のラベルが要る。**辞書（成果物）だけ**持ち込む |
| `score-sf-leads.js` / `research-mochica-customers.js` / `analyze-mochica-wins.js` | 分析の成果は v5 の係数として C1 に織り込み済み。分析スクリプト自体は poc に残す |
| `intent/collect.js` の jobs / midjobs 経路 | DC-IP から静かに0件になる層。Fly から probe してから判断 |
| cheerio | 第1次移植の判断を維持。`lib/fetchx/extract.ts` で書き直す |
| poc の CSV 中間ファイル群 | DB が正本。中間CSVは feeder の受け渡しだけに限定 |

---

## 9. 未決事項・リスク

| # | 事項 | 影響 | 判断のタイミング |
|---|---|---|---|
| 1 | **R1 の golden 照合で点が動く可能性** | asumo の `local-calibration.ts` は係数が一致しているが、**入力の集め方**（`from-customer.ts`）が poc の `resolveIcpInputs` と違う。同じ企業に違う emp/hire が入れば点は動く | R1 の着手直後。差分レポートを出してから委譲に切り替える |
| 2 | **`ICP_V5_MIX` の既定値** | 採用構成 ×1.15/0.55 は**実測ではなく仮説**。asumo は本番で使うので、既定 on のまま入れるかは業務判断 | R1 完了時 |
| 3 | **ATS指紋辞書の鮮度** | ベンダーのホストは変わる。poc で学習し直したら asumo にも配る運用が要る | R3 の設計時。辞書にバージョンと生成日を持たせる |
| 4 | **インテントの二重優先順位** | 合流を誤ると `/teleapo` と `/targeting` が違う順番を出す | R4 の設計レビュー。「同じ企業に階層は1つ」をテストで凍結 |
| 5 | **合説スクレイプの規約** | `feeder:mynavi` は第2次計画でも「規約確認後」としていた。合説ページも同じ扱い | R5 着手前 |
| 6 | **`GBIZ_TOKEN` が本番未設定** | 第2次計画から未解決。gBiz 経路の評価自体ができない | R5 より前 |
| 7 | 卒年サイトの季節変動 | マイナビの氏名取得率は 27卒28.3% / 28卒4.8%。**成熟した卒年サイトを使う**を運用手順に明記 | R5 |

---

## 10. 実装後にやること

asumo 側に**実装記録**を残す（本書は計画、あちらは記録）。
`asumo/docs/リスト作成機構_移植第3次_<日付>.md` を新設し、`npm run docs:check` / `devlog:sync` を通す。
あわせて **§7 規律5**（同期日とコミットハッシュ）を `lib/icp/*.js` の冒頭に入れ、
`scripts/icp-sync-check.ts` を `npm test` に組み込む。これが入って初めて、
今回と同じ乖離（気づかないまま上流が2世代進む）が起きなくなる。
