'use strict';
/**
 * G-Chain OS v2.1 — デモ用サンプル通話（合成・実在企業/個人情報なし）。
 * ffmpeg/STT が無くても分析パイプラインを実走・検証するための話者付きtranscript。
 */

// 1) 話しすぎ・質問少・打診漏れ（弱みが明確に出る通話）
const CALL_TALKATIVE = [
  { speaker: 'self', start: 0, end: 6, text: '突然のお電話失礼します、株式会社サンプルの担当と申します。新卒採用のご案内でお電話しました。' },
  { speaker: 'customer', start: 6, end: 8, text: 'はい、なんでしょうか。' },
  { speaker: 'self', start: 8, end: 58, text: '弊社のMOCHICAというサービスは応募者管理から面接調整まで一気通貫でできまして、LINEで学生とやり取りができ、歩留まりが改善します。導入企業様では内定辞退が減っていて、オペレーションも楽になります。料金も月額で始められて、初期費用も抑えられます。' },
  { speaker: 'customer', start: 58, end: 60, text: 'へえ、そうなんですね。' },
  { speaker: 'self', start: 60, end: 95, text: 'そうなんです。さらに説明会の予約もLINEで完結しますし、リマインドも自動で送れますので当日欠席も減ります。管理画面も見やすいと好評でして。' },
  { speaker: 'customer', start: 95, end: 98, text: 'なるほど、また検討しておきます。' },
  { speaker: 'self', start: 98, end: 104, text: 'ぜひご検討ください。よろしくお願いいたします。' },
];

// 2) バランス良い・ヒアリング・打診あり（良い通話）
const CALL_BALANCED = [
  { speaker: 'self', start: 0, end: 7, text: '株式会社サンプルの担当と申します。新卒採用の件で1点だけ伺えますか。' },
  { speaker: 'customer', start: 7, end: 9, text: 'はい、どうぞ。' },
  { speaker: 'self', start: 9, end: 14, text: '今年の新卒採用で、応募者の管理や面接調整で困っていることはありますか。' },
  { speaker: 'customer', start: 14, end: 26, text: 'そうですね、応募は来るんですが日程調整のメールが多くて、正直手が回っていないです。' },
  { speaker: 'self', start: 26, end: 32, text: 'なるほど、日程調整の工数がネックなんですね。今は何名くらいで対応されていますか。' },
  { speaker: 'customer', start: 32, end: 40, text: '2人ですね。ほぼ専任がいない状態で兼務でやっています。' },
  { speaker: 'self', start: 40, end: 50, text: 'ありがとうございます。まさにそこを自動化できるので、一度15分ほど画面を見ていただくのが早いです。来週の火曜か木曜、どちらがご都合よろしいですか。' },
  { speaker: 'customer', start: 50, end: 54, text: 'じゃあ木曜の午後で。' },
  { speaker: 'self', start: 54, end: 58, text: '承知しました、木曜14時で調整します。ありがとうございます。' },
];

// 3) 冒頭で切られ（冒頭の掴み弱み）
const CALL_CUTOFF = [
  { speaker: 'self', start: 0, end: 9, text: 'お世話になります、株式会社サンプルと申します。本日は新卒採用支援のサービスのご案内でお電話いたしました。実は弊社の…' },
  { speaker: 'customer', start: 9, end: 12, text: 'あ、そういうのは今は結構です。忙しいので。' },
  { speaker: 'self', start: 12, end: 15, text: '失礼しました。また改めてご連絡します。' },
];

const DEMO_CALLS = [
  { company: 'サンプル商事', segments: CALL_TALKATIVE, offsetMin: 0 },
  { company: 'サンプル製作所', segments: CALL_CUTOFF, offsetMin: 40 },
  { company: 'サンプル工業', segments: CALL_BALANCED, offsetMin: 90 },
];

module.exports = { CALL_TALKATIVE, CALL_BALANCED, CALL_CUTOFF, DEMO_CALLS };
