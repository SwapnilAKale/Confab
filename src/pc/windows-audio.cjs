'use strict';
// WinMM capture/playback in this Node process. No browser, callback thread or helper executable.
const {EventEmitter}=require('node:events');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
class WindowsAudio extends EventEmitter{
 constructor(){super();this.on('error',()=>{});const k=this.k=require('koffi'),dll=k.load('winmm.dll');
  this.format=k.struct({tag:'uint16',channels:'uint16',rate:'uint32',byteRate:'uint32',align:'uint16',bits:'uint16',extra:'uint16'});
  this.header=k.struct({data:'void *',length:'uint32',recorded:'uint32',user:'uintptr_t',flags:'uint32',loops:'uint32',next:'void *',reserved:'uintptr_t'});
  this.fn={};for(const dir of ['In','Out']){
   this.fn[dir+'Open']=dll.func('__stdcall','wave'+dir+'Open','uint32',[k.out(k.pointer('void *')),'uint32',k.pointer(this.format),'uintptr_t','uintptr_t','uint32']);
   for(const op of ['PrepareHeader','UnprepareHeader',dir==='In'?'AddBuffer':'Write'])this.fn[dir+op]=dll.func('uint32 __stdcall wave'+dir+op+'(void *handle, void *header, uint32 size)');
   for(const op of (dir==='In'?['Start','Stop','Reset','Close']:['Reset','Close']))this.fn[dir+op]=dll.func('uint32 __stdcall wave'+dir+op+'(void *handle)');
  }this.playGeneration=0;this.queue=Promise.resolve();
 }
 check(code,action){if(code)throw Object.assign(Error(action+' failed (Windows audio '+code+'). Check your default microphone/speakers and device permissions.'),{code:'native_audio'});}
 open(dir,rate){const output=[null];this.check(this.fn[dir+'Open'](output,0xffffffff,{tag:1,channels:1,rate,byteRate:rate*2,align:2,bits:16,extra:0},0,0,0),'Open '+dir);return output[0];}
 block(bytes){const pointer=this.k.alloc(this.header,1);this.k.encode(pointer,this.header,{data:bytes,length:bytes.length,recorded:0,user:0,flags:0,loops:0,next:null,reserved:0});return {pointer,bytes};}
 async probe(){const mic=this.open('In',16000);this.check(this.fn.InClose(mic),'Close microphone probe');const out=this.open('Out',24000);this.check(this.fn.OutClose(out),'Close speaker probe');}
 start(onData){if(this.capture)throw Error('Microphone already recording.');const capture=this.capture={handle:this.open('In',16000),blocks:[],queued:[],onData};
  try{for(let i=0;i<16;i++){const b=this.block(Buffer.alloc(3200));capture.blocks.push(b);this.check(this.fn.InPrepareHeader(capture.handle,b.pointer,this.k.sizeof(this.header)),'Prepare microphone');this.check(this.fn.InAddBuffer(capture.handle,b.pointer,this.k.sizeof(this.header)),'Queue microphone');capture.queued.push(b);}
   this.check(this.fn.InStart(capture.handle),'Start microphone');capture.timer=setInterval(()=>{try{this.drain(capture,true);}catch(e){try{this.stop();}catch{}this.emit('error',e);}},10);
  }catch(e){this.stop();throw e;}
 }
 drain(capture,requeue){
  // Buffers must be consumed in driver queue order, including after a wrap/reset.
  // Allocation order can put a later buffer before the tail of the recording.
  const count=capture.queued.length;
  for(let i=0;i<count;i++){const b=capture.queued[0];if(!b)break;const h=this.k.decode(b.pointer,this.header);if(!(h.flags&1))break;
   capture.queued.shift();if(h.recorded)capture.onData(Buffer.from(b.bytes.subarray(0,h.recorded)));
   if(requeue){this.check(this.fn.InAddBuffer(capture.handle,b.pointer,this.k.sizeof(this.header)),'Requeue microphone');capture.queued.push(b);}
  }
 }
 stop(){const c=this.capture;if(!c)return;this.capture=null;clearInterval(c.timer);let error;
  try{this.check(this.fn.InReset(c.handle),'Stop microphone');this.drain(c,false);}catch(e){error=e;}
  finally{for(const b of c.blocks){this.fn.InUnprepareHeader(c.handle,b.pointer,this.k.sizeof(this.header));this.k.free(b.pointer);}this.fn.InClose(c.handle);}if(error)throw error;
 }
 playWav(wav){if(!Buffer.isBuffer(wav)||wav.toString('ascii',0,4)!=='RIFF'||wav.readUInt16LE(20)!==1||wav.readUInt16LE(22)!==1||wav.readUInt16LE(34)!==16)throw Error('Expected mono PCM16 WAV from shared speech engine.');return this.play(wav.subarray(44),wav.readUInt32LE(24));}
 play(pcm,rate=24000){const generation=this.playGeneration;const job=this.queue.then(async()=>{
   if(generation!==this.playGeneration)return;const handle=this.open('Out',rate),b=this.block(pcm);this.output=handle;
   try{this.check(this.fn.OutPrepareHeader(handle,b.pointer,this.k.sizeof(this.header)),'Prepare speakers');this.check(this.fn.OutWrite(handle,b.pointer,this.k.sizeof(this.header)),'Play speakers');
    const end=Date.now()+10000+pcm.length/rate*500;while(!(this.k.decode(b.pointer,this.header).flags&1)){if(generation!==this.playGeneration)this.fn.OutReset(handle);if(Date.now()>end)throw Error('Speaker playback timed out.');await delay(10);}
   }finally{this.fn.OutReset(handle);this.fn.OutUnprepareHeader(handle,b.pointer,this.k.sizeof(this.header));this.fn.OutClose(handle);this.k.free(b.pointer);if(this.output===handle)this.output=null;}
  });this.queue=job.catch(()=>{});return job;
 }
 // One device handle for a whole reply. Buffers written while earlier ones play are queued
 // back to back by the driver; reopening the device per WAV costs ~0.75 s on the development PC.
 stream(rate=24000){const generation=this.playGeneration,pending=[],size=this.k.sizeof(this.header);let wake=null,ended=false;const poke=()=>{const w=wake;wake=null;w?.();};
  const job=this.queue.then(async()=>{
   if(generation!==this.playGeneration)return;const handle=this.open('Out',rate),blocks=[];this.output=handle;let deadline=Date.now()+10000;
   try{for(;;){
    if(generation!==this.playGeneration)break;
    while(pending.length){const pcm=pending.shift(),b=this.block(pcm);blocks.push(b);this.check(this.fn.OutPrepareHeader(handle,b.pointer,size),'Prepare speakers');this.check(this.fn.OutWrite(handle,b.pointer,size),'Play speakers');}
    while(blocks.length&&(this.k.decode(blocks[0].pointer,this.header).flags&1)){const b=blocks.shift();this.fn.OutUnprepareHeader(handle,b.pointer,size);this.k.free(b.pointer);}
    if(!blocks.length&&ended&&!pending.length)break;
    if(blocks.length){const queued=blocks.reduce((a,b)=>a+b.bytes.length,0)/2/rate*1000;deadline=Math.max(deadline,Date.now()+queued+10000);if(Date.now()>deadline)throw Error('Speaker playback timed out.');}else deadline=Date.now()+10000;
    await new Promise(r=>{wake=r;setTimeout(poke,10);});
   }}finally{this.fn.OutReset(handle);for(const b of blocks){this.fn.OutUnprepareHeader(handle,b.pointer,size);this.k.free(b.pointer);}this.fn.OutClose(handle);if(this.output===handle)this.output=null;}
  });this.queue=job.catch(()=>{});job.catch(()=>{});
  return {write(pcm){if(!ended){pending.push(pcm);poke();}},end(){ended=true;poke();return job;}};
 }
 loadingCue(){const rate=24000,pcm=Buffer.alloc(9600);for(let i=0;i<4800;i++)pcm.writeInt16LE(Math.round(1800*Math.sin(2*Math.PI*(i<2400?440:660)*i/rate)*Math.sin(Math.PI*(i%2400)/2400)),i*2);return this.play(pcm,rate);}
 cue(start){const rate=24000,pcm=Buffer.alloc(rate*.09*2);for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(2200*Math.sin(2*Math.PI*(start?880:440)*i/rate)*Math.sin(Math.PI*i/(pcm.length/2))),i*2);return this.play(pcm,rate);}
 // Disarm cue: two short falling tones (660 Hz then 330 Hz), distinct from the start/stop cues.
 disarmCue(){const rate=24000,n=Math.round(rate*.07),gap=Math.round(rate*.03),pcm=Buffer.alloc((n*2+gap)*2);for(const [start,freq] of [[0,660],[n+gap,330]])for(let i=0;i<n;i++)pcm.writeInt16LE(Math.round(2200*Math.sin(2*Math.PI*freq*i/rate)*Math.sin(Math.PI*i/n)),(start+i)*2);return this.play(pcm,rate);}
 // Soft single tick (1200 Hz, 40 ms): a press acknowledged with nothing else to do.
 tick(){const rate=24000,n=Math.round(rate*.04),pcm=Buffer.alloc(n*2);for(let i=0;i<n;i++)pcm.writeInt16LE(Math.round(1400*Math.sin(2*Math.PI*1200*i/rate)*Math.sin(Math.PI*i/n)),i*2);return this.play(pcm,rate);}
 // Error cue: two low buzzes (220 Hz): a press that could not be carried out.
 errorCue(){const rate=24000,n=Math.round(rate*.08),gap=Math.round(rate*.04),pcm=Buffer.alloc((n*2+gap)*2);for(const start of [0,n+gap])for(let i=0;i<n;i++)pcm.writeInt16LE(Math.round(2400*Math.sign(Math.sin(2*Math.PI*220*i/rate))*Math.sin(Math.PI*i/n)*.6),(start+i)*2);return this.play(pcm,rate);}
 stopPlayback(){this.playGeneration++;if(this.output)this.fn.OutReset(this.output);}
 async close(){this.stopPlayback();this.stop();await this.queue;}
}
module.exports={WindowsAudio};
