const ALLOWED_HOSTS = [
  'chzzk.naver.com', 'api.chzzk.naver.com', 'comm-api.game.naver.com',
  'sooplive.com', 'sooplive.co.kr', 'afreecatv.com',
  'youtube.com', 'suggestqueries-clients6.youtube.com',
  'translate.googleapis.com',
  // 단일 인스턴스 잠금 서버(server/ 참고). 배포 후 실제 workers.dev 서브도메인으로 교체할 것.
  'cheese-eyes-lock.seoldam82.workers.dev'
];
function isAllowedUrl(url) {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/html/dashboard.html") });
});

// ── 유튜브 엔딩화면/추천영상 클릭이 새 탭으로 새는 것에 대한 최후 방어선 ──
// content.js/youtube_endscreen_guard.js가 window.open/링크클릭/anchor.click()을
// 다 감쌌지만, 그 무엇도 안 거치고 새 탭이 열리는 경로가 실측으로
// 확인됐다(유튜브 내부 구현이 계속 바뀌어 새 우회 경로가 또 생길 수
// 있음). 페이지 JS를 아무리 감싸도 놓칠 여지가 있으므로 브라우저의
// chrome.tabs.onCreated를 최후 방어선으로 쓴다 — 어떤 경로든 100%
// 감지된다. 대시보드 탭이 opener인 유튜브 URL 새 탭만 대상으로 좁혀
// 다른 정상 새 탭은 안 건드린다.
function extractYoutubeVideoIdFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let m = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(url);
  if (m) return m[1];
  m = /youtu\.be\/([a-zA-Z0-9_-]{11})/.exec(url);
  if (m) return m[1];
  m = /\/shorts\/([a-zA-Z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

function isYoutubeWatchHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'www.youtube.com' || h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com';
  } catch (e) {
    return false;
  }
}

