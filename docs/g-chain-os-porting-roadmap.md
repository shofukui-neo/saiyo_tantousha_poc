# G-Chain OS — 別アプリ移植ロードマップ
## 現行実装を「そのまま」別アプリへ載せ替えるための設計

> 目的：現在の G-Chain OS（構造化分析 v2.0 ＋ 音声分析 v2.1）を、**全く別のアプリ**（別UI・別基盤・
> 場合により別言語）へ移植する。そのために「何が再利用でき（コア）／何を差し替えるか（アダプタ）」を
> 明確にし、移植を"作り直し"でなく"配線替え"にする。

---

## 0. 移植を楽にする1つの原則：Ports & Adapters（ヘキサゴナル）

```
        ┌───────────────── 純コア（移植で不変） ─────────────────┐
 UI ──▶ │  分析ロジック：metrics / feedback / weakness / analyze  │
 OS      │  構造化：outcome / features / loss-intel / reactivation │ ◀── 差し替え可能なアダプタ
 言語     │  基盤：event-engine / canonical / normalize / model     │     capture / stt / storage / llm / ui
        └────────────────────────────────────────────────────────┘
```

- **コア＝純関数（外部I/O無し）**。入力と出力が固定契約なら、どのアプリでも同じ結果を出す。
- **アダプタ＝環境依存**（録音・文字起こし・保存・LLM・UI）。移植先ごとに実装し直す“薄い層”。
- 現行コードは既にこの分離に沿っている（純モジュールは `require` のみ・I/Oは端に集約）。本ロードマップは
  この境界を**契約として固定**し、移植を機械的にする。

---

## 1. 現行モジュールの移植分類

| 分類 | モジュール | 移植時 |
|---|---|---|
| **純コア（不変・そのまま再利用）** | `voice/metrics.js`・`voice/feedback.js`・`voice/weakness.js`・`voice/analyze.js`(大部分)・`voice/stt.js`のパーサ(`parseWhisperJson`/`parseOpenAiJson`/`parseTimestamp`) | 無改変。別言語なら仕様＋golden vectorで再実装 |
| **純コア（構造化分析）** | `outcome`・`features`・`loss-intel`・`reactivation`・`discipline`・`model`・`kpi`・`event-engine`・`canonical`・`normalize` | 無改変 |
| **契約（データ定義）** | `schema.js`・`config.js`・本書 §3 の型 | JSON Schema / 型として凍結 |
| **アダプタ：capture** | `voice/recorder.js`（FFmpeg/dshow） | 対象環境で再実装（下記） |
| **アダプタ：stt** | `voice/stt.js`の録音→文字起こし部（whisper.cpp/クラウド） | 対象環境で再実装 |
| **アダプタ：storage** | `voice/store.js`（FSにJSON） | DB/IndexedDB等へ |
| **アダプタ：llm** | `voice/llm.js`（curl→Claude） | SDK/fetch へ |
| **アダプタ：ui/transport** | `server.js`・`webui.html`・`api.js` | 対象UIへ |
| **合流点（配線）** | `voice/pipeline.js` | ポートを差し替えて再利用 |

**要点：移植で書き直すのは右下の“アダプタ”だけ。**左上の“コア”は触らない（＝会話分析の頭脳は共有資産）。

---

## 2. ポート契約（アダプタが満たすべきインターフェース）

移植先は次の4ポートを実装すれば、`pipeline.js` 経由でコアがそのまま動く。

```ts
// 話者付きセグメント（全アプリ共通の最小単位）
type Segment = { speaker: 'self'|'customer'|'unknown'; start: number; end: number; text: string };

interface CapturePort {                    // 録音
  start(meta): { stop(): Promise<AudioRef> };   // AudioRef = ファイルパス/Blob/URL 等
}
interface SttPort {                        // 文字起こし（話者分離込み）
  transcribe(audioRef, opts): { segments: Segment[]; channels: number; attributed: boolean; backend: string };
}
interface StoragePort {                    // 蓄積
  saveCall(record): Ref;
  loadCalls(opts): CallRecord[];
}
interface LlmPort {                        // 任意・高精度診断
  diagnose(transcriptText): Diagnosis | null;
}
```

- **話者分離の設計は不変**：ステレオ（左=自分/右=相手）で撮り、各chを別々にSTT。これは環境が変わっても踏襲する
  （録音手段だけ変わる）。モノラルしか取れない環境では `attributed=false` を返し、LLMで事後帰属する分岐を用意。

---

## 3. データ契約（凍結すべき正本）

移植の“真の資産”はコードでなく**データ契約**。これを JSON Schema / 型として固定し、golden vector を付ける。

