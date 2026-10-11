'use strict';
// Agent connections, as used by setup and the tray's "Connect agents" window.
//   node scripts/agents.cjs list [--json]
//   node scripts/agents.cjs connect <agent> [--json]
//   node scripts/agents.cjs disconnect <agent|all> [--json]
const agents=require('../src/setup/agents.cjs');
const [action,target,...flags]=process.argv.slice(2),json=process.argv.includes('--json');
const LABEL={'not-installed':'not installed','not-connected':'installed, not connected','connected':'connected','needs-action':'needs action','needs-restart':'needs restart'};
// JSON is printed as ASCII (\uXXXX escapes): Windows PowerShell decodes a child's output with the console code page,
// which garbled the claude CLI's check marks in the setup and uninstall summaries.
const ascii=text=>text.replace(/[\u007f-￿]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
function print(value,text){if(json)process.stdout.write(ascii(JSON.stringify(value))+'\n');else console.log(text);}
try{
 if(action==='list'){const all=agents.list();print(all,all.map(a=>a.name.padEnd(14)+LABEL[a.state]+(a.detail&&a.state!=='not-installed'?'  '+a.detail:'')+(a.step?'\n  '+a.step:'')+(a.restart?'\n  '+a.restart:'')).join('\n'));}
 else if(action==='connect'&&target){const r=agents.connect(target);print(r,r.lines.join('\n')+'\n'+r.name+': '+LABEL[r.state]+'. '+r.detail+(r.step?'\n'+r.step:'')+(r.state==='needs-restart'&&r.restart?'\n'+r.restart:''));}
 else if(action==='disconnect'&&target){const r=target==='all'?agents.disconnectAll():[agents.disconnect(target)];print(r,r.map(x=>x.id+': '+x.lines.join('; ')).join('\n'));if(r.some(x=>!x.ok))process.exitCode=1;}
 else{console.error('Usage: node scripts/agents.cjs list | connect <agent> | disconnect <agent|all>  [--json]\nAgents: '+agents.AGENTS.map(a=>a.id).join(', '));process.exitCode=2;}
}catch(e){if(json)process.stdout.write(ascii(JSON.stringify({error:e.message}))+'\n');else console.error(e.message);process.exitCode=1;}
