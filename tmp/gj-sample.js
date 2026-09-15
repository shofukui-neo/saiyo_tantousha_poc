const fs=require('fs'),https=require('https');
const {mkey,buildExclusion,EMP_MIN,EMP_MAX}=require('../src/build-icp-fresh-1000');
const {isExcludedIndustry}=require('../src/icp-rules');
const {parseEmployees}=require('../src/mochica-fit');
const {readCsv}=require('../src/csv');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const get=(url)=>new Promise((res)=>{const req=https.get(url,{headers:{'User-Agent':UA,'Accept-Language':'ja'},timeout:20000},(r)=>{
 if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){r.resume();return res(get(new URL(r.headers.location,url).href))}
 let b='';r.setEncoding('utf8');r.on('data',c=>b+=c);r.on('end',()=>res(b));});
 req.on('error',()=>res(''));req.on('timeout',()=>{req.destroy();res('')});});
const ent=(s)=>String(s||'').replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(+d)).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ');
const text=(h)=>ent(String(h).replace(/<script[\s\S]*?<\/script>/g,'').replace(/<style[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,'\n')).replace(/\n\s*\n+/g,'\n');
const after=(t,kw,n=80)=>{const i=t.indexOf(kw);return i<0?'':t.slice(i+kw.length,i+kw.length+n).replace(/^\s*\|?\s*/,'').split('\n').filter(Boolean)[0]||''};

(async()=>{
const ids=[...fs.readFileSync('data/sitemaps/gj.xml','utf8').matchAll(/baseinfo\/(\d+)\//g)].map(m=>m[1]);
const uniq=[...new Set(ids)];
const N=parseInt(process.argv[2]||'40',10);
const sample=Array.from({length:N},(_,i)=>uniq[Math.floor((i+0.5)*uniq.length/N)]);
const excl=buildExclusion();
const past=new Set();
for(const f of ['data/leads-icp-fresh-perfect-1000.csv','data/leads-icp-perfect-named-1000.csv','data/leads-icp-fresh-10000.csv','data/leads-icp-hire6-500.csv'])
 if(fs.existsSync(f))for(const r of readCsv(fs.readFileSync(f,'utf8')).records){const k=mkey(r['企業名']);if(k)past.add(k)}
const st={fetched:0,named:0,fresh:0,emp:0,nonIT:0,hire:0,hire6:0,url:0};
const rows=[];
let i=0;
const worker=async()=>{while(true){const k=i++;if(k>=sample.length)return;const id=sample[k];
 const h=await get('https://www.gakujo.ne.jp/campus/company/baseinfo/'+id+'/');
 if(!h){continue}st.fetched++;
 const t=text(h);
 const name=ent(((h.match(/<title>([^<]*)<\/title>/)||[])[1]||'').replace(/の新卒採用[\s\S]*$/,'').trim());
 if(!name)continue;st.named++;
 const key=mkey(name);
 const isFresh=!(excl.names.has(key)||past.has(key));
 if(isFresh)st.fresh++;
 const empRaw=after(t,'従業員数',60);const emp=parseEmployees(empRaw);
 const ind=after(t,'業種',60);
 const inBand=emp!=null&&emp>=EMP_MIN&&emp<=EMP_MAX;if(inBand)st.emp++;
 const notIT=!isExcludedIndustry(ind);if(notIT)st.nonIT++;
 const site=([...new Set([...h.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m=>m[1]))]
   .filter(u=>!/gakujo\.ne\.jp|re-katsu|google|facebook|twitter|x\.com|youtube|instagram|line\.me|abc1008|sky-a\.co\.jp|tayori/i.test(u)))[0]||'';
 if(site)st.url++;
 const he=await get('https://www.gakujo.ne.jp/campus/company/employ/'+id+'/');
 const te=text(he);
 const blk=(()=>{const j=te.indexOf('採用予定人数');return j<0?'':te.slice(j,j+200)})();
 const jisseki=(blk.match(/前年度採用実績[：: ]*\s*(\d{1,4})\s*名/)||[])[1];
 const yotei=(blk.match(/20\d{2}年卒予定[：: ]*\s*(\d{1,4})\s*名/)||[])[1];
 const hire=Math.max(+(jisseki||0),+(yotei||0));
 if(hire)st.hire++;if(hire>=6)st.hire6++;
 rows.push({id,name,emp,ind:String(ind).slice(0,18),isFresh,hire,site:site.slice(0,40),inBand,notIT});
}};
await Promise.all(Array.from({length:5},()=>worker()));
fs.writeFileSync('tmp/gj-sample.json',JSON.stringify(rows,null,1));
const pass=rows.filter(r=>r.isFresh&&r.inBand&&r.notIT&&r.hire>=6);
console.log('\n=== あさがくナビ サンプル'+sample.length+'社 の実測 ===');
console.log('取得成功        ',st.fetched);
console.log('完全新規        ',st.fresh,'('+(st.fresh/st.named*100).toFixed(0)+'%)');
console.log('従業員100-2000  ',st.emp,'('+(st.emp/st.named*100).toFixed(0)+'%)');
console.log('非IT            ',st.nonIT);
console.log('採用人数が判明  ',st.hire,' うち6名以上 ',st.hire6);
console.log('自社URLあり     ',st.url);
console.log('全条件通過(電話除く):',pass.length,'→ 3314社換算 約'+Math.round(pass.length/sample.length*3314)+'社');
console.log(pass.slice(0,8).map(r=>`  ${r.name} / 従${r.emp} / ${r.ind} / 採用${r.hire}名`).join('\n'));
})();
