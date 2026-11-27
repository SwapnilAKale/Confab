'use strict';
// Voice mode: hands-free turns. One open capture on the echo-cancelled microphone stream; each turn the speech
// detector ends is recorded as the talk-back dictation, pasted into the voice box and sent with Enter; speaking while a
// reply plays stops it; the speakers' echo of a reply is never sent back.
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {PcController}=require('../src/pc/controller.cjs'),{TalkbackGate}=require('../src/pc/talkback.cjs'),{WindowsTextInput}=require('../src/input/windows-text.cjs'),{parseHotkeys}=require('../src/input/hotkeys.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));

function voiceController(t,{echoCancel=true,insertResult={status:'inserted',submitted:true,reason:'enter_queued',clipboardRestored:true},voiceIdleMs,bargeIn,clock}={}){
 const state={inserts:[],requests:[],clipboard:[],notices:[],starts:[],stops:0,ends:0,stopPlayback:0,cues:[],dictated:[],synth:[]};
 const gate=new TalkbackGate();
 const input=new EventEmitter();
 Object.assign(input,{ready:Promise.resolve({}),hotkeys:{voice:{label:'Ctrl+Shift+6'}},request:async action=>{state.requests.push(action);},close(){},api:{setClipboard:text=>state.clipboard.push(text)},
  insert:async(text,autoSend)=>{state.inserts.push({text,autoSend});return insertResult;}});
 const audio=new EventEmitter();
 for(const n of ['loadingCue','disarmCue','tick','errorCue','limitCue'])audio[n]=async()=>{state.cues.push(n);};
 Object.assign(audio,{cue:async start=>{state.cues.push(start?'start':'stop');},start:async(onData,options)=>{state.starts.push(options||null);state.onData=onData;return {communications:echoCancel};},stop:async()=>{state.stops++;},stopPlayback(){state.stopPlayback++;},close:async()=>{}});
 const engine=new EventEmitter();
 Object.assign(engine,{state:'loaded',start:async(id,emit)=>{state.emit=emit;},audio(){},end(){state.ends++;},cancel(){state.cancelled=true;},close(){},synthesize:async text=>{state.synth.push(text);return [];}});
 const c=new PcController({engine,audio,input,lazy:true,onTalkback:text=>{state.dictated.push(text);gate.dictated(text);},onDisarm:()=>gate.disarm(),notify:{failure:m=>{state.notices.push(m);return true;},badge(){},close:async()=>{}},saveDraft(){},clearDraft(){},...(voiceIdleMs?{voiceIdleMs}:{}),...(bargeIn!==undefined?{bargeIn}:{}),...(clock?{clock}:{})});
 t.after(()=>c.close());return {c,state,input,gate};
}
async function startVoice(c,input){input.emit('voice',{action:'start'});await c.actions;}
// Microphone audio: `seconds` of a 200 Hz tone at `amplitude` (0-1), as 16 kHz PCM16 in 20 ms chunks.
function tone(seconds,amplitude){const out=[];const n=Math.round(seconds*16000);for(let off=0;off<n;off+=320){const len=Math.min(320,n-off),pcm=Buffer.alloc(len*2);for(let i=0;i<len;i++)pcm.writeInt16LE(Math.round(amplitude*32767*Math.sin(2*Math.PI*200*(off+i)/16000)),i*2);out.push(pcm);}return out;}
// Feeds audio to the controller's microphone callback; after each chunk, `after(chunk index)` may emit detector events.
// A real cough (band-limited noise, no pitch, 0.5 s: longer than the 0.24 s barge-in needs) as 20 ms PCM16 chunks.
function coughChunks(seconds=0.5,level=0.6,seed=3){const {cough,pcm16}=require('./helpers/speech-sim.cjs'),f=cough(seconds,level,{seed}),out=[];for(let i=0;i<f.length;i+=320)out.push(pcm16(f.subarray(i,i+320)));return out;}
function feed(state,chunks,after=()=>{}){chunks.forEach((pcm,i)=>{state.onData(pcm);after(i);});}
// A turn the detector ended, `start`..`end` seconds into the capture.
const turn=(text,start=0,end=1,reason='endpoint')=>({type:'final',text,timing:{start,end,reason}});
// A turn with the recogniser's word times: `starts` in seconds into the capture, given as token times into the segment.
const timedTurn=(words,starts,start,end)=>({type:'final',text:words.join(' '),timing:{start,end,reason:'endpoint'},recognizerResult:{tokens:words.map(w=>' '+w),timestamps:starts.map(t=>t-start),durations:words.map(()=>0.2)}});

test('voice mode opens one echo-cancelled capture and sends each detected turn as a talk-back turn with Enter',async t=>{
 const {c,state,input,gate}=voiceController(t);await c.ready();await startVoice(c,input);
 assert.deepEqual(state.starts,[{communications:true}],'the microphone is opened as a communications (echo-cancelled) stream');
 assert.equal(c.status().voice.on,true);assert.equal(c.status().voice.echoCancel,true);assert.equal(c.badgeState().name,'voice');
 state.emit(turn('Run the tests please'));await wait(10);
 assert.deepEqual(state.inserts,[{text:'Run the tests please',autoSend:true}],'pasted and sent with Enter');
 assert.deepEqual(state.dictated,['Run the tests please'],'recorded as the talk-back dictation');
 assert.equal(gate.turn('claude-code:s1',null,'Run the tests please'),'match','the agent turn it becomes owns the spoken reply');
 state.emit(turn('And then commit',5,6));await wait(10);
 assert.equal(state.inserts.length,2,'voice mode keeps listening after a turn');assert.equal(c.status().metrics.voiceSent,2);
 assert.equal(c.state,'recording');assert.equal(state.stops,0,'the microphone stays open');
});

test('a turn longer than the detector window is sent once, joined, at its real end',async t=>{
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);
 state.emit(turn('first part of a long thought',0,24,'length-limit'));await wait(10);
 assert.equal(state.inserts.length,0,'a length-limit piece is not sent on its own');
 state.emit(turn('and its ending',24,30));await wait(10);
 assert.deepEqual(state.inserts.map(i=>i.text),['first part of a long thought and its ending']);
});

