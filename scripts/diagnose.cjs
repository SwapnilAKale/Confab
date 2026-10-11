'use strict';
// Checks the models, the service, the hotkeys and each connected agent's hook, and says what is wrong.
//   node scripts/diagnose.cjs [--full] [--json]     --full hashes every model file again
const diagnose=require('../src/setup/diagnose.cjs');
diagnose.run({full:process.argv.includes('--full')}).then(checks=>{
 if(process.argv.includes('--json'))console.log(JSON.stringify(checks));else console.log(diagnose.format(checks));
 process.exitCode=checks.some(c=>!c.ok&&!c.warn)?1:0;
}).catch(e=>{console.error('Diagnose failed: '+e.message);process.exitCode=2;});
