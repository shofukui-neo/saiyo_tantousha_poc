const fs=require('fs');
const {readCsv}=require('../src/csv');
const {mkey,buildExclusion}=require('../src/build-icp-fresh-1000');
const excl=buildExclusion();
const past=new Set();
const PAST=['data/leads-icp-fresh-perfect-1000.csv','data/leads-icp-perfect-named-1000.csv','data/leads-icp-fresh-10000.csv','data/leads-icp-fresh-named-1000.csv','data/leads-icp-hire6-500.csv','data/icp-fresh-pool.csv','data/icp-legacy-verified.csv','data/icp-hire6-pool-27.csv'];
for(const f of PAST){if(!fs.existsSync(f))continue;for(const r of readCsv(fs.readFileSync(f,'utf8')).records){const k=mkey(r['企業名']);if(k)past.add(k)}}
let tot=0,fresh=0;
for(const f of ['data/mynavi-2028-corpus.csv','data/mynavi-2027-corpus.csv']){
 if(!fs.existsSync(f))continue;
 const rs=readCsv(fs.readFileSync(f,'utf8')).records;
 let a=0;const ids=new Set();
 for(const r of rs){tot++;const k=mkey(r['企業名']);if(!k)continue;if(excl.names.has(k)||past.has(k))continue;if(ids.has(String(r.corpID)))continue;ids.add(String(r.corpID));a++;}
 console.log(f,rs.length+'社 → 社名で未既出',a);
 fresh+=a;
}
console.log('過去納品(統合マスタ外)社名:',past.size);
console.log('=> 幅を広げた再探索の候補 合計',fresh,'社');
