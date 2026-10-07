const {fork}=require('node:child_process'),path=require('node:path');
const {VadClient}=require('./vad-client.cjs'),{RecognitionQueue}=require('./recognition-queue.cjs');
function startManualRecognition(modelRoot,send){
 const decoder=fork(path.join(__dirname,'speech-worker.cjs'),['decode',modelRoot],{serialization:'advanced',windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});decoder.stderr.on('data',d=>process.stderr.write(d));
 const cadence=new (require('./preview-cadence.cjs').PreviewCadence)();
 let epoch=0,sequence=0,ready=false,active=null,recording=false,turnSettle=require('./turn-settings.cjs').DEFAULT_SETTLE;const streams=new Map(),lastStatus=new Map();
 function fail(message){send({type:'error',message});process.exitCode=1;decoder.kill();for(const s of streams.values())s.vad.close();}
 function status(){for(const route of ['agent','local']){const pending=[...streams.values()].filter(s=>s.route===route).reduce((n,s)=>n+s.queue.finals.length,0)+(active?.epoch===epoch&&active.route===route&&!active.preview?1:0);if(lastStatus.get(route)!==pending){lastStatus.set(route,pending);send({type:'recognition-state',epoch,route,pending});}}}
 function pump(){
  if(active||!ready)return;
  const all=[...streams.values()];while(!active){const s=all.find(s=>s.queue.finals.length)||all.find(s=>s.queue.preview);if(!s)break;active=s.queue.next();}
  if(active){active.previewPolicy=cadence.snapshot();active.queueMs=Date.now()-active.queuedAt;if(recording){const {samples,...meta}=active;send({...meta,type:'decode-start'});}decoder.send(active);}
  for(const s of [...streams.values()])if(s.closed&&!s.queue.finals.length&&!s.queue.preview&&active?.captureId!==s.id){streams.delete(s.id);s.vad.close();send({type:'capture-done',epoch,route:s.route,captureId:s.id});}
  status();
 }
 function open(e){if(streams.has(e.captureId)||streams.size>=8)throw Error('Too many pending microphone turns. Wait for transcription.');const s={id:e.captureId,route:e.route,offset:e.offset||0,queue:new RecognitionQueue({cadence}),closed:false};
 s.vad=new VadClient(modelRoot,{contextOverlap:process.env.VOICE_CONTEXT_OVERLAP!=='0',turnSettle:e.turnSettle===undefined?turnSettle:require('./turn-settings.cjs').resolveSettle(e.turnSettle),consumed(sampleCount){send({type:'consumed',epoch,sampleCount});},error:error=>fail(error.message),events(events,flushed){if(!streams.has(s.id))return;for(const event of events){const timing=event.timing?{...event.timing,start:event.timing.start+s.offset,end:event.timing.end+s.offset,...(Number.isFinite(event.timing.commitStart)?{commitStart:event.timing.commitStart+s.offset}:{})}:undefined;const utteranceId=s.id+':'+event.utteranceId;
 if(event.type==='segment'||event.type==='preview'){const job={type:'decode',id:++sequence,epoch,captureId:s.id,route:s.route,utteranceId,preview:event.type==='preview',samples:event.samples,timing,queuedAt:Date.now()};if(recording){const {samples,...meta}=job;send({...meta,type:'recognition-input',samples:job.preview?undefined:samples});}s.queue.add(job);}else if(event.type==='activity')send({...event,utteranceId,timing,epoch,route:s.route,captureId:s.id});}
 if(flushed)s.closed=true;const seconds=[...streams.values()].reduce((n,s)=>n+s.queue.seconds,0);if(seconds>60)return fail('Recognition fell behind. Your unfinished speech was not sent.');pump();}});streams.set(s.id,s);s.vad.reset();}
 decoder.on('message',e=>{if(e.type==='ready'){ready=true;send({type:'ready',engine:e.engine,loadMs:e.loadMs});pump();return;}if(e.type==='decode-error')return fail(e.message);if(e.type!=='decoded')return;const job=active,s=job&&streams.get(job.captureId),visible=s&&job.epoch===epoch&&s.queue.mayShow(job);if(visible&&(job.timing?.overlapSeconds||job.timing?.contextOverlapSeconds)){
  try{
   const contextSeconds=job.timing.overlapSeconds?Math.max(0,(s.acceptedThrough??job.timing.commitStart)-job.timing.start):0;
   const holdSeconds=job.timing.reason==='length-limit'?require('./turn-settings.cjs').BOUNDARY_HOLD_SECONDS:0;
   const trimmed=require('./overlap-text.cjs').contextualResult(e.alignedRecognizerResult||e.recognizerResult,{contextSeconds,holdSeconds,audioSeconds:job.timing.end-job.timing.start,overlapSeconds:job.timing.contextOverlapSeconds||3,previousText:s.acceptedText||''});
   if(!e.text.trim()&&s.pendingText&&!holdSeconds){trimmed.text=s.pendingText;trimmed.method='original-ending-fallback';trimmed.reviewRequired=true;}
   e={...e,rawText:e.text,text:trimmed.text,committedThrough:job.timing.start+trimmed.commitSeconds,boundaryPending:!!trimmed.pendingText,overlap:trimmed};
   if(!job.preview){s.pendingText=trimmed.pendingText;s.acceptedThrough=e.committedThrough;}
  }catch(error){
   // Preserve the raw words for review if native alignment is unavailable.
   // Do not silently guess which words to discard or stop audio capture.
   e={...e,rawText:e.text,committedThrough:job.timing.end,boundaryPending:false,overlap:{method:'untrimmed-fallback',reviewRequired:true,error:error.message}};
   if(!job.preview){s.pendingText='';s.acceptedThrough=e.committedThrough;}
  }
 }
 if(visible&&!job.preview)s.acceptedText=((job.timing?.overlapSeconds?s.acceptedText||'':'')+' '+e.text).trim().slice(-4096);
 if(recording&&job?.epoch===epoch)send({...e,route:job.route,captureId:job.captureId,type:'decode-result',visible:!!visible,queueMs:job.queueMs});if(visible){send({...e,type:job.preview?'partial':'final',route:job.route,captureId:job.captureId,queueMs:job.queueMs});}if(job?.epoch===epoch)cadence.observe(job,e.decodeMs);active=null;pump();});
 decoder.on('error',e=>fail(e.message));decoder.on('exit',()=>{for(const s of streams.values())s.vad.close();process.exit(0);});
 process.on('message',e=>{try{
 if(e.type==='reset'){cadence.reset();epoch=e.epoch;lastStatus.clear();recording=!!e.recording;turnSettle=require('./turn-settings.cjs').resolveSettle(e.turnSettle);for(const s of streams.values())s.vad.close();streams.clear();status();}
 if(e.epoch!==epoch)return;
 if(e.type==='capture-open'){if(!['agent','local'].includes(e.route)||typeof e.captureId!=='string')throw Error('Invalid microphone destination');open(e);}
 if(e.type==='audio'){const s=streams.get(e.captureId);if(s&&!s.closed)s.vad.push(new Float32Array(e.samples));else send({type:'consumed',epoch,sampleCount:e.samples.byteLength/4});}
 if(e.type==='capture-close'){const s=streams.get(e.captureId);if(s&&!s.closing){s.closing=true;s.vad.flush();}}
 }catch(error){fail(error.message);}});
 process.on('disconnect',()=>{for(const s of streams.values())s.vad.close();decoder.kill();process.exit(0);});
}
module.exports={startManualRecognition};
