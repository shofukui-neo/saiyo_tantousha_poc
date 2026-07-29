# G-Chain OS v1.5 詳細設計書
## MOCHICA テレアポ統合分析システム ―― 実装レベル仕様

> **位置づけ**：本書は [`g-chain-os-v1.5-baseline.md`](g-chain-os-v1.5-baseline.md)（BASELINE_FROZEN・単一正本）を親文書とし、その各節を**実装可能な粒度**に展開した従属文書である。
> **上下関係**：baselineの語と本書が矛盾した場合、常に baseline を優先する。本書の変更は baseline §15（BUGFIX／BLOCKER／候補ブランチ）の統制下に置く。
> **対象読者**：GAS実装者・LLMプロンプト実装者・受入テスト担当。
> **前提環境**：会社Google Workspace（Sheets ホット層／Drive コールド層／Apps Script）。外部API依存ゼロ。単独運用（`operator_id`・`actor_type` は固定値保持）。
> **表記規約**：列名は `snake_case`。状態値は `UPPER_SNAKE`。シート名は baseline のまま（`00_設定` 等）。★=evidence_grade（証拠専用・運用ステータスと別軸）。

---

## 目次

- 1. アーキテクチャ全体像
- 2. データフロー詳細（SYNC-0〜6 の実装仕様）
- 3. シート物理設計（列定義・型・制約）
- 4. Eイベント判定エンジン（18→01 再生成ロジック）
- 5. 名寄せ・冪等性・canonical統合アルゴリズム
- 6. 二枠サンプリング実装（METRIC / DIAGNOSTIC）
- 7. LLM I/O 契約（LCS-1.5.0 プロンプト）
- 8. 評価体系の計算仕様（O/Q/A/F/R）
- 9. KPI クエリ定義（分母規則の実装）
- 10. 実験マネージャ実装（プリレジ・マスク・ITT/PP）
- 11. M層メタ評価の実装
- 12. GAS モジュール／関数カタログ
- 13. エラー処理・冪等性・障害復旧
- 14. セキュリティ実装
- 15. 受入テスト実装対応表（AT トレーサビリティ）
- 16. 実装フェーズ計画

---

## 1. アーキテクチャ全体像

### 1.1 レイヤ構成

```
┌─────────────────────────────────────────────────────────────┐
│ 入力面（人手：1日1回コピペ）                                    │
│   BALES一覧 / SF活動・商談 / MiiTel文字起こし(二枠選定済み)      │
└───────────────┬─────────────────────────────────────────────┘
                │ 貼付
┌───────────────▼─────────────────────────────────────────────┐
│ 取込面（00_取込_BALES / _SF / _MiiTel）  ← 揮発・毎日クリア      │
│   row_hash / source_event_id / batch_id 付与                   │
└───────────────┬─────────────────────────────────────────────┘
                │ SYNC-4〜6（GAS自動）
┌───────────────▼─────────────────────────────────────────────┐
│ 正本層（事実）                                                  │
│   18_Eイベント明細（生観測を全保持・削除禁止・is_canonical）     │
│   02_通話コンテンツ（transcript）                              │
│   16_打診イベント / 17_ジャーニー                              │
└───────────────┬─────────────────────────────────────────────┘
                │ 生成ビュー（直接編集禁止）
┌───────────────▼─────────────────────────────────────────────┐
│ 派生層（診断・集計）                                            │
│   01_架電イベント（18からの再生成）/ 03_LCS診断 / 07_集計       │
│   04_次アクション / 05_実験 / 12_品質 / 13_監査 / 14_教師VIEW   │
└───────────────┬─────────────────────────────────────────────┘
                │ Drive保存
┌───────────────▼─────────────────────────────────────────────┐
│ コールド層（Drive・raw原本・制限フォルダ・編集禁止）             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 「事実／派生」の不可侵境界（baseline原則3・10の実装）

| 区分 | シート | 書込主体 | 直接編集 |
|---|---|---|---|
| **事実の正本** | 18・16・02 | SYNC＋LLM抽出＋手動訂正（監査付） | 手動訂正のみ許可（editor/timestamp/before-after必須） |
| **派生ビュー** | 01・07・14 | GAS再生成のみ | **禁止**（onEdit で保護＋警告） |
| **診断** | 03 | LLM＋人監査 | 監査フローのみ |
| **設定** | 00 | 人（版管理付） | valid_from 付き追記のみ |

実装：`01`・`07`・`14` は保護範囲（Protection API）を設定し、GAS サービスアカウント以外の編集を弾く。誤編集検知時は `12_データ品質` に `PROTECTED_SHEET_EDIT_ATTEMPT` を記録。

---

## 2. データフロー詳細（SYNC-0〜6 の実装仕様）

### 2.1 バッチ単位とトランザクション境界

- 1日次同期 = 1 `batch_id`（`YYYYMMDD-NNN`。同日再実行で NNN 増分）。
- SYNC は **前進のみ**（ロールバックせず、冪等キーで重複を吸収）。
- `batch_state ∈ {STARTED, INGESTED, NORMALIZED, GENERATED, SNAPSHOTTED, DONE, FAILED}` を `12_データ品質` に記録。

### 2.2 各ステップ詳細

| ステップ | 入力 | 処理 | 出力 | 失敗時 |
|---|---|---|---|---|
| SYNC-0 | 前batch状態 | 前回 `DONE` 未確認なら再開／新規採番 | `batch_id`, `batch_state=STARTED` | 前batch `FAILED` を検知→当日は前batch復旧を先行 |
| SYNC-1 | BALES貼付 | 取込_BALESに格納・`row_hash` | 取込_BALES rows | 列不一致→SYNC-5 で列プロファイル警告 |
| SYNC-2 | SF貼付 | 同上 | 取込_SF rows | 同上 |
| SYNC-3 | MiiTel貼付（二枠選定済み） | transcript を 02 へ・`transcript_selection_type` 保持 | 02 rows | 選定外貼付→`selection_type=UNSOLICITED` フラグ（率分母から除外） |
| SYNC-4 | 取込3面 | 列認識→型変換→`source_event_id` 生成→名寄せ（§5）→18へイベント抽出投入キュー化 | 18 生観測・16・02 | 型変換不能セル→`type_coerce_error` 行に隔離 |
| SYNC-5 | 18・取込面 | 件数一致・重複・名寄せ率・未知コード・`metric_coverage` 算出 | 12_データ品質 | 閾値割れ→WARN 表示（同期は継続） |
| SYNC-6 | 全rawスナップショット | Drive制限フォルダへ保存→取込面クリア→`batch_state=DONE` | Drive raw / クリア済取込面 | Drive書込失敗→`batch_state=FAILED`・取込面はクリアしない |

### 2.3 冪等性キー（baseline §5.1）

```
idempotency_key =
  primary:   source_system + source_event_id
  fallback:  row_hash( normalized_datetime + normalized_phone + call_sec + result )
