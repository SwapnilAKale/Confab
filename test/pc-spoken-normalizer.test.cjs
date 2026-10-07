'use strict';
// Node pronunciation normaliser (replaces NeMo in the PC speech path). Per-category cases, the NeMo
// r1.2.0 reference comparison, and typical workout-coach replies.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalize,cardinal,ordinal,year}=require('../src/pc/spoken-normalizer.cjs');
const {compare}=require('../scripts/compare-normalizer.cjs');
const {spokenReply}=require('../src/pc/reply-text.cjs');
const cases=list=>{for(const [input,expected] of list)assert.equal(normalize(input),expected,input);};

test('cardinals, decimals and negatives',()=>{
 assert.equal(cardinal('0'),'zero');assert.equal(cardinal('123'),'one hundred twenty three');assert.equal(cardinal('1000000'),'one million');
 cases([['1,110 sets','one thousand one hundred ten sets'],['13000','thirteen thousand'],['004','zero zero four'],['96.6','ninety six point six'],
  ['.5','point five'],['-2','minus two'],['there -0.4kg','there minus zero point four kilograms'],['1,234.56','one thousand two hundred thirty four point five six']]);
});
test('ordinals and years',()=>{
 assert.equal(ordinal(21),'twenty first');assert.equal(ordinal(12),'twelfth');assert.equal(ordinal(30),'thirtieth');
 assert.equal(year('2026'),'twenty twenty six');assert.equal(year('2006'),'two thousand six');assert.equal(year('1906'),'nineteen oh six');assert.equal(year('1900'),'nineteen hundred');
 cases([['21st','twenty first'],['111th','one hundred eleventh'],['21th','twenty one th'],['in 1994','in nineteen ninety four'],['so far in 2026:','so far in twenty twenty six:'],['the 1980s','the nineteen eighties'],['mid-80s','mid eighties']]);
});
test('dates: ISO (any hyphen), month names, day first, numeric',()=>{
 cases([['on 2026-04-10.','on April tenth twenty twenty six.'],['on 2026‑04‑10.','on April tenth twenty twenty six.'],['May 17, 2026','May seventeenth, twenty twenty six'],
  ['Jan. 15','January fifteenth'],['17 May 2010','the seventeenth of May twenty ten'],['the 26th May','the twenty sixth of May'],['10/06/2005','the tenth of June two thousand five'],
  ['15.01.2020','the fifteenth of January twenty twenty'],['in March 2025','in March twenty twenty five']]);
});
test('times',()=>{
 cases([['01:00','one o\'clock'],['1:05 p.m.','one oh five PM'],['5pm','five PM'],['2pm-5pm','two PM to five PM'],['1:59 p.m. EST','one fifty nine PM EST'],['1:05:30 p.m.','one hour five minutes and thirty seconds PM']]);
});
test('money, including ranges, magnitudes and rates',()=>{
 cases([['$12.50','twelve dollars fifty cents'],['$1','one dollar'],['$0.02','two cents'],['$2.5 million','two point five million dollars'],['£1.20','one pound twenty pence'],
  ['₹500','five hundred rupees'],['$250-$300','two hundred fifty dollars to three hundred dollars'],['$20/mo','twenty dollars per month'],['€3','three euros']]);
});
test('measurements, ranges, sets by reps, percentages, temperatures',()=>{
 cases([['130 lbs','one hundred thirty pounds'],['1 kg','one kilogram'],['1.5 kg','one point five kilograms'],['8-12 reps','eight to twelve reps'],['120 kg to 135 kg','one hundred twenty kilograms to one hundred thirty five kilograms'],
  ['2-5lb','two to five pounds'],['3x10','three by ten'],['4 x 8 at 60kg','four by eight at sixty kilograms'],['15%','fifteen percent'],['2.5%','two point five percent'],['2°C','two degrees Celsius'],
  ['12 km/h','twelve kilometers per hour'],['5 km per hour','five kilometers per hour'],['140 bpm','one hundred forty beats per minute'],['100 million kg','one hundred million kilograms'],['1.6 g/kg','one point six grams per kilogram']]);
});
test('fractions',()=>{
 cases([['1/2','one half'],['3/4 cup','three quarters cup'],['2/3','two thirds'],['4 1/2 lbs','four and a half pounds'],['22/3','twenty two thirds'],['24/7','twenty four seven']]);
});
test('symbols, math and abbreviations',()=>{
 cases([['≈ 98 lbs','approximately ninety eight pounds'],['~5 sets','about five sets'],['1-2=5','one minus two equals five'],['2+3','two plus three'],['A & B','A and B'],['Dr. Smith','doctor Smith'],['e.g. squats','for example squats'],['$ and %','dollar and percent']]);
});
test('plain prose is unchanged, and developer notation still reads as before',()=>{
 cases([['Rest well and train hard.','Rest well and train hard.'],['Open my File.py with version 1.2.3.','Open my File dot p y with version one point two point three.']]);
});
test('the one recorded NeMo output on disk is reproduced exactly',()=>{
 // test-output/headless-speech/nemo-kokoro.json, NeMo 1.2.0.
 assert.equal(normalize('It costs $12.50 for 20 kg.'),'It costs twelve dollars fifty cents for twenty kilograms.');
});
test('NeMo r1.2.0 English reference: same spoken words except the reviewed differences',()=>{
 const rows=compare(),different=rows.filter(r=>r.result==='different').map(r=>r.input);
 // Reviewed one by one (docs/DEVELOPER_GUIDE.md, "Pronunciation"). A new difference fails this test.
 const reviewed=['1:01:01','14:10:30','21:51:31','01:01:01','13000','123000','978-0','340 A.D','We have seen YoY growth in 2Q22','1795 / 1805','3 cc/s','4.4x','80 s','45º&C',
  'Nancy lived on 1428 Elm St.','Nancy lived on 1428 Elm St. It was a strange place.','$18081','$18052','$18095','from 2-10','2-5','2x8','2+3 m2','170 - 45190',
  '[HH AH0 L OW1]','<pitch=-.3>123 123</pitch>','C. S. Lewis','Our company offers a 401(k) retirement savings plan','/$€₩£BB¥#%AA and $€₩£¥#%'];
 assert.deepEqual([...new Set(different)].filter(input=>!reviewed.includes(input)),[]);
 assert.ok(rows.length>=320&&rows.length-different.length>=290,`${rows.length-different.length}/${rows.length}`);
});
test('Workout-coach replies through the full read-aloud path',()=>{
 const spoken=text=>normalize(spokenReply(text,{sentences:3,chars:400}).text);
 assert.equal(spoken('Your personal record for the Lat Pulldown is **130 lbs** for **6 reps**, achieved on **2026‑04‑10**. Great work!'),
  'Your personal record for the Lat Pulldown is one hundred thirty pounds for six reps, achieved on April tenth twenty twenty six. Great work!');
 assert.equal(spoken('Your total training volume for Flat Dumbbell Bench Press so far this year is ≈ 14,860 lbs.'),
  'Your total training volume for Flat Dumbbell Bench Press so far this year is approximately fourteen thousand eight hundred sixty pounds.');
 assert.equal(spoken('Do 3 sets (RPE 8) on push/pull days.'),'Do three sets, RPE eight, on push or pull days.');
});