test('speaking while a reply is read stops it (barge-in); a cough does not, even when the detector calls it 1 s of speech',async t=>{
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);
 c.lastSpeech={state:'playing'};const before=state.stopPlayback;
 feed(state,tone(3,0.002));// background
 // A 0.15 s cough; the detector reports activity for it with its 0.75 s pre-speech and 0.5 s hang-over (about 1.4 s).
 feed(state,[...coughChunks(),...tone(0.6,0.002)],()=>state.emit({type:'activity',utteranceId:'a',timing:{start:2.25,end:3.65}}));
 assert.equal(state.stopPlayback,before,'a cough does not interrupt');assert.equal(c.lastSpeech.state,'playing');
 feed(state,tone(1,0.002));
 // Speech: activity is reported while it goes on.
 let stoppedAt=null;feed(state,tone(1,0.08),i=>{state.emit({type:'activity',utteranceId:'b',timing:{start:4,end:4.75+i*0.02}});if(stoppedAt===null&&state.stopPlayback>before)stoppedAt=(i+1)*0.02;});
 assert.ok(stoppedAt!==null,'speech interrupts');assert.ok(stoppedAt>=0.2&&stoppedAt<=0.4,'after about 0.24 s of voice, not at once: '+stoppedAt);
 assert.equal(c.status().metrics.interruptions,1);assert.equal(c.lastSpeech.state,'cancelled');
 assert.equal(c.status().voice.on,true,'voice mode keeps listening after an interruption');
});

test('through the real speech detector code: a cough does not stop the reply, speech does',async t=>{
 // sherpa-onnx's Silero detector replaced by one that is "detected" from 0.1 s after loud audio starts until 0.5 s after
 // it ends, as the real one is with the default settings; silero-segmenter.cjs then builds the activity events.
 const sherpaPath=require.resolve('sherpa-onnx-node');const saved=require.cache[sherpaPath];let total=0,loudSince=null,lastLoud=-1;
 class FakeVad{acceptWaveform(samples){for(const v of samples){total++;if(Math.abs(v)>0.05){if(loudSince===null)loudSince=total;lastLoud=total;}else if(total-lastLoud>8000)loudSince=null;}}isEmpty(){return true;}front(){}pop(){}flush(){}isDetected(){return loudSince!==null&&total-loudSince>=1600&&total-lastLoud<=8000;}}
 require.cache[sherpaPath]={id:sherpaPath,filename:sherpaPath,loaded:true,exports:{Vad:FakeVad}};
 const segPath=require.resolve('../src/silero-segmenter.cjs');delete require.cache[segPath];
 t.after(()=>{if(saved)require.cache[sherpaPath]=saved;else delete require.cache[sherpaPath];delete require.cache[segPath];});
 const segmenter=require('../src/silero-segmenter.cjs').createSegmenter(require('node:path').resolve('assets/models'));
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);c.lastSpeech={state:'playing'};const before=state.stopPlayback;
 const run=chunks=>{let longest=0;for(const pcm of chunks){state.onData(pcm);const f=new Float32Array(pcm.length/2);for(let i=0;i<f.length;i++)f[i]=pcm.readInt16LE(i*2)/32768;for(const e of segmenter.push(f))if(e.type==='activity'){longest=Math.max(longest,e.timing.end-e.timing.start);state.emit(e);}}return longest;};
 run(tone(3,0.002));
 const cough=run([...coughChunks(),...tone(1,0.002)]);
 assert.ok(cough>=0.5,'the detector reports the cough as '+cough.toFixed(2)+' s of speech');assert.equal(state.stopPlayback,before,'yet it does not interrupt');
 run(tone(1.2,0.08));assert.equal(state.stopPlayback,before+1,'speech interrupts');
});

