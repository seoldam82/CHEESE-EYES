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
        const res = await fetch(url, { ...(init || {}), credentials: 'include' });
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