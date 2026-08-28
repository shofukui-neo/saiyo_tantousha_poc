# エントリーページURL → 利用ATS判定

エントリーページのURL（例 `https://www.career-cloud.asia/27/form/entry?id=16849397703997`）から、
その企業が使っている採用管理システム（ATS）を判定する。

| 例 | 判定 | ベンダー |
|---|---|---|
| `career-cloud.asia` | 採用一括かんりくん（管理くん） | HRクラウド |
| `job.axol.jp` / `mail.axol.jp` | アクセスオンライン（AOL/AOLC） | マイナビ |
| `hrmos.co` | HRMOS採用（ハーモス） | ビズリーチ |
| `sonar-ats.jp` / `i-web.jp` / `jobsuite.jp` / `ats.jobcan.jp` … | 各ATS | — |
| `job.rikunabi.com` / `job.mynavi.jp` など | ナビ媒体（ATSではない） | — |
| `docs.google.com/forms` / `form.run` / Contact Form 7 | 汎用フォーム＝**ATS未導入シグナル** | — |
| `mochica.jp` | MOCHICA（自社）＝既存顧客 | ネオキャリア |

> この機能を別プロジェクトで作り直す（AIに書かせる）ための仕様プロンプト: [ats-detection-prompt.md](./ats-detection-prompt.md)

## 使い方

```bash
# 単発（URLだけで即判定・ネットワーク不要）
npm run ats -- --url "https://www.career-cloud.asia/27/form/entry?id=16849397703997"
npm run ats -- --url "https://job.axol.jp/27/s/x/entry" --json

# 一括（CSVに ATS 列を付ける）
npm run ats -- --in data/leads-mochica-target.csv --out data/leads-ats.csv

# 一括＋ライブ取得（URLで決まらない行だけページを取得し、埋め込みフォームまで見る）
npm run ats:live -- --in data/leads-mochica-target.csv --out data/leads-ats.csv --conc 3
```

主なオプション:

| フラグ | 意味 |
|---|---|
| `--url-col <列名>` | エントリーURLの列。省略時は `エントリーURL`/`採用ページURL`/`URL` などから自動検出 |
| `--live` | URLだけで決まらない行のみページ取得（robots遵守・polite.js経由） |
| `--live-all` | ATS判明済みの行も取得（媒体併用・取りこぼしを潰す時） |
| `--only-unknown` | 既に `ATS` 列が埋まっている行はスキップ（差分埋め・再実行向け） |
| `--fill-col <列名>` | 既存列（例 `カスタム情報：利用中ATS`）の**空セルだけ**を判定結果で埋める。CRM由来の既存値は上書きしない |
| `--limit N` / `--conc N` | 件数上限 / 並列数（既定3） |

出力に付く列: `ATS` `ATSベンダー` `ATS種別` `ATS確度` `ATS根拠` `ATS併用` `営業メモ` `ATS判定日`

## 判定の仕組み（[src/ats.js](../src/ats.js)）

確度の高い順に3系統。最初に当たったものを主判定、残りを `ATS併用` に落とす。

1. **エントリーURLのホスト**（確度 0.95）— `career-cloud.asia` → かんりくん。
   サブドメインは一致扱い（`job.axol.jp` = `axol.jp`）だが、部分文字列は一致させない
   （`career-cloud.asia.evil.com` は不一致。`.` 境界必須）。
2. **リダイレクト後の最終URL**（0.90）— 自社ドメインからATSへ飛ばす構成。
3. **HTML内の埋め込み**（0.85）/ **本文マーカー**（0.60）— 自社サイトに `iframe`/`script`/`form action` で
   フォームを埋め込む構成はURLに出ないため、この経路が必須。`src`/`href`/`action`/`data-src` の
   絶対URLホストを見る（自ホストへの参照は捨てる）。

種別は `ats`（競合＝リプレイス提案） > `form`（自作フォーム＝新規導入の最有力） > `media`（媒体のみ） > `sns` の順で優先する。
媒体リンクが同居していても、入っているATSが主判定になる。

## ベンダーの追加

コードを触らずに `data/ats-registry.json`（任意・無ければ組込み定義のみ）で追加・上書きできる。

```json
[
  { "id": "example-ats", "name": "サンプル採用管理", "vendor": "サンプル株式会社",
    "kind": "ats", "hosts": ["example-ats.jp"], "htmlMarkers": ["example-ats"], "note": "" }
]
```

`id` が既存と同じなら既存定義にマージ（`hosts` の差し替えなど）。
1つのホストを複数ベンダーに割り当てると判定が非決定になるため、[test/ats.test.js](../test/ats.test.js) が重複を検出する。

## スコアリングへの接続

既存のスコアリングは BALES の `カスタム情報：利用中ATS` を見ています
（[`build-boshudan-list.js`](../src/build-boshudan-list.js) は「他社ATSなし+8／ATS不明+4」、
[`score-sf-leads.js`](../src/score-sf-leads.js) / [`score-expo-leads.js`](../src/score-expo-leads.js) は
「他社ATS導入」を減点根拠に使う）が、この列は手入力のため**空が多い**。
本機能はその空欄をエントリーURLから機械的に埋めるためのものです。

