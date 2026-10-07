'use strict';
// Compares the Node normaliser with NeMo's own English text-normalisation test cases (r1.2.0,
// test/fixtures/nemo-reference). Usage: node scripts/compare-normalizer.cjs [--diff]
const fs=require('node:fs'),path=require('node:path');
const {normalize}=require('../src/pc/spoken-normalizer.cjs');
const DIR=path.join(__dirname,'..','test','fixtures','nemo-reference');
// Same spoken words: case, punctuation, hyphens and NeMo's optional "and" after "hundred" are ignored.
const loose=s=>s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu,' ').replace(/\bhundred and\b/g,'hundred').replace(/\s+/g,' ').trim();
function compare(){
 const rows=[];
 for(const file of fs.readdirSync(DIR).filter(f=>f.startsWith('test_cases_')).sort()){
  const category=file.slice(11,-4);
  for(const line of fs.readFileSync(path.join(DIR,file),'utf8').split(/\r?\n/)){
   const at=line.indexOf('~');if(at<0)continue;
   const input=line.slice(0,at),nemo=line.slice(at+1),node=normalize(input,{dateOrder:'mdy'});// NeMo's English grammar is month-first
   rows.push({category,input,nemo,node,result:node===nemo?'exact':loose(node)===loose(nemo)?'same words':'different'});
  }
 }
 return rows;
}
if(require.main===module){
 const rows=compare(),by={};
 for(const r of rows){by[r.category]??={exact:0,'same words':0,different:0};by[r.category][r.result]++;}
 console.table(by);
 const total=rows.length,same=rows.filter(r=>r.result!=='different').length;console.log(`same spoken words: ${same}/${total}`);
 if(process.argv.includes('--diff'))for(const r of rows.filter(r=>r.result==='different'))console.log(`[${r.category}] ${r.input}\n   NeMo: ${r.nemo}\n   Node: ${r.node}`);
}
module.exports={compare,loose};
