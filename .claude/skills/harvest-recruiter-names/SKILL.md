---
name: harvest-recruiter-names
description: 採用担当者「個人名」つきリストを、マイナビだけに頼らず全媒体カタログから収穫する。どの媒体がどの経路で名前を出すか（構造化媒体／企業サイトhop／地方特化SME母集団）を実測に基づき正しくルーティングする。マイナビ依存のリスト作成を見直したい・非マイナビの担当者名ソースを増やしたい・全媒体で氏名を取りたい時に使う。
---

# 採用担当者名ハーベスト（全媒体・マイナビ非依存）

## いつ使うか
- リスト作成がマイナビ頼りになっており、非マイナビの担当者名ソースを増やしたい。
- `data/media-catalog.json`（106媒体）を最大限活用して氏名つきリストを作りたい。
- 「全媒体で担当者名を取りたい」— ただし後述の**構造的な限界**を正しく踏まえて。

## 最重要の前提（実測で確定した事実。ここを外すと徒労になる）
採用担当者の**個人名がどこに存在するか**は媒体ごとに構造的に決まっている。実測（`src/experiment-nonmynavi-names.js`）で:
- **媒体ページ自体に個人名が出るのは 106媒体中ごく僅か**（マイナビ=構造化問合せ先、Wantedly=投稿者名、チアキャリア=一部のみ）。他 ~100媒体の自ページに担当者名は無い。
- 名前は媒体がリンクする**企業サイト側**にある。よって大半の媒体では「媒体→企業公式サイトへ hop → 氏名抽出」が唯一の経路。
- **hopの歩留まりは媒体が集める企業母集団の性質で決まる**:
  - 全国/大手系媒体（レバテック/キャリアチケット等）→ 大企業は担当者名を非公開 → **~0%**
  - **地元SMEの「採用ページに外部リンクする」媒体 → SMEが自社採用ページに「担当／田中」「人事部 松井」を出す → 実測 24〜33%（にいがた就職応援団ナビ 4/17）**

**ただし超重要（実測でさらに判明した第2の壁）**: 「company-hopが効くか」は媒体が企業一覧を**どう出すか**で決まる。地方特化33媒体を実走した結果、名前が取れたのは**にいがた1媒体のみ**。理由:
- にいがた型 = 企業の採用ページへ**静的に外部リンク**する → hopできる → 名前が取れる。
- 他の大半 = 企業一覧が `search.php`/JSレンダ/外部ATSサブドメイン（例 `kagojob.saiyo-job.jp`）の裏にあり、静的クロールで母集団を列挙**できない** → 母集団0 → 名前0。これらは媒体ごとの個別対応（検索フォーム駆動/ATS追跡/JSレンダ）が必要で、費用対効果は低い（長い裾野）。

→ **結論: マイナビは"数ある feeder の一つ"に降格できる。非マイナビで名前を取る最有力は「SME採用ページへ外部リンクする媒体（にいがた型）× company-hop」。まず experiment で"外部リンクを静的に出す媒体"を選別してから回すのが鉄則。**

## 経路のルーティング（媒体を strategy で振り分ける）
`media-catalog.json` の各媒体 `strategy` に応じて経路を選ぶ:

| strategy | 媒体数 | 経路 | 期待yield |
|---|---|---|---|
| `sitemap-discovery` | 1 (Wantedly) | `npm run names:wantedly`（投稿者=採用担当の個人名を大量収穫） | 高 |
| `media-detail` (マイナビ) | — | `npm run mynavi:1000`（伝言板/インタビュー/問合せ先の3パターン, `src/mynavi-name-extract.js`） | 中〜高（SME掲載） |
| `recruit-page-link` ほか | 64+ | **`harvest-all-media.js`** = 企業母集団の入口として使い company-site hop | 外部リンク型SME媒体=中(24-33%), 大手/検索裏=0 |
| `blocked-or-login` | 24 | 名前は取れない。**新卒掲載=intentシグナル**としてのみ価値 | 0 |

## 実行（メインの汎用オーケストレータ）
`src/harvest-all-media.js` = カタログ駆動。全runnable媒体を巡回して外部企業URL（母集団）を2ティア抽出（法人格つき=強／短い企業名=弱）→ 各企業サイトへ hop → `probe-recruit-page`/`probe-recruit-deep` で氏名抽出 → 媒体横断で登録ドメイン重複排除。

