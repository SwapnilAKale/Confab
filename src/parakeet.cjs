const path=require('node:path'),os=require('node:os');
const variants={
 'tdt-v2':{directory:'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',kind:'transducer'}
};
// These checkpoints are English-only. There is no fictitious language-lock or
// phrase bias: each fresh stream receives the caller's 16 kHz PCM. Short-final
// synthetic silence is applied explicitly by recognition-padding.cjs.
function createParakeet(modelRoot,variant='tdt-v2'){
 const selected=variants[variant];if(!selected)throw Error('Unknown Parakeet variant: '+variant);
 const root=path.join(modelRoot,selected.directory),file=name=>path.join(root,name);
 const model=selected.kind==='ctc'?{nemoCtc:{model:file('model.int8.onnx')}}:
 {transducer:{encoder:file('encoder.int8.onnx'),decoder:file('decoder.int8.onnx'),joiner:file('joiner.int8.onnx')},modelType:'nemo_transducer'};
 const recognizer=new (require('sherpa-onnx-node').OfflineRecognizer)({
  featConfig:{sampleRate:16000,featureDim:80},
  modelConfig:{...model,tokens:file('tokens.txt'),numThreads:Math.min(3,os.availableParallelism()),provider:'cpu',debug:false},decodingMethod:'greedy_search'
 });
 const details=samples=>{const stream=recognizer.createStream();stream.acceptWaveform({sampleRate:16000,samples});recognizer.decode(stream);return recognizer.getResult(stream);};
 const recognize=samples=>details(samples).text;recognize.details=details;return recognize;
}
module.exports={createParakeet,variants};
