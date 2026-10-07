const path=require('node:path'),koffi=require('koffi');
const {PcmWindow}=require('./pcm-window.cjs');
const nativeDir=path.resolve(process.env.LOCAL_VOICE_NATIVE_DIR||path.join(__dirname,'../assets/moonshine-engine/moonshine_voice'));
if(process.platform==='win32')koffi.load(path.join(nativeDir,'onnxruntime.dll'));
const library={win32:'moonshine.dll',linux:'libmoonshine.so',darwin:'libmoonshine.dylib'}[process.platform];
if(!library)throw Error('Unsupported Moonshine platform: '+process.platform);
const lib=koffi.load(path.join(nativeDir,library));
const Option=koffi.struct('VoiceOption',{name:'str',value:'str'});
const Line=koffi.struct('VoiceLine',{
  text:'str',audio_data:'void*',audio_data_count:'size_t',start_time:'float',duration:'float',id:'uint64_t',
  is_complete:'int8_t',is_updated:'int8_t',is_new:'int8_t',has_text_changed:'int8_t',have_speakers_changed:'int8_t',
  speaker_spans:'void*',speaker_span_count:'uint64_t',last_transcription_latency_ms:'uint32_t',words:'void*',word_count:'uint64_t'
});
const Transcript=koffi.struct('VoiceTranscript',{lines:'void*',line_count:'uint64_t'});
if(koffi.sizeof(Line)!==88||koffi.sizeof(Transcript)!==16)throw Error('Unsupported Moonshine native ABI');
const load=lib.func('int32_t moonshine_load_transcriber_from_files(const char*, uint32_t, VoiceOption*, uint64_t, int32_t)');
const free=lib.func('void moonshine_free_transcriber(int32_t)');
const create=lib.func('int32_t moonshine_create_stream(int32_t,uint32_t)');
const freeStream=lib.func('int32_t moonshine_free_stream(int32_t,int32_t)');
const start=lib.func('int32_t moonshine_start_stream(int32_t,int32_t)');
const stop=lib.func('int32_t moonshine_stop_stream(int32_t,int32_t)');
const add=lib.func('int32_t moonshine_transcribe_add_audio_to_stream(int32_t,int32_t,const float*,uint64_t,int32_t,uint32_t)');
const update=lib.func('int32_t moonshine_transcribe_stream(int32_t,int32_t,uint32_t,_Out_ void**)');
const error=lib.func('const char* moonshine_error_to_string(int32_t)');
function check(code){if(code<0)throw Error(error(code)||'Local recognizer error '+code);return code;}
function createRecognizer(modelRoot,{segmentsOnly=false,previews=false}={}){
  const options=[{name:'transcription_interval',value:'1.5'},{name:'return_audio_data',value:'false'},{name:'log_output_text',value:'false'},
    {name:'decode_incomplete_lines',value:process.env.VOICE_PARTIALS==='0'?'false':'true'},{name:'ort_providers',value:'cpu'},{name:'vad_max_segment_duration',value:'15'}];
  if(segmentsOnly){options.push({name:'skip_transcription',value:'true'},{name:'vad_window_duration',value:'0.8'},{name:'vad_threshold',value:'0.3'});options.find(o=>o.name==='return_audio_data').value='true';options.find(o=>o.name==='transcription_interval').value='0.2';}
  const handle=check(load(path.join(modelRoot,'moonshine-medium-streaming-en'),5,options,options.length,30000));
  const input=new PcmWindow(),previewAt=new Map();
  let stream=null,samplesSinceUpdate=0,completed=new Set(),streamBase=0,deliveredEnd=0;
  function openStream(){if(stream!==null)check(freeStream(handle,stream));stream=check(create(handle,0));check(start(handle,stream));samplesSinceUpdate=0;completed.clear();previewAt.clear();}
  function reset(){input.reset();streamBase=0;deliveredEnd=0;openStream();}
  function read(force=false){
    const out=[null];check(update(handle,stream,force?1:0,out));
    if(!out[0])return [];
    const transcript=koffi.decode(out[0],Transcript);
    if(!transcript.lines||!transcript.line_count)return [];
    if(transcript.line_count>10000)throw Error('Invalid recognizer result');
    // Transcript memory is borrowed: copy text before the next native call.
    const lines=koffi.decode(transcript.lines,Line,Number(transcript.line_count));
    const events=[];
    for(const line of lines){
      const id=String(line.id);
      if(completed.has(id))continue;
      if(line.is_complete){completed.add(id);
        if(segmentsOnly&&line.audio_data&&line.audio_data_count>0&&line.audio_data_count<=16000*20){
          const nativeStart=streamBase+Math.round(line.start_time*16000);
          const end=Math.min(input.end,nativeStart+Number(line.audio_data_count));
          if(end<=deliveredEnd)continue;
          // VAD averages 800 ms of speech evidence. Preserve another 500 ms of
          // onset beyond its own look-behind, including speech before TTS stops.
          // Never prepend audio already owned by a preceding utterance.
          const begin=Math.max(input.start,deliveredEnd,nativeStart-8000);
          const audio=input.slice(begin,end);
          deliveredEnd=end;
          events.push({type:'segment',utteranceId:id,samples:audio.buffer,timing:{start:begin/16000,end:end/16000,nativeStart:nativeStart/16000,onsetMs:Math.max(0,nativeStart-begin)/16}});
        }else if(line.text?.trim())events.push({type:'final',text:line.text});
      }
      else if(line.has_text_changed||line.is_updated){
        events.push(segmentsOnly?{type:'activity',utteranceId:id,timing:{start:Math.max(input.start,deliveredEnd,streamBase+Math.round(line.start_time*16000)-8000)/16000,end:Math.min(input.end,streamBase+Math.round((line.start_time+line.duration)*16000))/16000}}:{type:'partial',text:line.text||''});
        if(previews&&line.duration>=1.5&&input.end-(previewAt.get(id)||0)>=24000){
          previewAt.set(id,input.end);
          const begin=Math.max(input.start,deliveredEnd,streamBase+Math.round(line.start_time*16000)-8000);
          const end=Math.min(input.end,streamBase+Math.round((line.start_time+line.duration)*16000));
          events.push({type:'preview',utteranceId:id,samples:input.slice(begin,end).buffer,timing:{start:begin/16000,end:end/16000}});
        }
      }
    }
    // Bound native transcript storage, but keep the audio that arrived after
    // the last segment. The old per-utterance reset discarded this look-ahead.
    if(segmentsOnly&&!force&&input.end-streamBase>=16000*60&&lines.every(line=>line.is_complete)){
      const begin=Math.max(input.start,input.end-16000),tail=input.slice(begin);
      streamBase=begin;openStream();check(add(handle,stream,tail,tail.length,16000,0));samplesSinceUpdate=tail.length;
    }
    return events;
  }
  reset();
  return {
    push(samples){
      input.push(samples);
      check(add(handle,stream,samples,samples.length,16000,0));samplesSinceUpdate+=samples.length;
      if(samplesSinceUpdate<(segmentsOnly?3200:24000))return [];
      samplesSinceUpdate=0;return read();
    },
    flush(){check(stop(handle,stream));return read(true);},
    reset,
    close(){if(stream!==null){freeStream(handle,stream);stream=null;}free(handle);}
  };
}
module.exports={createRecognizer};



