'use strict';
const {Worker}=require('node:worker_threads'),{EventEmitter}=require('node:events');
class WindowsTray extends EventEmitter{
 constructor(){super();this.worker=new Worker(require.resolve('./windows-tray-worker.cjs'));this.ready=new Promise((resolve,reject)=>{this.worker.once('error',reject);this.worker.on('message',e=>{if(e.type==='ready')resolve();else if(e.type==='action')this.emit('action',e.action);else if(e.type==='error'){reject(Error(e.message));this.emit('failure',e.message);}});});this.worker.on('error',e=>this.emit('failure',e.message));}
 update(state){if(!this.closed)this.worker.postMessage({type:'state',state});}
 badge(state){if(!this.closed)this.worker.postMessage({type:'badge',state});}
 setBadgeEnabled(enabled){if(!this.closed)this.worker.postMessage({type:'badgeEnabled',enabled:!!enabled});}
 failure(message){if(this.closed)return false;this.worker.postMessage({type:'notification',message});return true;}
 async close(){if(this.closed)return;this.closed=true;this.worker.postMessage({type:'close'});await Promise.race([new Promise(r=>this.worker.once('exit',r)),new Promise(r=>setTimeout(r,1000))]);await this.worker.terminate();}
}
module.exports={WindowsTray};
