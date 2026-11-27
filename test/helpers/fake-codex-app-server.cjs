'use strict';
// A stand-in for `codex app-server` (JSON-RPC over stdio) answering the two requests Confab uses to have Codex trust its
// hooks, the way Codex does: hooks/list lists every handler in $CODEX_HOME/hooks.json with a key
// "<file>:<event_snake>:<group>:<handler>", a hash of its definition and its trust status; config/batchWrite saves
// hooks.state."<key>".trusted_hash in $CODEX_HOME/config.toml. FAKE_CODEX_MODE changes its behaviour:
//   no-hooks-list   hooks/list is an unknown method (an older Codex)
//   ignore-writes   config/batchWrite answers ok but saves nothing
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const home=process.env.CODEX_HOME,file=path.join(home,'hooks.json'),toml=path.join(home,'config.toml'),mode=process.env.FAKE_CODEX_MODE||'';
const snake=s=>s.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();
function trusted(){const text=fs.existsSync(toml)?fs.readFileSync(toml,'utf8'):'',out={};
 for(const m of text.matchAll(/^\[hooks\.state\.'([^']*)'\]\s*\ntrusted_hash = "([^"]*)"/gm))out[m[1]]=m[2];return out;}
function list(){let config;try{config=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return [];}const t=trusted(),hooks=[];
 for(const [event,groups] of Object.entries(config.hooks||{}))groups.forEach((g,gi)=>(g.hooks||[]).forEach((h,hi)=>{
  const key=file+':'+snake(event)+':'+gi+':'+hi,hash='sha256:'+crypto.createHash('sha256').update(JSON.stringify([event,h])).digest('hex');
  hooks.push({key,eventName:event,handlerType:h.type,command:h.command,sourcePath:file,source:'user',currentHash:hash,trustStatus:t[key]===hash?'trusted':t[key]?'modified':'untrusted'});}));
 return hooks;}
function unquote(segment){return JSON.parse(segment);}
let buffer='';
const reply=(id,result,error)=>process.stdout.write(JSON.stringify(error?{id,error}:{id,result})+'\n');
process.stdin.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===undefined)continue;
 if(m.method==='initialize')reply(m.id,{userAgent:'fake'});
 else if(m.method==='hooks/list'){if(mode==='no-hooks-list')reply(m.id,null,{code:-32601,message:'Method not found: hooks/list'});else reply(m.id,{data:[{cwd:(m.params.cwds||[])[0]||'',hooks:list(),warnings:[],errors:[]}]});}
 else if(m.method==='config/batchWrite'){
  if(mode!=='ignore-writes'){let text=fs.existsSync(toml)?fs.readFileSync(toml,'utf8'):'';
   for(const e of m.params.edits){const k=/^hooks\.state\.("(?:[^"\\]|\\.)*")\.trusted_hash$/.exec(e.keyPath);if(!k){reply(m.id,null,{code:-32602,message:'bad keyPath '+e.keyPath});return;}
    text+="\n[hooks.state.'"+unquote(k[1])+"']\ntrusted_hash = \""+e.value+'"\n';}
   fs.writeFileSync(toml,text);}
  reply(m.id,{status:'ok',filePath:toml});}
 else reply(m.id,null,{code:-32601,message:'Method not found: '+m.method});}});
