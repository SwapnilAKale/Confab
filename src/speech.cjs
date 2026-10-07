const path=require('node:path');
const os=require('node:os');
const sherpa=require('sherpa-onnx-node');
function createASR(modelRoot,threads=3) {
  const root=path.join(modelRoot,'sherpa-onnx-streaming-zipformer-en-2023-06-26');
  const model=n=>path.join(root,n+'-epoch-99-avg-1-chunk-16-left-128.int8.onnx');
  return new sherpa.OnlineRecognizer({
    featConfig:{sampleRate:16000,featureDim:80},
    modelConfig:{transducer:{encoder:model('encoder'),decoder:model('decoder'),joiner:model('joiner')},
      tokens:path.join(root,'tokens.txt'),numThreads:Math.min(threads,os.availableParallelism()),provider:'cpu',debug:false},
    decodingMethod:'greedy_search',enableEndpoint:true,
    rule1MinTrailingSilence:2.4,rule2MinTrailingSilence:1.4,rule3MinUtteranceLength:300
  });
}
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
module.exports={createASR,createTTS,generate,sherpa};