```

- SYNC-4 は投入前に 18 の既存 `dedup_key` と突合し、既存なら **skip（増分ゼロ）**。
- 同一データ再貼付 → 全行 skip → `12` に `ingest_delta=0` を記録（AT-1 の再貼付増分0 検証点）。

---

## 3. シート物理設計（列定義・型・制約）

> 全シートに監査共通列を付与：`created_at`(datetime)・`created_by`(固定 operator_id)・`updated_at`・`schema_version`(="1.5")。以下は主要列のみ抜粋。列順は実装で固定し `00_設定.column_mapping` に定義。

### 3.1 `18_Eイベント明細`（★事実の正本・最重要）

| 列 | 型 | 制約 | 説明 |
|---|---|---|---|
| `event_id` | string(PK) | 一意 | `call_id + "-" + event_code + "-" + order` |
| `observation_id` | string | 一意 | 生観測ごとに1つ（複数源で複数行可） |
| `canonical_event_id` | string | FK→event_id | is_canonical 行を指す |
| `is_canonical` | bool | 非NULL | 集計対象は true のみ |
| `dedup_key` | string | index | `call_id + event_code + normalized_subtype + time_bucket` |
| `call_id` | string | FK→01 | 帰属通話 |
| `event_code` | enum | E0..E8 | |
| `event_order` | int | NULL許可 | 発生順（不明時 NULL） |
| `sequence_quality` | enum | exact/inferred/unknown | §5.4 |
| `occurred_at_sec` | int | NULL許可 | 通話内秒位置 |
| `turn_index` | int | NULL許可 | 発話ターン番号 |
| `subtype` | string | | e7_subtype 等（イベント別語彙は §3.9） |
| `info_class` | enum | business/timing/tool/decision | E4 のみ |
| `novelty` | enum | new/confirmed/contradicted | E4。contradicted→06 修正キュー起票 |
| `novelty_precision` | enum | DAY_LEVEL/EVENT_LEVEL | §5.5 |
| `disclosure_grade` | enum | a/b/c | E5。b以上でE5成立 |
| `value_type` | enum | problem/dissatisfaction/interest/future_condition/risk_awareness | E5 |
| `evidence_quote` | string | 非NULL(LLM抽出時) | 根拠引用（無ければ当該ラベル無効） |
| `speaker` | enum | agent/customer/reception/system | |
| `source_type` | enum | miitel_transcript/bales_note/bales_structured/sf/calendar/manual | 正規源優先順位に使用 |
| `extractor_version` | string | | LCS-1.5.0 等 |
| `label_confidence` | float | 0..1 | <0.60 は HOLD |
| `reviewed` | bool | | 人監査済 |

**不変条件**：
- 削除禁止（監査可能性）。訂正は新 `observation_id` を追加し旧を `is_canonical=false` に落とす。
- `is_canonical=true` は dedup_key ごとに **高々1行**（§5.6 の制約チェックで担保）。
- `evidence_quote IS NULL AND source_type='miitel_transcript'` の E3〜E5 行は無効（`reviewed=false` 固定・集計除外）。

### 3.2 `01_架電イベント`（18からの生成ビュー・直接編集禁止）

| 列 | 型 | 生成規則 |
|---|---|---|
| `call_id` | string(PK) | SYNC-4 採番 |
| `e0_state`..`e8_state` | enum{TRUE,FALSE,UNKNOWN,NOT_ELIGIBLE} | §4 判定エンジン |
| `max_event` | enum E0..E8 | TRUE の最大 event_code |
| `path_pattern` | string | is_canonical∧sequence_quality∈{exact, 高信頼inferred} のみ連結。不能時 `UNKNOWN_SEQUENCE` |
| `event_set` | string | `E3\|E4\|E6` 形式（順不同集合） |
| `purpose_planned` | enum | キュー由来（架電前確定・変更不可） |
| `purpose_resolved` | enum | L1抽出 |
| `purpose_changed` | bool | planned≠resolved |
| `analysis_level` | enum | L0/L1/L2 |
| `transcript_available` | bool | 02に本文あり |
| `event_observability` | enum | FULL/PARTIAL/NONE |
| `transcript_selection_type` | enum | METRIC_SAMPLE/DIAGNOSTIC_PRIORITY/BOTH/UNSOLICITED |
| `official_metric_eligible` | bool | `(observability=FULL) AND selection∈{METRIC_SAMPLE,BOTH}` |
| `event_required_for_purpose` | json | purposeテンプレ結合（イベント別 true/false） |
| `dialogue_continued` | bool | E3 実質発話≥2 |
| `journey_id` | string | FK→17 |
| `proposal_opportunity` | enum | yes/no/unclear |
| `nonpsych_cause_code` | enum | TECH_QUALITY/PERSONNEL_CHANGE/HIRING_FROZEN/POLICY_BLOCK/FORCE_MAJEURE/NULL |
| `script_version` | string | FK→11 |
| `experiment_tag` | string | FK→05（plannedのみ） |

**再生成規約**：`01` は 18 の is_canonical 行のみを入力に、GAS `regenerateCallEvents(call_id)` で全列再計算。18 に手動訂正が入ると当該 call_id を再生成キューに載せる（差分再生成）。

### 3.3 `00_設定`（key-value・版管理付）

| キー群 | 例キー | 値 | valid_from |
|---|---|---|---|
| サンプリング | `daily_transcript_cap` = 10 / `metric_sample_size` = 7 / `diagnostic_size` = 3 | int | ○ |
| 帰属窓 | `e8_attribution_days` = 30 | int | ○ |
| purposeテンプレ | `purpose_template.NEW_PROSPECTING` = {expected_path, success_def, required_events} | json | ○ |
| M仮閾値 | `min_practical_effect.E4_rate` = 5 / `.E7_rate` = 2 / `.Q_item` = 0.3 | float | ○（★仮） |
| モデルTier | `model.T1`=Opus4.8 / `.T2` / `.T3` / `.T4` | string | ○ |
| コード辞書 | `code.nonpsych_cause` = […] | list | ○ |
| 列マッピング | `column_mapping.BALES` = {...} | json | ○ |
| 盲検テンプレ | `blind_paste_template` | string | ○ |
| rubric版マップ | `rubric_version_map` = {item_id: version} | json | ○ |

**版管理**：値変更は行追記（旧行 `valid_until` を設定）。読取は `valid_from ≤ 参照日 < valid_until` の行。

### 3.4 `03_LCS診断`

| 列 | 型 | 制約 |
|---|---|---|
| `call_id` | string(PK/FK) | |
| `l_share`/`c_share`/`s_share` | 主因1・副因≤2 | 主因は3者いずれか1つ |
| `l_subclass` | enum | L-actionable / L-exogenous |
| `primary_gate_hypothesis` | enum | GK/G0/G1/G2/G3/G4 |
| `secondary_gate_hypothesis` | enum | 同上・NULL可 |
| `gate_confidence` | float | <0.60→`diagnosis_status=HOLD` |
| `alternative_nonpsychological_cause` | string | 必須（該当なしは "none" 明記） |
| `evidence_quotes` | json[] | 根拠引用。空なら診断無効 |
| `good` / `more` / `next_action` / `next_ng` | json | §8.3 構造 |
| `prompt_version` | string | LCS-1.5.0 |
| `diagnosis_status` | enum | ACTIVE/HOLD/REVISED |

### 3.5 `16_打診イベント`

`proposal_id`(PK) / `call_id`(FK) / `proposal_type`{material_send,callback,online_meeting,trial} / `proposal_form`{two_options,single_datetime,open_question,vague} / `proposal_order`(int) / `proposal_wording`(引用) / `customer_response`{accepted,conditional,deflected,declined} / `weak_close_candidate`(bool・★試用・M層対象)。

### 3.6 `17_ジャーニー`（GAS自動構成）

`journey_id`(PK=`uid + "-" + seq`) / `uid`(FK→06) / `journey_start`/`journey_end`(区切り: 硬拒否/クールダウン/年度替わり) / `call_ids`(json[]) / `e7_events`(json[]) / `e8_events`(json[]) / `originating_call_id`(各E7の帰属通話) / `journey_outcome`(教師ラベル区画専用)。

### 3.7 `05_実験管理`

`exp_id`(PK) / `type`{SCRIPT,RUBRIC_INTERVENTION} / `hypothesis` / `single_variable` / `assignment_rule`(hash固定) / `primary_metric` / `secondary_metrics`(json[]) / `safety_metrics`(json[]) / `n_target`(Wave1ベースライン算出) / `fidelity_target` / `decision_date` / `stop_condition` / `other_changes` / `comparison_condition` / `mask_until`(=decision_date) / `evidence_grade`★。

### 3.8 `14_教師データVIEW`（二区画・直接編集禁止）

| 区画 | 列群 | 制約 |
|---|---|---|
| feature_available_at_call | e{n}_state・subtype・Qサブスコア・診断特徴 | **call_at 以前の情報のみ**（未来情報混入禁止・baseline原則8） |
| posthoc_label | outcome・journey_outcome・label_available_at | `label_available_at` 必須（時点固定） |

生成時に `feature` 区画の各列について「その値が call_at 時点で確定していたか」を検証（`novelty_precision` 参照）。違反列は `LEAKAGE_SUSPECT` フラグ。

### 3.9 イベント別 subtype 語彙（`00_設定.code` に定義）

| event_code | subtype 語彙 |
|---|---|
| E4 | info_class = business/timing/tool/decision |
| E5 | value_type = problem/dissatisfaction/interest/future_condition/risk_awareness |
| E7 | meeting_confirmed(4)/tentative_booking(3)/agreed_callback_datetime(2)/agreed_followup_date(2)/vague_permission_to_call(1)/unilateral_callback(0) |
| E8 | next_step_outcome = held/valid_reply/opportunity_created/rescheduled/cancelled/no_show/pending |

---

## 4. Eイベント判定エンジン（18→01 再生成ロジック）

### 4.1 状態決定関数 `resolveEventState(call_id, event_code)`

擬似コード（baseline §2.1・2.2・2.6 準拠）：

```
function resolveEventState(call, e):
    # 1. 論理的前提（NOT_ELIGIBLE）— purpose は根拠にしない
    if not logicalPrerequisiteMet(call, e):        # 表 §2.2
        return NOT_ELIGIBLE

    # 2. observability
    obs = call.event_observability                 # FULL/PARTIAL/NONE
    canonicalTrue = existsCanonical(call, e, TRUE)  # 18 の is_canonical=true 行

    if canonicalTrue:
        return TRUE
    # 3. FALSE は「観測可能だったのに発生せず」のときのみ
    if obs == FULL and observableFor(e, obs):
        return FALSE
    # 4. それ以外は判定不能
    return UNKNOWN
