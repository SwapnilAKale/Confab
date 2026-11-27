'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('events'),fs=require('fs'),path=require('path'),http=require('http'),{spawn}=require('child_process');
const {prepareReply}=require('../src/pc/reply-text.cjs'),{run}=require('../src/pc/resident.cjs'),sdk=require('../src/pc/client.cjs'),profileApi=require('../src/pc/profile.cjs');
const spoken=text=>{const r=prepareReply(text);assert.equal(r.ok,true,JSON.stringify(r));return r.text;};
const rejected=text=>{const r=prepareReply(text);assert.equal(r.ok,false,text);return r.detail;};
const said=text=>{const r=prepareReply(text);assert.equal(r.ok,true,text);return r.text;};

test('citation brackets are removed',()=>{assert.equal(spoken('Volume drives growth [1].'),'Volume drives growth.');assert.equal(spoken('Two studies agree [2, 3] and a third [4-6].'),'Two studies agree and a third.');});
test('parenthetical content is spoken with a pause, never stripped',()=>{assert.equal(spoken('Do 3 sets (RPE 8).'),'Do 3 sets, RPE 8.');assert.equal(spoken('Do 3 sets (RPE 8) today'),'Do 3 sets, RPE 8, today');assert.equal(spoken('Squat stalled (as of 2026-07-09).'),'Squat stalled, as of 2026-07-09.');assert.equal(spoken('Rest (about 2 minutes (longer if needed)) then go.'),'Rest, about 2 minutes, longer if needed, then go.');assert.equal(spoken('Log each set(s) carefully.'),'Log each sets carefully.');assert.equal(spoken('3. **Seated Machine Curl (Kg)** – 360 sets'),'Seated Machine Curl, Kg, 360 sets');});
test('semicolons are prose pauses',()=>{assert.equal(spoken('Rest well; eat enough.'),'Rest well, eat enough.');});
test('slashes read per for unit pairs and or for word alternatives',()=>{assert.equal(spoken('Aim for 12 sets/week.'),'Aim for 12 sets per week.');assert.equal(spoken('Ran at 12 km/h.'),'Ran at 12 km per hour.');assert.equal(spoken('Eat 1.6 g/kg of protein.'),'Eat 1.6 g per kg of protein.');assert.equal(spoken('Train 3/week.'),'Train 3 per week.');assert.equal(spoken('Do 10 reps/set.'),'Do 10 reps per set.');assert.equal(spoken('Run a push/pull split.'),'Run a push or pull split.');assert.equal(spoken('Try push/pull/legs.'),'Try push, pull or legs.');assert.equal(spoken('Use lbs/kg consistently.'),'Use lbs or kg consistently.');assert.equal(spoken('Lift w/ straps, and/or w/o a belt.'),'Lift with straps, and or without a belt.');});
test('numbers and numeric slashes are left for pronunciation',()=>{assert.equal(spoken('Total 1,200 kg at 8/10 of the way.'),'Total 1,200 kg at 8/10 of the way.');});
test('code, diffs, paths, links and JSON never silence a reply: they are said in a short form or described',()=>{
 assert.equal(said('const answer = 7;'),'The reply is on screen.','a reply that is only code');
 assert.equal(said('Run `npm test` now.'),'Run npm test now.');assert.equal(said('Then `npm install --save-dev typescript`.'),'Then the npm command.');
 assert.equal(said('Call parse_log() first.'),'Call parse log first.');
 assert.equal(said('--- a/x\n+++ b/x\n@@ -1 +1 @@\n'),'Changes to x.','a reply that is only a diff names its file');
 assert.equal(said(String.raw`C:\private\file.json`),'file dot json');
 assert.equal(said('Edit src/pc/client.cjs.'),'Edit client dot cjs.','a path is said as its file name, keeping the full stop');
 assert.equal(said('See /usr/local/bin for it.'),'See bin for it.');
 assert.equal(said('Read https://example.com first.'),'Read a link first.');
 assert.equal(said('{"sets": 3}'),'Data with sets.','a reply that is only data names its keys');
 assert.equal(rejected('   '),'empty');
 const long=said('word. '.repeat(1100));assert.ok(long.length<=5000+30&&long.endsWith('Full reply on screen.'),'a very long reply is read up to the limit');
});
test('a reply that starts with a path or code is still read: the path as its file name, a code block described',()=>{
 assert.equal(said('src/pc/reply-text.cjs now handles paths. The tests pass.'),'reply text dot cjs now handles paths. The tests pass.');
 assert.equal(said(String.raw`The settings file is at C:\Users\A\AppData\Local\Confab\resident\settings.json and you can edit it.`),'The settings file is at settings dot json and you can edit it.');
 assert.equal(said(String.raw`I put the build in C:\Users\A\Desktop\AI\Confab and it runs.`),'I put the build in Confab and it runs.');
 assert.equal(said('Open ~/notes/todo.md or ./scripts/run.sh to see it.'),'Open todo dot md or run dot sh to see it.');
 assert.equal(said('I updated README.md and docs/DEVELOPER_GUIDE.md.'),'I updated README dot md and DEVELOPER GUIDE dot md.');
 assert.equal(said('Here is the change:\n```js\nconst x = 1;\nfoo(x);\n```\nThat fixes the bug.'),'Here is the change.\nJavaScript code, two lines.\nThat fixes the bug.');
 assert.equal(said('Press `Ctrl+Shift+5`, then call `voiceUnits` from `controller.cjs`.'),'Press Ctrl Shift 5, then call voiceUnits from controller dot cjs.');
 // Words with slashes, dates and versions are not paths.
 assert.equal(said('The date is 10/04/2026, push/pull days stay, at 80 km/h. Version 2.4.1 is out.'),'The date is 10/04/2026, push or pull days stay, at 80 km per hour. Version 2.4.1 is out.');
});

