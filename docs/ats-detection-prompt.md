# エントリーページ → ATS判定 再現プロンプト（そのまま貼って使う）

> 用途：この機能（[src/ats.js](../src/ats.js) ＋ [src/enrich-ats.js](../src/enrich-ats.js)）を、
> 別プロジェクト・別言語でゼロから作らせるための仕様プロンプト。既存コードを見せずに、
> このプロンプトだけで同じ判定結果になるように書いてある。
> 仕様の読み物版は [ats-detection.md](./ats-detection.md)。

---

## ここから貼り付け ↓↓↓

新卒採用管理システム（ATS）「MOCHICA」の営業リスト作成のため、**企業のエントリーページURLから
その企業が使っているATSを機械判定するモジュール**を実装してください。以下の仕様に厳密に従うこと。

### 0. 前提と設計方針

- 言語は Node.js（CommonJS、外部依存なし）。※別言語へ移す場合もロジック・数値・優先順位は変えない。
- **判定ロジックはネットワークを触らない純関数**にする。HTMLは呼び出し側が渡す。
  ページ取得はCLI層だけが行う（テスト可能性とrobots遵守のため）。
- 判定は「当たったら終わり」ではなく**複数候補を確度つきで集め、ランク付けして1つに決める**。
  次点は `others` として残す（媒体併用が読めるため営業上の情報になる）。

### 1. なぜ作るか（判定結果の使い道 ＝ 出力の意味づけ）

| 判定 | 営業上の意味 |
|---|---|
| 競合ATS（sonar / i-web / AOL …） | 既に導入済み → リプレイス提案。切替時期の見極め対象 |
| 汎用フォーム（Googleフォーム / Contact Form 7 …） | **ATS未導入の最有力シグナル** → 新規導入提案 |
| ナビ媒体のみ（リクナビ / マイナビ …） | 媒体経由エントリーのみ → ATS未導入の可能性 |
| 自社（MOCHICA） | 既存顧客 → リストから除外 |

この4分類が崩れると営業リストが壊れるため、**種別（kind）の取り違えを最も重い不具合**として扱うこと。

### 2. ベンダー定義（レジストリ）

1ベンダー1レコードの配列としてコード内に持つ。フィールド：

- `id`（英小文字ケバブ、一意）／ `name`（正規名・日本語表記そのまま）／ `vendor`（提供会社）
- `kind`: `'ats' | 'media' | 'form' | 'sns'` のいずれか
- `hosts`: 登録可能ドメインの配列（例 `['axol.jp']`）。サブドメインは一致扱い
- `pathHosts`: ホストだけでは決まらないもの。`{ host, path }`（path は正規表現文字列）
- `htmlMarkers`: ページHTML内の文字列マーカー（ホストが取れない埋め込み構成の保険）
- `aliases`: CRMの手入力表記ゆれ（後述の名寄せ用）
- `own`: 自社サービスなら `true`（MOCHICAのみ）
- `note`: 営業向けの短い注記

**最低限これだけは収録する**（`id` は下記のとおりにすること。テストが `id` を見る）：

*ATS（競合）*
`kanrikun` 採用一括かんりくん / HRクラウド株式会社 / `career-cloud.asia`（別名: 管理くん・管理君・かんりくん）｜
`aol` アクセスオンライン（AOL/AOLC） / マイナビ / `axol.jp`（別名: AOL・AOLC・アクセスオンライン）｜
`hrmos` HRMOS採用（ハーモス） / ビズリーチ / `hrmos.co`（別名: HRMOS・HARMOS・ハーモス）｜
`iweb` i-web / ヒューマネージ / `i-web.jp`（別名: iweb・アイウェブ）｜
`sonar` sonar ATS / Thinkings / `sonar-ats.jp`（別名: sonar・SONAR・ソナー）｜
`jobsuite` JobSuite / ステラス / `jobsuite.jp`｜
`jobcan` ジョブカン採用管理 / DONUTS / `jobcan.jp`,`jobcan.ne.jp`（エントリーは `ats.jobcan.jp`）｜
`herp` HERP Hire / `herp.careers`,`herp.cloud`｜ `talentio` Talentio / `talentio.com`｜
`saiyo-kakaricho` 採用係長 / ネットオン / `saiyo-kakaricho.com`｜
`engage` engage / エン・ジャパン / `en-gage.net`｜
`mochica` MOCHICA / ネオキャリア / `mochica.jp`（`own: true`）｜
`caritas-contact` キャリタスContact / ディスコ（**hosts空**・マーカーと別名のみ）｜
`line-saiyo-connect` LINE採用コネクト / LINEヤフー（**hosts空**）｜
外資: `greenhouse` `lever` `workday`（`myworkdayjobs.com`）`smartrecruiters` `workable` `successfactors` `taleo`

