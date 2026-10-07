# Third-party notices

Local Voice uses the components below. Each keeps its own licence. The speech models and the Moonshine engine are not stored in this repository; they are downloaded into `assets/` (sources and checksums in `assets/live-models.json`), and each keeps its licence files in its folder.

## Speech models

| Component | Use | Licence | Source |
|---|---|---|---|
| Parakeet TDT 0.6B v2, int8 (sherpa-onnx export) | Speech recognition | CC BY 4.0 (NVIDIA). Attribution, model card and licence are in the model folder. | Original model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2. Conversion: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models. No fine-tuning. |
| Kokoro multi-lang v1.0 (sherpa-onnx export) | Speech synthesis | Apache 2.0. Its LICENSE and README are in the model folder. | Original model: https://huggingface.co/hexgrad/Kokoro-82M. Conversion: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models. |
| eSpeak NG data (inside the Kokoro folder, `espeak-ng-data`) | Phonemization for Kokoro | GPL-3.0 | https://github.com/espeak-ng/espeak-ng |
| Moonshine medium streaming, English | Speech segmenting | MIT, as stated by the moonshine-voice 0.1.5 package | https://github.com/moonshine-ai/moonshine; files from https://download.moonshine.ai/model/medium-streaming-en/quantized_26_08_21/ |

## Libraries

| Component | Version | Licence | Source |
|---|---|---|---|
| moonshine-voice (native engine: `moonshine.dll`, `onnxruntime.dll`) | 0.1.5 | MIT; its licence is in `assets/moonshine-engine/moonshine_voice-0.1.5.dist-info/licenses` | https://pypi.org/project/moonshine-voice/0.1.5/ |
| sherpa-onnx-node, sherpa-onnx-win-x64 | 1.13.7 | Apache 2.0 | https://github.com/k2-fsa/sherpa-onnx |
| ONNX Runtime (bundled in sherpa-onnx-win-x64 and moonshine-voice) | — | MIT | https://github.com/microsoft/onnxruntime |
| Koffi | 3.2.1 | MIT | https://github.com/Koromix/koffi |
| Node.js (not bundled; required on PATH) | 22 or later | MIT | https://nodejs.org |

## Test data

| Component | Licence | Source |
|---|---|---|
| NeMo text processing r1.2.0 English test cases (`test/fixtures/nemo-reference`) | Apache 2.0; licence in that folder | https://github.com/NVIDIA/NeMo-text-processing |

## Notes

- The eSpeak NG data carries GPL obligations, so a distribution that includes the Kokoro folder is not an all-permissive distribution. Review the corresponding-source obligations before redistributing the models publicly.
- The Moonshine licence statement covers the 0.1.5 package and the English streaming model listed above; it does not extend to other Moonshine releases or languages.
- `test/fixtures/speech-sample.wav` was generated with the bundled Kokoro voice for tests.
