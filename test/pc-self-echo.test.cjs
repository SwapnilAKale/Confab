'use strict';
// Self-recognition (src/pc/self-echo.cjs): Confab's own reply coming back through the microphone, at any loudness and
// delay a room gives it, never counts as the user; a voice talking over it does.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SelfEcho,VoiceMeter,pitchStrength}=require('../src/pc/self-echo.cjs'),{speech,cough,pcm16,rms,microphone}=require('./helpers/speech-sim.cjs');
const OUT=24000;
// Plays a 10 s reply after 2 s of quiet room; returns the first time (s after the reply starts) the meter says
// "the user is speaking", or null, and what was learnt.
function run({gain,delayMs,userLevel=null,userAt=5,seed=1,sound=null}){
 let now=100000;const selfEcho=new SelfEcho({clock:()=>now}),meter=new VoiceMeter({selfEcho});
 const feed=(mic,from=0)=>{let first=null;for(let i=0;i<mic.length;i+=320){now+=20;meter.push(pcm16(mic.subarray(i,i+320)),now);if(first===null&&meter.voiced())first=from+i/16000;}return first;};
 feed(microphone({output:new Float32Array(1),outRate:OUT,seconds:2,delayMs,gain,seed:seed+50}));
 const reply=speech(10,OUT,{seed,pitch:190,level:0.3});selfEcho.startReply();for(let i=0;i<reply.length;i+=OUT)selfEcho.play(pcm16(reply.subarray(i,i+OUT)),OUT);
 let user=null;if(userLevel!==null){user=sound?sound(seed):speech(4,16000,{seed:seed+99,pitch:120,level:1});const echo=rms(microphone({output:reply,outRate:OUT,seconds:10,delayMs,gain,noise:0}).subarray(16000)),k=echo*userLevel/rms(user);for(let i=0;i<user.length;i++)user[i]*=k;}
 return {first:feed(microphone({output:reply,outRate:OUT,seconds:10,delayMs,gain,user,userAt,seed:seed+3})),learnt:selfEcho.status()};
}

test('its own reply never counts as the user, at any echo loudness or delay, for 20 different replies',()=>{
 // 20 reply sounds, among them 7 (learnt its loudness too low before) and 70 (a steady rhythm that fits one beat late).
 const seeds=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,70,138];
 for(const gain of [0.1,0.5,1.5])for(const delayMs of [30,150,300])for(const seed of seeds){
  const r=run({gain,delayMs,seed});assert.equal(r.first,null,`echo gain ${gain}, delay ${delayMs} ms, seed ${seed}: not the user`);
  assert.equal(r.learnt.learnt,true);assert.ok(Math.abs(r.learnt.delayMs-delayMs)<=80,`delay ${delayMs} ms learnt as ${r.learnt.delayMs} ms`);
 }
});

test('a voice talking over the reply is the user: usually within about 0.6 s; at most 2.2 s at 1.5 times the echo loudness, 1.7 s at twice, 1 s at 3 times',()=>{
 // Many seeds and start times, so the slow cases (the user starting while the reply is loud) are included.
 for(const [level,limit] of [[1.5,2.2],[2,1.7],[3,1]]){const latencies=[];
  // 108 runs per level: echo gains, delays, seeds and start times the slow cases come from.
  for(const gain of [0.05,0.3,1])for(const delayMs of [40,200,400])for(const seed of [1,2,3,4])for(const userAt of [2.3,4.1,6.7]){
   const r=run({gain,delayMs,userLevel:level,userAt,seed});const label=`x${level} gain ${gain} delay ${delayMs} seed ${seed} at ${userAt}`;
   assert.ok(r.first!==null&&r.first>=userAt,label+': interrupted after the user started');latencies.push(r.first-userAt);assert.ok(r.first-userAt<=limit,label+': within '+limit+' s, took '+(r.first-userAt).toFixed(2));}
  const sorted=latencies.sort((a,b)=>a-b);assert.ok(sorted[Math.floor(sorted.length/2)]<=0.7,`x${level}: median ${sorted[Math.floor(sorted.length/2)].toFixed(2)} s`);
 }
});

test('playback stopped: output that never played is not expected back; after the echo dies away the room is quiet again',()=>{
 let now=0;const selfEcho=new SelfEcho({clock:()=>now});
 selfEcho.play(pcm16(new Float32Array(OUT*5).fill(0.2)),OUT);assert.ok(selfEcho.sounding(1000));
 now=1000;selfEcho.stop();assert.ok(selfEcho.end<=1000,'queued output is dropped');
 assert.equal(selfEcho.sounding(1000+480+300+1),false,'no echo expected after the delay and tail');
});

