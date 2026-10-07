'use strict';
// Transcript readers for harnesses whose hook payloads carry no text. A reader returns
// {prompts, reply, replyKey} for the turn that just ended, or null. It reads only the transcript
// file the hook itself named, and only the tail, so a long conversation stays fast.
const fs=require('node:fs'),path=require('node:path');
const TAIL=4*1048576;
function tailLines(file){
 const fd=fs.openSync(file,'r');
 try{
  const size=fs.fstatSync(fd).size,start=Math.max(0,size-TAIL),buffer=Buffer.alloc(size-start);
  fs.readSync(fd,buffer,0,buffer.length,start);
  const lines=buffer.toString('utf8').split('\n');if(start>0)lines.shift();
  return lines.flatMap(line=>{try{return line.trim()?[JSON.parse(line)]:[];}catch{return [];}});
 }finally{fs.closeSync(fd);}
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Antigravity: <app data>/brain/<conversation>/.system_generated/logs/transcript.jsonl. That file
// cuts long content at about 4 KB; transcript_full.jsonl beside it has the full text.
// The user's words are inside <USER_REQUEST>; the final answer is a planner response with text
// and no tool calls. Messages queued during the turn are separate USER_INPUT steps.
function antigravitySteps(steps){
 const isUser=s=>s.type==='USER_INPUT',isFinal=s=>s.source==='MODEL'&&s.type==='PLANNER_RESPONSE'&&typeof s.content==='string'&&s.content.trim()&&!s.tool_calls?.length;
 const lastUser=steps.findLastIndex(isUser);if(lastUser<0)return null;
 const prompts=[];
 for(let i=lastUser;i>=0&&!isFinal(steps[i]);i--)if(isUser(steps[i])&&typeof steps[i].content==='string'){
  const inner=/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(steps[i].content);
  prompts.unshift((inner?inner[1]:steps[i].content).trim());
 }
 const lastPlanner=steps.findLastIndex(s=>s.source==='MODEL'&&s.type==='PLANNER_RESPONSE');
 const final=lastPlanner>lastUser&&isFinal(steps[lastPlanner])?steps[lastPlanner]:null;
 return {prompts:prompts.filter(Boolean),...(final?{reply:final.content,replyKey:final.step_index??lastPlanner}:{})};
}
async function antigravity(file,{attempts=3,delay=150}={}){
 if(!path.isAbsolute(file)||!/^transcript(_full)?\.jsonl$/.test(path.basename(file)))return null;
 const full=path.join(path.dirname(file),'transcript_full.jsonl'),source=fs.existsSync(full)?full:file;
 let result=null;
 // The final step can land in the file just after Stop fires.
 for(let i=0;i<attempts;i++){try{result=antigravitySteps(tailLines(source));}catch{result=null;}if(result?.reply!==undefined||i===attempts-1)break;await wait(delay);}
 return result;
}
// Windsurf (Devin Desktop): post_cascade_response_with_transcript names ~/.windsurf/transcripts/<trajectory>.jsonl,
// whose lines carry planner_response.response (docs.devin.ai/desktop/cascade/hooks). The prompt comes from
// pre_user_prompt, so only the last planner response is read. Untested live: the line shape is from the docs.
function windsurfSteps(steps){
 for(let i=steps.length-1;i>=0;i--){const text=steps[i]?.planner_response?.response;if(typeof text==='string'&&text.trim())return {prompts:[],reply:text,replyKey:i};}
 return null;
}
async function windsurf(file,{attempts=3,delay=150}={}){
 if(!path.isAbsolute(file)||!/\.jsonl$/i.test(file))return null;
 let result=null;
 for(let i=0;i<attempts;i++){try{result=windsurfSteps(tailLines(file));}catch{result=null;}if(result||i===attempts-1)break;await wait(delay);}
 return result;
}
module.exports={antigravity,antigravitySteps,windsurf,windsurfSteps};
