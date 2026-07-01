# マイナビ 採用担当者名 取得スキル（3パターン）

マイナビ新卒（job.mynavi.jp）から**採用担当者の実名**を取得するための確立済みスキル。
「どこに担当者名が載るか」を実DOMで調べて3つの定型パターンに整理し、各々を専用抽出器で堅く取る。
最終目的は **採用担当者名つき MOCHICA ターゲット企業 1000件** の生成。

---

## 3つの収集パターン（実DOM較正 2026-07）

| # | 場所 | ページ | 実例 | 抽出器 |
|---|------|--------|------|--------|
| ① | 伝言板の名乗り | `corp{id}/outline.html` | 「人事部の**青木**と申します。」 | `extractFromMessageBoard` |
| ② | インタビュー文末の帰属 | `corp{id}/outline.html` | 「＜(株)コロワイド … 人事企画部　**山野 誠一郎**さん＞」／「（**山野**さん）」 | `extractFromInterview` |
| ③ | 採用データの問合せ先 | `corpinfo/displayEmployment/index/?corpId=..&recruitingCourseId=..` | 「… 管理部　**川瀬**・伊藤 …」 | `extractFromEmployment` |

### ページ遷移（scraper が自動で辿る）
```
検索 or corpID
  └ outline.html        … ① 名乗り / ② インタビュー帰属
  └ employment.html     … 「採用データ」一覧。ここに displayEmployment へのリンク（募集コース分）
       └ displayEmployment/index?corpId&recruitingCourseId … ③ 問合せ先ブロック
  └ is.html / message.html … 旧レイアウトの問合せ先・担当者メッセージ（フォールバック）
```
※ ③の問合せ先は `employment.html` 自体には無く、その先の `displayEmployment` ページにある。
  scraper は `employment.html` から動的にリンクを収穫して辿る（最大2コース）。

---

## 設計の肝：構造アンカー＋緩い人名ゲート

マイナビ掲載は中小が多く、担当者姓が姓辞書（`jp-names`）に載らないことが多い（川瀬・山野…＝**母集団問題**）。
だが上記3つは「名乗り／さん／問合せ先の部署直後」という**強い構造**で人名を保証するため、
辞書一致を要求せず「2〜6字の漢字（間に1スペース許容）で、役割語／地名／業種語でない」なら人名として採用する
（`normPersonToken`）。辞書に載る姓は「姓 名」に整形して表記統一。

- `青木` → 辞書姓 → `青木`
- `山野 誠一郎` → 辞書外だがスペースで姓名境界を尊重 → `山野 誠一郎`
- `川瀬・伊藤` → 複数担当は先頭に正規化 → `川瀬`
- `管理部`／`岐阜`／`人事部` → 役割語・地名として却下

> 注意: strict な `isPlausiblePersonName` は辞書外5字フルネーム（山野誠一郎）を弾くため、
> 3パターンの一次抽出結果には**再ゲートを掛けない**（`normPersonToken` が検証済み）。

---

## ファイル

| ファイル | 役割 |
|----------|------|
| `src/mynavi-name-extract.js` | 3パターン抽出器 + `normPersonToken` + `extractMynaviName`（ページ種別ディスパッチ） |
| `test/mynavi-extract.test.js` | ユーザー提示の実文面での単体テスト（23アサーション） |
| `src/scrape-mynavi.js` | Playwright スクレイパ。`discoverCorpIds` / `scrapeByCorp` / `_chaseContact` で3面を巡回 |
| `src/build-mynavi-1000.js` | **discovery-first ハーベスタ**。検索で掲載SMEを列挙→3パターン抽出→1000件到達で停止（再開可能） |
| `src/build-mochica-mynavi.js` | 担当者名つき出力を MOCHICA アポ期待値モデルで採点→架電可能リスト化 |

---

## 使い方

```bash
# 単体テスト
node test/mynavi-extract.test.js

# 3例示企業でライブ確認（青木 / 山野 誠一郎 / 川瀬）
node -e '...' # docs参照

# 1000件ハーベスト（discovery-first・数時間・再開可能）
npm run mynavi:1000
#   = node src/build-mynavi-1000.js --out data/recruiter-mynavi-1000.csv --target 1000
#   中断しても data/recruiter-mynavi-1000.{csv,seen.txt} から再開。MYNAVI_POLITE_MS で間隔調整。

# MOCHICA採点（担当者名つき→架電リスト）
npm run mynavi:mochica
#   → leads-mochica-mynavi-named.csv    （全件・スコア降順）
#   → leads-mochica-mynavi-callable.csv （最高確度：電話×担当者名×氏名検証OK）
```

## 実測（スモーク: IT系20社）
- 担当者名 歩留まり **30%**（旧抽出器 ~16% から改善）
- 内訳: 伝言板の名乗り / インタビュー帰属 / 問合せ先 / 担当者メッセージ / メール推定 が混在

## シーズン更新
`MYNAVI_GRAD_YEAR`（既定 `27`＝マイナビ2027）は毎年の新卒サイト開設に合わせて更新する。
28卒サイト開設後は `MYNAVI_GRAD_YEAR=28 npm run mynavi:1000`。
