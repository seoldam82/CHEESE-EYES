// [CHEESE EYES] 시청 페이지에서 마우스 가운데 클릭으로 "멀티뷰에 추가"를
// 트리거하는 콘텐츠 스크립트. 우클릭 컨텍스트 메뉴는 치지직/숲/유튜브가
// contextmenu 기본 동작을 막고 자체 UI를 띄워 못 씀 — 가운데 클릭만 사용.
// all_frames 미설정(매니페스트 참고)이라 멀티뷰 그리드의 임베드 iframe에는
// 주입 안 되고 최상위 시청 탭에서만 동작한다.
// run_at=document_start인 이유: 무거운 SPA(치지직/숲/유튜브)가 document
// capture 단계에 자체 클릭 핸들러를 먼저 등록하고 stopPropagation을 부르는
// 경우가 있다. 같은 노드·같은 단계의 리스너는 등록 순서대로 실행되므로,
// 페이지 스크립트보다 먼저 등록해야 항상 우리가 이벤트를 먼저 보고 하위의
// stopPropagation에 영향받지 않는다.
(function () {
  function findVideoUnderPoint(x, y) {
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)];
    // 커스텀 컨트롤 오버레이가 <video>를 덮는 플레이어(치지직/숲 등)도 감지하도록
    // 클릭 지점의 엘리먼트 스택 전체에서 video 태그를 찾는다.
    return (stack || []).find((el) => el && el.tagName === 'VIDEO') || null;
  }

  // 홈/검색 결과 카드처럼 현재 URL이 채널이 아닐 수 있다 — 그럴 땐 video를
  // 감싸는 가장 가까운 <a href>가 실제 채널/시청 페이지를 가리킨다.
  // .href는 프로퍼티라 상대경로도 항상 절대 URL로 반환한다.
  function findNearestChannelLink(el) {
    let node = el;
    let depth = 0;
    while (node && depth < 12) {
      if (node.tagName === 'A' && node.href) return node;
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  // 유튜브 라이브를 videoId로 고정 저장하면, 방송 종료/재연결로 videoId가
  // 무효해졌을 때 새로고침해도 계속 재생 불가로 뜬다(dashboard.js의 자동
  // 갱신/삭제 로직이 채널 hash 기준이라 hash===videoId 고정 항목은 대상 밖).
  // 그래서 라이브면 videoId 대신 채널 URL을 넘겨 채널 추적으로 담는다.
  // VOD는 특정 영상 고정이 맞으므로 그대로 둔다.
  function isLikelyLiveVideo(video) {
    return !isFinite(video.duration);
  }

  // 홈/검색 카드의 호버 미리보기 클립도 <video>라 duration이 NaN/Infinity로
  // 나와 isLikelyLiveVideo가 우연히 true가 될 수 있다. 이때 findYoutubeChannelUrl()로
  // "페이지 채널"을 찾으면 검색 결과 페이지엔 그런 게 없어 document 전체에서
  // 엉뚱한 채널 링크를 잡아버린다 — 실제 시청 페이지(watch/live)에서만 승격한다.
  function isOnYoutubeWatchPage() {
    return location.pathname === '/watch' || /^\/live\//.test(location.pathname);
  }

  // 채널 홈/VOD 목록 카드는 호버해도 <video> 미리보기가 없는 경우가 많아
  // findVideoUnderPoint가 못 찾고 조용히 무시됐다 — 이때 클릭 지점 아래에서
  // 시청/VOD 링크로 보이는 <a href>를 대신 찾는다. 아무 <a>나 잡으면 무관한
  // 메뉴/설정 링크에도 반응하므로 시청 페이지 URL 모양인지 미리 거른다
  // (최종 판단은 background.js의 parsePageUrlToChannelRef).
  function looksLikeWatchLink(href) {
    if (!href) return false;
    return /chzzk\.naver\.com\/(live|video)\//.test(href)
      || /(?:^|\/\/)(?:www\.)?youtube\.com\/(watch\?|channel\/|@|live\/)/.test(href)
      || /play\.sooplive\.com\//.test(href);
  }

  function findNearestWatchLink(x, y) {
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)];
    for (const startEl of (stack || [])) {
      let node = startEl;
      let depth = 0;
      while (node && depth < 12) {
        if (node.tagName === 'A' && looksLikeWatchLink(node.href)) return node;
        node = node.parentElement;
        depth++;
      }
    }
    return null;
  }

  function findYoutubeChannelUrl() {
    const metaLink = document.querySelector('link[itemprop="channelId"]');
    const metaId = metaLink && metaLink.getAttribute('content');
    if (metaId && /^UC[a-zA-Z0-9_-]{22}$/.test(metaId)) {
      return `https://www.youtube.com/channel/${metaId}`;
    }
    // 최신 유튜브 채널 링크는 대부분 /channel/UC가 아닌 /@handle 형식이라
    // 그것만 찾으면 실패해 라이브가 매번 videoId 고정으로만 담겼다. 다만
    // 페이지 아무 /@handle이나 잡으면 위험하다(추천 영상 목록에도 다른
    // 채널 링크가 많음) — 소유자 영역(ytd-video-owner-renderer/#owner)으로
    // 좁혀서만 찾고, 못 찾으면 null(엉뚱한 채널보다 원본 영상 폴백이 낫다).
    const owner = document.querySelector('ytd-video-owner-renderer, #owner');
    const ownerLink = owner && owner.querySelector('a[href^="/channel/UC"], a[href^="/@"]');
    if (!ownerLink) return null;
    const href = ownerLink.getAttribute('href') || '';
    const channelMatch = href.match(/^\/channel\/(UC[a-zA-Z0-9_-]{22})/);
    if (channelMatch) return `https://www.youtube.com/channel/${channelMatch[1]}`;
    const handleMatch = href.match(/^(\/@[a-zA-Z0-9._-]{3,30})/);
    if (handleMatch) return `https://www.youtube.com${handleMatch[1]}`;
    return null;
  }

  // 검색/홈 피드 카드에서 클릭된 썸네일 <a> 자체는 진짜 제목을 안 담은
  // 경우가 흔하다(재생시간 등 장식 텍스트뿐) — 진짜 제목은 형제 노드
  // (id="video-title", 여러 렌더러 템플릿 공통)에 있다. 부모 방향만
  // 훑는 findNearestChannelLink류로는 형제를 못 찾으므로, 링크에서 위로
  // 올라가며 카드 컨테이너를 찾고 그 안에서 #video-title을 다시 찾는다.
  // (aria-label 우선 폴백은 재생시간 배지 등 엉뚱한 텍스트가 먼저 걸려서
  // 폐기 — #video-title이 나타날 상위 레벨까지 계속 올라간다.)
  function findCardTitle(linkEl) {
    let container = linkEl;
    for (let i = 0; i < 6 && container; i++) {
      const titleEl = container.querySelector && container.querySelector('#video-title');
      if (titleEl) {
        // aria-label은 재생시간·조회수 등 부가정보가 제목 뒤에 붙어있는
        // 경우가 많아, 더 깨끗한 title/textContent를 우선하고 aria-label은
        // 마지막 폴백으로만 쓴다.
        const text = (titleEl.getAttribute('title') || titleEl.textContent || titleEl.getAttribute('aria-label') || '').trim();
        if (text) return text;
      }
      container = container.parentElement;
    }
    return '';
  }

  // 채널 홈 링크 이름을 읽던 이전 방식(findVodChannelName)은 "스튜디오"
  // 등 무관한 링크를 잘못 집어 폐기 — document.title이 더 안정적이다
  // (치지직/숲/유튜브 모두 페이지 제목에 스트리머명+방송/영상 제목 포함).
  // 단, 이는 "이 페이지 자체가 그 영상"일 때만 맞으므로 검색/홈 피드처럼
  // 여러 영상이 나열된 경우엔 카드별 제목(findCardTitle)을 먼저 쓰고
  // 없을 때만 페이지 제목으로 넘어간다.
  // 유튜브 쇼츠는 SPA 오버레이라 document.title이 쇼츠마다 갱신 안 되고
  // "YouTube" 같은 일반값에 고정된 경우가 흔하다 — 이런 값이면 버리고
  // 더 구체적인 후보(영상 title/aria-label 등)로 넘어간다.
  const GENERIC_PAGE_TITLES = new Set(['YouTube', 'YouTube Shorts', 'Shorts - YouTube']);
  function guessTitle(video, linkEl) {
    const cardTitle = linkEl ? findCardTitle(linkEl) : '';
    if (cardTitle) return cardTitle;
    const pageTitle = (document.title || '').trim();
    if (pageTitle && !GENERIC_PAGE_TITLES.has(pageTitle)) return pageTitle;
    const candidates = [
      video && video.title,
      video && video.getAttribute && video.getAttribute('aria-label'),
      linkEl && linkEl.title,
      linkEl && linkEl.getAttribute && linkEl.getAttribute('aria-label'),
      linkEl && linkEl.textContent
    ];
    const found = candidates.find((v) => v && String(v).trim());
    if (found) return String(found).trim();
    return pageTitle;
  }

  // 트레이 목록 썸네일은 <video> 프레임을 캔버스로 캡처하지 않는다 — 홈/검색
  // 카드는 호버 미리보기 클립이 매번 처음부터 재생되므로, 클릭 시점의 프레임을
  // 그대로 찍으면 대부분 영상 맨 앞부분(암전/인트로)만 걸린다. 대신 플랫폼이
  // 이미 그려둔 정식 썸네일 이미지를 찾아 그 URL을 쓴다.

  // 카드(검색/홈 피드) 안에 있는 실제 썸네일 <img>를 찾는다. 작은 이미지는
  // 프로필/아바타 아이콘일 가능성이 커서 제외한다.
  function findCardThumbnailUrl(linkEl) {
    let container = linkEl;
    for (let i = 0; i < 6 && container; i++) {
      const imgs = container.querySelectorAll ? container.querySelectorAll('img') : [];
      for (const img of imgs) {
        const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
        if (w && w < 60) continue;
        const src = img.currentSrc || img.src
          || img.getAttribute('data-src') || img.getAttribute('data-thumb')
          || (img.getAttribute('srcset') || '').split(/[\s,]+/)[0];
        if (src && !src.startsWith('data:') && !src.startsWith('blob:')) return src;
      }
      container = container.parentElement;
    }
    return null;
  }

  // 카드가 아니라 시청 페이지 자체를 직접 찍었을 땐(예: 채널 라이브를 바로
  // 보는 중) og:image가 대개 그 방송/영상의 공식 썸네일을 가리킨다 —
  // 공유 미리보기용으로 대부분의 사이트가 넣어둔다. 단, 유튜브는 SPA
  // 네비게이션 중 이 태그가 기본 로고(yt_1200.png)로 남아있는 경우가 많아
  // (실측 확인) 유튜브에는 이 폴백을 쓰지 않는다 — findYoutubeThumbnailUrl 참고.
  function findPageThumbnailUrl() {
    const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    return (og && og.content) || null;
  }

  // 유튜브 카드의 썸네일 <img>는 지연 로딩이라 클릭 시점엔 src가 비어있는
  // 경우가 흔하다(실측 확인) — findCardThumbnailUrl이 못 찾거나 og:image가
  // 로고로 폴백되는 문제를 피하려고, 영상 ID만으로 유튜브의 표준 썸네일
  // CDN 경로를 직접 구성한다(지연 로딩/SPA 네비게이션 상태와 무관하게 항상 유효).
  const YT_VIDEO_ID_RE_LIST = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/
  ];
  function extractYoutubeVideoId(url) {
    if (!url) return null;
    for (const re of YT_VIDEO_ID_RE_LIST) {
      const m = re.exec(url);
      if (m) return m[1];
    }
    return null;
  }
  function findYoutubeThumbnailUrl(linkEl) {
    const id = extractYoutubeVideoId(location.href) || extractYoutubeVideoId(linkEl && linkEl.href);
    // mqdefault(320x180)는 트레이 썸네일 박스와 같은 16:9라 레터박스/크롭 없이
    // 꽉 채워진다. hqdefault(480x360, 4:3)는 레터박스가 섞여있어 크롭이 필요했다.
    return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
  }

  // 가운데 버튼 mousedown 시 크롬이 오토스크롤(팬) 모드를 시작한다 —
  // auxclick에서 preventDefault해도 이미 늦으므로 mousedown 시점에 미리 막는다.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    const video = findVideoUnderPoint(e.clientX, e.clientY);
    const watchLinkFallback = video ? null : findNearestWatchLink(e.clientX, e.clientY);
    if (!video && !watchLinkFallback) return;
    e.preventDefault();
  }, true);

  // 가운데 버튼 클릭은 브라우저가 일반 click 이벤트를 발생시키지 않고
  // auxclick으로 보낸다(링크 위에서는 새 탭으로 열리는 게 기본 동작).
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const video = findVideoUnderPoint(e.clientX, e.clientY);

    // video 미리보기가 없는 썸네일 카드(채널 홈/VOD탭 등)를 위한 폴백.
    const watchLinkFallback = video ? null : findNearestWatchLink(e.clientX, e.clientY);
    if (!video && !watchLinkFallback) return;

    // 사이트 자체의 클릭 핸들러(새 탭 열기/전체화면 토글 등)가 함께 발동하지
    // 않도록 막는다.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const linkEl = video ? findNearestChannelLink(video) : watchLinkFallback;
    const isYoutube = location.hostname.endsWith('youtube.com');
    const thumbnail = (isYoutube && findYoutubeThumbnailUrl(linkEl))
      || (linkEl && findCardThumbnailUrl(linkEl))
      || (!isYoutube && findPageThumbnailUrl())
      || null;
    let linkUrl = linkEl ? linkEl.href : null;
    const hintTitle = guessTitle(video, linkEl);

    if (video && location.hostname.endsWith('youtube.com') && isOnYoutubeWatchPage() && isLikelyLiveVideo(video)) {
      const channelUrl = findYoutubeChannelUrl();
      if (channelUrl) linkUrl = channelUrl;
    }

    try {
      chrome.runtime.sendMessage({ type: 'ADD_TO_MULTIVIEW', thumbnail, linkUrl, hintTitle });
    } catch (err) {}
  }, true);
})();