*ナビ媒体（kind: media）* `rikunabi`（`rikunabi.com`）`mynavi`（`mynavi.jp`）`career-tasu`（`career-tasu.jp`）
`gakujo`（`gakujo.ne.jp` あさがくナビ）`onecareer` `indeed`

*SNS/逆求人（kind: sns）* `offerbox` `kimisuka` `wantedly`

*汎用フォーム（kind: form）* `google-forms`（`forms.gle` ＋ pathHosts `docs.google.com` の `^/forms/`）
`formrun`（`form.run`）`formzu`（`formzu.net`,`formzu.com`）`form-mailer` `hubspot-forms`（`hsforms.com`,`hsforms.net`）
`tayori` `wpcf7`（**hosts空**・マーカー `wpcf7` / `contact-form-7` のみ＝自作フォーム）

> `hosts` が空の定義（キャリタスContact・LINE採用コネクト・Contact Form 7）を許すこと。
> ドメイン未確認でも、CRM表記の名寄せとHTMLマーカーには使うため。

**拡張点**：`data/ats-registry.json`（任意・無ければ組込み定義のみ）を読み、同じ `id` があれば
既存定義にマージ、無ければ追加する。コードを触らずベンダーを足せること。
読み込み結果はキャッシュし、テスト用にキャッシュを捨てる関数も公開する。

### 3. 判定ロジック（本体）

#### 3-1. URLの下ごしらえ
- `career-cloud.asia/27/form/entry` のような**スキーム無しの文字列も救う**（`https://` を補って解釈）。
- ホストは `www.` を除去し小文字化する。パースできなければ「判定不能」（例外を投げない）。

#### 3-2. ホスト一致の規則（ここが誤検知の急所）
完全一致、または **`.` 境界つきの後方一致**のみ一致とする。部分文字列一致は禁止。

- `job.axol.jp` は `axol.jp` に一致する
- `myaxol.jp` は `axol.jp` に**一致しない**
- `career-cloud.asia.evil.com` は `career-cloud.asia` に**一致しない**

#### 3-3. 3系統の判定と確度

| # | 経路 | 確度 | source |
|---|---|---|---|
| 1 | エントリーURLのホストが `hosts` / `pathHosts` に一致 | **0.95** | `url` |
| 2 | リダイレクト後の最終URLが一致（元URLとホストが違う時のみ） | **0.90** | `redirect` |
| 3 | HTML内の埋め込みリソースのホストが一致 | **0.85**（pathHostsのホストのみ一致は 0.75） | `embed` |
| 4 | HTML本文に `htmlMarkers` の文字列が出現（大小無視） | **0.60** | `marker` |

3の埋め込み抽出ルール（**自社ドメインにATSフォームを埋める構成はURLに出ないため、この経路が必須**）：

- `src` / `href` / `action` / `data-src` 属性の値を全て拾う（iframe・script・form・a で属性名は共通）。
- **絶対URLのみ**対象。相対パス・`data:`・`mailto:` は捨てる。`//host/…` のプロトコル相対は `https:` を補う。
- **自ホスト（baseUrl と同じホスト）への参照は捨てる**（自社サイト内リンクはノイズ）。
- 4のマーカー判定は、同じベンダーが3で既に当たっていればスキップ（確度を下げないため）。
- 同一ベンダーが複数経路で当たったら**確度の高い方を採用**して1件に畳む。

#### 3-4. 最終ランク付け
候補を `id` で畳んだうえで、**種別優先 → 確度**の順にソートする。
種別の順位は `ats(3) > form(2) > media(1) > sns(0)`。