async function interceptYoutubeSuggestionNewTab(tab) {
  if (!tab || tab.id == null || tab.openerTabId == null) return;

  let openerTab;
  try {
    openerTab = await chrome.tabs.get(tab.openerTabId);
  } catch (e) {
    return;
  }
  const dashboardUrl = chrome.runtime.getURL(DASHBOARD_PAGE_PATH);
  if (!openerTab || !openerTab.url || !openerTab.url.startsWith(dashboardUrl)) return;

  const tryHandle = async (url) => {
    if (!isYoutubeWatchHost(url)) return false;
    const videoId = extractYoutubeVideoIdFromUrl(url);
    if (!videoId) return false;
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
    chrome.runtime.sendMessage({ type: 'CHEESE_YT_NEWTAB_SUGGESTION', videoId }).catch(() => {});
    console.log('[CHEESE EYES] 유튜브 추천영상 새 탭 가로챔(chrome.tabs.onCreated) ->', videoId);
    return true;
  };

  if (await tryHandle(tab.pendingUrl || tab.url)) return;

  // 탭이 막 생성된 시점엔 url/pendingUrl이 아직 안 채워졌을 수 있다 —
  // 짧게(최대 3초) onUpdated로 기다렸다가 안 잡히면 포기하고 정상 로드되게
  // 둔다(더 늦게 개입하면 화면이 잠깐 보였다 닫히는 게 오히려 어색하다).
  await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 3000);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tab.id || settled) return;
      const url = changeInfo.url || changeInfo.pendingUrl;
      if (!url) return;
      tryHandle(url).then((handled) => {
        if (!handled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      });
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

chrome.tabs.onCreated.addListener((tab) => {
  interceptYoutubeSuggestionNewTab(tab).catch((err) => {
    console.warn('[CHEESE EYES] 유튜브 추천영상 새 탭 가로채기 실패:', err);
  });
});

// ── 사이드바 '멀티뷰에 추가' 트리거 ──────────────────────────────────────
// 시청 페이지에서 가운데 클릭(multiview_trigger.js)한 비디오를 담아두는
// 스테이징 트레이. 목록은 탭별이 아니라 전역(chrome.storage.session)
// 공유다 — 어느 탭에서 담고 눌러도 모든 탭의 트레이(multiview_sidebar.js)가
// 같은 목록을 본다. 대시보드 탭은 항상 1개만 유지(sendStagedToMultiview의
// 재사용 로직).
// UI는 chrome.sidePanel이 아니라 multiview_sidebar.js가 탭 페이지 안에
// 직접 그리는 오버레이다 — 네이티브 사이드패널은 (1) contextmenu를
// 가로채는 사이트가 많아 우클릭으로 못 열고 (2) 가운데클릭 같은 콘텐츠
// 스크립트 트리거는 Chrome이 인정하는 '사용자 제스처'가 아니라 자동으로
// 못 열어 포기했다.
const DASHBOARD_PAGE_PATH = 'src/html/dashboard.html';
const STAGED_STORAGE_KEY = 'staged_items';

// dashboard.js의 parseDirectInput()과 같은 규칙을 페이지 URL 기준으로
// 단순화한 버전 — 사용자가 입력한 임의 텍스트가 아니라 실제로 열려 있는
// 시청 페이지(또는 홈 화면 미리보기 카드가 가리키는 링크)의 URL만 다루면
// 되므로 훨씬 간단하다.
function parsePageUrlToChannelRef(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch (e) {
    return null;
  }
  const host = u.hostname;

  if (host === 'chzzk.naver.com') {
    const liveMatch = u.pathname.match(/^\/live\/([a-f0-9]{32})/i);
    if (liveMatch) return { platform: 'chzzk', id: liveMatch[1] };
    // VOD(다시보기)는 채널이 아니라 특정 영상 하나를 가리킨다 — 채널 hash와
    // 헷갈리지 않도록 isVod로 구분해서 넘긴다(dashboard.js가 라이브 채널
    // 조회 API를 잘못 호출하지 않게).
    const vodMatch = u.pathname.match(/^\/video\/(\d+)/);
    if (vodMatch) return { platform: 'chzzk', id: vodMatch[1], isVod: true };
    return null;
  }

  // 숲 VOD(vod.sooplive.com)는 임베드 자체가 안 되는 것으로 확인돼(제3자
  // iframe에서 재생을 아예 시작하지 않음 — 스트림 요청 자체가 안 나감)
  // 지원하지 않는다. 다음 버전에서 다시 검토.
  if (host === 'vod.sooplive.com' || host === 'vod.sooplive.co.kr') {
    return null;
  }

  if (host.endsWith('sooplive.com') || host.endsWith('sooplive.co.kr') || host.endsWith('afreecatv.com')) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts[0]) return null;
    const broadNo = /^\d+$/.test(parts[1] || '') ? parts[1] : undefined;
    return { platform: 'soop', id: parts[0], broadNo };
  }

  if (host === 'www.youtube.com' || host === 'youtube.com') {
    // 채널 URL(multiview_trigger.js가 라이브 감지 시 이 형태로 넘김)은
    // videoId가 아닌 채널 자체를 추적해야 방송 종료 시 videoId 자동
    // 갱신(refreshYoutubeVideoId)과 오프라인 자동 삭제가 적용된다. ?v=
    // 파라미터보다 먼저 검사(채널 URL엔 v=가 없음).
    const channelMatch = u.pathname.match(/^\/channel\/(UC[a-zA-Z0-9_-]{22})/);
    if (channelMatch) return { platform: 'youtube', id: channelMatch[1] };

    // 최신 유튜브 채널 URL은 대부분 /channel/UC...가 아닌 /@handle
    // 형식이다 — 못 알아보면 findYoutubeChannelUrl()이 넘긴 링크도
    // 여기서 버려진다(unsupported_page). dashboard.js가 이미 '@' 시작값을
    // 핸들로 다루므로(PlatformAdapters.youtube._resolveByHandleOrText)
    // 같은 규칙으로 '@' 접두사를 그대로 id로 넘긴다.
    const handleMatch = u.pathname.match(/^\/(@[a-zA-Z0-9._-]{3,30})/);
    if (handleMatch) return { platform: 'youtube', id: handleMatch[1] };

    const videoId = u.searchParams.get('v');
    if (videoId) return { platform: 'youtube', id: videoId };
    const liveMatch = u.pathname.match(/^\/live\/([a-zA-Z0-9_-]{11})/);
    return liveMatch ? { platform: 'youtube', id: liveMatch[1] } : null;
  }

  return null;
}

