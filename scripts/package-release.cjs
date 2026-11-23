'use strict';
// Builds the two GitHub Release assets for a tagged version of Confab:
//   - Confab-v<version>.zip: everything setup.cmd needs, at the archive root (Windows "Extract All" adds the folder).
//   - latest.json: small version manifest fetched by Confab's optional daily update check.
// Usage: node scripts/package-release.cjs [--out dist] [--tag v0.8.0]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');

// Kept in sync with the copy list in scripts/setup.ps1, plus LICENSE for the distributed archive.
const RELEASE_DIRS=['src','scripts','docs','assets/notices'];
const RELEASE_FILES=['package.json','package-lock.json','README.md','THIRD_PARTY_NOTICES.md','LICENSE','setup.cmd','uninstall.cmd','assets/live-models.json','assets/runtime.json','assets/app.ico'];
const EXCLUDED_NAMES=new Set(['__pycache__']);

function repoSlug(pkg){
 const raw=typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url||pkg.homepage||'';
 const m=/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(raw);
 if(!m)throw Error('package.json must name the GitHub repository URL');
 return m[1];
}

function walkDir(root,rel,out){
 const dir=path.join(root,rel);
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(EXCLUDED_NAMES.has(entry.name)||entry.name.endsWith('.pyc'))continue;
  const child=rel+'/'+entry.name;
  if(entry.isDirectory())walkDir(root,child,out);
  else if(entry.isFile())out.push(child);
 }
}

function collectFiles(root){
 const files=[];
 for(const dir of RELEASE_DIRS){
  const full=path.join(root,dir);
  if(!fs.existsSync(full)||!fs.statSync(full).isDirectory())throw Error('Missing release directory: '+dir);
  walkDir(root,dir,files);
 }
 for(const file of RELEASE_FILES){
  const full=path.join(root,file);
  if(!fs.existsSync(full)||!fs.statSync(full).isFile())throw Error('Missing release file: '+file);
  files.push(file);
 }
 return files.sort();
}

function verifyNotices(root){
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'assets','live-models.json'),'utf8'));
 for(const piece of manifest.pieces||[]){
  for(const f of piece.files||[]){
   const src=piece.download?.extra?.[f.path];
   if(!src||!src.startsWith('repo:'))continue;
   const rel=src.slice(5),data=fs.readFileSync(path.join(root,rel));
   const hash=crypto.createHash('sha256').update(data).digest('hex');
   if(hash!==f.sha256)throw Error(rel+' SHA-256 mismatch (expected '+f.sha256+', got '+hash+')');
  }
 }
}

function buildManifest(pkg,{now=new Date()}={}){
 const version=pkg.version;
 if(!/^\d+\.\d+\.\d+$/.test(version||''))throw Error('Invalid package.json version: '+version);
 const slug=repoSlug(pkg),tag='v'+version,asset='Confab-'+tag+'.zip';
 return {version,tag,url:'https://github.com/'+slug+'/releases/tag/'+tag,asset,publishedAt:now.toISOString()};
}

function createZip(stageDir,zipPath,files){
 fs.rmSync(zipPath,{force:true});
 if(process.platform==='win32'){
  const tar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
  const res=spawnSync(tar,['-a','-cf',zipPath,'-C',stageDir,'.'],{stdio:'pipe',encoding:'utf8'});
  if(res.status!==0)throw Error('tar.exe failed: '+(res.stderr||res.stdout||'exit '+res.status));
  return;
 }
 const res=spawnSync('zip',['-q','-r',zipPath,'.'],{cwd:stageDir,stdio:'pipe',encoding:'utf8'});
 if(res.status===0)return;
 if(res.error?.code!=='ENOENT')throw Error('zip failed: '+(res.stderr||res.stdout||'exit '+res.status));
 const py=spawnSync('python3',['-c','import os,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n for f in sys.argv[3:]: z.write(os.path.join(sys.argv[2],f),f)\n',zipPath,stageDir,...files],{stdio:'pipe',encoding:'utf8'});
 if(py.status!==0)throw Error('Could not create zip archive: '+(py.stderr||py.stdout||'exit '+py.status));
}

function pack(root,{outDir=path.join(root,'dist'),tag=null,now=new Date()}={}){
 root=path.resolve(root);outDir=path.resolve(outDir);
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const manifest=buildManifest(pkg,{now});
 if(tag&&tag!==manifest.tag)throw Error('Tag '+tag+' does not match package.json version '+pkg.version+' (expected '+manifest.tag+')');
 verifyNotices(root);
 const files=collectFiles(root);
 fs.mkdirSync(outDir,{recursive:true});
 const stageDir=fs.mkdtempSync(path.join(outDir,'.stage-'));
 try{
  for(const rel of files){
   const src=path.join(root,rel),dst=path.join(stageDir,rel);
   fs.mkdirSync(path.dirname(dst),{recursive:true});
   if(rel.endsWith('.cmd')){
    // Keep Windows CRLF line endings for batch launchers regardless of build OS.
    const text=fs.readFileSync(src,'utf8').replace(/\r?\n/g,'\r\n');
    fs.writeFileSync(dst,text,'utf8');
   }else fs.copyFileSync(src,dst);
  }
  const zipPath=path.join(outDir,manifest.asset);
  createZip(stageDir,zipPath,files);
  const manifestPath=path.join(outDir,'latest.json');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n','utf8');
  return {zipPath,manifestPath,manifest,files};
 }finally{fs.rmSync(stageDir,{recursive:true,force:true});}
}

if(require.main===module){
 const args=process.argv.slice(2);let outDir,tag=null;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--out'&&args[i+1])outDir=args[++i];
  else if(args[i]==='--tag'&&args[i+1])tag=args[++i];
 }
 const root=path.resolve(__dirname,'..');
 const result=pack(root,{...(outDir?{outDir:path.resolve(outDir)}:{}),tag});
 console.log('Packaged '+result.manifest.asset+' ('+result.files.length+' files) and latest.json in '+path.dirname(result.zipPath));
}

module.exports={RELEASE_DIRS,RELEASE_FILES,repoSlug,buildManifest,collectFiles,verifyNotices,pack};
