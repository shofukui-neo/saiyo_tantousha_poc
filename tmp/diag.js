const fs=require('fs'),https=require('https');
const {readCsv}=require('../src/csv');
const {extractOutlineFacts}=require('../src/scrape-mynavi');
const {extractHireRecord}=require('../src/enrich-hire-record');
const {extractPhones,normalizeJpPhone}=require('../src/phone');
const {parseEmployees}=require('../src/mochica-fit');
const {isExcludedIndustry}=require('../src/icp-rules');
const {mkey,buildExclusion,cleanDisplay}=require('../src/build-icp-fresh-1000');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const get=(u,rd=3)=>new Promise(res=>{const q=https.get(new URL(u),{headers:{'User-Agent':UA},timeout:20000},r=>{
 if(r.statusCode>=300&&r.statusCode<400&&r.headers.location&&rd>0){r.resume();return res(get(new URL(r.headers.location,u).href,rd-1))}
 if(r.statusCode!==200){r.resume();return res('')}let b='';r.setEncoding('utf8');r.on('data',c=>b+=c);r.on('end',()=>res(b))});
 q.on('error',()=>res(''));q.on('timeout',()=>{q.destroy();res('')})});
const ent=s=>String(s||'').replace(/&#x([0-9a-f]+);/gi,(m,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(m,d)=>String.fromCodePoint(+d)).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ');
const toText=h=>{let t=String(h||'').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<style[\s\S]*?<\/style>/g,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]+>/g,'\n');
 return ent(t).replace(/\n\s*\n+/g,'\n').replace(/(\d)\s*名/g,'$1名').replace(/(\d)\s*%/g,'$1%')};
(async()=>{
const excl=buildExclusion();
const past=new Set();
for(const f of ['data/leads-icp-fresh-perfect-1000.csv','data/leads-icp-perfect-named-1000.csv','data/leads-icp-fresh-10000.csv','data/leads-icp-fresh-named-1000.csv','data/leads-icp-hire6-500.csv','data/icp-fresh-pool.csv','data/icp-legacy-verified.csv','data/icp-hire6-pool-27.csv'])
 if(fs.existsSync(f))for(const r of readCsv(fs.readFileSync(f,'utf8')).records){const k=mkey(r['企業名']);if(k)past.add(k)}
const cand=[];const dd=new Set();
for(const r of readCsv(fs.readFileSync('data/mynavi-2028-corpus.csv','utf8')).records){
 const id=String(r.corpID||'').trim(),k=mkey(r['企業名']);
 if(!id||!k||dd.has(id))continue;if(excl.names.has(k)||past.has(k))continue;dd.add(id);cand.push({id,name:r['企業名']});}
let noPhone=0,noRec=0,shown=0;
for(const c of cand.slice(0,300)){
 const h=await get('https://job.mynavi.jp/28/pc/search/corp'+c.id+'/outline.html');if(!h)continue;
 const t=toText(h);const f2=extractOutlineFacts(t);const emp=parseEmployees(f2.従業員数);
 if(emp==null||!f2.業種||isExcludedIndustry(f2.業種))continue;
 const strict=(t.match(/電話番号\s*\|?\s*\n?\s*([0-9０-９\-()（） ]{9,22})/)||[])[1]||'';
 const p1=normalizeJpPhone(strict);
 let p2=null;const pr=extractPhones({html:h,text:t})||{};
 const list=(pr.candidates&&pr.candidates.length)?pr.candidates:(pr.phone?[pr]:[]);
 for(const x of list){if(x.isFax)continue;const nz=normalizeJpPhone(x.phone);if(nz){p2=nz;break}}
 const rec=extractHireRecord(t);
 if(!p1){noPhone++;if(shown<6){shown++;const i=t.indexOf('電話');console.log('[電話取れず]',c.name,'| 厳格:',JSON.stringify(strict),'| extractPhones:',p2,'| 近傍:',JSON.stringify(t.slice(i,i+50).replace(/\n/g,' ')))}}
 if(!rec){noRec++;}
}
console.log('--- 300社中 厳格正規表現で電話取れず:',noPhone,' 実績取れず:',noRec);
})();
