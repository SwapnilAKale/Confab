const {test}=require('node:test'),assert=require('node:assert/strict');const {Playback}=require('../src/playback.cjs');
function setup(memory){let sent;const playback=new Playback({memory,synthesize:job=>sent=job,emit:()=>{}});return {playback,start(id,text,options){playback.stop();playback.enqueue({id,text},options);const job=sent;playback.audio({...job,samples:Buffer.alloc(8),sampleRate:24000,synthesisMs:1});playback.progress({type:'playback-started',epoch:job.epoch,replyId:job.replyId,index:job.index});return job;}};}
test('separate reply positions survive later playback and a saved-memory restart',()=>{
 const {playback,start}=setup({last:{id:'older',index:3,complete:false}});const newJob=start('newer','New reply.');playback.progress({type:'playback-position',epoch:newJob.epoch,replyId:newJob.replyId,index:0});
 assert.equal(playback.memory.positions['host:older'].index,3);assert.equal(playback.memory.positions['host:newer'].index,0);
 const restored=setup(JSON.parse(JSON.stringify(playback.memory))).playback;assert.equal(restored.memory.positions['host:older'].index,3);assert.equal(restored.memory.last.id,'newer');
});
test('local speech has its own anchor while clarification cannot replace the referenced playback',()=>{
 const {playback,start}=setup({});start('host','Original agent reply.');start('local-reply','Yes, I can hear you.',{local:true,remember:true});assert.equal(playback.memory.last.id,'host');assert.equal(playback.memory.localLast.id,'local-reply');assert.equal(playback.memory.current.source,'local');
 start('question','Did you mean the earlier one?',{local:true,remember:false});assert.equal(playback.memory.current.id,'local-reply');assert.equal(playback.memory.localLast.id,'local-reply');assert.equal(playback.memory.positions['local:question'],undefined);
});