```

**E8 の特則**（§2.6・時間依存）：

```
function resolveE8(e7):
    o = e7.next_step_outcome
    if o in {held, valid_reply, opportunity_created}: return TRUE
    if o in {rescheduled, cancelled, no_show}:        return FALSE
    if o == pending:
        return UNKNOWN if withinWindow(e7, e8_attribution_days) else FALSE
```

`rescheduled` は旧E7に outcome を記録し、新E7を `next_step_disposition=created`・帰属窓リセットで **別行** 生成（2行方式）。

### 4.2 `event_required_for_purpose` の結合（§2.2）

`purpose_planned` の `00_設定.purpose_template.required_events` を各 event_code に結合。`E4_state=TRUE ∧ required=false` は **正常**（フラグを立てない）。率計算とは独立列。

### 4.3 path_pattern 生成（§5.4）

```
if all(is_canonical) and all(seq in {exact, inferred_high}):
    path_pattern = join(sorted_by_order(canonical_true_events), ">")
else:
    path_pattern = "UNKNOWN_SEQUENCE"
event_set = "|".join(sorted(distinct(canonical_true_event_codes)))
```

偽の経路（例: `E7>E7`）は is_canonical 単一化で構造的に発生しない（§5.6）。

### 4.4 max_event

`max_event = max(event_code where state==TRUE)`（TRUE のみ）。UNKNOWN/FALSE/NOT_ELIGIBLE は max に寄与しない。

---

## 5. 名寄せ・冪等性・canonical統合アルゴリズム

### 5.1 名寄せカスケード（baseline §5.2）

```
1. 法人番号 完全一致                         → uid確定
2. 正規化電話番号 一致                        → uid確定
3. 企業名正規化（法人格除去・全半角統一・支店語正規化）+ 類似度≥θ  → 候補
4. ドメイン一致                              → 候補
5. 手動確定（M9-99 例外キュー）→ 確定 → ルール昇格
```

`match_rate` を `12_データ品質` に記録（AT-1 ≥95% 検証点）。uid 昇格時は既存行を新uidへマイグレーション（`uid_migration_log`）。

### 5.2 正規化関数群

| 関数 | 規則 |
|---|---|
| `normPhone` | 数字抽出・国番号正規化・ハイフン除去 |
| `normCompanyName` | 株式会社/(株)/㈱ 等の法人格を除去・全半角統一・「支店/支社/営業所」語正規化。既存 [[ng-company-exclusion]] の normCompanyName と同一規則を共有 |
| `normDatetime` | JST・秒精度・ISO8601 |

### 5.3 canonical統合（baseline §5.3・最重要）

複数源（MiiTel/BALES/SF/Calendar）から同一イベントが観測されうる。全生観測を 18 に保持したうえで正規化：

```
dedup_key = call_id + event_code + normalized_subtype + time_bucket

