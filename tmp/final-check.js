const fs=require('fs');
const {readCsv}=require('../src/csv');
const {mkey,buildExclusion}=require('../src/build-icp-fresh-1000');
const {normalizeJpPhone}=require('../src/phone');
const {isExcludedIndustry}=require('../src/icp-rules');
const n=v=>parseInt(String(v||'').replace(/[^0-9]/g,''),10)||0;
const excl=buildExclusion();
const PAST=['data/leads-icp-fresh-perfect-1000.csv','data/leads-icp-perfect-named-1000.csv','data/leads-icp-fresh-10000.csv','data/leads-icp-fresh-named-1000.csv','data/leads-icp-hire6-500.csv'];
const past=new Map();
for(const f of PAST){if(!fs.existsSync(f))continue;for(const r of readCsv(fs.readFileSync(f,'utf8')).records){const k=mkey(r['企業名']);if(k)past.set(k,f)}}
for(const file of ['data/leads-icp-nooverlap-130.csv','data/leads-icp-nooverlap-all-215.csv']){
 const rs=readCsv(fs.readFileSync(file,'utf8')).records;
 const names=rs.map(r=>mkey(r['企業名']));
 const dup=names.length-new Set(names).size;
 const hitPast=names.filter(k=>past.has(k));
 const hitCrm=names.filter(k=>excl.names.has(k));
 const bad=rs.filter(r=>n(r['年間新卒採用人数'])<6).length;
 const noPhone=rs.filter(r=>!normalizeJpPhone(String(r['電話番号']||''))).length;
 const it=rs.filter(r=>isExcludedIndustry(r['業種'])).length;
 const emp=rs.map(r=>n(r['従業員数']));
 console.log('['+file+'] '+rs.length+'件');
 console.log('  社名重複',dup,'／ 過去納品と重複',hitPast.length,'／ 既存CRMと重複',hitCrm.length);
 console.log('  6名未満',bad,'／ 電話無効',noPhone,'／ IT',it,'／ 従業員 最小'+Math.min(...emp)+' 最大'+Math.max(...emp));
}
