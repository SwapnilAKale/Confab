// Defense in depth for the speech worker: JavaScript networking is prohibited.
// Native inference uses local file paths only. An OS-isolated validation is separate.
const fail=()=>{throw Error('External networking is disabled in the local speech process');};
for(const [name,keys] of Object.entries({
  'node:net':['connect','createConnection','createServer'],
  'node:tls':['connect','createServer'],
  'node:http':['request','get','createServer'],
  'node:https':['request','get','createServer'],
  'node:dgram':['createSocket']
})) for(const key of keys) require(name)[key]=fail;
globalThis.fetch=fail;globalThis.WebSocket=class{constructor(){fail();}};

