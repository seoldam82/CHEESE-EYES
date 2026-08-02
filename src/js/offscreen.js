const PROXY_VIDEO_ID = 'dQw4w9WgXcQ';
const IFRAME_ORIGIN = 'https://www.youtube.com';
const RELAY_URL = 'https://seoldam82.github.io/CHEESE-EYES/relay.html';

let iframeEl = null;
let iframeReady = false;
const pending = new Map();
let reqCounter = 0;

function ensureIframe() {
  if (iframeEl) return;
  iframeEl = document.createElement('iframe');
  iframeEl.style.display = 'none';
  iframeEl.src = `${RELAY_URL}?type=proxy&v=${PROXY_VIDEO_ID}`;
  document.body.appendChild(iframeEl);
}

function getProxyFrame() {
  try {
    return iframeEl && iframeEl.contentWindow ? iframeEl.contentWindow.frames[0] : null;
  } catch (e) {
    return null;
  }
}

window.addEventListener('message', (event) => {
  const proxyFrame = getProxyFrame();
  if (!proxyFrame || event.source !== proxyFrame) return;
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

    const proxyFrame = getProxyFrame();
    if (!proxyFrame) {
      sendResponse({ ok: false, status: 0, statusText: '유튜브 프록시 프레임을 찾을 수 없음', body: '' });
      return;
    }

    const requestId = `req_${++reqCounter}`;
    const resultPromise = new Promise((resolve) => pending.set(requestId, resolve));
    proxyFrame.postMessage(
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

  return true;
});