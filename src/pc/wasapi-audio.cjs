'use strict';
// WASAPI shared-mode audio through COM calls in koffi (no compiled helper). Same API as WindowsAudio.
// Measured on the development PC (5 October 2026): creating any audio stream (IAudioClient::Initialize) takes
// 380-660 ms in the Windows audio engine, for input and output alike, whatever the format or mode.
// waveInOpen hid the same cost and then delivered first audio about 1.15 s after the press.
// - Microphone: a new stream per recording (never kept open). Start() is followed by audio within
//   about 10 ms, so start() resolves at the moment capture is really live.
// - Output: one stream per sample rate is initialized once and kept STOPPED between sounds, so a
//   cue starts in milliseconds. A stopped stream does not keep the audio engine running.
const k=require('koffi'),{EventEmitter}=require('node:events');
const ole=k.load('ole32.dll');
const GUID=k.struct('LVW_GUID',{a:'uint32',b:'uint16',c:'uint16',d:k.array('uint8',8)});
const WFX=k.struct('LVW_WFX',{tag:'uint16',channels:'uint16',rate:'uint32',byteRate:'uint32',align:'uint16',bits:'uint16',extra:'uint16'});
const PROPS=k.struct('LVW_PROPS',{size:'uint32',offload:'int32',category:'int32',options:'int32'});
const P={
 getDefault:k.proto('int __stdcall LVW_GetDefault(void *self, int flow, int role, _Out_ void **device)'),
 getId:k.proto('int __stdcall LVW_GetId(void *self, _Out_ void **id)'),
 activate:k.proto('int __stdcall LVW_Activate(void *self, LVW_GUID *iid, uint32 context, void *params, _Out_ void **out)'),
 initialize:k.proto('int __stdcall LVW_Initialize(void *self, int mode, uint32 flags, int64 duration, int64 period, LVW_WFX *format, void *session)'),
 count:k.proto('int __stdcall LVW_Count(void *self, _Out_ uint32 *value)'),
 getService:k.proto('int __stdcall LVW_GetService(void *self, LVW_GUID *iid, _Out_ void **out)'),
 simple:k.proto('int __stdcall LVW_Simple(void *self)'),
 renderGet:k.proto('int __stdcall LVW_RenderGet(void *self, uint32 frames, _Out_ void **data)'),
 renderRelease:k.proto('int __stdcall LVW_RenderRelease(void *self, uint32 frames, uint32 flags)'),
 captureGet:k.proto('int __stdcall LVW_CaptureGet(void *self, _Out_ void **data, _Out_ uint32 *frames, _Out_ uint32 *flags, void *position, void *qpc)'),
 captureRelease:k.proto('int __stdcall LVW_CaptureRelease(void *self, uint32 frames)'),
 release:k.proto('uint32 __stdcall LVW_Release(void *self)'),
 query:k.proto('int __stdcall LVW_Query(void *self, LVW_GUID *iid, _Out_ void **out)'),
 setProperties:k.proto('int __stdcall LVW_SetProperties(void *self, LVW_PROPS *props)'),
 setDucking:k.proto('int __stdcall LVW_SetDucking(void *self, int optOut)')
};
const fn={coInit:ole.func('int __stdcall CoInitializeEx(void *reserved, uint32 model)'),
 create:ole.func('__stdcall','CoCreateInstance','int',[k.pointer(GUID),'void *','uint32',k.pointer(GUID),k.out(k.pointer('void *'))]),
 free:ole.func('void __stdcall CoTaskMemFree(void *p)')};
const guid=s=>{const h=s.replace(/[{}-]/g,'');return {a:parseInt(h.slice(0,8),16),b:parseInt(h.slice(8,12),16),c:parseInt(h.slice(12,16),16),d:[...Array(8)].map((_,i)=>parseInt(h.slice(16+i*2,18+i*2),16))};};
const IID={enumerator:guid('A95664D2-9614-4F35-A746-DE8DB63617E6'),audioClient:guid('1CB9AD4C-DBFA-4c32-B178-C2F568A703B2'),render:guid('F294ACFC-3146-4483-A7BF-ADDCA7C260E2'),capture:guid('C8ADBD64-E71E-48a0-A4DE-185C395CD317'),
 audioClient2:guid('726778CD-F60A-4EDA-82DE-E47610CD78AA'),session:guid('F4B1A599-7266-4319-A8CA-E70ACB11E8CD'),session2:guid('BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D')};
