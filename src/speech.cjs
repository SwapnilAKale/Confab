const path=require('node:path');
const os=require('node:os');
const sherpa=require('sherpa-onnx-node');
function createTTS(modelRoot,threads=3) {
  const root=path.join(modelRoot,'kokoro-multi-lang-v1_0');
  return new sherpa.OfflineTts({model:{
    kokoro:{model:path.join(root,'model.onnx'),voices:path.join(root,'voices.bin'),
      tokens:path.join(root,'tokens.txt'),dataDir:path.join(root,'espeak-ng-data'),
      lexicon:path.join(root,'lexicon-us-en.txt'),lang:'en-us'},
    numThreads:Math.min(threads,os.availableParallelism()),provider:'cpu',debug:false},
    maxNumSentences:1});
}
function generate(tts,text){
  return tts.generate({text,generationConfig:new sherpa.GenerationConfig({sid:3,speed:1.0,silenceScale:.2})});
}
module.exports={createTTS,generate,sherpa};

