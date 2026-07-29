# G-Chain OS v1.5 最終決定版 ―― MOCHICA テレアポ統合分析システム
## BASELINE_FROZEN・単一正本

> **文書統制**：本書はv1.3（評価基準確定版）・v1.4（Eイベントモデル）・v1.4.1（実装凍結パッチ）・v1.3.1差分モジュールの全内容を統合し、**上記を全て廃版**とする。最終レビュー（必須4＋推奨3）を反映済み。
> 統一モデルv2.1（G-Chain心理モデル＋Annex E）は別文書の**憲法**として併存・無改訂。
> AT合格後の運用実態反映版はv1.6として発行する。
> 表記：evidence_grade=★／★★／★★★（証拠専用）。運用ステータスは語表記。

---

# 0. システム定義

> **全架電が人手ゼロ〜コピペ1回で、①事実（Eイベント）②診断（G仮説・LCS）③改善行動（次アクション・コーチング）④実験データ ⑤ナレッジ の5形態に自動変換される。「分析されない架電」ゼロ、日次10分・週次30分。**

## 0.1 三位一体の目的

| 目的 | 成果 | 中核データ |
|---|---|---|
| 実務PDCA | 週次で最大ボトルネックを1つ特定→翌週の改善を測る | E率・LCS・打診イベント・回収率 |
| 育成PDCA | 新人が「何を・なぜ・どう直すか」を引用付きで理解 | GOOD/MORE/次行動/次NG・ナレッジ索引 |
| AI教師データ | 人とAIを同一基準で採点する学習対の蓄積 | raw＋state＋label＋confidence＋outcome |

## 0.2 設計原則（10箇条・確定）

1. 分析されない架電ゼロ（UNKNOWNも「見えていない量」として可視化する）
2. 人手は同期コピペ1日1回まで。API依存ゼロ
3. **Eは事実、Gは最後まで仮説**
4. **事実の有無と、目的上必要だったかを混ぜない**
5. 単一変数PDCAの機構化（プリレジ・覗き見ロック・判定日）
6. 全診断に反証可能性（根拠引用＋確信度＋棄却条件）
7. 評価基準自体が仮説であり、M層で淘汰される
8. 人が学べる形式＝AIが学べる形式（未来情報を入力特徴に混ぜない）
9. **KPI・実験の分母は無作為抽出、診断は優先抽出**——2つの枠を混ぜない
10. 複雑化はスキーマに許し、運用には許さない（サブタイプは全てLLM抽出列。人の日次入力増分ゼロ）

## 0.3 スコープ

対象＝テレアポ・インサイドセールス（架電〜商談化〜資産化・再活性化）。対象外＝リスト作成システム（独立既存・I/F接続のみ）。単独運用（operator_id/actor_typeは固定値で保持）。基盤＝会社Google Workspace（Sheets・Drive・GAS）。

---

# 1. 分析カバレッジ三層と文字起こしサンプリング

## 1.1 三層

| 層 | 対象 | 内容 | 運用 |
|---|---|---|---|
| L0 | 全架電 | 日時・企業・接続・E0〜E2・結果・次アクション・実験タグ | 自動 |
| L1 | 担当接続の全通話 | Eイベント明細抽出（E3〜E7・サブタイプ・打診イベント） | LLM自動（transcript必要） |
| L2 | 重点通話 | L/C/S帰属・G仮説・Q26/R6・GOOD/MORE/次行動/次NG | LLM＋人監査 |

## 1.2 文字起こし二枠サンプリング（選択バイアス遮断・最終レビュー1.1）

日次上限（既定10件・00_設定）を2枠に分割：

| 枠 | 既定 | 抽出規則 | 用途 |
|---|---|---|---|
| **METRIC_SAMPLE** | 7件 | E2成立通話から**無作為・裁量ゼロ**：hash(source_event_id＋call_date)昇順の上位7件。E2≤7なら全件 | KPI・実験判定の正式分母 |
| **DIAGNOSTIC_PRIORITY** | 3件 | アポ・打診到達失注・未知パターンを優先（METRIC選出済みを除く残りから） | LCS診断・コーチング・ナレッジ |