test('the voiceInterrupt setting off: speaking does not stop a reply, the badge says to use Cancel',async t=>{
 const {c,state,input}=voiceController(t,{bargeIn:false});await c.ready();await startVoice(c,input);
 assert.equal(c.status().voice.interrupt,false);c.lastSpeech={state:'playing'};assert.equal(c.badgeState().name,'voice-speaking-keys');const before=state.stopPlayback;
 feed(state,[...tone(3,0.002),...tone(1,0.1)],i=>state.emit({type:'activity',utteranceId:'b',timing:{start:3,end:3.75+i*0.02}}));
 assert.equal(state.stopPlayback,before);assert.equal(c.lastSpeech.state,'playing');
});

test('without Windows echo cancellation, on speakers: its own echo never stops a reply, the user speaking does',async t=>{
 const {speech,pcm16,microphone}=require('./helpers/speech-sim.cjs');
 let now=1e6;const {c,state,input}=voiceController(t,{echoCancel:false,clock:()=>now});await c.ready();await startVoice(c,input);
 assert.equal(c.status().voice.echoCancel,false);assert.equal(c.status().voice.interrupt,true,'interrupting by voice does not need Windows echo cancellation');
 // A 10 s reply played on loud laptop speakers: it comes back into the microphone at full level, 120 ms later.
 const reply=speech(10,24000,{seed:4,pitch:190,level:0.3}),hear=(mic,after=()=>{})=>{for(let i=0;i<mic.length;i+=320){now+=20;state.onData(pcm16(mic.subarray(i,i+320)));after(i/16000);}};
 hear(microphone({output:new Float32Array(1),outRate:24000,seconds:2,delayMs:120,gain:1}));
 c.lastSpeech={state:'playing'};assert.equal(c.badgeState().name,'voice-speaking');const before=state.stopPlayback;
 c.selfEcho.startReply();for(let i=0;i<reply.length;i+=24000)c.selfEcho.play(pcm16(reply.subarray(i,i+24000)),24000);
 // The speech detector hears the echo as speech the whole time.
 const activity=()=>state.emit({type:'activity',utteranceId:'e',timing:{start:2,end:now/1000}});
 hear(microphone({output:reply,outRate:24000,seconds:6,delayMs:120,gain:1,seed:9}),activity);
 assert.equal(state.stopPlayback,before,'6 s of its own echo: not interrupted');assert.equal(c.lastSpeech.state,'playing');
 assert.equal(c.status().voice.selfEcho.learnt,true);assert.ok(Math.abs(c.status().voice.selfEcho.delayMs-120)<=80,'echo delay learnt: '+c.status().voice.selfEcho.delayMs);
 // The user talks over it at twice the echo's loudness.
 const user=speech(3,16000,{seed:11,pitch:120,level:0.6});
 let stoppedAt=null;const rest=microphone({output:reply.subarray(6*24000),outRate:24000,seconds:3,delayMs:120,gain:1,user,userAt:0,seed:10});
 hear(rest,t=>{activity();if(stoppedAt===null&&state.stopPlayback>before)stoppedAt=t;});
 assert.ok(stoppedAt!==null&&stoppedAt<1.5,'the user stops it: '+stoppedAt);assert.equal(c.status().metrics.interruptions,1);
});

test('the speakers\' echo of a reply is dropped; the user\'s own words are sent',async t=>{
 const {c,state,input}=voiceController(t,{echoCancel:false});await c.ready();await startVoice(c,input);
 const live=c.capture.liveAt;
 c.spokenEcho={text:'the build passed and all twelve tests are green',words:new Set('the build passed and all twelve tests are green'.split(' ')),startedAt:live+1000,endedAt:null};
 state.emit(turn('the build passed and all tests are green',1.5,4));await wait(10);
 assert.equal(state.inserts.length,0,'the reply heard back is not sent');assert.equal(c.status().metrics.echoDropped,1);
 state.emit(turn('tests are green',4.5,5));await wait(10);
 assert.equal(state.inserts.length,0,'a short phrase from the reply while it still plays is echo');
 state.emit(turn('please deploy it to staging now',5,7));await wait(10);
 assert.deepEqual(state.inserts.map(i=>i.text),['please deploy it to staging now'],'different words are the user and are sent');
 c.spokenEcho.endedAt=live+8000;
 state.emit(turn('green',8.5,9));await wait(10);
 assert.equal(state.inserts.at(-1).text,'green','a one-word answer after the reply ended is sent even if the reply had that word');
 state.emit(turn('the build passed and all tests are green',20,22));await wait(10);
 assert.equal(state.inserts.at(-1).text,'the build passed and all tests are green','long after the reply, the same words are the user');
});

