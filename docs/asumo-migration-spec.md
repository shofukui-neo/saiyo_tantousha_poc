# G-Chain OS → asumo 移植スペック（確定版）

> 回答済みヒアリング（asumo=Next.js16/React19/Drizzle+SQLite/Fly、Zoom Phone録音＋Gemini文字起こし、
> 話者はLLM判別ラベル、非ステレオ・非リアルタイム）に基づく確定移植計画。
> 親ロードマップ: [g-chain-os-porting-roadmap.md](g-chain-os-porting-roadmap.md)。

---

## 0. 結論（3行）

1. **同一言語(TS)なので純コアを直接埋め込む**（サイドカー/WASM不要＝ロードマップ Phase 3「同一スタック」分岐）。
2. **話者確定はchベース→segmentのspeakerラベルベースへ切替**。コアは対応済み（`agent→self`正規化・タイムスタンプ無しは文字数フォールバック）。
3. **MVP＝既存 call_transcripts → 純コア(metrics/feedback) → /teleapo-analysis に架電後GOOD/MORE表示**。録音/STT/話者分離はasumo既存資産を再利用、新規は②③のみ。

---

## 1. ポート対応（asumo版）

| ポート | 現行(poc) | asumoでの実体 | 移植 |
|---|---|---|---|
| capture | recorder.js(FFmpeg/ステレオ) | **Zoom Phone録音(mp3)** zoomcall-sync | **破棄**（asumo既存） |
| stt | stt.js(whisper/クラウド・ch分離) | **Gemini** lib/transcribe.ts（agent/customer/unknownラベル付） | **破棄**（asumo既存） |
| 話者確定 | 左右ch分離 | **Geminiのspeakerラベル** | コアの`normalizeSpeaker`で吸収済 |
| **core** | metrics/feedback/weakness/analyze | **← これを移植（本体）** | **そのまま埋込** |
| storage | store.js(FS JSON) | **Drizzle+SQLite** | 新規Drizzleテーブル |
| llm(任意) | llm.js(Claude/curl) | **Gemini generateContent** | Geminiアダプタに差替 |
| ui/transport | server.js+webui.html | **Next App Router + /teleapo-analysis** | 新規UIセクション |

**破棄されるpocコード**：recorder.js / stt.jsの録音・ch分離部 / server.js / webui.html / api.jsのvoice録音制御。
**そのまま活きるpocコード**：metrics.js / feedback.js / weakness.js / analyze.js（純コア）。

---

## 2. 埋め込む純コア（コピーするファイル）

pocの以下は外部I/Oゼロ・依存なし。asumoへ `lib/gchain/` 等としてコピー（JSのままallowJs、または型を付けて.ts化。ロジック不変）。

- `src/gchain/voice/metrics.js` … 客観指標（話者エイリアス・タイムスタンプ任意対応済）
- `src/gchain/voice/feedback.js` … 5次元スコア＋GOOD/MORE/次NG（basis対応済）
- `src/gchain/voice/weakness.js` … 弱み蓄積集計
- `src/gchain/voice/analyze.js` … オーケストレータ（llmは注入・省略可）

> これらの**入力契約 = `Segment[]`（{speaker, start?, end?, text}）**。asumoの `call_transcripts.segments` を
> そのまま渡せる（speaker=agent/customer/unknown、start/end は無くてもよい＝文字数フォールバック）。

---

## 3. データ：Drizzleテーブル追加

`call_transcripts` と 1:1（recordingId冪等）で分析結果を持つ。

```ts
// lib/db/schema.ts に追加
export const callAnalysis = sqliteTable('call_analysis', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recordingId: text('recording_id').notNull().unique(),   // 冪等鍵（call_transcripts と揃える）
  callLogId: integer('call_log_id').references(() => callLogs.id),
  ownerEmail: text('owner_email'),                         // 弱み蓄積の集計単位
  executionScore: integer('execution_score'),
  timingBasis: text('timing_basis'),                       // 'time' | 'chars'
  metrics: text('metrics', { mode: 'json' }),              // computeMetrics の出力
  feedback: text('feedback', { mode: 'json' }),            // buildFeedback の出力
  events: text('events', { mode: 'json' }),                // LLM診断時のEイベント（任意）
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

弱み蓄積は `call_analysis` を ownerEmail で集計するだけ（別テーブル不要）。

---

## 4. サーバ処理：Server Action（架電後バッチ）

```ts
// lib/actions/analyze-call.ts
import { computeMetrics } from '@/lib/gchain/metrics';
import { buildFeedback } from '@/lib/gchain/feedback';