- `transcript_selection_type ∈ {METRIC_SAMPLE, DIAGNOSTIC_PRIORITY, BOTH}`（無作為枠に診断対象が入った場合はBOTH）
- **official_metric_eligible = (event_observability=FULL) AND (selection∈{METRIC_SAMPLE, BOTH})**。正式なE3〜E6率・実験判定はこの集合のみで算出
- DIAGNOSTIC通話の事実は18に記録するが、正式率の分母から除外（KPIクエリで遮断）
- **実験対象のE2成立通話は原則両群全件FULL化**。不能な場合は群ごと同数・同一規則の無作為抽出
- 品質KPI：`metric_coverage = METRIC_SAMPLE取得数／E2成立数`を日次で記録

---

# 2. Eイベントモデル（確定仕様）

## 2.1 4状態

```
e{n}_state ∈ { TRUE, FALSE, UNKNOWN, NOT_ELIGIBLE }
```

| 状態 | 意味 |
|---|---|
| TRUE | 観測でき、発生した |
| FALSE | **観測可能だったのに**発生しなかった（observability要件充足時のみ付与可） |
| UNKNOWN | データ不足で判定不能（transcript欠損等）。**分母から除外** |
| NOT_ELIGIBLE | 論理的前提を満たさない（§2.2）。分母から除外 |

max_event＝TRUEのみから算出。教師VIEWはstateをそのまま出力（UNKNOWNをFALSEに潰さない）。

## 2.2 NOT_ELIGIBLE＝論理的前提のみ（最終レビュー1.2）

| イベント | NOT_ELIGIBLE条件 |
|---|---|
| E3〜E5 | E2がTRUEでない |
| E6 | 営業発話が存在しない／接触不成立 |
| E7 | 次接点という概念が存在しない接触 |
| E8 | 帰属対象のE7／journeyがない |

**purposeはNOT_ELIGIBLEの根拠にしない**（前日確認中に「採用人数が変わった」と言われればE4=TRUEは普通に発生する）。目的上の要否は派生列 `event_required_for_purpose`（00_設定のpurposeテンプレートから結合）で別管理。`E4_state=TRUE ∧ required=false` は正常データ。

## 2.3 イベント定義