```bash
# 空セルだけ補完（既存のCRM値は上書きしない）。ATS列と食い違う行は監査できるよう両方残る
npm run ats -- --in data/leads.csv --out data/leads-ats.csv --fill-col "カスタム情報：利用中ATS"
```

## 全企業スイープ（[src/enrich-ats-all.js](../src/enrich-ats-all.js)）

エントリーURLが分かっていない企業も含めて、**手元の全社**を公式サイトから辿って判定する。
母集団は `leads-consolidated-all.csv` ＋ `leads-mochica-target.csv` ＋ BALES を**ホストで名寄せ**したもの（実測 11,232社）。

```bash
npm run ats:all                     # 全社スイープ（数時間。バックグラウンド推奨）
npm run ats:all -- --conc 16        # 並列数（既定12）
npm run ats:all -- --limit 200      # 先頭N社だけ試走
npm run ats:all -- --only-unknown   # CRMで利用中ATSが判明済みの社を飛ばす
npm run ats:all:rebuild             # 取得せずジャーナルからCSVだけ再生成
```

1社あたりの手順（見つかった時点で打ち切り・最大3取得）:

1. **URLホストだけで決まるなら取得しない**（`career-cloud.asia` など）
2. 起点ページ（採用ページURLがあればそれ、無ければ公式トップ）を取得 → HTML内の埋め込み/リンクから判定
3. トップ起点なら採用ページへ1hop（`recruit-page.js` の `findRecruitLinks`）
4. 採用ページ内の「エントリー/応募」リンクを1つだけ追う。**外部ホストならURLだけで判定できるので取得しない**

**中断・再開**: 1社1行の追記専用ジャーナル `data/ats-scan/journal.jsonl` に逐次書くので、
途中で止めても成果は残り、再実行すると済んだ企業を飛ばして続きから走る（`--no-resume` で最初から）。

出力 `data/ats-scan/ats-scan-all.csv` には `CRMとの一致` 列があり、
CRMの手入力値とURL判定の食い違いを監査できる。
**媒体リンク（マイナビ等）はATSの証拠にならない**ので、「一致／不一致」を出すのはATS種別が取れた時だけ。
（CRMが「無し」なのにURLでATSが出た＝CRMが古い、が最も多い更新パターン）

## ツール別リストの作成（[src/build-ats-lists.js](../src/build-ats-lists.js)）

「どの管理ツールを使っているか」でBALES既存リードを切り分け、**ツールごとに1本ずつ**リストを出す。
競合ごとに刺さるトークが違うため、束ねて渡せる形にするのが目的。

```bash
npm run ats:lists                                   # data/ats-lists/ に出力
npm run ats:lists -- --min 5                        # 5社未満のツールは個別ファイルを作らない
npm run ats:lists -- --include-none                 # 「無し（ATS未導入）」層も出す
npm run ats:lists -- --enrich data/leads-ats.csv    # URL判定の結果も合流（CRMが空の行だけ）
npm run ats:lists -- --keep-it --keep-small         # ICP除外を外して母数を見る
```

ATSの出どころは2系統で、**CRMの実測値が優先**（人が聞き取った事実をURL推定で上書きしない）。

1. `カスタム情報：利用中ATS`（手入力・表記ゆれあり）→ `normalizeAtsName()` で名寄せ
   （`sonarATS`／`SONAR` → sonar ATS、`採用一括かんりくん`／`管理くん` → 採用一括かんりくん）
2. `--enrich` に渡した [enrich-ats.js](../src/enrich-ats.js) の出力（エントリーURLからの機械判定）→ CRMが空の行だけ補完

除外・名寄せ・採点は [build-boshudan-list.js](../src/build-boshudan-list.js) と同じ基準:
アプローチ禁止／架電拒否／新卒なし・担当外／採用1~2名／電話なし／商談進行中・受注済み／
MOCHICA既存顧客／IT業種／従業員100名未満（判明時のみ）を落とし、`company-match` で1社1行にする。

採点は透明な加点式（新卒6名以上+22／規模スイート+18／名指し可+12／母集団課題を明言+18／
検討開始が3ヶ月以内+14／過去商談あり+8／直近1年に接点+8）で、**A：今週架電（60+）／B：次点（44-59）／C：ナーチャリング**。
加点根拠は1社ごとに `スコア根拠` 列へ出ます。

出力（`data/ats-lists/`）:

| ファイル | 用途 |
|---|---|
| `ATS別-{ツール名}-取込用.csv` | BALESCLOUD取込用（原本の列・値そのまま／Noだけ振り直し） |
| `ATS別-{ツール名}-根拠.csv` | 架電者が読むレビュー用（優先度・スコア根拠・母集団ニーズ根拠つき） |
| `_全ツール横断-根拠.csv` | 全ツールを1枚で見比べる用 |
| `_ATS別サマリ.csv` | ツール別の社数・A/B/C・名指し可・新卒6名以上 |

> 個人情報を含みます。取り扱いは [SECURITY.md](../SECURITY.md) に従い、納品時はダウンロードフォルダへ移動してください。

## テスト

```bash
npm run test:ats     # 88アサーション。`npm run test:all` にも組み込み済み
```
