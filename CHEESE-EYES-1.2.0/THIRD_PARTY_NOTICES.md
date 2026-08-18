# 서드파티 라이선스 고지

이 확장 프로그램은 합방(동시 출연) 겹침 감지의 음성 활동 검출(VAD)을 위해 아래 두
서드파티 컴포넌트를 그대로(바이너리) 포함하고 있습니다. 둘 다 MIT 라이선스이며,
소스는 전혀 수정하지 않았습니다(모델 가중치/WASM 바이너리는 원본 그대로 배포).

## ONNX Runtime Web (onnxruntime-web)

- 경로: `src/js/audio/ort/`
- 출처: https://github.com/microsoft/onnxruntime (버전 1.27.0)
- 용도: Silero VAD ONNX 모델을 브라우저에서 실행하기 위한 추론 런타임(WASM, CPU 전용)

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Silero VAD

- 경로: `src/js/audio/silero_vad.onnx`
- 출처: https://github.com/snakers4/silero-vad
- 용도: 사전학습된 음성 활동 검출(VAD) 모델 — 리더 채널이 실제로 말하고 있는
  구간만 골라 합방 겹침 판정(Stage 2 GCC-PHAT)에 반영하기 위해 사용
  (docs/collab-architecture.md §10)

```
MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