async function getStagedItems() {
  const data = await chrome.storage.session.get(STAGED_STORAGE_KEY);
  return data[STAGED_STORAGE_KEY] || [];
}

async function setStagedItems(items) {
  await chrome.storage.session.set({ [STAGED_STORAGE_KEY]: items });
}

// 목록이 전역 공유이므로 모든 탭의 트레이가 반응해야 한다. chrome.runtime.sendMessage()는
// background↔확장 페이지 간엔 도달하지만 콘텐츠 스크립트(multiview_sidebar.js)엔
// 도달을 보장 못 한다(실측: 사이드바가 새로고침 전까지 안 갱신됨). 콘텐츠
// 스크립트엔 chrome.tabs.sendMessage(tabId,...)만 확실히 닿으므로 열린
// 모든 탭에 targeted로 보낸다(콘텐츠 스크립트 없는 탭은 실패하고 무시됨).
async function notifyStagedUpdated() {
  chrome.runtime.sendMessage({ type: 'STAGED_UPDATED' }).catch(() => {});
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach((t) => {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'STAGED_UPDATED' }).catch(() => {});
    });
  } catch (e) {}
}

// 서로 다른 탭에서 거의 동시에 추가/삭제하면 get→push→set 사이에 다른
// 탭의 쓰기가 끼어들어 서로 덮어쓸 수 있다(고전적인 read-modify-write
// 경쟁). 이 큐로 모든 변경 작업을 하나씩 순서대로만 실행되게 직렬화한다.
let stagedWriteQueue = Promise.resolve();
function enqueueStagedWrite(fn) {
  const result = stagedWriteQueue.then(fn, fn);
  stagedWriteQueue = result.then(() => {}, () => {});
  return result;
}

async function addToMultiviewFromTab(tab, options) {
  const { thumbnail, linkUrl, hintTitle } = options || {};
  if (!tab || tab.id == null) return { ok: false, reason: 'no_tab' };
  // 페이지 자체가 시청 페이지가 아닐 수 있다(홈/검색 결과의 미리보기
  // 카드) — 그럴 땐 영상을 감싸는 링크의 href를 우선 시도하고, 실패하면
  // 현재 탭 URL로 폴백한다.
  const ref = (linkUrl && parsePageUrlToChannelRef(linkUrl))
    || (tab.url && parsePageUrlToChannelRef(tab.url));
  if (!ref) return { ok: false, reason: 'unsupported_page' };

  return enqueueStagedWrite(async () => {
    const items = await getStagedItems();
    const existing = items.find((it) => it.platform === ref.platform && it.id === ref.id);
    if (!existing) {
      items.push({
        platform: ref.platform,
        id: ref.id,
        broadNo: ref.broadNo,
        isVod: !!ref.isVod,
        title: hintTitle || tab.title || ref.id,
        thumbnail: thumbnail || null,
        addedAt: Date.now()
      });
      await setStagedItems(items);
    } else if (thumbnail) {
      // 이미 담겨있는 항목이면 방금 찾은 썸네일 URL로 갱신만 한다.
      existing.thumbnail = thumbnail;
      await setStagedItems(items);
    }
    notifyStagedUpdated();
    return { ok: true, duplicate: !!existing };
  });
}

async function removeStagedItem(index) {
  return enqueueStagedWrite(async () => {
    const items = await getStagedItems();
    if (index >= 0 && index < items.length) {
      items.splice(index, 1);
      await setStagedItems(items);
      notifyStagedUpdated();
    }
    return { ok: true, items };
  });
}

// 트레이가 항목마다 체크박스를 보여주고(§multiview_sidebar.js) 선택된
// 것만 골라 보낼 수 있게 platform+id로 만든 키를 쓴다 — 목록 순서가
// 바뀌어도(다른 탭에서 동시에 추가/삭제) 안정적으로 같은 항목을 가리킨다.
function stagedItemKey(it) { return `${it.platform}:${it.id}`; }

