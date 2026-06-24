require('dotenv').config();
const { politeGet } = require('./src/polite');
const { findRecruitLinks } = require('./src/recruit-page');
const { pageCorpus, visibleText, extractFromRecruitText } = require('./src/probe-recruit-page');
async function get(u){const r=await politeGet(u,{render:'static'});return(r&&!r.blocked&&!r.error&&r.html)?{html:r.html,fin:r.finalUrl||u}:null;}
(async()=>{
  const top=await get('https://sankyocc.jp/');
  console.log('TOP fetched?',!!top);
  if(top){
    const links=findRecruitLinks(top.fin,top.html).filter(l=>!l.external);
    console.log('TOP recruit links:',links.slice(0,8).map(l=>l.url.replace('https://sankyocc.jp','')));
  }
  // direct deep page that yielded 佐々木 before
  const deep=await get('https://sankyocc.jp/recruit/graduates1.html');
  console.log('\nDEEP graduates1.html fetched?',!!deep);
  if(deep){
    const corpus=pageCorpus(deep.html);
    console.log('textLen',visibleText(deep.html).length);
    const hit=extractFromRecruitText(corpus);
    console.log('regex extract:',hit?JSON.stringify({name:hit.name,role:hit.role,conf:hit.confidence}):'なし');
    // show the recruit links found ON the recruit landing page (2nd level)
    const rl=findRecruitLinks(deep.fin,deep.html).filter(l=>!l.external);
    console.log('2nd-level recruit links:',rl.slice(0,8).map(l=>l.url.replace('https://sankyocc.jp','')));
    // any 担当/佐々木 substring?
    const t=visibleText(deep.html);
    const idx=t.indexOf('佐々木'); console.log('佐々木 at',idx, idx>=0?t.slice(idx-30,idx+20).replace(/\s+/g,' '):'');
    const di=t.search(/採用担当|担当者/); console.log('担当 ctx:', di>=0?t.slice(di-10,di+40).replace(/\s+/g,' '):'なし');
  }
})();
