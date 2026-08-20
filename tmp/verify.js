const fs=require('fs'),https=require('https');
const {readCsv}=require('../src/csv');
const {extractOutlineFacts}=require('../src/scrape-mynavi');
const {extractHireRecord}=require('../src/enrich-hire-record');
const {extractPhones,normalizeJpPhone}=require('../src/phone');
const {parseEmployees}=require('../src/mochica-fit');
const {mkey,cleanDisplay}=require('../src/build-icp-fresh-1000');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const get=(u,rd=3)=>new Promise(res=>{const q=https.get(new URL(u),{headers:{'User-Agent':UA},timeout:20000},r=>{
 if(r.statusCode>=300&&r.statusCode<400&&r.headers.location&&rd>0){r.resume();return res(get(new URL(r.headers.location,u).href,rd-1))}
 if(r.statusCode!==200){r.resume();return res('')}let b='';r.setEncoding('utf8');r.on('data',c=>b+=c);r.on('end',()=>res(b))});
 q.on('error',()=>res(''));q.on('timeout',()=>{q.destroy();res('')})});
const ent=s=>String(s||'').replace(/&#x([0-9a-f]+);/gi,(m,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(m,d)=>String.fromCodePoint(+d)).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ');
const toText=h=>{let t=String(h||'').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<style[\s\S]*?<\/style>/g,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]+>/g,'\n');
 return ent(t).replace(/\n\s*\n+/g,'\n').replace(/(\d)\s*名/g,'$1名').replace(/(\d)\s*%/g,'$1%')};
(async()=>{
const file=process.argv[2]||'data/leads-icp-fresh-nooverlap-500.csv';
const rs=readCsv(fs.readFileSync(file,'utf8')).records;
const N=Math.min(10,rs.length);
const sample=Array.from({length:N},(_,i)=>rs[Math.floor((i+0.5)*rs.length/N)]);
let ok=0,ng=0;
for(const r of sample){
 const url=r['採用ページURL'];
 const h=await get(url);
 if(!h){console.log('NG (取得不可)',r['企業名']);ng++;continue}
 const t=toText(h);
 const h1=ent(((h.match(/<h1[^>]*>([^]{0,120}?)<\/h1>/)||[])[1]||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim());
 const f=extractOutlineFacts(t);
 const emp=parseEmployees(f.従業員数);
 const rec=extractHireRecord(t);
 const nameOk=mkey(cleanDisplay(h1))===mkey(r['企業名']);
 const empOk=String(emp)===String(parseEmployees(r['従業員数']));
 const hireOk=rec&&String(rec.人数)===String(r['年間新卒採用人数']);
 const pr=extractPhones({html:h,text:t})||{};
 const list=(pr.candidates&&pr.candidates.length)?pr.candidates:(pr.phone?[pr]:[]);
 const phones=list.map(x=>normalizeJpPhone(x.phone)).filter(Boolean);
 const phoneOk=phones.includes(r['電話番号']);
 const good=nameOk&&empOk&&hireOk&&phoneOk;
 good?ok++:ng++;
 console.log((good?'OK  ':'NG  ')+r['企業名']+' | 社名'+(nameOk?'○':'×')+' 従業員'+(empOk?'○':'×('+emp+')')+' 採用'+(hireOk?'○':'×('+(rec?rec.人数:'なし')+')')+' 電話'+(phoneOk?'○':'×('+phones.slice(0,2)+')')+' | '+r['年間新卒採用人数']+'名 '+r['採用人数の種別']);
}
console.log('==== 独立再取得検証: OK '+ok+' / NG '+ng+' (n='+N+')');
})();
