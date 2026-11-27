'use strict';
// Windows power throttling (src/power.cjs): the service and every speech process opt out, each speech process says so
// in its 'ready', the engine keeps it per process, and /health shows it. A process that reports false, or nothing,
// must show as not opted out.
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const path=require('node:path'),fs=require('node:fs'),childProcess=require('node:child_process');
const windows=process.platform==='win32';

// This process's power throttling state, read back from Windows: {controlMask, stateMask}.
function throttlingState(){const k=require('koffi'),kernel=k.load('kernel32.dll');
 const State=k.struct('TEST_POWER_THROTTLING_STATE',{version:'uint32',controlMask:'uint32',stateMask:'uint32'});
 const current=kernel.func('void* __stdcall GetCurrentProcess()'),get=kernel.func('int __stdcall GetProcessInformation(void* process, int informationClass, _Inout_ TEST_POWER_THROTTLING_STATE* information, uint32 size)');
 const info={version:1,controlMask:0,stateMask:0};assert.ok(get(current(),4,info,k.sizeof(State)),'GetProcessInformation');return {controlMask:info.controlMask,stateMask:info.stateMask};}

test('opting out: Windows records "never throttle my speed" for this process',{skip:!windows},()=>{
 assert.equal(require('../src/power.cjs').optOutOfPowerThrottling(),true);
 assert.deepEqual(throttlingState(),{controlMask:1,stateMask:0});
 assert.equal(require('../src/power.cjs').optOutOfPowerThrottling(),true,'a second call in the same process too');
});

test('a speech worker opts out before it loads anything and says so in its ready message',{skip:!windows||!fs.existsSync(path.resolve('assets/models/silero-vad'))},async()=>{
 const child=childProcess.fork(path.resolve('src/speech-worker.cjs'),['vad',path.resolve('assets/models')],{stdio:['ignore','ignore','ignore','ipc']});
 try{const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('no ready')),30000);child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m);}});child.on('exit',()=>reject(Error('worker exited')));});
  assert.equal(ready.powerThrottlingOff,true);}finally{child.kill();}
});

// The engine with its worker processes replaced by fakes that send the given 'ready' (and 'power') messages.
function engineWithFakeWorkers(t,messages){
 const saved=childProcess.fork;t.after(()=>{childProcess.fork=saved;delete require.cache[require.resolve('../src/service/native-engine.cjs')];});
 childProcess.fork=(file,args)=>{const child=new EventEmitter();Object.assign(child,{stderr:new EventEmitter(),send(){},kill(){},connected:true,pid:1});
  setImmediate(()=>{for(const m of messages[args[0]]||[])child.emit('message',m);});return child;};
 delete require.cache[require.resolve('../src/service/native-engine.cjs')];
 const {NativeSpeechEngine}=require('../src/service/native-engine.cjs');
 return new NativeSpeechEngine({normalizer:{normalize:async x=>x,close(){}}});
}

test('the engine keeps each speech process\'s report: voice, recognition, decoder and speech detector',async t=>{
 const engine=engineWithFakeWorkers(t,{'asr-manual':[{type:'ready',powerThrottlingOff:true,decoderPowerThrottlingOff:true},{type:'power',process:'vad',powerThrottlingOff:true}],tts:[{type:'ready',powerThrottlingOff:true}]});
 await engine.worker('asr-manual');await engine.worker('tts');await new Promise(r=>setImmediate(r));
 assert.deepEqual(engine.power,{asr:true,decode:true,vad:true,tts:true});engine.close();
});

test('a process that reports false, or nothing, shows as not opted out',async t=>{
 const engine=engineWithFakeWorkers(t,{'asr-manual':[{type:'ready',decoderPowerThrottlingOff:false},{type:'power',process:'vad'}],tts:[{type:'ready',powerThrottlingOff:false}]});
 await engine.worker('asr-manual');await engine.worker('tts');await new Promise(r=>setImmediate(r));
 assert.deepEqual(engine.power,{asr:false,decode:false,vad:false,tts:false});engine.close();
});

test('the recognition process passes on the decoder and speech detector own reports, true, false or missing',()=>{
 const probe=(decoder,vad)=>JSON.parse(childProcess.execFileSync(process.execPath,[path.resolve('test/helpers/recognition-power-probe.cjs'),decoder,vad],{encoding:'utf8',timeout:20000}));
 for(const [decoder,vad,expectDecoder,expectVad] of [['true','true',true,true],['false','true',false,true],['true','false',true,false],['missing','missing',false,false]]){
  const sent=probe(decoder,vad),ready=sent.find(m=>m.type==='ready'),power=sent.find(m=>m.type==='power'&&m.process==='vad');
  assert.equal(ready?.decoderPowerThrottlingOff,expectDecoder,`decoder reported ${decoder}`);
  assert.ok(power,'the speech detector report is passed on');assert.equal(power.powerThrottlingOff,expectVad,`speech detector reported ${vad}`);}
});

test('/health shows the service\'s own opt-out and each speech process\'s',{skip:!windows},async t=>{
 const {run}=require('../src/pc/resident.cjs'),profileApi=require('../src/pc/profile.cjs'),http=require('node:http');
 fs.mkdirSync(path.resolve('test-output'),{recursive:true});const profile=fs.mkdtempSync(path.resolve('test-output/power-health-'));
 const tray=new EventEmitter();Object.assign(tray,{ready:Promise.resolve(),update(){},failure(){},async close(){}});
 const input=new EventEmitter();Object.assign(input,{ready:Promise.resolve({}),api:{setClipboard(){}},request:async()=>{},setPaused(){return true;},close(){},insert:async()=>({status:'inserted'})});
 const audio=new EventEmitter();Object.assign(audio,{probe:async()=>{},loadingCue:async()=>{},cue:async()=>{},disarmCue:async()=>{},tick:async()=>{},start(){},stop(){},stopPlayback(){},close:async()=>{}});
 const engine={power:{asr:true,decode:true,vad:false},warmup:async()=>{},start:async()=>{},audio(){},end(){},cancel(){},close(){},synthesize:async()=>[]};
 const app=await run(process.cwd(),{profile,createTray:()=>tray,createInput:()=>input,createAudio:()=>audio,engineFactory:()=>engine,idleMs:60000});
 t.after(async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});});
 await app.engine.warmup();
 const link=profileApi.connection(profile);
 const health=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:link.port,path:'/health',headers:{authorization:'Bearer '+link.token}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve(JSON.parse(b)));}).on('error',reject);});
 assert.equal(health.powerThrottlingOff,true,'the service itself');
 assert.deepEqual(health.speechPowerThrottlingOff,{asr:true,decode:true,vad:false},'each speech process, including one that is not opted out');
});
