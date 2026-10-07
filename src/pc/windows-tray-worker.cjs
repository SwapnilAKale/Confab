'use strict';
// The tray's native window procedure handles sent and queued shell callbacks.
// Its separate thread keeps the popup's modal loop away from recording/playback.
const {parentPort}=require('node:worker_threads');
const {NativeTray}=require('./windows-tray-native.cjs');
const tray=new NativeTray({onAction:action=>parentPort.postMessage({type:'action',action}),onError:message=>parentPort.postMessage({type:'error',message})});
// The status badge shares this thread; a badge failure never takes the tray down.
let badge=null;try{badge=new (require('./windows-badge-native.cjs').Badge)();}catch{}
const poll=setInterval(()=>{tray.pump();try{badge?.tick();}catch{}},20);
parentPort.on('message',e=>{
 if(e.type==='state')tray.update(e.state);
 else if(e.type==='notification')tray.failure(e.message);
 else if(e.type==='badge')try{badge?.set(e.state);}catch{}
 else if(e.type==='badgeEnabled')try{badge?.setEnabled(e.enabled);}catch{}
 else if(e.type==='close'){clearInterval(poll);try{badge?.close();}catch{}tray.close();parentPort.close();}
});
process.on('exit',()=>{try{badge?.close();}catch{}tray.close();});
parentPort.postMessage({type:'ready'});