export async function analyzeCall(recordingId: string) {
  const tr = await db.query.callTranscripts.findFirst({ where: eq(callTranscripts.recordingId, recordingId) });
  if (!tr) return { ok: false, reason: 'no_transcript' };
  const segments = JSON.parse(tr.segments);            // [{speaker:'agent'|'customer', text, start?, end?}]
  const metrics = computeMetrics(segments);            // 話者エイリアス・文字数FBはコアが処理
  const connected = (metrics.customer_chars ?? metrics.customer_talk_sec) > 0 && metrics.seg_count >= 3;
  const feedback = buildFeedback(metrics, { connected });
  await db.insert(callAnalysis).values({
    recordingId, callLogId: tr.callLogId, ownerEmail: tr.ownerEmail ?? null,
    executionScore: feedback.execution_score, timingBasis: metrics.timing_basis,
    metrics, feedback, createdAt: new Date(),
  }).onConflictDoUpdate({ target: callAnalysis.recordingId, set: { metrics, feedback, executionScore: feedback.execution_score } });
  return { ok: true, metrics, feedback };
}
```

**起動契機**：既存の zoomcall-sync → 文字起こし完了後に `analyzeCall(recordingId)` を呼ぶ（lib/jobsのharnessに1ステップ追加）か、分析画面のボタンで手動実行。

---

## 5. UI：/teleapo-analysis に架電後フィードバック

1件の通話に対し表示する最小要素：
- 実行スコア（0-100）＋接続バッジ
- 指標：発話比(自分)・質問数・打診○×・（timingBasisが`time`なら秒、`chars`なら「文字/ターン」表示）
- **▲GOOD**（point＋quote）／**▼MORE**（point＋next_action）／**⛔次NG**（stop_condition）

自己分析（蓄積）：`weakness.aggregateWeakness(rows.map(r => ({started_at, metrics:r.metrics, feedback:r.feedback})))` を
ownerEmail単位で呼び、5次元バー・弱み・強み・トレンドを表示（pocのwebui.html「🎙架電分析」タブが実装見本）。

---

## 6. LLM高精度化（任意・後回し可）

MVPはルールベースのみで動く。高精度化は llm.js の Claude 呼び出しを **Gemini** に差し替え（asumoは lib/transcribe.ts で
generateContent 実績あり＝同じクライアントを流用）。プロンプト/スキーマは `src/gchain/voice/llm.js` の SYSTEM/userPrompt を
移植し、`response schema` を Gemini の JSON強制で受ける。analyze に diagnose を注入すれば good/more をLLM版で上書き。

---

## 7. MVP チェックリスト（最優先シナリオ＝あなたの1文）

> 既存 call_transcripts を入力に、talk比・質問数・打診有無等を算出し /teleapo-analysis に架電後GOOD/MORE/次NGを1件表示。

- [ ] 純コア4ファイルを `lib/gchain/` にコピー（型付けは任意）
- [ ] `call_analysis` テーブルをDrizzleに追加＋マイグレーション
- [ ] Server Action `analyzeCall(recordingId)` 実装（§4）
- [ ] /teleapo-analysis に1通話フィードバック表示（§5）
- [ ] 手動ボタンで1件通す → 表示確認（ここまででMVP完了）
- [ ] （次）zoomcall-sync 後の自動起動 / 自己分析パネル / Gemini診断

---

## 8. 確認したい1点（非ブロッキング）

**asumoの `call_transcripts.segments` に各発話の秒タイムスタンプ（start/end）はありますか？**
- **ある** → talk比/独白は「秒」で高精度（timing_basis=time）。
- **ない** → コアが自動で**文字数ベース**に切替（timing_basis=chars）。弱み検出は成立するが、独白/冒頭は
  「文字/ターン番号」表示になる。※どちらでも動くので着手は可能。ある方が表示が自然。

---

## 9. 移植の正しさを担保（golden vector）

pocの `test/gchain-voice.test.js`（23件、うち「asumo互換: タイムスタンプ無し+agentラベル」を含む）が
コアの入出力契約テスト＝**golden vector**。asumoへコアをコピーしたら同じ入力→同じ metrics/feedback になることを
1本テストで確認すれば、移植の正しさが保証される（丸め規則までコアに内包済み）。

---

## 10. 留意（asumo特有）

- 本番は Fly shared-cpu-1x/1GB。コアは純関数で軽い（音声/STTはGeminiに委譲済）ので負荷問題なし。
- 認証は暫定BASIC。ownerEmail単位の自己分析は「自分のスコープ」だけ見せる設計に将来のAuthで接続。
- サイドカー常駐は不要（同一プロセスで import）。localhost前提設計を持ち込まないこと（本番Fly構成と乖離するため）。