test('a reply that really plays reaches the self-recognition, and its echo heard while it is still playing never interrupts it; the user talking over it does',async t=>{
 const {speech,pcm16,microphone}=require('./helpers/speech-sim.cjs'),{wave}=require('../src/service/native-engine.cjs');
 let now=1e6;const {c,state,input}=voiceController(t,{echoCancel:false,clock:()=>now});
 // The speech engine returns 8 s of speech-like audio; the device stream records it and keeps playing until released.
 const voice=speech(8,24000,{seed:5,pitch:190,level:0.3}),written=[];let release;const played=new Promise(r=>release=r);
 c.engine.synthesize=async(text,{onChunk})=>{state.synth.push(text);onChunk(wave(voice,24000));return [];};
 c.audio.stream=rate=>({write:pcm=>written.push({rate,bytes:pcm.length}),end:()=>played});
 await c.ready();await startVoice(c,input);
 // Set after voice mode starts (starting stops any playback): stopping playback ends this reply's stream.
 c.audio.stopPlayback=()=>{state.stopPlayback++;release();};
 const hear=(mic,after=()=>{})=>{for(let i=0;i<mic.length;i+=320){now+=20;state.onData(pcm16(mic.subarray(i,i+320)));after(i/16000);}};
 hear(microphone({output:new Float32Array(1),outRate:24000,seconds:2,delayMs:150,gain:1}));
 const before=state.stopPlayback;assert.equal(c.reply('Here is a longer answer that is read aloud.'),true);
 for(let i=0;i<50&&c.lastSpeech.state!=='playing';i++)await wait(5);
 assert.equal(c.lastSpeech.state,'playing','the reply is really playing: '+JSON.stringify(c.lastSpeech));assert.ok(written.length>=1,'played through the device stream');assert.equal(written[0].bytes,voice.length*2);
 assert.ok(c.selfEcho.out.length>=390,'the self-recognition recorded the 8 s it is playing: '+c.selfEcho.out.length+' frames');assert.equal(c.selfEcho.status().learnt,false,'nothing learnt before it played');
 // 5 s of that reply heard back at full loudness while it plays, the detector calling it speech: learnt, no interruption.
 const activity=()=>state.emit({type:'activity',utteranceId:'e',timing:{start:2,end:now/1000}});
 hear(microphone({output:voice,outRate:24000,seconds:5,delayMs:150,gain:1,seed:12}),activity);
 assert.equal(c.selfEcho.status().learnt,true,'echo learnt from the playing reply');assert.equal(c.lastSpeech.state,'playing','still playing');assert.equal(state.stopPlayback,before,'its own echo did not interrupt it');
 // The user talks over the rest of it, twice as loud as the echo: the real playback is stopped.
 let stoppedAt=null;hear(microphone({output:voice.subarray(5*24000),outRate:24000,seconds:3,delayMs:150,gain:1,user:speech(3,16000,{seed:11,pitch:120,level:0.6}),seed:13}),t=>{activity();if(stoppedAt===null&&state.stopPlayback>before)stoppedAt=t;});
 assert.ok(stoppedAt!==null&&stoppedAt<1.5,'the user stops it: '+stoppedAt);await c.speech;assert.equal(c.lastSpeech.state,'cancelled');
});

test('what the user says right after interrupting is sent, with the reply own words trimmed from its start',async t=>{
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);
 const live=c.capture.liveAt,reply='the deployment finished and every service is healthy again';
 c.spokenEcho={text:reply,words:new Set(reply.split(' ')),startedAt:live+1000,endedAt:null};
 // The turn heard from 3.0 s: the reply's tail (words starting 3.0-3.8 s), then the user from 4.3 s; the interruption
 // is detected at 4.8 s. The recogniser gives each word's start (seconds into the segment).
 c.capture.interruptions=[{at:live+4800,spoken:c.spokenEcho}];c.spokenEcho.endedAt=live+4800;
 state.emit(timedTurn(['every','service','is','healthy','wait','roll','back','the','database','first'],[3.0,3.3,3.5,3.8,4.3,4.6,4.8,5.0,5.2,5.6],3.0,7));await wait(10);
 assert.deepEqual(state.inserts.map(i=>i.text),['wait roll back the database first'],'sent, without the reply words');
 assert.deepEqual(state.dictated,['wait roll back the database first'],'and its reply will be read');
 // Without the interruption the same words would have been dropped as echo (mostly the reply's words).
 c.capture.interruptions=[];state.emit(turn('the deployment finished and every service is healthy again now',5,6));await wait(10);
 assert.equal(state.inserts.length,1,'a turn mostly of the reply words, not during an interruption, is still echo');
});

test('after interrupting, the user repeating the reply own words is still sent',async t=>{
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);
 const live=c.capture.liveAt,reply='do you want me to run the tests now';
 c.spokenEcho={text:reply,words:new Set(reply.split(' ')),startedAt:live+1000,endedAt:null};
 // The user starts at 4.2 s with "run the tests" (words the reply said); the interruption is detected at 4.7 s.
 c.capture.interruptions=[{at:live+4700,spoken:c.spokenEcho}];c.spokenEcho.endedAt=live+4700;
 state.emit(timedTurn(['run','the','tests'],[4.2,4.5,4.7],4.0,5.6));await wait(10);
 assert.deepEqual(state.inserts.map(i=>i.text),['run the tests'],'kept: those words came after the user started');
 // The reply's tail heard just before the user, in the same turn, is still trimmed.
 c.capture.interruptions=[{at:live+9700,spoken:c.spokenEcho}];
 state.emit(timedTurn(['the','tests','now','run','the','tests'],[8.6,8.8,9.0,9.2,9.5,9.7],8.6,10.6));await wait(10);
 assert.equal(state.inserts.at(-1).text,'run the tests','the echo before the user is trimmed, the user words kept');
});

