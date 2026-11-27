'use strict';
// Daily check for a newer Confab release on GitHub.
// Fetches only the static latest.json release asset (no API rate limit, no user or machine data sent, never runs
// inside the network-isolated speech worker). Fails silently when offline and notifies at most once per version.
const fs=require('node:fs'),path=require('node:path');
const pkg=require('../../package.json');

function repoSlugFromPackage(p=pkg){
 const raw=typeof p.repository==='string'?p.repository:p.repository?.url||p.homepage||'';
 const m=/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(raw);
 return m?m[1]:'SwapnilAKale/Confab';
}

const REPO=repoSlugFromPackage();
const RELEASES_PREFIX='https://github.com/'+REPO+'/releases/';
const LATEST_URL=RELEASES_PREFIX+'latest/download/latest.json';
const CHECK_INTERVAL_MS=24*60*60*1000;
const INITIAL_DELAY_MS=15*1000;
const POLL_INTERVAL_MS=60*60*1000;
const TIMEOUT_MS=10*1000;
const MAX_BYTES=16*1024;

function parseVersion(value){
 if(typeof value!=='string')return null;
 const m=/^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
 return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null;
}

function isNewerVersion(candidate,current){
 const a=parseVersion(candidate),b=parseVersion(current);
 if(!a||!b)return false;
 for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}
 return false;
}

function isSafeReleaseUrl(url,releasesPrefix=RELEASES_PREFIX){
 return typeof url==='string'&&url.startsWith(releasesPrefix)&&!/[\s"'<>]/.test(url);
}

function validateManifest(data,releasesPrefix=RELEASES_PREFIX){
 if(!data||typeof data!=='object'||Array.isArray(data))return null;
 const version=typeof data.version==='string'?data.version.trim().replace(/^v/,''):null;
 if(!parseVersion(version))return null;
 const url=typeof data.url==='string'?data.url.trim():releasesPrefix+'tag/v'+version;
 if(!isSafeReleaseUrl(url,releasesPrefix))return null;
 return {version,url};
}

class UpdateChecker{
 constructor({
  profile,
  currentVersion=pkg.version,
  enabled=true,
  url=LATEST_URL,
  releasesPrefix=RELEASES_PREFIX,
  intervalMs=CHECK_INTERVAL_MS,
  initialDelayMs=INITIAL_DELAY_MS,
  pollMs=POLL_INTERVAL_MS,
  timeoutMs=TIMEOUT_MS,
  clock=()=>Date.now(),
  fetchImpl=globalThis.fetch,
  onUpdate=()=>{}
 }={}){
  this.file=profile?path.join(profile,'update-check.json'):null;
  this.currentVersion=currentVersion;
  this.enabled=enabled!==false;
  this.url=url;
  this.releasesPrefix=releasesPrefix;
  this.intervalMs=intervalMs;
  this.initialDelayMs=initialDelayMs;
  this.pollMs=pollMs;
  this.timeoutMs=timeoutMs;
  this.clock=clock;
  this.fetchImpl=fetchImpl;
  this.onUpdate=onUpdate;
  this.closed=false;
  this.inFlight=null;
  this.initialTimer=null;
  this.pollTimer=null;
  this.state=this.loadState();
  this.available=this.enabled?this.cachedAvailable():null;
 }

 loadState(){
  if(!this.file)return {};
  try{
   const parsed=JSON.parse(fs.readFileSync(this.file,'utf8'));
   return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
  }catch{return {};}
 }

 saveState(){
  if(!this.file)return;
  try{
   fs.mkdirSync(path.dirname(this.file),{recursive:true});
   fs.writeFileSync(this.file,JSON.stringify(this.state,null,2),{mode:0o600});
  }catch{}
 }

 cachedAvailable(){
  if(!isNewerVersion(this.state.latestVersion,this.currentVersion))return null;
  if(!isSafeReleaseUrl(this.state.latestUrl,this.releasesPrefix))return null;
  return {version:this.state.latestVersion,url:this.state.latestUrl};
 }

 start(){
  if(this.closed||!this.enabled)return;
  this.stopTimers();
  this.initialTimer=setTimeout(()=>{this.initialTimer=null;void this.checkIfDue();},this.initialDelayMs);
  this.initialTimer.unref?.();
  this.pollTimer=setInterval(()=>void this.checkIfDue(),this.pollMs);
  this.pollTimer.unref?.();
 }

 stopTimers(){
  if(this.initialTimer){clearTimeout(this.initialTimer);this.initialTimer=null;}
  if(this.pollTimer){clearInterval(this.pollTimer);this.pollTimer=null;}
 }

 setEnabled(flag){
  const next=flag!==false;
  if(next===this.enabled)return;
  this.enabled=next;
  if(!next){
   this.stopTimers();
   this.available=null;
   return;
  }
  this.available=this.cachedAvailable();
  this.start();
 }

 async checkIfDue({force=false}={}){
  if(this.closed||!this.enabled||typeof this.fetchImpl!=='function')return null;
  if(this.inFlight)return this.inFlight;
  const now=this.clock();
  if(!force&&Number.isFinite(this.state.checkedAt)&&(now-this.state.checkedAt)<this.intervalMs)return this.available;
  this.inFlight=(async()=>{
   try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    timer.unref?.();
    let res;
    try{
     res=await this.fetchImpl(this.url,{
      method:'GET',
      redirect:'follow',
      headers:{accept:'application/json','user-agent':'Confab'},
      signal:controller.signal
     });
    }finally{clearTimeout(timer);}
    if(!res||!res.ok)return this.available;
    const text=await res.text();
    if(text.length>MAX_BYTES)return this.available;
    const manifest=validateManifest(JSON.parse(text),this.releasesPrefix);
    if(!manifest)return this.available;
    if(this.closed||!this.enabled)return null;
    this.state.checkedAt=this.clock();
    this.state.latestVersion=manifest.version;
    this.state.latestUrl=manifest.url;
    if(isNewerVersion(manifest.version,this.currentVersion)){
     const notify=this.state.notifiedVersion!==manifest.version;
     if(notify)this.state.notifiedVersion=manifest.version;
     this.available={version:manifest.version,url:manifest.url};
     this.saveState();
     this.onUpdate({...this.available,notify});
     return this.available;
    }
    this.available=null;
    this.saveState();
    return null;
   }catch{
    return this.available;
   }finally{this.inFlight=null;}
  })();
  return this.inFlight;
 }

 close(){
  this.closed=true;
  this.stopTimers();
 }
}

module.exports={
 REPO,
 RELEASES_PREFIX,
 LATEST_URL,
 CHECK_INTERVAL_MS,
 INITIAL_DELAY_MS,
 POLL_INTERVAL_MS,
 parseVersion,
 isNewerVersion,
 isSafeReleaseUrl,
 validateManifest,
 UpdateChecker
};
