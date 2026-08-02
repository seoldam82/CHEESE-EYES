if (window.self === window.top) {
  const topStyle = document.createElement('style');
  topStyle.textContent = `
    .ext-theatre-iframe-active {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483647 !important;
      border: none !important;
    }
    body.ext-theatre-body-active {
      overflow: hidden !important;
    }
  `;
  (document.head || document.documentElement).appendChild(topStyle);

  window.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.type === 'TOGGLE_PARENT_THEATRE') {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((iframe) => {
        if (iframe.contentWindow === event.source) {
          const isFull = iframe.classList.toggle('ext-theatre-iframe-active');
          document.body.classList.toggle('ext-theatre-body-active', isFull);
        }
      });
    }
  });

} else {
  const host = window.location.hostname;
  const isSoopHost = host.includes('play.sooplive.com') || host.includes('sooplive.co.kr') || host.includes('afreecatv.com');
  const isChzzkHost = host.includes('chzzk.naver.com');
  const isYoutubeHost = host.endsWith('youtube.com');
  const isYoutubeChatFrame = isYoutubeHost && window.location.pathname.startsWith('/live_chat');
  const isYoutubeVideoFrame = isYoutubeHost && window.location.pathname.startsWith('/embed/');

  const isChatFrame = isYoutubeHost
    ? isYoutubeChatFrame
    : isSoopHost
      ? new URLSearchParams(window.location.search).get('vtype') === 'chat'
      : window.location.href.includes('/chat');

  let extensionOrigin = null;
  try { extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, ''); } catch (e) {}

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'CHEESE_API_PROXY') return;
    // 이 프레임은 매니페스트 매칭(URL 기준)만으로 주입되므로, 우리 대시보드가
    // 아닌 임의의 페이지가 같은 URL의 iframe을 자기 사이트에 심어놓고 이
    // 메시지를 보낼 수도 있다. 우리 확장 페이지에서 온 메시지인지 확인한다.
    if (!extensionOrigin || event.origin !== extensionOrigin) return;
    const { requestId, url, init } = event.data;
    (async () => {
      try {
        const res = await fetch(url, { ...(init || {}), credentials: 'include' });
        const body = await res.text();
        event.source && event.source.postMessage({
          type: 'CHEESE_API_PROXY_RESULT', requestId, ok: res.ok, status: res.status, body
        }, extensionOrigin);
      } catch (err) {
        event.source && event.source.postMessage({
          type: 'CHEESE_API_PROXY_RESULT', requestId, ok: false, status: 0, body: '', error: String((err && err.message) || err)
        }, extensionOrigin);
      }
    })();
  });

  if (isChatFrame) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  const style = document.createElement('style');

  if (isChzzkHost) {
    if (isChatFrame) {
      style.textContent = `
        * {
          -ms-overflow-style: none !important;
          scrollbar-width: none !important;
        }
        *::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        html, body, #root, main, [class*="chatting_container__"], [class*="live_chatting_area__"] {
          width: 100% !important;
          height: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          background-color: #181823 !important;
        }
      `;
    } else {
      style.textContent = `
        * {
          -ms-overflow-style: none !important;
          scrollbar-width: none !important;
        }
        *::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        [class*="header_container__"], 
        [class*="live_information_container__"], 
        [class*="sidebar_container__"], 
        [class*="live_chatting_container__"],
        [class*="live_stage_chatting__"],
        [class*="chatting_container__"],
        [class*="live_chatting_area__"],
        aside, header, footer { 
          display: none !important; 
          visibility: hidden !important;
          pointer-events: none !important;
        }
        html, body, main, [class*="content_container__"], [class*="live_content__"], [class*="live_stage_layout__"], [class*="live_stage_container__"], [class*="live_stage_player__"] {
          padding: 0 !important;
          margin: 0 !important;
          width: 100% !important;
          max-width: 100% !important;
          height: 100% !important;
          min-height: 100% !important;
          overflow: hidden !important;
          background: #000 !important;
        }
        [class*="player_container__"], [class*="video_container__"], [class*="webplayer_"] {
          width: 100% !important;
          height: 100% !important;
          max-width: 100% !important;
          max-height: 100% !important;
          padding: 0 !important;
          margin: 0 !important;
        }
        video {
          width: 100% !important;
          height: 100% !important;
          object-fit: contain !important;
        }
      `;
    }
  } else if (isSoopHost) {
    const soopChatBg = '#181823';

    style.textContent = `
      * {
        -ms-overflow-style: none !important;
        scrollbar-width: none !important;
      }
      *::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
      html, body, #player_area, .player_wrap, #webplayer {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        height: 100% !important;
        min-width: 0 !important;
        min-height: 0 !important;
        overflow: hidden !important;
        background: ${isChatFrame ? soopChatBg : '#000'} !important;
      }
      /* SOOP 데스크톱 레이아웃 기준으로 player_area/webplayer 내부 요소들에
         min-width가 박혀있어서, 프레임이 그보다 좁아지면 안 줄어들고 잘리며
         옆으로 밀려나온다. 플레이어 안쪽 전체에 min-width를 강제로 풀어서
         프레임 폭에 맞춰 실제로 줄어들 수 있게 한다. (치지직은 애초에 이런
         min-width 제약이 없어서 이 문제가 없었음) */
      ${isChatFrame ? '' : `
      #player_area, #player_area *, .player_wrap, .player_wrap *, #webplayer, #webplayer * {
        min-width: 0 !important;
      }
      `}
      video {
        width: 100% !important;
        height: 100% !important;
        min-width: 0 !important;
        object-fit: contain !important;
      }
      .embeded_mode #webplayer.chat_open #chatting_area {
        display: none !important;
      }
      .embeded_mode #webplayer #player div.quality_box {
        display: block !important;
      }
      .popout_chat #chatting_area {
        min-width: auto !important;
      }
      #webplayer #player_area {
        max-width: 100% !important;
      }
    `;
  } else if (isYoutubeHost) {
    // 유튜브 embed/live_chat 페이지는 자체적으로 깔끔한 임베드 레이아웃을 제공하므로
    // 치지직/숲처럼 DOM을 적극적으로 숨기지 않고 스크롤바 제거 + 여백 정리만 한다.
    style.textContent = `
      * {
        -ms-overflow-style: none !important;
        scrollbar-width: none !important;
      }
      *::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        background: #0f0f0f !important;
      }
      ${isYoutubeVideoFrame ? `
      video {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
      }
      ` : ''}
    `;
  }

  (document.head || document.documentElement).appendChild(style);

  if (!isChatFrame && isSoopHost) {
    function isolateSoopPlayer() {
      const player = document.querySelector('#player_area') || document.querySelector('.player_wrap') || document.querySelector('#webplayer');
      if (!player) return false;

      let el = player;
      while (el && el.parentElement && el !== document.body) {
        const parent = el.parentElement;
        Array.from(parent.children).forEach((sibling) => {
          if (sibling !== el) {
            sibling.style.setProperty('display', 'none', 'important');
          }
        });
        parent.style.setProperty('margin', '0', 'important');
        parent.style.setProperty('padding', '0', 'important');
        parent.style.setProperty('width', '100%', 'important');
        parent.style.setProperty('max-width', '100%', 'important');
        parent.style.setProperty('min-width', '0', 'important');
        parent.style.setProperty('height', '100%', 'important');
        parent.style.setProperty('overflow', 'hidden', 'important');
        el = parent;
      }

      const video = document.querySelector('video');
      if (video && player.contains(video)) {
        let inner = video;
        let guard = 0;
        while (inner && inner.parentElement && inner !== player && guard < 20) {
          guard++;
          const parent = inner.parentElement;
          Array.from(parent.children).forEach((sibling) => {
            if (sibling === inner) return;
            if (sibling.tagName === 'VIDEO') return;
            const hasControl = sibling.querySelector && sibling.querySelector('button, input, [role="slider"], [role="button"]');
            if (hasControl) return;
            sibling.style.setProperty('display', 'none', 'important');
          });
          inner = parent;
        }
      }

      return true;
    }

    isolateSoopPlayer();
    setInterval(isolateSoopPlayer, 1000);
  }

  function cleanupChatMessages() {
    if (!isChatFrame) return;
    if (isChzzkHost) {
      const chatItems = document.querySelectorAll('[class*="chatting_list__"] > div, [class*="live_chatting_list__"] > div');
      if (chatItems.length > 60) {
        const removeCount = chatItems.length - 60;
        for (let i = 0; i < removeCount; i++) {
          chatItems[i].remove();
        }
      }
    }
  }
  setInterval(cleanupChatMessages, 3000);

  if (!isChatFrame && (isChzzkHost || isSoopHost)) {
    console.log('🚀 [ScreenMode Inject] 스크립트 주입됨');

    let activeScreenIntervals = [];
    let screenModeAppliedSuccess = false;

    function clearAllScreenIntervals() {
      activeScreenIntervals.forEach((id) => clearInterval(id));
      activeScreenIntervals = [];
    }

    document.addEventListener('click', (e) => {
      if (e.isTrusted) {
        window.parent.postMessage({
          type: 'FRAME_CLICKED',
          url: window.location.href
        }, '*');
      }
    }, true);

    const CHEESE_FORWARD_KEYS = new Set(['z', 'Z', 'x', 'X', 'c', 'C', 'v', 'V', '/', 'Escape', 'Esc']);
    document.addEventListener('keydown', (e) => {
      if (!CHEESE_FORWARD_KEYS.has(e.key)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      const isTyping = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable
      );
      if (isTyping) return;

      window.parent.postMessage({ type: 'CHEESE_FORWARD_SHORTCUT', key: e.key }, '*');
    }, true);

    function checkWideModeDOM() {
      if (isSoopHost) {
        const bodyClass = document.body.className;
        const webplayer = document.querySelector('#webplayer');
        const webplayerClass = webplayer ? webplayer.className : '';
        
        return bodyClass.includes('screen_mode') || 
               bodyClass.includes('wide_mode') || 
               bodyClass.includes('web_fullscreen') ||
               webplayerClass.includes('screen') ||
               webplayerClass.includes('wide');
      }
      if (isChzzkHost) {
        const player = document.querySelector('[class*="live_player_video"], [class*="player_container"]');
        return player ? player.className.includes('theater') : false;
      }
      return false;
    }

    function isAlreadyWideMode() {
      if (screenModeAppliedSuccess) return true;
      return checkWideModeDOM();
    }

    function triggerScreenMode() {
      if (isAlreadyWideMode()) {
        return true;
      }

      let btn = null;
      if (isChzzkHost) {
        btn = document.querySelector('[class*="btn_theater"], [class*="p2p_theater_button"], [aria-label*="넓은"], [aria-label*="극장"]');
      } else if (isSoopHost) {
        btn = document.querySelector('button.btn_screen_mode, #screen_mode, .btn_screen, [tip="스크린모드"], [data-title="스크린모드"]');
      }

      if (btn) {
        console.log('🎯 [ScreenMode] 버튼 클릭 실행:', btn);
        btn.click();
        return true;
      }

      return false;
    }

    function applyScreenModePersistent() {
      if (screenModeAppliedSuccess || isAlreadyWideMode()) {
        screenModeAppliedSuccess = true;
        clearAllScreenIntervals();
        return;
      }

      let attempts = 0;
      const maxAttempts = 30;

      function attemptOnce() {
        if (screenModeAppliedSuccess || isAlreadyWideMode()) {
          screenModeAppliedSuccess = true;
          clearAllScreenIntervals();
          return true;
        }

        attempts++;

        const video = document.querySelector('video');
        const isVideoReady = isChzzkHost || (video && video.readyState >= 2);

        if (isVideoReady) {
          triggerScreenMode();

          if (isAlreadyWideMode()) {
            console.log('🎉 [ScreenMode] 적용 확인 완료!');
            screenModeAppliedSuccess = true;
            clearAllScreenIntervals();
            return true;
          }
        } else {
          console.log(`⏳ [ScreenMode Loop ${attempts}/${maxAttempts}] 비디오 로딩 대기 중...`);
        }

        return false;
      }

      if (attemptOnce()) return;

      const intervalId = setInterval(() => {
        if (attemptOnce()) return;

        if (attempts >= maxAttempts) {
          console.log('🏁 [ScreenMode Loop] 최대 시도 횟수 초과로 타이머 정지');
          clearInterval(intervalId);
          activeScreenIntervals = activeScreenIntervals.filter((id) => id !== intervalId);
        }
      }, 150);
      activeScreenIntervals.push(intervalId);
    }

    let isMouseInsideFrame = false;

    function reapplyScreenModeIfDropped() {
      if (!isMouseInsideFrame) return;
      if (checkWideModeDOM()) return;
      if (activeScreenIntervals.length > 0) return;
      console.log('🔄 [ScreenMode Watch] 스크린모드 해제 감지 -> 재적용 시도');
      screenModeAppliedSuccess = false;
      applyScreenModePersistent();
    }

    document.addEventListener('mouseenter', () => {
      isMouseInsideFrame = true;
      reapplyScreenModeIfDropped();
    });
    document.addEventListener('mouseleave', () => {
      isMouseInsideFrame = false;
    });

    function getWideModeWatchTargets() {
      const targets = [document.body];
      if (isSoopHost) {
        const webplayer = document.querySelector('#webplayer');
        if (webplayer) targets.push(webplayer);
      }
      if (isChzzkHost) {
        const player = document.querySelector('[class*="live_player_video"], [class*="player_container"]');
        if (player) targets.push(player);
      }
      return targets;
    }

    const screenModeObserver = new MutationObserver(() => {
      reapplyScreenModeIfDropped();
    });
    getWideModeWatchTargets().forEach((el) => {
      screenModeObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
    });

    const watchedTargets = new WeakSet(getWideModeWatchTargets());
    setInterval(() => {
      if (!isMouseInsideFrame) return;
      getWideModeWatchTargets().forEach((el) => {
        if (!watchedTargets.has(el)) {
          watchedTargets.add(el);
          screenModeObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
        }
      });
      reapplyScreenModeIfDropped();
    }, 200);
    window.addEventListener('message', (event) => {
      if (!event.data) return;

      const { type } = event.data;

      if (
        type === 'APPLY_SCREEN_MODE' ||
        type === 'APPLY_WIDE_MODE' ||
        type === 'REAPPLY_ALL'
      ) {
        if (!screenModeAppliedSuccess) {
          console.log('📩 [ScreenMode Message] 적용 신호 수신');
          applyScreenModePersistent();
        }
      } else if (type === 'RELOAD_PLAYER') {
        window.location.reload();
      } else if (type === 'DESTROY_PLAYER') {
        screenModeAppliedSuccess = false;
        clearAllScreenIntervals();
        const video = document.querySelector('video');
        if (video) {
          video.pause();
          video.removeAttribute('src');
          video.load();
        }
      }
    });

    setTimeout(() => {
      if (!screenModeAppliedSuccess && !isAlreadyWideMode()) {
        console.log('⏰ [ScreenMode Init] 레이아웃 안정화 후 최초 시도');
        applyScreenModePersistent();
      }
    }, 3500);

  }
}