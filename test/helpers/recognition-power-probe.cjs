'use strict';
// Runs src/manual-recognition.cjs in this process with its child processes (decoder and speech detector) replaced by
// fakes whose 'ready' carries the opt-out results given as arguments ('true', 'false' or 'missing'), opens one
// capture, and prints every message the router sends. Used by test/pc-power.test.cjs in a separate process, because
// the router takes over its process's message and exit handling.
const childProcess=require('node:child_process'),{EventEmitter}=require('node:events'),path=require('node:path');
const [decoderReport,vadReport]=process.argv.slice(2),value=v=>v==='missing'?{}:{powerThrottlingOff:v==='true'};
childProcess.fork=(file,args)=>{const child=new EventEmitter();Object.assign(child,{stderr:new EventEmitter(),send(){},kill(){},connected:true});
 setImmediate(()=>child.emit('message',{type:'ready',...(args[0]==='decode'?{engine:'fake',loadMs:1}:{}),...value(args[0]==='decode'?decoderReport:vadReport)}));return child;};
const sent=[];
require(path.resolve(__dirname,'../../src/manual-recognition.cjs')).startManualRecognition('models',m=>sent.push(m));
setImmediate(()=>{process.emit('message',{type:'reset',epoch:1});process.emit('message',{type:'capture-open',epoch:1,captureId:'c1',route:'agent',voice:true});
 setTimeout(()=>{process.stdout.write(JSON.stringify(sent.filter(m=>m.type==='ready'||m.type==='power')));process.exit(0);},50);});
