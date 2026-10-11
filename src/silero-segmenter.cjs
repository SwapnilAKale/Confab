'use strict';
// Speech segmenter: Silero VAD (assets/models/silero-vad) run by sherpa-onnx. It only marks where speech is; turns,
// pauses and decode windows are decided by context-turns.cjs. Events:
//   {type:'segment', utteranceId, samples, timing:{start,end,nativeStart,onsetMs}}  finished speech, with pre-speech audio
//   {type:'activity', utteranceId, timing:{start,end}}                              speech still going on (keeps a turn open)
// Times are seconds since this segmenter started; samples are exact slices of the input.
const path=require('node:path');
const {PcmWindow}=require('./pcm-window.cjs');
const RATE=16000;
function createSegmenter(modelRoot,settings=require('./vad-settings.cjs').resolve()){
 const sherpa=require('sherpa-onnx-node');
 const {threshold,preSpeechSeconds,minSilenceSeconds}=require('./vad-settings.cjs').resolve(settings);
 const minSpeech=0.1,pre=Math.round(preSpeechSeconds*RATE);
 const config={sileroVad:{model:path.join(modelRoot,'silero-vad','silero_vad.onnx'),threshold,minSilenceDuration:minSilenceSeconds,minSpeechDuration:minSpeech,maxSpeechDuration:15,windowSize:512},sampleRate:RATE,debug:false,numThreads:1};
 let vad=new sherpa.Vad(config,60);
 const input=new PcmWindow();let deliveredEnd=0,nextId=0,openSince=null;
 function drain(){
  const events=[];
  while(!vad.isEmpty()){
   const f=vad.front(false);vad.pop();
   const nativeStart=f.start,end=Math.min(input.end,f.start+f.samples.length);
   if(end<=deliveredEnd)continue;
   // Keep audio from before the detected start, but never audio already given to the previous segment.
   const begin=Math.max(input.start,deliveredEnd,nativeStart-pre);deliveredEnd=end;
   events.push({type:'segment',utteranceId:String(nextId++),samples:input.slice(begin,end).buffer,timing:{start:begin/RATE,end:end/RATE,nativeStart:nativeStart/RATE,onsetMs:Math.max(0,nativeStart-begin)/16}});
   openSince=null;
  }
  // sherpa reports a segment's start only when it ends: while speech goes on, report activity from an estimate.
  if(vad.isDetected()){
   if(openSince===null)openSince=Math.max(deliveredEnd,input.end-Math.round((minSpeech+0.1)*RATE)-pre);
   events.push({type:'activity',utteranceId:String(nextId),timing:{start:Math.max(input.start,openSince)/RATE,end:input.end/RATE}});
  }
  return events;
 }
 return {
  push(samples){input.push(samples);vad.acceptWaveform(samples);return drain();},
  flush(){vad.flush();return drain().filter(e=>e.type==='segment');},
  reset(){vad=new sherpa.Vad(config,60);input.reset();deliveredEnd=0;nextId=0;openSince=null;},
  close(){vad=null;}
 };
}
module.exports={createSegmenter};
