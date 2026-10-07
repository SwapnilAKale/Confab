const fs=require('node:fs');
function encodeFloatWave(samples,sampleRate=16000){
 const buffer=Buffer.alloc(44+samples.length*4);
 buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);
 buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(3,20);buffer.writeUInt16LE(1,22);
 buffer.writeUInt32LE(sampleRate,24);buffer.writeUInt32LE(sampleRate*4,28);buffer.writeUInt16LE(4,32);buffer.writeUInt16LE(32,34);
 buffer.write('data',36);buffer.writeUInt32LE(samples.length*4,40);
 for(let i=0;i<samples.length;i++)buffer.writeFloatLE(samples[i],44+i*4);
 return buffer;
}
function readWave(file){
 const b=fs.readFileSync(file);if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE')throw Error('Invalid WAV');
 let format,channels,sampleRate,bits,data;
 for(let p=12;p+8<=b.length;){const id=b.toString('ascii',p,p+4),size=b.readUInt32LE(p+4),start=p+8;if(start+size>b.length)throw Error('Truncated WAV');
  if(id==='fmt '){format=b.readUInt16LE(start);channels=b.readUInt16LE(start+2);sampleRate=b.readUInt32LE(start+4);bits=b.readUInt16LE(start+14);}
  if(id==='data')data=b.subarray(start,start+size);
  p=start+size+(size%2);
 }
 if(channels!==1||!data||!((format===3&&bits===32)||(format===1&&bits===16)))throw Error('Expected mono PCM16 or Float32 WAV');
 const width=bits/8,samples=new Float32Array(data.length/width);
 for(let i=0;i<samples.length;i++)samples[i]=format===3?data.readFloatLE(i*width):data.readInt16LE(i*width)/32768;
 return {samples,sampleRate};
}
function audioStats(samples,sampleRate=16000){
 let sum=0,peak=0,clipped=0,nearZero=0;
 for(const x of samples){sum+=x*x;peak=Math.max(peak,Math.abs(x));if(Math.abs(x)>=.99)clipped++;if(Math.abs(x)<.0001)nearZero++;}
 return {seconds:samples.length/sampleRate,samples:samples.length,sampleRate,rms:Math.sqrt(sum/Math.max(1,samples.length)),peak,clippedFraction:clipped/Math.max(1,samples.length),nearZeroFraction:nearZero/Math.max(1,samples.length)};
}
module.exports={encodeFloatWave,readWave,audioStats};