```jsonc
// CallRecord（1通話）
{
  "call_id": "string",
  "started_at": "ISO8601",
  "company": "string|null",
  "operator": "string",
  "connected": "boolean",
  "attributed": "boolean",
  "segments": [{ "speaker": "self|customer|unknown", "start": 0, "end": 0, "text": "" }],
  "metrics": { "talk_ratio_self": 0, "question_count": 0, "proposal_made": false,
               "opening_customer_first_sec": 0, "longest_monologue_sec": 0, "objection_count": 0, "...": 0 },
  "feedback": { "execution_score": 0, "dims": { "balance":0,"questions":0,"proposal":0,"opening":0,"monologue":0 },
                "good": {}, "more": {}, "next_ng": {} },
  "events": [{ "event_code": "E3|E4|E5|E6", "evidence_quote": "" }],   // LLM時
  "stt": { "backend": "", "channels": 2, "attributed": true }
}
```

`schema.js`（19シート・語彙）と `config.js`（閾値・重み）も契約の一部。**閾値/重みは設定として外出し済み**なので、
移植先でチューニングしても契約は不変。

---

## 4. 段階計画

### Phase 0 — 契約凍結（1〜2日）★最優先
- CallRecord / Segment / metrics / feedback を **JSON Schema と TypeScript型** に落とす（`contracts/` 新設）。
- **golden vector** を作る：入力segments → 期待metrics/feedback のペア（現行の `test/gchain-voice.test.js` が母体）。
  これが「移植が正しいか」の唯一の判定基準になる。
- 成果物：`contracts/*.schema.json`・`contracts/golden/*.json`。

### Phase 1 — コア分離（2〜3日）
- 純コアを I/O ゼロの独立パッケージに束ねる（`src/gchain/core/` or `@gchain/core`）。`require` 依存を内側だけに閉じる。
- ポート interface を明文化（本書 §2 を `.d.ts`/JSDocへ）。
- `pipeline.js` を唯一の合流点に統一（済：本コミットで導入）。

### Phase 2 — アダプタの契約化（2〜3日）
- 現行 recorder/stt/store/llm を「ポート実装」として整理（関数シグネチャをポートに合わせる）。
- 現行アプリ＝**リファレンス実装**（Node＋FFmpeg＋whisper＋FS）として温存。

### Phase 3 — 配布形態の決定（対象スタックで分岐）
| 移植先 | 戦略 | 労力 |
|---|---|---|
| **同一スタック（Node/JS・Electron・React Native）** | コアを npm/vendored でそのまま import。アダプタのみ実装 | 小 |
| **ブラウザ単体（Web）** | コアはそのままJSで動く。capture=MediaRecorder、stt=WebSpeech/クラウド、storage=IndexedDB | 小〜中 |
| **別言語（Swift/Kotlin/Go/Python等）** | ①コアを**仕様＋golden vector**で再実装し一致検証、または ②JSコアを **WASM化**して埋込、または ③**サイドカー**（localhostでコアをHTTP提供し対象アプリが叩く） | 中〜大 |

- **保険としてサイドカーを推奨**：`server.js` を「コアAPIサーバ」に純化すれば、どの言語のアプリでも
  `POST /analyze {segments}` → metrics/feedback を受け取れる（現 `api.js` が土台）。言語不問で即載る。

### Phase 4 — 対象アプリ統合（対象規模による）
- 対象アプリで4ポート＋UIを実装 → `pipeline.processAudio()` 相当を呼ぶ。
- capture/stt は対象OSの最良手段へ（例：モバイルなら端末録音＋オンデバイスWhisper）。

### Phase 5 — パリティ検証（継続）
- golden vector を対象実装に流し、metrics/feedback が**ビット一致**することを確認（丸め規則も契約に含める）。
- 不一致は契約のバグ→両側を契約に合わせる。

---

## 5. 移植を壊さないための規律

1. **コアに I/O を足さない**（ファイル/ネット/時刻/乱数を持ち込まない。`now` は引数注入・現行踏襲）。
2. **契約変更は versioned**（CallRecord に `schema_version`。破壊的変更は番号を上げ golden も更新）。
3. **閾値・重みは config**（コードに直書きしない。移植先でのチューニングを契約から分離）。
4. **golden vector を常に緑に**（現行 `gchain:test` がこれ。移植先でも同じ vector を通す）。
5. **アダプタは薄く**（ロジックをアダプタに書かない＝録音/保存の“やり方”だけ持たせる）。

---

## 6. 今すぐの準備状態（現行リポジトリ）

- ✅ 純コアと I/O は既に分離（純モジュールは外部I/O無し）。
- ✅ `pipeline.js` でポート合流点を明示（本作業で追加）。
- ✅ golden vector の母体＝ `test/gchain-voice.test.js`（18件）・`test/gchain-*.test.js`（計108件）。
- ⬜ Phase 0：契約を `contracts/` に切り出し（次アクション）。
- ⬜ 対象アプリの**スタック確定**（同一/ブラウザ/別言語）→ Phase 3 の分岐を選ぶ。

> **確認したい1点**：移植先アプリのスタックは？（Node/JS系 / ブラウザ単体 / 別言語）。
> ここが決まれば Phase 3 を確定し、サイドカー化か WASM 化か npm 化かを選んで具体作業に入れます。
