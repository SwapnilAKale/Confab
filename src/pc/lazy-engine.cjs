'use strict';
const {EventEmitter}=require('node:events');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
class LazySpeechEngine extends EventEmitter{
 constructor(factory,{idleMs=900000,clock=Date.now,busy=()=>false}={}){super();Object.assign(this,{factory,idleMs,clock,busy});this.state='unloaded';this.active=0;this.lastUsed=clock();this.timer=setInterval(()=>this.unloadIfIdle(),Math.min(1000,idleMs));this.timer.unref();}
 touch(){this.lastUsed=this.clock();}
 // Why replies are spoken without number/date expansion, or null (see NativeSpeechEngine).
 get normalizerError(){return this.engine?.normalizerError??null;}
 async warmup(){this.touch();if(this.closed)throw Error('Speech engine closed.');if(this.state==='loaded')return;if(this.loading)return this.loading;
  this.state='loading';this.emit('state',this.state);let engine;try{engine=this.engine=this.factory();}catch(error){this.state='error';this.emit('state',this.state);throw error;}
  this.loading=(async()=>{try{await engine.warmup();if(this.closed||this.engine!==engine)return;this.state='loaded';this.touch();this.emit('state',this.state);}catch(e){engine.close();if(this.engine===engine)this.engine=null;this.state='error';this.emit('state',this.state);throw e;}finally{this.loading=null;}})();return this.loading;
 }
 // Open capture immediately; bounded PCM stays in memory while models load.
 async start(id,emit){if(this.capture)throw Error('Capture already open.');this.touch();const c=this.capture={id,emit,queue:[],bytes:0,ended:false};void this.pump(c).catch(e=>{if(this.capture===c){this.capture=null;emit({type:'error',message:e.message});}});}
 async pump(c){try{await this.warmup();}catch(e){throw Error('Speech models could not load: '+(e.message||'unknown error'));}if(this.closed||this.capture!==c)return;const engine=this.engine;await engine.start(c.id,e=>{if(this.capture!==c)return;c.emit(e);if(['capture-done','error'].includes(e.type)){this.capture=null;this.touch();}});
  while(!this.closed&&this.capture===c){if(c.queue.length&&(engine.pendingSamples||0)<16000*20){const pcm=c.queue.shift();c.bytes-=pcm.length;engine.audio(c.id,pcm);}else if(!c.queue.length&&c.ended){engine.end(c.id);return;}else await delay(5);}
 }
 audio(id,pcm){const c=this.capture;if(!c||c.id!==id)throw Error('Capture closed.');c.bytes+=pcm.length;if(c.bytes>16000*2*125)throw Error('Recording exceeded the capture buffer.');c.queue.push(pcm);this.touch();}
 end(id){if(this.capture?.id===id)this.capture.ended=true;this.touch();}
 cancel(id){if(this.capture?.id!==id)return;this.capture=null;this.engine?.cancel(id);this.touch();}
 async synthesize(text,options){this.active++;try{await this.warmup();if(options?.isCancelled?.()||this.closed)return [];return await this.engine.synthesize(text,options);}finally{this.active--;this.touch();}}
 unloadIfIdle(){if(this.closed||this.loading||this.capture||this.active||this.busy()||this.state!=='loaded'||this.clock()-this.lastUsed<this.idleMs)return false;this.engine.close();this.engine=null;this.state='unloaded';this.emit('state',this.state);return true;}
 close(){this.closed=true;clearInterval(this.timer);if(this.capture)this.cancel(this.capture.id);this.engine?.close();this.engine=null;this.state='unloaded';}
}
module.exports={LazySpeechEngine};