// 드래그 순서 변경(§multiview_sidebar.js reorderItems)은 전체 키 배열로
// 온다 — 인덱스가 아닌 키로 재구성해야 메시지 왕복 중 다른 탭의 추가/
// 삭제와 안 어긋난다. order에 없는 항목(그 사이 추가된 것 등)은 맨 뒤에
// 붙여 유실 방지.
async function reorderStaged(order) {
  return enqueueStagedWrite(async () => {
    if (!Array.isArray(order) || order.length === 0) return { ok: false };
    const items = await getStagedItems();
    const byKey = new Map(items.map((it) => [stagedItemKey(it), it]));
    const reordered = [];
    order.forEach((key) => {
      if (byKey.has(key)) {
        reordered.push(byKey.get(key));
        byKey.delete(key);
      }
    });
    byKey.forEach((it) => reordered.push(it));
    await setStagedItems(reordered);
    notifyStagedUpdated();
    return { ok: true };
  });
}

async function sendStagedToMultiview(selectedKeys) {
  return enqueueStagedWrite(async () => {
    const items = await getStagedItems();
    // selectedKeys가 없으면(구버전 트레이 스크립트 등) 예전처럼 전부
    // 대상으로 삼는다 — 있으면 그 키에 해당하는 항목만 보내고 나머지는
    // 트레이에 그대로 남긴다.
    const toSend = Array.isArray(selectedKeys)
      ? items.filter((it) => selectedKeys.includes(stagedItemKey(it)))
      : items;
    if (!toSend.length) return { ok: false, reason: 'empty' };

    const dashboardUrl = chrome.runtime.getURL(DASHBOARD_PAGE_PATH);
    const existingTabs = await chrome.tabs.query({ url: dashboardUrl + '*' });

    // 대시보드 탭이 없으면 storage에 먼저 남겨둬야 그 탭의 DOMContentLoaded가
    // 바로 읽는다. 이미 열려 있으면 방송 메시지로 즉시 처리시키고, storage는
    // 메시지를 놓쳤을 때(로드 중 등) 폴백으로 겸한다. 대시보드 탭은 항상
    // 최대 1개(있으면 재사용, 없으면 생성).
    await chrome.storage.session.set({ pending_multiview_add: toSend });

    if (existingTabs.length > 0) {
      const dashTab = existingTabs[0];
      await chrome.runtime.sendMessage({ type: 'MULTIVIEW_PENDING_ADD_READY' }).catch(() => {});
      await chrome.tabs.update(dashTab.id, { active: true });
      await chrome.windows.update(dashTab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: dashboardUrl });
    }

    const sentKeys = new Set(toSend.map(stagedItemKey));
    const remaining = items.filter((it) => !sentKeys.has(stagedItemKey(it)));
    await setStagedItems(remaining);
    notifyStagedUpdated();
    return { ok: true };
  });
}