| E | 名称 | 判定条件 | サブフィールド（18に保存） |
|---|---|---|---|
| E0 | 発信成立 | 有効番号へ発信 | ― |
| E1 | 人接触 | 人間が応答（留守電・自動音声除く） | ― |
| E2 | 担当接続 | 採用担当/実質担当と会話開始 | ― |
| E3 | **意味応答** | E2後、相手が状況/判断/希望/質問のいずれかを含む発話≥1（「今忙しい」は成立・あいづち単独は不成立・受付発話は対象外）。派生列`dialogue_continued`（実質発話≥2） | ― |
| E4 | 情報獲得 | business/timing/tool/decision情報の獲得（reception_assetはR6/A軸へ） | info_class・novelty（new/confirmed/**contradicted**→マスタ修正起票） |
| E5 | 課題/関心表明 | **E5b以上**（E5a誘導同意はフラグを立てず記録のみ） | disclosure_grade(a/b/c)・value_type（problem/dissatisfaction/interest/future_condition/risk_awareness。no_problemはE4扱い） |
| E6 | 打診実行 | 打診イベント≥1（16に複数行保存） | →§2.4 |
| E7 | 次接点確保 | **強度2以上**のサブタイプ | e7_subtype・next_step_disposition |
| E8 | 次工程進行 | TRUEサブタイプ発生・帰属窓内 | →§2.6 |

## 2.4 打診イベント（16_打診イベント）

```
proposal_type : material_send / callback / online_meeting / trial
proposal_form : two_options / single_datetime / open_question / vague
proposal_order / proposal_wording（引用） / customer_response(accepted/conditional/deflected/declined)
```

- formは観測事実。**WEAK_CLOSEは評価仮説**としてM層対象（最終レビュー2.3）：初期ルール＝vague→候補、open_question→文脈条件付き候補（関係構築後の開放質問は有効な場合がある）。15_台帳に★試用で登録
- 一般原則：忠実度イベントのうち記述的なもの（LONG_OPENING秒数等）＝観測、評価的なもの（WEAK_CLOSE・PREMATURE_QUESTION等）＝仮説としてM層で検証

## 2.5 E7強度とdisposition

| e7_subtype | 強度 | E7成立 |
|---|---|---|
| meeting_confirmed | 4 | ○ |
| tentative_booking | 3 | ○ |
| agreed_callback_datetime / agreed_followup_date | 2 | ○ |
| vague_permission_to_call | 1 | ×（記録のみ） |
| unilateral_callback | 0 | ×（E7に含めない） |

`next_step_disposition`（架電時にこの通話が次接点へ与えた作用）：created / confirmed / rescheduled / cancelled。
**E7_state=TRUEはcreatedのみ**。CONFIRMATION目的の成功＝confirmed（新E7は発生しない）。リスケ＝旧E7側にoutcome記録＋新E7をcreated（2行）。

## 2.6 E8と次接点結果の分離（最終レビュー1.3）

`next_step_outcome`（作成済みE7の事後の結末）と E8_state の対応：

| next_step_outcome | 当該E7に対するE8_state |
|---|---|
| held / valid_reply / opportunity_created | **TRUE** |
| rescheduled | FALSE（当初接点として不成立。新E7へ帰属窓リセット。journey継続はJ層が保持） |
| cancelled / no_show | FALSE |
| pending・帰属窓（30日）内 | **UNKNOWN**（直近週のE8率を不当に下げない） |
| pending・窓超過 | FALSE |

実施率＝held／（created済みE7のうちoutcome確定分）。ダッシュボードは常にoutcome分布を併記。

---

# 3. purpose・経路・J層

## 3.1 purposeの3列

```
purpose_planned（キュー由来・架電前確定）／ purpose_resolved（L1抽出）／ purpose_changed
```
実験の割付・プリレジ・ITTは**plannedのみ**（事後分類の選択バイアス遮断）。purpose_changed率はD9監視指標。

## 3.2 目的別テンプレート（採点基準ではなく参照経路）

| purpose | 期待経路 | 成功定義 |
|---|---|---|
| NEW_PROSPECTING | E2→E3→E4→E5→E6→E7 | E7強度2+ or A2+ |
| FOLLOWUP_MATERIAL | E2→E3→(E4)→E6→E7 | 確認日→面談転換 or 次期限 |
| CALLBACK_SCHEDULED | E2→E3→E6→E7 | 前回合意履行＋前進 |
| REACTIVATION | E2→E3→E4→E7 | 時期確認＋次接点 |
| CONFIRMATION | E2→維持 | **next_step_disposition=confirmed** |

率・実験・評価はpurposeセグメント内でのみ比較。

## 3.3 J層（ジャーニー）

- journey_id＝uid＋連番（硬拒否・クールダウン・年度替わりで区切る）。17_ジャーニーはGAS自動構成
- E7/E8はjourney単位でも保持、originating_call_idで通話へ帰属。E8帰属窓＝E7後30日（00_設定）
- **貢献配分モデルは構築しない**（n過少・目的別評価が中間貢献を保護・journey_outcomeは教師のposthoc_label区画のみ）
- call視点率（実行品質・実験）とjourney視点率（営業成果・リスト評価）を分離定義

---

# 4. G層（心理仮説）と帰属規律

## 4.1 G層（統一モデルv2.1・無改訂）

GK取次／G0防衛反応（PKM・Thin-slicing）／G1関連性（自己関連付け）／G2機会費用（認知的倹約家・時間契約）／G3価値認識（ELM・自己説得・損失回避——観測マーカーはE4とE5、分割しない）／G4コミットメント（BYAF・FITD・選択設計・ザイガルニク）。全て★★★出典は憲法§4のまま。

## 4.2 E⇄G第一仮説対応（「支配」ではなく仮説）

| E遷移 | 第一仮説ゲート | 備考 |
|---|---|---|
| E1→E2 | GK | 取次設計（指名・用件文） |
| E2→E3 | G0＋G2初期 | 冒頭切電＝PKM発火疑い |
| E3維持 | G2 | 時間契約 |
| E3→E4 | G1 | 関連性 |
| E4→E5 | G3 | 自己説得。説明先行がここを殺す★ |
| E5→E6 | （営業行動） | §4.4の適格性判定 |
| E6→E7 | G4 | BYAF・2択・仮押さえ |
| E7→E8 | G4残存＋実務 | 宿題化・前日確認 |

診断JSON必須：primary/secondary_gate_hypothesis・gate_confidence・alternative_nonpsychological_cause。確信度<0.60はHOLD。

## 4.3 L/C/S帰属とL下位区分

主因1・副因≤2。L＝会話前決定条件／C＝会話設計・実行／S＝声・間・スタンス。
L下位区分：**L-actionable**（ICP外・重複・時期外＝設計で防げた→リスト改善）／**L-exogenous**（外生コード：TECH_QUALITY・PERSONNEL_CHANGE・HIRING_FROZEN・POLICY_BLOCK・FORCE_MAJEURE→誰の責でもない）。Lで失注してもA2/A3を取れなかった原因がC/Sなら副因として残す。

## 4.4 打診適格性

```
proposal_opportunity = yes / no / unclear
proposal_omission = (opportunity=yes ∧ 会話余地あり ∧ 打診なし) の時のみ true
```
opportunity=noの正当例：対象外確定・採用終了・強い不快・接触停止・時期情報取得が最適解・MOCHICAで解けない課題。Q19〜23のeligible集団はopportunity=yesに限定。

---

# 5. データ層

## 5.1 日次同期（SYNC）

| 手順 | 処理 | 主体 |
|---|---|---|
| SYNC-0 | 前回batch完了状態・当日source件数確認 | 自動 |
| SYNC-1 | BALES当日一覧→取込_BALES貼付 | 人/ブラウザ操作 |
| SYNC-2 | SF当日活動・商談→取込_SF貼付 | 人/ブラウザ操作 |
| SYNC-3 | **二枠規則（§1.2）で選定された通話**の文字起こし→取込_MiiTel貼付 | 人/ブラウザ操作 |
| SYNC-4 | 列認識・型変換・row_hash・source_event_id生成 | 自動 |
| SYNC-5 | 件数一致・重複・名寄せ率・未知コード・metric_coverage表示 | 自動 |
| SYNC-6 | rawスナップショットDrive保存→取込面クリア | 自動 |

冪等性：キー＝source_system＋source_event_id（なければ正規化日時・電話番号・通話秒・結果のrow_hash）。同一データ再貼付で増分ゼロ。

## 5.2 名寄せ

法人番号→正規化電話番号→企業名（法人格・全半角・支店語正規化＋類似度）→ドメイン→手動確定。M9-99例外キュー→確定→ルール昇格。uid昇格マイグレーション対応。

## 5.3 複数データ源の正規統合（最終レビュー1.4）

18は**生の観測を全て保持**（削除禁止・監査可能性）した上で正規化：

```
observation_id / canonical_event_id / dedup_key / is_canonical
dedup_key = call_id + event_code + normalized_subtype + time_bucket
```

| イベント | 正規源の優先順位 |
|---|---|
| E3〜E6 | MiiTel transcript ＞ BALES note |
| E7 | SF/Calendar確定 ＞ BALES structured ＞ transcript ＞ BALES note |
| E8 | SF実績 ＞ Calendar実績 ＞ BALES note |

**01の集計・path_pattern・ask_countはis_canonical=trueのみ**を使用（E7重複行・path「E7>E7」を構造的に防止）。手動訂正は最優先（editor・timestamp・before/after必須）。

## 5.4 発生順の品質（最終レビュー2.1）

```
event_order = NULL許可
sequence_quality = exact / inferred / unknown
```
path_patternはexact＋高信頼inferredのみで生成。順序不明時は`path_pattern=UNKNOWN_SEQUENCE`＋`event_set=E3|E4|E6`を保持（偽の経路を作らない）。

## 5.5 noveltyの時点固定（段階実装・最終レビュー2.2）

- Phase 0：前日rawスナップショット比較（P8流用）。`novelty_precision=DAY_LEVEL`を記録（同日午前の獲得情報は午後にnew誤判定され得ることを明示）
- Phase 2：`knowledge_state_at_call`＝call_at以前の確定全イベント（18参照）で判定。`novelty_precision=EVENT_LEVEL`

## 5.6 バックフィル

Wave 0（直近2週・列プロファイル）→Wave 1（3ヶ月・ベースライン）→Wave 2（全履歴・並走）。raw原文保持・正規化列別立て。

---

# 6. HUBスキーマ v1.5（最終形・19シート）

| シート | 主キー | 要点 |
|---|---|---|
| 00_設定 | key | KPI目標・コード辞書・列マッピング・モデルTier・**日次transcript上限（10=7+3）・帰属窓・purposeテンプレ・M仮閾値（valid_from付）・rubricバージョンマップ・最小実務差** |
| 00_取込_BALES/SF/MiiTel | batch+row | 生貼付・row_hash・取込状態 |
| 01_架電イベント | call_id | **18からの生成ビュー（直接編集禁止）**：e0〜e8_state・max_event・path_pattern/event_set・purpose_planned/resolved/changed・analysis_source/level・transcript_available・event_observability・**transcript_selection_type・official_metric_eligible**・event_required_for_purpose・dialogue_continued・journey_id・proposal_opportunity・nonpsych_cause_code・script_version・experiment_tag・raw列 |
| 02_通話コンテンツ | call_id | raw/clean transcript・turns・品質フラグ |
| 03_LCS診断 | call_id | L/C/S・G第一/第二仮説・gate_confidence・非心理的代替原因・根拠引用・確信度・GOOD/MORE/次行動/次NG・prompt_version |
| 04_次アクション | action_id | 種別・期日・完了条件・状態・overdue・CTR |
| 05_実験管理 | exp_id | type（SCRIPT/RUBRIC_INTERVENTION）・仮説・単一変数・ブロック割付・一次/二次指標・n・忠実度・判定日・棄却条件・other_changes・comparison_condition・★ |
| 06_企業・接点マスタ | uid | 統合ビュー・累積結果・クールダウン・**contradicted修正キュー** |
| 07_集計 | period+seg | 生産性・E率（official分母）・LCS・回収・実験・品質 |
| 08_改修ログ | change_id | **change_class（BUGFIX/BLOCKER/MODEL_CHANGE）・change_status（candidate/approved/rejected）** |
| 09_ナレッジ索引 | knowledge_id | 型・適用条件・反例・evidence_grade・出典 |
| 10_訴求根拠マスタ | claim_id | 使用可否文言・出典・条件・期限・禁止表現 |
| 11_スクリプト版 | script_version | 全文・変更点・関連exp |
| 12_データ品質 | batch_id | 件数差・重複・名寄せ率・**transcript同期率・metric_coverage・UNKNOWN率・purpose_changed率** |
| 13_ラベル監査 | audit_id | 初回/再判定・差分・確定・回帰結果 |
| 14_教師データVIEW | call_id | **二区画：feature_available_at_call／posthoc_label＋label_available_at**。journey_outcomeはラベル区画のみ。直接編集禁止 |
| 15_評価基準台帳 | item_id+version | construct・decision_hypothesis・**eligible_population・target_event・minimum_practical_effect**・M1〜M5・evidence_grade・operational_status・definition_hash・valid_from/until。**Q26/R6の全アンカー（2/1/0点基準）の正本は本台帳**（設計書は項目一覧のみ保持） |
| 16_打診イベント | proposal_id | §2.4 |
| 17_ジャーニー | journey_id | §3.3・GAS自動構成 |
| **18_Eイベント明細** | event_id | **事実の正本**：event_code・order・occurred_at_sec・turn_index・subtype・novelty・disclosure_grade・evidence_quote・speaker・source_type・extractor_version・label_confidence・reviewed・**observation_id・canonical_event_id・dedup_key・is_canonical・sequence_quality** |

Sheetsホット層＋Driveコールド層（raw原本・編集禁止）は継続。

---

# 7. 評価体系（O/Q/A/F/R）

## 7.1 五軸並列（総合点は出さない）

| 軸 | 測るもの | 形式 | 禁止解釈 |
|---|---|---|---|
| O Outcome | 相手側の結果 | O0〜O6 | 品質点に加算しない |
| Q Execution | 制御できた実行品質 | R6＋Q26・0〜100 | コーチング主指標 |
| A Assetization | 不成立でも残した資産 | A0〜A4 | 回収の主指標 |
| F Flow Health | 架電継続の運用状態 | 日次G/Y/R | 「根性」と結論しない |
| R Learning | 改善判断の信頼性 | 週次R1〜R7 | ― |

O5でもQ<70＝「成果は出たが再現性が低い」。O2でもQ≥85∧A3＝「良い非アポ」。この分離が教師データ品質の核心。

## 7.2 Q合成規則（確定）

- 2=完全／1=部分／0=未実施・逆行／NA。**NAは0点扱いしない**
- テレメトリ欠損項目（Q01-03/05/07/24-26の時間系）は`NA_TELEMETRY_MISSING`
- 適用可能満点<16点→`Q_INSUFFICIENT`（スコア非表示）
- 主表示＝セクション別サブスコア（A冒頭/B質問/C価値/D打診/Eスタンス）
- 期間比較・実験前後＝**共通項目法**（両期間で適用された項目のみ再計算）
- **結果盲検**：Q採点は結果ラベル非表示で実施（単独運用ではLLMが盲検枠を担う——貼付テンプレは結果・所感を剥ぐ）
- mastered項目＝優先度除外のみ。**総合スコア・共通項目法には残す**（分母を動かさない）。回帰番兵として点低下でアラート
- 重大違反C0（Q上限49・教師除外）／C1（上限69）／C2（A=0）／C3（PP除外・ITT残す）。cap適用前後の両スコア保存

項目一覧（アンカー正本は15_台帳）：受付R01〜R06／Q01〜Q06冒頭・信頼／Q07〜Q13質問・傾聴／Q14〜Q18価値接続／Q19〜Q23打診・回収／Q24〜Q26スタンス。

## 7.3 GOOD/MORE/次行動/次NG規約

GOOD＝行動＋引用＋通過E＋理由＋再利用条件。MORE＝単一項目（priority=frequency×gate_loss×controllability×confidence）。次行動＝When/Do/Say/Success/Window。次NG＝停止条件＋代替。抽象語禁止。

---

# 8. LCS診断・L2運用

- L2対象：全アポ・打診到達失注全件・E3〜E5未知パターン・E0〜E2層化サンプル・同一スクリプト版で週10件以上（成功と失敗を混ぜる）
- プロンプトLCS-1.5.0は**出力二分割**：L1イベント抽出JSON（18形式・METRIC/DIAGNOSTIC両方に適用）／L2診断JSON（03形式・DIAGNOSTIC中心）
- ラベル品質：確信度<0.60保留・根拠引用なし無効・週20%を7日後再診断・改版時ゴールド回帰・**納得率より結果ラベルを優先**
- 貼付テンプレ＝結果・所感を除去した盲検形式（仕様は00_設定に固定）

---

# 9. M層（評価基準のメタ評価）

## 9.1 メタ指標

| # | 指標 | 定義 | 備考 |
|---|---|---|---|
| M1 | 改善余地×変動性 | eligible_n・分散・週次変化・目標乖離 | 全件満点＝**mastered（回帰番兵）**／全件0点＝最優先課題（休眠禁止）／全NA＝定義を疑う |
| M2 | 判定信頼性 | intra_rater（7日後自己・結果非表示）／human_ai（ゴールド）／ai_test_retest／cross_version | raw＋重み付きκ。片寄分布はAC2/隣接一致。**C0〜C3は再現率100%・偽陽性≤5%（生涯基準）** |
| M3 | 条件付き予測関連 | eligible_population内でtarget_eventとの関連。層化＝新規/追客×list_batch | 因果主張はしない |
| M4a | actionability | MORE選出→実行可能次行動の生成率 | ― |
| M4b | 介入効果 | 05にtype=RUBRIC_INTERVENTIONで登録した準実験 | 昇格＝proximal≥**最小実務差**∧downstream2窓連続同方向∧confounded=false |
| M5 | コスト | NA率・保留率・所要 | LLM確信度は**校正（帯別正解率・Brier）完了まで保留優先度専用** |

最小実務差（★仮）：E4率+5pt／E7率+2pt／Q項目+0.3。全項目分を15_台帳へ事前宣言。

## 9.2 ライフサイクルと版管理

trial→active→core／mastered／dormant／insurance／retired。evidence_grade（★）とoperational_statusは別フィールド。item_id＋item_version＋definition_hash。M指標は(item_id, version)単位。有効レビュー＝eligible_n≥30。レビュー周期＝採点100件or月次。1レビューの変更＝同一セクション1・全体3まで。

## 9.3 回帰ゲート

プロンプト小改版＝ゴールド20件（項目一致≥90%・MORE一致≥80%・C検知差0）／基準変更・**モデル変更＝ゴールド60件全件**（＋MAE≤8・E判定一致≥95%）。回帰未実施の切替禁止。

---

# 10. KPI定義（分母規則つき・目標値は00_設定）

| 領域 | KPI | 定義（分母規則） |
|---|---|---|
| 品質 | 取込カバレッジ／重複率／名寄せ率／transcript同期率／**metric_coverage**／UNKNOWN率／purpose_changed率 | 12_データ品質 |
| 生産性 | 架電/活動時・ACW比率 | timing群 |
| 受付 | 担当名取得率・指定再架電取得率・受付資産化率 | E1受付通話分母 |
| 接続 | E2率＝E2/E0 | 全通話 |
| 会話 | E3率＝E3(TRUE)/E2、E4率＝E4(TRUE)/(E4∈{T,F})、E5率同様 | **official_metric_eligible限定・purposeセグメント内** |
| 信頼 | 相手質問発生率＝customer_question/E3 | 同上 |
| 打診 | 打診率＝E6/（E5∧opportunity=yes） | 適格性補正 |
| 成果 | E7率（form/subtype別）・実施率＝held/確定outcome・アポ確定率 | §2.6 |
| 回収 | 次アクション確保率・期限遵守率 | 回収可能失注分母 |
| 学習 | L2カバレッジ・実験忠実度・R週次スコア | ― |

**UNKNOWNとNOT_ELIGIBLEは常に分母外。D2ファネルはUNKNOWN帯をグレー表示。**

---

# 11. 実験マネージャ

原則：一実験一変数／ブロック割付（uid/call_idハッシュ固定・週替わり禁止）／一次・二次・安全指標と停止条件の事前登録／判定日まで効果指標マスク／ITT主・PP併記／nはWave 1ベースラインから算出。

## 実験#001（最終仕様）：質問先行 vs GIVE先行

| 項目 | 内容 |
|---|---|
| A腕 | 目的明示→文脈一文→一問（PREMATURE_QUESTION非該当形に再定義済み） |
| B腕 | A＋**企業固有GIVE一文（30秒以内・根拠マスタ適合）**——差分はGIVEの有無のみ |
| 一次 | **E4率**（purpose_planned=NEW_PROSPECTING ∧ E3=TRUE ∧ official_metric_eligible） |
| 二次 | 相手質問発生率・**E5率（E5b以上のみ）**・E7率・冒頭離脱率 |
| 安全 | 平均通話秒・架電/時・UNSOURCED_CLAIM率 |
| 忠実度 | AはGIVE_FIRSTなし／Bはあり。transcript機械検知 |
| 対象 | 実験E2通話は原則全件FULL（§1.2） |
| 割付 | 時間帯×新規/追客ブロック（業界はセル数確認後）・other_changesにRUBRIC_INTERVENTION併走を記録 |

Q03は戦術中立（「相手固有の文脈確立」を測る。GIVEでも質問でも企業固有性で2点）——評価器が実験結論を先取りしない。

---

# 12. 運用

## 日次（10分）
朝5分：期限順TODO・指定再架電・企業ブリーフ・当日実験条件 ／ 架電中：tereapo補助（任意）／ 終業：SYNC-0〜6＋二枠選定はGASが提示（人は貼るだけ）／ L2貼付（盲検テンプレ・日次上限内）

## 週次（30分）
Q1全件搭載→Q2ボトルネック1つ（E率＋代表発話）→Q3先週の単一変数判定→Q4来週の単一変数→ナレッジ・スクリプト版更新（変えなかった要素も記録）

## 最悪日設計
F-Redの日はSYNC-1（2分）のみ必須。MiiTel/L2は48時間遅延許容。悪い日を「欠損日」にしない。連続拒否後の休止・再開は運用指標（能力評価にしない）。

## 週次R（学習信頼性）
R1全件搭載／R2ボトルネック単一／R3帰属根拠／R4単一変数／R5判定可能性／R6資産化／**R7評価器健全性（期限到達時にM確認＋変更/維持の判断と根拠が記録。維持も正当。未到達NA）**。6/7以上×2週連続で安定認定。

---

# 13. 受入テスト（統合表）

| AT | シナリオ | 合格基準 |
|---|---|---|
| AT-0 | Wave 0を3日分取込 | source件数一致・重複0・列認識100%・**4状態の正付与・18→01再生成一致・canonical重複統合（複数源→1正規イベント）** |
| AT-1 | 実架電5日連続 | 名寄せ≥95%・所要≤10分/日・再貼付増分0・**二枠quota遵守・seed再現性** |
| AT-2 | 代表50件を手動正解と比較 | E1/E2/E7一致≥95%・他E≥85%（正解データはevent_order・disposition込み18形式） |
| AT-3 | 成功5・失敗15をLCS診断 | 引用率100%・保留運用・再診断主因一致≥80% |
| AT-4 | 次アクション各型3件 | タスク・期日・完了条件一致 |
| AT-5 | 実験#001実走 | 割付汚染<5%・忠実度≥85%・判定前マスク・判定ログ |
| AT-6 | 2週連続 | 週次Q1〜Q4全YES・期限漏れ0 |
| AT-7 | 第三者が代表10件閲覧 | GOOD/MORE/次行動/次NGを根拠付きで説明可能 |
| AT-Q1〜Q8 | 評価器（適用判定・二重採点κ≥0.70・MAE≤8・C再現率100%/偽陽性≤5%・結果漏洩差≤3点・L公平性・コーチング・運用効果） | v1.3基準を継承（M2規則は§9.1へ更新） |

不合格ループ：課題→データ/ロジック/運用/ラベルの4分類→**1修正**→再テスト→08記録。

# 14. セキュリティ

会社ドメイン限定・個人Drive複製禁止・リンク公開/公開CSV禁止（QS-1は同一ドメイン認証・IMPORTRANGE）・raw原本は制限フォルダ編集禁止・手動修正は監査ログ・AI貼付は匿名化テンプレ（会社承認確定まで）・保持期間は00_設定。

# 15. 変更管理（凍結規則・確定）

| 分類 | 扱い |
|---|---|
| BUGFIX | 常時可（改修ログ必須） |
| BLOCKER | 常時可（影響範囲記載） |
| MODEL_CHANGE | **候補ブランチ方式**：BASELINE_FROZEN→CANDIDATE起票→回帰（§9.3）→影響AT再実施→APPROVED昇格 or REJECTED。同時候補1本まで。**禁止は「回帰なしの基準書換え」のみ** |

# 16. ロードマップとモデルTier

Phase 0事実確認（Wave 0・AT-0）→1つなぐ（AT-1）→2わかる（AT-2〜4・novelty EVENT_LEVEL化）→3まわす（ベースライン・#001・AT-5）→4回収する（AT-6）→5育てる（AT-7）→6協業（教師VIEW・AI L1・人AI同一採点）。
クリティカルパス：Wave 0→冪等取込→名寄せ→**ゴールド60（18形式）**→ベースライン→#001。
モデルTier：T1 Frontier（設計・曖昧帰属・実験判定）／T2 High（大規模実装・例外処理）／T3 Standard（定常LCS・GAS）／T4 Fast（整形・バッチ）。現行割当は00_設定（2026-07時点：Fable 5／Opus 4.8／Sonnet系／Haiku 4.5）。2回失敗で1段上。切替は回帰ゲート必須。

# 17. 未決事項（Wave 0待ちのみ）

BALES/SFの法人番号・source ID実在／MiiTel貼付の話者・時刻粒度／AI貼付の社内承認・保持期間／SF-BALESアポ競合の実データ優先順位確定／QS-1既存6タブ現物のv2.1移行差分。

---

# 付録：版履歴（決定の系譜）

v1.0統合構想→v1.1確定（同期・名寄せ・単独運用）→v1.2/1.3（実ログ帰納：三層・O/Q/A/F/R・Q26）→照会票回答（データ実態確定）→E×G二層＋M層→v1.4（30問決定：独立イベント・purpose・J層・仮説規律）→v1.4.1（4状態・18明細・方式B・未来情報・候補ブランチ）→**v1.5（選択バイアス遮断・NOT_ELIGIBLE論理化・E8結果分離・canonical統合）＝BASELINE_FROZEN**。

> **本書をもって設計工程を終了する。以後の全変更はBUGFIX／BLOCKER／候補ブランチのみ。次工程：Wave 0実データ取得・ゴールド60件・LCS-1.5.0プロンプト。**
