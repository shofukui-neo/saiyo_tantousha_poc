---
name: mynavi-event-scrape
description: マイナビ新卒の合同説明会（就職セミナー/EXPO 等）の出展企業を、イベントページ→出展企業一覧→各社のマイナビ企業ページと辿って「企業名/電話番号/採用人数/従業員数/メールアドレス/担当者名」のスプレッドシート形式（大阪10/2シート形式）でCSV出力する。マイナビの合説・イベントURL・出展企業リストから架電リストを作りたい時、イベント一覧に載る全合説をまとめて抽出したい時に使う。
---

# マイナビ合説 出展企業スクレイプ

## いつ使うか
- 「このマイナビのイベントページの出展企業を、スプシ（企業名/電話番号/採用人数/従業員数/メール/担当者名）の形で出して」
- 「イベント一覧（https://job.mynavi.jp/conts/2027/event/）に載っている合説を全部抽出して」
- 合説出展企業＝「今まさに新卒採用に投資している企業」なので、MOCHICA架電の高インテント母集団になる。

## 実行（`src/scrape-mynavi-event.js`）
```bash
# 1イベント（URL でも ID でも可。複数はカンマ区切り）
npm run mynavi:event -- https://job.mynavi.jp/conts/event/2027/11032/index.html
node src/scrape-mynavi-event.js --event 11032,10509

# イベント一覧ページに載る全イベント（event_data.js 由来）
npm run mynavi:event:all

# イベント一覧を表示するだけ（ID/開催日/県/会場）
npm run mynavi:event:list
```
オプション: `--out <dir>`（既定 `data/mynavi-events`）, `--combined <file>`, `--no-cache`, `--delay <ms>`（既定1500）。
環境変数: `MYNAVI_GRAD_YEAR`（既定 `27`）, `MYNAVI_CONTS_YEAR`（既定 `2027`）— **卒年が変わったらここを更新**。

## 出力
- `data/mynavi-events/{eventId}_{イベント名}_{開催日}.csv`（BOM付きUTF-8、Excel/スプシにそのまま貼れる）
- 複数イベント時は `data/mynavi-events/all-events.csv` に結合。

### 1つのスプレッドシートに束ねる（会場ごとに1シート）
```bash
npm run mynavi:event:book        # data/mynavi-events/*.csv → マイナビ合説出展企業.xlsx
node src/build-mynavi-event-book.js --in data/mynavi-events --out <出力先.xlsx>
```
`src/build-mynavi-event-book.js`（exceljs）が上記CSVを読んで1ブックにまとめる。
- `一覧` … 会場別の社数/電話・担当者名・メールの取得数。各シートへのリンク付き。
- `{都市}{M}月{D}日`（例 `大阪10月2日`）… 会場ごとの出展企業。先頭6列がスプシ「大阪10/2」と同じ並び。
- `全会場` … 全イベント結合（イベント名/開催日/会場/都道府県を先頭に付与）。
- シート名はExcel制約に合わせ `/` を使わない（`大阪10/2` ではなく `大阪10月2日`）。重複時は `(2)` を付す。
- xlsx をGoogleドライブにドラッグすると全タブを保ったままGoogleスプレッドシートに変換される。
- 先頭6列はスプシ「大阪10/2」と同じ: `企業名, 電話番号, 採用人数, 従業員数, メールアドレス, 担当者名`。
  以降は検証用: `担当部署, 問合せ先原文, 本社電話番号, 電話番号候補, 従業員数原文, 掲載社名, 業種, ブース, 出展日, マイナビURL, corpId, イベントID, イベント名, 開催日, 会場, 都道府県, 取得日`。
- 最終成果物はダウンロードフォルダへコピーして納品する（`deliverables-to-downloads` 運用）。

## 導線（実DOM。2026-09 較正。壊れたら `CONFIG` を直す）
1. **イベント一覧** `https://job.mynavi.jp/conts/2027/event/` は `<div id="event-list-app">` のJS描画。
   実データは `https://job.mynavi.jp/conts/event/2027/kanri/event_data.js`（`var EVENT_DATA=[{event_id,title,pref,date1,place,exhibit_list_url,...}]`）。
2. **イベント詳細** `/conts/event/2027/{id}/index.html` は出展企業「一部抜粋」しか載らない。
3. **出展企業一覧（全件）** `https://jobevent.mynavi.jp/conts/event/2027list/list.php?ev={id}`
   `<em class="result-area-corp-name">社名</em>` ＋ `corp{ID}/outline.html` へのリンク。`exhibit_list_url` が空のイベントでも `?ev=ID` で取れる。
   「詳細を見る」が `btn-disabled` の出展社はマイナビ企業ページが無い → フリーワード検索で特定を試み、無ければ**社名のみの行**として残す（欠落させない）。
4. **企業ページ**（全て静的HTMLで取得可。Playwright不要）
   - `outline.html`: `<h1>掲載社名</h1>`, `<dt>従業員</dt><dd>`, `<dt>募集人数</dt><dd>`, 会社データ表 `本社電話番号`。
   - `employment.html`: 募集コースへのリンク `displayEmployment/index/?corpId=&recruitingCourseId=`（コース数分）。
   - `displayEmployment`: `td#accessInfoListDescText110`（問合せ先: 部署/担当者/TEL/MAIL/住所）, `td#accessInfoListDescText130`（E-MAIL）, `td.heading=募集人数` の隣。

## 各列のルール（スプシとの突合で決めた）
- **企業名**: 掲載社名の `(株)`→`株式会社` 等に展開し `【東証プライム上場】` 等の装飾を除去。
- **電話番号**: 問合せ先TELのうち **イベント開催県の市外局番を最優先**（例: 名古屋本社の企業でも大阪会場なら大阪支社の番号。スプシもそうなっていた）＞固定＞フリーダイヤル＞携帯。問合せ先に無ければ本社電話番号。候補は `電話番号候補` に全て残す。
- **採用人数**: outline の募集人数。「※各募集コースをご参照ください。」の時は各コースの募集人数をユニークで ` / ` 結合。
- **従業員数**: 原文の先頭の数値のみ（`1,757名（連結）`→`1757`）。原文は `従業員数原文`。
- **メール**: 各コースの E-MAIL＋問合せ先内のアドレスをユニークで ` / ` 結合。
- **担当者名**: 問合せ先の「部署＋氏名」行から人名だけを `・` 結合（`採用担当：吉本・黒川・石浦`→`吉本・黒川・石浦`）。姓は原文表記を保持（渡邊→渡辺にしない）。辞書外姓は「担当/部署」アンカーがある行のみ許容。担当者名が載っていない企業が大半（大阪10/2で16社中3社）なのは仕様。

## 注意
- `jobevent.mynavi.jp/robots.txt` は `Disallow: /`（一覧ページ）。人が閲覧する公開ページを1.5秒間隔・キャッシュ付きで少量取得する運用に留めること（1イベント≒60〜100リクエスト）。
- キャッシュ `data/mynavi-event-cache/`（TTL 3日）。出展企業は直前まで変わるので納品直前は `--no-cache`。
- 純ロジックのテスト: `npm run test:mynavi-event`（問合せ先の分解・社名正式化・電話選定）。
