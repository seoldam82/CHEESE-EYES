(function () {
  try {
    window.parent.location.hostname;
    return;
  } catch (e) {
  }

  const isChatFrame = new URLSearchParams(window.location.search).get('vtype') === 'chat';

  if (isChatFrame) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  if (!isChatFrame) {
    let waitAttempts = 0;
    const maxWaitAttempts = 150;    const notifyReady = () => {
      try {
        const channelId = window.location.pathname.split('/').filter(Boolean)[0];
        console.log('[CHEESE EYES] SOOP 영상 프레임: liveView 로딩 완료, 부모에 신호 전송', channelId);
        window.parent.postMessage({ type: 'SOOP_VIDEO_LOGIN_READY', channelId }, '*');
      } catch (e) {}
    };
    const waitForLiveView = () => {
      waitAttempts++;
      if (window.liveView && window.liveView._isLoaded && typeof window.liveView._isLoaded.then === 'function') {
        window.liveView._isLoaded.then(notifyReady, notifyReady);
      } else if (waitAttempts < maxWaitAttempts) {
        setTimeout(waitForLiveView, 100);
      } else {
        console.warn('[CHEESE EYES] SOOP 영상 프레임: liveView를 찾지 못해 준비 신호를 강제로 보냄');
        notifyReady();
      }
    };
    waitForLiveView();
    return;
  }

  if (window.opener != null) return;

  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const channelId = pathParts[0];
  if (!channelId) return;

  const frameName = isNaN(Number(channelId)) ? channelId : `#${channelId}`;
  console.log(`[CHEESE EYES] SOOP 채팅 프레임 진입, channelId=${channelId}, frameName=${frameName}`);

  let attempts = 0;
  const maxAttempts = 50;  
  const tryBind = () => {
    attempts++;
    let videoWindow = null;
    try {
      videoWindow = window.parent[frameName];
    } catch (e) {}

    if (videoWindow) {
      try {
        // [CHEESE EYES] window.opener 대체 구현: SOOP 채팅 프레임은 로그인 인식을 위해
        // window.opener가 필요하지만, 대시보드는 채팅/영상을 iframe으로 배치하고
        // window.open()을 쓰지 않아 opener가 비어 로그인 상태를 인식 못 한다. 자격 증명
        // 탈취나 임의 코드 실행 없이, 같은 대시보드의 영상 프레임(videoWindow) 참조를
        // opener로 노출해 iframe 환경에서도 기존 로그인 채팅 동작을 유지한다.
        Object.defineProperty(window, 'opener', {
          get: () => videoWindow,
          configurable: true
        });
        console.log(`[CHEESE EYES] SOOP 채팅 opener 바인딩 성공 (frameName=${frameName}, attempts=${attempts})`);
        document.documentElement.setAttribute('dark', 'true');

        setTimeout(() => {
          try {
            const desc = Object.getOwnPropertyDescriptor(window, 'opener');
            console.log('[CHEESE EYES] 3초 후 opener 상태:', window.opener, '(getter 유지됨:', desc && desc.get === undefined ? '아니오(덮어써짐)' : '예', ')');
          } catch (e) {
            console.log('[CHEESE EYES] 3초 후 opener 상태 확인 실패:', e);
          }
        }, 3000);
      } catch (err) {
        console.warn('[CHEESE EYES] SOOP 채팅 opener 흉내내기 실패:', err);
      }
    } else if (attempts < maxAttempts) {
      setTimeout(tryBind, 100);
    } else {
      console.warn(`[CHEESE EYES] SOOP 채팅 opener 바인딩 실패: window.parent[${frameName}]를 ${maxAttempts}번 시도해도 못 찾음`);
    }
  };
  tryBind();

  window.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('modal');
    if (modal == null) return;
    const modalObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const n of mutation.addedNodes) {
          if (n.querySelector?.('#layerLogin')) {
            console.warn('[CHEESE EYES] SOOP 채팅: 로그인 필요 모달(#layerLogin) 감지됨 - 로그인 세션이 채팅 프레임에 인식되지 않음');
            try {
              const retryKey = 'cheeseEyesChatLoginRetryCount';
              const maxAutoRetries = 3;
              const retryCount = parseInt(sessionStorage.getItem(retryKey) || '0', 10);
              if (retryCount < maxAutoRetries) {
                sessionStorage.setItem(retryKey, String(retryCount + 1));
                const delay = 1500 * (retryCount + 1);                console.warn(`[CHEESE EYES] 채팅 프레임 재초기화 요청 전송 (${delay}ms 후, 시도 ${retryCount + 1}/${maxAutoRetries}, referrer 보존을 위해 부모에 위임)`);
                setTimeout(() => {
                  window.parent.postMessage({ type: 'SOOP_CHAT_NEEDS_REINIT', channelId }, '*');
                }, delay);
              } else {
                console.warn(`[CHEESE EYES] 자동 재초기화 ${maxAutoRetries}회 모두 소진 - 더 이상 자동으로 재시도하지 않음(채팅 탭의 새로고침 버튼 사용 필요)`);
              }
            } catch (e) {
              console.warn('[CHEESE EYES] 재초기화 요청 실패:', e);
            }
            return;
          }
        }
      }
    });
    modalObserver.observe(modal, { childList: true });
  });
})();