test('the voice key after a message was sent: the reply being read stops, the reply still awaited is not read, last words are pasted, not sent',async t=>{
 const {c,state,input,gate}=voiceController(t);await c.ready();await startVoice(c,input);
 state.emit(turn('what is the weather'));await wait(10);assert.equal(gate.status().pending,'dictation','talk-back waiting for that message');
 c.lastSpeech={state:'playing'};const before=state.stopPlayback;
 input.emit('voice',{action:'stop'});await c.actions;
 assert.equal(state.stopPlayback,before+1,'the reading stops');assert.equal(gate.status().pending,'none','the awaited reply will not be read');
 state.emit(turn('never mind',5,6));state.emit({type:'capture-done'});await wait(20);
 assert.deepEqual(state.inserts.at(-1),{text:'never mind',autoSend:false},'last words pasted, without Enter');assert.equal(state.inserts[0].autoSend,true,'(the message before was sent)');assert.deepEqual(state.dictated,['what is the weather'],'but not as talk-back');assert.equal(gate.status().pending,'none');
});

test('voice mode asks the speech detector for the shorter voice turn end; dictation keeps the 2.2 s floor',async t=>{
 const {resolveSettle,VOICE_SETTLE,DEFAULT_SETTLE}=require('../src/turn-settings.cjs');
 assert.equal(VOICE_SETTLE,1.2);assert.equal(resolveSettle(undefined,{voice:true}),1.2);assert.equal(resolveSettle(0.5,{voice:true}),1.2);assert.equal(resolveSettle(undefined),DEFAULT_SETTLE);assert.equal(resolveSettle(1.2),2.2,'dictation is never shortened');
 const {c,input}=voiceController(t);let options=null;c.engine.start=async(id,emit,o)=>{options=o;};await c.ready();await startVoice(c,input);assert.deepEqual(options,{voice:true});
});

test('replies play during voice mode instead of waiting for the capture to end',async t=>{
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);
 assert.equal(c.reply('All done.'),true);await c.speech;
 assert.equal(c.lastSpeech.state,'completed',JSON.stringify(c.lastSpeech)+state.notices.join());assert.deepEqual(state.synth,['All done.'],'synthesized while voice mode listens');
});

test('the voice key ends voice mode: the microphone closes, speech already heard is pasted but not sent',async t=>{
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);
 input.emit('voice',{action:'stop'});await c.actions;
 assert.equal(state.stops,1);assert.equal(state.ends,1);assert.ok(state.cues.includes('stop'));assert.equal(c.badgeState().name,'transcribing');
 state.emit(turn('last words'));state.emit({type:'capture-done'});await wait(20);
 assert.deepEqual(state.inserts,[{text:'last words',autoSend:false}],'speech heard before the voice key is pasted for review, not sent');
 assert.equal(c.capture,null);assert.equal(c.state,'ready');assert.ok(state.requests.includes('voice-reset'),'the input leaves voice mode');assert.equal(c.status().voice.on,false);
});

test('Cancel in voice mode discards unsent speech and ends voice mode',async t=>{
 const {c,state,input}=voiceController(t);await c.ready();await startVoice(c,input);
 state.emit(turn('half a thought',0,24,'length-limit'));
 input.emit('disarmed',{voice:true});await c.actions;
 assert.equal(c.capture,null);assert.equal(c.state,'ready');assert.equal(state.cancelled,true);assert.deepEqual(state.clipboard,[],'nothing is copied');assert.equal(state.inserts.length,0);
 assert.ok(state.requests.includes('voice-reset'));
});

test('Cancel while a voice turn is being pasted ends voice mode quietly',async t=>{
 let release;const {c,state,input}=voiceController(t);input.insert=async(text)=>{state.inserts.push({text});await new Promise(r=>release=r);return {status:'inserted',submitted:false,reason:'enter_refused'};};
 await c.ready();await startVoice(c,input);
 state.emit(turn('send this'));await wait(10);assert.equal(state.inserts.length,1,'the paste is in progress');
 input.emit('disarmed',{voice:true});await c.actions;assert.equal(c.capture,null);assert.equal(c.status().voice.on,false);
 const notices=state.notices.length;release();await wait(10);
 assert.equal(state.notices.length,notices,'no notice about an unsent message after Cancel');assert.deepEqual(state.clipboard,[]);
});

test('a turn that cannot be pasted in the voice box goes to the clipboard and voice mode keeps listening',async t=>{
 const {c,state,input}=voiceController(t,{insertResult:{status:'rejected',reason:'focus_changed'}});await c.ready();await startVoice(c,input);
 state.emit(turn('send this'));await wait(20);
 assert.deepEqual(state.clipboard,['send this']);assert.match(state.notices.at(-1),/Not sent: focus was not in the box/);
 assert.equal(c.status().voice.on,true);assert.equal(c.state,'recording');
});

