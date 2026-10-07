const {fork}=require('node:child_process'),path=require('node:path');
// Moonshine's Silero model is process-global and its recurrent state survives
// freeing a stream/transcriber. A fresh process gives each call a clean detector.
// The transcription decoder and TTS stay warm in their existing workers.
class VadClient{
 constructor(modelRoot,{events,consumed,error,turnSettle=require('./turn-settings.cjs').DEFAULT_SETTLE,contextOverlap=false}){Object.assign(this,{modelRoot,events,consumed,error,turnSettle,contextOverlap});this.generation=0;this.child=null;}
 reset(){this.close();const generation=this.generation;
  const child=this.child=fork(path.join(__dirname,'speech-worker.cjs'),['vad',this.modelRoot],{windowsHide:true,env:{...process.env,VOICE_TURN_SETTLE:String(this.turnSettle),VOICE_CONTEXT_OVERLAP:this.contextOverlap?'1':'0'},serialization:'advanced',stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',data=>process.stderr.write(data));
  const current=()=>this.child===child&&this.generation===generation;
  child.on('message',event=>{if(!current())return;if(event.type==='vad-events'){this.events(event.events,event.flushed);if(event.consumed)this.consumed(event.sampleCount||0);}else if(event.type==='error')this.error(Error(event.message));});
  child.on('error',e=>{if(current())this.error(e);});child.on('exit',code=>{if(current())this.error(Error('Speech detector exited ('+code+').'));});
 }
 post(event){const child=this.child;if(!child)throw Error('Speech detector is not running');child.send(event,error=>{if(error&&this.child===child)this.error(error);});}
 push(samples){this.post({type:'audio',samples:samples.buffer.slice(samples.byteOffset,samples.byteOffset+samples.byteLength)});}
 flush(){this.post({type:'flush'});}
 close(){this.generation++;const child=this.child;this.child=null;child?.kill();}
}
module.exports={VadClient};
