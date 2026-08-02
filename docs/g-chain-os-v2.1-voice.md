# G-Chain OS v2.1 — 通話音声 収集・分析レイヤ（本システムの根幹）

> 目的：**架電音声をリアルタイムに収集・分析**し、①架電中に最適トーク ②架電直後に即フィードバック
> ③蓄積データで自分の弱みを可視化する。v2.0（構造化＝誰にいつ架けるか）に対し、v2.1は
> **会話の中身（どう話したか）**を扱う。両者は補完関係。

---

## 1. アーキテクチャ

```
[PCソフトフォン通話]
   │  マイク(自分)=左ch / システム音声(相手)=右ch
   ▼
[recorder.js] FFmpeg dshow → ステレオwav（話者がチャンネルで確定）
   ▼
[stt.js] 各chを別々に文字起こし（whisper.cpp ローカル / クラウドSTT）→ 話者付きsegments
   ▼
[metrics.js] 客観指標（AI不要）: talk比・質問数・打診有無・冒頭の掴み・最長独白・反論数
   ▼
[feedback.js] ルールベースGOOD/MORE/次NG＋実行スコア（5次元）  ←必ず動く
[llm.js]      任意: Claude で LCS診断（Eイベント/L・C・S帰属）を補強  ←鍵があれば
   ▼
[store.js] 通話レコードを蓄積（data/gchain/calls/*.json）
   ▼
[weakness.js] 履歴集計 → 自分の弱み・強み・改善トレンド
```

**設計の要**：ステレオ録音の左右chで**話者を確定**（ダイアライゼーションAI不要）。
**必ず動く**：STT以降の分析はAPI鍵ゼロでも動く（ルールベース）。鍵があればLLMで高精度化（ハイブリッド）。

---

## 2. セットアップ

### 必須：FFmpeg（音声キャプチャ）
1. FFmpeg を導入（`winget install Gyan.FFmpeg` 等）。PATHが通らなければ `GCHAIN_FFMPEG` にパス指定。
2. **システム音声（相手の声）の取得**：Windowsの「ステレオ ミキサー」を有効化、または VB-CABLE 等の仮想オーディオを導入。
3. デバイス名を確認：
   ```
   npm run gchain:voice -- devices
   ```
   ```powershell
   $env:GCHAIN_MIC="マイク (Realtek...)"       # 自分（左ch）
   $env:GCHAIN_SYS="ステレオ ミキサー (Realtek...)" # 相手（右ch）
   ```

### 文字起こし（どちらか）
- **ローカル（推奨・音声を外部に出さない）**：whisper.cpp を導入し
  ```powershell
  $env:GCHAIN_WHISPER_BIN="C:\tools\whisper\whisper-cli.exe"
  $env:GCHAIN_WHISPER_MODEL="C:\tools\whisper\ggml-large-v3.bin"
  ```
- **クラウド（高速・高精度・音声を外部送信）**：`OPENAI_API_KEY` を設定（社内承認前提）。

### 診断の高精度化（任意）
- `ANTHROPIC_API_KEY` を設定すると Claude が LCS診断（Eイベント/帰属）を付与。無ければルールベースのみ。

---

## 3. 使い方

### Web UI（推奨）
```
npm run gchain:web        # http://localhost:5180 →「🎙 架電分析」タブ
```
- **録音開始 → 通話 → 停止**：その場で文字起こし＋フィードバックを表示。
- **自己分析**：5次元（傾聴/ヒアリング/打診/冒頭/独白）の弱み・強み・トレンドをバー表示。
- **直近の通話**：各通話のスコアとMORE。行クリックで詳細。
- **デモ投入**：ffmpeg/STTが未設定でもUIを体験（合成通話3件）。

### CLI
```
npm run gchain:voice -- doctor                     # 環境自己診断（ffmpeg/デバイス/STT/LLMを✓✗表示）
npm run gchain:voice -- selftest                   # 合成wavでキャプチャ→分離の配線検証
npm run gchain:voice -- devices                    # デバイス確認
npm run gchain:voice -- record --company "会社名"   # 録音→Enterで停止→分析→保存
npm run gchain:voice -- analyze path\to\call.wav    # 既存wavを分析
npm run gchain:voice:demo                           # 合成通話でパイプライン実走
npm run gchain:voice:report                         # 蓄積から弱みを集計
npm run gchain:voice -- list                        # 直近の通話一覧
```

---

## 4. 三本柱の実装状況

| 柱 | 状態 | 実装 |
|---|---|---|
| ③ 架電後フィードバック（即） | **実装済（MVP）** | record→stt→metrics→feedback→表示。API鍵なしで動作 |
| ③ 蓄積で自分の弱みを判断 | **実装済** | store＋weakness。5次元スコア・トレンド・弱み特定 |
| ① 架電中リアルタイムコーチング | **次フェーズ** | ライブ文字起こし（chunk STT）→反論検知→次トーク提示。低遅延STTが前提 |

**架電中コーチングの設計方針（次フェーズ）**：録音を数秒chunkでSTT→`metrics`の反論検知(OBJECTION_RE)と
打診漏れ検知をリアルタイム適用→画面に「今は打診タイミング」「質問を挟め」を出す。土台（指標・検知正規表現）は
本レイヤに実装済みなので、chunk STTのストリーミングを足せば発火する。

---

## 5. 客観指標（AI不要で測る会話の質）

| 指標 | 意味 | 弱みシグナル |
|---|---|---|
| talk_ratio_self | 自分の発話比 | >0.65 話しすぎ |
| question_count | 自分の質問数 | <2 ヒアリング不足 |
| proposal_made | 具体的な次接点打診の有無 | false 打診漏れ |
| opening_customer_first_sec | 相手が話し出すまでの秒 | 大/無 冒頭で掴めず |
| longest_monologue_sec | 最長の連続独白 | >40 一方通行 |
| objection_count | 相手の反論数 | 対応の起点 |

実行スコア＝5次元（傾聴/ヒアリング/打診/冒頭/独白）の重み付き平均（0-100）。通話ごとに蓄積し、
`weakness.js` が「直近N件中M件で不足」という形であなたの弱みをデータで示す。

---

## 6. セキュリティ

- 音声・文字起こし・通話レコードは全て **data/gchain/（gitignore）にローカル保存**。外部送信は
  クラウドSTT/LLMを明示的に有効化した時のみ（音声=個人情報）。
- 既定（ローカルWhisper＋ルールベース）なら**PIIは一切PC外に出ない**。

---

## 7. 現状の限界（正直な明示）

- 架電中リアルタイムコーチングは未実装（chunk STTストリーミングが次の作業）。
- 話者分離はステレオ前提。モノラル録音では話者が混ざる（その場合の diarization は未対応）。
- ルールベース指標は正規表現ベース。方言・崩れた発話での取りこぼしはLLM診断で補完する想定。
