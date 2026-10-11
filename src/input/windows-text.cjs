'use strict';
const {EventEmitter}=require('node:events');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class WindowsTextInput extends EventEmitter {
  // partial (resident only): keep the shortcuts that registered, report the rest in 'hotkeys'
  // events, and retry them with retryHotkeys(). Without it any conflict closes the input, as before.
  // immediate (resident only): a dictation key starts recording at once; the focused box is
  // checked in the background and again before pasting, instead of blocking the start.
  constructor({api,accessibility,shortcuts=true,hotkeys,talkback=false,partial=false,immediate=false,restoreClipboard=false,wait=delay}={}){
    super();this.restoreClipboard=restoreClipboard;this.partial=partial;this.immediate=immediate;this.missing=[];this.on('error',()=>{});this.hotkeys=require('./hotkeys.cjs').parseHotkeys(hotkeys,{talkback});this.wait=wait;this.shortcutQueue=Promise.resolve();
    if(!api&&process.platform!=='win32')throw Error('Focused-app dictation currently requires Windows.');
    this.api=api||require('./windows-api.cjs').createWindowsApi();
    try{this.accessibility=accessibility||new (require('./accessibility.cjs').Accessibility)();}
    catch(error){this.api.close();throw error;}
    this.ready=this.start(shortcuts).catch(()=>{this.close();return {failed:true,reason:'native_api_unavailable'};});
  }
  async start(shortcuts){
    const available=await this.accessibility.ready;
    if(!available||this.closed){this.close();return {failed:true};}
    const keys=shortcuts?this.api.registerHotkeys(this.hotkeys):Object.keys(this.hotkeys).map(()=>true);
    const started={eventName:'started',armHotkey:keys[0],captureHotkey:keys[1],disarmHotkey:keys[2],...(this.hotkeys.talkback?{talkbackHotkey:keys[3]}:{})};
    const conflicts=Object.values(this.hotkeys).filter((_,i)=>!keys[i]).map(item=>item.label);
    if(conflicts.length&&!this.partial){this.close();return {...started,failed:true,reason:'shortcut_conflict',conflicts};}
    if(conflicts.length){this.missing=Object.keys(this.hotkeys).filter((_,i)=>!keys[i]);started.conflicts=conflicts;}
    if(shortcuts){this.poll=setInterval(()=>{for(const id of this.api.pollHotkeys())this.shortcutQueue=this.shortcutQueue.then(()=>this.hotkey(id)).catch(()=>this.emit('error',Error('Dictation shortcut failed.')));},25);this.poll.unref();}
    this.emit('started',started);return started;
  }
  async hotkey(id){
    if(this.closed||this.paused)return;
    if(this.busy){if(this.immediate)this.emit('press',{ignored:'insertion_busy'});return;}
    if(this.immediate&&(id===2||(id===4&&this.hotkeys.talkback))){
      // Start (or stop) now; never wait for UI Automation before giving feedback.
      this.recording=!this.recording;
      if(this.recording){this.target=null;this.emit('capture',{action:'start',talkback:id===4});this.armed=this.arm().then(result=>{this.emit('arm',{result,background:true});if(this.recording&&result.status==='armed')this.watchFocus();return result;},()=>({status:'rejected',reason:'accessibility_unavailable'}));}
      else{this.unwatchFocus();this.emit('capture',{action:'end'});}
      return;
    }
    if(this.immediate&&id===3){const recording=this.recording;this.unwatchFocus();this.target=null;this.recording=false;this.emit('disarmed',{recording});return;}
    if(id===1){if(this.immediate)this.emit('press',{action:'arm'});this.emit('arm',{result:await this.arm(),...(this.immediate?{acknowledged:true}:{})});}
    else if(id===2||(id===4&&this.hotkeys.talkback)){
      // Either dictation key stops an active recording; the key that started it sets its mode.
      if(!this.recording){const result=await this.arm();if(result.status!=='armed'){this.emit('arm',{result});return;}}
      this.recording=!this.recording;this.emit('capture',{action:this.recording?'start':'end',talkback:this.recording?id===4:undefined});
    }else if(id===3){this.target=null;this.recording=false;this.emit('disarmed');}
  }
  // Retries shortcuts another process held. Returns the labels registered by this call.
  retryHotkeys(){
    if(this.closed||this.paused||!this.missing.length)return [];
    const actions=Object.keys(this.hotkeys),restored=this.missing.filter(action=>this.api.registerHotkey(actions.indexOf(action),this.hotkeys[action]));
    this.missing=this.missing.filter(action=>!restored.includes(action));
    if(restored.length)this.emit('hotkeys',{missing:this.missing.map(a=>this.hotkeys[a].label),restored:restored.map(a=>this.hotkeys[a].label)});
    return restored.map(a=>this.hotkeys[a].label);
  }
  setPaused(paused){
    if(this.closed)return false;if(this.paused===paused)return true;
    if(paused){this.paused=true;this.missing=[];this.api.unregisterHotkeys();this.api.pollHotkeys();this.target=null;return true;}
    const keys=this.api.registerHotkeys(this.hotkeys);
    if(this.partial){this.paused=false;this.missing=Object.keys(this.hotkeys).filter((_,i)=>!keys[i]);if(this.missing.length)this.emit('hotkeys',{missing:this.missing.map(a=>this.hotkeys[a].label),restored:[]});return true;}if(keys.some(ok=>!ok)){this.api.unregisterHotkeys();return false;}this.paused=false;return true;
  }
  guard(idle=false){
    if(this.closed)return 'native_disconnected';
    if(!this.api.unlocked())return 'desktop_unavailable';
    if(!this.target)return 'not_armed';
    if(this.api.foreground()!==this.target.window)return 'focus_changed';
    if(this.api.keysDown())return 'typing_active';
    return null;
  }
  // A refused box, in words a log can keep: the check that failed and the control type (never any text).
  static refusal(snapshot){const o=snapshot?.observed;return o?[o.detail,o.type].filter(Boolean).join(': ')||null:null;}
  async arm(){
    const result=await this.armCheck();this.lastArm={status:result.status,reason:result.reason||null,detail:WindowsTextInput.refusal(result),at:Date.now()};return result;
  }
  async armCheck(){
    this.target=null;
    if(this.closed||!this.api.unlocked())return {status:'rejected',reason:'desktop_unavailable'};
    const window=this.api.foreground(),snapshot=await this.accessibility.snapshot();
    if(this.closed||!this.api.unlocked())return {status:'rejected',reason:'desktop_unavailable'};
    if(snapshot.status!=='editable')return snapshot;
    if(window==='0'||this.api.foreground()!==window||snapshot.window!==window)return {status:'rejected',reason:'focus_changed'};
    this.target={window,runtimeId:snapshot.runtimeId,...(this.immediate?{document:{id:snapshot.documentId??null,name:snapshot.documentName??null}}:{})};return {status:'armed',processId:snapshot.processId};
  }
  async field(){
    const target=this.target;
    const snapshot=await this.accessibility.snapshot({runtimeId:target.runtimeId,includeText:true});
    if(this.target!==target)return {status:'rejected',reason:'field_changed'};
    if(snapshot.status!=='editable')return snapshot;
    const changed=this.boxDifference(target,snapshot);if(changed)return {status:'rejected',reason:'field_changed',detail:changed};
    return snapshot;
  }
  // Same box: same top-level window and UI Automation element, and (resident mode) the same
  // containing document by runtime id and title, so another browser tab or app session that
  // reuses an input element is never taken for the box where dictation started.
  sameBox(target,snapshot){return !this.boxDifference(target,snapshot);}
  // Which part of the identity differs: 'window', 'element', 'document' or 'document_title'; null when it is the same box.
  boxDifference(target,snapshot){
    if(snapshot.window!==target.window)return 'window';
    if(snapshot.runtimeId!==target.runtimeId)return 'element';
    if(target.document&&(snapshot.documentId??null)!==target.document.id)return 'document';
    if(target.document&&(snapshot.documentName??null)!==target.document.name)return 'document_title';
    return null;
  }
  // Resident mode: while recording, report whether focus is in the target box ('focus' events on change).
  watchFocus(){
    this.unwatchFocus();let inTarget=true,checking=false,last=0;
    const report=value=>{if(value!==inTarget){inTarget=value;this.emit('focus',{inTarget});}};
    this.focusWatch=setInterval(async()=>{
     const target=this.target;if(!target||checking||this.closed)return;
     if(this.api.foreground()!==target.window){report(false);return;}
     if(Date.now()-last<300&&inTarget)return;
     checking=true;last=Date.now();
     try{const snapshot=await this.accessibility.snapshot({runtimeId:target.runtimeId});if(this.target===target&&this.focusWatch)report(snapshot.status==='editable'&&this.sameBox(target,snapshot));}catch{}finally{checking=false;}
    },100);this.focusWatch.unref?.();
  }
  unwatchFocus(){clearInterval(this.focusWatch);this.focusWatch=null;}
  async insert(text,autoSend=false){
    if(this.busy)return {status:'rejected',reason:'insertion_busy'};
    // Immediate mode: use the box checked at the start, or check the box focused now.
    if(this.immediate&&!this.target){await this.armed;if(!this.target){const result=await this.arm();if(result.status!=='armed'){const detail=WindowsTextInput.refusal(result);return {status:'rejected',reason:result.reason||'not_editable',...(detail?{detail}:{})};}}}
    this.busy=true;let dispatched=false,savedClipboard,stage;
    try{
      if(typeof text!=='string'||!text.trim()||text.length>20000)return {status:'rejected',reason:'invalid_text'};
      if(/[\x00-\x1f\x7f-\x9f]/u.test(text))return {status:'rejected',reason:'control_characters'};
      let reason=this.guard(true);if(reason)return {status:'rejected',reason};
      stage='inspect_target';const before=await this.field();if(before.status!=='editable'){const detail=before.detail||WindowsTextInput.refusal(before);return {status:before.status,reason:before.reason,...(detail?{detail}:{})};}
      if(typeof before.value!=='string')return {status:'rejected',reason:'text_unverified'};
      reason=this.guard(true);if(reason)return {status:'rejected',reason};
      // Detect editing in this field, not unrelated mouse movement elsewhere.
      await this.wait(250);
      reason=this.guard(true);if(reason)return {status:'rejected',reason};
      const settled=await this.field();if(settled.status!=='editable')return settled;
      if(settled.value!==before.value)return {status:'rejected',reason:'typing_active'};
      if(this.restoreClipboard){stage='preserve_clipboard';savedClipboard=this.api.saveClipboard();}
      stage='write_clipboard';
      const sequence=this.api.setClipboard(text);
      stage='recheck_target';const current=await this.field();if(current.status!=='editable')return current;
      if(current.value!==before.value)return {status:'rejected',reason:'typing_active'};
      reason=this.guard(true);if(reason)return {status:'rejected',reason};
      if(!this.api.clipboardUnchanged(sequence))return {status:'rejected',reason:'clipboard_changed'};
      stage='paste';dispatched=true;
      if(!this.api.paste())return {status:'uncertain',reason:'input_incomplete'};
      // A box that can never be read back (an xterm.js terminal input): reading it again would always look like a failed
      // paste. Report the paste as done but unconfirmed: still the same box with focus kept and no keys pressed, the text
      // left on the clipboard as a backup, and never followed by Enter.
      if(before.unreadable===true){
        stage='verify_paste';await this.wait(100);
        reason=this.guard();if(reason)return {status:'uncertain',reason};
        const after=await this.field();if(after.status!=='editable')return {status:'uncertain',reason:after.reason};
        return {status:'inserted',submitted:false,verified:false,reason:'box_unreadable'};
      }
      stage='verify_paste';let verified=false;
      for(let i=0;i<8;i++){
        await this.wait(50);
        reason=this.guard();if(reason)return {status:'uncertain',reason};
        const after=await this.field();
        if(after.status!=='editable')return {status:'uncertain',reason:after.reason};
        if(typeof after.value==='string'&&after.value!==before.value&&after.value.includes(text)){verified=true;break;}
      }
      if(!verified)return {status:'uncertain',reason:'text_unverified'};
      let clipboardRestored;
      if(this.restoreClipboard){stage='restore_clipboard';clipboardRestored=this.api.restoreClipboard(savedClipboard,sequence);}
      if(autoSend===true){
        reason=this.guard();if(reason)return {status:'inserted',submitted:false,reason:'enter_refused'};
        if(!this.api.enter())return {status:'uncertain',reason:'enter_unconfirmed'};
      }
      return {status:'inserted',submitted:autoSend===true,...(this.restoreClipboard?{clipboardRestored}:{}),reason:autoSend===true?'enter_queued':'review_in_app'};
    }catch(error){return {status:dispatched?'uncertain':'rejected',reason:['clipboard_busy','clipboard_changed','clipboard_preserve_failed','clipboard_format_unsupported'].includes(error.code)?error.code:'native_check_failed',...(stage&&this.restoreClipboard?{stage}:{})};}
    finally{if(savedClipboard)this.api.releaseClipboard(savedClipboard);this.busy=false;}
  }
  async request(action){
    if(action==='capture-reset'){this.recording=false;this.unwatchFocus();return {status:'reset'};}
    if(action==='arm')return this.arm();
    if(action==='disarm'){this.target=null;this.recording=false;return {status:'disarmed'};}
    if(action==='status')return {status:this.guard()||'ready'};
    return {status:'rejected',reason:'unsupported_action'};
  }
  close(){if(this.closed)return;this.closed=true;clearInterval(this.poll);this.unwatchFocus();this.target=null;this.accessibility.close();this.api.close();}
}
module.exports={WindowsTextInput};