> つまり「マイナビへのリンク（確度0.95）」と「iframeのsonar（確度0.85）」が同居していたら、
> **sonarを主判定**にしてマイナビは `others` へ落とす。媒体リンクは自社ATSの有無を否定しないため。

戻り値は次の形（未判定は `found:false` と空文字・0で埋めた同形を返す）：
`{ found, id, name, vendor, kind, kindLabel, own, note, confidence, evidence, source, others[] }`

`kindLabel` は `ats:採用管理システム / media:ナビ媒体 / form:汎用フォーム / sns:SNS・スカウト`。
`evidence` は日本語の一言で根拠を残す（例 `URLホスト job.axol.jp` ／ `埋め込みリソース example.sonar-ats.jp` ／ `HTML内マーカー "wpcf7"`）。

#### 3-5. 営業メモ（1行の文言生成）
判定結果から次の文字列を返す関数を作る：
未判定→`判定不能（要目視）` ／ `own`→`既存顧客（MOCHICA導入済み）` ／ ats→`競合ATS導入済み（<vendor>）＝リプレイス提案` ／
form→`ATS未導入の可能性大＝新規導入提案` ／ media→`媒体エントリーのみ＝ATS未導入の可能性` ／ sns→`スカウト媒体のみ＝ATS未導入の可能性`。

### 4. CRM表記の名寄せ（同じモジュールに同梱）

CRMの「利用中ATS」列は自由入力で `sonarATS` / `SONAR`、`採用一括かんりくん` / `管理くん` のように割れる。
比較キーは **全角英数→半角、小文字化、空白・記号（`・` `ー` `-` `_` `.` `,` `/` 括弧など）を除去**して作る
（これで `i-web` と `iweb`、`ＨＲＭＯＳ` と `HRMOS` が同一になる）。
`id` / `name` / `aliases` を同じキーに変換して突合し、次の status を返す：

- `known`：定義に当たった（`name` は正規名、`vendor` も返す）
- `none`：`無し|なし|無|未導入|導入なし|使っていない|特になし|none` に完全一致 → `name: '無し（ATS未導入）'`
- `empty`：空文字
- `unknown`：定義に無い製品名。**`name` は原文のまま、`vendor` は空**（ベンダーを推測しない）。
  `id` は `other:<比較キー>` とし、表記ゆれ違いの同一製品が同じIDに寄るようにする

### 5. CLI層（ネットワークを触るのはここだけ）

```
node src/enrich-ats.js --url "<エントリーURL>" [--live] [--json]
node src/enrich-ats.js --in <入力.csv> --out <出力.csv> [--live|--live-all] [--conc 3] [--limit N] [--only-unknown] [--url-col <列名>] [--fill-col <列名>]
```

- **URL列の自動検出**：`エントリーURL`→`エントリーページURL`→`応募URL`→`採用ページURL`→`URL`… の候補名を優先。
  無ければ列名に `URL` を含む列、それも無ければ先頭50行の値が `http` で始まる列。見つからなければエラー終了。
- **`--live` の取得条件**：URLだけで**ATSが確定した行は取りに行かない**（無駄打ち防止）。
  未判定 or 種別がATS以外の行だけ取得する。`--live-all` は全行取得。
  取得はrobots遵守のフェッチャ経由（静的HTML）。取得失敗しても落とさず、根拠列に `取得失敗:<理由>` を残す。
- **追加する列**：`ATS` `ATSベンダー` `ATS種別` `ATS確度`（小数2桁の文字列）`ATS根拠` `ATS併用`（`others` を ` / ` で連結）`営業メモ` `ATS判定日`（YYYY-MM-DD）。既存列の後ろに足す。
- **`--fill-col <列名>`**：指定した既存列（例 `カスタム情報：利用中ATS`）の**空セルだけ**を判定結果で埋める。
  **CRM由来の既存値は絶対に上書きしない**（人が聞き取った事実を推定で塗り潰さないため）。
- 並列ワーカー（既定3）で回し、**20件ごとに出力CSVをアトミック書き込みで途中保存**。
  終了時にベンダー別の件数集計を降順で標準出力へ。

