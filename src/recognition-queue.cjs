// Finals are authoritative. Keep only the newest waiting preview; never build a
// queue of obsolete speculative decodes while a person is still speaking.
class RecognitionQueue{
 constructor({cadence=null}={}){this.cadence=cadence;this.reset();}
 reset(){this.finals=[];this.preview=null;this.completed=new Set();}
 add(job){if(job.preview){if(!this.completed.has(job.utteranceId))this.preview=job;}else{this.finals.push(job);this.completed.add(job.utteranceId);if(this.preview?.utteranceId===job.utteranceId)this.preview=null;while(this.completed.size>200)this.completed.delete(this.completed.values().next().value);}}
 next(){if(this.finals.length)return this.finals.shift();const job=this.preview;this.preview=null;return job&&this.cadence&&!this.cadence.allow(job)?null:job;}
 mayShow(job){return !job.preview||!this.completed.has(job.utteranceId);}
 get seconds(){return this.finals.reduce((sum,j)=>sum+j.samples.byteLength/64000,0);}
}
module.exports={RecognitionQueue};
