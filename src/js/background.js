const ALLOWED_HOSTS = [
  'chzzk.naver.com', 'api.chzzk.naver.com', 'comm-api.game.naver.com',
  'sooplive.com', 'sooplive.co.kr', 'afreecatv.com',
  'youtube.com', 'suggestqueries-clients6.youtube.com'
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
          }
          // 확장 자신의 컨텍스트(chrome-extension://...)에서 직접 fetch하면 실제
          // Origin이 https://www.youtube.com과 달라 InnerTube 쪽에서 403으로 거부한다.
          // 예전에는 검색처럼 로그인 불필요한 엔드포인트는 통과했지만, 이제는 그런
          // 엔드포인트도 확장 origin에서의 직접 호출을 막기 시작했다(구독 피드 등
          // 로그인 전용 엔드포인트는 원래도 403이었음). 그래서 requiresAuth 여부와
          // 무관하게 /youtubei/v1/* 요청은 전부 실제 youtube.com origin(offscreen 문서 안의
          // 숨김 iframe)에서 그대로 요청을 실행해 이 문제를 해결한다.
          await syncYoutubePartitionedCookies();
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

// 유튜브도 SOOP과 동일한 문제를 겪는다: 크롬의 서드파티 쿠키 차단 때문에,
// offscreen 문서(최상위 사이트=chrome-extension://...) 안의 youtube.com
// iframe은 실제 Origin이 https://www.youtube.com로 맞더라도 사용자의 일반
// 로그인 쿠키(SID/APISID/SAPISID 등, SameSite=Lax/미지정)를 받지 못한다.
// 이 쿠키들을 우리 확장 파티션(CHIPS)에 그대로 복사해 두면, 그 iframe
// 안에서의 요청에는 정상적으로 실려 나간다. Origin/Referer를 조작하는 게
// 아니라, 사용자가 이미 가지고 있는 자신의 쿠키 값을 같은 브라우저 안의
// 다른 저장 파티션으로 복사하는 것뿐이라 SOOP 로직과 동일한 성격이다.
const YOUTUBE_AUTH_COOKIE_NAMES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PAPISID', '__Secure-1PSID', '__Secure-1PSIDCC', '__Secure-1PSIDTS',
  '__Secure-3PAPISID', '__Secure-3PSID', '__Secure-3PSIDCC', '__Secure-3PSIDTS'
];
const youtubePartitionKey = { topLevelSite: `chrome-extension://${chrome.runtime.id}` };

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

async function syncYoutubePartitionedCookies() {
  await syncPartitionedCookies('https://www.youtube.com/', YOUTUBE_AUTH_COOKIE_NAMES, youtubePartitionKey);
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  const c = changeInfo.cookie;
  if (c.partitionKey != null) return;

  const isSoop = c.domain && c.domain.includes('sooplive.com') && SOOP_AUTH_COOKIE_NAMES.includes(c.name);
  const isYoutube = c.domain && c.domain.includes('youtube.com') && YOUTUBE_AUTH_COOKIE_NAMES.includes(c.name);
  if (!isSoop && !isYoutube) return;

  const partitionKey = isSoop ? soopPartitionKey : youtubePartitionKey;

  if (changeInfo.removed) {
    (async () => {
      try {
        const url = cookieHostUrl(c.domain, c.path);
        await chrome.cookies.remove({ url, name: c.name, partitionKey });
      } catch (err) {
        console.error(`[CHEESE EYES] ${c.name} 파티션 쿠키 삭제 실패:`, err);
      }
    })();
    return;
  }

  if (isSoop) syncSoopPartitionedCookies();
  if (isYoutube) syncYoutubePartitionedCookies();
});

chrome.runtime.onInstalled.addListener(syncSoopPartitionedCookies);
chrome.runtime.onStartup.addListener(syncSoopPartitionedCookies);
syncSoopPartitionedCookies();

chrome.runtime.onInstalled.addListener(syncYoutubePartitionedCookies);
chrome.runtime.onStartup.addListener(syncYoutubePartitionedCookies);
syncYoutubePartitionedCookies();

// ── 유튜브 InnerTube 요청을 실제 youtube.com origin에서 실행하기 위한
//    offscreen 문서 관리 ─────────────────────────────────────────────
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
    justification: '유튜브 로그인 세션과 동일한 origin(https://www.youtube.com) 컨텍스트에서 InnerTube 인증 요청을 실행하기 위함'
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

// ── 유튜브 InnerTube 인증 (SAPISID Hash) ──────────────────────────────
// InnerTube의 로그인 전용 엔드포인트(구독 목록, 구독/구독취소 등)는
// SAPISIDHASH 인증 헤더가 없으면 비로그인 컨텍스트로 응답한다.
// SAPISID 쿠키 원본 값은 여기(background service worker) 밖으로 절대 내보내지 않고,
// 매 요청마다 해시된 Authorization 헤더만 생성해 PROXY_FETCH 응답에 실어 보낸다.
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