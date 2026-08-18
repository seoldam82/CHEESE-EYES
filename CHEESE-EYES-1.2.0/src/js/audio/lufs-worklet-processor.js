// AudioWorkletProcessor — 채널 오디오의 K-weighted momentary LUFS를 오디오
// 스레드에서 직접 계산해 보고한다(AnalyserNode+메인스레드 폴링 대체).
// docs/audio-architecture.md §5.3~§5.4 참고.
//
// 재생 경로가 아닌 측정 전용 탭 — process()는 입력만 읽고 출력은 항상
// 무음이다. content.js는 output을 silent gain(0) 경유로 destination에
// 연결해 항상 pull되게 해야 한다(연결 없으면 브라우저가 처리 대상에서 제외).

import { computeKWeightingCoefficients, computeVoiceBandCoefficients } from './lufs-coefficients.js';

// BS.1770 "Momentary" 라우드니스 정의(400ms 슬라이딩 윈도우).
const MOMENTARY_WINDOW_SEC = 0.4;
// 워클릿→content.js 보고 주기. 기존 피크추적 폴링(50ms)과 맞춰 그 오케스트
// 레이션 코드(피크추적·어택/릴리즈 스무딩)를 그대로 재사용한다(§5.4).
const REPORT_INTERVAL_SEC = 0.05;

// ── 합방 겹침 감지용 파형 캡처(옵션, 기본 꺼짐) ─────────────────────────
// docs/collab-architecture.md §3.1 — GCC-PHAT으로 내용 유사도를 판정하려면
// dB/LUFS 스칼라가 아니라 실제 파형이 필요하다. LUFS 측정과 같은 지점에서
// 곁다리로 다운샘플해 링 버퍼에 담아두고 요청 시 스냅샷을 돌려준다.
// 기본값 setCapture(false)에서는 process() 진입 시 플래그 확인 외 비용이
// 없다.
const CAPTURE_TARGET_SAMPLE_RATE = 8000;
const CAPTURE_WINDOW_SEC = 3;

class BiquadState {
  constructor() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
}

