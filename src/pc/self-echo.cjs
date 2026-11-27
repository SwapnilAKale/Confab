'use strict';
// Voice mode's self-recognition: telling the user's voice from Confab's own reply coming back through the microphone.
// Confab knows exactly what it plays, so it does not need a profile of its voice. It keeps the loudness of its own
// output over time (20 ms frames) and learns, from the start of each reply, how long that sound takes to come back
// into the microphone (delay) and how loud it arrives (gain). A microphone frame counts as the user only when it is
// clearly louder than the echo the playback predicts for that moment, and louder than the room's background. Barge-in
// needs enough such frames in a short window (VoiceMeter.voiced).
//
// - FRAME_MS: loudness frame length, for the microphone and the output alike.
// - CALIBRATE_MS: at the start of each reply, frames are used to learn delay and gain and never count as the user.
//   Delay and gain are kept from reply to reply; each reply refreshes them (the volume may have changed).
// - DELAYS_MS: echo delays tried (output handed over -> heard by the microphone), up to MAX_DELAY_MS.
// - SPREAD_MS: the prediction for a moment is the loudest output frame within this distance of the delayed time, so
//   small timing jitter between playback and capture does not make echo look unexplained.
// - ECHO_MARGIN: a frame is the user only when it is at least this many times the predicted echo.
// - TAIL_MS: after the last output frame, echo (room reverberation, buffered audio) is still predicted this long.
// - MIN_CALIBRATION_FRAMES: loud output frames needed to learn delay and gain; with fewer, the previous values stay.
const FRAME_MS=20,CALIBRATE_MS=600,MAX_DELAY_MS=480,DELAYS_MS=Array.from({length:MAX_DELAY_MS/20+1},(_,i)=>i*20),SPREAD_MS=20,ECHO_MARGIN=1.5,TAIL_MS=300,MIN_CALIBRATION_FRAMES=12;
// - GAIN_PERCENTILE: the echo's gain is this percentile of microphone/output ratios where the output is loud. The
//   median learnt it 25-30% low for some replies, so the loud end of a syllable could look like the user (4 of 120
//   simulated replies interrupted themselves); 0.65 removed that (0 of 360) with no slower interruptions.
const HISTORY_MS=10000,GAIN_PERCENTILE=0.65,DELAY_TIE=0.05;
function rmsFrames(pcm,rate,ms=FRAME_MS){const per=Math.max(1,Math.round(rate*ms/1000)),out=[];for(let off=0;off+1<pcm.length;off+=per*2){const end=Math.min(pcm.length,off+per*2);let s=0,n=0;for(let i=off;i+1<end;i+=2){const v=pcm.readInt16LE(i)/32768;s+=v*v;n++;}out.push({rms:Math.sqrt(s/n),ms:n/rate*1000});}return out;}
class SelfEcho{
 constructor({clock=Date.now}={}){this.clock=clock;this.out=[];this.end=0;this.gain=null;this.delayMs=null;this.mic=[];this.calibration=null;this.calibrations=0;}
 // A reply starts playing: its first CALIBRATE_MS teach delay and gain.
 startReply(){const now=this.clock();this.calibration={from:now,until:now+CALIBRATE_MS+MAX_DELAY_MS};}
 // Output PCM16 mono at `rate` handed to the speakers now. It plays after what is already queued.
 play(pcm,rate){const now=this.clock();let t=Math.max(now,this.end);for(const f of rmsFrames(pcm,rate)){this.out.push({t,rms:f.rms});t+=f.ms;}this.end=t;this.trim(now);}
 // Playback stopped: queued output that has not played yet will never be heard.
 stop(){const now=this.clock();this.out=this.out.filter(f=>f.t<now);this.end=Math.min(this.end,now);if(this.calibration&&this.calibration.until>now)this.finishCalibration(now);this.calibration=null;}
 trim(now){while(this.out.length&&this.out[0].t<now-HISTORY_MS)this.out.shift();while(this.mic.length&&this.mic[0].t<now-HISTORY_MS)this.mic.shift();}
 // Loudest output frame around time `t` (ms), the moment heard `delay` ms later.
 output(t){let max=0;for(let i=this.out.length-1;i>=0;i--){const f=this.out[i];if(f.t+FRAME_MS<t-SPREAD_MS)break;if(f.t<=t+SPREAD_MS&&f.rms>max)max=f.rms;}return max;}
 // Whether the speakers may be sounding at microphone time `t`.
 sounding(t){return this.out.length>0&&t>=this.out[0].t&&t<=this.end+(this.delayMs??MAX_DELAY_MS)+TAIL_MS;}
 // Predicted echo at microphone time `t`, or null when it cannot be predicted (not learnt yet).
 predicted(t){if(this.gain===null||this.delayMs===null)return null;return this.gain*this.output(t-this.delayMs);}
 // One microphone frame (RMS) that ended at time `t`. Returns {echo, user}: echo = playback could explain it.
 // `limit`: the room's background limit from VoiceMeter (a frame below it is never the user).
 hear(t,rms,limit){
  this.mic.push({t,rms});
  if(this.calibration&&t>this.calibration.until)this.finishCalibration(t);
  if(!this.sounding(t))return {echo:false,user:rms>=limit};
  if(this.calibration&&t>=this.calibration.from)return {echo:true,user:false};
  const p=this.predicted(t);if(p===null)return {echo:true,user:false};
  return {echo:true,user:rms>=limit&&rms>=ECHO_MARGIN*p};
 }
 // Learns delay and gain from the reply's opening: the delay whose delayed output best follows the microphone's
 // loudness (correlation of log levels), then the gain as the GAIN_PERCENTILE ratio microphone/output where the output is loud.
 finishCalibration(now){const c=this.calibration;this.calibration=null;if(!c)return;
  const mic=this.mic.filter(f=>f.t>=c.from&&f.t<=Math.min(now,c.until));if(mic.length<MIN_CALIBRATION_FRAMES)return;
  const fits=[];
  for(const d of DELAYS_MS){const xs=[],ys=[];for(const f of mic){const o=this.output(f.t-d);if(o>0){xs.push(Math.log(o+1e-4));ys.push(Math.log(f.rms+1e-4));}}
   if(xs.length<MIN_CALIBRATION_FRAMES)continue;fits.push({d,r:correlation(xs,ys)});}
  if(!fits.length)return;
  // A reply with a steady rhythm fits almost as well one beat late (a syllable every 0.4 s matched at 460 ms when the
  // echo came back after 50 ms). Real echo returns within a fraction of a beat, so the shortest delay that fits within
  // DELAY_TIE of the best one is taken.
  const top=Math.max(...fits.map(f=>f.r)),best=fits.find(f=>f.r>=top-DELAY_TIE);
  const pairs=mic.map(f=>({m:f.rms,o:this.output(f.t-best.d)})).filter(p=>p.o>0),loud=median(pairs.map(p=>p.o)),ratios=pairs.filter(p=>p.o>=loud).map(p=>p.m/p.o);
  if(ratios.length<MIN_CALIBRATION_FRAMES/2)return;
  this.delayMs=best.d;this.gain=percentile(ratios,GAIN_PERCENTILE);this.correlation=Math.round(best.r*100)/100;this.calibrations++;
 }
 status(){return {learnt:this.gain!==null,delayMs:this.delayMs,gain:this.gain===null?null:Math.round(this.gain*1000)/1000,correlation:this.correlation??null,calibrations:this.calibrations};}
}
function percentile(v,p){if(!v.length)return 0;const s=[...v].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(s.length*p))];}
function median(v){if(!v.length)return 0;const s=[...v].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];}
function correlation(x,y){const n=x.length,mx=x.reduce((a,b)=>a+b,0)/n,my=y.reduce((a,b)=>a+b,0)/n;let sxy=0,sxx=0,syy=0;for(let i=0;i<n;i++){const a=x[i]-mx,b=y[i]-my;sxy+=a*b;sxx+=a*a;syy+=b*b;}return sxx&&syy?sxy/Math.sqrt(sxx*syy):0;}

