'use strict';
// Speech-like test audio for the self-echo tests: syllables 120-260 ms long with random loudness and word gaps, voiced
// with a pitch of `pitch` Hz and its harmonics plus a little noise. Deterministic for a seed. Float samples in -1..1.
function prng(seed){let s=seed>>>0||1;return ()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
function speech(seconds,rate,{seed=1,pitch=160,level=0.3}={}){
 const r=prng(seed),n=Math.round(seconds*rate),out=new Float32Array(n);let i=0,phase=0;
 while(i<n){
  const syllables=1+Math.floor(r()*4);
  for(let k=0;k<syllables&&i<n;k++){const len=Math.round((0.12+r()*0.14)*rate),amp=level*(0.4+r()*0.6),f0=pitch*(0.85+r()*0.3);
   for(let j=0;j<len&&i<n;j++,i++){const env=Math.sin(Math.PI*j/len);phase+=2*Math.PI*f0/rate;let v=0;for(let h=1;h<=6;h++)v+=Math.sin(h*phase)/h;out[i]=amp*env*(0.8*v/1.8+0.2*(r()*2-1));}}
  i+=Math.round((0.08+r()*0.25)*rate);
 }
 return out;
}
// A cough: `bursts` bursts of band-limited noise (no pitch) over `seconds`, each with a sharp attack and fast decay.
function cough(seconds,level,{seed=1,bursts=1}={}){const r=prng(seed),n=Math.round(seconds*16000),out=new Float32Array(n);let a=0,b=0;
 for(let i=0;i<n;i++){const x=r()*2-1;a=0.7*a+0.3*x;b=0.98*b+0.02*a;const k=(i/n*bursts)%1;out[i]=level*(a-b)*Math.exp(-6*k)*Math.min(1,k*40);}return out;}
// Float samples -> PCM16 Buffer.
function pcm16(samples){const b=Buffer.alloc(samples.length*2);for(let i=0;i<samples.length;i++)b.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(samples[i]*32767))),i*2);return b;}
function rms(samples){let s=0;for(const v of samples)s+=v*v;return Math.sqrt(s/samples.length);}
// What the microphone hears: the output (at outRate) delayed by delayMs, scaled by gain, with two room reflections,
// plus background noise and an optional user voice starting at userAt seconds. 16 kHz.
function microphone({output,outRate,seconds,delayMs,gain,noise=0.002,user=null,userAt=0,seed=7}){
 const rate=16000,n=Math.round(seconds*rate),mic=new Float32Array(n),r=prng(seed);
 const at=t=>{const k=Math.floor(t*outRate);return k>=0&&k<output.length?output[k]:0;};
 for(let i=0;i<n;i++){const t=i/rate-delayMs/1000;mic[i]=gain*(at(t)+0.35*at(t-0.023)+0.15*at(t-0.061))+noise*(r()*2-1);}
 if(user)for(let i=0;i<user.length;i++){const k=Math.round(userAt*rate)+i;if(k<n)mic[k]+=user[i];}
 return mic;
}
module.exports={speech,cough,pcm16,rms,microphone,prng};
