'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawnSync}=require('node:child_process');
const updater=require('../src/pc/update-check.cjs');
const packager=require('../scripts/package-release.cjs');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'test-output','update-check');

function scratch(name){
 const dir=path.join(OUT,name+'-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,6));
 fs.mkdirSync(dir,{recursive:true});
 return dir;
}

test('version comparison and manifest validation accept only newer semver and GitHub release URLs',()=>{
 assert.equal(updater.isNewerVersion('0.8.1','0.8.0'),true);
 assert.equal(updater.isNewerVersion('0.10.0','0.9.9'),true);
 assert.equal(updater.isNewerVersion('1.0.0','0.9.9'),true);
 assert.equal(updater.isNewerVersion('v0.9.0','0.8.0'),true);
 assert.equal(updater.isNewerVersion('0.8.0','0.8.0'),false);
 assert.equal(updater.isNewerVersion('0.7.9','0.8.0'),false);
 assert.equal(updater.isNewerVersion('bad','0.8.0'),false);

 const valid=updater.validateManifest({version:'0.9.0',url:updater.RELEASES_PREFIX+'tag/v0.9.0'});
 assert.deepEqual(valid,{version:'0.9.0',url:updater.RELEASES_PREFIX+'tag/v0.9.0'});
 assert.equal(updater.validateManifest({version:'0.9.0',url:'https://evil.example/Confab.zip'}),null,'foreign URLs are rejected');
 assert.equal(updater.validateManifest({version:'0.9.0',url:updater.RELEASES_PREFIX+'tag/v0.9.0" --bad'}),null,'URLs with quotes or spaces are rejected');
 assert.equal(updater.validateManifest({version:'not-semver',url:updater.RELEASES_PREFIX+'latest'}),null);
});

test('UpdateChecker checks once per 24h, notifies once per version, persists across restarts, and clears after upgrade',async t=>{
 let payload={version:'0.9.0',url:updater.RELEASES_PREFIX+'tag/v0.9.0'},status=200,hits=0;
 const srv=http.createServer((req,res)=>{
  hits++;
  res.writeHead(status,{'content-type':'application/json'});
  res.end(typeof payload==='string'?payload:JSON.stringify(payload));
 });
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>srv.close(r)));
 const url='http://127.0.0.1:'+srv.address().port+'/latest.json';
 const profile=scratch('checker');
 t.after(()=>fs.rmSync(profile,{recursive:true,force:true}));

 let now=1_000_000;
 const events=[];
 const c1=new updater.UpdateChecker({profile,currentVersion:'0.8.0',url,clock:()=>now,onUpdate:e=>events.push(e)});
 t.after(()=>c1.close());
 assert.equal(c1.available,null);

 // First check finds v0.9.0 and notifies.
 await c1.checkIfDue();
 assert.equal(hits,1);
 assert.deepEqual(c1.available,{version:'0.9.0',url:updater.RELEASES_PREFIX+'tag/v0.9.0'});
 assert.deepEqual(events,[{version:'0.9.0',url:updater.RELEASES_PREFIX+'tag/v0.9.0',notify:true}]);

 // Within 24h, no second request is made.
 now+=12*60*60*1000;
 await c1.checkIfDue();
 assert.equal(hits,1,'throttled to once per 24 hours');

 // After 24h, re-checks but does not notify again for the same version.
 now+=13*60*60*1000;
 await c1.checkIfDue();
 assert.equal(hits,2);
 assert.equal(events.length,2);
 assert.equal(events[1].notify,false,'does not repeat notification for the same version');

 // Restarting on the same old version restores the cached update without hitting the network.
 const c2=new updater.UpdateChecker({profile,currentVersion:'0.8.0',url,clock:()=>now});
 t.after(()=>c2.close());
 assert.deepEqual(c2.available,{version:'0.9.0',url:updater.RELEASES_PREFIX+'tag/v0.9.0'});
 await c2.checkIfDue();
 assert.equal(hits,2,'cached timestamp survives restart');

 // A newer version triggers a fresh notification.
 now+=25*60*60*1000;
 payload={version:'0.10.0',url:updater.RELEASES_PREFIX+'tag/v0.10.0'};
 const events2=[];
 const c3=new updater.UpdateChecker({profile,currentVersion:'0.8.0',url,clock:()=>now,onUpdate:e=>events2.push(e)});
 t.after(()=>c3.close());
 await c3.checkIfDue();
 assert.equal(hits,3);
 assert.deepEqual(events2,[{version:'0.10.0',url:updater.RELEASES_PREFIX+'tag/v0.10.0',notify:true}]);

 // After upgrading to v0.10.0, the cached update clears immediately.
 const c4=new updater.UpdateChecker({profile,currentVersion:'0.10.0',url,clock:()=>now});
 t.after(()=>c4.close());
 assert.equal(c4.available,null);

 // Offline / error responses fail silently and keep previous state.
 now+=25*60*60*1000;
 status=500;payload='error';
 await c3.checkIfDue();
 assert.deepEqual(c3.available,{version:'0.10.0',url:updater.RELEASES_PREFIX+'tag/v0.10.0'});

 // Disabling prevents network calls and hides the pending update.
 c3.setEnabled(false);
 assert.equal(c3.available,null);
 const before=hits;
 await c3.checkIfDue({force:true});
 assert.equal(hits,before);
});