test('a box that cannot be read back gets the paste but no Enter, and says so once',async t=>{
 const {c,state,input}=voiceController(t,{insertResult:{status:'inserted',submitted:false,verified:false,reason:'box_unreadable'}});await c.ready();await startVoice(c,input);
 state.emit(turn('one'));await wait(10);state.emit(turn('two',3,4));await wait(10);
 assert.equal(state.inserts.length,2);assert.equal(state.notices.filter(n=>/does not press Enter/.test(n)).length,1);assert.equal(c.status().metrics.voiceSent,0);
});

test('voice mode ends itself after the idle time without speech',async t=>{
 const {c,state,input}=voiceController(t,{voiceIdleMs:60});await c.ready();await startVoice(c,input);
 await wait(30);state.emit({type:'activity',timing:{start:1,end:1.1}});await wait(40);
 assert.equal(state.stops,0,'speech restarts the idle timer');
 await wait(60);await c.actions;
 assert.equal(state.stops,1);assert.ok(state.cues.includes('limitCue'));assert.match(state.notices.at(-1),/Voice mode stopped after/);
});

test('input: the voice key arms the focused box and toggles voice mode; Ctrl+Shift+8 or 7 also ends it',async t=>{
 const api={foreground:()=>'w',unlocked:()=>true,keysDown:()=>false,recentInput:()=>false,registerHotkeys:defs=>Object.keys(defs).map(()=>true),pollHotkeys:()=>[],close(){}};
 const accessibility={ready:Promise.resolve(true),snapshot:async()=>({status:'editable',window:'w',runtimeId:'f',processId:1}),close(){}};
 const input=new WindowsTextInput({api,accessibility,talkback:true,immediate:true,shortcuts:false});t.after(()=>input.close());const started=await input.ready;assert.equal(started.voiceHotkey,true);
 const events=[];for(const name of ['voice','capture','press','disarmed'])input.on(name,e=>events.push([name,e]));
 await input.hotkey(5);assert.deepEqual(events.shift(),['voice',{action:'start'}]);assert.ok(input.target,'the focused box is the voice target');
 await input.request('capture-reset');assert.ok(input.target,'a capture reset keeps the voice target');
 await input.hotkey(5);assert.deepEqual(events.shift(),['voice',{action:'stop'}]);
 // The dictation keys, pressed out of habit, end voice mode too (even mid-paste), and start nothing.
 for(const key of [2,4])for(const busy of [false,true]){await input.hotkey(5);events.shift();input.busy=busy;await input.hotkey(key);input.busy=false;
  assert.deepEqual(events.shift(),['voice',{action:'stop'}],'key '+key+(busy?' while pasting':''));assert.equal(input.voice,false);assert.equal(input.recording,false);assert.equal(events.length,0,'no dictation starts');}
 await input.hotkey(5);events.shift();await input.hotkey(3);assert.deepEqual(events.shift(),['disarmed',{recording:false,voice:true}]);assert.equal(input.voice,false);
 await input.hotkey(5);events.shift();input.busy=true;await input.hotkey(3);assert.deepEqual(events.shift(),['disarmed',{recording:false,voice:true}],'Cancel works even while a turn is being pasted');assert.equal(input.target,null,'the paste in progress loses its target, so no Enter follows');input.busy=false;
 const refusing=new WindowsTextInput({api,accessibility:{...accessibility,snapshot:async()=>({status:'rejected',reason:'not_editable'})},talkback:true,immediate:true,shortcuts:false});t.after(()=>refusing.close());await refusing.ready;
 const arms=[];refusing.on('arm',e=>arms.push(e));refusing.on('voice',e=>arms.push(e));await refusing.hotkey(5);
 assert.equal(arms.length,1);assert.equal(arms[0].result.status,'rejected','no editable box: voice mode does not start');
});

test('voice key: Ctrl+Shift+6 by default, next to talk-back and dictate; can be changed or turned off',()=>{
 const keys=parseHotkeys({},{talkback:true});assert.equal(keys.voice.label,'Ctrl+Shift+6');
 assert.equal(parseHotkeys({voice:'Ctrl+Shift+V'},{talkback:true}).voice.label,'Ctrl+Shift+V');
 assert.equal(parseHotkeys({voice:'off'},{talkback:true}).voice.off,true);
 assert.throws(()=>parseHotkeys({voice:'Ctrl+Shift+8'},{talkback:true}),/different shortcut/);
});

test('voice mode starts a reply with a short first piece: at most 30 characters whenever a word break allows, no text lost',()=>{
 const {voiceUnits}=require('../src/pc/controller.cjs');
 const cases=[['The tests passed, and the build is green on every platform.','The tests passed,'],
  ['The quick fix is to restart the service and then clear the temporary folder before running it again.','The quick fix is to restart'],
  ['Unfortunately the deployment pipeline configuration references a credential store.','Unfortunately the deployment'],
  ['I antidisestablishmentarianistically considered everything you said before answering.','I'],
  ['Supercalifragilisticexpialidociously long first word here.','Supercalifragilisticexpialidociously'],
  ['Pneumonoultramicroscopicsilicovolcanoconiosis.','Pneumonoultramicroscopicsilicovolcanoconiosis.'],['Yes.','Yes.'],
  // Any whitespace is a word break, and the pieces are trimmed.
  ['A\tantidisestablishmentarianistically considered everything you said.','A'],['I  antidisestablishmentarianistically considered it.','I'],['Line one\nantidisestablishmentarianistically considered.','Line one']];
 for(const [text,first] of cases){const units=voiceUnits(text);
  assert.equal(units[0],first,text);assert.equal(units.join(' ').replace(/\s+/g,' '),text.replace(/\s+/g,' '),'nothing lost or reordered: '+text);assert.ok(units.every(u=>u===u.trim()&&u),'pieces trimmed: '+text);
  if(/\s/.test(text.slice(1,31)))assert.ok(units[0].length<=30,'at most 30 characters: '+text);}
 assert.deepEqual(voiceUnits(''),[]);
});

