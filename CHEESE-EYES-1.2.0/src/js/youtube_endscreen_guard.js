// [CHEESE EYES] 유튜브 임베드 엔딩화면/추천 영상 클릭 시 새 탭이 열리는 걸 막고
// 영상ID를 부모(relay.html)에 알려 대기열에 담는다(§docs/relay.html
// CHEESE_YT_SUGGESTION_CLICKED, §dashboard.js enqueueYoutubeVideo).
//
// document 최상위 capture 리스너만으론 실측상 못 잡는 경우가 있었다 —
// window.open 오버라이드도 클릭 캡처도 반응 안 하는데 새 탭이 열림. 유력한
// 원인은 유튜브가 링크를 (닫힌 것 포함) shadow DOM에 둬서 e.target/
// composedPath()가 shadow host로 재타겟팅되고, target="_blank" 기본 동작은
// window.open()을 거치지 않는 것. Element.prototype.attachShadow를 감싸서
// 새로 생기는 모든 shadow root(닫힌 것 포함)에도 클릭 캡처 리스너를 직접 심어 우회한다.
(function () {
  const host = window.location.hostname;
  const isYoutubeVideoFrame = host.endsWith('youtube.com') && window.location.pathname.startsWith('/embed/');
  if (!isYoutubeVideoFrame) return;

  const YT_WATCH_ID_RE = /[?&]v=([a-zA-Z0-9_-]{11})/;
  const YT_SHORT_ID_RE = /youtu\.be\/([a-zA-Z0-9_-]{11})/;

  const nativeWindowOpen = window.open.bind(window);
  window.open = function (url) {
    if (typeof url === 'string' && (url.includes('youtube.com') || url.includes('youtu.be'))) {
      const m = YT_WATCH_ID_RE.exec(url) || YT_SHORT_ID_RE.exec(url);
      if (m) {
        window.parent.postMessage({ type: 'CHEESE_YT_SUGGESTION_CLICKED', videoId: m[1] }, '*');
        return null;
      }
    }
    return nativeWindowOpen.apply(window, arguments);
  };

  function findYoutubeLink(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const el of path) {
      if (el && el.tagName === 'A' && el.href) return el;
    }
    if (e.target && e.target.closest) {
      const viaClosest = e.target.closest('a');
      if (viaClosest && viaClosest.href) return viaClosest;
    }
    return null;
  }

  function handleClick(e) {
    const link = findYoutubeLink(e);
    if (!link || !link.href) return;
    const m = YT_WATCH_ID_RE.exec(link.href) || YT_SHORT_ID_RE.exec(link.href);
    if (!m) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.parent.postMessage({ type: 'CHEESE_YT_SUGGESTION_CLICKED', videoId: m[1] }, '*');
  }

  document.addEventListener('click', handleClick, true);

  // [CHEESE EYES] 실측상 진짜 클릭(target=DIV)은 잡히는데 <a>가 composedPath에
  // 없고 window.open도 안 불리는 채 새 탭이 열렸다 — 유튜브가 detached
  // <a target="_blank">를 만들어 바로 .click()하는 트릭을 쓰는 것으로 보인다.
  // 이런 클릭은 document까지 전파되지 않아 캡처 리스너로 못 잡으므로,
  // 대신 이 트릭이 반드시 거치는 HTMLAnchorElement.prototype.click() 자체를
  // 감싸 DOM 연결 여부와 무관하게 항상 잡는다.
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const href = this.href;
      if (typeof href === 'string' && (href.includes('youtube.com') || href.includes('youtu.be'))) {
        const m = YT_WATCH_ID_RE.exec(href) || YT_SHORT_ID_RE.exec(href);
        if (m) {
          window.parent.postMessage({ type: 'CHEESE_YT_SUGGESTION_CLICKED', videoId: m[1] }, '*');
          return;
        }
      }
    } catch (err) {}
    return nativeAnchorClick.apply(this, arguments);
  };

  // shadow DOM(닫힌 것 포함) 안의 링크를 잡기 위해, 이후 생성되는 모든
  // shadow root 내부에도 같은 캡처 리스너를 직접 심는다.
  try {
    const nativeAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = nativeAttachShadow.call(this, init);
      try {
        root.addEventListener('click', handleClick, true);
      } catch (err) {}
      return root;
    };
  } catch (err) {
    console.warn('[CHEESE EYES] attachShadow 오버라이드 실패:', err);
  }
})();
