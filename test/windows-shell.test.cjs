'use strict';
// Regression: Local Voice installed from a packaged app's terminal (the Claude desktop app) landed in that app's private
// copy of %LOCALAPPDATA%, and the service started from there belonged to the app's job object. It died when the app
// closed, and Windows could not start it again (sign-in entry and Start menu found no launcher).
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const HELPERS=path.join(__dirname,'..','scripts','windows-shell.ps1');
const OUT=path.join(__dirname,'..','test-output','windows-shell');
const win=process.platform!=='win32';
function ps(script){const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','. "'+HELPERS+'"; '+script],{encoding:'utf8',windowsHide:true,timeout:60000});return {out:(r.stdout||'').trim(),err:(r.stderr||'').trim(),status:r.status};}
function scratch(name){const dir=path.join(OUT,name+'-'+process.pid+'-'+Date.now());fs.mkdirSync(dir,{recursive:true});return dir;}

test('detects when this process writes AppData into a packaged app\'s private copy',{skip:win},t=>{
 const base=scratch('appdata');fs.mkdirSync(path.join(base,'Packages','Some.Other_1'),{recursive:true});
 assert.equal(ps('Get-AppDataRedirect -Base "'+base+'"').out,'','real AppData: no redirect');
 // Simulate the redirect: the app's LocalCache\Local is the same folder the probe is written to.
 const local=path.join(base,'Packages','Claude_test123','LocalCache');fs.mkdirSync(local,{recursive:true});
 assert.equal(spawnSync('cmd.exe',['/d','/c','mklink','/J',path.join(local,'Local'),base],{windowsHide:true}).status,0,'junction created');
 t.after(()=>{try{fs.rmdirSync(path.join(local,'Local'));}catch{}});
 assert.equal(ps('Get-AppDataRedirect -Base "'+base+'"').out,'Claude_test123');
 assert.deepEqual(fs.readdirSync(base).filter(n=>n.startsWith('local-voice-probe-')),[],'the probe file is removed');
});

test('a program started through the shell belongs to the desktop, not to the caller',{skip:win},async()=>{
 const dir=scratch('shell'),report=path.join(dir,'parents.txt');
 fs.writeFileSync(path.join(dir,'probe.ps1'),'$chain=@(); $id=$PID; for($i=0;$i -lt 6 -and $id;$i++){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if(-not $p){break}; $chain+=($p.Name+":"+$p.ProcessId); $id=$p.ParentProcessId }; $chain -join ">" | Set-Content -LiteralPath "'+report+'"\r\n');
 fs.writeFileSync(path.join(dir,'probe.cmd'),'@powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+path.join(dir,'probe.ps1')+'"\r\n');
 ps('Start-ViaShell "'+path.join(dir,'probe.cmd')+'"');
 for(let i=0;i<100&&!fs.existsSync(report);i++)await new Promise(r=>setTimeout(r,200));
 const chain=fs.readFileSync(report,'utf8').trim();
 assert.match(chain,/^powershell\.exe:\d+>cmd\.exe:\d+>explorer\.exe:\d+/i,'started by the desktop shell: '+chain);
 assert.ok(!chain.includes(':'+process.pid+'>')&&!chain.endsWith(':'+process.pid),'not a descendant of the caller');
});

test('setup, uninstall and the service start use the shell helpers',()=>{
 const read=f=>fs.readFileSync(path.join(__dirname,'..','scripts',f),'utf8');
 assert.match(read('setup.ps1'),/Get-AppDataRedirect[\s\S]*Restart-OutsideSandbox/,'setup moves out of an app sandbox before installing');
 assert.match(read('uninstall.ps1'),/Get-AppDataRedirect[\s\S]*Restart-OutsideSandbox/,'uninstall moves out of an app sandbox before removing');
 const resident=read('install-resident.ps1');
 assert.match(resident,/if \(\$StartNow\) \{[^\n]*Start-ViaShell \$shortcut/,'-StartNow starts the service through the shell, like the Start menu');
 assert.doesNotMatch(resident,/\$StartNow\)[^\n]*Start-Process/,'never started as a child of the installer');
});

test('launchers from earlier runs are cleaned up, the running one is kept; setup and uninstall both clean',{skip:win},()=>{
 const dir=scratch('launchers'),own=path.join(dir,'local-voice-setup-own.cmd'),stale=path.join(dir,'local-voice-setup-old.cmd'),other=path.join(dir,'unrelated.cmd');
 for(const f of [own,stale,other])fs.writeFileSync(f,'@echo off\r\n');
 const r=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','. "'+HELPERS+'"; Remove-StaleLaunchers'],{env:{...process.env,TEMP:dir,LOCAL_VOICE_LAUNCHER:own},windowsHide:true});
 assert.equal(r.status,0);
 assert.equal(fs.existsSync(stale),false,'a launcher from an earlier run is removed');
 assert.equal(fs.existsSync(own),true,'the running launcher is kept');
 assert.equal(fs.existsSync(other),true,'files that are not Local Voice launchers are untouched');
 assert.match(fs.readFileSync(path.join(__dirname,'..','scripts','setup.ps1'),'utf8'),/Remove-StaleLaunchers/);
 assert.match(fs.readFileSync(path.join(__dirname,'..','scripts','uninstall.ps1'),'utf8'),/Remove-StaleLaunchers[\s\S]*local-voice-setup\.log/);
});
test('agent JSON output is ASCII, so Windows PowerShell reads it correctly under any code page',()=>{
 const r=spawnSync(process.execPath,[path.join(__dirname,'..','scripts','agents.cjs'),'connect','no-such-agent','--json'],{encoding:'utf8'});
 assert.ok(/^[\x00-\x7f]*$/.test(r.stdout),'only ASCII on stdout');
 const src=fs.readFileSync(path.join(__dirname,'..','scripts','agents.cjs'),'utf8'),{ascii}={ascii:eval(src.match(/const ascii=([^\n]+);/)[1])};
 assert.equal(JSON.parse(ascii(JSON.stringify({line:'✔ Successfully installed — done'}))).line,'✔ Successfully installed — done','escaped text decodes back unchanged');
});