// Whether a stretch of audio has a pitch, as voiced speech does: the strongest normalised autocorrelation at a lag of
// 2.5-12.5 ms (a pitch of 80-400 Hz). A cough, a click, a clap or breath is noise and scores low; a vowel scores high.
const PITCH_MIN_LAG=40,PITCH_MAX_LAG=200,PITCHED=0.45;
function pitchStrength(x,maxLag=PITCH_MAX_LAG){const n=x.length,sq=new Float64Array(n+1);for(let i=0;i<n;i++)sq[i+1]=sq[i]+x[i]*x[i];let best=0;
 for(let lag=PITCH_MIN_LAG;lag<=maxLag&&lag<n-40;lag++){let s=0;for(let i=0;i+lag<n;i++)s+=x[i]*x[i+lag];const e0=sq[n-lag],e1=sq[n]-sq[lag];if(e0>0&&e1>0){const r=s/Math.sqrt(e0*e1);if(r>best)best=r;}}
 return best;}

// Voice-mode microphone: RMS of each 20 ms frame with the time it ended, and for each frame whether it is the user.
// A frame is the user when it is louder than the room's background (RATIO times the quietest fifth of the frames heard
// while Confab was silent, and at least MIN_RMS), clearly louder than Confab's own echo (SelfEcho), and pitched (its
// last 40 ms have a pitch, see pitchStrength). Barge-in: at least LOUD_FRAMES of the last WINDOW_FRAMES frames are
// the user (about 0.24 s within 0.6 s). Coughs, clicks and claps are mostly unpitched: a stray slice of one may pass the pitch test, or a short voiced grunt at a cough's start, but not 0.24 s of it.
// The 40 ms pitch window reaches back one frame, so the first frames of a cough after a voiced grunt borrowed the
// grunt's pitch (a 0.2 s grunt then a cough interrupted 34 of 648 simulated replies). Each frame must also be pitched
// within its own 20 ms (OWN_PITCHED, lags up to OWN_MAX_LAG = 100 Hz): 6 of 648, with no slower interruptions.
const OWN_PITCHED=0.35,OWN_MAX_LAG=160;
const LEVEL_HISTORY=250,WINDOW_FRAMES=30,LOUD_FRAMES=12,RATIO=3,MIN_RMS=0.005,PITCH_WINDOW=640;
class VoiceMeter{
 constructor({selfEcho=new SelfEcho(),rate=16000}={}){this.selfEcho=selfEcho;this.rate=rate;this.frame=Math.round(rate*FRAME_MS/1000);this.quiet=[];this.user=[];this.sum=0;this.n=0;this.recent=new Float32Array(PITCH_WINDOW);this.recentAt=0;}
 limit(){if(!this.quiet.length)return MIN_RMS;const s=[...this.quiet].sort((a,b)=>a-b);return Math.max(MIN_RMS,s[Math.floor(s.length*0.2)]*RATIO);}
 // The last PITCH_WINDOW samples, oldest first.
 window(){const w=new Float32Array(PITCH_WINDOW),k=this.recentAt%PITCH_WINDOW;w.set(this.recent.subarray(k));w.set(this.recent.subarray(0,k),PITCH_WINDOW-k);return w;}
 // Microphone PCM16 that arrived at time `now` (its last sample was captured about then).
 push(pcm,now=this.selfEcho.clock()){const total=pcm.length>>1;
  for(let i=0;i<total;i++){const v=pcm.readInt16LE(i*2)/32768;this.recent[this.recentAt++%PITCH_WINDOW]=v;this.sum+=v*v;if(++this.n===this.frame){const rms=Math.sqrt(this.sum/this.frame);this.sum=0;this.n=0;
   const t=now-(total-1-i)/this.rate*1000,heard=this.selfEcho.hear(t,rms,this.limit());
   if(!heard.echo){this.quiet.push(rms);if(this.quiet.length>LEVEL_HISTORY)this.quiet.shift();}
   // The pitch is computed only for frames that are loud enough to count, so quiet audio costs nothing.
   const w=heard.user&&this.recentAt>=PITCH_WINDOW?this.window():null,user=!!w&&pitchStrength(w)>=PITCHED&&(OWN_PITCHED<=0||pitchStrength(w.subarray(PITCH_WINDOW-this.frame),OWN_MAX_LAG)>=OWN_PITCHED);
   this.user.push(user);if(this.user.length>WINDOW_FRAMES)this.user.shift();}}}
 voiced(){return this.user.length>=WINDOW_FRAMES&&this.user.filter(Boolean).length>=LOUD_FRAMES;}
}
module.exports={SelfEcho,VoiceMeter,rmsFrames,pitchStrength,FRAME_MS,CALIBRATE_MS,ECHO_MARGIN,WINDOW_FRAMES,LOUD_FRAMES};
