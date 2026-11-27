'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('tray receives direct shell callbacks and posted callbacks through the same window procedure',{skip:process.platform!=='win32'},t=>{
 const k=require('koffi'),u=k.load('user32.dll');
 const send=u.func('intptr_t __stdcall SendMessageW(void *window, uint32 message, uintptr_t wp, intptr_t lp)');
 const post=u.func('int __stdcall PostMessageW(void *window, uint32 message, uintptr_t wp, intptr_t lp)');
 const {NativeTray,CALLBACK_MESSAGE}=require('../src/pc/windows-tray-native.cjs');
 const errors=[];let opens=0;
 const tray=new NativeTray({requestMenu:()=>opens++,onError:text=>errors.push(text)});t.after(()=>tray.close());
 send(tray.window,CALLBACK_MESSAGE,1,0x205);
 assert.equal(opens,1,'right-click sent directly to WndProc must reach the menu handler');
 assert.equal(post(tray.window,CALLBACK_MESSAGE,1,0x202),1);tray.pump();
 assert.equal(opens,2,'posted left-click must use the same menu handler');
 send(tray.window,CALLBACK_MESSAGE,1,0x7b);assert.equal(opens,3);
 send(tray.window,CALLBACK_MESSAGE,1,0x200);assert.equal(opens,3,'hover must not open the menu');
 tray.update({models:'loaded',readMode:'off',paused:true,hotkeys:{arm:'Ctrl+Shift+9',capture:'Ctrl+Shift+8',disarm:'Ctrl+Shift+6',talkback:'Ctrl+Shift+T'},hotkeysUnavailable:['Ctrl+Shift+9']});
 const menu=tray.buildMenu();
 const count=u.func('int __stdcall GetMenuItemCount(void *menu)'),state=u.func('uint32 __stdcall GetMenuState(void *menu, uint32 id, uint32 flags)'),destroy=u.func('int __stdcall DestroyMenu(void *menu)');
 const text=u.func('int __stdcall GetMenuStringW(void *menu, uint32 item, _Out_ uint16 *buffer, int max, uint32 flags)'),label=i=>{const b=new Uint16Array(128);const n=text(menu,i,b,128,0x400);return String.fromCharCode(...b.slice(0,n));};
 try{assert.equal(count(menu),21);assert.deepEqual([16,17,19,20].map(i=>label(i)),["Connect agents…","Diagnose…","Uninstall Confab…","Quit Confab"]);assert.equal(label(10),"Mute voice mode (tap Ctrl+Shift)");assert.equal(state(menu,14,0)&1,1,"Mute is greyed out when voice mode is off");assert.equal(state(menu,14,0)&8,0,"and not ticked");assert.equal(label(14),'Check for updates');assert.equal(state(menu,7,0)&8,8,'status badge is on by default');assert.equal(state(menu,12,0)&8,8,'update check is on by default');assert.equal(state(menu,13,0),0xffffffff,'no update item when up to date');assert.equal(label(9),'Read full reply');assert.equal(state(menu,11,0)&8,0,'full reply is off by default');assert.deepEqual([2,3,4,5].map(label),['Dictate: Ctrl+Shift+8','Talk-back: Ctrl+Shift+T','Cancel: Ctrl+Shift+6','Arm text box: Ctrl+Shift+9 (in use elsewhere)'],'live and custom keys are shown');assert.equal(state(menu,5,0),0xffffffff,'no All replies item');assert.equal(state(menu,4,0)&8,0);assert.equal(state(menu,6,0)&8,8,'Off is checked');assert.equal(state(menu,6,0)&0x200,0x200,'modes are radio items');assert.equal(state(menu,2,0)&8,8);assert.equal(state(menu,3,0)&3,0);}finally{destroy(menu);}
 tray.update({models:'loaded',readMode:'talkback',fullReply:true,checkUpdates:false,updateAvailable:{version:'0.9.0',url:'https://github.com/SwapnilAKale/Confab/releases/tag/v0.9.0'}});const full=tray.buildMenu();try{assert.equal(state(full,11,0)&8,8,'full reply is checked when on');assert.equal(state(full,12,0)&8,0,'update check is unchecked when off');const u=new Uint16Array(128);const un=text(full,1,u,128,0x400);assert.equal(String.fromCharCode(...u.slice(0,un)),'Update available (v0.9.0)…');assert.equal(state(full,13,0)&3,0,'update item is enabled');}finally{destroy(full);}
 assert.deepEqual(errors,[]);tray.close();tray.close();
});
test('tray worker owns and disposes the registered callback safely',{skip:process.platform!=='win32'},async()=>{
 const {WindowsTray}=require('../src/pc/windows-tray.cjs');const tray=new WindowsTray();await tray.ready;tray.update({models:'unloaded',paused:false,readAloud:true});await new Promise(r=>setTimeout(r,100));await tray.close();
});
