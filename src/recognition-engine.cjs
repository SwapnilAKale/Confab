// Speech recognition: Parakeet TDT 0.6B v2 int8 (assets/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8).
const {variants,createParakeet}=require('./parakeet.cjs');
const id='tdt-v2';
const info={id,language:'en',provider:'cpu',directory:variants[id].directory,name:'Parakeet '+id+' int8'};
function createRecognizer(root){return createParakeet(root,id);}
module.exports={createRecognizer,info};
