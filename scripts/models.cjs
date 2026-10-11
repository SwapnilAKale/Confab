'use strict';
// Download or check the speech models listed in assets/live-models.json.
//   node scripts/models.cjs fetch          download whatever is missing or damaged, with progress; resumable
//   node scripts/models.cjs check [--full] report each piece (--full hashes every file again)
const path=require('node:path'),models=require('../src/setup/models.cjs');
const root=path.resolve(__dirname,'..'),[action,...flags]=process.argv.slice(2);
const mb=n=>(n/1048576).toFixed(0);
function progress({label,done,total,final}){
 if(total<1048576)return;// small text files: no progress line
 const line='  '+label+': '+mb(done)+' / '+mb(total)+' MB ('+(total?Math.floor(done*100/total):0)+'%)';
 if(process.stdout.isTTY){process.stdout.write('\r'+line.padEnd(78)+(final?'\n':''));}
 else if(final)console.log(line);
}
(async()=>{
 if(action==='fetch'){await models.ensure(root,{progress,log:line=>console.log(line)});console.log('All speech models are present and match assets/live-models.json.');return;}
 if(action==='check'){
  const result=models.check(root,{full:flags.includes('--full')});
  if(flags.includes('--json')){console.log(JSON.stringify(result));return;}
  for(const p of result)console.log((p.ok?'OK       ':'PROBLEM  ')+p.name+(p.ok?'':': '+[...p.missing.map(f=>'missing '+f),...p.bad.map(f=>'damaged '+f)].slice(0,5).join(', ')));
  process.exitCode=result.every(p=>p.ok)?0:1;return;
 }
 console.error('Usage: node scripts/models.cjs fetch | check [--full] [--json]');process.exitCode=2;
})().catch(e=>{if(process.stdout.isTTY)process.stdout.write('\n');console.error(e.message);process.exitCode=1;});
