'use strict';
// Speech text chunking, the audio cache and streaming synthesis in the native speech engine.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {AudioCache,speechChunks,splitSpeech}=require('../src/playback.cjs');
const {NativeSpeechEngine}=require('../src/service/native-engine.cjs');
const plain={normalize:async text=>text,close(){}};
test('speech chunks preserve every character',()=>{
 const text='I changed the file. Keep the link https://example.com and code:\n'+('print("hello world")\n'.repeat(40));
 assert.equal(splitSpeech(text).join(''),text);
});
test('short first speech chunk preserves exact complete text including code and Unicode',()=>{
 const text='Ran the Python file successfully.\n\n```python\nprint("hello")\n```\n'+('Keep every character, including punctuation! '.repeat(20));
 const chunks=speechChunks(text);assert.equal(chunks.join(''),text);assert.ok(chunks[0].length<=80);assert.equal(chunks[0],'Ran the Python file successfully.\n');
 assert.equal(speechChunks('a'.repeat(400)).join(''),'a'.repeat(400));
});
test('audio cache has a fixed memory bound and evicts least recently used entries',()=>{
 const cache=new AudioCache(20),audio={samples:Buffer.alloc(12)};cache.put('a',audio);cache.put('b',audio);assert.equal(cache.get('a'),undefined);assert.ok(cache.get('b'));assert.equal(cache.bytes,12);
});
test('native streaming stops generating further text parts after cancellation',async t=>{
 const engine=new NativeSpeechEngine({normalizer:plain});t.after(()=>engine.close());
 let calls=0,chunks=0,stopped=false;
 engine.worker=async()=>({send(){calls++;queueMicrotask(()=>engine.ttsJob.resolve({samples:new Float32Array(100).buffer,sampleRate:24000}));}});
 const result=await engine.synthesize('A sentence with several words. '.repeat(30),{onChunk(){chunks++;stopped=true;},isCancelled:()=>stopped});
 assert.equal(calls,1);assert.equal(chunks,1);assert.deepEqual(result,[]);
});
test('native sentence callbacks play before the full chunk completes and cache replay contains no duplication',async t=>{
 const engine=new NativeSpeechEngine({normalizer:plain});t.after(()=>engine.close());
 let job,requests=0;const chunks=[];
 engine.worker=async()=>({send(event){assert.equal(event.stream,true);requests++;job=engine.ttsJob;}});
 const running=engine.synthesize('First sentence. Second sentence.',{onChunk:chunk=>chunks.push(chunk)});
 await new Promise(resolve=>setImmediate(resolve));
 job.onChunk({samples:new Float32Array([.1,.2]).buffer,sampleRate:24000});assert.equal(chunks.length,1,'Sentence is playable before generation completes');
 job.onChunk({samples:new Float32Array([.3,.4]).buffer,sampleRate:24000});
 job.resolve({samples:new Float32Array([.1,.2,.3,.4]).buffer,sampleRate:24000});
 await running;assert.equal(chunks.length,2,'Final full audio must not repeat streamed sentences');
 const replay=await engine.synthesize('First sentence. Second sentence.');
 assert.equal(requests,1);assert.deepEqual(Buffer.concat(chunks.map(chunk=>chunk.subarray(44))),replay[0].subarray(44));
});
test('cancellation discards late sentence callbacks and prevents further text generation',async t=>{
 const engine=new NativeSpeechEngine({normalizer:plain});t.after(()=>engine.close());
 let job,stopped=false,requests=0;const chunks=[];
 engine.worker=async()=>({send(){requests++;job=engine.ttsJob;}});
 const running=engine.synthesize('A sentence with several words. '.repeat(20),{onChunk:chunk=>chunks.push(chunk),isCancelled:()=>stopped});
 await new Promise(resolve=>setImmediate(resolve));
 const audio={samples:new Float32Array(100).buffer,sampleRate:24000};
 job.onChunk(audio);stopped=true;job.onChunk(audio);job.resolve(audio);await running;
 assert.equal(chunks.length,1);assert.equal(requests,1);
});