```bash
# 最有力: 地方特化33媒体をまとめて（company-hop, 深めに巡回）
node src/harvest-all-media.js --cats "地方特化" --media-limit 33 --per-media-companies 25 --media-max-pages 16

# 促進カテゴリを絞って
node src/harvest-all-media.js --cats "逆求人|IT特化|理系|インターン" --per-media-companies 12

# より深い抽出（JSレンダ+複数ページ, 遅い）
node src/harvest-all-media.js --cats "地方特化" --deep --per-media-companies 20

# 事前の媒体スクリーニング（自ページに名前が出るか/企業リンク数を実測）
node src/experiment-nonmynavi-names.js --max-pages 12 --cats "逆求人|IT特化|理系"
```

### 主なオプション
- `--cats "<regex>"` … `media-catalog.json` の `cat` を正規表現で絞る（例 `地方特化`, `逆求人|IT特化`）。
- `--per-media-companies N` … 1媒体あたり hop する企業数の上限（既定25）。
- `--media-max-pages N` … 各媒体を巡回する最大ページ数（母集団の広さ。地方媒体は16以上推奨）。
- `--deep` … `probeRecruitDeep`（JSレンダ+複数ページ+構造/連絡先抽出）。精度↑・速度↓。
- `--include-structured` … 既定で除外するマイナビ/Wantedlyも含める。
- `--target N` … 累計氏名がNに達したら停止。

## 出力
- `data/recruiter-all-media.csv` … `企業名,公式URL,採用担当者名,役職,部署,確度,取得元,根拠URL,根拠,取得元媒体,媒体戦略`
- `data/recruiter-all-media.by-media.csv` … 媒体別 `母集団企業/氏名取得/yield`（**どの媒体が効いたかを必ずこれで確認**）
- 中断/再開: `data/harvest-all-media.journal.json`（媒体単位）＋ CSVアトミック書込。同じコマンドで再開。
  パラメータ（`--media-max-pages`等）を変えて取り直す時は journal と出力CSVを削除してから実行。

## 使い方の型（推奨ワークフロー）
1. **スクリーニング**: `experiment-nonmynavi-names.js` で候補カテゴリの「名前露出／企業リンク数」を実測。
2. **本収穫**: yield見込みの高い母集団（**地方特化を最優先**、次いでIT/理系のSME寄り）に `harvest-all-media.js` を回す。
3. **by-media.csv を必ず読む**: 0%が続く媒体はSPA/大手母集団＝深掘りしても無駄。効いた媒体だけ `--media-max-pages` を上げて深掘り。
4. **既存の柱と統合**: Wantedly(`names:wantedly`)＋マイナビ(`mynavi:1000`)＋本経路を名寄せ統合（`src/name-fusion.js`）。
5. MOCHICAターゲット化は既存の `mochica:*` / `deliver` へ。

## 正直な限界（過度な期待を避ける）
- **「全106媒体で担当者名取得」は物理的に不可**。2つの構造的な壁がある:
  1. **名前の在り処**: 媒体の自ページに担当者名は無い（19媒体中1）。名前は企業サイト側 → hop必須。blocked/login/大手非公開は0。
  2. **母集団の取り出し**: hopが効くのは媒体が企業採用ページへ**静的に外部リンク**する場合のみ。大半の媒体は企業一覧を検索フォーム/JS/外部ATSの裏に隠すため、静的に母集団を列挙できず0。地方特化33媒体でも名前が取れたのは1媒体（にいがた）だけだった。
- yieldは抽出技術ではなく**母集団の質と取り出しやすさが全て**。名前が欲しければ「SME採用ページへ外部リンクする媒体」を選ぶ。個別のsearch.php/ATS対応は費用対効果が低い（長い裾野）。
- 実運用の主柱は依然 Wantedly＋マイナビ＋にいがた型company-hop。本skillはそれを**媒体別に正しくルーティングし、マイナビ一本足を解消する**ためのもの。「全媒体で取れ」ではなく「取れる媒体を実測で選別して最大化する」のが正しい運用。

## 関連コード
- `src/harvest-all-media.js` … 本オーケストレータ
- `src/experiment-nonmynavi-names.js` … 媒体スクリーニング
- `src/probe-recruit-page.js` / `src/probe-recruit-deep.js` … 氏名抽出エンジン（構造表→下部連絡先→本文, alt属性, 名乗り/署名パターン）
- `src/mynavi-name-extract.js` … マイナビ3パターン抽出
- `src/harvest-wantedly.js` … Wantedly投稿者名
- `src/harvest-adaptive.js` … 企業サイトを氏名が取れるまでBFS深掘り（成功パス署名を学習）
- `data/media-catalog.json` … 106媒体カタログ（strategy/probe較正値）
