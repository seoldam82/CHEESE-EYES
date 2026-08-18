// dashboard.js(합방 겹침 감지 Stage 2)가 쓰는 GCC-PHAT 계산 전용 워커.
// docs/collab-architecture.md §8.6 참고.
//
// computeGccPhat은 FFT를 세 번(정방향 2 + 역방향 1) 돌려 메인 스레드에서
// 수십 ms를 잡아먹을 수 있고, 이게 setInterval(1.2초)마다 UI가 순간
// 먹통처럼 느껴지는 원인이었다. 이 워커가 그 계산만 별도 스레드로 뺀다.
importScripts('gcc-phat.js');

self.onmessage = (event) => {
  const { requestId, bufA, rateA, bufB, rateB, maxLagSec, centerLagSec } = event.data || {};
  let result = null;
  try {
    result = computeGccPhat(bufA, rateA, bufB, rateB, maxLagSec, undefined, centerLagSec);
  } catch (err) {
    result = null;
  }
  self.postMessage({ requestId, result });
};
