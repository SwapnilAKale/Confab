'use strict';
// Opts this process out of Windows power throttling (EcoQoS). Windows 11 slows down processes that have no visible
// window: it runs them on the efficiency cores at low clock speed. Confab's service and its speech workers have no
// window, so without this the speech engine ran about 5 times slower than in a terminal. Measured 23 November 2026 on
// an i5-13420H, on mains power, Balanced plan: Kokoro real-time factor 1.3-2.0 throttled, 0.39-0.50 with this (across runs).
// SetProcessInformation(ProcessPowerThrottling) with ControlMask EXECUTION_SPEED and StateMask 0 means "never
// throttle my execution speed". It changes only this process, needs no rights, and is undone when the process exits.
// Returns whether Windows accepted it; any failure (not Windows, older Windows) is ignored.
// The Windows functions, bound once: koffi refuses to define the same struct name twice, so a second call in one
// process must reuse them (it used to fail and report false).
let api=null;
function bind(){if(api)return api;const k=require('koffi'),kernel=k.load('kernel32.dll');
 const State=k.struct('CONFAB_POWER_THROTTLING_STATE',{version:'uint32',controlMask:'uint32',stateMask:'uint32'});
 return api={size:k.sizeof(State),current:kernel.func('void* __stdcall GetCurrentProcess()'),
  set:kernel.func('int __stdcall SetProcessInformation(void* process, int informationClass, CONFAB_POWER_THROTTLING_STATE* information, uint32 size)')};}
function optOutOfPowerThrottling(){
 if(process.platform!=='win32')return false;
 try{
  const {size,current,set}=bind();
  // ProcessPowerThrottling = 4; PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1; PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 1.
  return set(current(),4,{version:1,controlMask:1,stateMask:0},size)!==0;
 }catch{return false;}
}
module.exports={optOutOfPowerThrottling};
