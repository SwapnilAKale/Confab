'use strict';
// First sentence of a failure, at most 70 characters, for the badge.
function shortReason(message){const text=String(message||'').trim().replace(/\s+/g,' ');const first=(/^.+?[.!?](?=\s|$)/.exec(text)?.[0]||text).replace(/[.:]$/,'');return first.length>70?first.slice(0,69).trimEnd()+'…':first;}
const crypto=require('node:crypto');
const {spokenReply,speechUnits}=require('./reply-text.cjs'),{inferDateOrder}=require('./spoken-normalizer.cjs'),{normalize:normalizeText}=require('./talkback.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const MAX_RECORDING_MS=10*60*1000;
// Voice mode: hands-free turns. The microphone stays open; each turn the speech detector ends (1.2 s of silence in
// voice mode, VOICE_SETTLE in turn-settings.cjs; dictation waits 2.2 s) is
// pasted into the box where voice mode started and sent with Enter as a talk-back turn, so the agent's reply is read
// aloud; speaking while a reply plays stops it (barge-in).
// - VOICE_IDLE_MS: voice mode ends by itself after this long without speech, so a forgotten one cannot keep the
//   microphone open.
// - Barge-in: a reply stops only when the speech detector hears speech AND the microphone's loudness says it is the
//   user: about 0.24 s within 0.6 s of pitched frames (a cough or click has no pitch) louder than the room's background and the echo of
//   Confab's own playback (self-echo.cjs: Confab knows what it plays, learns how its speakers' sound comes back into the
//   microphone, and does not take that for the user). The detector's own timings cannot decide this: its first report
//   already includes 0.75 s of pre-speech audio, and it keeps reporting speech for 0.5 s after any sound ends.
// - ECHO_WINDOW_MS / ECHO_SHARE: a turn heard while a reply played (or this soon after it) whose words are mostly
//   the reply's own words is the speakers' echo, not the user, and is dropped instead of being sent back. A turn of
//   one or two words counts as echo only while the reply is still playing and only if the reply contains it, so a
//   short answer such as "yes" after a question is still sent.
// - VOICE_FIRST_UNIT: in voice mode a reply's first piece is at most this many characters (50 otherwise), so its
//   first words are synthesized and heard sooner. Exceptions: a first word longer than this is spoken on its own, and
//   a first piece with no word break at all stays whole (see voiceUnits).
// - BARGE_IN_LEAD_MS: an interruption is detected about this long after the user starts talking (self-echo.cjs needs
//   0.24 s of their voice, usually found within 0.4-0.5 s), so words that began earlier were heard before the user.
// - Resume: talking over a reply stops it at once. When that speech turns out to be nothing (its turn is empty, or is
//   only the reply's echo) and the user is quiet, the reply goes on from the start of the sentence it was reading. If
//   no turn comes back at all, it goes on after RESUME_QUIET_MS without speech. Anything pasted keeps it stopped.
//   RESUME_ACTIVE_MS: speech reported this recently means the user is still talking, so it waits.
const VOICE_IDLE_MS=10*60*1000,ECHO_WINDOW_MS=3000,ECHO_SHARE=0.7,VOICE_FIRST_UNIT=30,BARGE_IN_LEAD_MS=400,RESUME_QUIET_MS=2500,RESUME_ACTIVE_MS=600;
const {SelfEcho,VoiceMeter}=require('./self-echo.cjs');
// Generic native dictation. No agent-specific dependency.
class PcController {
 // onTalkback(text): talk-back dictation produced this draft. onDisarm(): cancel the pending talk-back; returns whether one was pending.
 // spoken: how much of a reply is read aloud ({sentences, chars}; 0 and 0 = the full reply).
 // maxRecordingMs: a dictation still recording after this long stops with the limit cue and is pasted as usual,
 // so a forgotten recording cannot keep the microphone open.
 constructor({engine,audio,input,notify,saveDraft,clearDraft,autoSend=false,lazy=false,onTalkback=()=>{},onDisarm=()=>false,spoken={sentences:0,chars:0},maxRecordingMs=MAX_RECORDING_MS,voiceIdleMs=VOICE_IDLE_MS,bargeIn=true,clock=Date.now}){
  // bargeIn: speaking stops a reply in voice mode (settings voiceInterrupt). Off, only the keys stop it.
  Object.assign(this,{engine,audio,input,notify,saveDraft,clearDraft,autoSend,lazy,onTalkback,onDisarm,spoken,maxRecordingMs,voiceIdleMs,bargeIn});this.readAloud=true;this.pendingReplies=0;this.replies=[];
  // clock: time for the voice-mode loudness and self-echo timeline (tests use a simulated one).
  this.clock=clock;this.selfEcho=new SelfEcho({clock});this.state='loading';this.metrics={captures:0,frames:0,transcripts:0,insertions:0,fallbacks:0,replies:0,suppressed:0,played:0,voiceTurns:0,voiceSent:0,interruptions:0,echoDropped:0};this.speech=Promise.resolve();this.actions=Promise.resolve();this.generation=0;
  input.on('capture',e=>{this.actions=this.actions.then(()=>e.action==='start'?this.startCapture({talkback:e.talkback===true}):this.endCapture()).catch(e=>this.failCapture(e));});
  input.on('mute',()=>this.toggleMute());
  input.on('voice',e=>{this.actions=this.actions.then(()=>e.action==='start'?this.startVoice():this.stopVoice()).catch(e=>this.failCapture(e));});
  // Background checks of the focused box during a recording are resolved at paste time.
  input.on('arm',e=>{if(e.background)return;if(e.result.status==='armed'){if(!e.acknowledged)void this.cue('tick');}else this.rejectPress('Click an editable input box first. '+(e.result.reason||''));});
  input.on('press',e=>{if(e.action==='arm')void this.cue('tick');else if(e.ignored==='insertion_busy')this.rejectPress('Still pasting the previous dictation. Try again in a moment.');
   else if(e.ignored==='voice_active')this.rejectPress('Voice mode is on. Press '+this.voiceKey()+' to end it, or just speak.');
   else if(e.ignored==='recording')this.rejectPress('Finish the dictation first, then start voice mode.');});
  input.on('disarmed',e=>this.disarm(e));
  // Focus left (or returned to) the box where dictation started; recording continues either way.
  input.on('focus',e=>{const c=this.capture;if(c&&this.state==='recording'){c.focusMoved=!e.inTarget;this.refreshBadge();}});
  engine.on?.('state',()=>this.refreshBadge());
  input.on('error',()=>this.failure('Dictation input failed. Quit and reopen Confab from Windows Startup.'));
  input.on('hotkeys',e=>{if(e.missing?.length)this.shortcutConflict(e.missing);else if(e.restored?.length)this.failure('Confab shortcut available again: '+e.restored.join(', ')+'.');});
  audio.on('error',e=>this.failCapture(e));
 }
 async ready(){return this.readying||(this.readying=this.start());}
 async start(){const started=await this.input.ready;if(started.failed)throw Object.assign(Error('Windows dictation input unavailable'),{code:started.conflicts?.length?'shortcut_conflict':'native_input_failed'});if(started.conflicts?.length)this.shortcutConflict(started.conflicts);if(!this.lazy){await this.audio.probe();try{await this.engine.warmup();}catch(error){throw Object.assign(error,{code:'native_models_failed'});}}if(!this.closed)this.state='ready';}
 // Disarm: stop playback, clear queued replies, discard any recording (nothing is pasted) and cancel
 // the pending talk-back. The disarm cue plays when a recording or talk-back was cancelled;
 // otherwise a soft tick acknowledges the press.
 disarm(){const cancelled=!!this.capture;this.actions=this.actions.then(()=>this.cancelCapture({discard:true})).catch(e=>this.failCapture(e));this.cancelSpeech();let pending=false;try{pending=this.onDisarm()===true;}catch{}void this.cue(pending||cancelled?'disarmCue':'tick');this.flash=null;this.refreshBadge();return pending;}
 // Every press gets audible feedback; a press that cannot be carried out also flashes the badge.
 cue(name,...args){try{return Promise.resolve(this.audio[name]?.(...args)).catch(()=>{});}catch{return Promise.resolve();}}
 // The badge shows the reason's first sentence; the notification carries the whole message.
 rejectPress(message){this.failure(message);void this.cue('errorCue');this.flashBadge('failed',4000,shortReason(message));}
 // Badge: Starting (until the microphone is live) -> Dictating/Talk-back, or Focus moved while focus is
 // away from the target box -> Transcribing (with a note while models still load) -> brief Pasted /
 // Not pasted / Failed; Speaking during reply playback; hidden otherwise. Model loading is never
 // shown during recording because the audio is buffered.
 badgeState(){const c=this.capture,loading=this.lazy&&this.engine.state!=='loaded';
  if(c?.voice){if(!c.live)return {name:'starting'};if(c.ending)return {name:loading?'transcribing-loading':'transcribing'};if(c.focusMoved)return {name:'voice-focus-moved'};
   if(this.flash)return {name:this.flash,...(this.flashReason?{reason:this.flashReason}:{})};
   if(this.lastSpeech?.state==='playing')return {name:c.muted?'voice-speaking-muted':this.voiceBargeIn()?'voice-speaking':'voice-speaking-keys'};
   if(['queued','synthesizing'].includes(this.lastSpeech?.state))return {name:'preparing'};
   return {name:c.muted?'voice-muted':'voice'};}
  if(c&&this.state==='recording'){if(!c.live)return {name:'starting'};if(c.focusMoved)return {name:'focus-moved'};return {name:c.talkback?'recording-talkback':'recording'};}
  if(c&&this.state==='transcribing')return {name:loading?'transcribing-loading':'transcribing'};
  if(this.flash)return {name:this.flash,...(this.flashReason?{reason:this.flashReason}:{})};
  if(this.lastSpeech?.state==='playing')return {name:'speaking'};
  if(['queued','synthesizing'].includes(this.lastSpeech?.state))return {name:'preparing'};
  return {name:'idle'};}
 refreshBadge(){const state=this.badgeState(),key=JSON.stringify(state);if(key===this.badgeKey)return;this.badgeKey=key;try{this.notify.badge?.(state);}catch{}}
 flashBadge(name,ms,reason=null){clearTimeout(this.flashTimer);this.flash=name;this.flashReason=reason;this.refreshBadge();this.flashTimer=setTimeout(()=>{this.flash=null;this.flashReason=null;this.refreshBadge();},ms);this.flashTimer.unref?.();}
 // Another process holds these global shortcuts.
 shortcutConflict(labels){this.failure('Confab could not register '+labels.join(', ')+': another program is using '+(labels.length>1?'them':'it')+', for example another dictation tool. Confab takes '+(labels.length>1?'them':'it')+' back automatically when free.');}
 failure(message){this.lastError=message;this.notificationAccepted=this.notify.failure(message);}
 // The voice key's label for messages, from the input's hotkeys.
 voiceKey(){return this.input.hotkeys?.voice?.label||'the voice mode key';}
 cancelSpeech(){this.selfEcho.stop();if(this.spokenEcho&&this.spokenEcho.endedAt===null)this.spokenEcho.endedAt=Date.now();this.generation++;if(this.lastSpeech&&['queued','synthesizing','playing'].includes(this.lastSpeech.state))this.lastSpeech={state:'cancelled',reason:'new_input_or_stop'};this.audio.stopPlayback();this.refreshBadge();}
 async startCapture({talkback=false}={}){
  // A press during startup waits for it instead of being dropped.
  if(this.state==='loading'&&this.readying)await this.readying.catch(()=>{});
  if(this.closed||this.paused){await this.input.request('capture-reset');return;}
  if(this.state!=='ready'){await this.input.request('capture-reset');this.rejectPress(this.state==='transcribing'?'Still transcribing the previous dictation. Try again in a moment.':'Confab is busy. Try again in a moment.');return;}
  this.cancelSpeech();const capture=this.capture={id:crypto.randomUUID(),parts:[],samples:0,peak:0,sumSquares:0,talkback,pressedAt:Date.now()};this.state='recording';this.metrics.captures++;this.flash=null;this.refreshBadge();
  // The badge shows Starting at once. The microphone opens now; the recording colour and the start
  // cue come together when capture is really live. Audio is buffered while models load and the
  // focused box is checked in the background.
  try{
   await this.engine.start(capture.id,e=>this.receive(capture,e));
   if(this.closed||this.capture!==capture)return;
   // Resolves once the microphone records (the threaded audio opens it off the main thread).
   await this.audio.start(pcm=>{if(this.capture!==capture)return;this.metrics.frames++;for(let i=0;i+1<pcm.length;i+=2){const sample=pcm.readInt16LE(i)/32768;capture.samples++;capture.peak=Math.max(capture.peak,Math.abs(sample));capture.sumSquares+=sample*sample;}this.engine.audio(capture.id,pcm);});
   if(this.closed||this.capture!==capture)return;
   capture.live=true;void this.cue('cue',true);this.refreshBadge();this.lastMicStartMs=Date.now()-capture.pressedAt;
  }catch(error){
   if(this.capture!==capture)return;this.capture=null;this.state='ready';try{this.engine.cancel(capture.id);}catch{}await this.input.request('capture-reset');
   this.rejectPress('Microphone unavailable, so nothing was recorded: '+(error.message||'it could not be opened')+' Check that a microphone is connected, enabled and allowed for desktop apps.');return;
  }
  capture.limit=setTimeout(()=>{this.actions=this.actions.then(()=>this.endCapture({limit:true})).catch(e=>this.failCapture(e));},this.maxRecordingMs);
 }
 // Voice mode starts: the input has already checked the focused box (the target for every turn). One long capture
 // on the echo-cancelled microphone stream; turns arrive from the speech detector as 'final' events.
 async startVoice(){
  if(this.state==='loading'&&this.readying)await this.readying.catch(()=>{});
  if(this.closed||this.paused){await this.input.request('voice-reset');return;}
  if(this.state!=='ready'){await this.input.request('voice-reset');this.rejectPress(this.state==='transcribing'?'Still transcribing the previous dictation. Try again in a moment.':'Confab is busy. Try again in a moment.');return;}
  this.cancelSpeech();const capture=this.capture={id:crypto.randomUUID(),parts:[],samples:0,peak:0,sumSquares:0,talkback:true,voice:true,pressedAt:Date.now(),turns:Promise.resolve(),meter:new VoiceMeter({selfEcho:this.selfEcho})};this.state='recording';this.metrics.captures++;this.flash=null;this.refreshBadge();
  try{
   await this.engine.start(capture.id,e=>this.receiveVoice(capture,e),{voice:true});
   if(this.closed||this.capture!==capture)return;
   const mode=await this.audio.start(pcm=>{if(this.capture!==capture)return;this.metrics.frames++;if(capture.muted)pcm=Buffer.alloc(pcm.length);for(let i=0;i+1<pcm.length;i+=2){const sample=pcm.readInt16LE(i)/32768;capture.samples++;capture.peak=Math.max(capture.peak,Math.abs(sample));capture.sumSquares+=sample*sample;}capture.meter.push(pcm,this.clock());this.engine.audio(capture.id,pcm);},{communications:true});
   if(this.closed||this.capture!==capture)return;
   capture.live=true;capture.liveAt=Date.now();capture.echoCancel=(mode?.communications??this.audio.captureMode?.communications)===true;this.lastVoice={echoCancel:capture.echoCancel,startedAt:capture.liveAt};
   void this.cue('cue',true);this.refreshBadge();this.lastMicStartMs=Date.now()-capture.pressedAt;
  }catch(error){
   if(this.capture!==capture)return;this.capture=null;this.state='ready';try{this.engine.cancel(capture.id);}catch{}await this.input.request('voice-reset');
   this.rejectPress('Microphone unavailable, so voice mode did not start: '+(error.message||'it could not be opened')+' Check that a microphone is connected, enabled and allowed for desktop apps.');return;
  }
  this.voiceIdle(capture);
 }
 // Voice mode's mute (a Ctrl+Shift tap, or the tray): the microphone's audio becomes silence until unmuted, so nothing
 // said meanwhile interrupts a reply or is sent; a turn being spoken when muting is dropped; replies are still read.
 // Mute periods are kept in capture audio time (seconds) so turns that overlap one can be recognised.
 toggleMute(){const c=this.capture;if(!c?.voice||c.ending||!c.live){void this.cue('tick');return false;}
  const now=c.samples/16000;c.muted=!c.muted;c.muteSpans=c.muteSpans||[];
  if(c.muted){c.muteSpans.push({from:now,to:null});c.parts=[];}else{const open=c.muteSpans.at(-1);if(open&&open.to===null)open.to=now;}
  void Promise.resolve().then(()=>c.muted?this.audio.cue(false):this.audio.cue(true)).catch(()=>{});this.refreshBadge();return c.muted;}
 // Whether a turn's audio overlaps a muted period (or the microphone is muted now).
 duringMute(capture,timing){if(capture.muted)return true;if(!capture.muteSpans?.length||!timing)return false;
  const start=Number.isFinite(timing.start)?timing.start:0,end=Number.isFinite(timing.end)?timing.end:start;
  return capture.muteSpans.some(m=>start<(m.to??Infinity)&&end>m.from);}
 // (Re)starts the silence timer that ends a forgotten voice mode.
 voiceIdle(capture){clearTimeout(capture.limit);capture.limit=setTimeout(()=>{this.actions=this.actions.then(()=>this.stopVoice({idle:true})).catch(e=>this.failCapture(e));},this.voiceIdleMs);capture.limit.unref?.();}
 // Voice mode ends (the voice key, or idle): the microphone closes, speech already heard is pasted but not sent, and voice
 // mode is over once the detector has finished. Cancel (disarm) discards instead, through cancelCapture.
 async stopVoice({idle=false}={}){const capture=this.capture;if(!capture?.voice||capture.ending)return;
  // Ending voice mode also ends the conversation: the reply being read stops, and the reply still awaited is not read.
  clearTimeout(capture.limit);capture.ending=true;this.endedAt=Date.now();this.dropResume(capture);this.cancelSpeech();try{this.onDisarm();}catch{}this.refreshBadge();await Promise.resolve(this.audio.stop()).catch(()=>{});
  this.engine.end(capture.id);void Promise.resolve().then(()=>idle?this.audio.limitCue():this.audio.cue(false)).catch(()=>{});
  if(idle)this.failure('Voice mode stopped after '+Math.round(this.voiceIdleMs/60000)+' minutes without speech. Press '+this.voiceKey()+' to start it again.');
  capture.deadline=setTimeout(()=>this.endVoice(capture),this.lazy?180000:90000);capture.deadline.unref?.();
 }
 // Voice mode is over: the last turn has been handled (or the detector timed out).
 async endVoice(capture){if(this.capture!==capture)return;clearTimeout(capture.deadline);clearTimeout(capture.limit);await capture.turns.catch(()=>{});if(this.capture!==capture)return;
  this.capture=null;this.state='ready';this.lastCapture={samples:capture.samples,peak:capture.peak,rms:capture.samples?Math.sqrt(capture.sumSquares/capture.samples):0,recognized:capture.heard===true};
  await this.input.request('voice-reset');this.refreshBadge();}
 // Speaking stops a reply unless the voiceInterrupt setting is off. Windows' echo cancellation is not required: the
 // self-echo check tells the user from Confab's own reply.
 voiceBargeIn(){return this.bargeIn!==false;}
 receiveVoice(capture,event){if(this.capture!==capture||this.closed)return;
  if(event.type==='activity'){if(capture.muted)return;
   if(capture.resume){capture.resume.lastActivity=Date.now();this.resumeLater(capture);}
   // Speech is going on. While a reply is being read or prepared, it stops the reply when the microphone's loudness
   // says it is the user, not the reply's own echo (VoiceMeter, SelfEcho).
   if(!capture.ending)this.voiceIdle(capture);
   if(this.voiceBargeIn()&&['queued','synthesizing','playing'].includes(this.lastSpeech?.state)&&capture.meter.voiced()){this.metrics.interruptions++;this.lastVoice={...this.lastVoice,interruptedAt:Date.now(),selfEcho:this.selfEcho.status()};capture.interruptions=[...(capture.interruptions||[]).slice(-4),{at:Date.now(),spoken:this.spokenEcho}];
    // Where the reply was when the user started talking, so it can go on if they said nothing.
    const replies=this.resumePoint(Date.now()-BARGE_IN_LEAD_MS);this.cancelSpeech();
    if(replies.length){capture.resume={replies,generation:this.generation,lastActivity:Date.now(),timer:null};this.resumeLater(capture);}}
   return;
  }
  if(event.type==='final'){
   // Speech from while the microphone was muted, or cut off by muting, is never sent.
   if(this.duringMute(capture,event.timing)){capture.parts=[];this.metrics.mutedDropped=(this.metrics.mutedDropped||0)+1;this.turnHeard(capture,false);return;}
   if(typeof event.text==='string'&&event.text.trim())capture.parts.push({text:event.text.trim(),timing:event.timing,words:wordStarts(event.recognizerResult,event.timing)});
   // A turn longer than the detector's 24 s window arrives in pieces; only its real end sends it.
   if(event.timing?.reason==='length-limit')return;
   const parts=capture.parts.splice(0);if(!parts.length){this.turnHeard(capture,false);return;}
   const text=parts.map(p=>p.text).join(' '),start=parts[0].timing?.start,end=parts[parts.length-1].timing?.end,words=parts.every(p=>p.words)?parts.flatMap(p=>p.words):null;
   capture.turns=capture.turns.then(()=>this.voiceTurn(capture,text,{start,end,words})).catch(e=>this.failure('Voice turn failed: '+(e.message||'unknown error')));
   return;
  }
  if(event.type==='capture-done'){void capture.turns.then(()=>this.endVoice(capture));return;}
  if(event.type==='error'){this.failCapture(Error(event.message||'Speech recognition failed.'));}
 }
 // What is left to read of the replies an interruption stopped: the one being read, from the start of the sentence
 // heard at `heardAt` (when the user started talking), and any waiting after it, whole. A reply not yet playing is
 // read again from its start.
 resumePoint(heardAt){const out=[];
  for(const [k,e] of this.replies.filter(e=>e.generation===this.generation).entries()){let text=e.text;
   if(k===0&&e.units&&e.marks.length&&e.marks[0].at!==null){const joined=e.units.join(' ');let offset=0,pos=0;
    for(const m of e.marks){const len=e.units[m.index].length;if(m.at!==null&&m.at<=heardAt)pos=offset+Math.min(len,Math.floor(len*(heardAt-m.at)/Math.max(1,m.sec*1000)));offset+=len+1;}
    let from=0;for(const m of joined.matchAll(/[.!?]["'”)\]]*\s+/g)){if(m.index<pos)from=m.index+m[0].length;else break;}
    text=joined.slice(from).trim();}
   if(text)out.push({text,raw:e.raw});}
  return out;}
 // (Re)starts the wait after which a stopped reply goes on when no turn came back (RESUME_QUIET_MS).
 resumeLater(capture){const r=capture.resume;clearTimeout(r.timer);r.timer=setTimeout(()=>this.resumeReply(capture),RESUME_QUIET_MS);r.timer.unref?.();}
 // A turn ended: `said` when it is being pasted. Something said keeps a stopped reply stopped (and stops one that went
 // on meanwhile); nothing said lets it go on, once the user is quiet.
 turnHeard(capture,said){const r=capture.resume;
  if(said){if(r){clearTimeout(r.timer);capture.resume=null;}
   if(capture.resumed===this.generation&&['queued','synthesizing','playing'].includes(this.lastSpeech?.state))this.cancelSpeech();capture.resumed=null;return;}
  if(r&&Date.now()-r.lastActivity>=RESUME_ACTIVE_MS)this.resumeReply(capture);}
 resumeReply(capture){const r=capture.resume;if(!r)return;clearTimeout(r.timer);capture.resume=null;
  if(this.capture!==capture||capture.ending||this.closed||r.generation!==this.generation)return;
  let any=false;for(const e of r.replies)any=this.reply(e.text,{resume:true,raw:e.raw})||any;
  if(any){this.metrics.resumed=(this.metrics.resumed||0)+1;capture.resumed=this.generation;this.lastVoice={...this.lastVoice,resumedAt:Date.now()};}}
 dropResume(capture){if(capture.resume){clearTimeout(capture.resume.timer);capture.resume=null;}capture.resumed=null;}
 // The interruption that happened while this turn was being spoken, if any (from 1 s before it began to its end).
 bargeInDuring(capture,timing){if(!capture.interruptions?.length||!capture.liveAt||!Number.isFinite(timing?.start))return null;
  const start=capture.liveAt+timing.start*1000,end=capture.liveAt+(Number.isFinite(timing.end)?timing.end:timing.start)*1000;
  return capture.interruptions.find(i=>i.at>=start-1000&&i.at<=end+1500)||null;}
 // How many of a turn's first words were heard before the user started talking over the reply: the words that began
 // more than BARGE_IN_LEAD_MS before the interruption at `at` (the interruption comes that long after the user starts).
 // Only those may be the reply's echo; later words are the user's, even if the reply said them too ("run the tests"
 // in answer to "shall I run the tests"). Uses the recogniser's word times; without them, the share of the turn's
 // duration before that moment, plus one word. 0 when the turn started after it.
 echoWordsBefore(capture,timing,at,text){const cutoff=at-BARGE_IN_LEAD_MS;
  if(Array.isArray(timing.words)&&timing.words.length){let n=0;for(const t of timing.words){if(capture.liveAt+t*1000<cutoff)n++;else break;}return n;}
  const start=capture.liveAt+timing.start*1000,end=capture.liveAt+(Number.isFinite(timing.end)?timing.end:timing.start)*1000;
  if(cutoff<=start)return 0;const words=String(text).trim().split(/\s+/).filter(Boolean).length;return Math.min(words,Math.ceil(words*Math.min(1,(cutoff-start)/Math.max(1,end-start)))+1);}
 // Whether a heard turn is the speakers' echo of the reply being read (see ECHO_WINDOW_MS, ECHO_SHARE).
 isEcho(capture,text,timing){
  const spoken=this.spokenEcho;if(!spoken)return false;
  const at=capture.liveAt&&Number.isFinite(timing?.start)?capture.liveAt+timing.start*1000:Date.now();
  if(at<spoken.startedAt-500||at>(spoken.endedAt??Infinity)+ECHO_WINDOW_MS)return false;
  const phrase=normalizeText(text),words=phrase.split(' ').filter(Boolean);if(!words.length)return true;
  if(words.length<3)return spoken.endedAt===null&&(' '+spoken.text+' ').includes(' '+phrase+' ');
  const heard=words.filter(w=>spoken.words.has(w)).length;return heard/words.length>=ECHO_SHARE;
 }
 // One voice turn: dropped as echo, or recorded as the talk-back dictation, pasted into the voice box and sent.
 async voiceTurn(capture,text,timing){
  if(this.closed||this.capture!==capture)return;capture.heard=true;this.metrics.transcripts++;
  // A turn during which the user interrupted a reply is the user, even though it also heard the reply's tail: only
  // the reply's own words at its start are trimmed. Other turns heard during a reply may be its echo (isEcho).
  const barge=this.bargeInDuring(capture,timing);
  if(barge){const trimmed=trimEcho(text,barge.spoken,this.echoWordsBefore(capture,timing,barge.at,text));if(trimmed!==text)this.metrics.echoTrimmed=(this.metrics.echoTrimmed||0)+1;text=trimmed;if(!text){this.metrics.echoDropped++;this.turnHeard(capture,false);return;}}
  else if(this.isEcho(capture,text,timing)){this.metrics.echoDropped++;this.turnHeard(capture,false);return;}
  this.turnHeard(capture,true);
  // After voice mode was ended, speech already heard is only pasted (no Enter, no talk-back), as a dictation: the user
  // reviews it and sends it, or not (stopVoice).
  const final=capture.ending===true;this.metrics.voiceTurns++;if(!final){try{this.onTalkback(text);}catch{}}
  this.pendingDraft=text;try{this.saveDraft(text);}catch{}
  // The paste waits for any dictation key action in progress; voice-mode turns go one at a time.
  const result=await this.input.insert(text,!final);this.lastInsertion=result;
  // Cancelled while pasting: nothing more happens (Cancel cleared the target box, so Enter was not pressed after it).
  if(this.capture!==capture)return;
  if(result.status!=='inserted')this.lastRefusal={at:Date.now(),status:result.status,reason:result.reason||null,detail:result.detail||null,armedAtStart:true,armDetail:null};
  if(result.status==='inserted'){this.metrics.insertions++;this.clearDraft(text);this.pendingDraft=null;
   if(result.submitted){this.metrics.voiceSent++;void this.cue('tick');this.flashBadge('sent',1200);}
   else{this.flashBadge('pasted',1500);if(!final&&!capture.ending&&result.reason!=='voice_ended'&&!capture.unsentNoticed){capture.unsentNoticed=true;this.failure(result.reason==='box_unreadable'?'Voice mode pasted your words, but this box cannot be checked, so Confab does not press Enter here. Press Enter to send, or use the agent\'s app or chat panel.':'Voice mode pasted your words but did not send them: a key was held down or focus moved. Press Enter to send.');}}
   if(result.clipboardRestored===false)this.failure('Text was inserted, but the previous clipboard could not be restored. Check your clipboard.');}
  else await this.fallback(text,result.status==='uncertain'?'Voice mode could not confirm the paste, so nothing was sent.':['focus_changed','field_changed','not_editable','not_armed'].includes(result.reason)?'Not sent: focus was not in the box where voice mode started. Click back into it.':'Voice turn was not sent.');
  this.refreshBadge();
 }
 // limit: stopped by maxRecordingMs, not by a press; the limit cue replaces the stop cue.
 async endCapture({limit=false}={}){const capture=this.capture;if(!capture||capture.voice||this.state!=='recording')return;
  clearTimeout(capture.limit);this.state='transcribing';this.endedAt=Date.now();this.refreshBadge();await Promise.resolve(this.audio.stop()).catch(()=>{});await this.input.request('capture-reset');
  this.engine.end(capture.id);void Promise.resolve().then(()=>limit?this.audio.limitCue():this.audio.cue(false)).catch(()=>this.failure('Recording stopped, but the speaker cue failed. Check your speakers.'));
  capture.deadline=setTimeout(()=>this.failCapture(Error('Transcription timed out.')),this.lazy?180000:90000);
 }
 receive(capture,event){if(this.capture!==capture||this.closed)return;
  if(event.type==='final'&&typeof event.text==='string'&&event.text.trim())capture.parts.push(event.text.trim());
  else if(event.type==='capture-done')void this.finish(capture).catch(e=>this.failCapture(e));
  else if(event.type==='error')this.failCapture(Error(event.message||'Speech recognition failed.'));
 }
 async finish(capture){
  clearTimeout(capture.deadline);clearTimeout(capture.limit);const text=capture.parts.join(' ');this.metrics.transcripts++;this.lastCapture={samples:capture.samples,peak:capture.peak,rms:capture.samples?Math.sqrt(capture.sumSquares/capture.samples):0,recognized:!!text};
  // Talk-back drafts are recorded in memory for turn matching whether pasted or left on the clipboard.
  if(text&&capture.talkback){try{this.onTalkback(text);}catch{}}
  if(text){this.pendingDraft=text;try{this.saveDraft(text);}catch{}await delay(Math.max(0,800-(Date.now()-this.endedAt)));if(this.closed||this.capture!==capture)return;
   const result=await this.input.insert(text,this.autoSend);this.lastInsertion=result;
   // Why a dictation was not pasted (codes only): the refusal, the check that failed, and whether the box was
   // confirmed when recording started. Kept until the next refusal, so a later successful paste does not hide it.
   if(result.status!=='inserted')this.lastRefusal={at:Date.now(),status:result.status,reason:result.reason||null,detail:result.detail||null,armedAtStart:this.input.lastArm?this.input.lastArm.status==='armed':null,armDetail:this.input.lastArm&&this.input.lastArm.status!=='armed'?[this.input.lastArm.reason,this.input.lastArm.detail].filter(Boolean).join(': '):null};
   if(result.status==='inserted'){this.metrics.insertions++;this.clearDraft(text);this.pendingDraft=null;this.capture=null;this.state='ready';this.flashBadge('pasted',1500);if(result.clipboardRestored===false)this.failure('Text was inserted, but the previous clipboard could not be restored. Check your clipboard.');}
   else await this.fallback(text,result.status==='uncertain'?'Insertion could not be verified. Check the input box before pasting.':['focus_changed','field_changed','not_editable','not_armed'].includes(result.reason)?'Not pasted: focus was not in the box where you started dictating.':'Draft was not inserted.');
  }else{this.capture=null;this.state='ready';this.rejectPress(capture.peak===0?'The microphone returned silent audio. Check that it is unmuted and the correct default device is selected.':'No speech was recognized. Check your microphone and try again.');}
  if(this.capture===capture){this.capture=null;this.state='ready';}
  this.refreshBadge();
 }
 async fallback(text,prefix='Draft was not inserted.'){
  this.pendingDraft=text;let saved=false;try{this.saveDraft(text);saved=true;}catch{}this.metrics.fallbacks++;let copied=false;
  for(let i=0;i<5&&!copied;i++){try{this.input.api.setClipboard(text);copied=true;}catch{await delay(100);}}
  if(this.capture&&!this.capture.voice&&this.state==='transcribing'){this.capture=null;this.state='ready';}void this.cue('errorCue');this.flashBadge('not-pasted',3000);
  this.failure(prefix+(copied?' It is on the clipboard, ready to paste.':saved?' Clipboard is busy. Your draft is saved in your Confab profile drafts folder.':' Clipboard and draft storage both failed. Keep Confab running and check disk space.'));
 }
 failCapture(error){const capture=this.capture;this.capture=null;clearTimeout(capture?.limit);clearTimeout(capture?.deadline);
  try{Promise.resolve(this.audio.stop()).catch(()=>{});}catch{}if(capture)this.engine.cancel(capture.id);void this.input.request('capture-reset');if(capture?.voice)void this.input.request('voice-reset');if(!this.closed)this.state='ready';
  const partial=capture?.voice?capture.parts.map(p=>p.text):capture?.parts||[];
  if(partial.length)void this.fallback(partial.join(' '),capture.voice?'Voice mode stopped: '+(error.message||'recording failed')+' Your unsent words were saved.':'Recording failed; the partial draft was saved.');else if(!this.closed)this.rejectPress(error.message||'Recording failed. Check your microphone.');
 }
 // discard (Disarm): drop the audio and any partial text; otherwise a partial draft is kept.
 async cancelCapture({discard=false}={}){const capture=this.capture;this.capture=null;clearTimeout(capture?.limit);clearTimeout(capture?.deadline);try{await this.audio.stop();}catch{}this.refreshBadge();if(capture){this.engine.cancel(capture.id);const partial=capture.voice?capture.parts.map(p=>p.text):capture.parts;if(partial.length&&!discard)await this.fallback(partial.join(' '),'Recording cancelled; partial draft saved.');}if(!this.closed)this.state='ready';await this.input.request('capture-reset');if(capture?.voice)await this.input.request('voice-reset');}
 // resume: the rest of a reply an interruption stopped (resumeReply); its text is already prepared, `raw` is the reply.
 reply(text,{resume=false,raw:original}={}){const raw=resume&&typeof original==='string'?original:text;
  // A new reply replaces one stopped by an interruption.
  if(!resume){this.metrics.replies++;if(this.capture?.voice)this.dropResume(this.capture);}if(this.paused||!this.readAloud||this.pendingReplies>=100){this.lastSpeech={state:'suppressed',reason:this.paused?'paused':!this.readAloud?'disabled':'queue_full'};return false;}// Only the opening is spoken (this.spoken); a short closing says when the rest was left out on purpose.
  const prepared=resume?{ok:true,text}:spokenReply(text,this.spoken);if(!prepared.ok){this.metrics.suppressed++;this.lastSpeech={state:'suppressed',reason:prepared.reason,detail:prepared.detail};return false;}text=prepared.text;this.pendingReplies++;const generation=this.generation;this.lastSpeech={state:'queued'};const timing={receivedAt:Date.now(),chars:text.length};this.lastReply=timing;if(!resume)void this.cue('tick');
  // Where each piece of the reply starts playing (marks), so an interruption knows how far it got (resumePoint).
  const entry={generation,text,raw,units:null,marks:[]};this.replies.push(entry);this.refreshBadge();const mark=name=>{if(timing[name]===undefined)timing[name]=Date.now()-timing.receivedAt;};
  // A dictation in progress holds the reply until it ends; voice mode does not (the reply plays while it listens).
  const recording=()=>!!this.capture&&!this.capture.voice;
  this.speech=this.speech.then(async()=>{while(recording()&&!this.closed&&generation===this.generation)await delay(25);if(this.closed||generation!==this.generation||recording()){if(generation===this.generation)this.lastSpeech={state:'cancelled',reason:recording()?'recording_active':'stopped'};this.refreshBadge();return;}this.lastSpeech={state:'synthesizing'};
   // Voice mode's echo filter compares what the microphone hears with the words being read.
   const words=normalizeText(text),echo=this.spokenEcho={text:words,words:new Set(words.split(' ').filter(Boolean)),startedAt:Date.now(),endedAt:null};
   // Synthesize whole units (see speechUnits), join their audio, and play the reply through one
   // output stream. Playback starts after the first unit unless a later unit is predicted to leave a
   // pause of more than PAUSE_LIMIT_MS; then it waits for the next unit and checks again. Pauses can
   // only fall between units.
   // Numeric dates follow one convention per reply: inferred from the whole reply, else the dateOrder setting.
   const normalize={dateOrder:inferDateOrder(raw)||this.spoken.dateOrder||'dmy'};
   const live=()=>!this.closed&&generation===this.generation,units=this.capture?.voice?voiceUnits(text):speechUnits(text),started=Date.now();mark('synthesisStartMs');timing.units=units.length;entry.units=units;
   let stream=null,playback=Promise.resolve(),buffered=[],bufferedSec=0,playing=false,doneChars=0,doneSec=0;
   const emit=wav=>{if(isPcm16(wav))this.selfEcho.play(wav.subarray(44),wav.readUInt32LE(24));if(stream)stream.write(wav.subarray(44));else{playback=playback.then(()=>live()&&this.audio.playWav(wav));playback.catch(()=>{});}};
   let audioRunsOutAt=0;timing.maxPauseMs=0;
   const begin=()=>{playing=true;mark('playbackStartMs');this.selfEcho.startReply();const now=Date.now();audioRunsOutAt=now+bufferedSec*1000;for(const m of entry.marks)if(m.at===null)m.at=now+m.offset*1000;this.lastSpeech={state:'playing'};this.refreshBadge();const rate=buffered.find(isPcm16)?.readUInt32LE(24);if(this.audio.stream&&rate&&buffered.every(w=>isPcm16(w)&&w.readUInt32LE(24)===rate))stream=this.audio.stream(rate);for(const wav of buffered)emit(wav);buffered=[];};
   let doneUnits=0;
   for(const [index,unit] of units.entries()){
    if(!live())break;const parts=[];const rest=await this.engine.synthesize(unit,{onChunk:w=>parts.push(w),isCancelled:()=>!live(),partLimit:160,normalize});if(!live())break;
    mark('firstUnitMs');
    if(playing){timing.maxPauseMs=Math.max(timing.maxPauseMs,Date.now()-audioRunsOutAt);audioRunsOutAt=Math.max(audioRunsOutAt,Date.now());}
    const wavs=joinWavs([...parts,...(rest||[])]);entry.marks.push({index,sec:wavs.reduce((n,w)=>n+wavSeconds(w),0),at:playing?audioRunsOutAt:null,offset:playing?null:bufferedSec});
    for(const wav of wavs){const sec=wavSeconds(wav);doneSec+=sec;if(playing){emit(wav);audioRunsOutAt+=sec*1000;}else{buffered.push(wav);bufferedSec+=sec;}}
    doneChars+=unit.length;doneUnits++;
    if(!playing&&doneSec>0&&!pauseExpected(units.slice(index+1),Date.now()-started,doneUnits,doneChars,doneSec,bufferedSec))begin();
   }
   if(live()&&!playing&&buffered.length)begin();
   timing.synthesisMs=Date.now()-started;timing.audioMs=Math.round(doneSec*1000);timing.realTimeFactor=doneSec?Math.round(timing.synthesisMs/1000/doneSec*100)/100:null;
   if(stream)await stream.end();await playback;mark('finishedMs');echo.endedAt=Date.now();if(generation===this.generation){this.metrics.played++;this.lastSpeech={state:'completed'};}
  }).catch(()=>{if(!this.closed){this.lastSpeech={state:'failed',stage:this.lastSpeech?.state};this.failure('Reply read-aloud failed. Check your speakers and speech models.');}}).finally(()=>{this.replies=this.replies.filter(e=>e!==entry);if(this.spokenEcho&&this.spokenEcho.endedAt===null)this.spokenEcho.endedAt=Date.now();this.pendingReplies--;this.refreshBadge();});return true;
 }
 status(){return {badgeState:this.badgeState().name,lastMicStartMs:this.lastMicStartMs,lastReply:this.lastReply,state:this.state,metrics:{...this.metrics},lastInsertion:this.lastInsertion,lastRefusal:this.lastRefusal||null,lastCapture:this.lastCapture,lastSpeech:this.lastSpeech,voice:this.capture?.voice?{on:true,muted:this.capture.muted===true,echoCancel:this.capture.echoCancel===true,interrupt:this.voiceBargeIn(),resumePending:!!this.capture.resume,selfEcho:this.selfEcho.status()}:{on:false},lastVoice:this.lastVoice||null,lastError:this.lastError,notificationAccepted:this.notificationAccepted};}
 async setPaused(paused){this.paused=paused;this.cancelSpeech();if(paused)await this.cancelCapture();if(this.input.setPaused?.(paused)===false){this.paused=true;this.failure('Dictation shortcut is in use. Close the other dictation instance before resuming.');return false;}return true;}
 setReadAloud(enabled){this.readAloud=enabled;if(!enabled)this.cancelSpeech();}
 async close(){if(this.closed)return;this.closed=true;this.state='stopping';clearTimeout(this.flashTimer);this.flash=null;this.cancelSpeech();try{await this.cancelCapture();}finally{try{this.input.close();}finally{try{this.engine.close();}finally{try{await this.audio.close();}finally{await this.notify.close();}}}}}
}
// Predicts whether starting playback now would leave a pause over PAUSE_LIMIT_MS before any upcoming
// unit, from the synthesis speed so far (a fixed cost per unit plus a cost per character).
const PAUSE_LIMIT_MS=1000,UNIT_OVERHEAD_MS=250;
function pauseExpected(upcoming,elapsedMs,doneUnits,doneChars,doneSec,bufferedSec){
 const msPerChar=Math.max(15,(elapsedMs-doneUnits*UNIT_OVERHEAD_MS)/doneChars),audioMsPerChar=doneSec*1000/doneChars;
 let ready=0,needed=bufferedSec*1000;
 for(const unit of upcoming){ready+=UNIT_OVERHEAD_MS+unit.length*msPerChar;if(ready-needed>PAUSE_LIMIT_MS)return true;needed=Math.max(needed,ready)+unit.length*audioMsPerChar;}
 return false;
}
// Start time (seconds into the capture) of each word of a recognised segment, from the recogniser's token times
// (seconds into the segment; a token starting with a space starts a word), or null when they are missing.
function wordStarts(result,timing){const tokens=result?.tokens,times=result?.timestamps;if(!Array.isArray(tokens)||!Array.isArray(times)||tokens.length!==times.length||!Number.isFinite(timing?.start))return null;
 const out=[];for(let i=0;i<tokens.length;i++)if(typeof tokens[i]==='string'&&Number.isFinite(times[i])&&(!out.length||/^\s/.test(tokens[i])))out.push(timing.start+times[i]);return out;}
// Voice mode's speech units: as speechUnits with a first piece of at most VOICE_FIRST_UNIT characters. speechUnits cuts
// at a natural pause (a comma, a clause word) within the limit; when there is none, it takes the first natural pause
// further on (within 91 characters), or else the whole first sentence. A first piece still longer than the limit is cut
// here at its last word break within the limit, so the reply is heard sooner, even when that break comes after a single
// short word ("I antidisestablishmentarianistically ..." starts with "I"). A first word longer than the limit is spoken
// on its own; only a first piece with no word break at all stays whole.
function voiceUnits(text){const units=speechUnits(text,160,{first:VOICE_FIRST_UNIT}),head=units[0];
 if(!head||head.length<=VOICE_FIRST_UNIT)return units;
 // Any whitespace is a word break (a space, a tab, a line break, several of them); the pieces are trimmed.
 const gaps=[...head.matchAll(/\s+/g)].filter(m=>m.index>0),gap=gaps.filter(m=>m.index<=VOICE_FIRST_UNIT).pop()||gaps[0];if(!gap)return units;
 return [head.slice(0,gap.index).trim(),head.slice(gap.index+gap[0].length).trim(),...units.slice(1)].filter(Boolean);}
// Drops from the start of a heard turn the longest run of two or more words (at most `limit`) that the reply also
// said, in that order: the reply's tail heard before the user's own words. Returns the rest ('' when it was all the
// reply's words).
function trimEcho(text,spoken,limit=Infinity){if(!spoken?.text)return text;const tokens=String(text).trim().split(/\s+/).filter(Boolean),reply=' '+spoken.text+' ';
 let cut=0;for(let k=Math.min(tokens.length,limit);k>=2;k--){const phrase=normalizeText(tokens.slice(0,k).join(' '));if(phrase&&reply.includes(' '+phrase+' ')){cut=k;break;}}
 return tokens.slice(cut).join(' ');}
function isPcm16(wav){return Buffer.isBuffer(wav)&&wav.length>=44&&wav.toString('ascii',0,4)==='RIFF'&&wav.readUInt16LE(20)===1&&wav.readUInt16LE(22)===1&&wav.readUInt16LE(34)===16;}
function wavSeconds(wav){return isPcm16(wav)?(wav.length-44)/2/wav.readUInt32LE(24):0;}
// Joins consecutive mono PCM16 WAVs of one rate into one WAV. Anything else passes through unchanged.
function joinWavs(wavs){if(wavs.length<2||!wavs.every(isPcm16)||!wavs.every(w=>w.readUInt32LE(24)===wavs[0].readUInt32LE(24)))return wavs;const data=Buffer.concat(wavs.map(w=>w.subarray(44))),head=Buffer.from(wavs[0].subarray(0,44));head.writeUInt32LE(36+data.length,4);head.writeUInt32LE(data.length,40);return [Buffer.concat([head,data])];}
module.exports={PcController,joinWavs,pauseExpected,voiceUnits,trimEcho};