// The real focus watch of the input layer, with a fake window and box whose identity the test changes.
async function focusRig(t){
 const box={status:'editable',window:'w',runtimeId:'f',processId:1,documentId:'d1',documentName:'New chat - Claude'};let foreground='w';
 const api={foreground:()=>foreground,unlocked:()=>true,keysDown:()=>false,recentInput:()=>false,registerHotkeys:defs=>Object.keys(defs).map(()=>true),pollHotkeys:()=>[],close(){}};
 const accessibility={ready:Promise.resolve(true),snapshot:async()=>({...box}),close(){}};
 const input=new WindowsTextInput({api,accessibility,talkback:true,immediate:true,shortcuts:false});t.after(()=>input.close());await input.ready;
 const focus=[];input.on('focus',e=>focus.push(e.inTarget));
 return {input,box,focus,setForeground:w=>{foreground=w;},settle:()=>wait(500)};
}

test('focus watch, plain dictation: leaving the box warns, coming back clears it',async t=>{
 const {input,box,focus,setForeground,settle}=await focusRig(t);
 await input.hotkey(2);await input.armed;await settle();assert.deepEqual(focus,[],'in the box: no warning');
 box.runtimeId='other';await settle();assert.deepEqual(focus,[false],'another box in the same window: Focus moved');
 box.runtimeId='f';await settle();assert.deepEqual(focus,[false,true],'back in the box');
 setForeground('x');await settle();assert.deepEqual(focus,[false,true,false],'another window: Focus moved');
 setForeground('w');box.documentName='Another chat - Claude';await settle();assert.deepEqual(focus,[false,true,false],'another chat (title) in dictation: still moved');
});

test('focus watch, voice mode: the app naming the chat after a send is the same box; switching chats, boxes or windows is not',async t=>{
 const {input,box,focus,setForeground,settle}=await focusRig(t);
 await input.hotkey(5);await settle();assert.deepEqual(focus,[]);
 // A send, then the Claude app renames "New chat": still the same box.
 input.voiceSentAt=Date.now();box.documentName='Weather today - Claude';await settle();assert.deepEqual(focus,[],'renamed after our send: same chat');
 // A further title change without a new send: another chat.
 box.documentName='Other chat - Claude';await settle();assert.deepEqual(focus,[false],'second title change: Focus moved');
 box.documentName='Weather today - Claude';await settle();assert.deepEqual(focus,[false,true],'back');
 // A title change long after the send: another chat.
 input.voiceSentAt=Date.now()-20000;box.documentName='Later chat - Claude';await settle();assert.deepEqual(focus,[false,true,false],'title change 20 s after a send: Focus moved');
 box.documentName='Weather today - Claude';await settle();
 // Another box or another window is never excused by a send.
 input.voiceSentAt=Date.now();box.runtimeId='other';await settle();assert.equal(focus.at(-1),false,'another box right after a send: Focus moved');
 box.runtimeId='f';await settle();assert.equal(focus.at(-1),true);
 input.voiceSentAt=Date.now();setForeground('x');await settle();assert.equal(focus.at(-1),false,'another window right after a send: Focus moved');
});

test('mute tap: Ctrl+Shift pressed and released on their own is a tap; with any other key, held long, or one alone it is not',()=>{
 const {ChordTap}=require('../src/input/windows-text.cjs');
 const run=samples=>{const tap=new ChordTap();let taps=0,t=0;for(const [ctrl,shift,other,ms=20] of samples){t+=ms;if(tap.sample({ctrl:!!ctrl,shift:!!shift,other:!!other},t))taps++;}return taps;};
 assert.equal(run([[1,0],[1,1],[1,1],[0,0]]),1,'Ctrl, then Shift, then both released');
 assert.equal(run([[0,1],[1,1],[1,0],[0,0]]),1,'Shift first, released one at a time');
 assert.equal(run([[1,1],[1,1,1],[1,1],[0,0]]),0,'Ctrl+Shift+5 (another key) is a shortcut, not a tap');
 assert.equal(run([[1,1],[1,1,1],[0,0],[1,1],[0,0]]),1,'after a shortcut, a clean tap still counts');
 assert.equal(run([[1,1],[1,1,0,900],[0,0]]),0,'held for almost a second: not a tap');
 assert.equal(run([[1,0],[1,0],[0,0]]),0,'Ctrl alone');assert.equal(run([[0,1],[0,0]]),0,'Shift alone');
 assert.equal(run([[1,1],[0,0],[1,1],[0,0]]),2,'two taps toggle twice');
});

