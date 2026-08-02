// ── CHEESE EYES 유튜브 InnerTube 프록시 (실제 youtube.com origin에서 실행) ──
// 이 스크립트는 src/html/offscreen.html이 만드는 숨김 iframe(window.name이
// 'cheese-eyes-yt-proxy'로 세팅된 프레임) 안에서만 동작한다. 그 외의 모든
// 일반 사용자 탭/임베드(유튜브 영상 시청, 다른 사이트가 삽입한 유튜브 임베드
// 등)에서는 아래 window.name 체크에서 즉시 종료되어 아무 영향도 주지 않는다.
//
// 목적: background.js(확장 자신의 컨텍스트, origin=chrome-extension://...)가
// 아니라 진짜 https://www.youtube.com 문서 안에서 InnerTube fetch를 실행해
// 브라우저가 자동으로 붙이는 실제 Origin/Referer 헤더가 SAPISIDHASH 계산에
// 쓰인 origin과 항상 일치하도록 한다. Origin 헤더를 확장 권한으로 위조하는
// 방식(declarativeNetRequest 등)은 사이트의 위조 방지 검증을 우회하는
// 행위로 볼 수 있어 사용하지 않는다 — 여기서는 헤더를 조작하지 않고,
// "실제로 그 origin에 있는" 정상적인 요청만 보낸다.
(function () {
  if (window.name !== 'cheese-eyes-yt-proxy') return;

  let EXTENSION_ORIGIN;
  try {
    EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
  } catch (e) {
    return; // chrome.runtime을 못 쓰는 컨텍스트면 안전하게 아무 것도 하지 않음
  }

  window.addEventListener('message', (event) => {
    // 우리 확장(offscreen 문서) 외의 어떤 발신자도 신뢰하지 않는다.
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
    window.parent.postMessage({ type: 'CHEESE_YT_PROXY_READY' }, EXTENSION_ORIGIN);
  } catch (e) {}
})();