// AUDIO_STREAM_CATEGORY: AudioCategory_Communications.
const CATEGORY_COMMUNICATIONS=3;
const CLSID_ENUMERATOR=guid('BCDE0395-E52F-467C-8E3D-C4579291692E');
const AUTOCONVERT=0x80000000|0x08000000, CLSCTX_ALL=23, RENDER=0, CAPTURE=1, SILENT=2;
const vtable=(object,index)=>k.decode(k.decode(object,'void *'),index*k.sizeof('void *'),'void *');
const call=(object,index,proto,...args)=>k.call(vtable(object,index),proto,object,...args);
const check=(hr,what)=>{if(hr<0)throw Object.assign(Error(what+' failed (WASAPI 0x'+(hr>>>0).toString(16)+'). Check your default microphone/speakers and device permissions.'),{code:'native_audio',hr:hr>>>0});};
const release=object=>{if(object)call(object,2,P.release);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const pcmFormat=rate=>({tag:1,channels:1,rate,byteRate:rate*2,align:2,bits:16,extra:0});

class WasapiAudio extends EventEmitter{
 constructor(){super();this.on('error',()=>{});fn.coInit(null,0);const out=[null];check(fn.create(CLSID_ENUMERATOR,null,CLSCTX_ALL,IID.enumerator,out),'Audio device enumerator');this.enumerator=out[0];this.outputs=new Map();this.queue=Promise.resolve();this.playGeneration=0;}
 defaultDevice(flow){const device=[null];check(call(this.enumerator,4,P.getDefault,flow,0,device),flow===CAPTURE?'Find microphone':'Find speakers');return device[0];}
 deviceId(device){const id=[null];check(call(device,5,P.getId,id),'Read device id');try{return k.decode(id[0],'char16_t',-1)||'';}finally{fn.free(id[0]);}}
 // Creates and initializes a shared stream (16-bit mono at `rate`, converted by Windows).
 // communications (voice mode microphone): the stream is tagged as a communications stream before it is initialized,
 // so Windows applies the device's communications processing, which includes acoustic echo cancellation where the
 // audio driver offers it. That lets voice mode keep the microphone open while a reply plays. The stream is opted
 // out of Windows' communications ducking, so other sounds are not turned down. `communications` in the result says
 // whether Windows accepted the tag; whether the driver really cancels echo cannot be read back.
 openStream(flow,rate,bufferMs,{communications=false}={}){
  const device=this.defaultDevice(flow);let client=[null],service=[null],tagged=false;
  try{
   const id=this.deviceId(device);
   if(communications&&call(device,3,P.activate,IID.audioClient2,CLSCTX_ALL,null,client)>=0&&client[0]){
    tagged=call(client[0],16,P.setProperties,{size:k.sizeof(PROPS),offload:0,category:CATEGORY_COMMUNICATIONS,options:0})>=0;
   }
   if(!client[0])check(call(device,3,P.activate,IID.audioClient,CLSCTX_ALL,null,client),'Activate audio stream');
   check(call(client[0],3,P.initialize,0,AUTOCONVERT,bufferMs*10000,0,pcmFormat(rate),null),flow===CAPTURE?'Open microphone':'Open speakers');
   if(tagged)this.optOutOfDucking(client[0]);
   const frames=[0];check(call(client[0],4,P.count,frames),'Read buffer size');
   check(call(client[0],14,P.getService,flow===CAPTURE?IID.capture:IID.render,service),'Open stream service');
   return {client:client[0],service:service[0],frames:frames[0],rate,id,communications:tagged};
  }catch(error){release(service[0]);release(client[0]);throw error;}
  finally{release(device);}
 }
 // IAudioSessionControl2::SetDuckingPreference(TRUE). A failure only means other sounds may be turned down.
 optOutOfDucking(client){const session=[null],session2=[null];try{if(call(client,14,P.getService,IID.session,session)<0||!session[0])return false;if(call(session[0],0,P.query,IID.session2,session2)<0||!session2[0])return false;return call(session2[0],16,P.setDucking,1)>=0;}catch{return false;}finally{release(session2[0]);release(session[0]);}}
 closeStream(s){if(!s)return;try{call(s.client,11,P.simple);}catch{}release(s.service);release(s.client);}
 // Output streams are kept initialized and stopped; a new default device replaces them.
 output(rate){
  let s=this.outputs.get(rate);
  if(s){let current='';try{const d=this.defaultDevice(RENDER);try{current=this.deviceId(d);}finally{release(d);}}catch{}if(current&&current!==s.id){this.closeStream(s);this.outputs.delete(rate);s=null;}}
  if(!s){s=this.openStream(RENDER,rate,200);this.outputs.set(rate,s);}
  return s;
 }
 warm(rate=24000){this.output(rate);}
 async probe(){this.closeStream(this.openStream(CAPTURE,16000,1000));this.output(24000);}
 // Plays PCM chunks from `next()` (null when finished) on the persistent output stream.
 async render(rate,next,generation){
  let s;try{s=this.output(rate);}catch(error){if(error.hr===0x88890004){this.outputs.delete(rate);s=this.output(rate);}else throw error;}
  let pending=null,offset=0,started=false;const deadline=()=>Date.now()+10000;let stall=deadline();
  try{
   for(;;){
    if(generation!==this.playGeneration)break;
    if(!pending||offset>=pending.length){pending=await next();offset=0;if(pending===null){pending=undefined;}}
    const padding=[0];check(call(s.client,6,P.count,padding),'Read playback position');
    if(pending===undefined){if(padding[0]===0||!started)break;await delay(10);continue;}
    const room=s.frames-padding[0],frames=Math.min(room,(pending.length-offset)>>1);
    if(frames>0){const data=[null];check(call(s.service,3,P.renderGet,frames,data),'Write audio');new Uint8Array(k.view(data[0],frames*2)).set(pending.subarray(offset,offset+frames*2));check(call(s.service,4,P.renderRelease,frames,0),'Commit audio');offset+=frames*2;stall=deadline();
     if(!started){check(call(s.client,10,P.simple),'Start playback');started=true;}}
    else{if(Date.now()>stall)throw Error('Speaker playback timed out.');await delay(10);}
   }
  }finally{try{call(s.client,11,P.simple);call(s.client,12,P.simple);}catch{}}
 }
 play(pcm,rate=24000){const generation=this.playGeneration;const job=this.queue.then(()=>{if(generation!==this.playGeneration)return;let given=false;return this.render(rate,async()=>{if(given)return null;given=true;return pcm;},generation);});this.queue=job.catch(()=>{});return job;}
 playWav(wav){if(!Buffer.isBuffer(wav)||wav.toString('ascii',0,4)!=='RIFF'||wav.readUInt16LE(20)!==1||wav.readUInt16LE(22)!==1||wav.readUInt16LE(34)!==16)throw Error('Expected mono PCM16 WAV from shared speech engine.');return this.play(wav.subarray(44),wav.readUInt32LE(24));}
 // One stream for a whole reply: chunks written while earlier ones play continue without a gap.
 stream(rate=24000){
  const generation=this.playGeneration,chunks=[];let ended=false,wake=null;
  const next=async()=>{for(;;){if(chunks.length)return chunks.shift();if(ended||generation!==this.playGeneration)return null;await new Promise(r=>{wake=r;setTimeout(r,20);});wake=null;}};
  const job=this.queue.then(()=>generation===this.playGeneration&&this.render(rate,next,generation));this.queue=job.catch(()=>{});job.catch(()=>{});
  return {write:pcm=>{if(!ended){chunks.push(pcm);wake?.();}},end:()=>{ended=true;wake?.();return job;}};
 }
 // Microphone: resolves once capture is running; audio follows within about 10 ms.
 // options.communications: voice mode's echo-cancelled stream (see openStream). Returns {communications}.
 start(onData,{communications=false}={}){
  if(this.capture)throw Error('Microphone already recording.');
  const s=this.openStream(CAPTURE,16000,1000,{communications});
  try{check(call(s.client,10,P.simple),'Start microphone');}catch(error){this.closeStream(s);throw error;}
  this.capture={...s,onData};
  this.capture.timer=setInterval(()=>{try{this.drain(this.capture);}catch(e){try{this.stop();}catch{}this.emit('error',e);}},10);
  return {communications:s.communications};
 }
 drain(c){
  if(!c)return;
  for(;;){
   const size=[0];check(call(c.service,5,P.count,size),'Read microphone');if(!size[0])return;
   const data=[null],frames=[0],flags=[0];check(call(c.service,3,P.captureGet,data,frames,flags,null,null),'Read microphone');
   const bytes=frames[0]*2,copy=Buffer.alloc(bytes);if(!(flags[0]&SILENT)&&bytes)copy.set(new Uint8Array(k.view(data[0],bytes)));
   check(call(c.service,4,P.captureRelease,frames[0]),'Release microphone buffer');
   if(bytes)c.onData(copy);
  }
 }
 stop(){const c=this.capture;if(!c)return;this.capture=null;clearInterval(c.timer);let error;try{this.drain(c);}catch(e){error=e;}finally{this.closeStream(c);}if(error)throw error;}
 stopPlayback(){this.playGeneration++;}
 async close(){this.stopPlayback();try{this.stop();}catch{}await this.queue;for(const s of this.outputs.values())this.closeStream(s);this.outputs.clear();release(this.enumerator);this.enumerator=null;}
}
// Cue sounds are the same PCM as the WinMM implementation; they call this.play().
const {WindowsAudio}=require('./windows-audio.cjs');
for(const name of ['loadingCue','cue','disarmCue','limitCue','tick','errorCue'])WasapiAudio.prototype[name]=WindowsAudio.prototype[name];
module.exports={WasapiAudio};
