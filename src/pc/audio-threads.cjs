'use strict';
// WinMM device opens take 0.5-0.9 s on some PCs and are synchronous. Running them on the main
// thread delayed cues, opened the microphone late and stalled the HTTP endpoint. ThreadedAudio
// keeps the WindowsAudio API but runs playback and capture on two worker threads, so a cue and
// the microphone open in parallel and the main thread never blocks.
const {Worker}=require('node:worker_threads'),{EventEmitter}=require('node:events');
class Channel{
 constructor(onEvent,role){this.pending=new Map();this.next=0;this.worker=new Worker(__filename,{workerData:{audioThread:true,role}});
  this.worker.on('message',m=>{if(m.id!==undefined){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.ok?p.resolve(m.value):p.reject(Object.assign(Error(m.message),{code:m.code}));}else onEvent(m);});
  this.worker.on('error',e=>{for(const p of this.pending.values())p.reject(e);this.pending.clear();onEvent({type:'error',message:e.message});});
  this.worker.unref();}
 call(op,args=[],transfer=[]){const id=++this.next;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,op,args},transfer);});}
 send(op,args=[],transfer=[]){this.worker.postMessage({op,args},transfer);}
 async close(){try{await this.call('close');}catch{}await this.worker.terminate();}
}
class ThreadedAudio extends EventEmitter{
 constructor(){super();this.on('error',()=>{});this.streams=0;
  this.playback=new Channel(e=>{if(e.type==='error')this.emit('error',Object.assign(Error(e.message),{code:'native_audio'}));},'playback');
  this.capture=new Channel(e=>{if(e.type==='pcm')this.onData?.(Buffer.from(e.data));else if(e.type==='error')this.emit('error',Object.assign(Error(e.message),{code:'native_audio'}));},'capture');}
 async probe(){await this.capture.call('probe');}
 // Resolves once the microphone is recording; rejects if it cannot be opened.
 start(onData){this.onData=onData;return this.capture.call('start');}
 // Resolves after the last captured audio has been delivered.
 stop(){return this.capture.call('stop');}
 play(pcm,rate){return this.playback.call('play',[pcm,rate]);}
 playWav(wav){return this.playback.call('playWav',[wav]);}
 loadingCue(){return this.playback.call('loadingCue');}
 cue(start){return this.playback.call('cue',[start]);}
 disarmCue(){return this.playback.call('disarmCue');}
 tick(){return this.playback.call('tick');}
 errorCue(){return this.playback.call('errorCue');}
 stopPlayback(){this.playback.send('stopPlayback');}
 stream(rate){const sid=++this.streams;this.playback.send('streamOpen',[sid,rate]);return {write:pcm=>this.playback.send('streamWrite',[sid,pcm]),end:()=>this.playback.call('streamEnd',[sid])};}
 async close(){await Promise.all([this.playback.close(),this.capture.close()]);}
}
// Worker side: one WindowsAudio instance per thread.
const threads=require('node:worker_threads');
if(!threads.isMainThread&&threads.workerData?.audioThread){
 // WASAPI first (see wasapi-audio.cjs for the timings); WinMM if WASAPI cannot start on the development PC.
 let audio;try{audio=new (require('./wasapi-audio.cjs').WasapiAudio)();if(threads.workerData.role==='playback')audio.warm();}catch{audio=new (require('./windows-audio.cjs').WindowsAudio)();}
 const port=threads.parentPort,streams=new Map();
 audio.on('error',e=>port.postMessage({type:'error',message:e.message}));
 const ops={
  probe:()=>audio.probe(),
  start:()=>audio.start(pcm=>{const copy=Uint8Array.from(pcm);port.postMessage({type:'pcm',data:copy},[copy.buffer]);}),
  stop:()=>audio.stop(),
  play:(pcm,rate)=>audio.play(Buffer.from(pcm),rate),
  playWav:wav=>audio.playWav(Buffer.from(wav)),
  loadingCue:()=>audio.loadingCue(),cue:start=>audio.cue(start),disarmCue:()=>audio.disarmCue(),tick:()=>audio.tick(),errorCue:()=>audio.errorCue(),
  stopPlayback:()=>audio.stopPlayback(),
  streamOpen:(sid,rate)=>{streams.set(sid,audio.stream(rate));},
  streamWrite:(sid,pcm)=>streams.get(sid)?.write(Buffer.from(pcm)),
  streamEnd:async sid=>{const s=streams.get(sid);streams.delete(sid);if(s)await s.end();},
  close:()=>audio.close()
 };
 port.on('message',async m=>{try{const value=await ops[m.op](...m.args);if(m.id!==undefined)port.postMessage({id:m.id,ok:true,value:value===undefined?undefined:null});}catch(error){if(m.id!==undefined)port.postMessage({id:m.id,ok:false,message:error.message,code:error.code});}});
}
module.exports={ThreadedAudio};
