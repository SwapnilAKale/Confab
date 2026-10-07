// Bounded, in-memory input history. Coordinates are samples since call start.
class PcmWindow {
 constructor(capacity=16000*32){this.data=new Float32Array(capacity);this.end=0;}
 get start(){return Math.max(0,this.end-this.data.length);}
 push(samples){for(let i=0;i<samples.length;i++)this.data[(this.end+i)%this.data.length]=samples[i];this.end+=samples.length;}
 slice(start,end=this.end){
  start=Math.max(this.start,Math.round(start));end=Math.min(this.end,Math.round(end));
  const out=new Float32Array(Math.max(0,end-start));for(let i=0;i<out.length;i++)out[i]=this.data[(start+i)%this.data.length];return out;
 }
 reset(){this.end=0;this.data.fill(0);}
}
module.exports={PcmWindow};
