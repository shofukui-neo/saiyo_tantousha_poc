'use strict';
// 精度の“不変条件”を毎回チェックする軽量テスト（npm test に含める高速版）。
// 重い基準比較は `npm run eval:gate`（全母集団 vs eval/baseline.json）が担う。
// ここでは小さな母集団で「常に成り立つべき性質」だけを確認する:
//   1) 決定論       … 同じ入力で2回評価して完全一致（回帰比較の前提）
//   2) precision    … 抽出名のゴミ(非姓/非フルネーム)は常に0であるべき
//   3) ICP健全性    … 全スコアが 0〜100 / 同一入力で不変
const assert = require('assert');
const { evaluate } = require('../src/eval/evaluate');

let fail = 0;
function ok(msg, cond) { if (cond) console.log('✓ ' + msg); else { console.log('✗ ' + msg); fail++; } }

const a = evaluate({ namesLimit: 250, icpLimit: 300 });
const b = evaluate({ namesLimit: 250, icpLimit: 300 });

// 1) 決定論（per-item 完全一致）
ok('決定論: Wantedly氏名が2回評価で完全一致', JSON.stringify(a.tracks.wantedly.items) === JSON.stringify(b.tracks.wantedly.items));
ok('決定論: 会社ページ氏名が2回評価で完全一致', JSON.stringify(a.tracks.company.items) === JSON.stringify(b.tracks.company.items));
ok('決定論: ICPスコアが2回評価で完全一致', JSON.stringify(a.tracks.icp.items) === JSON.stringify(b.tracks.icp.items));

// 2) precision 不変条件（ゴミは常に0）
ok(`precision: Wantedlyゴミ0件（実際 ${a.tracks.wantedly.garbage}）`, a.tracks.wantedly.garbage === 0);
ok(`precision: 会社ページゴミ0件（実際 ${a.tracks.company.garbage}）`, a.tracks.company.garbage === 0);

// 3) ICP健全性
const scores = Object.values(a.tracks.icp.items);
ok('ICP: 全スコアが 0〜100 の範囲', scores.length > 0 && scores.every((s) => s >= 0 && s <= 100));

// 評価母集団が空でないこと（キャッシュ未配置の取りこぼし検出）
ok(`母集団: Wantedlyページ>0（実際 ${a.tracks.wantedly.pagesScanned}）`, a.tracks.wantedly.pagesScanned > 0);
ok(`母集団: ICPレコード>0（実際 ${a.tracks.icp.recordsScored}）`, a.tracks.icp.recordsScored > 0);

console.log(fail ? `\n精度不変条件テスト: ${fail}件 失敗` : '\n精度不変条件テスト: 全通過');
assert.strictEqual(fail, 0, '精度不変条件テストに失敗');