group by dedup_key:
    winner = argmax over source priority:
        E3..E6: miitel_transcript > bales_note
        E7:     sf/calendar > bales_structured > transcript > bales_note
        E8:     sf > calendar > bales_note
    winner.is_canonical = true; canonical_event_id = winner.event_id
    others.is_canonical = false; others.canonical_event_id = winner.event_id
    manual_correction は常に最優先（source priority を上書き）
```

`time_bucket` = occurred_at_sec を N秒粒度で丸め（NULL時は event 単位で1バケット）。

### 5.4 制約チェック（SYNC-5 で実行）

- `assert` dedup_key ごとに `is_canonical=true` は高々1（違反→`CANONICAL_CONFLICT` を12へ、当該 call_id を再生成保留）。
- 手動訂正行は `editor`・`timestamp`・`before`・`after` 必須（欠落は書込拒否）。

---

## 6. 二枠サンプリング実装（METRIC / DIAGNOSTIC）

### 6.1 選定アルゴリズム（baseline §1.2・裁量ゼロ）

SYNC 前・当日 E2成立通話集合に対し GAS が提示（人は貼るだけ）：

```
E2set = 当日 e2_state==TRUE の通話
# 枠1: METRIC（無作為・裁量ゼロ・再現可能）
key(c) = hash(c.source_event_id + c.call_date)      # 決定的
METRIC = sort(E2set, by=key asc)[0 : min(7, |E2set|)]
# 枠2: DIAGNOSTIC（優先・METRIC除外後の残りから）
remaining = E2set - METRIC
priorityScore = f(is_appointment, reached_proposal_but_lost, is_novel_pattern)
DIAGNOSTIC = topN(remaining, by=priorityScore, n=3)
# 重複タグ
selection_type(c) =
    BOTH        if c in METRIC and c is diagnostic-worthy
    METRIC_SAMPLE if c in METRIC
    DIAGNOSTIC_PRIORITY if c in DIAGNOSTIC