test('endpoint requires id, explains every rejection, and logs without text',{skip:process.platform!=='win32'},async t=>{
 const profile=fs.mkdtempSync(path.resolve('test-output/resident-contract-'));const played=[],said=[];
 const tray=new EventEmitter();Object.assign(tray,{ready:Promise.resolve(),update(){},failure(){},async close(){}});
 const input=new EventEmitter();Object.assign(input,{ready:Promise.resolve({}),api:{setClipboard(){}},request:async()=>{},setPaused(){return true;},close(){},insert:async()=>({status:'inserted'})});
 const audio=new EventEmitter();Object.assign(audio,{probe:async()=>{},loadingCue:async()=>{},cue:async()=>{},start(){},stop(){},stopPlayback(){},async playWav(w){played.push(w.toString());},close:async()=>{}});
 const engine={warmup:async()=>{},start:async()=>{},audio(){},end(){},cancel(){},close(){},synthesize:async(text,{onChunk})=>{said.push(text);onChunk(Buffer.from(text));return [];}};
 const app=await run(process.cwd(),{profile,createTray:()=>tray,createInput:()=>input,createAudio:()=>audio,engineFactory:()=>engine,idleMs:60000});t.after(async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});});
 const link=profileApi.connection(profile);
 const post=(body,headers={authorization:'Bearer '+link.token})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:link.port,path:'/event',method:'POST',headers},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(b)}));});req.on('error',reject);req.end(typeof body==='string'?body:JSON.stringify(body));});
 const secret='Private reply text that must never be logged.';
 // Gives a session the pending talk-back, as talk-back dictation followed by its prompt would.
 const talk=(agent,sessionId)=>{app.gate.dictated('please talk back');return post({event:'turn',text:'please talk back',agent,sessionId});};
 assert.deepEqual(await post({event:'reply',text:secret,agent:'custom-agent',sessionId:'s'}),{status:400,accepted:false,reason:'missing_id'});
 assert.deepEqual(await post({event:'reply',text:secret,agent:'custom-agent',sessionId:'s'}),{status:400,accepted:false,reason:'missing_id'},'a missing id never turns into a later duplicate');
 assert.equal((await post('not json')).reason,'invalid_json');
 // Windows PowerShell with $OutputEncoding = UTF-8 pipes a byte-order mark before the JSON; that must not reject the call.
 assert.deepEqual(await post('\uFEFF'+JSON.stringify({event:'turn',text:'x',agent:'bom-agent',sessionId:'s'})),{status:200,accepted:true,reason:'no_match'});
 assert.equal((await post({event:'reply',text:'Hi.',id:'1',sessionId:'s'})).reason,'invalid_identity');
 assert.equal((await post({event:'shout',agent:'a',sessionId:'s'})).reason,'unknown_event');
 assert.equal((await post({event:'reply',text:7,id:'1',agent:'a',sessionId:'s'})).reason,'invalid_text');
 assert.equal((await post({event:'reply',text:'Hi.',id:7,agent:'a',sessionId:'s'})).reason,'invalid_id');
 assert.equal((await post({},{origin:'http://evil.test',authorization:'Bearer '+link.token})).reason,'browser_request');
 assert.equal((await post({},{authorization:'Bearer wrong'})).reason,'unauthorized');
 assert.equal((await post({},{host:'localhost:'+link.port,authorization:'Bearer '+link.token})).reason,'bad_host');
 assert.equal((await talk('custom-agent','s')).reason,'match');
 assert.deepEqual(await post({event:'reply',text:'Do 3 sets (RPE 8) for push/pull days [1].',id:'r1',agent:'custom-agent',sessionId:'s'}),{status:202,accepted:true,reason:'queued'});
 assert.deepEqual(await post({event:'reply',text:'Again.',id:'r1',agent:'custom-agent',sessionId:'s'}),{status:200,accepted:false,reason:'duplicate'});
 await talk('custom-agent','s');
 // With the default opening-only limit, a reply that is all code says the reply is on screen.
 assert.deepEqual(await post({event:'reply',text:'const x = 1;',id:'r2',agent:'custom-agent',sessionId:'s'}),{status:202,accepted:true,reason:'queued'});
 await app.controller.speech;assert.deepEqual(said,['Do 3 sets, RPE 8, for push or pull days.','The reply is on screen.']);
 // The removed per-turn dedupe mode no longer exempts a reply from its id.
 assert.equal((await post({agent:'claude-code',sessionId:'c',event:'reply',text:'Done.',dedupe:'turn'})).reason,'missing_id');
 await app.control('readAloud');assert.equal((await sdk.speak('Muted.',{profile,agent:'a'})).reason,'disabled');await app.control('readAloud');assert.equal(app.state().readMode,'talkback');
 await app.control('pause');assert.equal((await sdk.speak('Paused.',{profile,agent:'a'})).reason,'paused');await app.control('pause');
 const health=await sdk.status({profile});assert.equal(health.requests.byReason.missing_id,3);assert.equal(health.requests.byReason.bad_host,1);assert.equal(health.lastRejected.reason,'paused');assert.equal(health.lastRejected.agent,'a');assert.ok(health.requests.accepted>=1);
 const log=fs.readFileSync(path.join(profile,'requests.jsonl'),'utf8');assert.equal(log.trim().split('\n').length,health.requests.total);assert.ok(!log.includes('Private reply')&&!log.includes('RPE')&&!log.includes(link.token)&&!log.includes('"r1"'),'log holds no text, ids or tokens');
 for(const line of log.trim().split('\n'))assert.deepEqual(Object.keys(JSON.parse(line)).filter(k=>!['at','route','event','agent','session','turn','status','accepted','reason','detail','decision'].includes(k)),[]);
 // The Python client discovers, authenticates, generates an id and returns the service result.
 // Async spawn: the resident under test shares this event loop.
 app.gate.dictated('please talk back');
 const py=await new Promise(resolve=>{const child=spawn(process.env.PYTHON||'python',['-c','import sys,json;sys.path.insert(0,sys.argv[1]);import confab as lv;t=lv.turn("please talk back",agent="py",profile=sys.argv[2]);print(json.dumps([t["reason"],lv.speak("Rest 2 minutes (or longer).",agent="py",profile=sys.argv[2],turn_id=t["turnId"]),lv.event({"event":"reply","text":"Hi."},agent="py",profile=sys.argv[2]),lv.speak("x",profile=sys.argv[3])]))',path.resolve('src/pc'),profile,path.join(profile,'missing')] ,{windowsHide:true});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',error=>resolve({error}));child.on('close',status=>resolve({status,stdout,stderr}));});
 if(py.error||py.status!==0){t.diagnostic('Python unavailable: '+(py.error?.message||py.stderr));return;}
 assert.deepEqual(JSON.parse(py.stdout),['match',{accepted:true,reason:'queued',status:202},{accepted:false,reason:'missing_id',status:400},{accepted:false,reason:'unavailable'}]);
});
test('markdown is flattened before speech',()=>{assert.equal(spoken('**Seated Machine Curl** - 3 sets at RPE 8/10.'),'Seated Machine Curl, 3 sets at RPE 8 out of 10.');assert.equal(spoken('Use *slow* eccentrics and __full__ range, ~~not~~ partials.'),'Use slow eccentrics and full range, not partials.');assert.equal(spoken('## Today\nSquat heavy.'),'Today.\nSquat heavy.');assert.equal(spoken('> Rest well.'),'Rest well.');assert.equal(spoken('Use `Lat Pulldown` today.'),'Use Lat Pulldown today.');assert.equal(spoken('See [the guide](https://example.com/a) first.'),'See the guide first.');assert.equal(spoken('| Lift | Sets |\n|---|---|\n| Squat | 5 |'),'Lift, Sets.\nSquat, 5.');assert.equal(spoken('Keep snake_case_name and 5 * 3.'),'Keep snake_case_name and 5 times 3.');assert.ok(!/[*#`]/.test(spoken('# A\n**b** *c* `d`')));});
test('numbered and bulleted lists drop markers and pause between items',()=>{assert.equal(spoken("Today's plan: 1. Squats 2. Bench 3. Rows"),"Today's plan: Squats. Bench. Rows.");assert.equal(spoken('1. Squats 2. Bench 3. Rows'),'Squats. Bench. Rows.');assert.equal(spoken('Plan:\n1. Squats\n2) Bench\n- Rows\n* Curls\n+ Dips\n• Plank'),'Plan.\nSquats.\nBench.\nRows.\nCurls.\nDips.\nPlank.');assert.equal(spoken('Plan: • Squat • Bench'),'Plan: Squat. Bench');assert.equal(spoken('Step 1. Warm up and 2. Lift'),'Step 1. Warm up and 2. Lift');assert.equal(spoken('Version 2. Then go.'),'Version 2. Then go.');});
test('scale ratios read out of only in rating context',()=>{assert.equal(spoken('Hit RPE 8/10.'),'Hit RPE 8 out of 10.');assert.equal(spoken('Effort was 7/10 today.'),'Effort was 7 out of 10 today.');assert.equal(spoken('Rated it 4/5.'),'Rated it 4 out of 5.');assert.equal(spoken('Sleep score: 85/100.'),'Sleep score: 85 out of 100.');assert.equal(spoken('That was 9/10 RPE.'),'That was 9 out of 10 RPE.');assert.equal(spoken('Add 3/4 cup of oats.'),'Add 3/4 cup of oats.');assert.equal(spoken('Deload on 10/04.'),'Deload on 10/04.');});
test('regression sentences from the live check',()=>{assert.equal(spoken('Do 3 sets (RPE 8) on push/pull days, about 12 sets/week [1].'),'Do 3 sets, RPE 8, on push or pull days, about 12 sets per week.');assert.equal(spoken('**Seated Machine Curl** - 3 sets at RPE 8/10.'),'Seated Machine Curl, 3 sets at RPE 8 out of 10.');assert.equal(spoken("Today's plan: 1. Squats 2. Bench 3. Rows"),"Today's plan: Squats. Bench. Rows.");});
test('inline code that is not plain words is said as code on screen; a short command as it is',()=>{assert.equal(said('Run `npm test` now.'),'Run npm test now.');assert.equal(said('Set `max_sets=5` there.'),'Set the code on screen there.');assert.equal(said('```\nx\n```'),'Code, one line.');});
test('speech units: short first unit (long first sentence split at a clause), then growing units of whole sentences',()=>{const {speechUnits}=require('../src/pc/reply-text.cjs');
 const units=speechUnits('All three fixes are done and running in the new version, and every automated test passes on this machine. The microphone is faster. The badge is clearer. Focus is tracked while you talk, and the text is copied if you stop elsewhere. Done.');
 assert.equal(units[0],'All three fixes are done','about 50 characters, split before a clause word');assert.ok(units[0].length<=50);
 assert.ok(units[1].startsWith('and running in the new version'));assert.ok(units[1].length<=120);assert.ok(units.slice(2).every(u=>u.length<=160));
 assert.deepEqual(speechUnits('Short one. Second sentence here.'),['Short one. Second sentence here.'],'short sentences merge within 50 characters');assert.deepEqual(speechUnits('Short one. A second sentence that is clearly longer than the cap.'),['Short one.','A second sentence that is clearly longer than the cap.']);assert.deepEqual(speechUnits('Short. Also short.'),['Short. Also short.']);
 const noComma='A'.repeat(95)+' end.';assert.deepEqual(speechUnits(noComma),[noComma],'no clause boundary: the sentence stays whole');
 assert.equal(require('../src/pc/reply-text.cjs').prepareReply('About 0.57–0.60 s → done ✓ in 115 ms.').text,'About 0.57 to 0.60 seconds to done in 115 milliseconds.');});
test('spoken opening: first prose paragraph, at most N sentences and M characters, cut flagged',()=>{const {spokenOpening}=require('../src/pc/reply-text.cjs');
 const reply='The fix is in and all tests pass. Speech now starts in about two seconds. One more detail here. And a fourth sentence.\n\n## Details\n- item one\n```js\ncode()\n```';
 assert.deepEqual(spokenOpening(reply),{text:'The fix is in and all tests pass. Speech now starts in about two seconds. One more detail here.',cut:true});
 assert.deepEqual(spokenOpening(reply,{sentences:1,chars:400}),{text:'The fix is in and all tests pass.',cut:true});
 assert.equal(spokenOpening(reply,{sentences:3,chars:60}).text,'The fix is in and all tests pass.','character cap ends at a whole sentence');
 assert.deepEqual(spokenOpening('Short answer.'),{text:'Short answer.',cut:false});
 assert.equal(spokenOpening('# Title\n\nOpening line after the heading.\n\n- list').text,'Opening line after the heading.');
 assert.equal(spokenOpening('Intro line:\n- first\n- second').text,'Intro line:','a list ends the opening');
 assert.deepEqual(spokenOpening(reply,{sentences:0,chars:0}),{text:reply,cut:false},'0 and 0 = full reply');});
test('spoken reply: paths and code in the opening are said in a short form, never silencing the reply',()=>{const {spokenReply}=require('../src/pc/reply-text.cjs');
 assert.deepEqual(spokenReply('I added the rule. I saved a backup as `settings.json.bak` in your folder. They apply to new sessions.\n\n- details',{sentences:3,chars:400}),{ok:true,text:'I added the rule. I saved a backup as settings dot json dot bak in your folder. They apply to new sessions. Full reply on screen.',opening:true});
 assert.deepEqual(spokenReply('Run `npm test` now.',{sentences:3,chars:400}),{ok:true,text:'Run npm test now.',opening:true},'a short command is said as it is');
 assert.deepEqual(spokenReply('src/pc/x.cjs is fixed. Tests pass.',{sentences:3,chars:400}),{ok:true,text:'x dot cjs is fixed. Tests pass.',opening:true},'a reply that starts with a path');
 assert.deepEqual(spokenReply('const x = 1;',{sentences:3,chars:400}),{ok:true,text:'The reply is on screen.',opening:true});
 assert.deepEqual(spokenReply('It is done: all good.',{sentences:3,chars:400}),{ok:true,text:'It is done: all good.',opening:true});
 assert.deepEqual(spokenReply('Edit src/pc/client.cjs, then run `npm test`. The fix is in.'),{ok:true,text:'Edit client dot cjs, then run npm test. The fix is in.'},'full-reply mode reads it too');});

test('code blocks, diffs, commands and data are described in a few words: what, how big, what they name',()=>{const {describeBlock,fileName,spokenReply}=require('../src/pc/reply-text.cjs');
 const d=(info,body)=>describeBlock(info,body,fileName);
 assert.equal(d('python','import json\n\ndef load_config(path):\n    with open(path) as f:\n        return json.load(f)\n\ndef save_config(path, data):\n    json.dump(data, open(path, "w"))'),'Python code, six lines, defining load config and save config.');
 assert.equal(d('js','const renderList = (items) => items.map(x => x.name);\nfunction mount(el) {}\nclass Store {}'),'JavaScript code, three lines, defining render list, mount and store.');
 assert.equal(d('java','public class Foo {\n  public static void main(String[] args) {}\n  private int count(int x) { return x; }\n}'),'Java code, four lines, defining foo, main and count.');
 assert.equal(d('ts','export function a() {}\nexport function b() {}\nexport function c() {}\nexport function e() {}'),'TypeScript code, four lines, defining a, b, c and one more.');
 assert.equal(d('','def main():\n    print(1)'),'Python code, two lines, defining main.','no tag: the language is guessed');
 assert.equal(d('elixir','defmodule Hello do\nend'),'Elixir code, two lines.','an unknown tag is said as the language');
 assert.equal(d('','x'),'Code, one line.');assert.equal(d('',''),'Code on screen.');
 assert.equal(d('bash','npm test'),'npm test.','a short plain command is said as it is');
 assert.equal(d('powershell','git fetch --all\ngit rebase origin/main\nnpm install --save-dev typescript'),'Commands for git and npm, three lines.');
 assert.equal(d('bash','docker compose up --build -d'),'A docker command.');
 assert.equal(d('json','{"name":"confab","version":"1.0","scripts":{},"license":"MIT"}'),'Data with name, version, scripts and one more.');
 assert.equal(d('json','[1,2,3]'),'A list of three items.');
 assert.equal(d('yaml','name: confab\nversion: 2\nmodels:\n  - a'),'YAML, four lines, with name, version and models.');
 assert.equal(d('diff','--- a/src/pc/controller.cjs\n+++ b/src/pc/controller.cjs\n@@ -1 +1,2 @@\n-const T=1;\n+const T=2;\n+// longer'),'Changes to controller dot cjs: two lines added, one line removed.');
 assert.equal(d('output','line one\nline two'),'Output on screen, two lines.');
 // In a reply, the description takes the block's place and the prose around it is read as before.
 assert.deepEqual(spokenReply('Run this:\n```bash\nnpm test\n```'),{ok:true,text:'Run this.\nnpm test.'});
 assert.deepEqual(spokenReply('Run this:\n```bash\nnpm test\n```',{sentences:3,chars:400}),{ok:true,text:'Run this: npm test.',opening:true});
 assert.deepEqual(spokenReply('I changed the timeout.\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\nThat should fix it.'),{ok:true,text:'I changed the timeout.\nChanges to x dot js: one line added, one line removed.\nThat should fix it.'});
 assert.deepEqual(spokenReply('```json\n{"sets": 3}\n```'),spokenReply('{"sets": 3}'),'JSON in a block or on its own line is described the same way');
 assert.deepEqual(spokenReply('```python\ndef a():\n    pass\n```'),spokenReply('```python\ndef a():\n    pass\n```'),'the same block is always described the same way');
});

test('punctuation after a path, an unclosed or stray fence, cmdlets and empty replies',()=>{const {describeBlock,fileName,spokenReply}=require('../src/pc/reply-text.cjs');
 const o={sentences:3,chars:400};
 // Punctuation after a Windows path stays out of the path, so its file name is still said.
 for(const [mark,rest] of [[',',' then save.'],['?',' Yes.'],[';',' done.'],[':',' now.'],['!','']])
  assert.match(spokenReply('Open C:\\x\\a.json'+mark+rest).text,/^Open a dot json[,?:!]/,mark);
 // A fence that is never closed runs only to the next blank line; the prose after it is still read.
 assert.equal(spokenReply('Here it is:\n```python\ndef a():\n    pass\n\nThat should work.').text,'Here it is.\nPython code, two lines, defining a.\nThat should work.');
 assert.deepEqual(spokenReply('Use this:\n```\nnpm test'),{ok:true,text:'Use this.\nnpm test.'},'a reply cut short inside a block');
 // A stray ``` in prose is not a block and does not silence the line.
 assert.equal(spokenReply('Type ```js to start a block.').text,'Type js to start a block.');
 assert.equal(spokenReply('Call ``a`b`` here.').text,'Call the code on screen here.','a double-backtick span is one span');
 // PowerShell cmdlets are said as words.
 assert.equal(describeBlock('powershell','Get-ChildItem src',fileName),'get child item src.');
 assert.equal(describeBlock('powershell','Get-ChildItem -Recurse src',fileName),'A get child item command.');
 assert.equal(describeBlock('powershell','Get-ChildItem -Recurse\nRemove-Item -Force x',fileName),'Commands for get child item and remove item, two lines.');
 // An empty reply, or one with nothing to say, is silent in both modes.
 for(const v of ['','   ',null,undefined,42]) assert.deepEqual(spokenReply(v,o),spokenReply(v),JSON.stringify(v));
 assert.equal(spokenReply('',o).ok,false);
});