### 6. 受け入れ条件（このまま自動テストにすること）

1. `https://www.career-cloud.asia/27/form/entry?id=…` → `採用一括かんりくん` ／ vendor `HRクラウド株式会社` ／ kind `ats` ／ 確度 ≧0.9
2. `job.axol.jp` と `mail.axol.jp` が同じ `aol`。`HTTPS://JOB.AXOL.JP/…`（大文字）も同じ。スキーム省略URLも判定できる
3. `career-cloud.asia.evil.com` ／ `notcareer-cloud.asia` は**判定不能**。空文字・`担当者に確認` のような非URLも判定不能
4. 未登録の自社ドメイン `https://example.co.jp/recruit/entry/` は、URLだけでは判定不能
5. `<iframe src="https://example.sonar-ats.jp/form/abc">` を含むHTML → `sonar`、source `embed`、確度は 0.95未満かつ0.7以上
6. `<script src="//career-cloud.asia/js/form.js">`（プロトコル相対）→ `kanrikun` ／ `<form action="https://job.axol.jp/…">` → `aol`
7. 自ホストへの `<a href>` のみ、または相対 `<iframe src="/form/entry">` のみ → 候補ゼロ
8. `<div class="wpcf7 wpcf7-form">` → `wpcf7`、確度は埋め込み（0.85）より低い
9. `finalUrl` が `https://job.axol.jp/…` → `aol`、source `redirect`
10. sonarのiframe＋マイナビへのリンクが同居 → 主判定 `sonar`、`others` に `mynavi` が残る
11. `job.rikunabi.com/…` は kind `media`。`docs.google.com/forms/…` は `google-forms`、`docs.google.com/spreadsheets/…` は判定不能
12. 営業メモ：sonar→「リプレイス」を含む／mochica→「既存顧客」／`form.run`→「新規導入」／リクナビ→「未導入」／未判定→「目視」
13. 定義の健全性：`id` 重複なし／`kind` は4種のみ／**1ホストが複数ベンダーに割り当てられていない**（判定が非決定になるため必ず検査する）
14. 名寄せ：`sonarATS`＝`SONAR`、`管理くん`＝`管理君`＝`採用一括かんりくん`、`i-web`＝`iweb`、`HARMOS`→`hrmos`、`ＨＲＭＯＳ`→`hrmos`、前後空白つき `ジョブカン`→`jobcan`、`無し`／`なし`→`none`、空文字→`empty`
15. 名寄せ（未登録）：`HRPRIME`→ status `unknown`・name は原文・vendor 空。`HRPRIME` と `hrprime` は同一ID、`らくるーと` は別ID
16. CLI：URL列の自動検出4パターン／`ATS確度` が `"0.95"` の文字列／取得失敗時は `ATS根拠` が `取得失敗:robots-disallow` で `ATS` は空

### 7. やらないこと（明示的な非目標）

- 判定できない企業に**推測で埋めない**。未判定は未判定のまま残す（`ATS根拠` に理由を書く）。
- 媒体リンクを「ATS導入の証拠」として扱わない（CRMとの突合でも、媒体のみの行は不一致判定にしない）。
- ヘッドレスブラウザでのレンダリングは既定にしない（静的HTMLで足りる。robots・負荷の観点）。

## ここまで ↑↑↑

---

## 元実装との対応（社内向けメモ）

| プロンプトの節 | 実装 |
|---|---|
| 2. レジストリ ／ 3. 判定 ／ 4. 名寄せ | [src/ats.js](../src/ats.js) |
| 5. CLI | [src/enrich-ats.js](../src/enrich-ats.js)（`npm run ats` ／ `npm run ats:live`） |
| 6. 受け入れ条件 | [test/ats.test.js](../test/ats.test.js)（`npm run test:ats`） |

エントリーURLが未知の企業まで公式サイトから辿る全社スイープ（[src/enrich-ats-all.js](../src/enrich-ats-all.js)）と、
ツール別リスト生成（[src/build-ats-lists.js](../src/build-ats-lists.js)）は本プロンプトの範囲外。
必要なら [ats-detection.md](./ats-detection.md) の該当節を追加で貼ること。
