const {PcmWindow}=require('./pcm-window.cjs');
const RATE=16000;
// Acoustic boundaries update one continuous turn. Only a confirmed endpoint,
// explicit flush, or the decode length limit may finalize its PCM.
class ContextTurns {
 constructor({settle=require('./turn-settings.cjs').DEFAULT_SETTLE,maxSeconds=24,previews=true,overlapSeconds=0}={}){
  if(!Number.isFinite(settle)||settle<=0||!Number.isFinite(maxSeconds)||maxSeconds<=0||maxSeconds>24)throw Error('Invalid speech turn limits');
  if(!Number.isFinite(overlapSeconds)||overlapSeconds<0||overlapSeconds>=maxSeconds||overlapSeconds>5)throw Error('Invalid speech context overlap');
  this.overlap=Math.round(overlapSeconds*RATE);this.overlapEnd=null;this.input=new PcmWindow();this.settle=settle;this.maxSeconds=maxSeconds;this.previews=previews;this.sequence=0;this.cut=0;this.group=null;
 }
 push(samples,events,{flush=false}={}){
  this.input.push(samples);const out=[],limit=Math.round(this.maxSeconds*RATE);
  if(this.group&&this.group.audioStart<this.input.start)throw Error('Speech context exceeded the audio buffer; unfinished audio was not submitted');
  const make=(start,end,open=new Set(),parts=[])=>({id:'turn-'+(++this.sequence),start,audioStart:this.overlapEnd===start?Math.max(this.input.start,start-this.overlap):start,end,open,parts,previewAt:-Infinity});
  const finish=(reason,end=this.group?.end)=>{
   const g=this.group;if(!g)return;this.group=null;if(end<=g.start&&g.audioStart===g.start)return;
   const parts=g.parts.filter(p=>p.end*RATE>g.start&&p.start*RATE<end).map(p=>({...p,start:Math.max(p.start,g.start/RATE),end:Math.min(p.end,end/RATE)}));
   out.push({type:'segment',utteranceId:g.id,samples:this.input.slice(g.audioStart,end).buffer,timing:{start:g.audioStart/RATE,end:end/RATE,commitStart:g.start/RATE,overlapSeconds:(g.start-g.audioStart)/RATE,contextOverlapSeconds:this.overlap/RATE,parts,reason,endpointAt:this.input.end/RATE}});this.cut=end;this.overlapEnd=reason==='length-limit'?end:null;
  };
  for(const e of events){
   if(e.type==='activity')out.push(e);
   if(!['activity','preview','segment'].includes(e.type)||!e.timing)continue;
   const start=Math.max(this.cut,this.input.start,Math.round(e.timing.start*RATE)),end=Math.min(this.input.end,Math.round(e.timing.end*RATE));
   if(end<=start){if(e.type==='segment')this.group?.open.delete(e.utteranceId);continue;}
   // No separate join-gap decision: a pause inside an unsealed turn remains PCM.
   if(!this.group)this.group=make(start,end);
   let g=this.group;g.end=Math.max(g.end,end);
   if(e.type==='segment'){g.open.delete(e.utteranceId);g.parts.push({...e.timing});}else g.open.add(e.utteranceId);
   while(g.end-g.audioStart>=limit){
    const boundary=g.audioStart+limit,tailEnd=g.end,open=new Set(g.open),parts=g.parts.filter(p=>p.end*RATE>boundary);
    finish('length-limit',boundary);
    if(tailEnd===boundary&&!this.overlap)break;
    this.group=g=make(boundary,tailEnd,open,parts);
    if(tailEnd===boundary)break;
   }
   g=this.group;
   if(g&&this.previews&&e.type!=='activity'&&g.end-g.start>=24000&&this.input.end-g.previewAt>=24000){g.previewAt=this.input.end;out.push({type:'preview',utteranceId:g.id,samples:this.input.slice(g.audioStart,g.end).buffer,timing:{start:g.audioStart/RATE,end:g.end/RATE,commitStart:g.start/RATE,overlapSeconds:(g.start-g.audioStart)/RATE,contextOverlapSeconds:this.overlap/RATE}});}
  }
  if(this.group&&(flush||(!this.group.open.size&&this.input.end-this.group.end>=this.settle*RATE)))finish(flush?'flush':'silence');
  return out;
 }
}
module.exports={ContextTurns};
