const fs=require('fs');
const {readCsv}=require('../src/csv');
const {mkey,buildExclusion}=require('../src/build-icp-fresh-1000');
const c28=readCsv(fs.readFileSync('data/mynavi-2028-corpus.csv','utf8')).records;
const seen=new Set();
for(const f of ['data/icp-fresh-pool.seen.txt','data/leads-icp-fresh-10000.seen.txt','data/icp-hire6-pool-27.seen.txt']){
  if(!fs.existsSync(f))continue;
  for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/)){const t=l.trim();if(t)seen.add(t);}
}
const excl=buildExclusion();
let nSeen=0,nExcl=0,nOpen=0;
for(const r of c28){const id=String(r.corpID);const k=mkey(r['企業名']);
  if(seen.has(id)){nSeen++;continue}
  if(k&&excl.names.has(k)){nExcl++;continue}
  nOpen++;}
console.log('マイナビ28卒コーパス',c28.length,'社');
console.log('  探索済(seen)      ',nSeen);
console.log('  社名で既存除外    ',nExcl);
console.log('  未着手(＝伸びしろ)',nOpen);
