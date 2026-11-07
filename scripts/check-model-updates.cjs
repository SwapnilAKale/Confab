'use strict';
// Maintenance check: has anything newer been published for the speech models? Setup downloads every model from a
// pinned commit (see the note in assets/live-models.json), so nothing changes by itself. This reports what has moved
// on since, for a person to benchmark and then pin (docs/DEVELOPER_GUIDE.md, "Updating a model"):
//   - a pinned source with a revision newer than watch.since in which a file Confab uses changed;
//   - new models from a piece's "watch" list (Hugging Face searches, GitHub releases) published after watch.since.
// Once those are reviewed, move watch.since forward, whether or not anything was taken.
//   node scripts/check-model-updates.cjs [--json]
// Exit code 0: nothing new. 1: something to review. 2: a source could not be checked.
// It runs monthly on GitHub (.github/workflows/model-updates.yml): a failed run there means there is something new.
const fs=require('node:fs'),path=require('node:path'),models=require('../src/setup/models.cjs');

async function getJson(url){
 const headers={accept:'application/json','user-agent':'confab-model-check'};
 if(url.startsWith('https://api.github.com/')&&process.env.GITHUB_TOKEN)headers.authorization='Bearer '+process.env.GITHUB_TOKEN;
 const res=await fetch(url,{headers});
 if(!res.ok)throw Error(url+' answered '+res.status);
 return res.json();
}
const HF=/^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:resolve|raw)\/([0-9a-f]{40})\/(.*)$/,GH=/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.*)$/;
// The pinned repositories a piece downloads from, each with the files Confab takes from it (file in the piece:
// path in the repository).
function sources(piece){
 const out=new Map(),d=piece.download||{};
 const add=(url,file)=>{
  const m=HF.exec(url)||GH.exec(url);if(!m)return;
  const kind=HF.test(url)?'huggingface':'github',key=kind+' '+m[1]+'@'+m[2];
  if(!out.has(key))out.set(key,{kind,repo:m[1],rev:m[2],files:{}});
  out.get(key).files[file]=decodeURIComponent(m[3]);
 };
 const extra=d.extra||{};
 for(const f of piece.files){if(extra[f.path])add(extra[f.path],f.path);else if(d.base)add(d.base+f.path,f.path);}
 return [...out.values()];
}
const short=sha=>sha.slice(0,7),day=iso=>String(iso).slice(0,10);
// A newer revision dated before since was already reviewed (and not taken).
async function checkSource(src,since,get){
 if(src.kind==='huggingface'){
  const api='https://huggingface.co/api/models/'+src.repo,latest=await get(api+'/revision/main');
  if(latest.sha===src.rev||latest.lastModified<=since)return null;
  const tree=async rev=>new Map((await get(api+'/tree/'+rev+'?recursive=true')).filter(e=>e.type==='file').map(e=>[e.path,e.lfs?.oid||e.oid]));
  const [now,then]=await Promise.all([tree(latest.sha),tree(src.rev)]);
  const changed=Object.entries(src.files).filter(([,p])=>now.get(p)!==then.get(p)).map(([f])=>f);
  return {where:src.repo,pinned:short(src.rev),latest:short(latest.sha)+' ('+day(latest.lastModified)+')',changed};
 }
 const api='https://api.github.com/repos/'+src.repo,head=(await get(api+'/commits?per_page=1'))[0],changed=[];
 if(head.sha===src.rev||head.commit.committer.date<=since)return null;
 for(const [file,p] of Object.entries(src.files)){
  const [now,then]=await Promise.all([get(api+'/contents/'+p),get(api+'/contents/'+p+'?ref='+src.rev)]);
  if(now.sha!==then.sha)changed.push(file);
 }
 return {where:src.repo,pinned:short(src.rev),latest:short(head.sha)+' ('+day(head.commit.committer.date)+')',changed};
}
async function checkWatch(piece,get){
 const w=piece.watch;if(!w)return [];
 const found=[],pinned=new Set(sources(piece).map(s=>s.repo));
 for(const q of w.huggingface||[]){
  const list=await get('https://huggingface.co/api/models?author='+encodeURIComponent(q.author)+'&search='+encodeURIComponent(q.search)+'&limit=1000');
  for(const m of list)if(m.createdAt>w.since&&!pinned.has(m.id))found.push({name:m.id,date:day(m.createdAt),url:'https://huggingface.co/'+m.id});
 }
 if(w.githubReleases){
  for(const r of await get('https://api.github.com/repos/'+w.githubReleases+'/releases?per_page=20'))
   if(r.published_at>w.since&&!r.draft)found.push({name:w.githubReleases+' '+r.tag_name,date:day(r.published_at),url:r.html_url});
 }
 return found.sort((a,b)=>b.date.localeCompare(a.date));
}
// One report per piece: changes in its pinned sources, new models to consider, and any source that failed.
async function check(root,{get=getJson}={}){
 const report=[];
 for(const piece of models.manifest(root).pieces){
  const r={name:piece.name,updates:[],newModels:[],errors:[]};
  for(const src of sources(piece)){try{const u=await checkSource(src,piece.watch?.since||'',get);if(u&&u.changed.length)r.updates.push(u);}catch(e){r.errors.push(e.message);}}
  try{r.newModels=await checkWatch(piece,get);}catch(e){r.errors.push(e.message);}
  report.push(r);
 }
 return report;
}
function format(report){
 const lines=[];
 for(const r of report){
  lines.push('## '+r.name);
  if(!r.updates.length&&!r.newModels.length&&!r.errors.length){lines.push('Up to date.','');continue;}
  for(const u of r.updates)lines.push('- **'+u.where+'** has a newer revision, '+u.latest+' (pinned: '+u.pinned+'). Changed: '+u.changed.join(', ')+'.');
  for(const m of r.newModels)lines.push('- New model: ['+m.name+']('+m.url+'), '+m.date+'.');
  for(const e of r.errors)lines.push('- Could not check: '+e);
  lines.push('');
 }
 lines.push('Before pinning anything, follow "Updating a model" in docs/DEVELOPER_GUIDE.md: benchmark it against the current one first.');
 return lines.join('\n');
}
module.exports={check,format,sources};
if(require.main===module){
 check(path.resolve(__dirname,'..')).then(report=>{
  const text=format(report);
  console.log(process.argv.includes('--json')?JSON.stringify(report,null,1):text);
  if(process.env.GITHUB_STEP_SUMMARY)try{fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'# Speech model check\n\n'+text+'\n');}catch{}
  process.exitCode=report.some(r=>r.errors.length)?2:report.some(r=>r.updates.length||r.newModels.length)?1:0;
 },e=>{console.error(e.message);process.exitCode=2;});
}