// Direct Form I 이차 IIR: y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2]
//                                - a1*y[n-1] - a2*y[n-2]
function processBiquad(coeffs, state, x) {
  const y = coeffs.b0 * x + coeffs.b1 * state.x1 + coeffs.b2 * state.x2
    - coeffs.a1 * state.y1 - coeffs.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = x;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

class LufsMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // AudioWorkletGlobalScope의 전역 sampleRate — 이 컨텍스트가 실제로 도는
    // 샘플레이트(44.1kHz/48kHz 등)에 맞춰 매번 계수를 새로 계산한다.
    this.coeffs = computeKWeightingCoefficients(sampleRate);
    this.stage1States = [];
    this.stage2States = [];

    // ── 음성대역(300~3400Hz) 필터 상태(§9) ──────────────────────────────
    // K-weighting과 달리 채널별로 따로 안 둔다 — 모노 믹스다운 하나에만 적용
    // (합방 겹침 감지는 "전체적으로 같은 목소리가 섞이는가"만 보면 되므로).
    this.voiceCoeffs = computeVoiceBandCoefficients(sampleRate);
    this.voiceHighpassState = new BiquadState();
    this.voiceLowpassState = new BiquadState();

    this.windowSamples = Math.max(1, Math.round(MOMENTARY_WINDOW_SEC * sampleRate));
    // 링 버퍼 기반 이동합(running sum) — 매 샘플 O(1)로 "최근 400ms 제곱합"을
    // 유지한다. 채널별 합산값을 프레임마다 하나의 버퍼에 넣는다: mean-square는
    // 채널 합에 대해 선형이라(BS.1770의 채널별 가중 평균 합산과 동치) 이렇게
    // 합쳐도 결과가 같다.
    this.ringBuffer = new Float32Array(this.windowSamples);
    this.ringIndex = 0;
    this.runningSum = 0;

    // 음성대역 신호용 이동합 — LUFS 링 버퍼와 같은 창(400ms) 재사용(음절
    // 단위론 더 짧아도 되지만 튜닝 변수를 늘리지 않으려 그대로 맞춤 — §9.3).
    this.voiceRingBuffer = new Float32Array(this.windowSamples);
    this.voiceRingIndex = 0;
    this.voiceRunningSum = 0;

    this.reportIntervalFrames = Math.max(1, Math.round(REPORT_INTERVAL_SEC * sampleRate));
    this.framesSinceReport = 0;

    // 다운샘플 비율은 정수로 반올림 — iframe마다 AudioContext.sampleRate가
    // 달라 실제 캡처 레이트가 정확히 8000Hz가 아닐 수 있다(예:
    // 44100/6=7350Hz). 실측 레이트를 함께 보고해 GCC-PHAT 쪽에서 리샘플로
    // 맞추게 한다(gcc-phat.js 참고).
    this.captureRatio = Math.max(1, Math.round(sampleRate / CAPTURE_TARGET_SAMPLE_RATE));
    this.captureSampleRate = sampleRate / this.captureRatio;
    this.captureWindowSec = CAPTURE_WINDOW_SEC;
    this.captureBufferLength = Math.max(1, Math.round(this.captureWindowSec * this.captureSampleRate));
    this.captureBuffer = new Float32Array(this.captureBufferLength);
    this.captureIndex = 0;
    this.captureFilled = 0;
    this.captureEnabled = false;
    this.decimateAccum = 0;
    this.decimateCount = 0;

    this.port.onmessage = (event) => this.handleControlMessage(event.data);
  }

  handleControlMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.cmd === 'setCapture') {
      this.captureEnabled = !!msg.enabled;
      // windowSec — VOD 합방 싱크(§docs/vod-collab-sync-architecture.md
      // 2026-08-16 후속) 전용. 기본 3초 캡처 창은 라이브 합방(레이턴시
      // 차이가 보통 몇 초 이내)에 맞춘 값이라, 메타데이터 오프셋 오차가
      // 그보다 클 수 있는 vod-sync 쌍에는 dashboard.js가 더 넓은 창을
      // 요청한다. 창 길이가 실제로 바뀔 때만 버퍼를 다시 만든다 — 매번
      // setCapture(enabled 갱신용으로도 자주 옴)마다 재할당하면 그때마다
      // 캡처가 리셋돼 버린다.
      const windowSec = (typeof msg.windowSec === 'number' && msg.windowSec > 0) ? msg.windowSec : CAPTURE_WINDOW_SEC;
      const windowChanged = windowSec !== this.captureWindowSec;
      if (windowChanged) {
        this.captureWindowSec = windowSec;
        this.captureBufferLength = Math.max(1, Math.round(this.captureWindowSec * this.captureSampleRate));
        this.captureBuffer = new Float32Array(this.captureBufferLength);
        this.captureIndex = 0;
        this.captureFilled = 0;
        this.decimateAccum = 0;
        this.decimateCount = 0;
      }
      // forceReset — VOD 합방 싱크가 시크로 재생위치를 옮긴 직후에 쓴다
      // (§dashboard.js maybeRefineVodSyncOffsetFromLag). 시크 도중/직후에도
      // 링 버퍼는 계속 채워지고 있어서, 강제로 비우지 않으면 시크 전(다른
      // 시점의) 오디오와 시크 후 오디오가 한 버퍼 안에 섞인 채로 다음
      // GCC-PHAT 상관에 쓰이게 된다 — 실제로 안 겹치는데 우연히 짧은
      // 구간이 맞아떨어지는 것처럼 보이는 오탐의 원인이 될 수 있다.
      if (!this.captureEnabled || windowChanged || msg.forceReset) {
        // 꺼질 때/창 길이가 바뀔 때/강제 리셋 요청 시 버퍼를 비운다 —
        // 다시 켰을 때(또는 이어서 켜진 채로도) 오래된(무관한) 샘플이
        // 새 캡처에 섞여 들어가는 걸 막는다.
        this.captureBuffer.fill(0);
        this.captureIndex = 0;
        this.captureFilled = 0;
        this.decimateAccum = 0;
        this.decimateCount = 0;
      }
    } else if (msg.cmd === 'getSnippet') {
      this.port.postMessage({
        type: 'snippet',
        requestId: msg.requestId,
        samples: this.readCaptureSnapshot(),
        sampleRate: this.captureSampleRate,
        filled: this.captureFilled >= this.captureBufferLength,
        capturedAtMs: Date.now()
      });
    }
  }

  // 링 버퍼를 오래된→최신 순서의 선형 배열로 재배열해 스냅샷을 만든다.
  readCaptureSnapshot() {
    const len = this.captureBufferLength;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = this.captureBuffer[(this.captureIndex + i) % len];
    }
    return out;
  }

  ensureChannelStates(channelCount) {
    while (this.stage1States.length < channelCount) {
      this.stage1States.push(new BiquadState());
      this.stage2States.push(new BiquadState());
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      // 아직 연결이 안 됐거나 프레임이 없는 순간 — 계속 pull되도록 true만 반환.
      return true;
    }

    const channelCount = input.length;
    this.ensureChannelStates(channelCount);
    const frameCount = input[0].length;

    for (let i = 0; i < frameCount; i++) {
      let combinedSquared = 0;
      let monoSum = 0;
      for (let c = 0; c < channelCount; c++) {
        const x = input[c][i];
        monoSum += x;
        const afterStage1 = processBiquad(this.coeffs.stage1, this.stage1States[c], x);
        const kWeighted = processBiquad(this.coeffs.stage2, this.stage2States[c], afterStage1);
        combinedSquared += kWeighted * kWeighted;
      }
      const monoAvg = monoSum / channelCount;

      // 음성대역(300~3400Hz)만 남긴 모노 신호 — §9. 합방 겹침 판정(Stage1
      // 엔벨로프 상관, Stage2 GCC-PHAT)에 쓸 "말소리 위주" 신호를 K-weighting과
      // 별개로 뽑는다. LUFS(combinedSquared 기반)는 원음 그대로 둔다.
      const afterVoiceHp = processBiquad(this.voiceCoeffs.highpass, this.voiceHighpassState, monoAvg);
      const voiceSample = processBiquad(this.voiceCoeffs.lowpass, this.voiceLowpassState, afterVoiceHp);

      this.runningSum += combinedSquared - this.ringBuffer[this.ringIndex];
      this.ringBuffer[this.ringIndex] = combinedSquared;
      // windowSamples가 2의 거듭제곱이 아니라 %로 감쌀 수밖에 없는데, 매
      // 샘플(초당 수만 회) 도는 오디오 렌더 스레드 루프라 정수 나눗셈보다
      // 분기 증가가 더 저렴하다 — 인덱스 시퀀스는 %와 완전히 동일하다.
      this.ringIndex++;
      if (this.ringIndex >= this.windowSamples) this.ringIndex = 0;

      const voiceSquared = voiceSample * voiceSample;
      this.voiceRunningSum += voiceSquared - this.voiceRingBuffer[this.voiceRingIndex];
      this.voiceRingBuffer[this.voiceRingIndex] = voiceSquared;
      this.voiceRingIndex++;
      if (this.voiceRingIndex >= this.windowSamples) this.voiceRingIndex = 0;

      this.framesSinceReport++;
      if (this.framesSinceReport >= this.reportIntervalFrames) {
        this.framesSinceReport = 0;
        const meanSquare = this.runningSum / this.windowSamples;
        const lufs = meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -100;
        // voiceDb는 K-weighting 캘리브레이션(-0.691) 없이 밴드패스 신호의
        // 평균제곱 dB다 — 절대 라우드니스가 아니라 채널 간 상대 비교용이라
        // 캘리브레이션이 필요 없다.
        const voiceMeanSquare = this.voiceRunningSum / this.windowSamples;
        const voiceDb = voiceMeanSquare > 0 ? 10 * Math.log10(voiceMeanSquare) : -100;
        this.port.postMessage({ lufs, voiceDb });
      }

      if (this.captureEnabled) {
        // 음성대역으로 걸러낸 신호를 담는다(§9) — 예전엔 원본 모노 믹스다운을
        // 그대로 담아서, 서로 다른 배경음악/효과음의 저음 에너지가 GCC-PHAT
        // 상관을 오염시켜 실제 목소리 크로스토크를 놓치는 문제가 있었다.
        // 음성대역만 남기면 오염이 줄지만 게임 대사도 같은 대역이라 완전한
        // 분리는 아니다(§9.3).
        this.decimateAccum += voiceSample;
        this.decimateCount++;
        if (this.decimateCount >= this.captureRatio) {
          this.captureBuffer[this.captureIndex] = this.decimateAccum / this.decimateCount;
          this.captureIndex++;
          if (this.captureIndex >= this.captureBufferLength) this.captureIndex = 0;
          if (this.captureFilled < this.captureBufferLength) this.captureFilled++;
          this.decimateAccum = 0;
          this.decimateCount = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('lufs-meter-processor', LufsMeterProcessor);