```

- `hash` は決定的（seed固定）→ **AT-1 seed再現性** の検証点。
- 実験対象 E2通話は上記に優先し **両群全件 FULL 化**（不能時は群ごと同数・同一規則無作為）。

### 6.2 official_metric_eligible（率分母のゲート）

```
official_metric_eligible = (event_observability == FULL)
                           AND (selection_type in {METRIC_SAMPLE, BOTH})
```

正式な E3〜E6率・実験判定は **この集合のみ**。DIAGNOSTIC の事実は 18 に記録するが KPI クエリで分母から遮断（§9）。

### 6.3 品質KPI

`metric_coverage = |取得できたMETRIC_SAMPLE| / |E2成立|`（日次・`12_データ品質`）。

---

## 7. LLM I/O 契約（LCS-1.5.0 プロンプト）

### 7.1 出力二分割（baseline §8）

プロンプト `LCS-1.5.0` は **1通話につき2つのJSON** を出力：

**(A) L1 イベント抽出JSON**（→18形式・METRIC/DIAGNOSTIC両方に適用）

```json
{
  "call_id": "…",
  "events": [
    {
      "event_code": "E4",
      "event_order": 3,
      "sequence_quality": "exact",
      "occurred_at_sec": 82,
      "turn_index": 6,
      "subtype": {"info_class": "timing"},
      "novelty": "new",
      "evidence_quote": "26卒はもう充足してて、27卒を今見てます",
      "speaker": "customer",
      "label_confidence": 0.86
    }
  ],
  "proposals": [
    {"proposal_type":"online_meeting","proposal_form":"two_options",
     "proposal_order":1,"proposal_wording":"…","customer_response":"conditional"}
  ],
  "e7": {"e7_subtype":"tentative_booking","next_step_disposition":"created"}
}
```

**(B) L2 診断JSON**（→03形式・DIAGNOSTIC中心）

```json
{
  "call_id": "…",
  "attribution": {"l":0.6,"c":0.3,"s":0.1,
    "l_subclass":"L-exogenous","nonpsych_cause_code":"HIRING_FROZEN"},
  "gate": {"primary":"G3","secondary":"G2","gate_confidence":0.55,
    "alternative_nonpsychological_cause":"予算凍結が確定済で心理要因の余地小"},
  "evidence_quotes": ["…","…"],
  "good": {"action":"…","quote":"…","passed_event":"E4","reason":"…","reuse_condition":"…"},
  "more": {"item":"…","priority":0.72},
  "next_action": {"when":"…","do":"…","say":"…","success":"…","window":"…"},
  "next_ng": {"stop_condition":"…","alternative":"…"},
  "prompt_version": "LCS-1.5.0"
}
```

### 7.2 バリデーション（受入前ゲート）

| 検査 | 規則 | 違反時 |
|---|---|---|
| 引用必須 | 各 E3〜E5・各診断に `evidence_quote` | 当該ラベル無効化 |
| 確信度 | `label_confidence`/`gate_confidence` < 0.60 | HOLD（`diagnosis_status=HOLD`） |
| 未来情報禁止 | 診断が outcome を参照していない | LEAKAGE→再生成 |
| 盲検 | 入力に結果・所感が含まれない（貼付テンプレで剥奪済） | 盲検逸脱を12へ |
| enum整合 | subtype/value_type/gate が語彙内 | 未知コード→SYNC-5警告 |

### 7.3 盲検貼付テンプレ（`00_設定.blind_paste_template`）

MiiTel 文字起こしから **結果・所感・アポ有無を機械的に除去**した本文のみを LLM 入力へ。単独運用では LLM が盲検枠を担う（人が結果を知っていても入力に混ぜない）。

### 7.4 モデルTier割当（baseline §16）

| タスク | Tier | 現行(2026-07) |
|---|---|---|
| 曖昧帰属・実験判定 | T1 | Opus 4.8 |
| 大規模実装・例外処理 | T2 | (High系) |
| 定常LCS・GAS | T3 | Sonnet系 |
| 整形・バッチ | T4 | Haiku 4.5 |

2回失敗で1段上。Tier切替は §11.3 回帰ゲート必須。

---

## 8. 評価体系の計算仕様（O/Q/A/F/R）

### 8.1 五軸並列（総合点を出さない）

各軸は独立列。O を Q に加算しない等の **禁止解釈** をクエリレベルで担保（総合点列を物理的に持たない）。

### 8.2 Q合成規則（baseline §7.2 の実装）

```
項目スコア ∈ {2, 1, 0, NA}                  # NAは0点扱いしない
NA分岐:
    時間系(Q01-03/05/07/24-26) & telemetry欠損 → NA_TELEMETRY_MISSING
    適用不能                                   → NA