test('m:ss durations: a duration cue reads minutes and seconds',()=>{
 cases([['rest 1:30 between sets','rest one minute thirty between sets'],['Rest 2:00, then go again.','Rest two minutes, then go again.'],['Rest 1:05.','Rest one minute five seconds.'],
  ['Plank for 0:45.','Plank for forty five seconds.'],['Your 5k time was 25:30.','Your five k time was twenty five minutes thirty.'],['Pace 5:30/km','Pace five minutes thirty per kilometer'],
  ['Hold 1:00 per side','Hold one minute per side'],['a 1:30 minutes rest','a one minute thirty seconds rest'],['1:30 rest between rounds','one minute thirty rest between rounds'],
  ['You ran 1:05:30 today.','You ran one hour five minutes thirty seconds today.'],['finished in 2:00:00','finished in two hours'],['Your best mile split was 6:58.','Your best mile split was six minutes fifty eight.']]);
});
test('clock times keep the clock reading',()=>{
 cases([['at 6:30 PM','at six thirty PM'],['See you at 6:30.','See you at six thirty.'],['Wake at 6:30 tomorrow','Wake at six thirty tomorrow'],['The gym opens 5:30 in the morning.','The gym opens five thirty in the morning.'],
  ['until 9:15','until nine fifteen'],['Rest at 6:30.','Rest at six thirty.'],['6:30 pm','six thirty PM'],['at 14:10:30','at fourteen hours ten minutes and thirty seconds']]);
});
test('ambiguous m:ss without any cue keeps the current clock reading; impossible clock values are durations',()=>{
 cases([['The meeting is 6:30.','The meeting is six thirty.'],['Result: 5:30','Result: five thirty'],['It was 45:10.','It was forty five minutes ten.'],['14:10:30','fourteen hours ten minutes thirty seconds']]);
});
test('dates: a part above 12 settles the convention; ISO is unambiguous',()=>{
 cases([['25/12/2026','the twenty fifth of December twenty twenty six'],['12/25/2026','December twenty fifth twenty twenty six'],['13.01.2026','the thirteenth of January twenty twenty six'],
  ['2026-10-07','October seventh twenty twenty six']]);
 assert.equal(normalize('12/25/2026',{dateOrder:'dmy'}),'December twenty fifth twenty twenty six','certain dates ignore the setting');
});
test('dates: ambiguous ones follow other dates in the same reply, else the dateOrder setting (default day-first)',()=>{
 const {inferDateOrder}=require('../src/pc/spoken-normalizer.cjs');
 assert.equal(inferDateOrder('25/12/2026 and 07/10/2026'),'dmy');assert.equal(inferDateOrder('12/25/2026 then 07/10/2026'),'mdy');
 assert.equal(inferDateOrder('07/10/2026'),null);assert.equal(inferDateOrder('25/12/2026 and 12/25/2026'),null,'a mixed reply settles nothing');assert.equal(inferDateOrder('2026-10-07'),null,'ISO says nothing about slashed dates');
 cases([['07/10/2026','the seventh of October twenty twenty six'],['on 07.10.2026','on the seventh of October twenty twenty six'],['25/12/2026 and 07/10/2026','the twenty fifth of December twenty twenty six and the seventh of October twenty twenty six'],
  ['12/25/2026 then 07/10/2026','December twenty fifth twenty twenty six then July tenth twenty twenty six'],['25/12/2026 and 12/25/2026 then 07/10/2026','the twenty fifth of December twenty twenty six and December twenty fifth twenty twenty six then the seventh of October twenty twenty six'],['10/04','the tenth of April']]);
 assert.equal(normalize('07/10/2026',{dateOrder:'mdy'}),'July tenth twenty twenty six','the setting decides when nothing else does');
 assert.equal(normalize('07/10/2026',{dateOrder:'dmy'}),'the seventh of October twenty twenty six');
 assert.equal(normalize('25/12/2026 and 07/10/2026',{dateOrder:'mdy'}),'the twenty fifth of December twenty twenty six and the seventh of October twenty twenty six','dates in the reply override the setting');
});
test('the controller infers the date order from the whole reply and passes it to every synthesis unit',async t=>{
 const {EventEmitter}=require('events'),{PcController}=require('../src/pc/controller.cjs'),calls=[];
 const input=new EventEmitter();Object.assign(input,{ready:Promise.resolve({}),request:async()=>{},close(){},api:{setClipboard(){}},insert:async()=>({status:'inserted'})});
 const audio=new EventEmitter();for(const n of ['loadingCue','disarmCue','tick','errorCue'])audio[n]=async()=>{};Object.assign(audio,{probe:async()=>{},cue:async()=>{},start(){},stop(){},stopPlayback(){},playWav:async()=>{},close:async()=>{}});
 const engine=new EventEmitter();Object.assign(engine,{state:'loaded',warmup:async()=>{},start:async()=>{},audio(){},end(){},cancel(){},close(){},synthesize:async(unit,options)=>{calls.push(options.normalize);return [];}});
 const c=new PcController({engine,audio,input,notify:{failure:()=>true,badge(){},close:async()=>{}},saveDraft(){},clearDraft(){},spoken:{sentences:0,chars:0,dateOrder:'dmy'}});t.after(()=>c.close());await c.ready();
 c.reply('Your best set was on 12/25/2026. That was a strong session with a lot of volume and good form throughout the whole workout. Your next test is on 07/10/2026.');
 await c.speech;assert.ok(calls.length>=2,'several units');assert.deepEqual([...new Set(calls.map(o=>o.dateOrder))],['mdy']);
 calls.length=0;c.reply('Your next test is on 07/10/2026.');await c.speech;assert.deepEqual(calls.map(o=>o.dateOrder),['dmy'],'nothing settles it: the setting');
});
