const fs=require('fs');
const {readCsv,normCompanyName}=require('../src/csv');
const t=fs.readFileSync('data/BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv','utf8');
const {records}=readCsv(t);
const pos=new Map(), neg=new Map();
for(const r of records){
  const v=(r['カスタム情報：利用中ATS']||'').trim();
  const name=(r['会社情報：会社名']||'').trim();
  const site=(r['会社情報：Webサイト']||'').trim();
  if(!name) continue;
  const k=normCompanyName(name);
  if(!k) continue;
  if(v && v!=='無し' && v!=='その他'){
    const cur=pos.get(k)||{name,site:'',ats:v};
    if(!cur.site&&site) cur.site=site;
    pos.set(k,cur);
  } else if(v==='無し'){
    const cur=neg.get(k)||{name,site:''};
    if(!cur.site&&site) cur.site=site;
    neg.set(k,cur);
  }
}
const psite=[...pos.values()].filter(x=>x.site);
const nsite=[...neg.values()].filter(x=>x.site);
console.log('ATS名あり企業(ユニーク)',pos.size,'うちサイト有',psite.length);
console.log('無し企業(ユニーク)',neg.size,'うちサイト有',nsite.length);
const byAts={};
for(const x of psite) byAts[x.ats]=(byAts[x.ats]||0)+1;
console.log('--- ベンダー別サイト有企業数 ---');
Object.entries(byAts).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(String(v).padStart(5),k));
console.log('--- サンプル ---');
psite.slice(0,8).forEach(x=>console.log(' ',x.ats,'|',x.name,'|',x.site));
