const fs=require('fs');
const {readCsv}=require('../src/csv');
const t=fs.readFileSync('data/BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv','utf8');
const {records}=readCsv(t);
console.log('BALESリード件数', records.length);
const c=new Map(), tag=new Map();
let withSite=0;
for(const r of records){
  const v=(r['カスタム情報：利用中ATS']||'').trim();
  if(v) c.set(v,(c.get(v)||0)+1);
  const g=(r['タグ：他社ATS導入']||'').trim();
  if(g) tag.set(g,(tag.get(g)||0)+1);
  if((r['会社情報：Webサイト']||'').trim()) withSite++;
}
console.log('Webサイト有', withSite);
console.log('--- 利用中ATS 値分布(上位40) ---');
[...c.entries()].sort((a,b)=>b[1]-a[1]).slice(0,40).forEach(([k,v])=>console.log(String(v).padStart(6),k));
console.log('件数合計', [...c.values()].reduce((a,b)=>a+b,0));
console.log('--- タグ：他社ATS導入 ---');
[...tag.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log(String(v).padStart(6),k));