// 트레이의 '대기열에 추가' 버튼 — 배달 방식(storage에 얹고 대시보드 탭
// 열기/포커스)은 sendStagedToMultiview와 같지만, 대기열은 dashboard.js의
// videoQueue(유튜브 전용, §processPendingQueueAdd)로 들어가야 해서 유튜브
// 항목만 골라 보낸다. 치지직/숲이나 체크 해제 항목은 트레이에 남겨
// '멀티뷰로 보내기'로 여전히 보낼 수 있게 한다.
async function sendStagedToQueue(selectedKeys) {
  return enqueueStagedWrite(async () => {
    const items = await getStagedItems();
    const eligiblePool = items.filter((it) => it.platform === 'youtube');
    const eligible = Array.isArray(selectedKeys)
      ? eligiblePool.filter((it) => selectedKeys.includes(stagedItemKey(it)))
      : eligiblePool;
    if (!eligible.length) return { ok: false, reason: 'no_youtube_items' };

    const dashboardUrl = chrome.runtime.getURL(DASHBOARD_PAGE_PATH);
    const existingTabs = await chrome.tabs.query({ url: dashboardUrl + '*' });

    await chrome.storage.session.set({ pending_queue_add: eligible });

    if (existingTabs.length > 0) {
      const dashTab = existingTabs[0];
      await chrome.runtime.sendMessage({ type: 'QUEUE_PENDING_ADD_READY' }).catch(() => {});
      await chrome.tabs.update(dashTab.id, { active: true });
      await chrome.windows.update(dashTab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: dashboardUrl });
    }

    const sentKeys = new Set(eligible.map(stagedItemKey));
    const remaining = items.filter((it) => !sentKeys.has(stagedItemKey(it)));
    await setStagedItems(remaining);
    notifyStagedUpdated();
    return { ok: true };
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'PROXY_FETCH') {
    const { url, init, requiresAuth } = message;
    if (!isAllowedUrl(url)) {
      sendResponse({ ok: false, status: 0, statusText: '허용되지 않은 도메인', body: '' });
      return false;
    }
    (async () => {
      try {
        const { hostname } = new URL(url);
        if (hostname === 'www.youtube.com' && url.includes('/youtubei/v1/')) {
          let finalInit = init || {};
          if (requiresAuth) {
            try {
              const authHeader = await buildYoutubeSapisidHashHeader();
              if (authHeader) {
                finalInit = { ...finalInit, headers: { ...(finalInit.headers || {}), ...authHeader } };
              }
            } catch (authErr) {
              console.warn('[CHEESE EYES] 유튜브 인증 헤더 생성 실패, 비로그인 상태로 요청 진행:', authErr);
            }
            // 로그인이 필요한 요청(구독 라이브 목록 등)은 검색 등과 공유하는
            // 익명 offscreen iframe이 아니라, 실제 유튜브 탭 컨텍스트에서 실행한다.
            // 실제 로그인 세션 쿠키를 그 익명 프록시 파티션에 흘려보내면
            // youtube.com/embed 탐색 자체가 로그인 보호/이상 탐지에 걸려 검색까지
            // 포함한 프록시 전체가 먹통이 되는 문제가 있었기 때문.
            const result = await sendToYoutubeTabProxy(url, finalInit);
            sendResponse(result);
            return;
          }
          const result = await sendToOffscreenYoutubeProxy(url, finalInit);
          sendResponse(result);
          return;
        }
        const res = await fetch(url, init || {});
        const body = await res.text();
        sendResponse({ ok: res.ok, status: res.status, statusText: res.statusText, body });
      } catch (err) {
        sendResponse({ ok: false, status: 0, statusText: String((err && err.message) || err), body: '' });
      }
    })();

    return true;
  }

  if (message.type === 'CHECK_LOGIN_COOKIE') {
    const { url, names } = message;
    (async () => {
      try {
        for (const name of names || []) {
          const cookie = await chrome.cookies.get({ url, name });
          if (cookie && cookie.value) {
            sendResponse({ ok: true, loggedIn: true, name });
            return;
          }
        }
        sendResponse({ ok: true, loggedIn: false });
      } catch (err) {
        console.error('[CHEESE EYES] CHECK_LOGIN_COOKIE 실패:', err);
        sendResponse({ ok: false, loggedIn: false, error: String((err && err.message) || err) });
      }
    })();

    return true;
  }

  if (message.type === 'GET_SOOP_SESSION_KEY') {
    (async () => {
      try {
        const cookie = await chrome.cookies.get({ url: 'https://www.sooplive.com/', name: 'sck_session_key' });
        sendResponse({ ok: true, value: cookie ? cookie.value : '' });
      } catch (err) {
        sendResponse({ ok: false, value: '' });
      }
    })();

    return true;
  }

  if (message.type === 'SOOP_LOGOUT') {
    (async () => {
      try {
        for (const name of SOOP_AUTH_COOKIE_NAMES) {
          try {
            const raw = await chrome.cookies.get({ url: 'https://www.sooplive.com/', name });
            if (raw) {
              const url = cookieHostUrl(raw.domain, raw.path);
              await chrome.cookies.remove({ url, name });
            }
          } catch (e) {}
          try {
            const part = await chrome.cookies.get({ url: 'https://www.sooplive.com/', name, partitionKey: soopPartitionKey });
            if (part) {
              const url = cookieHostUrl(part.domain, part.path);
              await chrome.cookies.remove({ url, name, partitionKey: soopPartitionKey });
            }
          } catch (e) {}
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  // ADD_TO_MULTIVIEW는 콘텐츠 스크립트(multiview_trigger.js)에서만 보내므로
  // sender.tab으로 발신 탭 정보를 얻는다. 나머지는 탭에 종속되지 않는
  // 전역 목록 작업이라 탭 정보가 필요 없다.
  if (message.type === 'ADD_TO_MULTIVIEW') {
    const tab = sender && sender.tab;
    if (!tab) { sendResponse({ ok: false, reason: 'no_tab' }); return false; }
    addToMultiviewFromTab(tab, message).then(sendResponse);
    return true;
  }

  if (message.type === 'GET_STAGED') {
    getStagedItems().then((items) => sendResponse({ ok: true, items }));
    return true;
  }

  if (message.type === 'REMOVE_STAGED_ITEM') {
    removeStagedItem(message.index).then(sendResponse);
    return true;
  }

  if (message.type === 'SEND_STAGED_TO_MULTIVIEW') {
    sendStagedToMultiview(message.keys).then(sendResponse);
    return true;
  }

  if (message.type === 'SEND_STAGED_TO_QUEUE') {
    sendStagedToQueue(message.keys).then(sendResponse);
    return true;
  }

  if (message.type === 'REORDER_STAGED') {
    reorderStaged(message.order).then(sendResponse);
    return true;
  }

  if (message.type === 'OPEN_LOGIN_POPUP') {
    const { url, width, height } = message;
    const popupWidth = width || 500;
    const popupHeight = height || 650;
    (async () => {
      try {
        let left;
        let top;
        try {
          const parentWindowId = sender && sender.tab ? sender.tab.windowId : (await chrome.windows.getCurrent()).id;
          const parentWin = await chrome.windows.get(parentWindowId);
          left = Math.round(parentWin.left + (parentWin.width - popupWidth) / 2);
          top = Math.round(parentWin.top + (parentWin.height - popupHeight) / 2);
        } catch (posErr) {
          left = undefined;
          top = undefined;
        }

        const win = await chrome.windows.create({
          url,
          type: 'popup',
          width: popupWidth,
          height: popupHeight,
          ...(left != null && top != null ? { left, top } : {}),
          focused: true
        });

        pinnedPopupWindows.set(win.id, {
          left: win.left != null ? win.left : left,
          top: win.top != null ? win.top : top
        });

        sendResponse({ ok: true, windowId: win.id });
      } catch (err) {
        console.error('[CHEESE EYES] OPEN_LOGIN_POPUP 실패:', err);
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();

    return true;
  }

  return false;
});

const pinnedPopupWindows = new Map();
chrome.windows.onBoundsChanged.addListener((win) => {
  const pinned = pinnedPopupWindows.get(win.id);
  if (!pinned || pinned.left == null || pinned.top == null) return;
  const driftedX = Math.abs(win.left - pinned.left) > 2;
  const driftedY = Math.abs(win.top - pinned.top) > 2;
  if (!driftedX && !driftedY) return;
  chrome.windows.update(win.id, { left: pinned.left, top: pinned.top }).catch(() => {});
});

chrome.windows.onRemoved.addListener((windowId) => {
  pinnedPopupWindows.delete(windowId);
  chrome.runtime.sendMessage({ type: 'LOGIN_POPUP_CLOSED', windowId }).catch(() => {});
});
const SOOP_AUTH_COOKIE_NAMES = ['AuthTicket', 'UserTicket', 'sck_session_key', 'RDB'];
const soopPartitionKey = { topLevelSite: `chrome-extension://${chrome.runtime.id}` };

function cookieHostUrl(domain, path) {
  const host = domain.startsWith('.') ? `www${domain}` : domain;
  return `https://${host}${path}`;
}

async function syncPartitionedCookies(baseUrl, names, partitionKey) {
  for (const name of names) {
    let cookie;
    try {
      cookie = await chrome.cookies.get({ url: baseUrl, name });
    } catch (err) {
      console.error(`[CHEESE EYES] ${name} 쿠키 조회 실패:`, err);
      continue;
    }
    if (!cookie) continue;
    if (cookie.partitionKey != null) continue;
    const url = cookieHostUrl(cookie.domain, cookie.path);
    try {
      await chrome.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: true,
        httpOnly: cookie.httpOnly,
        sameSite: 'no_restriction',
        expirationDate: cookie.expirationDate,
        partitionKey
      });
    } catch (err) {
      console.error(`[CHEESE EYES] ${cookie.name} 파티션 쿠키 동기화 실패:`, err);
    }
  }
}

async function syncSoopPartitionedCookies() {
  await syncPartitionedCookies('https://www.sooplive.com/', SOOP_AUTH_COOKIE_NAMES, soopPartitionKey);
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  const c = changeInfo.cookie;
  if (c.partitionKey != null) return;

  const isSoop = c.domain && c.domain.includes('sooplive.com') && SOOP_AUTH_COOKIE_NAMES.includes(c.name);
  if (!isSoop) return;

  if (changeInfo.removed) {
    (async () => {
      try {
        const url = cookieHostUrl(c.domain, c.path);
        await chrome.cookies.remove({ url, name: c.name, partitionKey: soopPartitionKey });
      } catch (err) {
        console.error(`[CHEESE EYES] ${c.name} 파티션 쿠키 삭제 실패:`, err);
      }
    })();
    return;
  }

  syncSoopPartitionedCookies();
});

chrome.runtime.onInstalled.addListener(syncSoopPartitionedCookies);
chrome.runtime.onStartup.addListener(syncSoopPartitionedCookies);
syncSoopPartitionedCookies();

const YOUTUBE_AUTH_COOKIE_NAMES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PAPISID', '__Secure-1PSID', '__Secure-1PSIDCC', '__Secure-1PSIDTS',
  '__Secure-3PAPISID', '__Secure-3PSID', '__Secure-3PSIDCC', '__Secure-3PSIDTS'
];
const youtubePartitionKey = { topLevelSite: `chrome-extension://${chrome.runtime.id}` };

// 2026-08 되돌림: 이 파티션에 로그인 세션 쿠키를 동기화해 offscreen 프록시로
// 구독 인증을 시도했으나, 로그인 쿠키를 실은 숨겨진 iframe의 youtube.com/embed
// 탐색이 유튜브 이상 탐지에 걸려 검색 포함 프록시 전체가 먹통이 되는 회귀가
// 있었다. 그래서 '이 파티션엔 로그인 쿠키를 절대 안 남긴다'로 되돌린다 —
// 팔로우 라이브 목록은 이 방식으론 지원 안 함.
async function clearYoutubePartitionedCookies() {
  for (const name of YOUTUBE_AUTH_COOKIE_NAMES) {
    try {
      const cookie = await chrome.cookies.get({ url: 'https://www.youtube.com/', name, partitionKey: youtubePartitionKey });
      if (cookie) {
        const url = cookieHostUrl(cookie.domain, cookie.path);
        await chrome.cookies.remove({ url, name, partitionKey: youtubePartitionKey });
      }
    } catch (err) {
      console.error(`[CHEESE EYES] ${name} 유튜브 파티션 쿠키 정리 실패:`, err);
    }
  }
}

chrome.runtime.onInstalled.addListener(clearYoutubePartitionedCookies);
chrome.runtime.onStartup.addListener(clearYoutubePartitionedCookies);
clearYoutubePartitionedCookies();

const OFFSCREEN_DOCUMENT_URL = 'src/html/offscreen.html';
let creatingOffscreenDocument = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_URL)]
  });
  if (existingContexts.length > 0) return;

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_URL,
    reasons: ['IFRAME_SCRIPTING'],
    justification: '유튜브 로그인 세션과 동일한 origin(https://www.youtube.com) 컨텍스트에서 InnerTube 요청을 실행하기 위함'
  });
  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function sendToOffscreenYoutubeProxy(url, init) {
  try {
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_YT_FETCH', url, init });
    if (!result) {
      return { ok: false, status: 0, statusText: 'offscreen 프록시 응답 없음', body: '' };
    }
    return result;
  } catch (err) {
    return { ok: false, status: 0, statusText: String((err && err.message) || err), body: '' };
  }
}

