// Admission control for speculative decoding only. Finals never enter this gate.
// Allow an immediate first preview for a new utterance, then budget at most
// roughly half the decoder time for previews using its measured previous cost.
class PreviewCadence {
 constructor({enabled=process.env.VOICE_ADAPTIVE_PREVIEWS==='1',now=Date.now}={}){Object.assign(this,{enabled,now});this.reset();}
 reset(){this.lastAt=-Infinity;this.lastUtterance=null;this.costMs=0;this.started=0;this.skipped=0;}
 get intervalMs(){return Math.max(1500,2*this.costMs);}
 allow(job){if(!job.preview)return true;const at=this.now();if(this.enabled&&job.utteranceId===this.lastUtterance&&at-this.lastAt<this.intervalMs){this.skipped++;return false;}this.lastAt=at;this.lastUtterance=job.utteranceId;this.started++;return true;}
 observe(job,ms){if(job?.preview&&Number.isFinite(ms)&&ms>=0)this.costMs=ms;}
 snapshot(){return {adaptive:this.enabled,intervalMs:this.intervalMs,started:this.started,skipped:this.skipped};}
}
module.exports={PreviewCadence};
