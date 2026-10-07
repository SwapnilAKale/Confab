const {test}=require('node:test'),assert=require('node:assert/strict');
const {PreviewCadence}=require('../src/preview-cadence.cjs'),{RecognitionQueue}=require('../src/recognition-queue.cjs');
test('expensive previews are skipped while final PCM and order are preserved',()=>{
 let now=0;const cadence=new PreviewCadence({enabled:true,now:()=>now}),q=new RecognitionQueue({cadence});
 const make=(id,preview=true,utteranceId='a')=>({id,preview,utteranceId,samples:new Float32Array([id]).buffer});
 const first=make(1);q.add(first);assert.equal(q.next(),first);cadence.observe(first,4000);
 now=4000;q.add(make(2));assert.equal(q.next(),null);assert.equal(q.preview,null,'No delayed stale preview can stall drain');
 const final=make(3,false);q.add(final);assert.equal(q.next(),final);assert.equal(cadence.skipped,1);
 now=4500;const next=make(4,true,'b');q.add(next);assert.equal(q.next(),next,'New utterance still receives its first preview');
 now=13000;q.add(make(5,true,'b'));assert.equal(q.next().id,5);cadence.reset();assert.equal(cadence.started,0);
});
test('baseline override and fast decoding retain normal preview cadence',()=>{
 let now=0;const adaptive=new PreviewCadence({enabled:true,now:()=>now}),baseline=new PreviewCadence({enabled:false,now:()=>now}),job={preview:true,utteranceId:'a'};
 assert.ok(adaptive.allow(job));adaptive.observe(job,200);now=1500;assert.ok(adaptive.allow(job));
 assert.ok(baseline.allow(job));baseline.observe(job,5000);assert.ok(baseline.allow(job));assert.ok(adaptive.allow({preview:false}));
});