// 로그인 필요 InnerTube 요청(구독 라이브 목록 등)을 실제 유튜브 탭
// 컨텍스트에서 실행하는 프록시. 열려 있는 youtube.com 탭을 재사용하고
// (자연스러운 트래픽), 없으면 비활성 탭을 새로 연다. 이후엔 같은 탭을
// 재사용해 탭이 계속 열리고 닫히는 걸 방지한다.
let cachedYoutubeTabId = null;

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('youtube_tab_load_timeout'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);

    // 리스너 등록 전에 이미 로딩이 끝나 있었을 가능성 대비
    chrome.tabs.get(tabId).then((tab) => {
      if (settled) return;
      if (tab && tab.status === 'complete') {
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

async function getOrCreateYoutubeTab() {
  if (cachedYoutubeTabId != null) {
    try {
      const tab = await chrome.tabs.get(cachedYoutubeTabId);
      if (tab && tab.url && /(^|\.)youtube\.com$/.test(new URL(tab.url).hostname)) {
        return cachedYoutubeTabId;
      }
    } catch (e) {
      // 탭이 이미 닫혔거나 다른 곳으로 이동함
    }
    cachedYoutubeTabId = null;
  }

  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://youtube.com/*'] });
    const usable = tabs.find(t => t.id != null && t.status === 'complete');
    if (usable) {
      cachedYoutubeTabId = usable.id;
      return cachedYoutubeTabId;
    }
  } catch (err) {
    console.warn('[CHEESE EYES] 기존 유튜브 탭 조회 실패:', err);
  }

  const created = await chrome.tabs.create({ url: 'https://www.youtube.com/', active: false });
  await waitForTabComplete(created.id);
  cachedYoutubeTabId = created.id;
  return cachedYoutubeTabId;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === cachedYoutubeTabId) cachedYoutubeTabId = null;
});

