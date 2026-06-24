require('dotenv').config();
const { readCsv } = require('./src/csv');
const fs = require('fs');
const { politeGet } = require('./src/polite');
const { findRecruitLinks } = require('./src/recruit-page');
const { pageCorpus, visibleText, extractFromRecruitText } = require('./src/probe-recruit-page');
const { extractRecruiterFromText } = require('./src/recruiter');
const { pageMatchesCompany } = require('./src/search');
const { isPlausiblePersonName } = require('./src/jp-names');

const { records } = readCsv(fs.readFileSync('data/diagnose-harvest.csv','utf8'));
const ctx = records.filter(r=>r.outcome==='CONTEXT_NO_NAME').slice(0,12);

async function get(u){ const r=await politeGet(u,{render:'static'}); return (r&&!r.blocked&&!r.error&&r.html)?r.html:null; }

(async()=>{
  let recovered=0;
  for(const rec of ctx){
    const name=rec['企業名'], url=rec['公式URL'];
    const topHtml=await get(url); if(!topHtml){console.log('—fetchfail',name);continue;}
    const links=findRecruitLinks(url,topHtml).filter(l=>!l.external).map(l=>l.url).slice(0,3);
    const pages=[...new Set([...links,url])];
    let found='';
    for(const p of pages){
      const html=p===url?topHtml:await get(p); if(!html)continue;
      const corpus=pageCorpus(html);
      // Gemini on EVERY recruit-context page (aggressive)
      const g=await extractRecruiterFromText(corpus.slice(0,8000),{name},require('./src/config')).catch(()=>null);
      if(g&&g.name&&isPlausiblePersonName(g.name)&&pageMatchesCompany(name,'',visibleText(html))){found=g.name+' ['+g.engine+'] @'+p.split('/').slice(2).join('/').slice(0,30);break;}
    }
    if(found)recovered++;
    console.log(`${found?'★ '+found:'— なし'}  | ${name}`);
  }
  console.log(`\nGemini積極適用でのリカバリ: ${recovered}/${ctx.length}`);
})();
