// Lossless chunks. No summarizing, code removal, or invented prose.
function splitSpeech(text,limit=220){
 const out=[];
 while(text.length>limit){
  let cut=text.lastIndexOf(' ',limit);
  const sentence=Math.max(text.lastIndexOf('. ',limit),text.lastIndexOf('? ',limit),text.lastIndexOf('! ',limit));
  if(sentence>40)cut=sentence+1;
  if(cut<1)cut=limit;
  else if(text[cut]===' ')cut++;
  out.push(text.slice(0,cut));text=text.slice(cut);
 }
 if(text)out.push(text);
 return out;
}
const crypto=require('node:crypto');
const {spokenProjection}=require('./spoken-text.cjs');
// The concatenation is always the original text. No rewriting or removal of code.
function speechChunks(text,limit=80){
 if(!text)return [];
 if(text.length<=limit)return [text];
 const head=text.slice(0,limit+1),boundary=/[.!?;:\n](?:\s|$)/g;let match,cut=0;
 while((match=boundary.exec(head)))if(match.index>=15){cut=match.index+match[0].length;break;}
 if(!cut){cut=head.lastIndexOf(' ');if(cut<16)cut=limit;else cut++;}
 return [text.slice(0,cut),...splitSpeech(text.slice(cut),160)];
}
class AudioCache{
 constructor(maxBytes=32*1024*1024){this.maxBytes=maxBytes;this.bytes=0;this.items=new Map();}
 get(key){const item=this.items.get(key);if(item){this.items.delete(key);this.items.set(key,item);}return item;}
 put(key,audio){const size=audio.samples.byteLength;if(size>this.maxBytes)return;
  if(this.items.has(key)){this.bytes-=this.items.get(key).samples.byteLength;this.items.delete(key);}
  this.items.set(key,audio);this.bytes+=size;
  while(this.bytes>this.maxBytes){const first=this.items.keys().next().value;this.bytes-=this.items.get(first).samples.byteLength;this.items.delete(first);}
 }
}
class Playback{
 constructor({synthesize,emit,onMemory=()=>{},memory={},bufferLimit=5}){Object.assign(this,{synthesize,emit,onMemory,bufferLimit});this.epoch=0;this.queue=[];this.inFlight=null;this.buffered=new Map();this.stopped=new Map();this.cache=new AudioCache();this.memory={heard:[],last:null,interrupted:null,...memory};this.memory.positions ||= {};for(const point of [this.memory.last,this.memory.interrupted])if(point&&!this.memory.positions['host:'+point.id])this.memory.positions['host:'+point.id]={...point};if(this.memory.spokenVersion!==2){for(const point of [this.memory.last,this.memory.localLast,this.memory.interrupted,...Object.values(this.memory.positions)])if(point)point.offsetSeconds=0;this.memory.spokenVersion=2;}this.metrics=[];this.playId=0;}
 key(text){return crypto.createHash('sha256').update('kokoro-sid3-speed1-markdown-v2\0'+text).digest('hex');}
 stop(){for(const job of this.buffered.values())this.stopped.set(job.epoch+':'+job.replyId+':'+job.index,job);while(this.stopped.size>32)this.stopped.delete(this.stopped.keys().next().value);this.epoch++;this.queue=[];this.buffered.clear();this.emit({type:'playback-stop',epoch:this.epoch});}
 enqueue(reply,{start=0,local=false,remember=!local,owner=local?'local':'agent',offsetSeconds=0}={}){
  const chunks=speechChunks(reply.text),projection=spokenProjection(reply.text);let offset=0;const spoken=chunks.map(text=>{const value=projection.slice(offset,offset+text.length).replace(/\s+/g,' ').trim();offset+=text.length;return value;});const queuedAt=Date.now(),playId=++this.playId;
  for(let i=start;i<chunks.length;i++)this.queue.push({type:'speak',text:chunks[i],spokenText:spoken[i],epoch:this.epoch,replyId:reply.id,index:i,last:i===chunks.length-1,local,remember,owner,offsetSeconds:i===start?offsetSeconds:0,queuedAt,playId,key:this.key(spoken[i])});
  this.pump();
 }
 deliver(job,audio,cached){
  const event={...job,...audio,type:'audio',cached,queuedAt:job.queuedAt};
  this.buffered.set(job.replyId+':'+job.index,event);this.emit(event);
 }
 pump(){
  while(this.queue.length&&this.buffered.size<this.bufferLimit){
   const job=this.queue[0],cached=this.cache.get(job.key);
   if(cached){this.queue.shift();this.deliver(job,cached,true);continue;}
   if(this.inFlight)return;
   this.inFlight=this.queue.shift();this.synthesize(this.inFlight);return;
  }
 }
 audio(event){
  const job=this.inFlight;if(!job||event.epoch!==job.epoch||event.replyId!==job.replyId||event.index!==job.index)return;
  this.inFlight=null;
  const audio={samples:Buffer.from(event.samples),sampleRate:event.sampleRate,synthesisMs:event.synthesisMs,synthesisCpu:event.synthesisCpu,freeMemoryBytes:event.freeMemoryBytes};
  this.cache.put(job.key,audio);
  if(job.epoch===this.epoch)this.deliver(job,audio,false);
  this.pump();
 }
 failed(){this.inFlight=null;this.stop();}
 progress(event){
  const key=event.replyId+':'+event.index,job=event.epoch===this.epoch?this.buffered.get(key):event.type==='playback-position'?this.stopped.get(event.epoch+':'+key):null;if(!job)return;
  if(job.remember&&['playback-started','playback-position','played'].includes(event.type)){
   const source=job.local?'local':'host',point={id:job.replyId,index:job.index+(event.type==='played'?1:0),complete:event.type==='played'&&job.last,offsetSeconds:event.type==='played'?0:Math.max(0,event.offsetSeconds||0)};
   this.memory.positions[source+':'+job.replyId]=point;
   this.memory.current={source,id:job.replyId};if(job.local)this.memory.localLast=point;this.onMemory(this.memory);
  }
  if(event.type==='playback-started'){
   if(!job.local){this.memory.last={id:job.replyId,index:job.index,complete:false};this.memory.heard=this.memory.heard.filter(id=>id!==job.replyId).concat(job.replyId).slice(-20);this.onMemory(this.memory);}
   this.metrics.push({replyId:job.replyId,index:job.index,cached:job.cached,local:job.local,first:job.index===0,queuedToStartMs:Date.now()-job.queuedAt,synthesisMs:job.synthesisMs,synthesisCpu:job.synthesisCpu,freeMemoryBytes:job.freeMemoryBytes,gapBeforeMs:event.gapBeforeMs||0});this.metrics=this.metrics.slice(-80);
  }
  if(event.type==='playback-position'&&!job.local){this.memory.interrupted={id:job.replyId,index:job.index,offsetSeconds:Math.max(0,event.offsetSeconds||0)};this.memory.last={id:job.replyId,index:job.index,complete:false};this.onMemory(this.memory);}
  if(event.type==='played'){
   if(!job.local){this.memory.last={id:job.replyId,index:job.index+1,complete:job.last};if(job.last&&this.memory.interrupted?.id===job.replyId)this.memory.interrupted=null;this.onMemory(this.memory);}
   this.buffered.delete(key);this.pump();
  }
 }
 snapshot(){return {epoch:this.epoch,cacheBytes:this.cache.bytes,queued:this.queue.length,buffered:this.buffered.size,metrics:this.metrics};}
}
module.exports={splitSpeech,Playback,AudioCache,speechChunks};