適用可能満点 = Σ(適用項目の満点2)
if 適用可能満点 < 16: return Q_INSUFFICIENT   # スコア非表示

Q_raw = 100 * Σ(得点) / 適用可能満点          # NA項目は分母から除外
サブスコア = セクション別(A冒頭/B質問/C価値/D打診/Eスタンス)  # 主表示

# 重大違反 cap（前後両スコア保存）
C0: Q ≤ 49  かつ 教師データ除外
C1: Q ≤ 69
C2: A = 0
C3: PP除外・ITT残す
```

- **共通項目法**（期間比較・実験前後）：両期間で適用された項目のみで再計算（分母固定）。
- **mastered 項目**：優先度表示からのみ除外。総合スコア・共通項目法には残す（回帰番兵：点低下でアラート）。
- **結果盲検**：Q採点入力に結果ラベルを渡さない。

### 8.3 GOOD/MORE/次行動/次NG 構造（baseline §7.3）

| 要素 | 必須フィールド |
|---|---|
| GOOD | action・quote・passed_event・reason・reuse_condition |
| MORE | 単一item・priority = frequency × gate_loss × controllability × confidence |
| 次行動 | when・do・say・success・window |
| 次NG | stop_condition・alternative |

抽象語（「頑張る」等）は禁止（バリデータで語彙チェック）。

### 8.4 A（資産化）・F（フロー健全性）・R（学習信頼性）

- A0〜A4：失注でも残した資産（担当名・時期情報・次接点）。回収の主指標。
- F：日次 G/Y/R（架電継続の運用状態）。F-Red 日は最悪日設計（SYNC-1のみ必須）。「根性」と結論しない。
- R：週次 R1〜R7（§12週次R）。6/7以上×2週連続で安定認定。

---

## 9. KPI クエリ定義（分母規則の実装）

> 全KPIは `07_集計`（period+seg）に materialized。**UNKNOWN と NOT_ELIGIBLE は常に分母外**。会話系は `official_metric_eligible=true ∧ purposeセグメント内`。

| KPI | 分子 | 分母 | フィルタ |
|---|---|---|---|
| E2率 | e2_state=TRUE | 全E0通話 | ― |
| E3率 | e3_state=TRUE | e2_state=TRUE | official_eligible ∧ purpose |
| E4率 | e4_state=TRUE | e4_state∈{TRUE,FALSE} | official_eligible ∧ purpose |
| E5率 | e5_state=TRUE(b以上) | e5_state∈{TRUE,FALSE} | official_eligible ∧ purpose |
| 相手質問発生率 | customer_question通話 | e3_state=TRUE | official_eligible |
| 打診率 | e6_state=TRUE | e5_state=TRUE ∧ proposal_opportunity=yes | 適格性補正 |
| E7率 | e7_state=TRUE | 適格母集団 | form/subtype別に分割 |
| 実施率 | next_step_outcome=held | created済E7 ∧ outcome確定分 | pending(窓内)=UNKNOWN除外 |
| 次アクション確保率 | 次接点あり失注 | 回収可能失注 | ― |
| metric_coverage | 取得METRIC | E2成立 | 品質KPI |
| purpose_changed率 | purpose_changed=true | 全通話 | 監視指標 |

**D2ファネル**：各段の UNKNOWN 帯をグレー表示（「見えていない量」の可視化・原則1）。

### 9.1 クエリ実装方針

GAS `rebuildAggregates(period, segment)` が 18(is_canonical)→01→07 を集計。分母フィルタは共通述語関数 `officialDenominator(callRow, eventCode)` に集約し、KPI 間の分母規則ドリフトを防ぐ。

---

## 10. 実験マネージャ実装（プリレジ・マスク・ITT/PP）

### 10.1 プリレジ・割付・マスク

```
登録時(05): hypothesis, single_variable, primary/secondary/safety, stop_condition,
            decision_date, n_target(Wave1由来) を確定。以後変更禁止(BLOCKER扱い)。
割付: arm(unit) = hash(uid_or_call_id) % 2   # 週替わり禁止・ブロック内固定
      ブロック = 時間帯 × 新規/追客（業界はセル数確認後）
