'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {check,format,sources}=require('../scripts/check-model-updates.cjs');
const OUT=path.join(__dirname,'..','test-output','model-updates');
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
// A manifest with one Hugging Face piece and one GitHub piece, and a fake get() that serves the APIs from a table.
function setup(name,pieces){
 const root=path.join(OUT,name+'-'+process.pid);fs.mkdirSync(path.join(root,'assets'),{recursive:true});
 fs.writeFileSync(path.join(root,'assets','live-models.json'),JSON.stringify({pieces}));return root;
}
const hfPiece=(watch={since:'2026-10-01'})=>({name:'Model',path:'m',download:{base:'https://huggingface.co/o/model/resolve/'+A+'/',extra:{'N.md':'repo:assets/notices/N.md'}},watch,files:[{path:'enc.onnx'},{path:'tokens.txt'},{path:'N.md'}]});
const ghPiece={name:'Vad',path:'v',download:{extra:{'vad.onnx':'https://raw.githubusercontent.com/o/vad/'+A+'/data/vad.onnx'}},watch:{since:'2026-10-01',githubReleases:'o/vad'},files:[{path:'vad.onnx'}]};
const tree=(enc,tok)=>[{type:'directory',path:'d'},{type:'file',path:'enc.onnx',oid:'x',lfs:{oid:enc}},{type:'file',path:'tokens.txt',oid:tok},{type:'file',path:'README.md',oid:'r'}];
function api(table){const seen=[];return {seen,get:async url=>{seen.push(url);if(!(url in table))throw Error(url+' answered 404');return table[url];}};}
const HF='https://huggingface.co/api/models/o/model',GH='https://api.github.com/repos/o/vad';

test('sources lists each pinned repository with the files taken from it, and skips files shipped in the repo',()=>{
 assert.deepEqual(sources(hfPiece()),[{kind:'huggingface',repo:'o/model',rev:A,files:{'enc.onnx':'enc.onnx','tokens.txt':'tokens.txt'}}]);
 assert.deepEqual(sources(ghPiece),[{kind:'github',repo:'o/vad',rev:A,files:{'vad.onnx':'data/vad.onnx'}}]);
});
test('a pinned source still at its revision, with nothing new published, is up to date',async()=>{
 const {get,seen}=api({[HF+'/revision/main']:{sha:A,lastModified:'2026-11-01T00:00:00Z'},'https://huggingface.co/api/models?author=o&search=model&limit=1000':[{id:'o/model',createdAt:'2026-11-01T00:00:00Z'},{id:'o/old',createdAt:'2025-01-01T00:00:00Z'}]});
 const report=await check(setup('current',[hfPiece({since:'2026-10-01',huggingface:[{author:'o',search:'model'}]})]),{get});
 assert.deepEqual(report,[{name:'Model',updates:[],newModels:[],errors:[]}],'the pinned repo itself and older models are not new');
 assert.equal(seen.some(u=>u.includes('/tree/')),false,'no file listing is needed');
 assert.match(format(report),/## Model\nUp to date\./);
});
test('a newer revision is reported with the files Confab uses that changed in it',async()=>{
 const {get}=api({[HF+'/revision/main']:{sha:B,lastModified:'2026-11-07T05:47:26Z'},[HF+'/tree/'+B+'?recursive=true']:tree('new','t'),[HF+'/tree/'+A+'?recursive=true']:tree('old','t')});
 const [r]=await check(setup('changed',[hfPiece()]),{get});
 assert.deepEqual(r.updates,[{where:'o/model',pinned:'aaaaaaa',latest:'bbbbbbb (2026-11-07)',changed:['enc.onnx']}]);
 assert.match(format([r]),/newer revision, bbbbbbb \(2026-11-07\) \(pinned: aaaaaaa\)\. Changed: enc\.onnx\./);
});
test('a newer revision that changes none of the files Confab uses, or one already reviewed, is not reported',async()=>{
 const {get}=api({[HF+'/revision/main']:{sha:B,lastModified:'2026-11-07T00:00:00Z'},[HF+'/tree/'+B+'?recursive=true']:tree('old','t'),[HF+'/tree/'+A+'?recursive=true']:tree('old','t')});
 assert.deepEqual((await check(setup('readme',[hfPiece()]),{get}))[0].updates,[],'only the README changed');
 const reviewed=api({[HF+'/revision/main']:{sha:C,lastModified:'2026-09-08T00:00:00Z'}});
 assert.deepEqual((await check(setup('reviewed',[hfPiece()]),{get:reviewed.get}))[0].updates,[],'dated before watch.since');
});
test('a GitHub file changed since its pinned commit, and a new release, are reported',async()=>{
 const {get}=api({[GH+'/commits?per_page=1']:[{sha:C,commit:{committer:{date:'2026-11-02T10:00:00Z'}}}],[GH+'/contents/data/vad.onnx']:{sha:'new'},[GH+'/contents/data/vad.onnx?ref='+A]:{sha:'old'},
  [GH+'/releases?per_page=20']:[{tag_name:'v7.0',published_at:'2026-11-02T10:00:00Z',html_url:'https://github.com/o/vad/releases/tag/v7.0'},{tag_name:'v6.9',published_at:'2026-11-01T00:00:00Z',draft:true},{tag_name:'v6.2',published_at:'2026-01-01T00:00:00Z'}]});
 const [r]=await check(setup('github',[ghPiece]),{get});
 assert.deepEqual(r.updates,[{where:'o/vad',pinned:'aaaaaaa',latest:'ccccccc (2026-11-02)',changed:['vad.onnx']}]);
 assert.deepEqual(r.newModels,[{name:'o/vad v7.0',date:'2026-11-02',url:'https://github.com/o/vad/releases/tag/v7.0'}],'drafts and older releases are left out');
});
test('a source that cannot be reached is reported as an error, and the other pieces are still checked',async()=>{
 const {get}=api({[GH+'/commits?per_page=1']:[{sha:A,commit:{committer:{date:'2026-11-02T10:00:00Z'}}}],[GH+'/releases?per_page=20']:[]});
 const report=await check(setup('error',[hfPiece(),ghPiece]),{get});
 assert.match(report[0].errors[0],/revision\/main answered 404/);
 assert.deepEqual(report[1],{name:'Vad',updates:[],newModels:[],errors:[]});
 assert.match(format(report),/Could not check: .*404/);
});
test('the real manifest watches every piece',()=>{
 for(const p of require('../assets/live-models.json').pieces){
  assert.match(p.watch?.since||'',/^\d{4}-\d{2}-\d{2}$/,p.name+' has a watch.since date');
  assert.ok(p.watch.huggingface?.length||p.watch.githubReleases,p.name+' says where newer versions appear');
 }
});
