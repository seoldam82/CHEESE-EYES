// ── CHEESE EYES offscreen 문서 ──────────────────────────────────────
// background.js가 유튜브 InnerTube 인증 요청을 보낼 때, 확장 자신의
// 컨텍스트(chrome-extension://...)가 아니라 진짜 https://www.youtube.com
// origin 안에서 fetch가 실행되도록 중계하는 역할만 한다.
//
// iframe src는 유튜브가 제3자 삽입을 공식 허용하는 /embed/ 경로를 쓴다.
// 실제로 어떤 영상이 로드되는지는 중요하지 않다 — offscreen 문서 자체가
// 화면에 그려지지 않고, 우리는 이 프레임의 "origin"만 필요하기 때문이다.
const PROXY_VIDEO_ID = 'dQw4w9WgXcQ'; // 항상 살아있는 안정적인 공개 영상 ID, 재생 여부는 무관
const IFRAME_ORIGIN = 'https://www.youtube.com';

let iframeEl = null;
let iframeReady = false;
const pending = new Map();
let reqCounter = 0;

function ensureIframe() {
  if (iframeEl) return;
  iframeEl = document.createElement('iframe');
  iframeEl.name = 'cheese-eyes-yt-proxy';
  iframeEl.style.display = 'none';
  iframeEl.src = `${IFRAME_ORIGIN}/embed/${PROXY_VIDEO_ID}?autoplay=0&controls=0`;
  document.body.appendChild(iframeEl);
}

window.addEventListener('message', (event) => {
  if (!iframeEl || event.source !== iframeEl.contentWindow) return;
  if (!event.data) return;

  if (event.data.type === 'CHEESE_YT_PROXY_READY') {
    iframeReady = true;
    return;
  }
  if (event.data.type === 'CHEESE_YT_PROXY_RESULT') {
    const { requestId, ...rest } = event.data;
    const resolve = pending.get(requestId);
    if (resolve) {
      pending.delete(requestId);
      resolve(rest);
    }
  }
});

function waitUntilReady(timeoutMs) {
  if (iframeReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (iframeReady) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'OFFSCREEN_YT_FETCH') return false;

  (async () => {
    ensureIframe();
    const ready = await waitUntilReady(5000);
    if (!ready) {
      sendResponse({ ok: false, status: 0, statusText: '유튜브 프록시 프레임 준비 시간 초과', body: '' });
      return;
    }

    const requestId = `req_${++reqCounter}`;
    const resultPromise = new Promise((resolve) => pending.set(requestId, resolve));
    iframeEl.contentWindow.postMessage(
      { type: 'CHEESE_YT_PROXY_FETCH', requestId, url: message.url, init: message.init },
      IFRAME_ORIGIN
    );

    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve(null), 15000)
    );
    const result = await Promise.race([resultPromise, timeout]);
    if (result == null) {
      pending.delete(requestId);
      sendResponse({ ok: false, status: 0, statusText: '유튜브 프록시 요청 시간 초과', body: '' });
      return;
    }
    sendResponse(result);
  })();

  return true; // 비동기 응답
});
