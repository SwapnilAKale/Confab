'use strict';
// The idle resident does not keep a PowerShell UIA process alive.
class LazyAccessibility{
 constructor(){this.ready=Promise.resolve(true);}
 async snapshot(options){if(this.closed)return {status:'rejected',reason:'accessibility_unavailable'};clearTimeout(this.timer);if(!this.inner||this.inner.closed)this.inner=new(require('./accessibility.cjs').Accessibility)();const inner=this.inner;await inner.ready;try{return await inner.snapshot(options);}finally{this.timer=setTimeout(()=>{inner.close();if(this.inner===inner)this.inner=null;},30000);this.timer.unref();}}
 close(){this.closed=true;clearTimeout(this.timer);this.inner?.close();this.inner=null;}
}
module.exports={LazyAccessibility};
