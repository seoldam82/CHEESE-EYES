// ITU-R BS.1770-4 K-weighting 필터 계수 계산.
//
// BS.1770-4는 48kHz 기준 계수만 표로 제공하지만 AudioContext.sampleRate는
// 환경마다 다르다. Annex 1의 이중선형변환 재도출 공식을 임의 샘플레이트에
// 적용하는 순수 함수 — fs=48000일 때 표준 참조 계수와 소수점 9자리 이상
// 일치함을 확인했다(node로 검증). docs/audio-architecture.md §5.3 참고.

// 스테이지 1 — 헤드/귀 응답 근사 셸빙 필터 (약 1.7kHz 위로 +4dB 완만한 부스트)
const STAGE1_F0 = 1681.9744509555319;
const STAGE1_G = 3.99984385397;
const STAGE1_Q = 0.7071752369554193;

// 스테이지 2 — RLB(Revised Low-frequency B) 하이패스 (저음 롤오프)
const STAGE2_F0 = 38.13547087602444;
const STAGE2_Q = 0.5003270373238773;

function computeStage1(sampleRate) {
  const K = Math.tan(Math.PI * STAGE1_F0 / sampleRate);
  const Vh = Math.pow(10, STAGE1_G / 20);
  const Vb = Math.pow(Vh, 0.499666774155);
  const a0 = 1.0 + K / STAGE1_Q + K * K;
  return {
    b0: (Vh + (Vb * K) / STAGE1_Q + K * K) / a0,
    b1: (2.0 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / STAGE1_Q + K * K) / a0,
    a1: (2.0 * (K * K - 1.0)) / a0,
    a2: (1.0 - K / STAGE1_Q + K * K) / a0,
  };
}

function computeStage2(sampleRate) {
  const K = Math.tan(Math.PI * STAGE2_F0 / sampleRate);
  const a0 = 1.0 + K / STAGE2_Q + K * K;
  return {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: (2.0 * (K * K - 1.0)) / a0,
    a2: (1.0 - K / STAGE2_Q + K * K) / a0,
  };
}

// { stage1: {b0,b1,b2,a1,a2}, stage2: {b0,b1,b2,a1,a2} } — b0/b1/b2/a1/a2는
// a0=1로 정규화된 Direct Form I 이차 IIR 계수(전달함수: y[n] = b0*x[n] +
// b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]).
export function computeKWeightingCoefficients(sampleRate) {
  return {
    stage1: computeStage1(sampleRate),
    stage2: computeStage2(sampleRate),
  };
}

// ── 합방 겹침 감지용 "음성대역" 필터 (docs/collab-architecture.md §9) ──────
// RBJ Audio EQ Cookbook의 표준 2차 하이패스/로우패스 공식(Butterworth,
// Q=1/√2 — 캐스케이드 시 통과대역이 가장 평평함)을 그대로 쓴다:
// https://www.w3.org/andrew/2011/pmspeople/Audio-EQ-Cookbook.txt
//
// 컷오프는 ITU-R G.711 전화망 대역(300~3400Hz) — 목소리 명료도를 유지하며
// 저음 위주 배경음악/SFX 에너지를 걷어낸다. 이 값이 크로스토크 판정에도
// 최적이라는 실측 검증은 없다(§9.3).
const VOICE_BAND_HIGHPASS_HZ = 300;
const VOICE_BAND_LOWPASS_HZ = 3400;
const VOICE_BAND_Q = Math.SQRT1_2; // 1/√2, Butterworth

function computeRbjBiquad(type, f0, Q, sampleRate) {
  const w0 = 2 * Math.PI * f0 / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  let b0, b1, b2;
  if (type === 'highpass') {
    b0 = (1 + cosw0) / 2;
    b1 = -(1 + cosw0);
    b2 = (1 + cosw0) / 2;
  } else {
    // lowpass
    b0 = (1 - cosw0) / 2;
    b1 = 1 - cosw0;
    b2 = (1 - cosw0) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// { highpass: {...}, lowpass: {...} } — 두 스테이지를 순서대로 캐스케이드
// (하이패스 → 로우패스)하면 300Hz~3400Hz 대역만 남는 밴드패스가 된다.
export function computeVoiceBandCoefficients(sampleRate) {
  return {
    highpass: computeRbjBiquad('highpass', VOICE_BAND_HIGHPASS_HZ, VOICE_BAND_Q, sampleRate),
    lowpass: computeRbjBiquad('lowpass', VOICE_BAND_LOWPASS_HZ, VOICE_BAND_Q, sampleRate),
  };
}
