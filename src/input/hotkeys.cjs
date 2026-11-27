'use strict';
// Any change to a shortcut here or in its handlers must update the Hotkeys table at the top of
// docs/DEVELOPER_GUIDE.md.
const DEFAULT_HOTKEYS=Object.freeze({arm:'Ctrl+Shift+9',capture:'Ctrl+Shift+8',disarm:'Ctrl+Shift+0'});
// Resident key set: a fourth action, talk-back, and a fifth, voice mode, registered after the other three so
// their hotkey ids stay 1-3 (talk-back 4, voice 5). The three keys in use sit together: voice mode 6, talk-back 7,
// dictate 8. Disarm (Cancel) has no key by default; "hotkeys": {"disarm": "Ctrl+Shift+0"} in settings.json sets one.
const DEFAULT_TALKBACK='Ctrl+Shift+7',DEFAULT_VOICE='Ctrl+Shift+6',RESIDENT_DISARM='off';
// The arm action is off by default; "hotkeys": {"arm": "Ctrl+Shift+9"} in settings.json turns it on.
// "off" keeps the action's position (hotkey ids are positional) but registers nothing. Voice mode and Disarm can be
// "off" too.
const RESIDENT_ARM='off';
function parseHotkeys(overrides={},{talkback=false}={}){
  const defaults=talkback?{...DEFAULT_HOTKEYS,arm:RESIDENT_ARM,disarm:RESIDENT_DISARM,talkback:DEFAULT_TALKBACK,voice:DEFAULT_VOICE}:DEFAULT_HOTKEYS;
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).some(key=>!(key in defaults)))throw Error('Hotkeys must specify '+Object.keys(defaults).join(', ').replace(/, ([^,]+)$/,' or $1')+'.');
  const result={};
  for(const action of Object.keys(defaults)){
    const value=overrides[action]??defaults[action];
    if(value==='off'&&(action==='arm'||action==='voice'||action==='disarm')){result[action]={label:null,off:true,vk:0,modifiers:0};continue;}
    const match=typeof value==='string'&&/^Ctrl\+Shift\+([A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/i.exec(value);
    if(!match)throw Error('Use Ctrl+Shift plus a letter, number, function key or Space.');
    const key=match[1].toUpperCase();
    const vk=key==='SPACE'?0x20:key.length===1?key.charCodeAt(0):0x6f+Number(key.slice(1));
    result[action]={label:'Ctrl+Shift+'+(key==='SPACE'?'Space':key),vk,modifiers:0x4006};
  }
  const on=Object.values(result).filter(item=>!item.off);if(new Set(on.map(item=>item.vk)).size!==on.length)throw Error('Choose a different shortcut for each dictation action.');
  return result;
}
module.exports={DEFAULT_HOTKEYS,DEFAULT_TALKBACK,DEFAULT_VOICE,RESIDENT_DISARM,RESIDENT_ARM,parseHotkeys};
