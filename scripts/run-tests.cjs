'use strict';
// Runs every *.test.cjs under test/ and src/adapters/claude-code/test/ with Node's test runner.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const DIRS=['test','src/adapters/claude-code/test'];
const files=DIRS.flatMap(dir=>fs.readdirSync(path.join(ROOT,dir)).filter(f=>f.endsWith('.test.cjs')).map(f=>dir+'/'+f));
// Some tests write scratch files under test-output/ (git-ignored).
fs.mkdirSync(path.join(ROOT,'test-output'),{recursive:true});
const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...files],{cwd:ROOT,stdio:'inherit'});
process.exit(result.status??1);