test('package-release builds Confab-vX.Y.Z.zip and latest.json matching setup.ps1 and validates tags',t=>{
 const outDir=scratch('release');
 t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
 const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
 assert.throws(()=>packager.pack(ROOT,{outDir,tag:'v0.0.1'}),/does not match package\.json version/);

 const res=packager.pack(ROOT,{outDir,tag:'v'+pkg.version});
 assert.equal(path.basename(res.zipPath),'Confab-v'+pkg.version+'.zip');
 assert.ok(fs.existsSync(res.zipPath));
 assert.ok(fs.existsSync(res.manifestPath));
 const manifest=JSON.parse(fs.readFileSync(res.manifestPath,'utf8'));
 assert.equal(manifest.version,pkg.version);
 assert.equal(manifest.tag,'v'+pkg.version);
 assert.equal(manifest.asset,'Confab-v'+pkg.version+'.zip');
 assert.deepEqual(updater.validateManifest(manifest),{version:pkg.version,url:manifest.url});

 // Every file/dir setup.ps1 copies must be in the release package list.
 const setupPs1=fs.readFileSync(path.join(ROOT,'scripts','setup.ps1'),'utf8');
 const dirsMatch=/\$dirs\s*=\s*@\(([^)]+)\)/.exec(setupPs1);
 const filesMatch=/\$files\s*=\s*@\(([^)]+)\)/.exec(setupPs1);
 const parseList=m=>[...m[1].matchAll(/'([^']+)'/g)].map(x=>x[1].replace(/\\/g,'/'));
 for(const d of parseList(dirsMatch))assert.ok(packager.RELEASE_DIRS.includes(d),'release includes setup dir '+d);
 for(const f of parseList(filesMatch))assert.ok(packager.RELEASE_FILES.includes(f),'release includes setup file '+f);

 // Unpack the zip and check key files, line endings, and exclusions.
 if(process.platform==='win32'){
  const unpacked=path.join(outDir,'unpacked');
  fs.mkdirSync(unpacked,{recursive:true});
  const tar=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
  assert.equal(spawnSync(tar,['-xf',res.zipPath,'-C',unpacked]).status,0);
  assert.ok(fs.existsSync(path.join(unpacked,'setup.cmd')));
  assert.ok(fs.existsSync(path.join(unpacked,'LICENSE')));
  assert.ok(fs.existsSync(path.join(unpacked,'src','pc','update-check.cjs')));
  assert.equal(fs.existsSync(path.join(unpacked,'test')),false,'tests are excluded from release archive');
  assert.equal(fs.existsSync(path.join(unpacked,'node_modules')),false,'node_modules is excluded');
  const setupCmd=fs.readFileSync(path.join(unpacked,'setup.cmd'),'utf8');
  assert.ok(setupCmd.includes('\r\n'),'setup.cmd keeps Windows CRLF line endings');
 }
});
