// Silero VAD(음성 활동 검출) 전용 워커. docs/collab-architecture.md §10 참고.
//
// 합방 겹침 감지(§9)의 밴드패스 필터만으로는 게임 대사/효과음처럼 같은
// 대역에 걸친 소리를 걸러내지 못해 학습된 모델이 필요하다.
// onnxruntime-web(MIT, Microsoft)으로 Silero VAD(MIT) ONNX 모델을 이 워커
// 안에서 돌려 메인 스레드를 막지 않는다(THIRD_PARTY_NOTICES.md 참고).
//
// 일반 Worker는 chrome.runtime API를 상속받지 못하므로, 모델/런타임 URL은
// 부모(dashboard.js)가 chrome.runtime.getURL로 구해 'init' 메시지로 넘긴다.

let session = null;
let initPromise = null;

// 8kHz 모델 기준(RATE_CONFIG). 16kHz 쪽(512/64)은 이 확장의 캡처 레이트가
// 항상 8kHz 근방(lufs-worklet-processor.js CAPTURE_TARGET_SAMPLE_RATE)이라
// 쓰지 않는다.
const SR = 8000;
const FRAME_SAMPLES = 256;
const CONTEXT_SAMPLES = 32;
const STATE_SHAPE = [2, 1, 128];

// gcc-phat.js의 resampleLinear와 동일 — 별도 워커라 import 대신 복제했다.
// 캡처 실측 레이트(예: 44100/6=7350Hz)가 정확히 8000Hz가 아닐 수 있는데,
// 모델의 sr(=8000)과 시간축이 어긋나면 조용히 엉뚱한 결과가 나오므로
// 반드시 8000Hz로 맞춘 뒤 추론한다.
function resampleLinear(buf, fromRate, toRate) {
  if (fromRate === toRate) return buf;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(buf.length * ratio));
  const out = new Float32Array(outLen);
  const lastIdx = buf.length - 1;
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.min(lastIdx, Math.floor(srcPos));
    const i1 = Math.min(lastIdx, i0 + 1);
    const frac = srcPos - i0;
    out[i] = buf[i0] * (1 - frac) + buf[i1] * frac;
  }
  return out;
}

async function ensureSession(modelUrl, wasmBaseUrl) {
  if (session) return session;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    importScripts('ort.wasm.min.js');
    // 스레드 풀(SharedArrayBuffer)은 호스트 페이지가 COOP/COEP를 보내지
    // 않으면(우리가 통제 불가) 못 쓴다 — 처음부터 단일 스레드로 고정한다.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = wasmBaseUrl;
    ort.env.wasm.proxy = false; // 이미 워커 안이라 추가 프록시 워커가 필요 없다.
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return session;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

// samples(임의 sampleRate) → 8kHz 리샘플 → 256샘플 프레임 단위로 순회하며
// 프레임별 발화 확률을 반환한다. 컨텍스트(이전 프레임 끝 32샘플)와 LSTM
// state는 스니펫 안에서만 이어가고 스니펫끼리는 독립적으로 리셋한다.
// 3초 스니펫엔 프레임이 충분히 많아(약 25개) 초기 워밍업 영향은 작다.
async function runVad(samples, sampleRate) {
  const resampled = resampleLinear(samples, sampleRate, SR);
  const frameCount = Math.max(1, Math.ceil(resampled.length / FRAME_SAMPLES));

  let state = new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2]);
  let context = new Float32Array(CONTEXT_SAMPLES);
  const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SR)]), []);

  const probs = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const frame = new Float32Array(FRAME_SAMPLES);
    const start = f * FRAME_SAMPLES;
    const avail = Math.min(FRAME_SAMPLES, resampled.length - start);
    if (avail > 0) frame.set(resampled.subarray(start, start + avail));

    const modelInput = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
    modelInput.set(context, 0);
    modelInput.set(frame, CONTEXT_SAMPLES);

    const inputTensor = new ort.Tensor('float32', modelInput, [1, CONTEXT_SAMPLES + FRAME_SAMPLES]);
    const stateTensor = new ort.Tensor('float32', state, STATE_SHAPE);

    // eslint-disable-next-line no-await-in-loop
    const result = await session.run({ input: inputTensor, state: stateTensor, sr: srTensor });
    probs[f] = result.output.data[0];
    state = result.stateN.data;
    context = frame.subarray(FRAME_SAMPLES - CONTEXT_SAMPLES);
  }

  return { probs, frameSamplesAtOutputRate: FRAME_SAMPLES, outputSampleRate: SR };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.cmd === 'init') {
    try {
      await ensureSession(msg.modelUrl, msg.wasmBaseUrl);
      self.postMessage({ type: 'init-result', ok: true });
    } catch (err) {
      self.postMessage({ type: 'init-result', ok: false, error: String(err && err.message || err) });
    }
    return;
  }
  if (msg.cmd === 'infer') {
    const { requestId, samples, sampleRate } = msg;
    try {
      await ensureSession(msg.modelUrl, msg.wasmBaseUrl);
      const { probs, frameSamplesAtOutputRate, outputSampleRate } = await runVad(samples, sampleRate);
      self.postMessage({
        type: 'infer-result',
        requestId,
        probs,
        frameSamplesAtOutputRate,
        outputSampleRate,
      });
    } catch (err) {
      self.postMessage({ type: 'infer-result', requestId, error: String(err && err.message || err) });
    }
  }
};
