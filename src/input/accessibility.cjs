'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
class Accessibility {
  constructor(){
    this.pending=new Map();this.nextId=0;
    const shell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    this.child=spawn(shell,['-NoLogo','-NoProfile','-NonInteractive','-Sta','-File',path.join(__dirname,'accessibility.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.ready=new Promise(resolve=>{this.resolveReady=resolve;});
    this.timer=setTimeout(()=>this.close(),5000);
    const lines=readline.createInterface({input:this.child.stdout});
    lines.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
      if(message.eventName==='ready'){clearTimeout(this.timer);this.resolveReady(true);}
      const request=this.pending.get(message.id);
      if(request){clearTimeout(request.timer);this.pending.delete(message.id);request.resolve(message.result);}
    });
    this.child.on('error',()=>this.close());this.child.on('exit',()=>this.close());
    this.child.stdin.on('error',()=>this.close());this.child.stderr.resume();
  }
  snapshot(options={}){
    if(this.closed)return Promise.resolve({status:'rejected',reason:'accessibility_unavailable'});
    const id=++this.nextId;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>this.close(),3000);
      this.pending.set(id,{resolve,timer});
      this.child.stdin.write(JSON.stringify({id,action:'snapshot',...options})+'\n');
    });
  }
  close(){
    if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.resolveReady(false);
    for(const request of this.pending.values()){clearTimeout(request.timer);request.resolve({status:'rejected',reason:'accessibility_unavailable'});}this.pending.clear();
    this.child.stdin.end();this.child.kill();
  }
}
module.exports={Accessibility};