test('before anything is learnt, sound during playback is not taken for the user',()=>{
 let now=0;const selfEcho=new SelfEcho({clock:()=>now});selfEcho.play(pcm16(new Float32Array(OUT).fill(0.2)),OUT);
 assert.deepEqual(selfEcho.hear(100,0.5,0.005),{echo:true,user:false});
 assert.deepEqual(selfEcho.hear(5000,0.5,0.005),{echo:false,user:true},'once Confab is silent, loud sound is the user again');
});

test('a cough (0.3-0.9 s, 1-2 bursts) does not stop the reply at 3 or 10 times the echo loudness; speech has a pitch, a cough does not',()=>{
 for(const [seconds,bursts] of [[0.3,1],[0.6,1],[0.9,2]])for(const level of [3,10])for(const gain of [0.1,1])for(const seed of [1,2]){
  const r=run({gain,delayMs:150,userLevel:level,userAt:4,seed,sound:s=>cough(seconds,1,{seed:s+7,bursts})});
  assert.equal(r.first,null,`cough ${seconds} s x${bursts} at ${level} times the echo, gain ${gain}, seed ${seed}: not an interruption`);}
 const vowel=speech(0.3,16000,{seed:3,pitch:150,level:0.3}).subarray(800,1440),noise=cough(0.3,1,{seed:4}).subarray(800,1440);
 assert.ok(pitchStrength(vowel)>0.6,'speech: '+pitchStrength(vowel).toFixed(2));assert.ok(pitchStrength(noise)<0.3,'cough: '+pitchStrength(noise).toFixed(2));
});

test('a cough that starts with a voiced grunt does not stop the reply: speech-like grunts up to 0.2 s, steady "uhh" grunts up to 0.17 s and the measured 0.2 s cases; a steady 0.5 s voice, or 0.6 s of speech, does',()=>{
 // The grunt: a pitched sound like the start of "uh" (speech-like, or a steady vowel), then the noise of the cough.
 const vowel=(seconds,pitch)=>{const n=Math.round(seconds*16000),out=new Float32Array(n);for(let i=0;i<n;i++){let v=0;for(let h=1;h<=6;h++)v+=Math.sin(2*Math.PI*h*pitch*i/16000)/h;out[i]=0.4*v*Math.min(1,i/160,(n-i)/160);}return out;};
 const join=(a,b)=>{const out=new Float32Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;};
 for(const [kind,grunts] of [['speech',[0.05,0.1,0.15,0.2]],['steady',[0.05,0.1,0.17]]])for(const grunt of grunts)for(const level of [3,10])for(const gain of [0.1,1])for(const seed of [1,5]){
  const sound=s=>join(kind==='speech'?speech(0.4,16000,{seed:s+40,pitch:140,level:0.6}).subarray(0,Math.round(grunt*16000)):vowel(grunt,140),cough(0.5,1,{seed:s}));
  const r=run({gain,delayMs:60,userLevel:level,userAt:4,seed,sound:s=>sound(s+7)});
  assert.equal(r.first,null,`${kind} ${grunt} s grunt then a cough at ${level} times the echo, gain ${gain}, seed ${seed}: not an interruption`);}
 // A steady 0.2 s "uhh" then a cough: before each frame had to be pitched on its own, the cough's first frames borrowed
 // the grunt's pitch and these interrupted.
 for(const delayMs of [60,300])for(const pitch of [140,200])for(const [seconds,bursts] of [[0.4,1],[0.8,2]]){
  const r=run({gain:2,delayMs,userLevel:2,userAt:3.3,seed:5,sound:s=>join(vowel(0.2,pitch),cough(seconds,1,{seed:s,bursts}))});
  assert.equal(r.first,null,`steady 0.2 s grunt at ${pitch} Hz then a ${seconds} s cough, delay ${delayMs} ms: not an interruption`);}
 // A sustained voiced sound is speech as far as anyone can tell: it interrupts.
 for(const gain of [0.1,1])for(const seed of [1,5]){
  const steady=run({gain,delayMs:60,userLevel:3,userAt:4,seed,sound:()=>vowel(0.5,140)});assert.ok(steady.first!==null&&steady.first>=4,`a steady 0.5 s voice interrupts (gain ${gain}, seed ${seed})`);
  const spoken=run({gain,delayMs:150,userLevel:3,userAt:4,seed,sound:s=>speech(0.6,16000,{seed:s+40,pitch:140,level:0.6})});assert.ok(spoken.first!==null&&spoken.first>=4,`0.6 s of speech interrupts (gain ${gain}, seed ${seed})`);}
});