test('mute tap: the input watches for it only in voice mode, and emits mute',async t=>{
 let chord={ctrl:false,shift:false,other:false},reads=0;
 const api={foreground:()=>'w',unlocked:()=>true,keysDown:()=>false,recentInput:()=>false,registerHotkeys:defs=>Object.keys(defs).map(()=>true),pollHotkeys:()=>[],close(){},modifierChord:()=>{reads++;return chord;}};
 const accessibility={ready:Promise.resolve(true),snapshot:async()=>({status:'editable',window:'w',runtimeId:'f',processId:1}),close(){}};
 const input=new WindowsTextInput({api,accessibility,talkback:true,immediate:true,shortcuts:false,muteTap:true});t.after(()=>input.close());await input.ready;
 const mutes=[];input.on('mute',e=>mutes.push(e));
 await wait(60);assert.equal(reads,0,'no key states are read outside voice mode');
 await input.hotkey(5);chord={ctrl:true,shift:true,other:false};await wait(60);chord={ctrl:false,shift:false,other:false};await wait(60);
 assert.deepEqual(mutes,[{action:'toggle'}]);
 await input.hotkey(5);const after=reads;await wait(80);assert.equal(reads,after,'voice mode ended: no more reading');
 const off=new WindowsTextInput({api,accessibility,talkback:true,immediate:true,shortcuts:false,muteTap:false});t.after(()=>off.close());await off.ready;
 const before=reads;await off.hotkey(5);await wait(60);assert.equal(reads,before,'muteTap off: never read');
});

test('muted: the microphone gives silence, nothing interrupts or is sent, replies still play; unmuting listens again',async t=>{
 const {c,state,input}=voiceController(t);const heard=[];c.engine.audio=(id,pcm)=>heard.push(pcm.some(b=>b!==0));await c.ready();await startVoice(c,input);
 const loud=Buffer.alloc(640);for(let i=0;i<320;i++)loud.writeInt16LE(Math.round(8000*Math.sin(i/3)),i*2);
 state.onData(loud);assert.equal(heard.at(-1),true,'unmuted: the voice reaches the recogniser');
 // Halfway through a sentence (a 24 s piece already heard), the user mutes.
 state.emit(turn('first part of a sentence',0,0.01,'length-limit'));
 for(let i=0;i<50;i++)state.onData(loud);
 input.emit('mute',{action:'toggle'});await wait(5);assert.equal(c.status().voice.muted,true);assert.equal(c.badgeState().name,'voice-muted');assert.ok(state.cues.includes('stop'),'a falling tone');
 state.onData(loud);assert.equal(heard.at(-1),false,'muted: silence reaches the recogniser');
 c.lastSpeech={state:'playing'};assert.equal(c.badgeState().name,'voice-speaking-muted');const before=state.stopPlayback;
 state.emit({type:'activity',timing:{start:1,end:2}});assert.equal(state.stopPlayback,before,'nothing interrupts while muted');
 state.emit(turn('the rest that was cut off',0.01,1.2));await wait(10);
 assert.equal(state.inserts.length,0,'speech overlapping the mute is not sent, nor the earlier piece');
 for(let i=0;i<100;i++)state.onData(loud);
 input.emit('mute',{action:'toggle'});await wait(5);assert.equal(c.status().voice.muted,false);assert.ok(state.cues.includes('start'),'a rising tone');
 state.onData(loud);assert.equal(heard.at(-1),true,'unmuted again');
 const now=c.capture.samples/16000;state.emit(turn('send this one',now+0.1,now+1));await wait(10);
 assert.deepEqual(state.inserts.map(i=>i.text),['send this one'],'speech after unmuting is sent');
});

test('a turn left unsent because voice mode ended during its paste shows no "not sent" notice; other unsent turns still do',async t=>{
 // The input reports voice_ended when the voice key was pressed while the turn was being pasted: the words stay in the
 // box on purpose, so there is nothing to warn about (even before the controller has marked voice mode as ending).
 const ended=voiceController(t,{insertResult:{status:'inserted',submitted:false,reason:'voice_ended',clipboardRestored:true}});
 await ended.c.ready();await startVoice(ended.c,ended.input);
 ended.state.emit(turn('last words'));await wait(10);
 assert.equal(ended.state.inserts.length,1,'pasted');assert.deepEqual(ended.state.notices,[],'no notice');assert.equal(ended.c.badgeState().name,'pasted');
 // Enter refused while voice mode is still on: the user is told once.
 const refused=voiceController(t,{insertResult:{status:'inserted',submitted:false,reason:'enter_refused',clipboardRestored:true}});
 await refused.c.ready();await startVoice(refused.c,refused.input);
 refused.state.emit(turn('one'));await wait(10);refused.state.emit(turn('two',3,4));await wait(10);
 assert.equal(refused.state.notices.filter(n=>/did not send them/.test(n)).length,1,'told once that it was not sent');
});
