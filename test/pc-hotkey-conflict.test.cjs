'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('events');
const {WindowsTextInput}=require('../src/input/windows-text.cjs'),{PcController}=require('../src/pc/controller.cjs');
// Fake Win32 hotkey table: `held` combinations belong to another process (another app).
function fakeApi(held){const mine=new Set();const label=vk=>'Ctrl+Shift+'+String.fromCharCode(vk);return {held,mine,foreground:()=>'w',unlocked:()=>true,keysDown:()=>false,recentInput:()=>false,pollHotkeys:()=>[],close(){},
 registerHotkeys(defs){return Object.values(defs).map(d=>{if(d.off)return true;const ok=!held.has(label(d.vk));if(ok)mine.add(label(d.vk));return ok;});},
 registerHotkey(i,d){if(d.off)return true;const ok=!held.has(label(d.vk));if(ok)mine.add(label(d.vk));return ok;},unregisterHotkeys(){mine.clear();}};}
const accessibility={ready:Promise.resolve(true),snapshot:async()=>({status:'editable',window:'w',runtimeId:'f',processId:1}),close(){}};

test('three-key input without talk-back: any conflict fails the whole input and names the keys',async t=>{
 const input=new WindowsTextInput({api:fakeApi(new Set(['Ctrl+Shift+8'])),accessibility});t.after(()=>input.close());
 const started=await input.ready;assert.equal(started.failed,true);assert.deepEqual(started.conflicts,['Ctrl+Shift+8']);
});

test('resident keeps the shortcuts it can register, reports the rest, and reclaims them when freed',async t=>{
 const api=fakeApi(new Set(['Ctrl+Shift+9','Ctrl+Shift+8','Ctrl+Shift+0']));
 const input=new WindowsTextInput({api,accessibility,talkback:true,partial:true});t.after(()=>input.close());
 const started=await input.ready;assert.notEqual(started.failed,true);assert.deepEqual(started.conflicts,['Ctrl+Shift+8'],'only Dictate collides: the resident no longer registers Ctrl+Shift+9 and Disarm is Ctrl+Shift+6');
 assert.deepEqual([...api.mine],['Ctrl+Shift+6','Ctrl+Shift+7']);assert.deepEqual(input.missing,['capture']);
 const events=[];input.on('hotkeys',e=>events.push(e));
 assert.deepEqual(input.retryHotkeys(),[],'still held');assert.deepEqual(events,[]);
 api.held.delete('Ctrl+Shift+8');
 assert.deepEqual(input.retryHotkeys(),['Ctrl+Shift+8']);assert.deepEqual(events,[{missing:[],restored:['Ctrl+Shift+8']}]);
 // Pause releases everything; resume reports what is still held instead of failing.
 assert.equal(input.setPaused(true),true);assert.deepEqual(input.retryHotkeys(),[],'no retries while paused');
 assert.equal(input.setPaused(false),true);assert.equal(events.length,1,'nothing is still held after resuming');
});

test('controller shows a tray notification naming conflicting and restored shortcuts',async t=>{
 const notices=[];const input=new EventEmitter();Object.assign(input,{ready:Promise.resolve({conflicts:['Ctrl+Shift+8','Ctrl+Shift+0']}),request:async()=>{},close(){}});
 const audio=new EventEmitter();Object.assign(audio,{probe:async()=>{},stopPlayback(){},close:async()=>{}});
 const c=new PcController({engine:{close(){}},audio,input,notify:{failure:m=>{notices.push(m);return true;},close:async()=>{}},saveDraft(){},clearDraft(){},lazy:true});t.after(()=>c.close());
 await c.ready();assert.equal(c.state,'ready','the resident keeps running');
 assert.match(notices[0],/could not register Ctrl\+Shift\+8, Ctrl\+Shift\+0: another program is using them/);
 input.emit('hotkeys',{missing:[],restored:['Ctrl+Shift+8']});assert.match(notices.at(-1),/available again: Ctrl\+Shift\+8/);
 input.emit('hotkeys',{missing:['Ctrl+Shift+9'],restored:[]});assert.match(notices.at(-1),/could not register Ctrl\+Shift\+9: another program is using it/);
});
