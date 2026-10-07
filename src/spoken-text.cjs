// Same-length display projection keeps original reply/chunk positions stable.
// Only prose formatting is masked. Inline/fenced code contents remain verbatim.
function spokenProjection(text){
 const out=text.split(''),protectedRanges=[];
 const mask=(start,end)=>{for(let i=start;i<end;i++)if(out[i]!=='\n'&&out[i]!=='\r')out[i]=' ';};
 for(const m of text.matchAll(/^( {0,3})(`{3,}|~{3,})[^\n]*$/gm))mask(m.index,m.index+m[0].length);
 let fence=null;for(const m of text.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm)){if(!fence)fence={start:m.index+m[0].length,mark:m[1][0]};else if(m[1][0]===fence.mark){protectedRanges.push([fence.start,m.index]);fence=null;}}if(fence)protectedRanges.push([fence.start,text.length]);
 for(const m of text.matchAll(/(`+)([^`\n]+)\1/g)){if(protectedRanges.some(([a,b])=>m.index>=a&&m.index<b))continue;mask(m.index,m.index+m[1].length);mask(m.index+m[0].length-m[1].length,m.index+m[0].length);protectedRanges.push([m.index,m.index+m[0].length]);}
 const protectedAt=i=>protectedRanges.some(([a,b])=>i>=a&&i<b);
 for(const m of text.matchAll(/^(?: {0,3}#{1,6}\s+|\s*[-+*]\s+|\s*>\s?)/gm))if(!protectedAt(m.index))mask(m.index,m.index+m[0].length);
 for(const m of text.matchAll(/^\s*(?:[-*_]\s*){3,}$/gm))if(!protectedAt(m.index))mask(m.index,m.index+m[0].length);
 for(const m of text.matchAll(/(\*\*|__|~~|\*)(?=\S)([\s\S]*?\S)\1/g))if(!protectedAt(m.index)){mask(m.index,m.index+m[1].length);mask(m.index+m[0].length-m[1].length,m.index+m[0].length);}
 // Single underscore emphasis must not consume snake_case identifiers.
 for(const m of text.matchAll(/(?<![\w])_(?=\S)([^_\n]*\S)_(?![\w])/g))if(!protectedAt(m.index)){mask(m.index,m.index+1);mask(m.index+m[0].length-1,m.index+m[0].length);}
 return out.join('');
}
module.exports={spokenProjection};
