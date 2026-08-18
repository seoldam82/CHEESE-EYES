(function () {
  if (window.name !== 'cheese-eyes-yt-proxy') return;

  let EXTENSION_ORIGIN;
  try {
    EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
  } catch (e) {
    return;
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== EXTENSION_ORIGIN) return;
    if (!event.data || event.data.type !== 'CHEESE_YT_PROXY_FETCH') return;

    const { requestId, url, init } = event.data;
    (async () => {
      let result;
      try {
        // 이 iframe은 여러 InnerTube 호출이 공유하는 숨겨진 프록시라, 로그인
        // 쿠키를 실으면(과거 시도) 로그인 보호/이상 탐지에 걸려 전체가 먹통이
        // 됐다 — 항상 완전 익명으로만 요청한다.
        const res = await fetch(url, { ...(init || {}), credentials: 'omit' });
        const body = await res.text();
        result = { requestId, ok: res.ok, status: res.status, statusText: res.statusText, body };
      } catch (err) {
        result = { requestId, ok: false, status: 0, statusText: String((err && err.message) || err), body: '' };
      }
      event.source.postMessage({ type: 'CHEESE_YT_PROXY_RESULT', ...result }, EXTENSION_ORIGIN);
    })();
  });

  try {
    window.top.postMessage({ type: 'CHEESE_YT_PROXY_READY' }, EXTENSION_ORIGIN);
  } catch (e) {}
})();