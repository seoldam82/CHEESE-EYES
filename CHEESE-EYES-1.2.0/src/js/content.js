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
  const isSoopHost = host.includes('play.sooplive.com') || host.includes('vod.sooplive.com') || host.includes('sooplive.co.kr') || host.includes('afreecatv.com');
  const isChzzkHost = host.includes('chzzk.naver.com');
  const isYoutubeHost = host.endsWith('youtube.com');
  const isYoutubeChatFrame = isYoutubeHost && window.location.pathname.startsWith('/live_chat');
  const isYoutubeVideoFrame = isYoutubeHost && window.location.pathname.startsWith('/embed/');

  const isChatFrame = isYoutubeHost
    ? isYoutubeChatFrame
    : isSoopHost
      ? new URLSearchParams(window.location.search).get('vtype') === 'chat'
      : window.location.href.includes('/chat');
  // dashboard.js가 재생 위치 기준 채팅 다시보기 조회에 쓰므로(§loadChzzkVodChat),
  // 아래 재생 위치 보고 인터벌 대상에 포함시킨다.
  const isChzzkVodFrame = isChzzkHost && !isChatFrame && window.location.pathname.startsWith('/video/');
  // 숲 VOD 플레이어(vod.sooplive.com)도 재생위치 보고 대상 — VOD 합방 싱크
  // 동기화(docs/vod-collab-sync-architecture.md §4.8)가 드리프트 보정에
  // 필요로 한다. 예전엔 "숲은 VOD 채팅탭이 없어서" 이 인터벌 대상에서
  // 빠져 있었는데, 이제 채팅 다시보기 용도가 아니라도 재생위치 자체가
  // 필요해졌다.
  const isSoopVodFrame = host.includes('vod.sooplive.com');

  // 채팅 다시보기 전용 보조 임베드(§docs/vod-chat-architecture.md) — 치지직
  // VOD 페이지에서 #vod-aside만 잘라 보여줄 때 URL에 붙는 마커
  // (§PlatformAdapters.chzzk.getChatEmbedUrl). 네이티브 REST 모드에서는
  // 안 쓰임. 이 프레임에선 화면모드/오디오그래프/재생위치보고 등 메인
  // 재생 타일 전용 로직을 끄고 영상은 강제 음소거만 한다 — 메인과
  // 소리가 겹치지 않게.
  const isCheeseChatEmbed = isChzzkHost && new URLSearchParams(window.location.search).get('cheeseChatEmbed') === '1';

  if (isCheeseChatEmbed) {
    // 버그 수정: #vod-aside를 fixed로 덮는 CSS만으론 부족했다 — 조상에
    // transform/filter/perspective/contain이 하나라도 있으면 그 조상이
    // 새 containing block이 되어 fixed가 뷰포트 기준으로 안 그려진다
    // (영상 페이지는 흔히 이런 조상을 가짐). CSS로는 안전히 못 피해
    // JS로 #vod-aside를 <body> 바로 아래로 reparent한다.
    // "iframe load"만으로는 치지직 SPA가 자체 로딩화면에 갇힌 상태를
    // 구분 못 해 dashboard.js 감시(§attachChzzkVodChatWatchdog)가 오탐
    // 타임아웃을 냈었다. "#vod-aside 등장"도 부족했다 — 틀(제목/닫기버튼)만
    // 먼저 뜨고 실제 채팅 로그는 한참 로딩 중일 수 있어서, 이걸로
    // '준비됨'을 잘못 보고하면 감시 타이머가 취소돼 다시는 재시도하지
    // 않는다. 그래서 role="log" 안에 진짜 메시지(닉네임 버튼)가 나타나야만
    // 준비됨으로 본다.
    let readyReported = false;
    const promoteVodAside = () => {
      const aside = document.getElementById('vod-aside');
      if (aside && aside.parentElement !== document.body) {
        document.body.appendChild(aside);
      }
      if (aside && !readyReported) {
        const log = aside.querySelector('[role="log"]');
        const hasChatContent = log && (log.querySelector('button[aria-haspopup]') || log.children.length > 1);
        if (hasChatContent) {
          readyReported = true;
          window.parent.postMessage({ type: 'CHZZK_CHAT_EMBED_READY' }, '*');
        }
      }
    };

    // 메인 재생 타일의 재생 위치/정지 상태를 dashboard.js가 릴레이해준다
    // (§dashboard.js CHANNEL_PLAYBACK_TIME 핸들러). 못 받은 동안(연결
    // 직후 등)은 기존처럼 그냥 재생만 계속시켜 채팅 다시보기가 멈춰있지
    // 않게 한다.
    let syncedPaused = false;
    let syncedCurrentTime = null;
    window.addEventListener('message', (event) => {
      if (!event.data || event.data.type !== 'CHZZK_VOD_CHAT_SYNC') return;
      syncedPaused = !!event.data.paused;
      syncedCurrentTime = (typeof event.data.currentTime === 'number' && isFinite(event.data.currentTime))
        ? event.data.currentTime : null;
    });

    const forceMutedAndPlaying = () => {
      promoteVodAside();
      document.querySelectorAll('video').forEach((video) => {
        video.muted = true;
        video.volume = 0;
        // 메인 타일과 위치가 크게 어긋나면(새로고침/탐색 등) 맞춰준다 —
        // 매초 미세하게 흔들리는 걸 막기 위해 2초 넘게 벌어졌을 때만.
        if (syncedCurrentTime !== null && Math.abs(video.currentTime - syncedCurrentTime) > 2) {
          video.currentTime = syncedCurrentTime;
        }
        if (syncedPaused) {
          if (!video.paused) video.pause();
        } else if (video.paused && video.readyState >= 2) {
          // 채팅 다시보기 aside는 실제 재생 위치를 따라가야 스크롤/갱신되므로,
          // 메인이 재생 중이면 음소거된 채로도 계속 재생 상태를 유지시켜준다
          // (자동재생이 막혀 일시정지로 시작하는 경우를 대비한 보수적인 재시도).
          video.play().catch(() => {});
        }
      });
    };
    forceMutedAndPlaying();
    setInterval(forceMutedAndPlaying, 1000);
  }

  // VOD 엔딩화면에서 다른 영상 클릭 시 SPA 라우팅으로 URL이 /video/{ID}로
  // 바뀐다(새로고침 없이). 이 프레임은 chzzk.naver.com을 직접 embed한
  // 것(중계 페이지 없음)이라 URL을 그대로 읽어, 바뀌면 대시보드에 알려
  // 채널 슬롯을 교체한다(§dashboard.js handleVodVideoChanged). 채팅 전용
  // 임베드는 채널 슬롯이 아니므로 제외.
  if (isChzzkHost && !isChatFrame && !isCheeseChatEmbed) {
    const VOD_PATH_RE = /^\/video\/(\d+)/;
    let lastVodId = (VOD_PATH_RE.exec(window.location.pathname) || [])[1] || null;
    setInterval(() => {
      const m = VOD_PATH_RE.exec(window.location.pathname);
      const currentId = m ? m[1] : null;
      if (currentId && currentId !== lastVodId) {
        lastVodId = currentId;
        window.parent.postMessage({ type: 'CHANNEL_VIDEO_CHANGED', videoId: currentId }, '*');
      }
    }, 1000);
  }

  // 유튜브 엔딩화면/카드 클릭을 새 탭 대신 대기열로 가로채는 로직은
  // document_idle보다 먼저 실행돼야 한다 — 이 시점엔 유튜브 폴리머
  // 플레이어가 이미 capture-phase 클릭 리스너를 건 뒤라 놓칠 수 있다.
  // 그래서 src/js/youtube_endscreen_guard.js를 document_start에 따로
  // 주입해 window.open()/클릭 캡처를 먼저 선점한다(§manifest.json,
  // §docs/relay.html CHEESE_YT_SUGGESTION_CLICKED).

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
    } else if (isCheeseChatEmbed) {
      // #vod-aside(실채팅으로 확인한 실제 id, §docs/vod-chat-architecture.md)만
      // 뷰포트 전체로 끌어올려 나머지를 가린다. 아래 요소들을 일일이 안
      // 숨기는 이유: 해시 붙는 CSS 모듈 클래스명은 배포마다 바뀌어 못
      // 믿지만, #vod-aside를 최상위로 덮는 방식은 아래 구조와 무관하게
      // 항상 동작한다.
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
        #vod-aside {
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          margin: 0 !important;
          z-index: 2147483000 !important;
          display: block !important;
          visibility: visible !important;
          opacity: 1 !important;
          pointer-events: auto !important;
        }
        /* 닫기(X) 버튼을 실수로 누르면 치지직 내부 상태에서 닫혀버려
           되살릴 방법이 없다 — 클릭만 막고 아이콘은 그대로 둔다
           (선택자가 안 맞아도 무해하게 안 먹을 뿐이라 안전). */
        #vod-aside [class*="_close_button_"] {
          pointer-events: none !important;
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
      html, body, #player_area, .player_wrap, #webplayer, #videoLayer {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        height: 100% !important;
        min-width: 0 !important;
        min-height: 0 !important;
        overflow: hidden !important;
        background: ${isChatFrame ? soopChatBg : '#000'} !important;
      }
      /* SOOP 데스크톱 레이아웃 기준 player_area/webplayer 내부에 min-width가
         박혀있어 프레임이 좁아지면 잘리고 밀려난다. 내부 전체 min-width를
         강제로 풀어 프레임 폭에 맞게 줄어들게 한다(치지직은 이 제약이
         없어 문제없음). */
      ${isChatFrame ? '' : `
      #player_area, #player_area *, .player_wrap, .player_wrap *, #webplayer, #webplayer *, #videoLayer, #videoLayer * {
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
      ` : ''}
    `;
  }

  (document.head || document.documentElement).appendChild(style);

  if (!isChatFrame && isSoopHost) {
    function isolateSoopPlayer() {
      // #videoLayer는 VOD(vod.sooplive.com) 플레이어 컨테이너 — 라이브
      // 페이지 구조와 달라, 없으면 이 함수가 못 찾고 return해 주변 UI가
      // 안 지워지고 재생 영역이 찌그러진다.
      const player = document.querySelector('#player_area') || document.querySelector('.player_wrap')
        || document.querySelector('#webplayer') || document.querySelector('#videoLayer');
      if (!player) return false;

      // VOD(#videoLayer)는 조상 형제를 강제 숨기는 아래 공격적 처리를
      // 건너뛴다 — 라이브 기준 로직이라 VOD 재생/컨트롤 초기화에 필요한
      // 걸 실수로 숨겨 화면이 까맣게 남을 수 있다(검증 중). 크기/배경은
      // 위 CSS 리셋만으로 이미 맞춰짐.
      if (player.id === 'videoLayer') return true;

      // setInterval로 계속 재실행되므로 이미 적용된 상태면 스타일 쓰기를
      // 건너뛴다 — SPA가 형제를 다시 보이게 하는 경우를 잡으려 폴링은
      // 유지하되, 매 틱 불필요한 강제 재계산만 없앤다.
      let el = player;
      while (el && el.parentElement && el !== document.body) {
        const parent = el.parentElement;
        Array.from(parent.children).forEach((sibling) => {
          if (sibling !== el && sibling.style.display !== 'none') {
            sibling.style.setProperty('display', 'none', 'important');
          }
        });
        if (parent.style.overflow !== 'hidden') {
          parent.style.setProperty('margin', '0', 'important');
          parent.style.setProperty('padding', '0', 'important');
          parent.style.setProperty('width', '100%', 'important');
          parent.style.setProperty('max-width', '100%', 'important');
          parent.style.setProperty('min-width', '0', 'important');
          parent.style.setProperty('height', '100%', 'important');
          parent.style.setProperty('overflow', 'hidden', 'important');
        }
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
            if (sibling.style.display === 'none') return;
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

  if (!isChatFrame && !isCheeseChatEmbed && (isChzzkHost || isSoopHost || isYoutubeVideoFrame)) {
    console.log('🚀 [ScreenMode Inject] 스크립트 주입됨');

    let activeScreenIntervals = [];
    let screenModeAppliedSuccess = false;

    function clearAllScreenIntervals() {
      activeScreenIntervals.forEach((id) => clearInterval(id));
      activeScreenIntervals = [];
    }

    document.addEventListener('click', (e) => {
      if (e.isTrusted) {
        window.top.postMessage({
          type: 'FRAME_CLICKED',
          url: window.location.href
        }, '*');
      }
    }, true);

    const CHEESE_FORWARD_KEYS = new Set(['z', 'Z', 'x', 'X', 'c', 'C', 'v', 'V', '`', '/', 'Escape', 'Esc']);
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

      window.top.postMessage({ type: 'CHEESE_FORWARD_SHORTCUT', key: e.key }, '*');
    }, true);

  if (isChzzkHost || isSoopHost) {
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
  }
  // ↑ 스크린모드 감시는 치지직/숲 전용이라 여기서 if(isChzzkHost||isSoopHost)를
  // 닫는다. 예전엔 이 닫는 중괄호가 파일 끝에 있어 아래 오디오그래프/
  // SET_CHANNEL_VOLUME 코드까지 이 안에 갇혀, 유튜브 프레임(둘 다 false)에서
  // 통째로 실행 안 되는 버그가 있었다 — 아래는 플랫폼 무관(video, Web
  // Audio API)이라 모든 플랫폼에서 실행돼야 한다.

    // 우리가 직접 넣은 값임을 기억해둔다(SET_CHANNEL_VOLUME에서 채움) —
    // volume/muted를 바꾸면 아래 'volumechange' 리스너도 똑같이 발화하는데,
    // 이건 우리 값의 에코일 뿐 사용자 조작이 아니므로 구분해서 걸러야 한다.
    let lastAppliedVolumeFromParent = null;
    // 버그 수정: 대시보드가 최초로 볼륨을 지정하기 전(특히 유튜브는
    // 자동재생 음소거 협상 중) 유튜브 자체 로직이 video의 volume/muted를
    // 우리 명령 없이 건드릴 수 있다. 이때 lastAppliedVolumeFromParent가
    // 아직 null이라 에코로 안 걸러지고 '사용자 조작'으로 오인 보고돼,
    // 채널 추가 직후 오디오 패널에 저절로 수동 고정값(흔히 0%)이 걸리는
    // 원인이었다. 대시보드로부터 최소 한 번 진짜 값을 받기 전까지는 이
    // 구간의 volumechange를 통째로 무시한다.
    let hasReceivedVolumeFromParent = false;
    // 버그 수정: 최초 값 수신 후에도 한동안(정확한 트리거 미상, 버퍼링
    // 종료 추정) 유튜브가 계정에 저장된 자체 볼륨을 슬쩍 재적용하는
    // 사례가 있었다. INITIAL_TRUST_DELAY_MS 동안은 이것도 무시한다 —
    // docs/relay.html이 이 기간보다 길게 초기 재적용을 재시도하므로
    // (§INITIAL_UNMUTE_RETRY_ATTEMPTS) 어긋남은 알아서 바로잡히고,
    // content.js는 그동안만 사용자 조작으로 오인 보고하지 않으면 된다.
    const INITIAL_TRUST_DELAY_MS = 9000;
    let firstAppliedFromParentAt = null;
    function markAppliedFromParent(percent) {
      lastAppliedVolumeFromParent = percent;
      hasReceivedVolumeFromParent = true;
      if (firstAppliedFromParentAt === null) firstAppliedFromParentAt = Date.now();
    }
    function isWithinInitialTrustDelay() {
      return firstAppliedFromParentAt !== null
        && (Date.now() - firstAppliedFromParentAt) < INITIAL_TRUST_DELAY_MS;
    }
    // 대시보드가 마지막으로 지정한 목표 볼륨(%) — SPA로 video가 새로
    // 생겼을 때(§attachVolumeChangeWatcher) 곧바로 재적용하려고 기억해둔다.
    // 새 엘리먼트가 항상 이 값으로 시작한다고 가정해야, 그 초기
    // volumechange만 신뢰 구간에서 걸러지고 이후부터 정상적으로 사용자
    // 조작 판정을 받는다.
    let lastKnownTargetPercent = 100;
    // USER_VOLUME_CHANGE 보고가 새 volumechange로 덮어써졌는지 판단하는
    // 세대 번호 — §USER_VOLUME_REPORT_CONFIRM_MS 참고.
    let pendingUserVolumeReportToken = 0;
    // 버그 수정("메인-서브에서 자꾸 자동→수동으로 바뀐다"): 메인↔서브 전환/
    // 레이아웃 전환은 <video> 엘리먼트를 새로 만들지 않고 같은 엘리먼트의
    // 렌더링 크기만(작은 서브 썸네일 ↔ 큰 메인) 바꾼다 — 그래서
    // attachVolumeChangeWatcher의 "새 엘리먼트" 신뢰 리셋(§후속 수정 4/8)이
    // 아예 발동하지 않는다. 그런데 치지직/숲 플레이어가 이 크기 변화에
    // 반응해(화질 재협상 등으로 추정) video.volume/muted를 순간적으로 건드리는
    // 경우가 있고, 이미 한참 지난 채널이라 §hasReceivedVolumeFromParent/
    // §INITIAL_TRUST_DELAY_MS 어느 쪽도 이걸 걸러주지 못해 800ms 뒤 그대로
    // '사용자 조작'으로 보고돼 수동 고정값이 걸렸다. dashboard.js가 메인/
    // 레이아웃 전환 시점에 SUPPRESS_VOLUME_ECHO를 보내면, 그 직후 짧은 구간
    // 동안만 volumechange 보고를 추가로 억제한다(대시보드가 의도한 목표
    // 재적용은 SET_CHANNEL_VOLUME 경로로 평소처럼 계속 일어나므로 실제 볼륨
    // 반영에는 영향이 없다).
    let volumeReportSuppressedUntil = 0;

    // ── 채널별 오디오 레벨(dBFS) 측정 + video.volume 기반 볼륨 제어 ────────
    // 레벨 측정은 AnalyserNode/AudioWorklet으로 실제 오디오를 봐야 하는데,
    // Web Audio API는 MediaElementAudioSourceNode로 video 출력 경로를
    // 가로채는 방식만 지원한다(순수 '도청'은 없음). AudioContext가 진짜
    // running이 되기 전엔 연결하지 않는다 — resume()이 자동재생 정책에
    // 막혀 suspended로 남으면 연결하는 순간 소리가 끊긴다.
    //
    // 그래프를 연결해도 video.volume/muted는 여전히 실제 소리에 영향을
    // 준다(그래프 진입 전 별도 감쇠 단계 — 크롬에서 실측 확인). 그래서
    // 그래프의 GainNode는 항상 1로 고정하고 video.volume 하나만 실제
    // 음량 조절점으로 둔다 — 조절점이 둘이면 플레이어 슬라이더 조작이
    // 씹히거나 이중 감쇠/진동이 생겼던 과거 버그가 재발한다.
    //
    // 그래프는 '오디오 최적화' 체크박스가 꺼져 있어도 만들어질 수 있다
    // (needsGraphPending, dashboard.js §postVolumeMessage의 needsGraph)
    // — 측정/컴프레서 용도일 뿐 볼륨 소유권과는 무관하다.
    let needsGraphPending = false;
    // 실험실 > 오디오 최적화 > "다이나믹 컴프레서" 서브 토글의 최신 상태.
    // SET_CHANNEL_VOLUME마다 대시보드가 실어 보낸다(dashboard.js §5.5).
    let compressorEnabledPending = false;
    // docs/collab-architecture.md §13 — 합방 음소거 여부. video.volume은
    // 이걸로 더 이상 0이 되지 않는다(대시보드가 항상 진짜 목표를 보냄)
    // — 그래프 active면 gainNode를, 아니면(§13.5 폴백) video.muted를
    // 대신 맞춘다. SET_CHANNEL_VOLUME마다 갱신.
    let collabMutedPending = false;
    const pendingAudioContexts = new Set();

    // smooth=true로 볼륨을 바꿀 때 걸리는 시간. dB 자동 보정·합방 겹침
    // 태그 등 자동으로 수시로 바뀌는 상황이 많아서, 짧으면(예: 500ms)
    // 여전히 소리가 훅훅 튀는 느낌이 난다.
    const SMOOTH_RAMP_MS = 1200;

    // 버그 수정(유튜브 광고 의심): 채널 추가 초기뿐 아니라 정상 재생
    // 중에도 우리가 안 시킨 volumechange가 관찰된다 — 광고 시작/종료 등
    // 내부 전환이 순간 volume/muted를 건드렸다 되돌리는 것으로 추정.
    // 즉시 보고하면 그 순간값이 수동 고정값으로 저장되므로, 값이 바뀐
    // 뒤 이 시간 동안 유지되는지 확인 후에만 보고한다 — 진짜 사용자
    // 조작은 유지되어 보고되고, 스쳐가는 내부 전환은 이 시간 안에
    // 원복돼 걸러진다.
    const USER_VOLUME_REPORT_CONFIRM_MS = 800;

    // ── 레벨 측정 오케스트레이션(피크 추적 + 어택/릴리즈 스무딩) ─────────
    // 측정 원본(레거시 AnalyserNode RMS dBFS든 워클릿 K-weighted LUFS든)과
    // 무관하게 이 오케스트레이션은 그대로 재사용한다(docs/audio-architecture.md
    // §5.4 '오케스트레이션은 재작성하지 않는다'). readInstantDb()의 단위만
    // dBFS→LUFS로 바뀔 뿐 로그 스케일 처리 로직은 동일하다.
    // readInstantVoiceDb는 옵션(§9, docs/collab-architecture.md) — 워클릿만
    // 음성대역(300~3400Hz)을 따로 뽑을 수 있고 레거시엔 없다(생략 시
    // voiceDb 필드가 안 실리며 dashboard.js는 db로 폴백).
    // 보고 간격 — 디버그 dB 파형이 촘촘하도록 500ms에서 줄였다.
    // dashboard.js의 DEBUG_DB_HISTORY_MAX_SAMPLES/DEBUG_PANEL_REFRESH_MS도
    // 함께 맞춰야 표시 범위/갱신 주기가 안 어긋난다.
    const LEVEL_REPORT_INTERVAL_MS = 200;

    function startLevelSamplingLoop(graph, readInstantDb, readInstantVoiceDb) {
      let smoothedDb = null;
      let smoothedVoiceDb = null;
      // 보고 간격마다 스냅샷 한 번만 읽으면 그사이 순간적으로 커지는
      // 구간을 놓칠 수 있다. 실제 측정은 50ms마다 해서 구간 최댓값을
      // 추적하고, 보고는 LEVEL_REPORT_INTERVAL_MS 간격으로 유지해 메시지
      // 폭주를 막는다.
      let peakSinceReport = -100;
      let peakVoiceSinceReport = -100;

      graph.peakSampleInterval = setInterval(() => {
        const instantDb = readInstantDb();
        if (instantDb > peakSinceReport) peakSinceReport = instantDb;
        if (readInstantVoiceDb) {
          const instantVoiceDb = readInstantVoiceDb();
          if (instantVoiceDb > peakVoiceSinceReport) peakVoiceSinceReport = instantVoiceDb;
        }
      }, 50);

      graph.sampleInterval = setInterval(() => {
        const peakDb = peakSinceReport;
        peakSinceReport = -100;
        // 컴프레서의 어택/릴리즈와 같은 방식 — 커질 땐 빠르게 따라가
        // (어택) 스파이크를 바로 반영하고, 조용해질 땐 천천히 내려와
        // (릴리즈) 볼륨이 들쭉날쭉해지는 걸 막는다.
        if (smoothedDb === null) {
          smoothedDb = peakDb;
        } else if (peakDb > smoothedDb) {
          smoothedDb = smoothedDb * 0.4 + peakDb * 0.6;
        } else {
          smoothedDb = smoothedDb * 0.85 + peakDb * 0.15;
        }

        const message = { type: 'CHANNEL_AUDIO_LEVEL', db: smoothedDb };

        if (readInstantVoiceDb) {
          const peakVoiceDb = peakVoiceSinceReport;
          peakVoiceSinceReport = -100;
          if (smoothedVoiceDb === null) {
            smoothedVoiceDb = peakVoiceDb;
          } else if (peakVoiceDb > smoothedVoiceDb) {
            smoothedVoiceDb = smoothedVoiceDb * 0.4 + peakVoiceDb * 0.6;
          } else {
            smoothedVoiceDb = smoothedVoiceDb * 0.85 + peakVoiceDb * 0.15;
          }
          message.voiceDb = smoothedVoiceDb;
        }

        // window.top이 아닌 window.parent로 보낸다 — 유튜브는 relay.html을
        // 한 번 더 거쳐 embed가 한 단계 더 중첩된다(§dashboard.js
        // getVideoEmbedUrl). top으로 보내면 relay.html을 건너뛰어
        // event.source가 videoWrapperMap의 직계 iframe과 달라져 채널
        // 매칭이 영구 실패한다(치지직/숲은 중첩 없어 parent===top).
        // parent로 보내면 relay.html이 다시 릴레이해 event.source가
        // 항상 일치한다.
        window.parent.postMessage(message, '*');
      }, LEVEL_REPORT_INTERVAL_MS);
    }

    // 폴백 경로 — AudioWorklet을 못 쓰는 환경(미지원, CSP로 addModule
    // 차단 등)의 기존 RMS dBFS 측정(docs/audio-architecture.md §5.8).
    function startLegacyAudioLevelSampling(graph) {
      const analyser = graph.analyser;
      const buffer = new Float32Array(analyser.fftSize);
      const readInstantDb = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
        const rms = Math.sqrt(sumSquares / buffer.length);
        return rms > 0 ? 20 * Math.log10(rms) : -100;
      };
      startLevelSamplingLoop(graph, readInstantDb);
    }

    // 새 경로 — AudioWorkletProcessor(lufs-worklet-processor.js)가 오디오
    // 스레드에서 계산한 K-weighted momentary LUFS를 그대로 순간값으로
    // 쓴다. 워클릿은 50ms마다 보고하므로(worklet REPORT_INTERVAL_SEC)
    // 이 50ms 폴링이 매번 최신값을 읽는 셈.
    function startWorkletAudioLevelSampling(graph) {
      let latestLufs = -100;
      let latestVoiceDb = -100;
      graph.workletNode.port.onmessage = (event) => {
        const data = event.data;
        // 워클릿은 50ms마다 { lufs, voiceDb }를 보낸다(§9) — voiceDb는
        // 음성대역(300~3400Hz)만 남긴 dB로, 합방 겹침 감지가 배경음악/
        // 효과음에 덜 흔들리도록 leveling용 LUFS(lufs)와 별개로 쓴다.
        if (data && typeof data === 'object' && typeof data.lufs === 'number' && isFinite(data.lufs)) {
          latestLufs = data.lufs;
          if (typeof data.voiceDb === 'number' && isFinite(data.voiceDb)) latestVoiceDb = data.voiceDb;
        } else if (data && data.type === 'snippet') {
          // 합방 겹침 감지용 파형 스니펫 응답(§합방 겹침 감지 아래) — 워클릿
          // 결과를 그대로 부모(dashboard.js)에 올려보낸다. Float32Array는
          // 구조화 복제로 전달되므로 별도 인코딩이 필요 없다.
          window.parent.postMessage({
            type: 'CHANNEL_AUDIO_SNIPPET',
            requestId: data.requestId,
            samples: data.samples,
            sampleRate: data.sampleRate,
            filled: data.filled
          }, '*');
        }
      };
      startLevelSamplingLoop(graph, () => latestLufs, () => latestVoiceDb);
    }

    // ── 합방 겹침 감지 — 파형 캡처 제어/스니펫 요청 릴레이 ─────────────────
    // docs/collab-architecture.md §3 — dashboard.js는 워클릿에 직접 말을 걸
    // 수 없으므로(다른 iframe 안의 AudioWorkletNode), content.js가 중계한다.
    // 워클릿이 없는 채널(오디오 최적화 꺼짐, 레거시 폴백, 아직 연결 전)에서는
    // 아무것도 못 하므로, 스니펫 요청은 즉시 samples:null로 응답해 대시보드가
    // 타임아웃까지 기다리지 않게 한다.
    // 그래프/워클릿이 아직 준비 전(자동재생 정책으로 suspended 등)에
    // SET_CHANNEL_CAPTURE가 먼저 도착하면, 그 요청이 유실되지 않도록
    // 마지막 요청값을 기억해뒀다가 워클릿이
    // 붙는 시점(tryStartWorkletSampling)에 적용한다 — compressorEnabledPending과
    // 같은 패턴.
    let captureEnabledPending = false;
    // VOD 합방 싱크(§docs/vod-collab-sync-architecture.md)가 라이브 합방
    // 기본값(3초)보다 넓은 캡처 창을 요청할 때 쓰는 값 — undefined면 워클릿이
    // 자기 기본값(CAPTURE_WINDOW_SEC)을 쓴다.
    let captureWindowSecPending = undefined;

    function handleSetChannelCapture(enabled, windowSec, forceReset) {
      captureEnabledPending = !!enabled;
      captureWindowSecPending = windowSec;
      const video = document.querySelector('video');
      const graph = video && video.__cheeseAudioGraph;
      if (graph && graph.state === 'active' && graph.workletNode) {
        graph.workletNode.port.postMessage({ cmd: 'setCapture', enabled: captureEnabledPending, windowSec: captureWindowSecPending, forceReset: !!forceReset });
      }
    }

    function handleRequestAudioSnippet(requestId) {
      const video = document.querySelector('video');
      const graph = video && video.__cheeseAudioGraph;
      if (graph && graph.state === 'active' && graph.workletNode) {
        graph.workletNode.port.postMessage({ cmd: 'getSnippet', requestId });
      } else {
        // unavailable: 이 채널이 워클릿 경로(Stage 2)를 절대 못 쓴다는
        // 확정 신호(레거시 폴백으로 넘어갔거나 그래프 연결 실패) —
        // 대시보드가 받으면 Stage 1 단독으로 영구 폴백해도 된다고
        // 판단한다. graph.state==='pending'(연결 중)이면 곧 생길 수도
        // 있어 unavailable을 false로 둬 다음 주기에 재시도하게 한다
        // (docs/collab-architecture.md §6).
        const definitelyUnavailable = !graph || graph.state === 'unavailable'
          || (graph.state === 'active' && graph.measurementMode !== 'worklet');
        window.parent.postMessage({
          type: 'CHANNEL_AUDIO_SNIPPET',
          requestId,
          samples: null,
          unavailable: definitelyUnavailable
        }, '*');
      }
    }

    // ── 합방 겹침 감지 — 레이턴시(라이브 엣지까지 거리) 측정/보고 ────────────
    // docs/collab-latency-architecture.md §3. dashboard.js는 겹침 클러스터에
    // 대표 채널이 없을 때 '누구를 들려줄지' 정하는 타이브레이커로만
    // 쓴다(전역 비교 anchor로는 안 쓰임 — 전체 쌍 비교 구조). video만
    // 있으면 오디오 그래프 유무와 무관하게 측정 가능.
    function estimateLiveLatencySec(video) {
      if (!video || !video.seekable || video.seekable.length === 0) return null;
      const edge = video.seekable.end(video.seekable.length - 1);
      const behind = edge - video.currentTime;
      return behind >= 0 ? behind : null; // 음수면 측정 이상치 — 무시
    }

    const LIVE_LATENCY_REPORT_INTERVAL_MS = 1500;
    function reportLiveLatency() {
      const video = document.querySelector('video');
      const latencySec = estimateLiveLatencySec(video);
      if (latencySec === null) return;
      window.parent.postMessage({ type: 'CHANNEL_LIVE_LATENCY', latencySec }, '*');
    }
    // VOD는 "라이브 엣지까지 거리"라는 개념 자체가 없다 — seekable.end는
    // VOD 전체 길이 근처라 estimateLiveLatencySec이 남은 재생 시간(수백~
    // 수천 초)을 그대로 돌려준다. 예전엔 vod-sync 그룹이 Stage1/2(§
    // channelLatencySecByHash로 탐색 중심을 옮기는 getEstimatedLagMsForPair/
    // getEstimatedGccCenterLagSec)를 아예 건너뛰어서 이 오염된 값이 무해했지만,
    // 이제 vod-sync 쌍도 그 파이프라인을 그대로 타므로(§docs/vod-collab-sync-
    // architecture.md 2026-08-16 후속) 이 값이 들어가면 ±3초 탐색 중심이
    // 엉뚱한 곳으로 밀려 정렬을 영영 못 찾게 된다. 치지직/숲 VOD 프레임은
    // 아예 보고하지 않는다.
    if (!isChzzkVodFrame && !isSoopVodFrame) {
      setInterval(reportLiveLatency, LIVE_LATENCY_REPORT_INTERVAL_MS);
    }

    // ── 재생 위치 주기 보고 ──────────────────────────────────────────────
    // 유튜브: iframe이 새로고침/재추가로 다시 만들어지면 0초부터 시작된다.
    // dashboard.js가 채널별로 이 값을 기억해뒀다가 embed URL에 start=초로
    // 실어 보내 이어본다. 왕복 없이 몇 초마다 흘려보내기만 하면 되므로 간단하다.
    // 치지직 VOD: 이어보기 용도는 아니지만, 채팅 다시보기가 '지금 재생
    // 위치 기준 조회'에 같은 신호를 재사용한다(§dashboard.js loadChzzkVodChat).
    // 숲 VOD: VOD 합방 싱크 동기화의 드리프트 보정용
    // (§dashboard.js CHANNEL_PLAYBACK_TIME 핸들러, vod-sync 분기).
    // duration도 같이 보낸다 — vod-sync 그룹의 방송 시간이 서로 다를 때
    // (§docs/vod-collab-sync-architecture.md, 겹치지 않는 구간 처리)
    // 대시보드가 "이 멤버가 아직 시작 전/이미 끝난 구간"을 판단하는 데
    // 쓴다. 메타데이터 조회를 새로 추가하는 대신 실제 플레이어가 이미
    // 아는 값을 그대로 흘려보내는 쪽이 더 정확하다(치지직 17시간 분할
    // 등의 예외를 신경 쓸 필요가 없음). isFinite로 걸러야 하는 이유:
    // duration은 메타데이터 로드 전엔 NaN, 라이브 프레임에선 Infinity일
    // 수 있다(이 블록은 VOD 프레임에서만 도므로 보통은 정상 숫자).
    if (isYoutubeVideoFrame || isChzzkVodFrame || isSoopVodFrame) {
      const PLAYBACK_TIME_REPORT_INTERVAL_MS = 1000;
      function reportPlaybackTime() {
        const video = document.querySelector('video');
        if (!video || !isFinite(video.currentTime)) return;
        const duration = isFinite(video.duration) ? video.duration : null;
        window.parent.postMessage({ type: 'CHANNEL_PLAYBACK_TIME', currentTime: video.currentTime, paused: video.paused, duration }, '*');
      }
      // 2026-08-17 후속(사용자 지적: "정지는 대표가 먼저 멈추고 나머지가
      // 딜레이 있게 멈추는데 재생은 바로 됨" — 실제로는 재생/정지 둘 다
      // 최대 1초(폴링 주기) 지연이 똑같았는데, 정지 쪽만 그 1초 동안
      // 멤버가 계속 움직이고 소리도 나서 눈에 더 띄었을 뿐이었다). 재생/
      // 정지는 폴링을 기다리지 않고 video의 'play'/'pause' 이벤트가 나는
      // 즉시 바로 보고한다 — 위치(currentTime)는 그대로 1초 폴링에
      // 맡긴다(그 정도 지연은 드리프트 시크 임계값(§dashboard.js
      // VOD_SYNC_DRIFT_THRESHOLD_SEC=1.5초)보다 작아 체감상 문제없다).
      // SPA라 <video>가 통째로 새로 생길 수 있어(§attachVolumeChangeWatcher
      // 와 같은 이유) 리스너가 옛 엘리먼트에 남아 있으면 다시는 안 불릴 수
      // 있다 — 매 폴링 틱마다 지금 video가 리스너를 붙인 그 엘리먼트인지
      // 확인해 바뀌었으면 새로 붙인다(새 MutationObserver 없이 기존 폴링
      // 틱에 얹는 방식).
      let listenedVideo = null;
      function ensurePlayPauseListeners() {
        const video = document.querySelector('video');
        if (!video || video === listenedVideo) return;
        listenedVideo = video;
        video.addEventListener('play', reportPlaybackTime);
        video.addEventListener('pause', reportPlaybackTime);
      }
      ensurePlayPauseListeners();
      setInterval(() => {
        ensurePlayPauseListeners();
        reportPlaybackTime();
      }, PLAYBACK_TIME_REPORT_INTERVAL_MS);
    }

    // ── 다이나믹 컴프레서(옵션) ────────────────────────────────────────
    // 채널 내부 다이나믹레인지를 미리 다듬어 채널 간 dB(LUFS) 비교
    // (dashboard.js §3.4)를 안정시킨다. 토글마다 그래프를 재연결하면
    // 복잡해지므로 노드는 항상 넣어두고, 꺼져 있을 땐 threshold=0dB·
    // ratio=1(무압축)로 파라미터만 바꿔 우회시킨다(docs/audio-architecture.md
    // §5.5).
    const COMPRESSOR_ACTIVE_PARAMS = { threshold: -20, knee: 6, ratio: 3, attack: 0.01, release: 0.25 };
    const COMPRESSOR_NEUTRAL_PARAMS = { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 };

    // 자동 메이크업 게인(아래 makeupGainNode) 튜닝값 — 처음엔
    // compressorNode.reduction을 100% 그대로 빠르게(0.05초) 되돌렸는데,
    // 고음에서 '치지직'거리는 잡음이 생겼다. 원인은 컴프레서의 오디오
    // 스레드 엔벨로프(attack10ms/release250ms)와 50ms 폴링 기반 게인
    // 보정 사이 타이밍 불일치로, 빠른 트랜지언트(특히 고음)에서
    // 과보정돼 클리핑에 가까워진 것으로 추정. 그래서 70%만 보정(과보정
    // 여지 남김) + 반응 지연(0.05→0.15초) + 절대 상한(MAKEUP_GAIN_MAX_DB)으로
    // 완화했다. '메인이 서브보다 작게 들린다'는 원 문제는 대부분
    // 해소되고 잡음 위험도 낮다. 혹시 모를 과보정 대비 최종 출력 앞에
    // 안전 리미터를 하나 더 둔다(아래).
    const MAKEUP_GAIN_TIME_CONSTANT_SEC = 0.15;
    const MAKEUP_GAIN_COMPENSATION_RATIO = 0.7;
    const MAKEUP_GAIN_MAX_DB = 10;

    // 메이크업 게인 과보정으로 디지털 클리핑이 나지 않도록 경로 맨 끝에
    // 브릭월에 가까운 안전 리미터를 둔다. threshold -1dB로 약간의
    // 헤드룸을 남기고 매우 빠른 attack(1ms)으로 순간 피크까지 잡는다 —
    // 평소엔 거의 관여 안 하고(신호가 -1dBFS 밑이면 무압축) 과부하
    // 순간에만 걸리는 안전망.
    const SAFETY_LIMITER_PARAMS = { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

    function applyCompressorSetting(compressorNode, enabled) {
      const params = enabled ? COMPRESSOR_ACTIVE_PARAMS : COMPRESSOR_NEUTRAL_PARAMS;
      const ctx = compressorNode.context;
      compressorNode.threshold.setValueAtTime(params.threshold, ctx.currentTime);
      compressorNode.knee.setValueAtTime(params.knee, ctx.currentTime);
      compressorNode.ratio.setValueAtTime(params.ratio, ctx.currentTime);
      compressorNode.attack.setValueAtTime(params.attack, ctx.currentTime);
      compressorNode.release.setValueAtTime(params.release, ctx.currentTime);
    }

    // docs/collab-architecture.md §13 — 합방 음소거 전용 스위치. gainNode는
    // 이 함수로만 건드리며 항상 0 아니면 1만 가진다(목표 음량엔 관여
    // 안 함 — video.volume과 서로 다른 답을 내던 예전 이중 조절점
    // 버그와는 다른 쓰임).
    function applyCollabGain(graph, muted, smooth) {
      const gainNode = graph && graph.gainNode;
      if (!gainNode) return;
      const ctx = gainNode.context;
      const target = muted ? 0 : 1;
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime);
      if (!smooth) {
        gainNode.gain.setValueAtTime(target, ctx.currentTime);
        return;
      }
      // video.volume의 smooth 램프(SMOOTH_RAMP_MS)와 같은 길이로 맞춰
      // 체감을 통일한다 — 겹침이 감지되는 순간 뚝 끊기지 않고 자연스럽게
      // 사라지게.
      gainNode.gain.linearRampToValueAtTime(target, ctx.currentTime + SMOOTH_RAMP_MS / 1000);
    }

    // AudioWorklet 모듈을 로드해 측정 그래프를 연결한다. 성공하면 true,
    // 실패(미지원/CSP 차단/addModule 예외)하면 false를 돌려주고 아무
    // 노드도 남기지 않는다 — 호출 쪽에서 레거시 경로로 폴백해야 함을
    // 알 수 있게.
    async function tryStartWorkletSampling(ctx, tapSourceNode, graph) {
      if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') return false;
      try {
        const workletUrl = chrome.runtime.getURL('src/js/audio/lufs-worklet-processor.js');
        await ctx.audioWorklet.addModule(workletUrl);
        if (graph.state !== 'active') return false; // 그 사이 그래프가 정리됐으면 포기.

        const workletNode = new AudioWorkletNode(ctx, 'lufs-meter-processor');
        // 이 노드는 측정 전용이라 오디오 출력에 기여하면 안 된다. 다만
        // destination까지 연결되지 않으면 브라우저가 이 노드를 "pull"
        // 대상에서 제외해 process()가 안 불릴 수 있어(AnalyserNode와 달리
        // AudioWorkletNode는 자동 pull 대상이 아님), gain=0 무음 싱크를
        // 거쳐 destination에 연결해 항상 처리되도록 강제한다.
        const silentSink = ctx.createGain();
        silentSink.gain.value = 0;
        tapSourceNode.connect(workletNode);
        workletNode.connect(silentSink);
        silentSink.connect(ctx.destination);

        graph.workletNode = workletNode;
        graph.silentSink = silentSink;
        graph.measurementMode = 'worklet';
        startWorkletAudioLevelSampling(graph);
        // 워클릿이 준비되기 전에 이미 SET_CHANNEL_CAPTURE가 도착해 있었을
        // 수 있다 — 그 요청이 유실되지 않도록 지금 다시 적용한다(windowSec도
        // 같이).
        if (captureEnabledPending) {
          workletNode.port.postMessage({ cmd: 'setCapture', enabled: true, windowSec: captureWindowSecPending });
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    function ensureAudioGraph(video) {
      if (!video || video.__cheeseAudioGraph) return;
      const graph = { state: 'pending' };
      video.__cheeseAudioGraph = graph;

      let ctx;
      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        ctx = new AudioContextCtor();
      } catch (e) {
        graph.state = 'unavailable';
        return;
      }
      // 버그 수정: graph.ctx를 active가 됐을 때만 채우면, pending 상태로
      // 남아있는(아직 연결 전) 동안 <video>가 SPA로 교체되어 teardownAudioGraph가
      // 불려도 graph.ctx가 비어있어 이 AudioContext를 못 닫고 그대로 백그라운드에
      // 계속 살아있게 된다(리스너/오디오 리소스 누수). pending 상태에서도
      // 닫을 수 있도록 생성 직후 바로 채워둔다.
      graph.ctx = ctx;

      const tryConnect = () => {
        if (graph.state !== 'pending' || ctx.state !== 'running') return;
        try {
          const source = ctx.createMediaElementSource(video);
          const gainNode = ctx.createGain();
          const compressorNode = ctx.createDynamicsCompressor();
          const makeupGainNode = ctx.createGain();
          const limiterNode = ctx.createDynamicsCompressor();
          applyCompressorSetting(compressorNode, compressorEnabledPending);
          // GainNode는 실제 음량을 담당하지 않고 항상 1.0으로 고정된다 —
          // video.volume(setFallbackVolume)이 유일한 실제 볼륨 컨트롤이다
          // (조절점이 둘이면 안 됨). 예외: 합방 음소거 중에만 gainNode를
          // 0으로(docs/collab-architecture.md §13) — video.volume/muted는
          // 안 건드려 측정 탭(gainNode 앞)이 계속 진짜 신호를 보게 한다.
          // 그 외엔 항상 1로 고정된, 없는 셈 치는 노드다.
          gainNode.gain.value = collabMutedPending ? 0 : 1;
          makeupGainNode.gain.value = 1;
          limiterNode.threshold.setValueAtTime(SAFETY_LIMITER_PARAMS.threshold, ctx.currentTime);
          limiterNode.knee.setValueAtTime(SAFETY_LIMITER_PARAMS.knee, ctx.currentTime);
          limiterNode.ratio.setValueAtTime(SAFETY_LIMITER_PARAMS.ratio, ctx.currentTime);
          limiterNode.attack.setValueAtTime(SAFETY_LIMITER_PARAMS.attack, ctx.currentTime);
          limiterNode.release.setValueAtTime(SAFETY_LIMITER_PARAMS.release, ctx.currentTime);

          // source → compressor(다이나믹레인지 정리, 옵션) → makeupGain(컴프레서가
          // 누른 만큼 일부 되돌림) → [측정 탭] → gainNode(항상 1, 볼륨
          // 미담당) → limiter(안전망) → destination. 측정은 makeupGain
          // 이후·gain 이전 신호를 본다 — '방송 자체의 크기'를 재는 것이지
          // '우리가 얼마나 크게 틀지'가 아니기 때문(docs/audio-architecture.md
          // §5.5).
          source.connect(compressorNode);
          compressorNode.connect(makeupGainNode);
          makeupGainNode.connect(gainNode);
          gainNode.connect(limiterNode);
          limiterNode.connect(ctx.destination);

          // 컴프레서는 dB 비교(§3.4) 안정화용이지 전체 음량을 낮추려는
          // 게 아니다(docs/audio-architecture.md §5.5). 메이크업 게인
          // 없이 압축만 하면 threshold(-20dB)를 자주 넘는 채널(SFX·음악
          // 잦은 메인)일수록 계속 눌리기만 해, 같은 볼륨(%)이어도 조용한
          // 채널(서브)보다 작게 들리는 문제가 있었다('메인 100%가 서브
          // 25%보다 작게 들린다'). compressorNode.reduction을 50ms마다
          // 읽어 MAKEUP_GAIN_COMPENSATION_RATIO(70%)만큼만 되돌린다
          // (100% 되돌리면 타이밍 불일치로 고음 잡음 발생, §위 튜닝값
          // 참고). 절대 상한(MAKEUP_GAIN_MAX_DB)도 둬 게인이 한없이
          // 커지지 않게 막는다.
          graph.makeupGainInterval = setInterval(() => {
            const reductionDb = compressorNode.reduction || 0;
            const compensationDb = Math.min(MAKEUP_GAIN_MAX_DB, -reductionDb * MAKEUP_GAIN_COMPENSATION_RATIO);
            const target = Math.pow(10, compensationDb / 20);
            makeupGainNode.gain.setTargetAtTime(target, ctx.currentTime, MAKEUP_GAIN_TIME_CONSTANT_SEC);
          }, 50);

          // 이 시점 이후 statechange가 재진입해도 위 가드에서 걸러지도록,
          // 노드 연결이 끝나자마자(비동기 워클릿 로드 이전에) state를
          // 확정한다.
          graph.state = 'active';
          graph.gainNode = gainNode;
          graph.compressorNode = compressorNode;
          graph.makeupGainNode = makeupGainNode;
          graph.limiterNode = limiterNode;
          pendingAudioContexts.delete(ctx);
          // video.volume은 손대지 않는다 — SET_CHANNEL_VOLUME의
          // setFallbackVolume이 그래프 유무와 무관하게 항상 목표 퍼센트로 맞춘다.
          // docs/collab-architecture.md §13.5 — 그래프 pending이던 동안
          // 합방 음소거가 걸렸다면 §13.5 폴백으로 video.muted를 대신
          // 켜뒀을 수 있다. 이제 active가 됐으니 video.volume/muted를
          // '합방과 무관한 진짜 목표'(lastKnownTargetPercent) 기준으로
          // 재계산한다 — 무조건 muted=false로 풀면 사용자가 실제 0%로
          // 낮춘 채널까지 풀려버리므로, setFallbackVolume을 다시 불러
          // '합방 때문' 음소거만 걷고 '진짜 0%' 음소거는 유지되게 한다.
          // 유튜브 프레임은 §13.5 폴백을 안 걸었으므로(isYoutubeVideoFrame
          // 분기) 여기서도 건드리지 않는다 — relay.html이 공식 API로 전담.
          if (!isYoutubeVideoFrame) {
            setFallbackVolume(video, lastKnownTargetPercent, false, 0);
          }

          tryStartWorkletSampling(ctx, makeupGainNode, graph).then((workletOk) => {
            if (workletOk || graph.state !== 'active') return;
            // 워클릿 실패 — 레거시 AnalyserNode 경로로 폴백.
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            makeupGainNode.connect(analyser);
            graph.analyser = analyser;
            graph.measurementMode = 'legacy';
            startLegacyAudioLevelSampling(graph);
          });
        } catch (e) {
          // 이미 다른 곳에서 이 video에 createMediaElementSource가 호출된 적이
          // 있는 등 예외적인 상황 — 포기하고 video.volume 방식을 계속 쓴다.
          graph.state = 'unavailable';
          pendingAudioContexts.delete(ctx);
        }
      };

      ctx.resume().catch(() => {});
      tryConnect();
      if (graph.state === 'pending') {
        pendingAudioContexts.add(ctx);
        ctx.addEventListener('statechange', tryConnect);
      }
    }

    // 버그 수정: SPA가 <video>를 통째로 새로 만들면(재연결, 화질 전환 등)
    // 옛 엘리먼트의 측정 그래프(AudioContext + 측정 루프)가 정리 안 되고
    // 백그라운드에서 계속 돌아, 새 그래프와 함께 CHANNEL_AUDIO_LEVEL을
    // 이중 보고하며(dB 파형이 들쭉날쭉해짐) 사라진 옛 오디오가 실제
    // 소리와 섞여 측정치가 흔들렸다. 두 setInterval을 멈추고 AudioContext를
    // 닫아 완전히 정리한다.
    function teardownAudioGraph(video) {
      const graph = video && video.__cheeseAudioGraph;
      if (!graph) return;
      graph.state = 'unavailable';
      clearInterval(graph.peakSampleInterval);
      clearInterval(graph.sampleInterval);
      clearInterval(graph.makeupGainInterval);
      if (graph.ctx) {
        // graph.ctx는 이제 active가 되기 전(pending)에도 채워져 있으므로
        // (§ensureAudioGraph) 아직 연결되지 않은 그래프도 여기서 함께
        // 정리된다 — pendingAudioContexts에 남아있으면 나중에
        // retryPendingAudioContexts가 이미 닫힌 컨텍스트를 계속 resume()
        // 시도하게 되므로 먼저 뺀다.
        pendingAudioContexts.delete(graph.ctx);
        try { graph.ctx.close(); } catch (e) {}
      }
      video.__cheeseAudioGraph = null;
    }

    // 자동재생 정책 때문에 resume()이 막혀 있었다면, 이 프레임 안에서 첫
    // 사용자 제스처(클릭/키 입력)가 발생했을 때 다시 시도한다.
    function retryPendingAudioContexts() {
      pendingAudioContexts.forEach((ctx) => { ctx.resume().catch(() => {}); });
    }
    document.addEventListener('click', retryPendingAudioContexts, { capture: true, passive: true });
    document.addEventListener('keydown', retryPendingAudioContexts, { capture: true, passive: true });

    // 모드 전환처럼 여러 채널 목표 음량이 한꺼번에 바뀔 때, smooth
    // 플래그를 보내면 즉시 튀지 않고 지정 시간(기본 500ms) 동안
    // 자연스럽게 변한다.
    //
    // 볼륨은 항상 video.volume(setFallbackVolume) 하나로만 조절한다 —
    // GainNode 기반 100% 초과 증폭 경로는 제거됐다(플레이어와 멀티뷰가
    // 다른 조절점을 가지면 이중 감쇠/진동/표시 불일치가 생겼던 게 근본
    // 원인). video.volume은 0~1만 허용하므로 채널 음량 상한은 항상 100%다.

    function setFallbackVolume(video, targetPercent, smooth, durationMs) {
      // video.volume은 브라우저가 0~1 밖의 값을 넣으면 예외를 던지므로
      // (RangeError), GainNode 경로와 달리 여기서는 100%를 넘겨 받아도
      // 증폭이 불가능하다 — 1로 캡.
      const target = Math.min(1, Math.max(0, targetPercent / 100));
      if (!smooth) {
        if (video.__cheeseVolumeRampTimer) {
          clearInterval(video.__cheeseVolumeRampTimer);
          video.__cheeseVolumeRampTimer = null;
        }
        video.__cheeseRampInProgress = false;
        video.__cheeseRampTargetPercent = null;
        markAppliedFromParent(targetPercent);
        video.volume = target;
        video.muted = target <= 0;
        return;
      }
      // 방어적 무변화 가드: 이미 도달했거나 진행 중인 것과 같은 목표가
      // 다시 와도(§dashboard.js postVolumeMessage 중복 억제 캐시가 놓친
      // 경우 포함) 새 램프를 걸면 안 된다 — 새 램프마다 __cheeseRampInProgress
      // 창(최대 durationMs) 동안 진짜 volumechange가 무시되는데, 재전송이
      // ~500ms 간격이고 램프가 1200ms라 예전엔 이 잠금이 사실상 영구적이었다.
      const alreadyRampingToSameTarget = video.__cheeseRampInProgress
        && video.__cheeseRampTargetPercent === targetPercent;
      const alreadySettledAtTarget = !video.__cheeseRampInProgress
        && Math.round((video.muted ? 0 : video.volume) * 100) === targetPercent;
      if (alreadyRampingToSameTarget || alreadySettledAtTarget) {
        markAppliedFromParent(targetPercent);
        return;
      }
      if (video.__cheeseVolumeRampTimer) {
        clearInterval(video.__cheeseVolumeRampTimer);
        video.__cheeseVolumeRampTimer = null;
      }
      const startVolume = video.volume;
      const stepMs = 50;
      const steps = Math.max(1, Math.round(durationMs / stepMs));
      let step = 0;
      video.__cheeseRampInProgress = true;
      video.__cheeseRampTargetPercent = targetPercent;
      video.__cheeseVolumeRampTimer = setInterval(() => {
        step++;
        const t = Math.min(1, step / steps);
        video.volume = startVolume + (target - startVolume) * t;
        video.muted = video.volume <= 0;
        if (t >= 1) {
          clearInterval(video.__cheeseVolumeRampTimer);
          video.__cheeseVolumeRampTimer = null;
          // 마지막 스텝의 volumechange는 이 콜백이 끝난 뒤 비동기로 발화할 수
          // 있어 __cheeseRampInProgress를 여기서 바로 내리면 그 이벤트가
          // "사용자 조작"으로 오인될 수 있다 — 에코 판별용 값을 먼저
          // 남겨둔다.
          markAppliedFromParent(targetPercent);
          video.__cheeseRampInProgress = false;
          video.__cheeseRampTargetPercent = null;
        }
      }, stepMs);
    }

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
      } else if (type === 'CHEESE_EXPECT_VOLUME_ECHO') {
        // 유튜브 전용: relay.html이 영상을 처음 추가할 때 음소거 자동재생
        // 후, SET_CHANNEL_VOLUME이 아니라 유튜브 IFrame Player API
        // (unMute/setVolume)로 직접 음소거를 푼다(§docs/relay.html
        // unmuteAndPlay). 그러면 'volumechange'가 발화하지만 SET_CHANNEL_VOLUME을
        // 안 거쳐 lastAppliedVolumeFromParent가 비어있어 '사용자 조작'으로
        // 오인됐다(영상 추가마다 오디오 패널에 수동 고정값이 걸리는 원인).
        // relay.html이 이 신호로 미리 알려주면 정상적으로 에코 처리된다.
        markAppliedFromParent(Math.round(Number(event.data.volume) || 0));
      } else if (type === 'SUPPRESS_VOLUME_ECHO') {
        // §volumeReportSuppressedUntil 선언부 참고 — 메인/레이아웃 전환
        // 시점에 dashboard.js가 보낸다.
        const durationMs = Number(event.data.durationMs) || 2000;
        volumeReportSuppressedUntil = Date.now() + durationMs;
      } else if (type === 'SET_CHANNEL_VOLUME') {
        const video = document.querySelector('video');
        // video.volume이 유일한 실제 컨트롤이라 브라우저 제약으로 0~100%가
        // 물리적 상한이다(100% 초과 증폭 경로는 제거됨). 합방 음소거는 더
        // 이상 이 값을 0으로 접지 않는다(dashboard.js §postVolumeMessage) —
        // 항상 "합방과 무관한 진짜" 목표만 들어온다.
        const vol = Math.min(100, Math.max(0, Number(event.data.volume) || 0));
        const smooth = !!event.data.smooth;
        needsGraphPending = !!event.data.needsGraph;
        compressorEnabledPending = !!event.data.compressorEnabled;
        collabMutedPending = !!event.data.collabMuted;
        // SPA로 video 엘리먼트가 나중에 새로 생겼을 때(§attachVolumeChangeWatcher)
        // 곧바로 다시 적용해줄 수 있도록 마지막 목표값을 기억해둔다.
        lastKnownTargetPercent = vol;
        if (video) {
          const graph = video.__cheeseAudioGraph;
          // 유튜브 임베드 프레임은 예외: video가 유튜브 IFrame Player API가
          // 관리하는 별도 볼륨 상태(player.getVolume()/isMuted(), 화면
          // 슬라이더도 이 값)를 하나 더 갖고 video.volume과 독립적이다
          // (실측 확인: video.volume을 직접 바꿔도 player.getVolume()은
          // 그대로고, 이후 공식 API가 한 번이라도 불리면 video.volume이
          // 오래된 값으로 되돌아감). relay.html이 초기 자동재생 해제·
          // 엔딩화면 복귀 등에서 계속 공식 API를 호출해 그때마다 우리가
          // 적용한 video.volume이 되돌려졌다 — '멀티뷰 조절이 유튜브만
          // 안 먹는다'는 원인. 그래서 유튜브는 relay.html이 공식 API
          // (setVolume/unMute)로 volume/muted를 전담하고 여기선 건너뛴다
          // (조절점을 하나로 유지). 그 API 호출도 결국 이 프레임 video.volume을
          // 동기적으로 바꾸므로 아래 attachVolumeChangeWatcher의
          // volumechange 리스너는 그대로 동작한다(§CHEESE_EXPECT_VOLUME_ECHO로
          // 에코 판별). 치지직/숲은 이런 별도 상태가 없어 예외가 필요 없다.
          if (!isYoutubeVideoFrame) {
            // smooth=true 램프 시간. 500ms는 dB 자동 보정처럼 자주·크게
            // 바뀌는 상황에서 여전히 훅 튀어 SMOOTH_RAMP_MS로 늘렸다.
            // 그래프 유무와 무관하게 볼륨은 항상 video.volume이 담당하고,
            // GainNode는 합방 음소거 중에만 예외적으로 관여한다
            // (docs/collab-architecture.md §13).
            setFallbackVolume(video, vol, smooth, SMOOTH_RAMP_MS);
            // §13.5 폴백 — 그래프가 없거나(pending) 영구 불가(unavailable)면
            // gainNode로 못 죽이니 video.muted로 대신 죽인다. false로
            // 되돌릴 필요는 없다 — 위 setFallbackVolume이 매번 '진짜
            // 목표' 기준으로 muted를 이미 재계산했으므로 필요할 때만
            // true를 더 얹는다. 그래프 active면 손대지 않는다
            // (applyCollabGain이 전담).
            if (collabMutedPending && (!graph || graph.state !== 'active')) {
              video.muted = true;
            }
          }
          if (graph && graph.state === 'active') {
            if (graph.compressorNode) applyCompressorSetting(graph.compressorNode, compressorEnabledPending);
            applyCollabGain(graph, collabMutedPending, smooth);
          }
          if (needsGraphPending) ensureAudioGraph(video);
        }
      } else if (type === 'SET_CHANNEL_CAPTURE') {
        handleSetChannelCapture(event.data.enabled, event.data.windowSec, event.data.forceReset);
      } else if (type === 'REQUEST_AUDIO_SNIPPET') {
        handleRequestAudioSnippet(event.data.requestId);
      } else if (type === 'PAUSE') {
        // 화면 숨김(§dashboard.js toggleChannelVideoHidden) 시 대시보드가
        // 보낸다 — 유튜브는 relay.html이 공식 API로 처리하고, 치지직/숲은
        // 이 프레임이 곧 시청 페이지라 <video>를 직접 멈춘다. 안 보는
        // 화면을 계속 디코딩할 필요 없다.
        const video = document.querySelector('video');
        if (video) video.pause();
      } else if (type === 'PLAY') {
        const video = document.querySelector('video');
        if (video) video.play().catch(() => {});
      } else if (type === 'SEEK_TO_TIME') {
        // 치지직/숲 VOD 전용(§docs/vod-collab-sync-architecture.md §4.7) —
        // 이 프레임이 곧 시청 페이지라 <video>를 직접 시킹한다. 유튜브는
        // relay.html이 공식 IFrame Player API의 seekTo로 이미 처리하므로
        // (dashboard.js seekChannelToTime) 여기까지 도달하지 않는다.
        const video = document.querySelector('video');
        const seconds = Number(event.data.seconds);
        if (video && isFinite(seconds)) video.currentTime = Math.max(0, seconds);
      }
    });

    // ── 사용자가 플레이어를 직접 조작(음소거/볼륨 드래그)했을 때 대시보드에
    // 알려서, 그 채널의 오디오 설정으로 저장/반영할 수 있게 한다. ──────────
    // SPA가 <video>를 통째로 새로 만들었는지 판단하기 위해 마지막으로 본
    // 엘리먼트를 기억해둔다(§teardownAudioGraph).
    let lastWatchedVideo = null;
    function attachVolumeChangeWatcher() {
      const video = document.querySelector('video');
      if (!video) return;
      if (lastWatchedVideo && lastWatchedVideo !== video) {
        teardownAudioGraph(lastWatchedVideo);
      }
      lastWatchedVideo = video;
      // SPA라 video 엘리먼트가 새로 생길 수 있어 여기서도 재확인한다 —
      // 단, 그래프가 필요할 때만(디버그/합방/오디오 최적화 중 하나라도
      // — needsGraphPending, 플래그는 SET_CHANNEL_VOLUME으로 갱신됨) 새
      // 그래프를 만든다.
      if (needsGraphPending) ensureAudioGraph(video);
      // 그래프가 있든 없든 video.volume이 유일한 실제 컨트롤이고 GainNode는
      // 항상 1로 고정돼 있으므로, 여기서 video.volume/muted를 강제로
      // 되돌릴 일이 없다 — 플레이어 자체 슬라이더 조작이 곧 실제 음량
      // 변경이고, 아래 'volumechange' 리스너가 그대로 멀티뷰에 보고한다.
      if (video.__cheeseVolumeWatched) return;
      video.__cheeseVolumeWatched = true;
      // 버그 수정: SPA가 <video>를 통째로 새로 만들면(재연결, 화질 전환
      // — 치지직에 흔함) 새 엘리먼트는 사이트 기본값에서 시작한다. 그런데
      // lastAppliedVolumeFromParent 등 '신뢰 상태'는 엘리먼트별이 아니라
      // 클로저 전체에 걸려있어 예전 엘리먼트 기준으로 이미 신뢰 구간을
      // 지난 채 남아있었다 — 새 엘리먼트의 첫 volumechange가 '사용자
      // 조작'으로 오인돼 오디오 패널에 수동 고정값이 걸렸다('치지직도
      // 자꾸 수동으로 바뀐다'는 신고). 새 엘리먼트 감지 시 신뢰 상태를
      // 리셋하고 마지막 목표 볼륨을 곧바로 재적용한다(채널 추가 직후와
      // 동일 취급). 유튜브는 대상 아님(§isYoutubeVideoFrame — relay.html이
      // 공식 API로 전담).
      lastAppliedVolumeFromParent = null;
      hasReceivedVolumeFromParent = false;
      firstAppliedFromParentAt = null;
      if (!isYoutubeVideoFrame) {
        setFallbackVolume(video, lastKnownTargetPercent, false, 0);
      }
      video.addEventListener('volumechange', () => {
        // 그래프 활성 채널도 이 이벤트를 무시하지 않는다 — GainNode가
        // 볼륨을 안 갖게 되면서(video.volume이 항상 유일한 컨트롤) 예전
        // 에코 판별 실패/순환 문제의 전제가 사라졌다. 아래
        // lastAppliedVolumeFromParent 판별은 그래프 없는 채널에서 이미
        // 검증된 방식 그대로다.
        //
        // 버그 수정: SET_CHANNEL_VOLUME/CHEESE_EXPECT_VOLUME_ECHO를 한
        // 번도 못 받았으면 이 volumechange는 우리가 시킨 게 아니지만
        // '사용자 조작'도 아니다 — 유튜브가 채널 추가 직후 자체 로직으로
        // volume/muted를 건드리는 경우가 있어(§hasReceivedVolumeFromParent
        // 선언부 참고) 오인 보고를 막기 위해 통째로 무시한다. 첫 값 수신
        // 후 INITIAL_TRUST_DELAY_MS 동안도 마찬가지로 무시한다
        // (§INITIAL_TRUST_DELAY_MS 참고 — 그동안 relay.html이 계속 재시도 중).
        if (!hasReceivedVolumeFromParent || isWithinInitialTrustDelay()) return;
        // §volumeReportSuppressedUntil — 메인/레이아웃 전환 직후 짧은 구간.
        if (Date.now() < volumeReportSuppressedUntil) return;
        // smooth 전환 중에는 setInterval이 video.volume을 계속 바꾸며
        // volumechange를 매 스텝 발생시킨다 — 사용자가 직접 조작한 게
        // 아니므로 전환이 끝날 때까지는 전부 무시한다.
        if (video.__cheeseRampInProgress) return;
        const currentPercent = Math.round((video.muted ? 0 : video.volume) * 100);
        if (lastAppliedVolumeFromParent !== null && currentPercent === lastAppliedVolumeFromParent) {
          // 우리가 방금 넣은 값의 에코 — 무시한다. volume/muted가 같은
          // 호출에서 둘 다 바뀌면(예: 음소거 해제 시) volumechange가
          // 속성마다 한 번씩 두 번 올 수 있다 — 마커를 바로 지우면 두
          // 번째 이벤트를 '진짜 사용자 조작'으로 오인해 보고해버린다.
          // 이번 턴의 나머지 이벤트가 다 처리된 뒤에야 지운다.
          setTimeout(() => {
            if (lastAppliedVolumeFromParent === currentPercent) lastAppliedVolumeFromParent = null;
          }, 0);
          return;
        }
        lastAppliedVolumeFromParent = null;
        // 곧바로 보고하지 않는다 — §USER_VOLUME_REPORT_CONFIRM_MS 참고.
        // 이 시간 동안 값이 그대로 유지되는지 확인한 뒤에만 보고해서, 유튜브
        // 광고 전환 등으로 추정되는 스쳐 지나가는 내부 변화를 걸러낸다.
        const reportToken = ++pendingUserVolumeReportToken;
        setTimeout(() => {
          if (reportToken !== pendingUserVolumeReportToken) return; // 그 사이 또 바뀜 — 최신 것에 맡긴다
          if (video.__cheeseRampInProgress) return;
          if (Date.now() < volumeReportSuppressedUntil) return; // 대기 중 억제 구간에 들어옴
          const stillPercent = Math.round((video.muted ? 0 : video.volume) * 100);
          if (stillPercent !== currentPercent) return; // 확인 시간 동안 값이 또 바뀜 — 아직 불안정
          window.parent.postMessage({ type: 'USER_VOLUME_CHANGE', volume: stillPercent }, '*');
        }, USER_VOLUME_REPORT_CONFIRM_MS);
      });
      // VOD 재생이 끝까지 도달하면 발화 — 대시보드가 그리드에서 자동으로
      // 뺀다. 라이브는 보통 발화 안 하므로(끊김/오프라인과 다름) 오프라인
      // 감지는 dashboard.js의 별도 주기 확인이 담당한다.
      video.addEventListener('ended', () => {
        window.parent.postMessage({ type: 'CHANNEL_VIDEO_ENDED' }, '*');
      });
    }
    attachVolumeChangeWatcher();
    // 치지직/숲 모두 SPA라 <video> 엘리먼트가 나중에 생기거나 교체될 수 있어
    // 주기적으로 재확인한다(이미 붙어있으면 __cheeseVolumeWatched로 스킵됨).
    setInterval(attachVolumeChangeWatcher, 1000);

    setTimeout(() => {
      if (!screenModeAppliedSuccess && !isAlreadyWideMode()) {
        console.log('⏰ [ScreenMode Init] 레이아웃 안정화 후 최초 시도');
        applyScreenModePersistent();
      }
    }, 3500);

  }
}