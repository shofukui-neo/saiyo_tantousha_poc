const fs=require('fs'),path=require('path');
const {readCsv}=require('/c/Users/shofu/Desktop/saiyo_tantousha_poc/poc/src/csv');
const {mkey}=require('/c/Users/shofu/Desktop/saiyo_tantousha_poc/poc/src/build-icp-fresh-1000');
const num=v=>parseInt(String(v||'').replace(/[^0-9]/g,''),10)||0;
const led=JSON.parse(fs.readFileSync('data/hire-count.json','utf8'));
// 過去に渡した可能性のある成果物（統合マスタ2026-07-14以降に作ったもの）
const delivered=['data/leads-icp-fresh-perfect-1000.csv','data/leads-icp-perfect-named-1000.csv','data/leads-icp-fresh-10000.csv','data/leads-icp-fresh-named-1000.csv','data/leads-icp-hire6-500.csv'];
const D={};
for(const f of delivered){ if(!fs.existsSync(f))continue; const s=new Set(); for(const r of readCsv(fs.readFileSync(f,'utf8')).records){const k=mkey(r['企業名']);if(k)s.add(k);} D[f]=s; console.log(path.basename(f), s.size+'社'); }
// 有資格プール（ICP完全適合×6名以上）を再構成
const pools=['data/leads-icp-fresh-perfect-1000.csv','data/icp-legacy-verified.csv','data/icp-fresh-pool.csv','data/icp-hire6-pool-27.csv'];
const seen=new Set(); const rows=[];
for(const f of pools){ if(!fs.existsSync(f))continue; for(const r of readCsv(fs.readFileSync(f,'utf8')).records){const k=mkey(r['企業名']); if(!k||seen.has(k))continue; seen.add(k); rows.push(r);} }
let q=0, byFile={};
const rest=[];
for(const r of rows){ const l=led[String(r['corpID']||'').trim()]||{}; const h=Math.max(num(l.実績人数),num(l.人数)); if(h<6)continue; q++;
  let hit=null; for(const f of delivered){ if(D[f]&&D[f].has(mkey(r['企業名']))){hit=f;break;} }
  if(hit){byFile[path.basename(hit)]=(byFile[path.basename(hit)]||0)+1;} else rest.push(r['企業名']);
}
console.log('\nICP完全適合×6名以上 の有資格プール:',q,'社');
console.log('うち過去成果物に既出:',JSON.stringify(byFile,null,0));
console.log('→ 過去に渡したリストと被らない残り:',rest.length,'社');
console.log(rest.slice(0,15).join(' / '));
