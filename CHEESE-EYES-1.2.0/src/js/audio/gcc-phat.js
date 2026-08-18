// 두 오디오 스니펫이 같은 신호의 지연된 복사본인지(마이크 크로스토크) 판정하는
// 파형 유사도 계산. docs/collab-architecture.md §2~§3, §8 참고.
//
// 파일명은 gcc-phat이지만 기본값은 PHAT(위상 전용 정규화)을 쓰지 않는다 —
// PHAT은 진폭을 무시해 조용한 배경 잡음과 실제 목소리 크로스토크를 똑같이
// 취급하는 오탐이 있었다(§8.1). 진폭을 살리는 일반 정규화 교차상관
// (exponent=0)이 훨씬 깨끗하게 분리되어 기본값으로 채택했다.
//
// 번들러 없는 순수 스크립트 구조라(§4.2) 외부 FFT 라이브러리 대신 작은
// radix-2 FFT를 직접 구현한다. dashboard.js와 같은 전역 스코프에 로드되므로
// ES 모듈이 아닌 전역 함수(window.computeGccPhat)로 노출한다.

(function () {
  function nextPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  // in-place 반복형 radix-2 Cooley-Tukey FFT. re/im은 길이 N(2의 거듭제곱)인
  // Float64Array. inverse=true면 역FFT(결과를 N으로 나눠 정규화까지 포함).
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wlenRe = Math.cos(ang), wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        const half = len / 2;
        for (let k = 0; k < half; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const t2Re = re[i + k + half], t2Im = im[i + k + half];
          const vRe = t2Re * curRe - t2Im * curIm;
          const vIm = t2Re * curIm + t2Im * curRe;
          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + half] = uRe - vRe;
          im[i + k + half] = uIm - vIm;
          const nextRe = curRe * wlenRe - curIm * wlenIm;
          const nextIm = curRe * wlenIm + curIm * wlenRe;
          curRe = nextRe; curIm = nextIm;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  function removeMean(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const mean = sum / buf.length;
    const out = new Float64Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] - mean;
    return out;
  }

  // 선형보간 리샘플 — 두 iframe의 워클릿이 서로 다른 AudioContext.sampleRate
  // 에서 독립적으로 다운샘플하므로(예: 48000/6=8000 vs 44100/6=7350) 캡처
  // 레이트가 다를 수 있다. 상관 전에 더 낮은 쪽 레이트로 맞춘다 — 정밀도보다
  // "같은 시간축" 정합이 중요하므로 이 정도로 충분.
  function resampleLinear(buf, fromRate, toRate) {
    if (fromRate === toRate) return buf;
    const ratio = toRate / fromRate;
    const outLen = Math.max(1, Math.round(buf.length * ratio));
    const out = new Float64Array(outLen);
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

  // bufA, bufB: 같은 샘플레이트의 실수 시계열(Float64Array, 평균 제거됨).
  // maxLagSamples 범위에서 정규화 교차상관의 최댓값과 그 위치(지연, 샘플)를
  // 찾는다. 기본은 lag=0을 중심으로 ±maxLagSamples를 탐색한다.
  //
  // whiteningExponent: 0(기본값, 일반 정규화 교차상관) ~ 1(완전 PHAT, 위상만
  // 남김). 교차전력스펙트럼 진폭을 |Gab|^exponent로 나눠 부분 백색화한다.
  // 실측상 exponent=0이 우리 용도(조용한 잡음 vs 큰 목소리 크로스토크 구분)에
  // 압도적으로 낫다(§8.1) — 남겨둔 건 나중에 플랫폼 인코딩 차이가 문제될 때
  // 조정할 여지를 위해서다(§8.3).
  //
  // centerLagSamples(기본 0): 탐색 구간의 중심을 옮긴다(docs/collab-latency-
  // architecture.md). 두 채널의 레이턴시 차이가 크면 진짜 상관 피크가 lag=0
  // 근방이 아니라 그만큼 떨어진 곳에 있어, 중심을 안 옮기면 매번 잡음만
  // 비교하게 되어 오탐이 늘어난다. 탐색 폭(maxLagSamples)은 그대로 두고
  // 중심만 이동시킨다.
  function generalizedCrossCorrelate(bufA, bufB, maxLagSamples, whiteningExponent, centerLagSamples) {
    const n = bufA.length + bufB.length - 1;
    const N = nextPow2(n);

    const reA = new Float64Array(N), imA = new Float64Array(N);
    const reB = new Float64Array(N), imB = new Float64Array(N);
    reA.set(bufA);
    reB.set(bufB);

    fft(reA, imA, false);
    fft(reB, imB, false);

    const reG = new Float64Array(N), imG = new Float64Array(N);
    const EPS = 1e-12;
    const exponent = whiteningExponent || 0;
    for (let i = 0; i < N; i++) {
      const gr = reA[i] * reB[i] + imA[i] * imB[i];
      const gi = imA[i] * reB[i] - reA[i] * imB[i];
      if (exponent > 0) {
        const mag = Math.sqrt(gr * gr + gi * gi) + EPS;
        const w = exponent >= 1 ? mag : Math.pow(mag, exponent);
        reG[i] = gr / w;
        imG[i] = gi / w;
      } else {
        reG[i] = gr;
        imG[i] = gi;
      }
    }

    fft(reG, imG, true);

    // reG[0..N-1]은 순환 상관 — 인덱스 0은 lag 0, 1..N/2-1은 양의 lag,
    // N-1..N/2+1은 음의 lag(그 인덱스에서 N을 뺀 값)로 해석한다.
    // 진폭을 남겨둔 채로 계산했으므로(exponent<1) 신호 에너지로 나눠
    // -1~1 근방의 정규화 상관계수로 바꾼다 — exponent=1(완전 PHAT)에서는
    // 이미 위상만 남아 있어 이 나눗셈이 추가로 진폭을 왜곡하지 않는다.
    let energyA = 0, energyB = 0;
    for (let i = 0; i < bufA.length; i++) energyA += bufA[i] * bufA[i];
    for (let i = 0; i < bufB.length; i++) energyB += bufB[i] * bufB[i];
    const norm = Math.sqrt(energyA * energyB) + EPS;

    const half = Math.floor(N / 2) - 1;
    const margin = Math.max(0, Math.min(maxLagSamples, half));
    const center = Math.max(-half, Math.min(half, Math.round(centerLagSamples || 0)));
    const lo = Math.max(-half, center - margin);
    const hi = Math.min(half, center + margin);
    let bestVal = -Infinity, bestLag = 0;
    for (let lag = lo; lag <= hi; lag++) {
      const idx = lag >= 0 ? lag : N + lag;
      const val = reG[idx] / norm;
      if (val > bestVal) { bestVal = val; bestLag = lag; }
    }
    return { peak: bestVal, lagSamples: bestLag };
  }

  // bufA/bufB: Float32Array(또는 배열형) — 각 채널의 "최근 N초" 다운샘플
  // 스니펫. rateA/rateB: 각 스니펫의 실제 캡처 샘플레이트. maxLagSec: 탐색할
  // 최대 지연(초, centerLagSec 중심으로 ±maxLagSec). whiteningExponent 생략
  // 시 0(권장값, 위 설명 참고).
  //
  // centerLagSec(기본 0, docs/collab-latency-architecture.md): 두 채널의
  // 실측 레이턴시 차이(초)로 탐색 중심을 옮긴다. **부호 주의**: 이 함수의
  // lagSec는 "A[m] ≈ B[m-lag]"(A가 lag초만큼 B보다 지연) 관계로 정의되어
  // dashboard.js Stage1(lag=LB-LA)과 부호가 반대다(실측: B가 A보다 0.5초
  // 더 지연되면 lagSec=-0.5) — 그래서 여기 넘기는 값은 `LA - LB`여야 한다
  // (호출부 refreshWaveformScoreForPair 참고).
  //
  // 반환: { score, lagSec } | null(입력이 너무 짧으면). score는 대략 -1~1
  // 정규화 상관계수(같은 신호면 1에 가까움). 실제 방송 데이터로 임계값을
  // 검증한 적은 없다 — docs/collab-architecture.md §6/§8 열린 질문 참고.
  function computeGccPhat(bufA, rateA, bufB, rateB, maxLagSec, whiteningExponent, centerLagSec) {
    if (!bufA || !bufB || bufA.length < 8 || bufB.length < 8) return null;
    const targetRate = Math.min(rateA, rateB);
    const a = removeMean(rateA === targetRate ? bufA : resampleLinear(bufA, rateA, targetRate));
    const b = removeMean(rateB === targetRate ? bufB : resampleLinear(bufB, rateB, targetRate));
    const maxLagSamples = Math.max(1, Math.round(maxLagSec * targetRate));
    const limit = Math.min(maxLagSamples, a.length - 1, b.length - 1);
    const centerLagSamples = Math.round((centerLagSec || 0) * targetRate);
    const { peak, lagSamples } = generalizedCrossCorrelate(a, b, limit, whiteningExponent, centerLagSamples);
    return { score: peak, lagSec: lagSamples / targetRate };
  }

  // dashboard.js(메인 스레드)뿐 아니라 gcc-phat-worker.js(전용 워커, self만
  // 존재하고 window는 없음)에서도 importScripts로 이 파일을 그대로 불러
  // 쓴다 — FFT 연산이 메인 스레드를 막지 않도록 워커로 옮겼다(§8.6).
  (typeof window !== 'undefined' ? window : self).computeGccPhat = computeGccPhat;
})();
