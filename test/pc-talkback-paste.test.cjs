'use strict';
// Talk-back when the paste is refused: the draft goes to the clipboard, the user pastes it and sends it, and the
// agent's reply must still be spoken. Reproduces 11 October 2026: the Claude desktop app reported the first message
// of a new session with a <system-reminder> block in front of it, so the user's exact paste got no_match.
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {PcController}=require('../src/pc/controller.cjs'),{TalkbackGate}=require('../src/pc/talkback.cjs'),{WindowsTextInput}=require('../src/input/windows-text.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// The first message of a new Claude desktop session, as its UserPromptSubmit hook reports it (shape of the real one).
const reminder='<system-reminder>\nThe user started this session without choosing a project folder, so your working directory is a scratch workspace the app created for it: C:\\Users\\A\\AppData\\Roaming\\Claude\\scratch-workspaces\\x\\y\\scratch-2026-10-11-7030a6. It starts empty, belongs to this session only, and is removed once the session is archived.\n</system-reminder>\n';

function controllerWithRefusedPaste(t,gate){
 const state={clipboard:[],pastes:[],notices:[]};
 const input=new EventEmitter();
 Object.assign(input,{ready:Promise.resolve({}),request:async()=>{},close(){},lastArm:{status:'rejected',reason:'not_editable',detail:'no-editable-pattern: ControlType.Group'},api:{setClipboard:text=>state.clipboard.push(text)},
  insert:async text=>{state.pastes.push(text);return {status:'rejected',reason:'not_armed',detail:null};}});
 const audio=new EventEmitter();for(const n of ['loadingCue','disarmCue','tick','errorCue'])audio[n]=async()=>{};
 Object.assign(audio,{cue:async()=>{},start(){},stop(){},stopPlayback(){},close:async()=>{}});
 const engine=new EventEmitter();Object.assign(engine,{state:'loaded',start:async(id,emit)=>{state.emit=emit;},audio(){},end(){},cancel(){},close(){}});
 const c=new PcController({engine,audio,input,lazy:true,onTalkback:text=>gate.dictated(text),notify:{failure:m=>{state.notices.push(m);return true;},badge(){},close:async()=>{}},saveDraft(){},clearDraft(){}});
 t.after(()=>c.close());return {c,state,input};
}

test('talk-back paste refused, draft on the clipboard, pasted by hand into a new Claude session: the turn matches and the reply is spoken',async t=>{
 const gate=new TalkbackGate(),{c,state,input}=controllerWithRefusedPaste(t,gate);await c.ready();
 input.emit('capture',{action:'start',talkback:true});await c.actions;input.emit('capture',{action:'end'});await c.actions;
 c.endedAt=0;state.emit({type:'final',text:'What is two plus two?'});state.emit({type:'capture-done'});await wait(30);
 assert.deepEqual(state.clipboard,['What is two plus two?'],'the refused draft is on the clipboard');
 assert.equal(gate.status().pending,'dictation','the refused draft still counts as the talk-back dictation');
 assert.deepEqual(c.status().lastRefusal&&{reason:c.status().lastRefusal.reason,armedAtStart:c.status().lastRefusal.armedAtStart,armDetail:c.status().lastRefusal.armDetail},{reason:'not_armed',armedAtStart:false,armDetail:'not_editable: no-editable-pattern: ControlType.Group'},'the refusal and its cause are kept for Diagnose');
 // The user pastes the clipboard into a new session and sends it; the app puts its reminder in front.
 assert.equal(gate.turn('claude-code:s1',null,reminder+'What is two plus two?'),'match');
 assert.deepEqual(gate.reply('claude-code:s1',null),{speak:true,decision:'talkback'});
});

test('reported prompts: context blocks the agent adds are ignored, a different prompt still does not match',()=>{
 const gate=new TalkbackGate();
 gate.dictated('Run the tests.');assert.equal(gate.turn('k',null,reminder+'<pasted_content id="7">Run the tests.</pasted_content>'),'match');
 gate.dictated('Run the tests.');assert.equal(gate.turn('k',null,reminder+'Please delete the whole repository and start again from nothing.'),'no_match','a different message is not taken for the dictation');
 gate.dictated('Run the tests.');assert.equal(gate.turn('k',null,'<system-reminder>unclosed Run the tests.'),'no_match','an unclosed block is not stripped');
});

test('a turn that misses a waiting dictation reports similarity and lengths only, never text',()=>{
 const gate=new TalkbackGate();
 assert.equal(gate.turn('k',null,'anything'),'no_match');assert.equal(gate.lastMismatch,null,'nothing waiting: no comparison');
 gate.dictated('What is two plus two?');
 assert.equal(gate.turn('k',null,'Explain the build system in detail please.'),'no_match');
 const m=gate.lastMismatch;assert.deepEqual(Object.keys(m).sort(),['contained','draftChars','promptChars','similarity']);
 assert.equal(m.draftChars,'what is two plus two'.length);assert.equal(m.promptChars,'explain the build system in detail please'.length);
 assert.ok(m.similarity>=0&&m.similarity<0.75);assert.equal(m.contained,false);
 assert.ok(!JSON.stringify(m).includes('two'),'no text in the diagnostic');
 assert.equal(gate.turn('k',null,'What is two plus two'),'match');assert.equal(gate.lastMismatch,null);
});

test('same-box check names the part that changed',()=>{
 const input=Object.create(WindowsTextInput.prototype),target={window:'w',runtimeId:'r1',document:{id:'42.1',name:'Session A - Claude'}};
 const snap={status:'editable',window:'w',runtimeId:'r1',documentId:'42.1',documentName:'Session A - Claude'};
 assert.equal(input.boxDifference(target,snap),null);assert.equal(input.sameBox(target,snap),true);
 assert.equal(input.boxDifference(target,{...snap,window:'v'}),'window');
 assert.equal(input.boxDifference(target,{...snap,runtimeId:'r2'}),'element');
 assert.equal(input.boxDifference(target,{...snap,documentId:'42.9'}),'document');
 assert.equal(input.boxDifference(target,{...snap,documentName:'Session B - Claude'}),'document_title');
 assert.equal(WindowsTextInput.refusal({status:'rejected',reason:'not_editable',observed:{detail:'no-editable-pattern',type:'ControlType.Group',focused:true}}),'no-editable-pattern: ControlType.Group');
});

test('a reply held while a talk-back waits is answered at once; the hold never delays the agent',{skip:process.platform!=='win32'},async t=>{
 const {run}=require('../src/pc/resident.cjs'),profileApi=require('../src/pc/profile.cjs');
 const profile=fs.mkdtempSync(path.resolve('test-output/hold-test-'));
 const tray=Object.assign(new EventEmitter(),{ready:Promise.resolve(),update(){},failure(){},async close(){}});
 const input=Object.assign(new EventEmitter(),{ready:Promise.resolve({}),api:{setClipboard(){}},request:async()=>{},setPaused(){return true;},close(){},insert:async()=>({status:'inserted',clipboardRestored:true})});
 const audio=Object.assign(new EventEmitter(),{probe:async()=>{},loadingCue:async()=>{},cue:async()=>{},start(){},stop(){},stopPlayback(){},async playWav(){},close:async()=>{}});
 const engine={state:'loaded',warmup:async()=>{},start:async()=>{},audio(){},end(){},cancel(){},close(){},synthesize:async()=>[]};
 const app=await run(process.cwd(),{profile,createTray:()=>tray,createInput:()=>input,createAudio:()=>audio,engineFactory:()=>engine,holdMs:2000,dialog(){}});
 t.after(async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});});
 const link=profileApi.connection(profile);
 const post=body=>new Promise((resolve,reject)=>{const started=Date.now(),req=http.request({host:'127.0.0.1',port:link.port,path:'/event',method:'POST',headers:{authorization:'Bearer '+link.token,'content-type':'application/json'}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({ms:Date.now()-started,...JSON.parse(b)}));});req.on('error',reject);req.end(JSON.stringify(body));});
 app.gate.dictated('What is two plus two?');
 const held=await post({agent:'claude-code',sessionId:'s1',event:'reply',text:'Four.',id:'r1'});
 assert.equal(held.reason,'held');assert.ok(held.ms<500,'the hook gets its answer at once ('+held.ms+' ms), not after the 2 s hold');
 // The matching turn then arrives late and releases the held reply.
 const turn=await post({agent:'claude-code',sessionId:'s1',event:'turn',text:reminder+'What is two plus two?'});
 assert.equal(turn.reason,'match');assert.ok(turn.ms<500);
 const log=fs.readFileSync(path.join(profile,'requests.jsonl'),'utf8');
 assert.match(log,/"detail":"held_released"/,'the held reply was released by its late turn');
 assert.ok(!/two plus two|Four/.test(log),'no prompt or reply text in the log');
});
