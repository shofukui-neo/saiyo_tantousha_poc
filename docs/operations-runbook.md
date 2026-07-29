# 運用ランブック — 採用担当者リスト 即運用オペレーション

「今のリストを即戦力化して即運用」するための実務手順書。統合マスタ
`data/leads-consolidated-all.csv`（30,290社・採点/名寄せ/被り判定済）を単一の真実として、
BALESCLOUD取込形式のハンドオフ物を生成・検証・配布し、架電結果で回す。

---

## 0. TL;DR（今日始める）

```powershell
npm run deliver          # 3スコープ生成＋取込前検証＋ハンドオフ要約
```

→ `data/leads-bales-callable.csv`（**即架電 2,570社**）を BALESCLOUD にインポート → 本日架電開始。

---

## 1. 成果物（誰に何を渡すか）

| ファイル | 社数 | 渡す先 | 中身 |
|---|---|---|---|
| **`data/leads-bales-callable.csv`** | **2,570** | **即架電チーム** | 担当者名＋電話＋完全新規。会社名/電話/担当者姓/敬称が**全件充足**。★最優先 |
| `data/leads-bales-named.csv` | 4,753 | メール/フォーム後追い | 担当者名あり・完全新規。電話欠(約46%)はメール導線へ |
| `data/leads-bales-all.csv` | 30,290 | 俯瞰・バックアップ | 既存被り含む全社。架電には使わない |

すべて **BALESCLOUD リードリストと同一266列構造・UTF-8**。取込時の列マッピング調整は不要。

### 品質ライン（deliver が自動検証）
- 全ファイル：列数266一致・**取込不能行（会社名空）ゼロ**
- callable：**電話100%・担当者姓100%** を満たさなければ `deliver` は異常終了（架電不能物を配らない）

---

## 2. インポート手順（BALESCLOUD）

1. BALESCLOUD → リード → インポート
2. `data/leads-bales-callable.csv` を指定（文字コード UTF-8）
3. 266列がBALES構造と一致しているためマッピングは既定のまま取込
4. 取込後、架電呼称は「部署 + 担当者名 + 様」で表示される（敬称は全件付与済）

> 既存リード（BALES/SF/MOCHICA顧客）との重複は**生成時点で除外済**（`既存被り` 空のみ = 完全新規）。
> 二重取込防止のため、追加取込は毎回 callable/named の**再生成→差分**で運用する。

---

## 3. 定期リフレッシュ

### 3-1. 成果物の再生成（マスタ更新後いつでも）
```powershell
npm run deliver
```
統合マスタを更新したら必ず再実行。生成物は決定論的（同じマスタ→同じ出力）。

### 3-2. アプローチ禁止（NG）企業の反映
新しいNGが来たら `data/ng-companies.txt` に社名を追記（旧社名可・自動展開）：
```powershell
npm run ng          # 影響社数の確認（ドライラン）
npm run ng:apply    # 正リストから除外を適用
```
※ NG適用対象リストのパスは `package.json` の `ng` スクリプト参照。統合マスタに反映後 `npm run deliver`。

### 3-3. 既存被りの再判定（BALES/SF/MOCHICA顧客リストを更新したら）
参照マスタ（`data/BALESCLOUDの既存リスト…`, `data/セールスフォース…`, `data/MOCHICAの既存顧客…`）
を差し替えたら、統合再スコアで被りを取り直す：
```powershell
node src/consolidate-all.js   # 正規化＋名寄せ重複排除＋MOCHICA再採点＋既存被り再判定
npm run deliver
```

---

## 4. 架電結果フィードバック（利回りで回す）

架電結果を `sources/outcomes.csv` に記録（キー：法人番号 なければ企業名／列：接続/アポ/商談/受注/コスト）：
```powershell
npm run kpi        # ソース別 接続率→アポ率→受注率・アポ単価 を算出、寄せる/止めるを提示
```
**2週間サイクル**で判定 → 高利回りセグメントへ配分を寄せる。

---

## 5. データ取扱（重要）

- 本ディレクトリの CSV は**個人情報・企業リスト**。`data/` は既定で `.gitignore` 済。
- 共有は暗号化ボールト経由：`npm run encrypt:lists` / 復号 `npm run decrypt:lists`。
- 取得した担当者名は個人情報。利用目的の特定・適正取得・オプトアウト対応を前提に運用。
- 詳細は [SECURITY.md](../SECURITY.md)。

---

## 6. トラブルシュート

| 症状 | 対処 |
|---|---|
| `deliver` が「統合マスタが見つかりません」で停止 | `data/leads-consolidated-all.csv` の存在確認。無ければ `node src/consolidate-all.js` |
| `deliver` が検証✗で異常終了 | 出力の✗行を確認。列数不一致→BALES参照ヘッダ破損、会社名空→マスタ側の欠損行 |
| 取込後に重複リードが出る | 既存参照リストが古い可能性。§3-3 で被り再判定→再生成 |
| callable の社数を増やしたい | 担当者名×電話の母集団が上限。母集団拡大は別ゴール（マイナビ/Wantedly再走査）＝運用とは分離 |

---

## 7. スコープ外（このランブックは扱わない）

- 母集団の再収集・拡大（`npm run mynavi:1000` 等の再走査）… 別途「リスト刷新」ゴール
- 24/7モニタリング常時稼働 … `docs/monitoring-ops-runbook.md`
- Salesforce/BALES ライブAPI連携 … `docs/sf-integration-design.md`（未実装・設計のみ）
