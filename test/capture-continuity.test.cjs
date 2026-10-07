const {test}=require('node:test'),assert=require('node:assert/strict'),{PcmWindow}=require('../src/pcm-window.cjs');
// test/fixtures/speech-sample.wav: "Sitara, start the next set." spoken by the bundled Kokoro voice, 16 kHz mono.
test('bounded PCM retains chronological samples across wraparound',()=>{const w=new PcmWindow(5);w.push(Float32Array.from([0,1,2]));w.push(Float32Array.from([3,4,5,6]));assert.equal(w.start,2);assert.deepEqual(Array.from(w.slice(0)),[2,3,4,5,6]);assert.deepEqual(Array.from(w.slice(3,6)),[3,4,5]);w.reset();w.push(Float32Array.from([9]));assert.deepEqual(Array.from(w.slice(0)),[9]);});
test('native segmentation preserves onset and next utterances across bounded stream resets',()=>{
 const path=require('node:path'),{readWave}=require('../src/wav.cjs'),speech=readWave('test/fixtures/speech-sample.wav').samples;
 const input=new Float32Array(16000*77),starts=[1,58,61.5,65.2,70];for(const at of starts)input.set(speech,at*16000);
 const recognizer=require('../src/moonshine.cjs').createRecognizer(path.resolve('assets/models'),{segmentsOnly:true}),segments=[];
 try{for(let i=0;i<input.length;i+=1600)segments.push(...recognizer.push(input.subarray(i,i+1600)).filter(e=>e.type==='segment'));segments.push(...recognizer.flush().filter(e=>e.type==='segment'));}finally{recognizer.close();}
 assert.equal(segments.length,starts.length);let previousEnd=0;
 for(const [i,e] of segments.entries()){assert.ok(e.timing.start<=starts[i],JSON.stringify(e.timing));assert.ok(e.timing.start>=previousEnd);previousEnd=e.timing.end;const samples=new Float32Array(e.samples),begin=Math.round(e.timing.start*16000);assert.deepEqual(samples,input.slice(begin,begin+samples.length));}
});

test('call reset isolates native recurrent state and drops an in-flight old stream',async()=>{
 const path=require('node:path'),{readWave}=require('../src/wav.cjs'),{VadClient}=require('../src/vad-client.cjs'),input=readWave('test/fixtures/speech-sample.wav').samples;
 let chunks=[],resolve,reject,consumedSamples=0;const vad=new VadClient(path.resolve('assets/models'),{events(events,flushed){chunks.push(...events.filter(e=>e.type==='segment'));if(flushed)resolve(chunks);},consumed(n){consumedSamples+=n;},error(e){reject(e);}});
 async function run(){chunks=[];consumedSamples=0;const done=new Promise((r,j)=>{resolve=r;reject=j;});vad.reset();for(let i=0;i<input.length;i+=1600)vad.push(input.subarray(i,i+1600));vad.flush();const result=await done;assert.equal(consumedSamples,input.length);return result;}
 try{const first=await run();assert.ok(first.length);vad.reset();vad.push(new Float32Array(3200).fill(.5));const second=await run();const signature=events=>events.map(({samples,timing})=>({timing,hash:require('node:crypto').createHash('sha256').update(Buffer.from(samples)).digest('hex')}));assert.deepEqual(signature(second),signature(first));assert.deepEqual(signature(await run()),signature(first));}finally{vad.close();}
});
