// Commit stable words and reserve the boundary ending for the next decode.
// Exact suffix matching only locates the handoff; it cannot rewrite stable text.
const key=text=>text.trim().toLowerCase().replace(/[\u2018\u2019]/g,"'").replace(/^["'\u201c\u201d]+|[.,!?"\u201c\u201d]+$/g,'');
function contextualResult(result,{contextSeconds=0,holdSeconds=0,audioSeconds,overlapSeconds=3,previousText=''}={}){
 const trimSeconds=contextSeconds;
 const text=result.text||'';if(!text||(!trimSeconds&&!holdSeconds))return {text,pendingText:'',commitSeconds:audioSeconds,method:'none',contextSeconds:trimSeconds};
 const tokens=result.tokens,times=result.timestamps;
 if(!Array.isArray(tokens)||!Array.isArray(times)||tokens.length!==times.length||!Array.isArray(result.durations)||result.durations.length!==tokens.length||result.durations.some(t=>!Number.isFinite(t)||t<0)||tokens.join('').trim()!==text.trim()||times.some((t,i)=>!Number.isFinite(t)||t<0||(i>0&&t<times[i-1])))throw Error('Overlapping transcription needs valid token timing; draft retained for review');
 const words=[];for(let i=0;i<tokens.length;i++){
  if(!words.length||/^\s/.test(tokens[i]))words.push({raw:tokens[i],start:times[i],end:times[i]+result.durations[i]});else{words.at(-1).raw+=tokens[i];words.at(-1).end=Math.max(words.at(-1).end,times[i]+result.durations[i]);}
 }
 let cut=words.findIndex(w=>w.start>=trimSeconds);if(cut<0)cut=words.length;
 const previous=trimSeconds?previousText.trim().split(/\s+/).map(key).filter(Boolean):[],current=words.map(w=>key(w.raw));
 let best=null;
 // Exact suffix agreement near the timestamp boundary can recover a new word
 // whose timestamp drifts slightly into the prefix, or avoid repeating the
 // last committed word when its timestamp drifts past it. Repeated words away
 // from the boundary remain untouched.
 for(let end=1;end<=words.length;end++){
  if(words[end-1].start>trimSeconds+.4)continue;
  for(let count=Math.min(previous.length,end,12);count>=2;count--){
   if(previous.slice(-count).every((w,i)=>w===current[end-count+i])){
    const distance=Math.abs(end-cut),before=words[end-1].start<trimSeconds;if(!best||count>best.count||count===best.count&&(before&&!best.before||before===best.before&&distance<best.distance))best={end,count,distance,before};break;
   }
  }
 }
 if(best)cut=best.end;
 let stop=words.length;
 if(holdSeconds){stop=words.findIndex(w=>w.end>audioSeconds-holdSeconds);if(stop<0)stop=words.length;
  // Do not withhold the beginning of an unusually long identifier that will
  // lie outside the next decoder's audio. Keep that whole word stable instead.
  while(stop<words.length&&words[stop].start<audioSeconds-overlapSeconds+.2)stop++;
  stop=Math.max(cut,stop);
 }
 const render=a=>a.map(w=>w.raw).join('').trim();
 return {text:render(words.slice(cut,stop)),pendingText:render(words.slice(stop)),commitSeconds:stop<words.length?words[stop].start:audioSeconds,method:best?'preceding-suffix':trimSeconds?'timestamp':'initial',contextSeconds:trimSeconds,discardedWords:cut};
}
module.exports={contextualResult};