マスク: 効果指標は今日 < decision_date の間は 07 で非表示(mask_until=decision_date)
判定: ITT主(purpose_planned基準・plannedのみ) + PP併記
```

### 10.2 実験#001（質問先行 vs GIVE先行）実装差分

| 項目 | 実装 |
|---|---|
| 忠実度検知 | transcript 機械検知：B腕に「企業固有GIVE一文」有無を判定（`give_first_detected`）。A腕に混入→汚染 |
| 一次指標 | E4率（purpose_planned=NEW_PROSPECTING ∧ e3_state=TRUE ∧ official_eligible） |
| 対象FULL化 | 実験E2通話は §6.1 に優先し両群全件 FULL |
| Q03中立 | Q03は「相手固有の文脈確立」を測る（GIVEでも質問でも企業固有性で2点）＝評価器が結論先取りしない |
| 併走記録 | other_changes に RUBRIC_INTERVENTION 併走を記録 |

判定前 mask・判定ログ・割付汚染<5%・忠実度≥85% が AT-5 検証点。

---

## 11. M層メタ評価の実装

### 11.1 メタ指標の計算単位

M指標は `(item_id, item_version)` 単位。有効レビュー = `eligible_n ≥ 30`。

| 指標 | 実装 |
|---|---|
| M1 改善余地×変動性 | eligible_n・分散・週次変化・目標乖離。全満点→mastered（回帰番兵）／全0→最優先（休眠禁止）／全NA→定義を疑う |
| M2 判定信頼性 | intra_rater(7日後・結果非表示)/human_ai(ゴールド)/ai_test_retest/cross_version。重み付きκ、片寄分布は AC2/隣接一致。**C0〜C3 は再現率100%・偽陽性≤5%（生涯基準）** |
| M3 条件付き予測関連 | eligible_population 内で target_event との関連。層化=新規/追客×list_batch。**因果主張しない** |
| M4a actionability | MORE選出→実行可能次行動の生成率 |
| M4b 介入効果 | 05に RUBRIC_INTERVENTION 登録の準実験。昇格=proximal≥最小実務差 ∧ downstream2窓連続同方向 ∧ confounded=false |
| M5 コスト | NA率・保留率・所要。LLM確信度は校正(帯別正解率・Brier)完了まで保留優先度専用 |

### 11.2 ライフサイクル

`trial → active → core / mastered / dormant / insurance / retired`。`evidence_grade(★)` と `operational_status` は別フィールド。レビュー周期=採点100件 or 月次。1レビューの変更=同一セクション1・全体3まで。

### 11.3 回帰ゲート（切替の門）

| 変更種別 | ゴールド | 合格基準 |
|---|---|---|
| プロンプト小改版 | 20件 | 項目一致≥90% ∧ MORE一致≥80% ∧ C検知差0 |
| 基準変更・モデル変更 | 60件全件 | 上記 ＋ MAE≤8 ∧ E判定一致≥95% |

**回帰未実施の切替は禁止**（baseline §15 の唯一の禁止事項）。

---

## 12. GAS モジュール／関数カタログ

> 実装は Apps Script。トリガ＝`onOpen`(メニュー)・`onEdit`(保護)・時間主導なし（人手同期起点）。

| モジュール | 主要関数 | 責務 |
|---|---|---|
| `sync.gs` | `runSync()`・`sync0..sync6()` | 日次同期オーケストレーション・batch状態遷移 |
| `ingest.gs` | `parsePaste(source)`・`assignSourceEventId()`・`computeRowHash()` | 取込面の列認識・型変換・冪等キー |
| `matching.gs` | `resolveUid()`・`normPhone/normCompanyName/normDatetime()` | 名寄せカスケード・正規化 |
| `canonical.gs` | `dedupeObservations()`・`pickCanonical()`・`assertCanonicalUnique()` | canonical統合・制約チェック |
| `eventEngine.gs` | `resolveEventState()`・`resolveE8()`・`regenerateCallEvents()`・`buildPathPattern()` | 18→01再生成 |
| `sampling.gs` | `selectTranscripts()`・`isOfficialEligible()` | 二枠選定・eligibleゲート |
| `llmContract.gs` | `buildBlindPaste()`・`validateL1Json()`・`validateL2Json()` | LLM I/O契約・盲検・バリデーション |
| `scoring.gs` | `computeQ()`・`applyCaps()`・`commonItemMethod()` | Q合成・cap・共通項目法 |
| `kpi.gs` | `rebuildAggregates()`・`officialDenominator()` | KPI集計・分母規則 |
| `experiment.gs` | `assignArm()`・`maskEffectMetrics()`・`decideExperiment()` | 割付・マスク・ITT/PP |
| `meta.gs` | `computeM1..M5()`・`runRegressionGate()` | M層・回帰ゲート |
| `journey.gs` | `buildJourneys()`・`attributeE8()` | J層自動構成・帰属窓 |
| `snapshot.gs` | `saveRawToDrive()`・`clearIntake()` | コールド層保存・取込面クリア |
| `quality.gs` | `writeQualityKpis()`・`logProtectionBreach()` | 12_データ品質記録 |
| `audit.gs` | `logManualCorrection()`・`recordChange()` | 手動訂正・08改修ログ |

### 12.1 冪等な再実行

`runSync()` は `batch_state` を見て中断地点から再開。全 write は upsert（idempotency_key）。

---

## 13. エラー処理・冪等性・障害復旧

| 事象 | 検知 | 復旧 |
|---|---|---|
| 前batch FAILED | SYNC-0 | 当日新規より前batch復旧を優先 |
| Drive書込失敗 | SYNC-6 | 取込面をクリアしない・`batch_state=FAILED`・再実行で再保存 |
| 列プロファイル逸脱 | SYNC-5 | WARN・同期継続・`column_drift` を12へ |
| canonical衝突 | assertCanonicalUnique | 当該call_id再生成保留・`CANONICAL_CONFLICT` |
| 保護シート誤編集 | onEdit | 変更取消・`PROTECTED_SHEET_EDIT_ATTEMPT` |
| LLM JSON不正 | validateL*Json | 当該ラベル無効/HOLD・再抽出キュー |
| 最悪日(F-Red) | 運用 | SYNC-1(2分)のみ必須・MiiTel/L2は48h遅延許容 |

**設計思想**：悪い日を「欠損日」にしない。連続拒否後の休止・再開は運用指標であり能力評価にしない。

---

## 14. セキュリティ実装

- スプレッドシート・Drive は **会社ドメイン限定共有**。個人Drive複製禁止・リンク公開/公開CSV禁止。
- QS-1 連携は同一ドメイン認証＋`IMPORTRANGE`（外部公開しない）。
- raw原本は Drive 制限フォルダ・編集禁止（サービスアカウントのみ書込）。
- 手動修正は全て監査ログ（editor/timestamp/before/after）。
- AI貼付は匿名化テンプレ（会社承認確定まで個人情報・社名を伏せる運用）。
- 保持期間は `00_設定`。

---

## 15. 受入テスト実装対応表（AT トレーサビリティ）

| AT | 検証対象モジュール | 合格判定の実装 |
|---|---|---|
| AT-0 | ingest/canonical/eventEngine | source件数一致・重複0・列認識100%・4状態正付与・18→01再生成一致・canonical複数源→1正規 |
| AT-1 | sync/matching/sampling | 名寄せ≥95%・所要≤10分/日・再貼付 `ingest_delta=0`・二枠quota遵守・seed再現性 |
| AT-2 | eventEngine/llmContract | E1/E2/E7一致≥95%・他E≥85%（正解=event_order・disposition込み18形式） |
| AT-3 | llmContract/scoring | 引用率100%・HOLD運用・再診断主因一致≥80% |
| AT-4 | scoring(next_action) | 各型3件でタスク・期日・完了条件一致 |
| AT-5 | experiment | 割付汚染<5%・忠実度≥85%・判定前マスク・判定ログ |
| AT-6 | 運用(週次Q1〜Q4) | 2週連続全YES・期限漏れ0 |
| AT-7 | scoring(GOOD/MORE) | 第三者が代表10件を根拠付き説明可能 |
| AT-Q1〜Q8 | meta(M2) | 適用判定・二重採点κ≥0.70・MAE≤8・C再現率100%/偽陽性≤5%・結果漏洩差≤3点・L公平性 |

**不合格ループ**：課題→{データ/ロジック/運用/ラベル}の4分類→**1修正**→再テスト→08記録。

---

## 16. 実装フェーズ計画

| Phase | 名称 | 主要成果物 | ゲート |
|---|---|---|---|
| 0 | 事実確認 | Wave0取込・列プロファイル・4状態付与 | AT-0 |
| 1 | つなぐ | 冪等取込・名寄せ・二枠選定 | AT-1 |
| 2 | わかる | 18→01再生成・LCS-1.5.0・novelty EVENT_LEVEL化 | AT-2〜4 |
| 3 | まわす | Wave1ベースライン・実験#001 | AT-5 |
| 4 | 回収する | 週次PDCA定着 | AT-6 |
| 5 | 育てる | GOOD/MORE運用 | AT-7 |
| 6 | 協業 | 教師VIEW・AI L1・人AI同一採点 | ― |

**クリティカルパス**：Wave0 → 冪等取込 → 名寄せ → **ゴールド60件（18形式）** → ベースライン → 実験#001。

---

## 付録A：未決事項（Wave 0 実データで確定）

baseline §17 のまま：BALES/SF の法人番号・source ID 実在／MiiTel 貼付の話者・時刻粒度／AI貼付の社内承認・保持期間／SF-BALESアポ競合の優先順位確定／QS-1 既存6タブの v2.1 移行差分。

## 付録B：本詳細設計で追加した実装判断（baseline 非改訂・実装補助）

以下は baseline を変更せず、実装のために本書で具体化した点。矛盾が生じた場合は baseline 優先で修正する。

- `batch_id` 形式・`batch_state` 遷移（baseline は「batch完了状態確認」のみ規定）
- `dedup_key.time_bucket` の丸め粒度（`00_設定` でパラメータ化）
- GAS モジュール分割（§12）と関数名（実装都合・命名は変更可）
- 保護シートの onEdit 実装（baseline「直接編集禁止」の物理担保手段）
- `officialDenominator()` 述語集約による分母規則ドリフト防止（baseline §10 の実装手段）

> 本詳細設計書は baseline v1.5（BASELINE_FROZEN）に従属する。以後の変更は baseline §15（BUGFIX／BLOCKER／候補ブランチ）の統制下でのみ行う。
