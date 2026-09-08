'use strict';
// マイナビ合説スクレイパの純ロジック（ネットワーク不要）テスト
const assert = require('assert');
const m = require('../src/scrape-mynavi-event');

// 問合せ先ブロックの分解
const cases = [
  ['名古屋本社：人事部　採用教育グループ\n【MAIL】saiyo-nagoya@sr-net.co.jp\n【Free】0120-19-7300(フリーダイヤル／本社)\n【TEL】 052-413-6820（本社）\n【住所】名古屋市中村区岩塚本通二丁目12番', '', ['0120-197-300', '052-413-6820']],
  ['採用担当：吉本・黒川・石浦\nTEL 06-6227-0018\nsaiyou@nakai-eng.co.jp', '吉本・黒川・石浦', ['06-6227-0018']],
  ['総務部　渡邊\n045-753-5000', '渡邊', ['045-753-5000']],
  ['人事総務部 野崎瑠美 03-6878-3814 saiyo@tsrweb.co.jp', '野崎瑠美', ['03-6878-3814']],
  ['管理部　川瀬・伊藤\n〒530-0001 大阪府大阪市北区梅田1-1-1', '川瀬・伊藤', []],
  ['新卒採用担当:宮北・野尻・小山田・青山・原田\n052-363-6868', '宮北・野尻・小山田・青山・原田', ['052-363-6868']],
  ['採用担当 山下まで\nTEL：089-923-2480 FAX：089-923-2481', '山下', ['089-923-2480', '089-923-2481']],
  ['人事部 南出\n070-6519-7064', '南出', ['070-6519-7064']],
  ['採用担当\nTEL 03-1234-5678\nFAX 03-1234-5679', '', ['03-1234-5678']],
  ['住所 ：〒459-8009 愛知県名古屋市緑区清水山1-132\n担当部署 ：総務部（渡辺・村越・松宮）\n電話番号 ：052-621-3572', '渡辺・村越・松宮', ['052-621-3572']],
  ['管理本部 奥山（おくやま）\nTEL：011-261-1451', '奥山', ['011-261-1451']],
];
// 社名を人名にしない
assert.strictEqual(m.parseContact('(株)池田ハルク\n〒721-0961 広島県福山市明神町2-14-29\nTEL:084-922-8602\n採用担当：胃甲', '池田ハルク').担当者名, '胃甲');
assert.strictEqual(m.parseContact('(株)佐藤信\n本社管理部 人事担当 輪湖\nTEL 072（734）8111', '(株)佐藤信').担当者名, '輪湖');
for (const [text, names, phones] of cases) {
  assert.strictEqual(m.parseContact(text).担当者名, names, 'names: ' + text);
  assert.deepStrictEqual(m.phonesIn(text), phones, 'phones: ' + text);
}

// 社名の正式化
assert.strictEqual(m.formalCompanyName('(株)システムリサーチ【東証プライム上場】'), '株式会社システムリサーチ');
assert.strictEqual(m.formalCompanyName('アークミール(株)【ステーキのどん】'), 'アークミール株式会社');
assert.strictEqual(m.formalCompanyName('(一社)日本能率協会'), '一般社団法人日本能率協会');
assert.strictEqual(m.formalCompanyName('ヤマダホールディングス／ヤマダデンキ／ヤマダホームズ'), 'ヤマダホールディングス／ヤマダデンキ／ヤマダホームズ');

// 従業員数
assert.strictEqual(m.employeeCount('1,757名（2026年4月時点・連結）'), '1757');
assert.strictEqual(m.employeeCount('２，４４６人'), '2446');
assert.strictEqual(m.employeeCount(''), '');

// 電話番号の選定（イベント県の市外局番を優先、無ければ本社電話番号）
assert.strictEqual(m.pickPhone(['052-413-6820', '06-7669-7511', '0120-19-7300'], '052-413-6820（代）', '大阪府'), '06-7669-7511');
assert.strictEqual(m.pickPhone(['0120-19-7300', '052-413-6820'], '', '東京都'), '052-413-6820');
assert.strictEqual(m.pickPhone([], '052-413-6820（代）', '大阪府'), '052-413-6820');

// イベントID判別
assert.strictEqual(m.eventIdFrom('https://job.mynavi.jp/conts/event/2027/11032/index.html'), '11032');
assert.strictEqual(m.eventIdFrom('https://jobevent.mynavi.jp/conts/event/2027list/list.php?ev=10509&tm=workstyle'), '10509');
assert.strictEqual(m.eventIdFrom('11032'), '11032');

console.log('mynavi-event.test.js: OK');
