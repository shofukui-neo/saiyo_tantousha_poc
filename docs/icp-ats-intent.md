# ICP適合 × ATS未導入 × インテントシグナルあり → BALESCLOUD取込

作成: 2026-09-03 ／ 実装: `src/build-icp-ats-intent.js`（統合）・`src/enrich-url-gbiz.js`（URL補完）／ `npm run icp:ats:intent`

## 何を出すか

層1（ICPハード条件＋他社ATS未導入）と層2（タイミングシグナル）を1本に結び、
「今かけるべき社」だけを BALESCLOUD の266列構造で出す。

| 出力 | 中身 |
|---|---|
| `data/leads-bales-icp-ats-intent.csv` ★ | BALES取込形式。既存被りなし（完全新規）のみ |
| `data/leads-bales-icp-ats-intent-withsf.csv` | 同形式。SF既存リード被りを含む参考版（取込には使わない） |
| `data/leads-icp-ats-intent.csv` | 根拠つき詳細（ICP根拠／ATS根拠／なぜ今／推奨トーク） |
| `data/leads-icp-ats-intent-report.md` | 件数内訳・落ちた理由・上位20社 |

BALESの `カスタム情報：顧客の現状 / 顧客の課題感 / 活動予定コメント` に
ATS状態・インテント階層・最有力シグナル・「なぜ今」・推奨トークを載せてあるので、架電者はBALES画面だけで文脈を持てる。

## 3条件の定義

| 条件 | 判定 | 根拠列 |
|---|---|---|
| ICP適合 | `icp-rules.js` のハードゲート: 官公庁ブロック（社名＋**自治体ドメイン**）／IT除外／従業員100名未満・新卒6名未満は判明時のみ除外。採用人数は 実績(直近年)＞年間新卒採用人数＞採用予定 の順で採る | `ICP根拠` |
| ATS未導入 | `enrich-ats.js` の `ATS判定 = 未導入`（要確認・不明・導入済は落とす） | `entry_type` `エントリー動線` `ATS根拠` |
| インテント確認 | `intent-analyze.js` の階層 **C以上**（スコア10点以上＝検知シグナルが1つ以上生きている）。`--tier B` で厳しく | `検知シグナル` `なぜ今` `根拠` |

## 2つの経路（母集団が別）

| 経路 | 母集団 | 流れ | 実測 |
|---|---|---|---|
| A | ATS判定済み600社のうち未導入230社（統合マスタ。担当者名あり） | `_tmp-ats-mi.csv` → `intent-analyze --sources csv,mynavi` → 結合 | 230 → インテントC以上83 → ICP通過**50**（うち完全新規9・SF被り41） |
| B | インテント採点済み2,000社（完全新規×ICP上位、`leads-fresh-top2000.csv`）のC以上1,560社 | `enrich-url-gbiz`（公式URL補完）→ `enrich-ats` → 結合 | 1,560 → URL取得554 → ATS未導入168 → **168**（全て完全新規） |
| 合計 | 経路間の重複3社を除去 | | **214社**（A経路49＋B経路165／完全新規173／階層A24・B97・C93） |

経路Bのボトルネックは**公式URLの欠損**（1,560社中22社しか持っていない）。
マイナビ会社概要には企業ホームページ欄が無いので、gBizINFO を社名で検索→法人番号→詳細APIで `company_url` を引いた
（検索APIの応答はURLを落とすので詳細APIが必須。一致1,209社／URL付与532社＝34%）。
残り1,006社はURLが無くATS判定不能＝**この層の上限は判定精度ではなくURL保有率**。

## 再実行手順

```bash
# 経路A: ATS未導入の社にインテントを足す
node src/intent-analyze.js --in data/_tmp-ats-mi.csv --sources csv,mynavi --conc 4 \
  --out data/_tmp-intent-atsmi.csv --report data/_tmp-intent-atsmi.md
#  → 統合マスタ列（ATS判定/既存被り/担当者名…）を企業名で結合して data/icp-ats-intent-routeA-input.csv

# 経路B: インテント陽性の社に公式URL→ATS判定を足す
node src/enrich-url-gbiz.js --in data/icp-ats-intent-routeB-input.csv        # gBiz 700ms間隔・約30分/1500社
SCRAPE_MAX_RETRY=1 PER_PAGE_TIMEOUT_MS=8000 SCRAPE_DELAY_MS=1500 \
  node src/enrich-ats.js --in data/icp-ats-intent-routeB-input.csv --out data/icp-ats-intent-routeB-ats.csv --conc 8

# 統合 → BALES
npm run icp:ats:intent          # = build-icp-ats-intent.js --in routeA,routeB
```

`format-bales.js` は `--no-record --no-dedupe-history` で呼ぶ（納品台帳には書かない）。台帳に載せたいときは
`node src/format-bales.js --in data/leads-icp-ats-intent.csv --scope fresh --batch <名前>` を別途叩く。

## 実データで踏んだ罠

- **undici の `assert(!this.paused)`**: 特定ホストのソケット終端で fetch 層がプロセスごと落ちる（`harvest-adaptive.js` と同じ症状）。
  `enrich-ats.js` に `uncaughtException` の継続処理と `PROBE_TIMEOUT_MS`（既定90秒）の打ち切りを入れた。落ちても台帳（`ats-status.json`）は25社ごとに保存されるので再実行で続きから走る。
- **「愛知株式会社」= 愛知県庁**（公式URLが `pref.aichi.jp`）。社名に法人格が付いていて `isGovernmentOrg` を素通りしたので、自治体ドメイン（`pref./city./town./vill./.lg.jp`）でもブロックするようにした。
- 経路Aは統合マスタの古い行が混ざり、採用人数<6で28社落ちた。落とした理由はレポートに残る。

## 伸ばすなら

- URL保有率がすべて。経路Bの1,006社に検索API（Google CSE / Brave / Serper のキーが `.env` に無い）で公式URLを引ければ、同じ歩留り（未導入30%）で+300社見込める。
- インテントは初回観測（観測回数1）なので「新設・切替」系は保有判定止まり。2サイクル目（`npm run intent` を再実行）で差分が立ち、A階層が増える。