async function sendToYoutubeTabProxy(url, init) {
  try {
    const tabId = await getOrCreateYoutubeTab();
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (fetchUrl, fetchInit) => {
        try {
          const res = await fetch(fetchUrl, { ...(fetchInit || {}), credentials: 'include' });
          const body = await res.text();
          return { ok: res.ok, status: res.status, statusText: res.statusText, body };
        } catch (err) {
          return { ok: false, status: 0, statusText: String((err && err.message) || err), body: '' };
        }
      },
      args: [url, init]
    });
    const result = injection && injection[0] && injection[0].result;
    if (!result) {
      return { ok: false, status: 0, statusText: '유튜브 탭 프록시 응답 없음', body: '' };
    }
    return result;
  } catch (err) {
    console.error('[CHEESE EYES] 유튜브 탭 프록시 실패:', err);
    return { ok: false, status: 0, statusText: String((err && err.message) || err), body: '' };
  }
}

async function sha1Hex(text) {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-1', encoded);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function buildYoutubeSapisidHashHeader() {
  let cookie = await chrome.cookies.get({ url: 'https://www.youtube.com/', name: 'SAPISID' });
  if (!cookie) {
    cookie = await chrome.cookies.get({ url: 'https://www.youtube.com/', name: '__Secure-3PAPISID' });
  }
  if (!cookie || !cookie.value) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const origin = 'https://www.youtube.com';
  const digest = await sha1Hex(`${timestamp} ${cookie.value} ${origin}`);

  return {
    Authorization: `SAPISIDHASH ${timestamp}_${digest}`,
    'X-Origin': origin
  };
}