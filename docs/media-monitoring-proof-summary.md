# 新卒媒体 横展開 実証サマリ（自律実証ラン総括）

問い: 「求人ボックス以外にも、大手・地方系・専門職など**あらゆる新卒媒体**でリアルタイム鮮度監視が実現できるか」
作成: 2026-06-19 ／ 関連: [設計](monitoring-design.md)・[評価報告書](monitoring-evaluation-report.md)・[媒体マトリクス](media-monitorability.md)

---

## 1. 結論
**実現可能。ただし「公開の求人/企業一覧を静的に持つ媒体」に限る。** 鮮度の取り方は媒体タイプで異なるが、いずれも同一の熱量モデルで吸収できる。実機で**3媒体（求人ボックス＋リクナビ＋キャリタス就活）の横断監視サイクルが動作**することを実証し、評価報告書で挙げた**2大Blockerも解消**、ロジックは**機能テスト36件で回帰保護**済み。

逆求人・スカウト型（OfferBox/キミスカ/LabB/レバテック）、エージェント型（キャリアチケット）、口コミ掲示板（みん就）、行政POSTフォーム（ハローワーク/しょくばらぼ）は、公開一覧を持たない or 静的取得できず、**静的監視には構造的に不適**。

## 2. 媒体タイプ別「鮮度取得モード」（本ランで確定した最重要知見）
| タイプ | 例 | 静的HTMLの粒度 | 鮮度の取り方 | システムでの扱い |
|---|---|---|---|---|
| 求人アグリゲータ型 | 求人ボックス | 求人カード単位 | **掲載日ベース**「N日前/新着」 | recencyDays→係数×1.5〜 |
| 新卒ナビ型 | リクナビ・キャリタス・マイナビ | 企業名中心・メタ薄 | **出現/エントリー状態ベース** | NEW/REAPPEARED＋recencyDays=null(中立) |
| 逆求人/エージェント/口コミ/行政 | OfferBox等 | 公開一覧なし/POST/JS | — | 対象外 or presenceのみ |

「鮮度」は単一指標でなく媒体タイプで取得経路が異なる。本システムは掲載日係数とNEWイベントの両方を扱い、**無い情報は捏造しない**（recencyDays=nullは中立）。

## 3. 実装した観測器（3媒体・実機検証済URL）
| 媒体 | 一覧URL | セレクタ | 種別 |
|---|---|---|---|
| 求人ボックス | (検索) …の仕事?pg= | `.p-result_card`/`.p-result_company` | アグリゲータ（掲載日◎） |
| リクナビ | /2027/search/?kw= | `[class*="companyName__"]`（CSS Modulesハッシュに頑健） | 新卒ナビ（出現） |
| キャリタス就活 | /employment-search/ | `.c_panelCompanyInfoMain__ttl` | 新卒ナビ（出現/エントリー） |

実証サイクル: 66社＝求人ボックス24＋リクナビ30＋キャリタス12 が**1ランキングに重複0で合流**。拡張は `snapshot.js` の `LIST_ADAPTERS` に `{name, searchUrl, companySel, cardSel?}` を足すだけ。`MONITOR_SOURCES` で観測網を限定可。

## 4. 評価報告書 2大Blocker の解消（実証付き）
- **① キャッシュTTL（real-time成立）**: polite.js に `maxAgeMs` を追加、監視は短TTL（既定30分、`--watch`は間隔の半分を自動設定）。実測: 短TTLは2回目も5.1秒で再取得＝変化検知可／7日TTLは2回目0.35秒でキャッシュ＝検知不能。
- **② 真の掲載鮮度**: 全観測器が `parseRecencyDays`（新着/本日/N日前/週間前/絶対日付）を抽出→`recencyFactor` で熱量に乗算＋rankのタイブレーク第一位。実測: 本日掲載18.0＞8-10日前12.6＞15日+12.0で「本当に新しい掲載」が上位化。

## 5. ソース間公平化（本ランで発見＆解消）
媒体ごとに職種抽出粒度が違うと熱量が不公平（リクナビは社名のみ→ICP係数が発火せず劣後）。
→ `icpFactor` を**スクレイプ職種＋ヒットしたクエリ語**の両方で判定。実証: 修正後リクナビ30社が求人ボックス24社と同列(12.0)に。

## 6. 方法論上の訂正（誠実性の記録）
初回プローブの「STATIC_OK」一部は**ホームページを叩いた偽陽性**（企業ロゴのカルーセルを企業密度と誤計上）。検索URLで叩いた媒体だけが信頼でき、`discover-endpoint.js`（トップHTMLリンク解析）で実URLを特定する手法が有効。盲目的URL推測は限界（推測群は全滅）。

## 7. テスト
`npm run monitor:test`（`test/monitor.test.js`）= 36アサーション全パス。
parseRecencyDays/eventWeight/recencyFactor/icpFactor(公平化)/diffSnapshots(全イベント種)/applyCycle(熱量・72h半減・REAPPEARED)/rank(鮮度タイブレーク)/autonomy.evolve(増殖・撤退) をネットワーク非依存で回帰保護。

## 8. 残課題・推奨
1. 新卒ナビ型で掲載日まで取るには Playwright で詳細ページ展開（コスト対効果要検討。出現ベースで実用上は足りる見込み）。【未・ROI要検討】
2. ~~固定URL観測器の同一URL重複取得~~ → 解決済（`fixedUrl`フラグで1回取得＋中立クエリ帰属＋dedupe）。
3. 評価報告書3階層の効果測定（②鮮度精度・③下流アポ率/リフト）は実運用データ蓄積後に `source-kpi.js` で実施。【要・運用データ】
4. ~~偽差分抑制（多数決GONE）~~ → 解決済（`missStreak`で2サイクル連続不在を確定不在とし、点滅復帰のREAPPEARED誤発火を抑制。`MONITOR_GONE_CONFIRM`）。

→ コード側の実装バックログ（2・4）は解消。残るは①(大規模・ROI要検討)と③(運用データ待ち)で、いずれも現時点で着手するより運用判断・データ蓄積が先。

## 9. 成果物
- 監視エンジン: `src/monitor/{store,snapshot,diff,heat,report,autonomy,run}.js`
- 実証ハーネス: `src/monitor/{probe-media,probe-variants,discover-endpoint,media-catalog}.js`
- テスト: `test/monitor.test.js`
- ドキュメント: 本書／`monitoring-design.md`／`monitoring-evaluation-report.md`(付録A〜C)／`media-monitorability.md`
- データ: `data/monitor/{media-probe.json, hottest.{md,csv}, heat-state.json, …}`
- 実行: `npm run monitor`(1サイクル)／`monitor:watch`(常駐)／`monitor:test`(テスト)

## 10. 実証イテレーション履歴（自律ラン）
1 媒体カタログ30件プローブ → 2 URL修復(マイナビ/ワンキャリア) → 3 適用境界の確定 → 4 マルチソースend-to-end → 5 ソース間公平化 → 6 真の掲載鮮度(Blocker②) → 7 キャッシュTTL(Blocker①) → 8 媒体タイプ別鮮度モード確定 → 9 ホームページ偽陽性の訂正・検証済URL特定 → 10 キャリタス観測器追加(3媒体) → 11 機能テスト36件 → 12 本サマリ統合。
