'use strict';
// Claude Code hook: hands the payload to the generic hook adapter with the claude-code mapping
// (src/adapters/hooks/mappings/claude-code.json). The service decides what is spoken.
// Observer only: never outputs a permission decision.
const {handle,firstJsonEnd,DEADLINE_MS}=require('../hooks/adapter.cjs');
async function relay(root,input,options={}){await handle('claude-code',input,options);}
// The prompt hook blocks Claude's turn: act on the first complete JSON object (never wait for end of
// stdin) and exit at the shared hard deadline, whatever happens.
if(require.main===module){
 const exit=()=>process.exit(0);
 setTimeout(exit,Math.max(100,DEADLINE_MS-Math.round(process.uptime()*1000)));
 let input='',started=false;const go=raw=>{if(started)return;started=true;relay(process.argv[2],raw).catch(()=>{}).finally(exit);};
 process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{input+=s;if(input.length>1048576)return exit();const end=firstJsonEnd(input);if(end>0)go(input.slice(0,end));});process.stdin.on('end',()=>go(input));process.stdin.on('error',exit);
}
module.exports={relay};
