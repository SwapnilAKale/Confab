'use strict';
// Codex runs a hook only once it is trusted. Connecting Codex asks Codex itself to trust Confab's own hooks, the way
// its Settings > Hooks > Trust all does, so nobody has to find that page (which in some Codex app versions lists no
// hooks at all, leaving nothing to click). Codex's app-server (the program behind the Codex app, the VS Code
// extension and the CLI, `codex app-server`, JSON-RPC over stdio) is asked:
//   hooks/list         every hook Codex finds, with its key, the hash of its current definition and its trust status;
//   config/batchWrite  hooks.state."<key>".trusted_hash = that hash, for each of Confab's hooks not yet trusted;
//   hooks/list         again, to confirm Codex now reports them trusted.
// Only hooks whose command runs Confab's adapter from the user's hooks.json are trusted; any other hook is left as it
// is. Codex computes the hash and writes the entry, so its format is never guessed here. If no Codex answers, the
// caller falls back to telling the user how to trust the hooks by hand.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn,spawnSync}=require('node:child_process');
const OURS=/adapters[\\/]+hooks[\\/]+adapter\.cjs/;

// One app-server session: call(method, params) resolves with the result or rejects with the error.
function session(exe,{env=process.env,timeoutMs=30000}={}){
 // A .cjs program is a stand-in for Codex (the tests' fake app-server), run with this Node.js.
 const script=/\.c?js$/i.test(exe),child=spawn(script?process.execPath:exe,[...(script?[exe]:[]),'app-server'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
 let buffer='',next=0,failed=null;const pending=new Map();
 const fail=error=>{if(failed)return;failed=error;for(const {reject} of pending.values())reject(error);pending.clear();};
 child.on('error',e=>fail(Error('Codex could not be started ('+exe+'): '+e.message)));
 child.on('exit',code=>fail(Error('Codex stopped before answering (exit code '+code+').')));
 child.stdout.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let m;try{m=JSON.parse(line);}catch{continue;}
  const p=m.id!==undefined&&pending.get(m.id);if(!p)continue;pending.delete(m.id);
  if(m.error)p.reject(Error(m.error.message||JSON.stringify(m.error)));else p.resolve(m.result);}});
 const timer=setTimeout(()=>fail(Error('Codex did not answer within '+Math.round(timeoutMs/1000)+' s.')),timeoutMs);
 const send=message=>{try{child.stdin.write(JSON.stringify(message)+'\n');}catch(e){fail(e);}};
 const call=(method,params)=>failed?Promise.reject(failed):new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});send({id,method,params});});
 const close=()=>{clearTimeout(timer);try{child.stdin.end();}catch{}try{child.kill();}catch{}};
 return {call,notify:method=>send({method}),close};
}
// A TOML key path segment, quoted (keys hold drive letters, backslashes and colons).
const quoted=key=>'"'+String(key).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
// Confab's hooks among those Codex lists: our adapter's command, defined in the user's hooks.json.
function ours(hooks,hooksFile){const file=path.resolve(hooksFile).toLowerCase();
 return (hooks||[]).filter(h=>h&&h.handlerType==='command'&&OURS.test(h.command||'')&&h.sourcePath&&path.resolve(h.sourcePath).toLowerCase()===file);}

// Trusts Confab's hooks with one Codex. Resolves {ok, trusted: keys newly trusted, already: keys already trusted};
// rejects when this Codex cannot be asked or does not confirm.
async function trustWith(exe,{hooksFile,env,timeoutMs}={}){
 const s=session(exe,{env,timeoutMs});
 try{
  await s.call('initialize',{clientInfo:{name:'confab',title:'Confab',version:'1'}});s.notify('initialized');
  const list=async()=>ours((await s.call('hooks/list',{cwds:[os.homedir()]}))?.data?.flatMap(d=>d.hooks||[]),hooksFile);
  const before=await list();
  if(!before.length)throw Error('Codex did not find Confab\'s hooks in '+hooksFile+'.');
  const todo=before.filter(h=>h.trustStatus!=='trusted'),already=before.filter(h=>h.trustStatus==='trusted').map(h=>h.key);
  if(todo.length){
   if(todo.some(h=>typeof h.currentHash!=='string'||!h.currentHash))throw Error('Codex did not give the hash of Confab\'s hooks.');
   await s.call('config/batchWrite',{edits:todo.map(h=>({keyPath:'hooks.state.'+quoted(h.key)+'.trusted_hash',value:h.currentHash,mergeStrategy:'upsert'})),reloadUserConfig:true});
   const after=await list(),left=after.filter(h=>h.trustStatus!=='trusted');
   if(left.length)throw Error('Codex still reports '+left.length+' of Confab\'s hooks as '+left[0].trustStatus+'.');
  }
  return {ok:true,trusted:todo.map(h=>h.key),already};
 }finally{s.close();}
}
// The Codex programs to ask, the one people run first: the Codex app from the Microsoft Store, then the others setup
// finds (the Codex app's own folder, the VS Code extension, npm, PATH). Only .exe files can run the app-server.
function codexPrograms({home=os.homedir(),env=process.env}={}){
 const hooks=require('../adapters/hooks/install.cjs'),{loadMapping}=require('../adapters/hooks/adapter.cjs');
 const store=hooks.appxLocation('OpenAI.Codex',env),first=store?[path.join(store,'app','resources','codex.exe')]:[];
 const others=hooks.candidates(loadMapping('codex').install.requires.binaries.filter(p=>!p.startsWith('APPX:')),{home,env});
 const newest=list=>list.map(f=>{try{return {f,t:fs.statSync(f).mtimeMs};}catch{return null;}}).filter(Boolean).sort((a,b)=>b.t-a.t).map(x=>x.f);
 return [...new Set([...first.filter(f=>fs.existsSync(f)),...newest(others.filter(f=>/\.exe$/i.test(f)))])];
}
// Tries each Codex until one confirms. {ok:true, exe, trusted, already} or {ok:false, error}.
async function trust({home=os.homedir(),env=process.env,hooksFile=path.join(home,'.codex','hooks.json'),programs,timeoutMs=30000}={}){
 const list=programs||codexPrograms({home,env}),errors=[];
 if(!list.length)return {ok:false,error:'No Codex program was found to ask.'};
 for(const exe of list.slice(0,3)){try{return {...await trustWith(exe,{hooksFile,env,timeoutMs}),exe};}catch(e){errors.push(e.message);}}
 return {ok:false,error:errors[0]};
}
// For synchronous callers (Connect runs synchronously from setup and the tray window): runs trust in a child process.
function trustSync({env,...options}={}){
 const r=spawnSync(process.execPath,[__filename,'--trust',JSON.stringify(options)],{encoding:'utf8',windowsHide:true,env:env||process.env,timeout:(options.timeoutMs||30000)*3+15000});
 const line=(r.stdout||'').trim().split(/\r?\n/).pop();
 try{return JSON.parse(line);}catch{return {ok:false,error:r.error?.message||(r.stderr||'').trim().split(/\r?\n/).pop()||'Codex could not be asked.'};}
}
if(require.main===module&&process.argv[2]==='--trust'){
 const options=JSON.parse(process.argv[3]||'{}');
 trust(options).then(r=>{process.stdout.write(JSON.stringify(r)+'\n');process.exit(0);},e=>{process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exit(0);});
}
module.exports={trust,trustSync,trustWith,codexPrograms,ours};
