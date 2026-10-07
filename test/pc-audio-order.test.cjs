'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {WindowsAudio}=require('../src/pc/windows-audio.cjs');
function fixture(){const blocks=[0,1,2].map(n=>({pointer:{flags:1,recorded:1},bytes:Buffer.from([n])}));const chunks=[];const audio=Object.create(WindowsAudio.prototype);audio.k={decode:p=>p,sizeof:()=>48};audio.fn={InAddBuffer:(_h,p)=>{p.flags=0;return 0;}};const capture={handle:1,blocks,queued:[blocks[2],blocks[0],blocks[1]],onData:b=>chunks.push(b[0])};return {audio,capture,blocks,chunks};}
test('native microphone drains completed buffers in queue order after ring wrap',()=>{const {audio,capture,chunks}=fixture();audio.drain(capture,false);assert.deepEqual(chunks,[2,0,1]);assert.equal(capture.queued.length,0);});
test('native microphone does not skip an earlier pending buffer',()=>{const {audio,capture,blocks,chunks}=fixture();blocks[2].pointer.flags=0;audio.drain(capture,true);assert.deepEqual(chunks,[]);assert.equal(capture.queued[0],blocks[2]);});
test('requeued buffers are delivered once and retain chronological queue order',()=>{const {audio,capture,chunks}=fixture();audio.drain(capture,true);audio.drain(capture,true);assert.deepEqual(chunks,[2,0,1]);assert.deepEqual(capture.queued.map(b=>b.bytes[0]),[2,0,1]);});
