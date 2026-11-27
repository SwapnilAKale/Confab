'use strict';
// Connecting Codex has Codex itself trust Confab's hooks (src/setup/codex-trust.cjs), through a stand-in for
// `codex app-server` (test/helpers/fake-codex-app-server.cjs) that lists and trusts hooks the way Codex does.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const codexTrust=require('../src/setup/codex-trust.cjs'),agents=require('../src/setup/agents.cjs'),hooks=require('../src/adapters/hooks/install.cjs');
const FAKE=path.join(__dirname,'helpers','fake-codex-app-server.cjs'),OUT=path.join(__dirname,'..','test-output','codex-trust');
function setup(name,mode=''){
 const home=path.join(OUT,name+'-'+process.pid+'-'+Date.now()),codex=path.join(home,'.codex');fs.mkdirSync(codex,{recursive:true});
 const env={...process.env,CODEX_HOME:codex,FAKE_CODEX_MODE:mode,LOCALAPPDATA:path.join(home,'Local'),PATH:''};
 // Codex "installed", for the support check that connecting runs first.
 const bin=path.join(home,'Local','OpenAI','Codex','bin','x');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'codex.exe'),'last_assistant_message');
 return {home,codex,env,profile:path.join(home,'profile'),hooksFile:path.join(codex,'hooks.json'),toml:path.join(codex,'config.toml')};
}

test('Codex is asked to trust Confab\'s hooks, and only those; a second time finds them trusted already',async()=>{
 const s=setup('trust');hooks.install('codex',{home:s.home,env:s.env});
 // Someone else's hook in the same file stays untrusted.
 const config=JSON.parse(fs.readFileSync(s.hooksFile,'utf8'));config.hooks.Stop.push({hooks:[{type:'command',command:'other-tool notify'}]});fs.writeFileSync(s.hooksFile,JSON.stringify(config));
 fs.writeFileSync(s.toml,'model = "x"\n');
 const r=await codexTrust.trust({home:s.home,env:s.env,hooksFile:s.hooksFile,programs:[FAKE]});
 assert.equal(r.ok,true,r.error);assert.equal(r.exe,FAKE);assert.equal(r.trusted.length,3,'UserPromptSubmit, Stop and SessionEnd');
 const toml=fs.readFileSync(s.toml,'utf8');
 assert.match(toml,/^model = "x"$/m,'the rest of config.toml is kept');
 assert.equal((toml.match(/\[hooks\.state\./g)||[]).length,3);assert.doesNotMatch(toml,/stop:1:0/,'the other tool\'s hook is not trusted');
 assert.equal(agents.codexTrusted({home:s.home}),true,'Confab\'s own check agrees');
 const again=await codexTrust.trust({home:s.home,env:s.env,hooksFile:s.hooksFile,programs:[FAKE]});
 assert.deepEqual([again.ok,again.trusted.length,again.already.length],[true,0,3]);
});

test('a Codex that cannot be asked, or does not confirm, is reported; the next one found is tried',async()=>{
 const s=setup('fail','no-hooks-list');hooks.install('codex',{home:s.home,env:s.env});
 const old=await codexTrust.trust({home:s.home,env:s.env,hooksFile:s.hooksFile,programs:[FAKE]});
 assert.equal(old.ok,false);assert.match(old.error,/hooks\/list/);
 const missing=path.join(s.home,'no-such-codex.exe');
 const next=await codexTrust.trust({home:s.home,env:{...s.env,FAKE_CODEX_MODE:''},hooksFile:s.hooksFile,programs:[missing,FAKE]});
 assert.equal(next.ok,true,'the first could not be started, the second trusted them');assert.equal(next.exe,FAKE);
 const s2=setup('ignored','ignore-writes');hooks.install('codex',{home:s2.home,env:s2.env});
 const ignored=await codexTrust.trust({home:s2.home,env:s2.env,hooksFile:s2.hooksFile,programs:[FAKE]});
 assert.equal(ignored.ok,false);assert.match(ignored.error,/still reports 3 of Confab's hooks as untrusted/);
 const none=await codexTrust.trust({home:s.home,env:s.env,hooksFile:s.hooksFile,programs:[]});
 assert.deepEqual(none,{ok:false,error:'No Codex program was found to ask.'});
});

test('Connect for Codex installs the hooks and has Codex trust them: connected, no step left; if Codex cannot be asked, the step stays with the reason',()=>{
 const s=setup('connect');
 const r=agents.connect('codex',{home:s.home,env:s.env,profile:s.profile,codexPrograms:[FAKE],processes:[]});
 assert.equal(r.state,'connected',JSON.stringify(r));assert.equal(r.step,null);assert.equal(r.trustError,undefined);
 assert.ok(r.lines.some(l=>/^Codex trusted Confab's hooks \(3\)/.test(l)),r.lines.join('\n'));
 // Disconnect removes the trust entries again.
 agents.disconnect('codex',{home:s.home,env:s.env,profile:s.profile});assert.equal(fs.readFileSync(s.toml,'utf8').includes('hooks.state'),false);
 const f=setup('connect-fail','no-hooks-list');
 const q=agents.connect('codex',{home:f.home,env:f.env,profile:f.profile,codexPrograms:[FAKE],processes:[]});
 assert.equal(q.state,'needs-action');assert.match(q.trustError,/hooks\/list/);assert.match(q.step,/Click Connect to have Codex trust Confab's hooks\. Or trust them in Codex: .*"Trust all"\. In the Codex CLI: type \/hooks and press t\./);
});

test('a Store app is looked up only when no other program was found (asking Windows is slow)',()=>{
 const s=setup('appx');
 // Without the package's data folder (%LOCALAPPDATA%\Packages\OpenAI.Codex_...) Windows is never asked.
 assert.equal(hooks.appxLocation('OpenAI.Codex',s.env),null);
 assert.deepEqual(hooks.candidates(['%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe','APPX:OpenAI.Codex:app/resources/codex.exe'],{home:s.home,env:s.env}),[path.join(s.home,'Local','OpenAI','Codex','bin','x','codex.exe')]);
});
