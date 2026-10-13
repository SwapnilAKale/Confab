'use strict';
// Downloads and checks the four live speech pieces listed in assets/live-models.json. That file is the only source
// of truth: every file must have its listed size and SHA-256, and each download (archive or file) is checked against
// the size and SHA-256 recorded for it before anything is unpacked. Downloads resume from a ".part" file.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const STAMP='models-verified.json';

function manifest(root){return JSON.parse(fs.readFileSync(path.join(root,'assets','live-models.json'),'utf8'));}
function sha256File(file){
 const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),chunk=Buffer.alloc(4*1048576);
 try{let n;while((n=fs.readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,n));}finally{fs.closeSync(fd);}
 return hash.digest('hex');
}
// A full hash of 1 GB takes seconds, so a file already hashed is trusted while its size and modification time are
// unchanged (recorded in assets/models-verified.json). full:true hashes every file again.
function readStamp(root){try{return JSON.parse(fs.readFileSync(path.join(root,'assets',STAMP),'utf8'));}catch{return {};}}
function writeStamp(root,stamp){fs.writeFileSync(path.join(root,'assets',STAMP),JSON.stringify(stamp)+'\n');}
function checkPiece(root,piece,{full=false,stamp=readStamp(root)}={}){
 const missing=[],bad=[];
 for(const f of piece.files){
  const file=path.join(root,piece.path,f.path);let st;
  try{st=fs.statSync(file);}catch{missing.push(f.path);continue;}
  if(st.size!==f.size){bad.push(f.path);continue;}
  const key=piece.path+'/'+f.path,seen=stamp[key];
  if(!full&&seen&&seen[0]===st.size&&seen[1]===st.mtimeMs&&seen[2]===f.sha256)continue;
  if(sha256File(file)!==f.sha256){bad.push(f.path);delete stamp[key];continue;}
  stamp[key]=[st.size,st.mtimeMs,f.sha256];
 }
 return {ok:!missing.length&&!bad.length,missing,bad};
}
function check(root,{full=false}={}){
 const stamp=readStamp(root),result=manifest(root).pieces.map(piece=>({name:piece.name,path:piece.path,bytes:piece.totalBytes,...checkPiece(root,piece,{full,stamp})}));
 try{writeStamp(root,stamp);}catch{}
 return result;
}
const mb=n=>(n/1048576).toFixed(0)+' MB';
// Download url to dest, resuming dest.part. Checks the final size and SHA-256 when given; a mismatch deletes the
// partial file so the next attempt starts clean.
async function download(url,dest,{size,sha256,label=path.basename(dest),progress=()=>{},fetchImpl=globalThis.fetch,attempts=4}={}){
 const part=dest+'.part';fs.mkdirSync(path.dirname(dest),{recursive:true});
 for(let attempt=1;;attempt++){
  let have=0;try{have=fs.statSync(part).size;}catch{}
  if(size&&have>size){fs.rmSync(part,{force:true});have=0;}
  try{
   if(!size||have<size){
    const res=await fetchImpl(url,{headers:have?{range:'bytes='+have+'-'}:{},redirect:'follow'});
    if(res.status===416&&size&&have===size){/* already complete */}
    else{
     if(res.status!==200&&res.status!==206)throw Error('the server answered '+res.status+' '+(res.statusText||''));
     if(res.status===200&&have){have=0;}// no resume support: start again
     const total=size||have+Number(res.headers.get('content-length')||0);
     let done=have,last=0;
     const counter=new (require('node:stream').Transform)({transform(chunk,_,cb){done+=chunk.length;const now=Date.now();if(now-last>250){last=now;progress({label,done,total});}cb(null,chunk);}});
     await pipeline(Readable.fromWeb(res.body),counter,fs.createWriteStream(part,{flags:have?'a':'w'}));
     progress({label,done,total,final:true});
    }
   }
   const got=fs.statSync(part).size;
   if(size&&got!==size)throw Error('the download stopped at '+mb(got)+' of '+mb(size));
   if(sha256&&sha256File(part)!==sha256){fs.rmSync(part,{force:true});throw Object.assign(Error(label+' did not match its SHA-256 checksum, so it was deleted.'),{fatal:attempt>=2});}
   fs.renameSync(part,dest);return dest;
  }catch(error){
   if(attempt>=attempts||error.fatal)throw Error('Could not download '+label+' from '+url+': '+error.message);
   await new Promise(r=>setTimeout(r,1000*attempt));
  }
 }
}
// Windows' own tar (bsdtar) unpacks both .tar.bz2 and .zip (a wheel is a zip).
function extract(archive,dir){
 fs.mkdirSync(dir,{recursive:true});
 const tar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
 const r=spawnSync(tar,['-xf',archive,'-C',dir],{windowsHide:true,encoding:'utf8'});
 if(r.error||r.status!==0)throw Error('Could not unpack '+path.basename(archive)+': '+(r.error?.message||r.stderr||'tar exited with '+r.status));
}
function place(src,dst){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.rmSync(dst,{force:true});fs.renameSync(src,dst);}
// Fetch whatever a piece is missing. A piece's "download" names where each file comes from:
//   extra:   {file: url}, or "repo:<path>" for a file this project ships (checked against the same SHA-256)
//   archive: {url, size, sha256, folder}: downloaded, checked, unpacked into a staging folder; only listed files move in
//   base:    a URL prefix; each file is downloaded on its own
async function fetchPiece(root,piece,state,{downloads,progress,log=()=>{}}){
 const spec=piece.download;if(!spec)throw Error('assets/live-models.json has no download source for '+piece.name+'.');
 const target=path.join(root,piece.path),need=[...state.missing,...state.bad],work=path.join(downloads,path.basename(piece.path));
 const extra=spec.extra||{},fromArchive=need.filter(n=>!extra[n]&&spec.archive),single=need.filter(n=>!fromArchive.includes(n));
 const total=single.reduce((sum,n)=>sum+piece.files.find(x=>x.path===n).size,0),many=single.length>8,got=new Map();
 const sum=()=>[...got.values()].reduce((a,b)=>a+b,0);
 async function one(name){
  const f=piece.files.find(x=>x.path===name),source=extra[name]||(spec.base?spec.base+name.split('/').map(encodeURIComponent).join('/'):null);
  if(!source)throw Error(piece.name+': no download source for '+name+'.');
  if(source.startsWith('repo:')){
   const file=path.join(root,source.slice(5));
   // The manifest hashes the file as stored in the repository (Unix line endings). A Windows checkout can convert a
   // text file to CRLF (Git for Windows does by default), so accept that file too and copy the original bytes.
   const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
   let bytes=fs.existsSync(file)?fs.readFileSync(file):null;
   if(bytes&&hash(bytes)!==f.sha256)bytes=Buffer.from(bytes.toString('latin1').replace(/\r\n/g,'\n'),'latin1');
   if(!bytes||hash(bytes)!==f.sha256)throw Error(piece.name+': '+source.slice(5)+' is missing or does not match its checksum.');
   fs.mkdirSync(path.dirname(path.join(target,name)),{recursive:true});fs.writeFileSync(path.join(target,name),bytes);return;
  }
  // Many small files (Kokoro has 377): one progress line for the piece, not one per file.
  await download(source,path.join(work,name),{size:f.size,sha256:f.sha256,label:many?piece.name:piece.name+': '+name,progress:many?p=>{got.set(name,p.done);progress({label:piece.name,done:sum(),total,final:false});}:progress});
  got.set(name,f.size);if(many)progress({label:piece.name,done:sum(),total,final:sum()===total});
  place(path.join(work,name),path.join(target,name));
 }
 // Up to 6 files at a time.
 const queue=[...single];
 await Promise.all(Array.from({length:Math.min(6,queue.length)},async()=>{while(queue.length)await one(queue.shift());}));
 if(fromArchive.length){
  const a=spec.archive,archive=path.join(downloads,path.basename(new URL(a.url).pathname));
  await download(a.url,archive,{size:a.size,sha256:a.sha256,label:piece.name,progress});
  const staging=path.join(downloads,'unpack-'+path.basename(piece.path));
  fs.rmSync(staging,{recursive:true,force:true});
  log('  Unpacking '+piece.name+' (this can take a minute or two)...');
  extract(archive,staging);
  for(const name of fromArchive){
   const src=path.join(staging,a.folder||'',name);
   if(!fs.existsSync(src))throw Error(piece.name+': '+name+' is not in the downloaded archive.');
   place(src,path.join(target,name));
  }
  fs.rmSync(staging,{recursive:true,force:true});fs.rmSync(archive,{force:true});
 }
 fs.rmSync(work,{recursive:true,force:true});
}
// Folders of pieces an earlier version used ("retired" in the manifest), deleted on setup and uninstall.
function removeRetired(root,{log=()=>{}}={}){
 const removed=[];
 for(const r of manifest(root).retired||[]){const dir=path.join(root,r.path);if(!fs.existsSync(dir))continue;fs.rmSync(dir,{recursive:true,force:true});removed.push(r.path);log('Removed '+r.path+' (no longer used).');}
 if(removed.length){const stamp=readStamp(root);for(const key of Object.keys(stamp))if(removed.some(p=>key.startsWith(p+'/')))delete stamp[key];try{writeStamp(root,stamp);}catch{}}
 return removed;
}
async function ensure(root,{downloads=path.join(root,'..','downloads'),progress=()=>{},log=()=>{},full=false}={}){
 removeRetired(root,{log});
 const pieces=manifest(root).pieces,stamp=readStamp(root),report=[];
 for(const piece of pieces){
  log('Checking '+piece.name+'...');
  let state=checkPiece(root,piece,{full,stamp});
  if(state.ok){log('  Present and verified ('+mb(piece.totalBytes)+').');report.push({name:piece.name,action:'verified'});continue;}
  const count=state.missing.length+state.bad.length;
  log('  '+(state.missing.length===piece.files.length?'Not downloaded yet':count+' file(s) missing or damaged')+'. Downloading from '+new URL(piece.download?.archive?.url||piece.download?.base||piece.source).host+' ...');
  await fetchPiece(root,piece,state,{downloads,progress,log});
  state=checkPiece(root,piece,{full:true,stamp});
  if(!state.ok)throw Error(piece.name+' failed its SHA-256 check after download: '+[...state.missing,...state.bad].slice(0,5).join(', '));
  log('  Downloaded and verified against assets/live-models.json.');report.push({name:piece.name,action:'downloaded'});
  try{writeStamp(root,stamp);}catch{}
 }
 try{writeStamp(root,stamp);}catch{}
 try{fs.rmdirSync(downloads);}catch{}
 return report;
}
module.exports={manifest,check,checkPiece,ensure,removeRetired,download,extract,sha256File};
