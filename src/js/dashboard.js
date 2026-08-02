let presets = [];
let mainChannel = null;
let activeChatChannel = null;
let currentLayout = 'grid';
let chatVisible = false;
let searchDebounceTimer = null;
let currentSearchKeyword = '';
let fetchedTagChannels = [];
let selectedTagChannels = [];
let channels = [];

const IFRAME_ALLOW = "autoplay *; fullscreen *; encrypted-media *; picture-in-picture *; local-network-access *; loopback-network *";

// ── 유튜브 영상/채팅 중계(오류153·embed_domain 우회용 실제 https 도메인) ──
// chrome-extension:// origin에서는 (1) 유튜브 임베드 플레이어가 Referer를
// 못 받아 오류 153(플레이어 구성 오류)이 나고, (2) live_chat은 embed_domain
// 검증을 통과하지 못해 ERR_BLOCKED_BY_RESPONSE로 막힌다. 우리가 소유한
// 실제 도메인(예: GitHub Pages)에 올려둔 중계 페이지 하나(relay.html,
// ?type=video|chat 파라미터로 분기)를 iframe으로 감싸는 방식으로 둘 다
// 우회한다. GitHub Pages 대역폭/캐시 효율을 위해 예전의 yt-video.html·
// yt-chat.html 두 파일을 relay.html 하나로 통합했다. 아래 값을 실제
// 배포된 GitHub Pages 주소로 바꿔야 동작한다.
// (예: 'https://seoldam82.github.io/CHEESE-EYES')
const YT_RELAY_ORIGIN = 'https://seoldam82.github.io/CHEESE-EYES';
let displayChannels = [];   
let isFirstZeroRemoved = false;
let channelAddOrder = [];

function getFirstChzzkHash() {
  for (const h of channelAddOrder) {
    const c = channels.find(ch => ch.hash === h);
    if (c && c.platform === 'chzzk') return h;
  }
  return null;
}

const chatReinitOverlays = new Map();
const reinitPendingHashes = new Set();
function getChatReinitOverlay(hash) {
  if (!chatContainer) return null;
  let el = chatReinitOverlays.get(hash);
  if (el && el.isConnected) return el;
  el = document.createElement('div');
  el.className = 'chat-reinit-overlay';
  el.setAttribute('data-hash', hash);
  el.innerHTML = '<div class="chat-reinit-spinner"></div><div class="chat-reinit-text">채팅 재연결 중...</div>';
  el.style.display = 'none';
  chatContainer.appendChild(el);
  chatReinitOverlays.set(hash, el);
  return el;
}
function updateChatReinitOverlayVisibility(hash) {
  const el = chatReinitOverlays.get(hash);
  if (!el) return;
  el.style.display = (reinitPendingHashes.has(hash) && hash === activeChatChannel) ? 'flex' : 'none';
}
function showChatReinitOverlay(hash) {
  if (!hash) return;
  reinitPendingHashes.add(hash);
  getChatReinitOverlay(hash);
  updateChatReinitOverlayVisibility(hash);
}
function hideChatReinitOverlay(hash) {
  if (!hash) return;
  reinitPendingHashes.delete(hash);
  updateChatReinitOverlayVisibility(hash);
}

const soopVideoReadyMap = new Map();
function getSoopVideoReadyEntry(hash) {
  if (!soopVideoReadyMap.has(hash)) {
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    soopVideoReadyMap.set(hash, { promise, resolve: resolveFn, done: false });
  }
  return soopVideoReadyMap.get(hash);
}
function markSoopVideoReady(hash) {
  const entry = soopVideoReadyMap.get(hash);
  if (entry && !entry.done) {
    entry.done = true;
    entry.resolve();
  }
}

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'SOOP_VIDEO_LOGIN_READY') return;
  if (event.data.channelId) markSoopVideoReady(event.data.channelId);
});

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'SOOP_CHAT_NEEDS_REINIT') return;
  const hash = event.data.channelId;
  if (!hash || !chatContainer) return;
  const iframe = chatContainer.querySelector(`iframe[data-hash="${hash}"]`);
  if (!iframe) return;
  console.warn(`[CHEESE EYES] SOOP 채팅 재초기화 요청 수신 (hash=${hash}), referrer를 살려 다시 로드합니다.`);
  soopVideoReadyMap.delete(hash);
  const wasVisible = chatVisible && hash === activeChatChannel;
  if (wasVisible) showChatReinitOverlay(hash);
  loadChatIframe(iframe, hash, 'soop').finally(() => { if (wasVisible) hideChatReinitOverlay(hash); });
});

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHEESE_FORWARD_SHORTCUT') return;
  const key = event.data.key;
  if (!key) return;
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});

let autocompleteRenderToken = 0;

function apiFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    try {
      const { requiresAuth, ...fetchInit } = init;
      chrome.runtime.sendMessage({ type: 'PROXY_FETCH', url, init: fetchInit, requiresAuth }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('background 프록시 응답이 없습니다.'));
          return;
        }
        resolve({
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          json: async () => JSON.parse(response.body || 'null'),
          text: async () => response.body || ''
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function frameApiFetch(hash, url, init = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const wrapper = typeof videoWrapperMap !== 'undefined' ? videoWrapperMap.get(hash) : null;
    const iframe = wrapper && wrapper.querySelector('iframe');
    if (!iframe || !iframe.contentWindow) {
      reject(new Error('frame_not_ready'));
      return;
    }

    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      reject(new Error('frame_proxy_timeout'));
    }, timeoutMs);

    function onMessage(event) {
      if (!event.data || event.data.type !== 'CHEESE_API_PROXY_RESULT' || event.data.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve({
        ok: event.data.ok,
        status: event.data.status,
        statusText: '',
        json: async () => JSON.parse(event.data.body || 'null'),
        text: async () => event.data.body || ''
      });
    }

    window.addEventListener('message', onMessage);
    iframe.contentWindow.postMessage({ type: 'CHEESE_API_PROXY', requestId, url, init }, '*');
  });
}

function checkLoginCookie(url, names) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'CHECK_LOGIN_COOKIE', url, names }, (response) => {
        if (chrome.runtime.lastError || !response) { resolve(false); return; }
        resolve(!!response.loggedIn);
      });
    } catch (e) { resolve(false); }
  });
}

function getSoopSessionKey() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_SOOP_SESSION_KEY' }, (res) => {
        if (chrome.runtime.lastError || !res) { resolve(''); return; }
        resolve(res.ok ? res.value : '');
      });
    } catch (e) { resolve(''); }
  });
}

window.cheeseDebugSoopCookies = function () {
  chrome.runtime.sendMessage({ type: 'DEBUG_SOOP_COOKIES' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      console.error('[CHEESE EYES] 쿠키 디버그 실패:', chrome.runtime.lastError || res);
      return;
    }
    console.log('[CHEESE EYES] 원본 쿠키 존재 여부:', res.raw);
    console.log('[CHEESE EYES] 파티션(CHIPS) 쿠키 존재 여부:', res.partitioned);
  });
};

const PLATFORM_META = {
  chzzk:   { label: '치지직', color: '#00ffa3', enabled: true },
  soop:    { label: '숲',     color: '#3385ff', enabled: true },
  youtube: { label: '유튜브', color: '#FF0000', enabled: true },
  twitch:  { label: '트위치', color: '#9146FF', enabled: false }
};

// 채널 카드(비디오 타일)의 배경색 전용 팔레트. 뱃지/탭/테두리 등에 쓰이는
// PLATFORM_META.color와는 분리해서 카드 배경에만 적용한다.
const CARD_BG_COLORS = {
  chzzk:   '#99fbc1',
  soop:    '#7ebcf9',
  youtube: '#e79390'
};

function getCardBgColor(platform) {
  return CARD_BG_COLORS[platform] || CARD_BG_COLORS.chzzk;
}

function getPlatformLabel(key) {
  const meta = PLATFORM_META[key];
  return t(`platform.${key}`, meta ? meta.label : key);
}

const UI_LANGUAGE_LABELS = { ko: '한국어', ja: '日本語', en: 'English' };
function getUiLanguageOptions() {
  const supported = (typeof window !== 'undefined' && window.CHEESE_EYES_SUPPORTED_LANGS) || ['ko', 'ja', 'en'];
  return supported.map(code => ({ value: code, label: UI_LANGUAGE_LABELS[code] || code }));
}

function getPlatformColor(platform) {
  return (PLATFORM_META[platform] && PLATFORM_META[platform].color) || PLATFORM_META.chzzk.color;
}

function hexToRgbString(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '0, 255, 163';
  const int = parseInt(m[1], 16);
  return `${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}`;
}

function getPlatformColorRGB(platform) {
  return hexToRgbString(getPlatformColor(platform));
}

const PlatformAdapters = {
  chzzk: {
    async searchAutocomplete(keyword, size = 10) {
      try {
        const res = await apiFetch(`https://api.chzzk.naver.com/service/v1/search/channels?keyword=${encodeURIComponent(keyword)}&offset=0&size=20&withFirstChannelContent=true`);
        if (!res.ok) return [];
        const data = await res.json();
        const list = data.content && data.content.data ? data.content.data : [];

        const checked = await Promise.all(list.map(async (entry) => {
          const c = entry.channel;
          if (!c || !c.channelId || !c.channelName) return null;
          const isLive = await checkChzzkLiveByChannelId(c.channelId);
          return isLive ? { platform: 'chzzk', text: c.channelName } : null;
        }));

        const seen = new Set();
        const items = [];
        for (const item of checked) {
          if (!item || seen.has(item.text)) continue;
          seen.add(item.text);
          items.push(item);
          if (items.length >= size) break;
        }
        return items;
      } catch (e) { return []; }
    },
    async searchChannelByName(name) {
      try {
        const res = await apiFetch(`https://api.chzzk.naver.com/service/v1/search/channels?keyword=${encodeURIComponent(name)}&offset=0&size=33&withFirstChannelContent=true`);
        if (res.ok) {
          const data = await res.json();
          if (data.content && data.content.data && data.content.data.length > 0) {
            const c = data.content.data[0].channel;
            return { platform: 'chzzk', hash: c.channelId, name: c.channelName };
          }
        }
      } catch (err) { console.error(`'${name}' 치지직 채널 검색 실패:`, err); }
      return null;
    },
    async getChannelById(id) {
      try {
        const res = await apiFetch(`https://api.chzzk.naver.com/service/v1/channels/${id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.content && data.content.channelName) {
            return { platform: 'chzzk', hash: id, name: data.content.channelName };
          }
        }
      } catch (err) { console.error('치지직 해시 조회 실패:', err); }
      return { platform: 'chzzk', hash: id, name: id.substring(0, 8) };
    },
    async searchTagLives(keywordsList) {
      const fetchChannelsForSingleTag = async (keyword) => {
        const channelMap = new Map();
        let nextParam = null;
        let hasNext = true;

        while (hasNext) {
          const url = new URL('https://api.chzzk.naver.com/service/v1/tag/lives');
          url.searchParams.set('size', '50');
          url.searchParams.set('sortType', 'POPULAR');
          url.searchParams.set('tags', keyword);

          if (nextParam && typeof nextParam === 'object') {
            Object.keys(nextParam).forEach(key => {
              if (nextParam[key] !== null && nextParam[key] !== undefined) {
                url.searchParams.set(key, nextParam[key]);
              }
            });
          }

          const res = await apiFetch(url.toString());
          if (!res.ok) break;

          const data = await res.json();
          const liveList = data.content?.data || data.content?.lives || [];

          liveList.forEach(item => {
            if (item.channel && item.channel.channelId) {
              channelMap.set(item.channel.channelId, {
                platform: 'chzzk',
                hash: item.channel.channelId,
                name: item.channel.channelName
              });
            }
          });

          const pageNext = data.content?.page?.next;
          if (pageNext && Object.keys(pageNext).length > 0) {
            nextParam = pageNext;
          } else {
            hasNext = false;
          }
        }
        return channelMap;
      };

      const results = await Promise.all(keywordsList.map(k => fetchChannelsForSingleTag(k)));
      const firstMap = results[0];
      const finalMap = new Map();
      firstMap.forEach((info, id) => {
        if (results.slice(1).every(m => m.has(id))) finalMap.set(id, info);
      });
      return Array.from(finalMap.values());
    },
    async fetchFollowingLive() {
      const res = await apiFetch('https://api.chzzk.naver.com/service/v1/channels/followings/live?size=100', { credentials: 'include' });
      if (!res.ok) { const err = new Error('chzzk_following_failed'); err.status = res.status; throw err; }
      const data = await res.json();
      const list = data.content?.followingList || data.content?.data || [];
      return list.map(item => {
        const c = item.channel || item;
        const liveImg = item.liveImageUrl || item.defaultThumbnailImageUrl || c.channelImageUrl || '';
        return {
          platform: 'chzzk',
          hash: c.channelId,
          name: c.channelName,
          title: item.liveTitle || '',
          thumbnail: liveImg ? liveImg.replace('{type}', '270') : '',
          viewersText: typeof item.concurrentUserCount === 'number' ? item.concurrentUserCount.toLocaleString() : ''
        };
      });
    },
    async checkLoginStatus() {
      try {
        const res = await apiFetch('https://api.chzzk.naver.com/service/v1/channels/followings/live?size=1', { credentials: 'include' });
        return res.ok;
      } catch (e) { return false; }
    },
    getLoginUrl() { return 'https://nid.naver.com/nidlogin.login?url=https://chzzk.naver.com/'; },
    getLogoutUrl() { return 'https://nid.naver.com/nidlogin.logout?returl=https://chzzk.naver.com/'; },
    getVideoEmbedUrl(id) { return `https://chzzk.naver.com/live/${id}`; },
    getChatEmbedUrl(id) { return `https://chzzk.naver.com/live/${id}/chat`; },
    getChannelHomeUrl(id) { return `https://chzzk.naver.com/${id}`; },
    async checkFollowStatus(id) {
      try {
        const res = await apiFetch(`https://api.chzzk.naver.com/service/v1/channels/${id}`, { credentials: 'include' });
        if (!res.ok) return false;
        const data = await res.json();
        return !!(data.content && data.content.personalData && data.content.personalData.following);
      } catch (e) { return false; }
    },
    async setFollow(id, follow) {
      const url = `https://api.chzzk.naver.com/service/v1/channels/${id}/follow`;
      const init = { method: follow ? 'POST' : 'DELETE' };
      try {
        const res = await frameApiFetch(id, url, init);
        return !!res.ok;
      } catch (frameErr) {
        console.warn('[CHEESE EYES] 치지직 팔로우 프레임 프록시 실패, background로 폴백:', frameErr);
        try {
          const res = await apiFetch(url, { ...init, credentials: 'include' });
          return !!res.ok;
        } catch (e) { console.error('[CHEESE EYES] 치지직 팔로우 처리 실패:', e); return false; }
      }
    }
  },

  soop: {
    async _liveSearch(keyword, { page = 1, count = 20 } = {}) {
      try {
        const sessionKey = await getSoopSessionKey();
        const url = `https://sch.sooplive.com/api.php?l=DF&m=liveSearch&c=UTF-8&w=webk&isMobile=0&onlyParent=1&szType=json` +
          `&sck_session_key=${encodeURIComponent(sessionKey)}&szOrder=score&szKeyword=${encodeURIComponent(keyword)}` +
          `&nPageNo=${page}&nListCnt=${count}&tab=total&location=total_search&isHashSearch=0&v=2.0`;
        const res = await apiFetch(url, { credentials: 'include' });
        if (!res.ok) return [];
        const data = await res.json();
        return data?.REAL_BROAD || data?.data || data?.list || data?.result || [];
      } catch (err) { console.error(`'${keyword}' 숲 liveSearch 실패:`, err); return []; }
    },
    _toChannelData(raw) {
      if (!raw) return null;
      const id = raw.user_id || raw.bj_id;
      if (!id) return null;
      const nm = raw.user_nick || id;
      const broadNo = raw.broad_no;
      return { platform: 'soop', hash: id, broadNo, name: nm };
    },
    async searchAutocomplete(keyword, size = 10) {
      try {
        const list = await this._liveSearch(keyword, { count: size });
        const kw = String(keyword || '').trim().toLowerCase();
        const seen = new Set();
        const items = [];
        for (const raw of list) {
          const text = String(raw.user_nick || raw.user_id || '').trim();
          if (!text || seen.has(text)) continue;
          // 검색어를 포함하지 않는 연관 검색어(느슨한 매칭 결과)는 목록에서 제외한다.
          if (kw && !text.toLowerCase().includes(kw)) continue;
          seen.add(text);
          items.push({ platform: 'soop', type: 'bj', text, user_id: raw.user_id || '', broadNo: raw.broad_no || '' });
          if (items.length >= size) break;
        }
        return items;
      } catch (e) { return []; }
    },
    async searchChannelByName(name) {
      const list = await this._liveSearch(name);
      const first = list[0];
      if (!first || String(first.user_nick || '').trim() !== String(name).trim()) {
        return null;
      }
      return this._toChannelData(first);
    },
    async searchChannelById(id) {
      const list = await this._liveSearch(id);
      const matched = list.find(c => (c.user_id || '').trim() === id.trim()) || list[0];
      return this._toChannelData(matched);
    },
    async getChannelById(id) {
      const found = await this.searchChannelById(id);
      if (found) return found;
      return { platform: 'soop', hash: id, name: id };
    },
    async _fetchByCategoryNo(categoryNo) {
      const map = new Map();
      try {
        const url = `https://sch.sooplive.com/api.php?m=categoryContentsList&szType=live&nPageNo=1&nListCnt=60&szPlatform=pc&szCateNo=${encodeURIComponent(categoryNo)}&szOrder=view_cnt_desc&strmLangType=`;
        const res = await apiFetch(url);
        if (!res.ok) {
          console.warn(`[숲] 카테고리 '${categoryNo}' 요청 실패 (status=${res.status})`);
          return map;
        }
        const data = await res.json();
        const list = data?.data?.list;
        if (!Array.isArray(list)) {
          console.warn(`[숲] 카테고리 '${categoryNo}' 응답에서 list 배열을 찾지 못함`, data);
          return map;
        }
        list.forEach(item => {
          const c = this._toChannelData(item);
          if (c) map.set(c.hash, c);
        });
        console.log(`[숲] 카테고리 '${categoryNo}' 검색 결과: ${map.size}개`);
      } catch (err) {
        console.error(`[숲] 카테고리 '${categoryNo}' 검색 실패:`, err);
      }
      return map;
    },
    async _fetchByHashtag(keyword, { page = 1, count = 60 } = {}) {
      const map = new Map();
      try {
        const sessionKey = await getSoopSessionKey();
        const url = `https://sch.sooplive.com/api.php?l=DF&m=liveSearch&c=UTF-8&w=webk&isMobile=0&onlyParent=1&szType=json` +
          `&sck_session_key=${encodeURIComponent(sessionKey)}&szOrder=view_cnt&szOrderType=desc&szKeyword=${encodeURIComponent(keyword)}` +
          `&nPageNo=${page}&nListCnt=${count}&tab=live&location=hash&isHashSearch=1&v=2.0`;
        const res = await apiFetch(url, { credentials: 'include' });
        if (!res.ok) {
          console.warn(`[숲] 해시태그 '${keyword}' 요청 실패 (status=${res.status})`);
          return map;
        }
        const data = await res.json();
        const list = data?.REAL_BROAD;
        if (!Array.isArray(list)) {
          console.warn(`[숲] 해시태그 '${keyword}' 응답에서 REAL_BROAD 배열을 찾지 못함`, data);
          return map;
        }
        list.forEach(item => {
          const c = this._toChannelData(item);
          if (c) map.set(c.hash, c);
        });
        console.log(`[숲] 해시태그 '${keyword}' 검색 결과: ${map.size}개`);
      } catch (err) {
        console.error(`[숲] 해시태그 '${keyword}' 검색 실패:`, err);
      }
      return map;
    },
    async searchTagLives(categoryNoList) {
      try {
        const perCategory = await Promise.all(categoryNoList.map(async (tag) => {
          const catMap = await this._fetchByCategoryNo(tag);
          if (catMap.size > 0) return catMap;
          console.log(`[숲] '${tag}' 카테고리 결과 없음 → 해시태그 검색으로 폴백`);
          return await this._fetchByHashtag(tag);
        }));

        const firstMap = perCategory[0] || new Map();
        const finalMap = new Map();
        firstMap.forEach((info, id) => {
          if (perCategory.slice(1).every(m => m.has(id))) finalMap.set(id, info);
        });
        console.log(`[숲] 태그 검색 최종 교집합: ${finalMap.size}개`);
        return Array.from(finalMap.values());
      } catch (err) { console.error('숲 카테고리 검색 실패:', err); return []; }
    },
    async fetchFollowingLive() {
      const res = await apiFetch('https://myapi.sooplive.com/api/favorite', { credentials: 'include' });
      if (!res.ok) { const err = new Error('soop_following_failed'); err.status = res.status; throw err; }
      const data = await res.json();
      const list = Array.isArray(data?.data) ? data.data : [];
      return list
        .filter(item => item && Array.isArray(item.broad_info) && item.broad_info.length > 0)
        .map(item => {
          const info = item.broad_info[0] || {};
          const c = this._toChannelData({
            ...item,
            broad_no: info.broad_no || info.BROAD_NO || item.broad_no
          });
          if (!c) return null;
          const viewers = info.total_view_cnt ?? info.view_cnt ?? info.m_current_view_cnt;
          return {
            ...c,
            title: info.broad_title || info.title || '',
            thumbnail: info.broad_img || info.thumbnail || '',
            viewersText: viewers != null ? Number(viewers).toLocaleString() : ''
          };
        })
        .filter(c => c && c.hash);
    },
    _favoriteListPromise: null,
    _favoriteListFetchedAt: 0,
    async _fetchFavoriteList(force = false) {
      const now = Date.now();
      if (!force && this._favoriteListPromise && (now - this._favoriteListFetchedAt) < 5000) {
        return this._favoriteListPromise;
      }
      this._favoriteListFetchedAt = now;
      this._favoriteListPromise = (async () => {
        try {
          const res = await apiFetch('https://myapi.sooplive.com/api/favorite', { credentials: 'include' });
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data?.data) ? data.data : [];
        } catch (e) { return []; }
      })();
      return this._favoriteListPromise;
    },
    getChannelHomeUrl(id) { return `https://www.sooplive.com/station/${id}`; },
    async checkFollowStatus(id) {
      try {
        const list = await this._fetchFavoriteList();
        const found = list.find(item => item && item.user_id === id);
        return !!(found && found.is_favorite);
      } catch (e) { return false; }
    },
    async setFollow(id, follow) {
      const url = follow ? 'https://myapi.sooplive.com/api/favorite' : `https://myapi.sooplive.com/api/favorite/${id}`;
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(follow ? { user_id: id } : { _method: 'delete' })
      };
      try {
        let res;
        try {
          res = await frameApiFetch(id, url, init);
        } catch (frameErr) {
          console.warn('[CHEESE EYES] 숲 팔로우 프레임 프록시 실패, background로 폴백:', frameErr);
          res = await apiFetch(url, { ...init, credentials: 'include' });
        }
        if (res.ok) this._favoriteListFetchedAt = 0;
        return !!res.ok;
      } catch (e) { console.error('[CHEESE EYES] 숲 팔로우 처리 실패:', e); return false; }
    },
    async checkLoginStatus() {
      const cookieLoggedIn = await checkLoginCookie('https://login.sooplive.com/', ['AuthTicket', 'UserTicket']);
      if (cookieLoggedIn) return true;

      try {
        const res = await apiFetch('https://afevent2.sooplive.co.kr/api/get_private_info.php', { credentials: 'include' });
        if (!res.ok) return false;
        const data = await res.json();
        return !!(data && data.CHANNEL && Number(data.CHANNEL.IS_LOGIN) === 1);
      } catch (e) { return false; }
    },
    getLoginUrl() {
      const redirect = 'https%3A%2F%2Fwww.sooplive.com%2F%3FNaPm%3Dct%253Dms449q61%257Cci%253Dcheckout%257Ctr%253Dds%257Ctrx%253Dnull%257Chk%253Db35fd46bed07395082f04cfc18718246fc96e156';
      return `https://login.sooplive.com/afreeca/login.php?szFrom=pop&request_uri=${redirect}`;
    },
    getLogoutUrl() { return null; },
    async logout() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'SOOP_LOGOUT' }, (res) => {
          resolve(!!(res && res.ok));
        });
      });
    },
    getVideoEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      const broadNo = ch && ch.broadNo;
      return broadNo ? `https://play.sooplive.com/${id}/${broadNo}` : `https://play.sooplive.com/${id}`;
    },
    getChatEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      const broadNo = ch && ch.broadNo;
      return broadNo ? `https://play.sooplive.com/${id}/${broadNo}?vtype=chat` : `https://play.sooplive.com/${id}?vtype=chat`;
    }
  },

  youtube: {
    async _context() {
      return {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20260101.00.00',
          hl: (typeof window !== 'undefined' && window.CHEESE_EYES_CURRENT_LANG) || 'ko'
        }
      };
    },
    INNERTUBE_API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    async _innerTubePost(path, body, requiresAuth = false) {
      const res = await apiFetch(`https://www.youtube.com/youtubei/v1/${path}?key=${this.INNERTUBE_API_KEY}&prettyPrint=false`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': body?.context?.client?.clientVersion || '2.20260101.00.00'
        },
        body: JSON.stringify(body),
        requiresAuth
      });
      if (!res.ok) {
        const reason = res.statusText ? ` (${res.statusText})` : '';
        console.warn(`[CHEESE EYES] InnerTube ${path} 요청 실패: status=${res.status}${reason}`);
        return null;
      }
      try { return await res.json(); } catch (e) { return null; }
    },
    _collectLiveVideoRenderers(node, out = []) {
      if (!node || typeof node !== 'object') return out;
      if (node.videoRenderer) {
        const vr = node.videoRenderer;
        const isLive = !!(vr.badges || []).some(b => b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW')
          || vr.thumbnailOverlays?.some(o => o?.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE');
        if (isLive) out.push(vr);
      }
      for (const key in node) {
        if (key === 'videoRenderer') continue;
        const val = node[key];
        if (val && typeof val === 'object') this._collectLiveVideoRenderers(val, out);
      }
      return out;
    },
    _videoRendererToChannel(vr) {
      try {
        const owner = vr.ownerText?.runs?.[0] || vr.longBylineText?.runs?.[0] || vr.shortBylineText?.runs?.[0];
        const channelId = owner?.navigationEndpoint?.browseEndpoint?.browseId;
        const name = owner?.text || vr.title?.runs?.[0]?.text || '';
        const videoId = vr.videoId;
        if (!channelId || !videoId) return null;
        const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || '';
        const thumbs = vr.thumbnail?.thumbnails;
        const thumbnail = Array.isArray(thumbs) && thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
        const viewersText = (vr.viewCountText?.runs || []).map(r => r.text).join('')
          || vr.shortViewCountText?.simpleText
          || '';
        return { platform: 'youtube', hash: channelId, name, videoId, title, thumbnail, viewersText };
      } catch (e) { return null; }
    },
    _collectChannelRenderers(node, out = []) {
      if (!node || typeof node !== 'object') return out;
      if (node.channelRenderer) {
        const cr = node.channelRenderer;
        const channelId = cr.channelId;
        if (channelId) {
          const name = cr.title?.simpleText || cr.title?.runs?.[0]?.text || '';
          const handleCandidate = cr.channelHandleText?.simpleText
            || (cr.subscriberCountText?.simpleText?.startsWith('@') ? cr.subscriberCountText.simpleText : '')
            || '';
          const subscriberText = (!handleCandidate && cr.subscriberCountText?.simpleText) || cr.videoCountText?.simpleText || '';
          out.push({ platform: 'youtube', hash: channelId, name, handle: handleCandidate, subscriberText });
        }
      }
      for (const key in node) {
        if (key === 'channelRenderer') continue;
        const val = node[key];
        if (val && typeof val === 'object') this._collectChannelRenderers(val, out);
      }
      return out;
    },
    async _searchChannelRenderers(keyword) {
      const context = await this._context();
      const data = await this._innerTubePost('search', { context, query: keyword, params: 'EgIQAg%3D%3D' });
      if (!data) return [];
      return this._collectChannelRenderers(data).filter(ch => ch.hash && ch.name);
    },
    _parseSubscriberCountText(text) {
      if (!text) return null;
      const cleaned = String(text).replace(/,/g, '');

      const koMatch = cleaned.match(/([\d.]+)\s*(만|천)?/);
      if (/구독자|명/.test(cleaned) && koMatch) {
        const num = parseFloat(koMatch[1]);
        if (isNaN(num)) return null;
        const unit = koMatch[2];
        if (unit === '만') return num * 10000;
        if (unit === '천') return num * 1000;
        return num;
      }

      const enMatch = cleaned.match(/([\d.]+)\s*([KMB])?/i);
      if (/subscribers?/i.test(cleaned) && enMatch) {
        const num = parseFloat(enMatch[1]);
        if (isNaN(num)) return null;
        const unit = (enMatch[2] || '').toUpperCase();
        if (unit === 'K') return num * 1_000;
        if (unit === 'M') return num * 1_000_000;
        if (unit === 'B') return num * 1_000_000_000;
        return num;
      }

      return null;
    },
    async searchAutocomplete(keyword, size = 10) {
      try {
        const isHandleMode = keyword.startsWith('@');
        const hl = (typeof window !== 'undefined' && window.CHEESE_EYES_CURRENT_LANG) || 'ko';
        const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=${encodeURIComponent(hl)}&q=${encodeURIComponent(keyword)}`;
        const res = await apiFetch(url);
        if (!res.ok) return [];

        let suggestions = [];
        try {
          const raw = await res.text();
          const parsed = JSON.parse(raw);
          suggestions = Array.isArray(parsed?.[1])
            ? parsed[1].map(s => Array.isArray(s) ? s[0] : s).filter(s => typeof s === 'string')
            : [];
        } catch (e) { return []; }

        const filtered = isHandleMode
          ? suggestions.filter(s => s.startsWith('@'))
          : suggestions.filter(s => !this._looksLikeNonChannelQuery(s));

        return filtered.slice(0, size).map(text => ({ platform: 'youtube', text }));
      } catch (e) { console.error('유튜브 자동완성(Stage A) 실패:', e); return []; }
    },
    _looksLikeNonChannelQuery(text) {
      const s = String(text).trim();
      if (!s) return true;
      if (/[?!]/.test(s)) return true;
      if (/\s/.test(s)) return true;

      const topicWords = ['리뷰', 'review', 'vs', '비교', '모음', '총정리', '순위', 'top', '베스트', 'best', '하는법', 'how to', 'tutorial'];
      const lower = s.toLowerCase();
      if (topicWords.some(w => lower.includes(w))) return true;

      if (s.split(/\s+/).filter(Boolean).length > 5) return true;

      if (/\d/.test(s) && /(결산|가지|선정|추천)/.test(s)) return true;

      return false;
    },
    async _resolveKeywordCandidatesForStageB(query) {
      const data = await this._fetchLiveSearchResults(query);
      if (!data) return [];

      const liveRenderers = this._collectLiveVideoRenderers(data);
      const seen = new Set();
      const candidates = [];
      for (const vr of liveRenderers) {
        const ch = this._videoRendererToChannel(vr);
        if (!ch || seen.has(ch.hash)) continue;
        seen.add(ch.hash);
        const thumbnail = vr.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '';
        const viewersText = vr.viewCountText?.runs?.map(r => r.text).join('') || vr.viewCountText?.simpleText || '';
        const title = vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || '';
        candidates.push({ ...ch, thumbnail, viewersText, title });
      }

      const withIndex = candidates.map((c, idx) => ({ ...c, _idx: idx, _viewers: this._parseViewerCountText(c.viewersText) }));
      withIndex.sort((a, b) => {
        if (a._viewers == null && b._viewers == null) return a._idx - b._idx;
        if (a._viewers == null) return 1;
        if (b._viewers == null) return -1;
        if (b._viewers !== a._viewers) return b._viewers - a._viewers;
        return a._idx - b._idx;
      });
      return withIndex.map(({ _idx, _viewers, ...rest }) => rest);
    },
    async _fetchLiveSearchResults(query) {
      try {
        const context = await this._context();
        return await this._innerTubePost('search', { context, query, params: 'EgJAAQ%3D%3D' });
      } catch (e) { console.error(`'${query}' 유튜브 라이브 검색 실패:`, e); return null; }
    },
    async _resolveHandleCandidatesForStageB(handleText) {
      const resolved = await this._resolveByHandleOrText(handleText);
      if (!resolved) return [];
      return [{
        platform: 'youtube',
        hash: resolved.hash,
        name: resolved.name,
        videoId: resolved.videoId || null,
        thumbnail: '',
        viewersText: ''
      }];
    },
    _parseViewerCountText(text) {
      if (!text) return null;
      const cleaned = String(text).replace(/,/g, '');

      const koMatch = cleaned.match(/([\d.]+)\s*(만|천)?/);
      if (koMatch) {
        const num = parseFloat(koMatch[1]);
        if (!isNaN(num)) {
          if (koMatch[2] === '만') return num * 10000;
          if (koMatch[2] === '천') return num * 1000;
          return num;
        }
      }

      const enMatch = cleaned.match(/([\d.]+)\s*([KMB])?/i);
      if (enMatch) {
        const num = parseFloat(enMatch[1]);
        if (!isNaN(num)) {
          const unit = (enMatch[2] || '').toUpperCase();
          if (unit === 'K') return num * 1_000;
          if (unit === 'M') return num * 1_000_000;
          if (unit === 'B') return num * 1_000_000_000;
          return num;
        }
      }
      return null;
    },
    async searchChannelByName(name) {
      try {
        const channels = await this._searchChannelRenderers(name);
        if (channels.length === 0) return null;
        return await this._resolveByChannelId(channels[0].hash);
      } catch (err) { console.error(`'${name}' 유튜브 채널 검색 실패:`, err); return null; }
    },
    async _resolveByChannelId(channelId) {
      let name = channelId;
      try {
        const context = await this._context();
        const data = await this._innerTubePost('browse', { context, browseId: channelId });
        console.log(`[CHEESE EYES][YT-DEBUG] browse(${channelId}) 응답 여부:`, !!data);
        if (data) {
          const liveRenderers = this._collectLiveVideoRenderers(data);
          console.log(`[CHEESE EYES][YT-DEBUG] browse(${channelId}) liveRenderers 개수:`, liveRenderers.length);
          const match = liveRenderers.map(vr => this._videoRendererToChannel(vr)).find(c => c && c.hash === channelId);
          if (match) {
            console.log(`[CHEESE EYES][YT-DEBUG] browse에서 videoId 확보 성공:`, match.videoId);
            return match;
          }
          const metaTitle = data?.metadata?.channelMetadataRenderer?.title;
          if (metaTitle) name = metaTitle;
          console.log(`[CHEESE EYES][YT-DEBUG] browse에서는 라이브 카드를 못 찾음, /live 폴백 시도`);
        }
      } catch (err) {
        console.error(`'${channelId}' 유튜브 채널 browse 실패:`, err);
      }

      // browse(홈 탭) 응답에 라이브 카드가 노출되지 않는 채널(레이아웃에 따라 흔함)을 위한
      // 폴백. 확정적인 videoId 없이 /embed/live_stream?channel=... 로 임베드하면 최근
      // YouTube 쪽에서 "오류 153: 동영상 플레이어 구성 오류"가 자주 발생하므로, 대신
      // /channel/<id>/live 가 라이브 중일 때 해당 영상의 watch 페이지로 캐노니컬되는
      // 점을 이용해 videoId만 안전하게 추출한다.
      try {
        const videoId = await this._resolveLiveVideoIdFromLivePage(channelId);
        console.log(`[CHEESE EYES][YT-DEBUG] /live 폴백 결과 videoId:`, videoId);
        if (videoId) return { platform: 'youtube', hash: channelId, name, videoId };
      } catch (err) {
        console.error(`'${channelId}' 유튜브 /live 페이지 조회 실패:`, err);
      }

      console.warn(`[CHEESE EYES][YT-DEBUG] ${channelId}: videoId를 끝내 확보하지 못함 (browse도, /live 폴백도 실패) -> live_stream?channel= 폴백으로 임베드될 예정`);
      return { platform: 'youtube', hash: channelId, name };
    },
    async _resolveLiveVideoIdFromLivePage(channelId) {
      const res = await apiFetch(`https://www.youtube.com/channel/${channelId}/live`);
      console.log(`[CHEESE EYES][YT-DEBUG] /channel/${channelId}/live 응답: ok=${res.ok} status=${res.status}`);
      if (!res.ok) return null;
      const html = await res.text();
      const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
      console.log(`[CHEESE EYES][YT-DEBUG] /live 페이지 canonical 매치:`, m ? m[1] : null, '(html 길이:', html.length, ')');
      return m ? m[1] : null;
    },
    async _resolveByHandleOrText(text) {
      try {
        const channels = await this._searchChannelRenderers(text);
        if (channels.length === 0) return null;
        const target = text.startsWith('@')
          ? (channels.find(ch => ch.handle && ch.handle.toLowerCase() === text.toLowerCase()) || channels[0])
          : channels[0];
        return await this._resolveByChannelId(target.hash);
      } catch (err) { console.error(`'${text}' 유튜브 채널 조회 실패:`, err); return null; }
    },
    async getChannelById(id) {
      const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;
      const YT_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
      if (YT_CHANNEL_ID_RE.test(id)) return await this._resolveByChannelId(id);
      if (id.startsWith('@')) {
        const found = await this._resolveByHandleOrText(id);
        if (found) return found;
        return { platform: 'youtube', hash: id, name: id };
      }
      if (YT_VIDEO_ID_RE.test(id)) {
        return { platform: 'youtube', hash: id, name: id, videoId: id };
      }
      const found = await this._resolveByHandleOrText(id);
      if (found) return found;
      return { platform: 'youtube', hash: id, name: id };
    },
    async fetchFollowingLive() {
      const context = await this._context();
      const data = await this._innerTubePost('browse', { context, browseId: 'FEsubscriptions' }, true);
      if (!data) { const err = new Error('youtube_following_failed'); throw err; }
      const liveRenderers = this._collectLiveVideoRenderers(data);
      return liveRenderers.map(vr => this._videoRendererToChannel(vr)).filter(Boolean);
    },
    async checkLoginStatus() {
      return await checkLoginCookie('https://www.youtube.com/', ['SAPISID', '__Secure-3PAPISID']);
    },
    getLoginUrl() { return 'https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&continue=https://www.youtube.com/'; },
    getLogoutUrl() { return 'https://www.youtube.com/logout'; },
    getVideoEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      const videoId = ch && ch.videoId;
      // 오류 153(동영상 플레이어 구성 오류)은 확장 origin에서 Referer가
      // 비어있어서 발생한다. 채팅과 동일하게 실제 https 도메인의 중계
      // 페이지(relay.html?type=video)를 거쳐 정상적인 Referer/origin으로 요청한다.
      // (yt-video.html/yt-chat.html 두 파일을 relay.html 하나로 통합 —
      //  GitHub Pages 캐시 적중률/유지보수 편의를 위함)
      const url = videoId
        ? `${YT_RELAY_ORIGIN}/relay.html?type=video&v=${encodeURIComponent(videoId)}&autoplay=1`
        : `${YT_RELAY_ORIGIN}/relay.html?type=video&channel=${encodeURIComponent(id)}&autoplay=1`;
      console.log(`[CHEESE EYES][YT-DEBUG] getVideoEmbedUrl(${id}) -> videoId=${videoId || '(없음)'} url=${url}`);
      return url;
    },
    getChatEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      const videoId = ch && ch.videoId;
      if (!videoId) return 'about:blank';
      // is_popout=1 방식도 결국 확장 origin에서는 거부당하는 사례가 확인되어,
      // 우리가 소유한 실제 https 도메인(YT_RELAY_ORIGIN)의 중계 페이지(relay.html?type=chat)를
      // 거쳐 embed_domain 검증을 정상적으로 통과시킨다.
      return `${YT_RELAY_ORIGIN}/relay.html?type=chat&v=${encodeURIComponent(videoId)}`;
    },
    getChannelHomeUrl(id) {
      const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;
      return YT_CHANNEL_ID_RE.test(id) ? `https://www.youtube.com/channel/${id}` : `https://www.youtube.com/${id}`;
    }
  }
};

function getAdapter(platform) {
  return PlatformAdapters[platform] || PlatformAdapters.chzzk;
}

async function refreshSoopBroadNo(hash) {
  try {
    const fresh = await PlatformAdapters.soop.searchChannelById(hash);
    if (!fresh || !fresh.broadNo) return;
    [channels, displayChannels].forEach(arr => {
      const c = arr.find(c => c.hash === hash && c.platform === 'soop');
      if (c) c.broadNo = fresh.broadNo;
    });
  } catch (e) {
    console.error(`[CHEESE EYES] 숲 broadNo 갱신 실패 (${hash}):`, e);
  }
}

function getChannelObjByHash(hash) {
  return displayChannels.find(c => c.hash === hash) || channels.find(c => c.hash === hash);
}

async function refreshYoutubeVideoId(hash) {
  try {
    const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;
    if (!YT_CHANNEL_ID_RE.test(hash)) return; 
    const fresh = await PlatformAdapters.youtube._resolveByChannelId(hash);
    if (!fresh || !fresh.videoId) return;
    [channels, displayChannels].forEach(arr => {
      const c = arr.find(c => c.hash === hash && c.platform === 'youtube');
      if (c) c.videoId = fresh.videoId;
    });
  } catch (e) {
    console.error(`[CHEESE EYES] 유튜브 videoId 갱신 실패 (${hash}):`, e);
  }
}

function buildPlatformTabsBar(activeTab, onSelect, excludePlatforms = []) {
  const bar = document.createElement('div');
  bar.className = 'search-platform-tabs';
  const tabs = [
    { key: 'all', label: t('platformTabs.all', '전체'), color: '#FFC800' },
    ...Object.keys(PLATFORM_META)
      .filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p] && !excludePlatforms.includes(p))
      .map(p => ({ key: p, label: getPlatformLabel(p), color: PLATFORM_META[p].color }))
  ];
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'search-platform-tab' + (t.key === activeTab ? ' active' : '');
    el.textContent = t.label;
    el.style.setProperty('--tab-color', t.color);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onSelect(t.key);
    });
    bar.appendChild(el);
  });
  return bar;
}

let currentSearchPlatformTab = 'all';
let currentListPlatformTab = 'all';
let listNoticeBuilder = null;

function saveSearchPlatformTab() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ search_platform_tab: currentSearchPlatformTab });
  } else {
    localStorage.setItem('search_platform_tab', currentSearchPlatformTab);
  }
}

const videoWrapperMap = new Map();
const videoGrid = document.getElementById('video-grid');
const chatTabs = document.getElementById('chat-tabs');
const chatContainer = document.getElementById('chat-frame-container');
const chatSidebar = document.getElementById('chat-sidebar');
const channelInput = document.getElementById('channel-input');
const autocompleteList = document.getElementById('autocomplete-list');
const chatToggleBtn = document.getElementById('chat-toggle');
const presetContainer = document.getElementById('preset-container');
const controlPanel = document.getElementById('control-panel');

if (controlPanel) {
  controlPanel.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      controlPanel.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

if (videoGrid) {
  videoGrid.addEventListener('wheel', (e) => {
    if (currentLayout === 'main_sub' && e.deltaY !== 0) {
      e.preventDefault();
      videoGrid.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

document.getElementById('add-btn')?.addEventListener('click', addChannelFromInput);
document.getElementById('mode-grid')?.addEventListener('click', () => switchLayout('grid'));
document.getElementById('mode-main_sub')?.addEventListener('click', () => switchLayout('main_sub'));
document.getElementById('chat-toggle')?.addEventListener('click', toggleChat);

document.getElementById('save-preset-btn')?.addEventListener('click', openPresetModal);
document.getElementById('clear-all-btn')?.addEventListener('click', clearAllPresets);

const tagSearchBtn = document.getElementById('tag-search-btn');
if (tagSearchBtn) {
  tagSearchBtn.addEventListener('click', () => openList('tag'));
}

const followingBtn = document.getElementById('following-btn');
if (followingBtn) {
  followingBtn.addEventListener('click', () => openList('following'));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.input-wrapper')) {
    hideAutocomplete();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const migrateChannel = (c) => ({ platform: c.platform || 'chzzk', hash: c.hash, name: c.name, broadNo: c.broadNo });

  const loadInitialData = (savedChannels, savedPresets, savedLayout, savedSearchTab, savedChatVisible) => {
    channels = (savedChannels || []).map(migrateChannel);
    displayChannels = [...channels];
    channelAddOrder = channels.map(c => c.hash);
    presets = (savedPresets || []).map(p => ({ ...p, channels: (p.channels || []).map(migrateChannel) }));
    currentLayout = savedLayout || 'grid';
    currentSearchPlatformTab = savedSearchTab || 'all';

    if (displayChannels.length > 0) {
      mainChannel = displayChannels[0].hash;
      activeChatChannel = displayChannels[0].hash;
    } else {
      mainChannel = null;
      activeChatChannel = null;
    }

    document.getElementById('mode-grid')?.classList.toggle('active', currentLayout === 'grid');
    document.getElementById('mode-main_sub')?.classList.toggle('active', currentLayout === 'main_sub');

    chatVisible = !!savedChatVisible;
    chatSidebar?.classList.toggle('active', chatVisible);
    chatToggleBtn?.classList.toggle('active', chatVisible);

    renderPresets();
    renderAll();
  };

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['my_channels', 'my_presets', 'my_layout', 'search_platform_tab', 'my_chat_visible'], (result) => {
      loadInitialData(result.my_channels, result.my_presets, result.my_layout, result.search_platform_tab, result.my_chat_visible);
    });
  } else {
    const savedChannels = JSON.parse(localStorage.getItem('my_channels') || '[]');
    const savedPresets = JSON.parse(localStorage.getItem('my_presets') || '[]');
    const savedLayout = localStorage.getItem('my_layout') || 'grid';
    const savedSearchTab = localStorage.getItem('search_platform_tab') || 'all';
    const savedChatVisible = localStorage.getItem('my_chat_visible') === '1';
    loadInitialData(savedChannels, savedPresets, savedLayout, savedSearchTab, savedChatVisible);
  }
});

window.addEventListener('resize', () => {
  renderVideo();
});

if (chatTabs) {
  chatTabs.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      chatTabs.scrollLeft += e.deltaY;
    }
  });
}

if (presetContainer) {
  presetContainer.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      presetContainer.scrollLeft += e.deltaY;
    }
  });
}

window.addEventListener('message', (event) => {
  if (event.data && (event.data.type === 'FRAME_CLICKED' || event.data.type === 'CHZZK_FRAME_CLICKED')) {
    const clickedUrl = event.data.url;
    const matchedChannel = channels.find(c => clickedUrl.includes(c.hash));
    if (!matchedChannel) return;

    if (currentLayout === 'main_sub' && mainChannel !== matchedChannel.hash) {
      setMainChannel(matchedChannel.hash);
    }

    if (activeChatChannel !== matchedChannel.hash) {
      setChatChannel(matchedChannel.hash);
    }
  }
});

function saveChannelsToStorage() {
  const dataToSave = {
    'my_channels': channels,
    'main_channel': mainChannel 
  };

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set(dataToSave);
  } else {
    localStorage.setItem('my_channels', JSON.stringify(channels));
    if (mainChannel) {
      localStorage.setItem('main_channel', mainChannel);
    }
  }
}

function savePresetsToStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ 'my_presets': presets });
  } else {
    localStorage.setItem('my_presets', JSON.stringify(presets));
  }
}

function saveLayoutToStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ 'my_layout': currentLayout });
  } else {
    localStorage.setItem('my_layout', currentLayout);
  }
}

function getParsedKeywords(input) {
  if (!input) return [];
  return input
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '');
}

let currentNoticeMode = 'tag';

function openList(mode = 'tag') {
  currentNoticeMode = mode;
  currentListPlatformTab = 'all';
  listNoticeBuilder = null;

  let displayTitle = '';
  let keywords = [];

  if (currentNoticeMode === 'tag') {
    const value = channelInput ? channelInput.value : '';
    keywords = getParsedKeywords(value);

    if (keywords.length === 0) {
      if (channelInput) channelInput.focus();
      return;
    }
    displayTitle = t('tagSearch.titleTemplate', `'${keywords.join(', ')}' 태그 방송 채널`, { keywords: keywords.join(', ') });
  } else if (currentNoticeMode === 'following') {
    displayTitle = t('following.titlePrefix', '팔로우 채널 중 ') + t('following.titleLive', '라이브') + t('following.titleSuffix', ' 목록');
  }

  let noticeBackdrop = document.getElementById('tag-notice-modal');

  if (!noticeBackdrop) {
    noticeBackdrop = document.createElement('div');
    noticeBackdrop.id = 'tag-notice-modal';
    noticeBackdrop.className = 'tag-notice-backdrop';
    noticeBackdrop.innerHTML = `
      <div class="tag-notice-window">
        <div class="tag-notice-header">
          <h3 id="tag-notice-title">${t('modal.searchResultTitle', '검색 결과')}</h3>
          <button class="tag-notice-close" id="tag-notice-close-btn">✕</button>
        </div>
        <div class="tag-notice-body" id="tag-notice-body"></div>
        <div class="tag-notice-footer">
          <button id="tag-modal-select-all">${t('modal.selectAll', '전체 선택')}</button>
          <button id="tag-modal-add-confirm">${t('modal.addSelected', '선택한 채널 추가')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(noticeBackdrop);
    
    document.getElementById('tag-notice-close-btn').addEventListener('click', closeTagNoticeModal);
    document.getElementById('tag-modal-select-all').addEventListener('click', toggleSelectAllTagChannels);
    document.getElementById('tag-modal-add-confirm').addEventListener('click', confirmAddTagChannels);
    
    noticeBackdrop.addEventListener('click', (e) => {
      if (e.target === noticeBackdrop) {
        closeTagNoticeModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      const modal = document.getElementById('tag-notice-modal');
      if (!modal || !modal.classList.contains('active')) return;

      if (e.key === 'Escape' || e.key === 'Esc') {
        closeTagNoticeModal();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirmAddTagChannels();
      }
    });
  }

  const noticeTitleEl = document.getElementById('tag-notice-title');
  noticeTitleEl.style.color = '#ffc800';
  if (currentNoticeMode === 'following') {
    const prefix = t('following.titlePrefix', '팔로우 채널 중 ');
    const live = t('following.titleLive', '라이브');
    const suffix = t('following.titleSuffix', ' 목록');
    noticeTitleEl.innerHTML = `${prefix}<span style="color:#FFc800">${live}</span>${suffix}`;
  } else {
    noticeTitleEl.textContent = displayTitle;
  }
  noticeBackdrop.classList.add('active');

  if (currentNoticeMode === 'tag') {
    fetchTagLives(keywords);
  } else if (currentNoticeMode === 'following') {
    fetchMyFollowingChannels();
  }
}

function closeTagNoticeModal() {
  const noticeBackdrop = document.getElementById('tag-notice-modal');

  if (noticeBackdrop) {
    noticeBackdrop.classList.remove('active');
  }
}

function buildFollowingLoginRow(platform) {
  const meta = PLATFORM_META[platform];
  const row = document.createElement('div');
  row.className = 'login-notice-row';

  const label = document.createElement('span');
  label.textContent = t('following.loginRequiredTemplate', `${meta.label} 로그인이 필요합니다.`, { platform: getPlatformLabel(platform) });
  label.className = 'login-notice-label';

  const btnGroup = document.createElement('div');
  btnGroup.style.cssText = 'display:flex; gap:6px;';

  const loginBtn = document.createElement('button');
  loginBtn.textContent = t('following.loginButtonTemplate', `${meta.label} 로그인`, { platform: getPlatformLabel(platform) });
  // 숲(파랑)/유튜브(빨강) 배경은 검정 글씨보다 흰 글씨가 더 잘 보인다.
  const loginBtnTextColor = (platform === 'soop' || platform === 'youtube') ? '#ffffff' : '#000000';
  loginBtn.style.cssText = `padding:6px 12px; cursor:pointer; border-radius:4px; border:none; background:${meta.color}; color:${loginBtnTextColor}; font-weight:bold; font-size:12px;`;
  loginBtn.addEventListener('click', () => {
    openLoginPopup(getAdapter(platform).getLoginUrl()).then(() => {
      fetchMyFollowingChannels();
    });
  });

  const retryBtn = document.createElement('button');
  retryBtn.textContent = t('following.loginDone', '로그인 완료');
  retryBtn.className = 'login-notice-retry-btn';
  retryBtn.addEventListener('click', () => fetchMyFollowingChannels());

  btnGroup.appendChild(loginBtn);
  btnGroup.appendChild(retryBtn);
  row.appendChild(label);
  row.appendChild(btnGroup);
  return row;
}

async function fetchMyFollowingChannels() {
  const bodyContainer = document.getElementById('tag-notice-body');
  bodyContainer.innerHTML = `<div class="tag-notice-empty">${t('following.loading', '팔로우 채널 목록을 불러오는 중...')}</div>`;

  fetchedTagChannels = [];
  selectedTagChannels = [];
  listNoticeBuilder = null;

  const enabledPlatforms = Object.keys(PLATFORM_META).filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p]);
  const loginStatuses = await Promise.all(enabledPlatforms.map(p => PlatformAdapters[p].checkLoginStatus()));
  const loginStatusByPlatform = Object.fromEntries(enabledPlatforms.map((p, i) => [p, loginStatuses[i]]));

  const loggedInPlatforms = enabledPlatforms.filter(p => loginStatusByPlatform[p]);
  // 플랫폼별로 병렬 요청하되, 화면에는 모든 플랫폼의 응답이 다 도착한 뒤 한 번에만
  // 표시한다(먼저 도착한 플랫폼 결과를 바로 띄우지 않음).
  const settled = await Promise.allSettled(loggedInPlatforms.map(p => PlatformAdapters[p].fetchFollowingLive()));
  const followingGroups = [];
  const results = [];
  loggedInPlatforms.forEach((p, i) => {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      const candidates = outcome.value || [];
      followingGroups.push({ platform: p, candidates });
      results.push(...candidates);
    } else {
      console.error(`${PLATFORM_META[p].label} 팔로우 목록 요청 실패:`, outcome.reason);
      followingGroups.push({ platform: p, candidates: [] });
    }
  });

  fetchedTagChannels = results;

  const loggedOutPlatforms = enabledPlatforms.filter(p => !loginStatusByPlatform[p]);
  if (loggedOutPlatforms.length > 0) {
    listNoticeBuilder = () => {
      const wrap = document.createElement('div');
      loggedOutPlatforms.forEach(p => wrap.appendChild(buildFollowingLoginRow(p)));
      return wrap;
    };
  }

  if (fetchedTagChannels.length === 0 && !listNoticeBuilder) {
    bodyContainer.innerHTML = `<div class="tag-notice-empty">${t('following.empty', '라이브 중인 채널이 없습니다.')}</div>`;
    return;
  }
  if (fetchedTagChannels.length === 0) {
    bodyContainer.innerHTML = '';
    bodyContainer.appendChild(listNoticeBuilder());
    const empty = document.createElement('div');
    empty.className = 'tag-notice-empty';
    empty.textContent = t('following.empty', '라이브 중인 채널이 없습니다.');
    bodyContainer.appendChild(empty);
    return;
  }

  renderFollowingColumns(followingGroups);
}

// 검색 결과 모달(live-confirm)과 동일한 플랫폼별 컬럼 스타일로 팔로우 목록을
// 그린다. 단, 검색 결과와 달리 진행 중 표시 없이 모든 플랫폼 응답이 도착한
// 뒤 한 번에만 렌더링된다(fetchMyFollowingChannels에서 이미 대기 후 호출됨).
function renderFollowingColumns(groups) {
  const bodyContainer = document.getElementById('tag-notice-body');
  bodyContainer.innerHTML = '';

  if (listNoticeBuilder) {
    bodyContainer.appendChild(listNoticeBuilder());
  }

  const tabsBar = buildPlatformTabsBar(currentListPlatformTab, (tab) => {
    currentListPlatformTab = tab;
    renderFollowingColumns(groups);
  });
  bodyContainer.appendChild(tabsBar);

  const listWrap = document.createElement('div');
  // 팔로우 목록은 태그 검색 결과와 달리 채널 카드(썸네일+제목) 없이
  // 태그 목록처럼 칩 형태로 표시한다. (dashboard.css의 .following-mode 참고)
  listWrap.className = 'live-confirm-rows following-mode';

  groups.forEach(group => {
    if (currentListPlatformTab !== 'all' && group.platform !== currentListPlatformTab) return;
    (group.candidates || []).forEach(ch => {
      const isSelected = selectedTagChannels.some(item => item.hash === ch.hash && item.platform === ch.platform);
      const row = createLiveResultRow(ch, isSelected, () => {
        const idx = selectedTagChannels.findIndex(s => s.hash === ch.hash && s.platform === ch.platform);
        if (idx > -1) {
          selectedTagChannels.splice(idx, 1);
          row.classList.remove('selected');
        } else {
          selectedTagChannels.push(ch);
          row.classList.add('selected');
        }
      });
      listWrap.appendChild(row);
    });
  });

  if (listWrap.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tag-notice-empty';
    empty.textContent = t('modal.emptyPlatformResult', '해당 플랫폼의 채널이 없습니다.');
    bodyContainer.appendChild(empty);
    return;
  }

  bodyContainer.appendChild(listWrap);
}

async function fetchTagLives(tagKeywords) {
  const bodyContainer = document.getElementById('tag-notice-body');
  bodyContainer.innerHTML = `<div class="tag-notice-empty">${t('tagSearch.loading', '전체 태그 방송 정보를 불러오는 중...')}</div>`;
  
  fetchedTagChannels = [];
  selectedTagChannels = [];
  listNoticeBuilder = null;

  const keywordsList = Array.isArray(tagKeywords) ? tagKeywords : [tagKeywords];

  if (keywordsList.length === 0) {
    bodyContainer.innerHTML = `<div class="tag-notice-empty">${t('tagSearch.noKeyword', '검색할 태그가 없습니다.')}</div>`;
    return;
  }

  try {
    const enabledPlatforms = Object.keys(PLATFORM_META).filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p] && p !== 'youtube');
    const resultsByPlatform = await Promise.all(
      enabledPlatforms.map(p => PlatformAdapters[p].searchTagLives(keywordsList)
        .catch(err => { console.error(`${PLATFORM_META[p].label} 태그 검색 실패:`, err); return []; }))
    );

    const relevanceQuery = keywordsList.join(', ');
    fetchedTagChannels = mergeTagChannelsByRelevance(relevanceQuery, resultsByPlatform);

    if (PLATFORM_META.youtube && PLATFORM_META.youtube.enabled) {
      listNoticeBuilder = () => {
        const notice = document.createElement('div');
        notice.className = 'login-notice-row';
        notice.textContent = t('tagSearch.youtubeUnsupported', '유튜브는 해시태그 기반 태그 검색을 지원하지 않습니다.');
        return notice;
      };
    }

    if (fetchedTagChannels.length > 0) {
      renderTagChipsInModal();
    } else {
      bodyContainer.innerHTML = '';
      if (listNoticeBuilder) bodyContainer.appendChild(listNoticeBuilder());
      const empty = document.createElement('div');
      empty.className = 'tag-notice-empty';
      empty.textContent = t('tagSearch.emptyResult', '해당 태그들을 모두 만족하는 방송 채널이 없습니다.');
      bodyContainer.appendChild(empty);
    }

  } catch (err) {
    console.error('태그 검색 요청 실패:', err);
    bodyContainer.innerHTML = `<div class="tag-notice-empty">${t('tagSearch.error', '데이터를 불러오지 못했습니다. 콘솔을 확인하세요.')}</div>`;
  }
}

function renderTagChipsInModal() {
  const bodyContainer = document.getElementById('tag-notice-body');
  bodyContainer.innerHTML = '';

  if (listNoticeBuilder) {
    bodyContainer.appendChild(listNoticeBuilder());
  }

  const tabsBar = buildPlatformTabsBar(currentListPlatformTab, (tab) => {
    currentListPlatformTab = tab;
    renderTagChipsInModal();
  }, currentNoticeMode === 'tag' ? ['youtube'] : []);
  bodyContainer.appendChild(tabsBar);

  const filtered = fetchedTagChannels.filter(c => currentListPlatformTab === 'all' || c.platform === currentListPlatformTab);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tag-notice-empty';
    empty.textContent = t('modal.emptyPlatformResult', '해당 플랫폼의 채널이 없습니다.');
    bodyContainer.appendChild(empty);
    return;
  }

  const chipWrapper = document.createElement('div');
  chipWrapper.className = 'tag-chip-container';

  filtered.forEach(ch => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip-item';
    chip.textContent = ch.name;
    chip.setAttribute('data-hash', ch.hash);
    chip.setAttribute('data-platform', ch.platform);
    chip.style.setProperty('--tab-color', getPlatformColor(ch.platform));

    if (selectedTagChannels.some(item => item.hash === ch.hash && item.platform === ch.platform)) {
      chip.classList.add('selected');
    }
    
    chip.addEventListener('click', (e) => {
      
      if (chipWrapper.classList.contains('has-dragged')) return;

      const existsIdx = selectedTagChannels.findIndex(item => item.hash === ch.hash && item.platform === ch.platform);

      if (existsIdx > -1) {
        selectedTagChannels.splice(existsIdx, 1);
        chip.classList.remove('selected');
      } else {
        selectedTagChannels.push(ch);
        chip.classList.add('selected');
      }
    });

    chipWrapper.appendChild(chip);
  });

  bodyContainer.appendChild(chipWrapper);
  
  initTagChipDragSelect(chipWrapper);
}

function initTagChipDragSelect(scrollContainer) {
  let isMouseDown = false;
  let isDragging = false;
  let startAbsX = 0;
  let startAbsY = 0;
  let dragRect = null;
  let initialSelectedState = new Map();
  let autoScrollTimer = null;
  let lastMouseEvt = null;
  let lastShiftStartAbsX = null;
  let lastShiftStartAbsY = null;
  let startChip = null;
  function toggleChipState(chip) {
    if (!chip) return;
    const hash = chip.getAttribute('data-hash');
    const platform = chip.getAttribute('data-platform');
    const channelObj = fetchedTagChannels.find(c => c.hash === hash && c.platform === platform);
    const isSelected = chip.classList.contains('selected');

    if (isSelected) {
      chip.classList.remove('selected');
      const idx = selectedTagChannels.findIndex(c => c.hash === hash && c.platform === platform);
      if (idx > -1) selectedTagChannels.splice(idx, 1);
    } else {
      chip.classList.add('selected');
      if (channelObj && !selectedTagChannels.some(c => c.hash === hash && c.platform === platform)) {
        selectedTagChannels.push(channelObj);
      }
    }
  }

  scrollContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;

    isMouseDown = true;
    isDragging = false;
    scrollContainer.classList.remove('has-dragged');

    const rect = scrollContainer.getBoundingClientRect();
    const currentChip = e.target.closest('.tag-chip-item');
    if (e.shiftKey && lastShiftStartAbsX !== null && lastShiftStartAbsY !== null) {
      startAbsX = lastShiftStartAbsX;
      startAbsY = lastShiftStartAbsY;
    } else {
      startAbsX = (e.clientX - rect.left) + scrollContainer.scrollLeft;
      startAbsY = (e.clientY - rect.top) + scrollContainer.scrollTop;
      
      lastShiftStartAbsX = startAbsX;
      lastShiftStartAbsY = startAbsY;
      startChip = currentChip; 
    }

    const chips = scrollContainer.querySelectorAll('.tag-chip-item');
    chips.forEach(chip => {
      initialSelectedState.set(chip, chip.classList.contains('selected'));
    });

    dragRect = document.createElement('div');
    dragRect.className = 'drag-select-rect';
    dragRect.style.left = `${startAbsX}px`;
    dragRect.style.top = `${startAbsY}px`;
    dragRect.style.width = '0px';
    dragRect.style.height = '0px';

    scrollContainer.appendChild(dragRect);
    if (e.shiftKey) {
      lastMouseEvt = e;
      updateDragSelection();
      const endChip = currentChip;
      toggleChipState(startChip);
      if (endChip && endChip !== startChip) {
        toggleChipState(endChip);
      }
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!isMouseDown) return;
    if (!isDragging) {
      isDragging = true;
      scrollContainer.classList.add('has-dragged');
      document.body.classList.add('drag-selecting');
      startAutoScroll();
    }

    lastMouseEvt = e;
    updateDragSelection();
  });

  window.addEventListener('mouseup', () => {
    if (!isMouseDown) return;

    isMouseDown = false;
    document.body.classList.remove('drag-selecting');
    stopAutoScroll();

    if (dragRect) {
      dragRect.remove();
      dragRect = null;
    }

    setTimeout(() => {
      scrollContainer.classList.remove('has-dragged');
    }, 50);

    isDragging = false;
    initialSelectedState.clear();
  });

  function updateDragSelection() {
    if (!dragRect || !lastMouseEvt) return;

    const e = lastMouseEvt;
    const rect = scrollContainer.getBoundingClientRect();

    const currentAbsX = (e.clientX - rect.left) + scrollContainer.scrollLeft;
    const currentAbsY = (e.clientY - rect.top) + scrollContainer.scrollTop;

    const rectLeft = Math.min(startAbsX, currentAbsX);
    const rectTop = Math.min(startAbsY, currentAbsY);
    const rectWidth = Math.abs(currentAbsX - startAbsX);
    const rectHeight = Math.abs(currentAbsY - startAbsY);

    dragRect.style.left = `${rectLeft}px`;
    dragRect.style.top = `${rectTop}px`;
    dragRect.style.width = `${rectWidth}px`;
    dragRect.style.height = `${rectHeight}px`;

    const chips = scrollContainer.querySelectorAll('.tag-chip-item');
    chips.forEach(chip => {
      const chipLeft = chip.offsetLeft;
      const chipTop = chip.offsetTop;
      const chipRight = chipLeft + chip.offsetWidth;
      const chipBottom = chipTop + chip.offsetHeight;

      const isIntersecting = !(
        rectLeft + rectWidth < chipLeft ||
        rectLeft > chipRight ||
        rectTop + rectHeight < chipTop ||
        rectTop > chipBottom
      );

      const hash = chip.getAttribute('data-hash');
      const platform = chip.getAttribute('data-platform');
      const channelObj = fetchedTagChannels.find(c => c.hash === hash && c.platform === platform);
      const wasSelectedOriginally = initialSelectedState.get(chip);

      if (isIntersecting) {
        if (wasSelectedOriginally) {
          chip.classList.remove('selected');
          const idx = selectedTagChannels.findIndex(c => c.hash === hash && c.platform === platform);

          if (idx > -1) selectedTagChannels.splice(idx, 1);
        } else {
          chip.classList.add('selected');

          if (channelObj && !selectedTagChannels.some(c => c.hash === hash && c.platform === platform)) {
            selectedTagChannels.push(channelObj);
          }
        }
      } else {
        if (wasSelectedOriginally) {
          chip.classList.add('selected');

          if (channelObj && !selectedTagChannels.some(c => c.hash === hash && c.platform === platform)) {
            selectedTagChannels.push(channelObj);
          }
        } else {
          chip.classList.remove('selected');
          const idx = selectedTagChannels.findIndex(c => c.hash === hash && c.platform === platform);

          if (idx > -1) selectedTagChannels.splice(idx, 1);
        }
      }
    });
  }

  function startAutoScroll() {
    stopAutoScroll();
    autoScrollTimer = setInterval(() => {
      if (!isDragging || !lastMouseEvt) return;

      const rect = scrollContainer.getBoundingClientRect();
      const mouseY = lastMouseEvt.clientY;
      const edgeThreshold = 35;
      const scrollSpeed = 10;

      if (mouseY > rect.bottom - edgeThreshold) {
        scrollContainer.scrollTop += scrollSpeed;
        updateDragSelection();
      } else if (mouseY < rect.top + edgeThreshold) {
        scrollContainer.scrollTop -= scrollSpeed;
        updateDragSelection();
      }
    }, 16);
  }

  function stopAutoScroll() {
    if (autoScrollTimer) {
      clearInterval(autoScrollTimer);
      autoScrollTimer = null;
    }
  }
}

function toggleSelectAllTagChannels() {
  const items = document.querySelectorAll('.tag-chip-item, .selectable-channel-item');
  if (items.length === 0) return;

  const filtered = fetchedTagChannels.filter(c => currentListPlatformTab === 'all' || c.platform === currentListPlatformTab);
  const isAllSelected = filtered.every(ch => selectedTagChannels.some(s => s.hash === ch.hash && s.platform === ch.platform));

  items.forEach((item) => {
    const hash = item.getAttribute('data-hash');
    const platform = item.getAttribute('data-platform');
    const ch = filtered.find(c => c.hash === hash && c.platform === platform);
    if (!ch) return;

    if (!isAllSelected) {
      if (!selectedTagChannels.some(s => s.hash === ch.hash && s.platform === ch.platform)) {
        selectedTagChannels.push(ch);
      }
      item.classList.add('selected');
    } else {
      const idx2 = selectedTagChannels.findIndex(s => s.hash === ch.hash && s.platform === ch.platform);
      if (idx2 > -1) selectedTagChannels.splice(idx2, 1);
      item.classList.remove('selected');
    }
  });
}

async function confirmAddTagChannels() {
  closeTagNoticeModal();

  for (const ch of selectedTagChannels) {
    if (!channels.some(c => c.platform === ch.platform && c.hash === ch.hash)) {
      channels.push(ch);
      displayChannels.push(ch);
      channelAddOrder.push(ch.hash);
      if (!mainChannel) mainChannel = displayChannels[0].hash;
      if (!activeChatChannel) activeChatChannel = displayChannels[0].hash;

      saveChannelsToStorage();
      renderAll();
    }
  }

  channelInput.value = '';
}

function openPresetModal() {
  if (channels.length === 0) {
    alert('저장할 채널이 없습니다.');
    return;
  }

  let modal = document.getElementById('preset-modal');

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'preset-modal';
    modal.className = 'preset-modal-backdrop';
    modal.innerHTML = `
      <div class="preset-modal-content">
        <h3>프리셋 저장</h3>
        <div class="modal-field">
          <label>프리셋 이름</label>
          <input type="text" id="preset-name-input" placeholder="예) 종합게임 스트리머" />
        </div>
        <div class="modal-field">
          <label>프리셋 색상</label>
          <input type="color" id="preset-color-input" value="#FFFFFF" />
        </div>
        <div class="modal-actions">
          <button id="preset-cancel-btn">취소</button>
          <button id="preset-save-confirm-btn" class="primary">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('preset-cancel-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });

    document.getElementById('preset-save-confirm-btn').addEventListener('click', confirmSavePreset);
  }

  document.getElementById('preset-name-input').value = '';
  document.getElementById('preset-color-input').value = '#FFC800';
  modal.classList.add('active');
  document.getElementById('preset-name-input').focus();
}

function confirmSavePreset() {
  const nameInput = document.getElementById('preset-name-input');
  const colorInput = document.getElementById('preset-color-input');
  const name = nameInput.value.trim();
  const color = colorInput.value || '#ffffff';

  if (!name) {
    alert('프리셋 이름을 입력해주세요.');
    return;
  }

  const newPreset = {
    id: Date.now(),
    name: name,
    color: color,
    channels: [...channels]
  };

  presets.push(newPreset);
  savePresetsToStorage();
  renderPresets();

  document.getElementById('preset-modal').classList.remove('active');
}

function getContrastTextColor(hexColor) {
  let hex = hexColor.replace('#', '');

  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }

  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

function renderPresets() {
  if (!presetContainer) return;

  presetContainer.innerHTML = '';

  presets.forEach(preset => {
    const item = document.createElement('div');
    item.className = 'preset-item';
    
    const bgColor = preset.color || '#ffffff';
    const textColor = getContrastTextColor(bgColor);

    item.style.backgroundColor = bgColor;
    item.style.color = textColor;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'preset-name';
    nameSpan.textContent = preset.name;
    nameSpan.addEventListener('click', () => loadPreset(preset.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'preset-delete-btn';
    deleteBtn.innerHTML = '✕';
    deleteBtn.style.color = textColor;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePreset(preset.id);
    });

    item.appendChild(nameSpan);
    item.appendChild(deleteBtn);
    presetContainer.appendChild(item);
  });
}

async function loadPreset(presetId) {
  const target = presets.find(p => p.id === presetId);
  if (!target) return;

  const presetChannels = target.channels || [];
  if (presetChannels.length === 0) return;
  videoWrapperMap.forEach((wrapper) => {
    const iframe = wrapper.querySelector('iframe');
    if (iframe) iframe.src = 'about:blank';
    wrapper.remove();
  });
  videoWrapperMap.clear();
  videoGrid.innerHTML = '';
  channels = [...presetChannels];
  displayChannels = [...presetChannels];
  channelAddOrder = presetChannels.map(c => c.hash);
  mainChannel = displayChannels[0].hash;
  activeChatChannel = displayChannels[0].hash;
  saveChannelsToStorage();
  renderAll();
  await new Promise(resolve => setTimeout(resolve, 100));
}

function deletePreset(presetId) {
  presets = presets.filter(p => p.id !== presetId);
  savePresetsToStorage();
  renderPresets();
}

function clearAllPresets() {
  if (presets.length === 0) return;
  if (confirm('저장된 모든 프리셋을 삭제하시겠습니까?')) {
    presets = [];
    savePresetsToStorage();
    renderPresets();
  }
}

function toggleChat() {
  chatVisible = !chatVisible;
  chatSidebar?.classList.toggle('active', chatVisible);
  chatToggleBtn?.classList.toggle('active', chatVisible);
  saveChatVisibleToStorage();
  renderVideo();

  if (!chatVisible) {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    window.focus();
    if (document.body && typeof document.body.focus === 'function') {
      document.body.focus();
    }
  }
}

function saveChatVisibleToStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ my_chat_visible: chatVisible });
  } else {
    localStorage.setItem('my_chat_visible', chatVisible ? '1' : '0');
  }
}

let isMouseOverChatFrame = false;
const chatFrameContainerForShortcut = document.getElementById('chat-frame-container');
if (chatFrameContainerForShortcut) {
  chatFrameContainerForShortcut.addEventListener('mouseenter', () => { isMouseOverChatFrame = true; });
  chatFrameContainerForShortcut.addEventListener('mouseleave', () => { isMouseOverChatFrame = false; });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isMouseOverChatFrame) return;

  const active = document.activeElement;
  const isTyping = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable
  );
  if (isTyping) return;

  toggleChat();
});

const channelInputWrapper = document.getElementById('channel-input-wrapper');
const inputsContainer = document.querySelector('.inputs');
const addChannelBtnRef = document.getElementById('add-btn');

function openQuickSearch() {
  if (!channelInputWrapper) return;
  channelInputWrapper.classList.add('quick-search-active');
  channelInput && channelInput.focus();
}

function closeQuickSearch() {
  if (!channelInputWrapper) return;
  if (!channelInputWrapper.classList.contains('quick-search-active')) return;
  channelInputWrapper.classList.remove('quick-search-active');
  channelInput && channelInput.blur();
}

document.addEventListener('mousedown', (e) => {
  if (!channelInputWrapper || !channelInputWrapper.classList.contains('quick-search-active')) return;
  if (e.target.closest('#channel-input-wrapper')) return;
  closeQuickSearch();
});

const fsModeToolbarRef = document.getElementById('fs-mode-toolbar');

function openFsQuickSearch() {
  const appContainer = document.getElementById('app-container');
  if (!appContainer || !fsModeToolbarRef || !channelInputWrapper) return;
  if (!chatVisible) {
    toggleChat();
  }
  fsModeToolbarRef.appendChild(channelInputWrapper);
  appContainer.classList.add('fs-search-active');
  channelInput && channelInput.focus();
}

function closeFsQuickSearch() {
  const appContainer = document.getElementById('app-container');
  if (!appContainer || !appContainer.classList.contains('fs-search-active')) return;
  appContainer.classList.remove('fs-search-active');
  if (inputsContainer && addChannelBtnRef) {
    inputsContainer.insertBefore(channelInputWrapper, addChannelBtnRef);
  }
  channelInput && channelInput.blur();
  hideAutocomplete && hideAutocomplete();
}

document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const isTyping = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable
  );

  if (e.key === 'Escape' || e.key === 'Esc') {
    const appContainerForEsc = document.getElementById('app-container');
    const isQuickSearchActive = channelInputWrapper && channelInputWrapper.classList.contains('quick-search-active');
    const isFsSearchActive = appContainerForEsc && appContainerForEsc.classList.contains('fs-search-active');

    if (isQuickSearchActive || isFsSearchActive) {
      if (isQuickSearchActive) closeQuickSearch();
      if (isFsSearchActive) closeFsQuickSearch();
    } else if (chatVisible) {
      toggleChat();
    }
    return;
  }

  if (e.key === '/') {
    if (isTyping) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const appContainer = document.getElementById('app-container');
    if (appContainer && appContainer.classList.contains('fs-mode')) {
      openFsQuickSearch();
    } else {
      openQuickSearch();
    }
    return;
  }

  if (isTyping) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'z' || e.key === 'Z') {
    switchLayout('grid');
  } else if (e.key === 'x' || e.key === 'X') {
    switchLayout('main_sub');
  } else if (e.key === 'v' || e.key === 'V') {
    openSettingModal();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp') return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

  const active = document.activeElement;
  const isChannelInputFocused = active === channelInput;

  if (isChannelInputFocused) {
    if (e.key === 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();

    const platformTabOrder = ['all', ...Object.keys(PLATFORM_META).filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p])];
    const curIdx = platformTabOrder.indexOf(currentSearchPlatformTab);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const nextIdx = ((curIdx === -1 ? 0 : curIdx) + dir + platformTabOrder.length) % platformTabOrder.length;
    currentSearchPlatformTab = platformTabOrder[nextIdx];
    saveSearchPlatformTab();
    if (currentSearchKeyword) fetchAutocomplete(currentSearchKeyword);
    return;
  }

  const isTyping = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable
  );
  if (isTyping) return;
  if (!chatVisible) return;
  if (!displayChannels || displayChannels.length === 0) return;

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    e.stopPropagation();

    const idx = displayChannels.findIndex(c => c.hash === activeChatChannel);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const baseIdx = idx === -1 ? 0 : idx;
    const nextIdx = (baseIdx + dir + displayChannels.length) % displayChannels.length;
    setChatChannel(displayChannels[nextIdx].hash);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();

    const currentChannel = getChannelObjByHash(activeChatChannel);
    if (!currentChannel) return;
    const btnEl = chatTabs ? chatTabs.querySelector(`.chat-tab[data-hash="${activeChatChannel}"] .chat-tab-refresh-btn`) : null;
    refreshChatTab(activeChatChannel, currentChannel.platform, btnEl);
  }
});

function parseDirectInput(rawToken) {
  const str = (rawToken || '').trim();
  if (!str) return null;

  let chzzkCandidate = str;
  if (chzzkCandidate.includes('chzzk.naver.com/')) {
    const parts = chzzkCandidate.split('/');
    chzzkCandidate = parts[parts.length - 1].split('?')[0];
  }
  if (/^[a-f0-9]{32}$/i.test(chzzkCandidate)) {
    return { platform: 'chzzk', id: chzzkCandidate };
  }

  if (str.includes('play.sooplive.com/') || str.includes('sooplive.co.kr/') || str.includes('bj.afreecatv.com/')) {
    const parts = str.split('?')[0].split('/').filter(Boolean);
    const domainIdx = parts.findIndex(p => p.includes('sooplive.com') || p.includes('sooplive.co.kr') || p.includes('afreecatv.com'));
    if (domainIdx !== -1 && parts[domainIdx + 1]) {
      const id = parts[domainIdx + 1];
      const maybeBroadNo = parts[domainIdx + 2];
      const broadNo = /^\d+$/.test(maybeBroadNo || '') ? maybeBroadNo : undefined;
      return { platform: 'soop', id, broadNo };
    }
    const id = parts[parts.length - 1];
    if (id) return { platform: 'soop', id };
  }

  const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;
  const YT_HANDLE_RE = /^@[a-zA-Z0-9._-]{3,30}$/;
  const YT_URL_VIDEO_ID_RE = /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/;

  if (YT_HANDLE_RE.test(str)) {
    return { platform: 'youtube', id: str };
  }
  if (str.includes('youtube.com/') || str.includes('youtu.be/')) {
    const videoIdMatch = YT_URL_VIDEO_ID_RE.exec(str);
    if (videoIdMatch) return { platform: 'youtube', id: videoIdMatch[1] };

    const parts = str.split('?')[0].split('/').filter(Boolean);
    const domainIdx = parts.findIndex(p => p.includes('youtube.com'));
    if (domainIdx !== -1 && parts[domainIdx + 1]) {
      let next = parts[domainIdx + 1];
      if (next === 'channel' && parts[domainIdx + 2]) next = parts[domainIdx + 2];
      if (YT_CHANNEL_ID_RE.test(next) || next.startsWith('@')) {
        return { platform: 'youtube', id: next };
      }
    }
  }

  return null;
}

function isHashFormat(str) {
  return !!parseDirectInput(str);
}

function getLastKeywordInfo(value) {
  const parts = value.split(',').map(p => p.trim());
  const lastPart = parts.pop() || '';
  const validPreviousParts = parts.filter(p => p.length > 0);
  const prefix = validPreviousParts.length > 0 ? validPreviousParts.join(', ') + ', ' : '';
  return { prefix, lastKeyword: lastPart };
}

let currentFocusIndex = 1;

function handleInputChange() {
  if (isKeyNavigating) return;

  const { lastKeyword } = getLastKeywordInfo(channelInput.value);

  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  if (!lastKeyword || isHashFormat(lastKeyword)) {
    hideAutocomplete();
    return;
  }

  searchDebounceTimer = setTimeout(() => {
    fetchAutocomplete(lastKeyword);
  }, 150);
}

let isKeyNavigating = false;

if (channelInput) {
  channelInput.addEventListener('input', () => {
    if (!isKeyNavigating) {
      handleInputChange();
    }
    isKeyNavigating = false;
  });

  channelInput.addEventListener('keydown', (e) => {
    if (e.isComposing && e.key !== 'Enter') return;

    if (e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      hideAutocomplete();
      openList();
      return;
    }

    const items = autocompleteList ? autocompleteList.querySelectorAll('.autocomplete-item') : [];
    const isListActive = autocompleteList && autocompleteList.classList.contains('active') && items.length > 0;

    if (isListActive) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        
        if (typeof searchDebounceTimer !== 'undefined' && searchDebounceTimer) {
          clearTimeout(searchDebounceTimer);
        }
        
        if (e.isComposing) {
          channelInput.blur();
          channelInput.focus();
        }

        isMouseMoving = false;
        isKeyNavigating = true;

        if (e.key === 'ArrowDown') {
          if (currentFocusIndex < 0) {
            currentFocusIndex = 0; 
          } else if (currentFocusIndex < items.length - 1) {
            currentFocusIndex++;
          }
        } else if (e.key === 'ArrowUp') {
          if (currentFocusIndex > 0) {
            currentFocusIndex--;
          }
        }

        updateFocus(items);
        return;
      } 
      
      if (e.key === 'Enter') {
        e.preventDefault();
        if (currentFocusIndex > -1 && items[currentFocusIndex]) {
          const focusedEl = items[currentFocusIndex];
          if (focusedEl.dataset.ignoreTrigger === 'true') {
            return;
          }
          const selectedText = focusedEl.querySelector('.keyword-text')?.textContent || '';
          const selectedPlatform = focusedEl.getAttribute('data-platform') || 'chzzk';
          selectAutocompleteItem({ platform: selectedPlatform, text: selectedText });
          addChannelFromInput();
        } else {
          hideAutocomplete();
          addChannelFromInput();
        }
        return;
      }
      
      if (e.key === 'Escape') {
        hideAutocomplete();
        return;
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      hideAutocomplete();
      addChannelFromInput();
      return;
    }
  });
}

const originalShowAutocomplete = showAutocomplete;
showAutocomplete = function(items, searchKeyword) {
  console.log('🚨 [LOG FUNC] showAutocomplete() 호출됨! -> currentFocusIndex가 -1로 초기화됩니다.');
  originalShowAutocomplete(items, searchKeyword);
};

const originalHideAutocomplete = hideAutocomplete;
hideAutocomplete = function() {
  console.log('🚨 [LOG FUNC] hideAutocomplete() 호출됨!');
  originalHideAutocomplete();
};

const originalUpdateFocus = updateFocus;
updateFocus = function(items) {
  console.log(`🎨 [LOG UI] updateFocus() 실행 -> targetIndex: ${currentFocusIndex}`);
  originalUpdateFocus(items);
};

async function fetchAutocompleteItems(keyword) {
  const enabledPlatforms = Object.keys(PLATFORM_META)
    .filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p]);

  if (enabledPlatforms.includes(currentSearchPlatformTab)) {
    return await PlatformAdapters[currentSearchPlatformTab].searchAutocomplete(keyword, 10);
  }

  const resultsByPlatform = await Promise.all(
    enabledPlatforms.map(p => PlatformAdapters[p].searchAutocomplete(keyword, 10))
  );

  return mergeAutocompleteByRelevance(keyword, resultsByPlatform);
}

async function fetchAutocomplete(keyword) {
  currentSearchKeyword = keyword;

  try {
    const items = await fetchAutocompleteItems(keyword);

    const { lastKeyword: latestKeyword } = getLastKeywordInfo(channelInput.value);
    if (keyword !== latestKeyword || keyword !== currentSearchKeyword) {
      return;
    }

    showAutocomplete(items, keyword);
  } catch (err) {
    console.error('연관 검색어 조회 실패:', err);
    showAutocomplete([], keyword);
  }
}

function updateFocus(items) {
  items.forEach((item, idx) => {
    if (idx === currentFocusIndex) {
      item.classList.add('focused'); 
      item.scrollIntoView({ block: 'nearest' }); 
    } else {
      item.classList.remove('focused');
    }
  });
}

async function checkChzzkLiveByChannelId(channelId) {
  if (!channelId) return false;
  try {
    const res = await apiFetch(`https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`);
    if (!res.ok) return false;

    const data = await res.json();
    return !!(data && data.content && data.content.status === 'OPEN');
  } catch (e) {
    return false;
  }
}

let autocompletePlatformHints = new Map();

function positionAutocompleteList() {
  if (!channelInput || !autocompleteList) return;
  const rect = channelInput.getBoundingClientRect();
  autocompleteList.style.top = `${rect.bottom + 6}px`;
  autocompleteList.style.left = `${rect.left}px`;
  autocompleteList.style.width = `${rect.width}px`;
}

window.addEventListener('resize', () => {
  if (autocompleteList && autocompleteList.classList.contains('active')) {
    positionAutocompleteList();
  }
});

window.addEventListener('scroll', () => {
  if (autocompleteList && autocompleteList.classList.contains('active')) {
    positionAutocompleteList();
  }
}, true);

if (autocompleteList) {
  autocompleteList.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      autocompleteList.scrollTop += e.deltaY;
    }
  }, { passive: false });
}

function showAutocomplete(items, searchKeyword) {
  autocompleteList.innerHTML = '';
  currentFocusIndex = -1;
  positionAutocompleteList();

  autocompleteRenderToken++;
  const tabsBar = buildPlatformTabsBar(currentSearchPlatformTab, (tab) => {
    currentSearchPlatformTab = tab;
    saveSearchPlatformTab();
    if (currentSearchKeyword) fetchAutocomplete(currentSearchKeyword);
  });
  autocompleteList.appendChild(tabsBar);

  if (!items || items.length === 0) {
    autocompleteList.classList.add('active');
    return;
  }

  items.forEach((item, index) => {
    const text = (item && item.text ? String(item.text) : '').trim();
    if (!text) return;

    const li = document.createElement('li');
    li.className = 'autocomplete-item';
    li.setAttribute('data-platform', item.platform);
    li.style.setProperty('--item-color', getPlatformColor(item.platform));

    const svgIcon = `
      <svg class="search-icon" viewBox="0 0 24 24" style="width: 16px; height: 16px; flex-shrink: 0;">
        <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
      </svg>
    `;

    const textSpan = document.createElement('span');
    textSpan.className = 'keyword-text';
    textSpan.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;';

    if (searchKeyword && text.toLowerCase().includes(searchKeyword.toLowerCase())) {
      const idx = text.toLowerCase().indexOf(searchKeyword.toLowerCase());
      const before = text.substring(0, idx);
      const match = text.substring(idx, idx + searchKeyword.length);
      const after = text.substring(idx + searchKeyword.length);

      textSpan.innerHTML = `${before}<span class="highlight">${match}</span>${after}`;
    } else {
      textSpan.textContent = text;
    }

    li.dataset.ignoreTrigger = 'false';

    li.innerHTML = svgIcon;
    li.appendChild(textSpan);

    li.addEventListener('mouseenter', () => {
      currentFocusIndex = index;
      updateFocus(autocompleteList.querySelectorAll('.autocomplete-item'));
    });

    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectAutocompleteItem(item);
    });

    autocompleteList.appendChild(li);
  });

  autocompleteList.classList.add('active');
}

function hideAutocomplete() {
  autocompleteRenderToken++;  if (autocompleteList) {
    autocompleteList.classList.remove('active');
    autocompleteList.innerHTML = '';
  }
  currentFocusIndex = -1;
}

function selectAutocompleteItem(item) {
  const obj = typeof item === 'string' ? { platform: 'chzzk', text: item } : item;
  if (obj.ignoreTrigger) return;

  const { prefix } = getLastKeywordInfo(channelInput.value);
  channelInput.value = prefix + obj.text + ', ';
  if (obj.platform !== 'youtube') {
    autocompletePlatformHints.set(obj.text.trim(), obj.platform);
  }
  hideAutocomplete();
  channelInput.focus();
}

let liveConfirmToken = 0;
let liveConfirmSections = [];

function ensureLiveConfirmModal() {
  let modal = document.getElementById('live-confirm-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'live-confirm-modal';
  modal.className = 'tag-notice-backdrop';
  modal.innerHTML = `
    <div class="tag-notice-window">
      <div class="tag-notice-header">
        <h3 id="live-confirm-title">${t('modal.searchResultTitle', '검색 결과')}</h3>
        <button class="tag-notice-close" id="live-confirm-close-btn">✕</button>
      </div>
      <div class="tag-notice-body" id="live-confirm-body"></div>
      <div class="tag-notice-footer" style="justify-content:flex-end;">
        <button id="live-confirm-apply-btn">${t('modal.addSelected', '선택한 채널 추가')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('live-confirm-close-btn').addEventListener('click', closeLiveConfirmModal);
  document.getElementById('live-confirm-apply-btn').addEventListener('click', applyLiveConfirmSelection);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeLiveConfirmModal();
  });
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('active')) return;
    if (e.key === 'Escape' || e.key === 'Esc') closeLiveConfirmModal();
  });

  return modal;
}

function closeLiveConfirmModal() {
  liveConfirmToken++;
  const modal = document.getElementById('live-confirm-modal');
  if (modal) modal.classList.remove('active');
  liveConfirmSections = [];
}

function openLiveConfirmModal(keywords) {
  const list = (keywords || []).map(k => String(k || '').trim()).filter(Boolean);
  if (list.length === 0) return;

  hideAutocomplete();

  const modal = ensureLiveConfirmModal();
  const titleEl = document.getElementById('live-confirm-title');
  const myToken = ++liveConfirmToken;
  currentLiveConfirmPlatformTab = 'all';
  currentLiveConfirmKeywordTab = 'all';

  titleEl.textContent = `${list.join(', ')} - ${t('modal.searchResultTitle', '검색 결과')}`;
  modal.classList.add('active');

  liveConfirmSections = list.map(keyword => ({ keyword, groups: [], selected: new Set() }));
  renderLiveConfirmSections();

  liveConfirmSections.forEach((section, sectionIdx) => {
    loadKeywordCandidatesProgressively(sectionIdx, section.keyword, myToken);
  });
}

function loadKeywordCandidatesProgressively(sectionIdx, keyword, myToken) {
  const isHandleMode = keyword.startsWith('@');
  const enabledPlatforms = Object.keys(PLATFORM_META).filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p]);

  const platformFetchers = {
    youtube: () => isHandleMode
      ? PlatformAdapters.youtube._resolveHandleCandidatesForStageB(keyword)
      : PlatformAdapters.youtube._resolveKeywordCandidatesForStageB(keyword),
    chzzk: () => fetchChzzkLiveCandidatesByName(keyword),
    soop: () => fetchSoopLiveCandidatesByName(keyword)
  };

  const platformsToQuery = isHandleMode ? ['youtube'] : enabledPlatforms.filter(p => platformFetchers[p]);

  const targetSection = liveConfirmSections[sectionIdx];
  if (targetSection) {
    targetSection.expectedCount = platformsToQuery.length;
    targetSection.allPlatforms = platformsToQuery;
  }

  platformsToQuery.forEach(platform => {
    platformFetchers[platform]()
      .catch(err => {
        console.error(`'${keyword}' ${platform} 라이브 후보 조회 실패:`, err);
        return [];
      })
      .then(candidates => {
        if (liveConfirmToken !== myToken) return;
        const section = liveConfirmSections[sectionIdx];
        if (!section) return;
        section.groups.push({ platform, candidates: candidates || [] });
        renderLiveConfirmSections();
      });
  });
}

async function fetchChzzkLiveCandidatesByName(keyword) {
  const res = await apiFetch(`https://api.chzzk.naver.com/service/v1/search/channels?keyword=${encodeURIComponent(keyword)}&offset=0&size=20&withFirstChannelContent=true`);
  if (!res.ok) return [];
  const data = await res.json();
  const list = data.content && data.content.data ? data.content.data : [];

  const checked = await Promise.all(list.map(async (entry) => {
    const c = entry.channel;
    if (!c || !c.channelId || !c.channelName) return null;
    try {
      const detailRes = await apiFetch(`https://api.chzzk.naver.com/service/v2/channels/${c.channelId}/live-detail`);
      if (!detailRes.ok) return null;
      const detail = await detailRes.json();
      const content = detail && detail.content;
      if (!content || content.status !== 'OPEN') return null;
      return {
        platform: 'chzzk',
        hash: c.channelId,
        name: c.channelName,
        title: content.liveTitle || '',
        thumbnail: content.liveImageUrl ? content.liveImageUrl.replace('{type}', '270') : '',
        viewersText: typeof content.concurrentUserCount === 'number' ? content.concurrentUserCount.toLocaleString() : ''
      };
    } catch (e) { return null; }
  }));

  return checked.filter(Boolean);
}

async function fetchSoopLiveCandidatesByName(keyword) {
  const list = await PlatformAdapters.soop._liveSearch(keyword, { count: 20 });
  const kw = String(keyword || '').trim().toLowerCase();
  return list.map(raw => {
    const ch = PlatformAdapters.soop._toChannelData(raw);
    if (!ch) return null;
    if (kw && !String(ch.name || '').toLowerCase().includes(kw)) return null;
    const viewers = raw.total_view_cnt ?? raw.view_cnt ?? raw.m_current_view_cnt;
    return {
      ...ch,
      title: raw.broad_title || raw.title || '',
      thumbnail: raw.broad_img || raw.thumbnail || '',
      viewersText: viewers != null ? Number(viewers).toLocaleString() : ''
    };
  }).filter(Boolean);
}

function createLiveResultRow(ch, isSelected, onToggle) {
  const row = document.createElement('div');
  row.className = 'live-confirm-row selectable-channel-item';
  row.style.setProperty('--item-color', getPlatformColor(ch.platform));
  row.setAttribute('data-hash', ch.hash);
  row.setAttribute('data-platform', ch.platform);
  if (isSelected) row.classList.add('selected');

  if (ch.thumbnail) {
    const img = document.createElement('img');
    img.src = ch.thumbnail;
    img.className = 'live-confirm-thumb';
    row.appendChild(img);
  }

  const info = document.createElement('div');
  info.className = 'live-confirm-info';

  const isKnownLive = ch.platform !== 'youtube' || !!ch.videoId;

  const nameEl = document.createElement('div');
  nameEl.className = 'live-confirm-name';
  nameEl.textContent = ch.name;
  info.appendChild(nameEl);

  const titleEl = document.createElement('div');
  titleEl.className = 'live-confirm-title';
  const titleText = ch.title || ch.name;
  titleEl.textContent = titleText;
  titleEl.title = titleText;
  info.appendChild(titleEl);

  const sub = document.createElement('div');
  sub.className = 'live-confirm-sub';
  if (isKnownLive) {
    sub.textContent = ch.viewersText ? `● LIVE · ${ch.viewersText}` : '● LIVE';
    sub.classList.add('is-live');
  } else {
    sub.textContent = t('following.empty', '라이브 중인 채널이 없습니다.');
    sub.classList.add('is-offline');
  }
  info.appendChild(sub);

  row.appendChild(info);
  row.addEventListener('click', () => onToggle(row));

  return row;
}

let currentLiveConfirmPlatformTab = 'all';
let currentLiveConfirmKeywordTab = 'all';

function buildKeywordTabsBar(activeTab, onSelect) {
  const bar = document.createElement('div');
  bar.className = 'search-platform-tabs search-keyword-tabs';
  const tabs = [
    { key: 'all', label: t('platformTabs.all', '전체') },
    ...liveConfirmSections.map(section => ({ key: section.keyword, label: section.keyword }))
  ];
  tabs.forEach(tabInfo => {
    const el = document.createElement('div');
    el.className = 'search-platform-tab' + (tabInfo.key === activeTab ? ' active' : '');
    el.textContent = tabInfo.label;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onSelect(tabInfo.key);
    });
    bar.appendChild(el);
  });
  return bar;
}

function renderLiveConfirmSections() {
  const bodyEl = document.getElementById('live-confirm-body');
  bodyEl.innerHTML = '';

  const tabsBar = buildPlatformTabsBar(currentLiveConfirmPlatformTab, (tab) => {
    currentLiveConfirmPlatformTab = tab;
    renderLiveConfirmSections();
  });
  bodyEl.appendChild(tabsBar);

  if (liveConfirmSections.length > 1) {
    const keywordTabsBar = buildKeywordTabsBar(currentLiveConfirmKeywordTab, (tab) => {
      currentLiveConfirmKeywordTab = tab;
      renderLiveConfirmSections();
    });
    bodyEl.appendChild(keywordTabsBar);
  }

  const sectionsToRender = liveConfirmSections.filter(section => (
    currentLiveConfirmKeywordTab === 'all' || section.keyword === currentLiveConfirmKeywordTab
  ));

  sectionsToRender.forEach(section => {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'live-confirm-section';

    if (currentLiveConfirmKeywordTab === 'all' && liveConfirmSections.length > 1) {
      const heading = document.createElement('div');
      heading.className = 'live-confirm-section-heading';
      heading.textContent = section.keyword;
      sectionEl.appendChild(heading);
    }

    const allPlatforms = section.allPlatforms || [];
    const allResponded = section.expectedCount != null && section.groups.length >= section.expectedCount;

    const visibleCandidates = [];
    section.groups.forEach(group => {
      if (currentLiveConfirmPlatformTab !== 'all' && group.platform !== currentLiveConfirmPlatformTab) return;
      group.candidates.forEach(ch => visibleCandidates.push({ platform: group.platform, ch }));
    });

    if (allPlatforms.length === 0) {
      // 아직 어떤 플랫폼에 조회를 시작하지도 않은 초기 순간
      const loading = document.createElement('div');
      loading.className = 'tag-notice-empty';
      loading.textContent = t('modal.liveConfirmLoading', '라이브 여부를 확인하는 중...');
      sectionEl.appendChild(loading);
    } else if (visibleCandidates.length === 0 && allResponded) {
      // 모든 플랫폼이 응답을 마쳤는데 (현재 탭 기준) 결과가 없는 경우
      const empty = document.createElement('div');
      empty.className = 'tag-notice-empty';
      empty.textContent = t('following.empty', '라이브 중인 채널이 없습니다.');
      sectionEl.appendChild(empty);
    } else {
      const listWrap = document.createElement('div');
      listWrap.className = 'live-confirm-rows';

      visibleCandidates.forEach(({ platform, ch }) => {
        const uid = `${platform}:${ch.hash}`;
        const row = createLiveResultRow(ch, section.selected.has(uid), () => {
          if (section.selected.has(uid)) {
            section.selected.delete(uid);
            row.classList.remove('selected');
          } else {
            section.selected.add(uid);
            row.classList.add('selected');
          }
        });
        listWrap.appendChild(row);
      });

      sectionEl.appendChild(listWrap);

      if (!allResponded) {
        const loadingMore = document.createElement('div');
        loadingMore.className = 'live-confirm-platform-loading';
        loadingMore.textContent = t('modal.liveConfirmLoading', '라이브 여부를 확인하는 중...');
        sectionEl.appendChild(loadingMore);
      }
    }

    bodyEl.appendChild(sectionEl);
  });
}

function applyLiveConfirmSelection() {
  const selectedChannels = [];
  liveConfirmSections.forEach(section => {
    section.groups.forEach(group => {
      group.candidates.forEach(ch => {
        const uid = `${group.platform}:${ch.hash}`;
        if (section.selected.has(uid)) selectedChannels.push(ch);
      });
    });
  });

  closeLiveConfirmModal();
  if (selectedChannels.length > 0) commitChannels(selectedChannels);
}

function commitChannels(channelDataList) {
  let hasAdded = false;

  channelDataList.forEach(ch => {
    if (!ch || !ch.hash) return;
    if (channels.some(c => c.platform === ch.platform && c.hash === ch.hash)) return;

    const channelData = { platform: ch.platform, hash: ch.hash, name: ch.name };
    if (ch.broadNo) channelData.broadNo = ch.broadNo;
    if (ch.videoId) channelData.videoId = ch.videoId;
    if (ch.platform === 'youtube') {
      console.log(`[CHEESE EYES][YT-DEBUG] commitChannels: ${ch.name}(${ch.hash}) videoId=${ch.videoId || '(없음)'}`);
    }

    channels.push(channelData);
    displayChannels.push(channelData);
    channelAddOrder.push(channelData.hash);
    hasAdded = true;
  });

  if (!hasAdded) return;

  if (!mainChannel) mainChannel = displayChannels[0].hash;
  if (!activeChatChannel) activeChatChannel = displayChannels[0].hash;

  saveChannelsToStorage();
  renderAll();
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prevDiag
        : Math.min(prevDiag, dp[j], dp[j - 1]) + 1;
      prevDiag = temp;
    }
  }
  return dp[n];
}

function computeRelevanceScore(query, candidateName) {
  if (!candidateName) return -1;
  const q = String(query).trim().toLowerCase();
  const c = String(candidateName).trim().toLowerCase();
  if (!q || !c) return -1;

  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) {
    const lenDiff = Math.abs(c.length - q.length);
    return Math.max(0.7, 0.95 - lenDiff * 0.02);
  }

  const dist = levenshteinDistance(q, c);
  const maxLen = Math.max(q.length, c.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

function mergeTagChannelsByRelevance(query, listsByPlatform) {
  const maxLen = Math.max(0, ...listsByPlatform.map(list => list.length));
  const merged = [];

  for (let i = 0; i < maxLen; i++) {
    const candidates = listsByPlatform
      .map(list => list[i])
      .filter(Boolean)
      .sort((a, b) => computeRelevanceScore(query, b.name) - computeRelevanceScore(query, a.name));

    merged.push(...candidates);
  }

  return merged;
}

function mergeAutocompleteByRelevance(keyword, listsByPlatform) {
  const maxLen = Math.max(0, ...listsByPlatform.map(list => list.length));
  const merged = [];

  for (let i = 0; i < maxLen; i++) {
    const candidates = listsByPlatform
      .map(list => list[i])
      .filter(Boolean)
      .sort((a, b) => computeRelevanceScore(keyword, b.text) - computeRelevanceScore(keyword, a.text));

    merged.push(...candidates);
  }

  return merged;
}

async function addChannelFromInput() {
  const value = channelInput.value.trim();
  if (!value) {
    if (channelInput) channelInput.focus();
    return;
  }

  hideAutocomplete();
  const rawTokens = value.split(',').map(t => t.trim()).filter(t => t.length > 0);

  const directChannels = [];
  const pendingKeywords = [];

  for (const token of rawTokens) {
    const direct = parseDirectInput(token);

    if (direct) {
      let channelData = null;
      if (direct.platform === 'soop' && direct.broadNo) {
        channelData = { platform: 'soop', hash: direct.id, broadNo: direct.broadNo, name: direct.id };
      } else {
        channelData = await getAdapter(direct.platform).getChannelById(direct.id);
      }
      if (channelData && channelData.hash) directChannels.push(channelData);
      continue;
    }

    const hintPlatform = autocompletePlatformHints.get(token);
    let resolvedDirectly = false;

    if (hintPlatform) {
      try {
        const channelData = await getAdapter(hintPlatform).searchChannelByName(token);
        if (channelData && channelData.hash) {
          const isLive = channelData.platform === 'chzzk'
            ? await checkChzzkLiveByChannelId(channelData.hash)
            : true;
          if (isLive) {
            directChannels.push(channelData);
            resolvedDirectly = true;
          }
        }
      } catch (err) {
        console.error(`'${token}' 채널 확인 실패:`, err);
      }
    }

    if (!resolvedDirectly) pendingKeywords.push(token);
  }

  if (directChannels.length > 0) {
    commitChannels(directChannels);
  }

  channelInput.value = '';

  if (pendingKeywords.length > 0) {
    openLiveConfirmModal(pendingKeywords);
  }
}

function switchLayout(mode) {
  if (currentLayout === mode) return;

  currentLayout = mode;
  saveLayoutToStorage();
  document.getElementById('mode-grid')?.classList.toggle('active', mode === 'grid');
  document.getElementById('mode-main_sub')?.classList.toggle('active', mode === 'main_sub');
  renderVideo();
}

function swapChannels(hash1, hash2) {
  const paIdx1 = channels.findIndex(c => c.hash === hash1);
  const paIdx2 = channels.findIndex(c => c.hash === hash2);

  if (paIdx1 !== -1 && paIdx2 !== -1) {
    const tempPa = channels[paIdx1];
    channels[paIdx1] = channels[paIdx2];
    channels[paIdx2] = tempPa;
  }
  const daIdx1 = displayChannels.findIndex(c => c.hash === hash1);
  const daIdx2 = displayChannels.findIndex(c => c.hash === hash2);

  if (daIdx1 !== -1 && daIdx2 !== -1) {
    const tempDa = displayChannels[daIdx1];
    displayChannels[daIdx1] = displayChannels[daIdx2];
    displayChannels[daIdx2] = tempDa;
  }
  if (displayChannels.length > 0) {
    mainChannel = displayChannels[0].hash;
  }

  console.log(`🔄 [SWAP SUCCESS] da: ${daIdx1} ↔ ${daIdx2}, pa: ${paIdx1} ↔ ${paIdx2}`);

  saveChannelsToStorage();
  renderAll();
}

function setMainChannel(hash) {
  if (!hash || mainChannel === hash) return;
  const currentMainHash = mainChannel;
  
  const daIdx1 = displayChannels.findIndex(c => c.hash === currentMainHash);
  const daIdx2 = displayChannels.findIndex(c => c.hash === hash);
  if (daIdx1 !== -1 && daIdx2 !== -1) {
    const temp = displayChannels[daIdx1];
    displayChannels[daIdx1] = displayChannels[daIdx2];
    displayChannels[daIdx2] = temp;
  }
  const paIdx1 = channels.findIndex(c => c.hash === currentMainHash);
  const paIdx2 = channels.findIndex(c => c.hash === hash);

  if (paIdx1 !== -1 && paIdx2 !== -1) {
    const temp = channels[paIdx1];
    channels[paIdx1] = channels[paIdx2];
    channels[paIdx2] = temp;
  }
  mainChannel = displayChannels[0].hash;

  if (currentLayout === 'main_sub') {
    activeChatChannel = mainChannel;
    updateChatSession();
  }

  saveChannelsToStorage();
  renderAll(); 
}

function setChatChannel(hash) {
  if (!hash) return;
  activeChatChannel = hash;
  if (chatTabs) {
    const tabs = chatTabs.querySelectorAll('.chat-tab');
    tabs.forEach(tab => {
      if (tab.getAttribute('data-hash') === hash) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });
  }
  ensureChatIframeCreated(hash);
  syncChatVisibility();
}
let iframeLoadQueue = [];
let isProcessingQueue = false;
const QUEUE_CONFIG = {
  initialDelay: 0,     
  stepDelay: 50,       
  maxDelayCap: 2000,   
  maxRetries: 3        
};

function createIframeReadyPromise(iframe, hash, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let isResolved = false;

    try {
      const videoElem = iframe.contentDocument?.querySelector('video');
      if (videoElem) {
        if (videoElem.readyState >= 3) {
          videoElem.pause();
          return resolve({ iframe, hash, success: true });
        }
        const onReady = () => {
          videoElem.pause();
          cleanup();
          if (!isResolved) { isResolved = true; resolve({ iframe, hash, success: true }); }
        };
        videoElem.addEventListener('canplaythrough', onReady, { once: true });
        videoElem.addEventListener('canplay', onReady, { once: true });
      }
    } catch (e) {
    
    }
    const handleMessage = (event) => {
      if (!event.origin.includes('naver.com') && !event.origin.includes('chzzk')) return;

      const data = event.data;
      if (!data) return;

      const isReady = 
        data.type === 'PLAYER_READY' ||
        data.type === 'BUFFERING_END' ||
        data.type === 'PLAYBACK_STATE_CHANGED' ||
        data.cmd === 'ready' ||
        (typeof data === 'string' && (data.includes('ready') || data.includes('canplay')));

      if (isReady) {
        console.log(`🎯 [READY DETECTED] [${hash}] 치지직 플레이어 로딩 완료 신호 수신!`);
        iframe.contentWindow?.postMessage(JSON.stringify({ cmd: 'pause', type: 'command' }), '*');
        cleanup();
        if (!isResolved) { isResolved = true; resolve({ iframe, hash, success: true }); }
      }
    };

    const iframeLoadHandler = () => {
      setTimeout(() => {
        if (!isResolved) {
          console.log(`⚡ [FAST FALLBACK] [${hash}] Iframe 로드 후 안정화 완료 (조기 동기화)`);
          cleanup();
          isResolved = true;
          resolve({ iframe, hash, success: true });
        }
      }, 1500); 
    };

    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
      iframeLoadHandler();
    } else {
      iframe.addEventListener('load', iframeLoadHandler, { once: true });
    }

    const timer = setTimeout(() => {
      console.warn(`⏰ [READY TIMEOUT] [${hash}] 최종 시간 초과 (강제 포함)`);
      cleanup();
      if (!isResolved) { isResolved = true; resolve({ iframe, hash, success: false }); }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', handleMessage);
      iframe.removeEventListener('load', iframeLoadHandler);
    }

    window.addEventListener('message', handleMessage);
    iframe.contentWindow?.postMessage(JSON.stringify({ cmd: 'pause', type: 'command' }), '*');
  });
}

async function processIframeQueue() {
  if (isProcessingQueue || isReloadingAll) return;
  isProcessingQueue = true;

  console.log(`🚀 [QUEUE] processIframeQueue 실행 중... 남은 큐 개수: ${iframeLoadQueue.length}`);

  let currentDelay = QUEUE_CONFIG.initialDelay; 
  const loadingPromises = []; 

  try {
    while (iframeLoadQueue.length > 0) {
      const task = iframeLoadQueue.shift();
      if (!task || !task.iframe || !task.url) continue;

      const targetHash = task.hash || task.url.split('/').pop();
      const isStillExist = channels.some(c => c.hash === targetHash);
      if (!isStillExist) {
        console.warn(`🛑 [QUEUE SKIP] 이미 삭제된 채널입니다. (Skip): ${targetHash}`);
        continue;
      }

      console.log(`⏳ [QUEUE LOAD] Iframe 생성/URL 할당 -> 타겟 Hash: ${targetHash}`);
      const isSuccess = await loadIframeWithBackoff(task.iframe, task.url, targetHash);

      if (isSuccess) {
        loadingPromises.push(createIframeReadyPromise(task.iframe, targetHash, 10000));
      } else {
        console.error(`❌ [QUEUE FAIL] 최종 로드 실패: ${targetHash}`);
      }

      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay = Math.min(currentDelay + QUEUE_CONFIG.stepDelay, QUEUE_CONFIG.maxDelayCap);
    }

    if (loadingPromises.length > 0) {
      console.log(`⏳ [SYNC WAIT] 총 ${loadingPromises.length}개 채널의 버퍼링 완결을 비동기로 동시에 대기합니다...`);
      
      const results = await Promise.all(loadingPromises);
      const readyIframes = results.filter(res => res.iframe);
      const startTime = performance.now();
      const clockTime = new Date().toISOString().split('T')[1].slice(0, -1);
      
      console.log(`▶️ [ALL SYNC PLAY] [${clockTime}] 모든 채널 버퍼링 완전 완료! 총 ${readyIframes.length}개 비디오 동시 재생 실행`);
      
      unpauseAllIframesSimultaneously(readyIframes, startTime);
    }

  } catch (error) {
    console.error(`💥 [QUEUE ERROR] 큐 내부 예외 발생:`, error);
  } finally {
    isProcessingQueue = false;
    console.log(`✅ [QUEUE] 비디오 큐 로드 완료. 채팅 큐 시작...`);
    loadAllChatsSequential();
  }
}

function unpauseAllIframesSimultaneously(iframeList, baseTime) {
  const len = iframeList.length;
  if (len === 0) return;

  const targets = new Array(len);
  for (let i = 0; i < len; i++) {
    const item = iframeList[i];
    const iframe = item.iframe || item;
    targets[i] = {
      win: iframe.contentWindow,
      hash: item.hash || iframe.getAttribute('data-hash') || `채널 #${i + 1}`
    };
  }

  requestAnimationFrame(() => {
    const triggerStart = performance.now();
    const clockTime = new Date().toISOString().split('T')[1].slice(0, -1);

    for (let i = 0; i < len; i++) {
      const target = targets[i];
      if (!target || !target.win) continue;

      target.win.postMessage({ action: 'SYNC_PLAY', type: 'SET_VOLUME', value: 1 }, '*');
      target.win.postMessage({ type: 'PLAY' }, '*');

      const now = performance.now();
      const diffFromStart = (now - triggerStart).toFixed(3); 

      console.log(`🔊 [ALL PLAY TRIGGER] [${clockTime}] [${target.hash}] 트리거 완료 (+${diffFromStart}ms)`);
    }
  });
}

async function loadIframeWithBackoff(iframe, url, hash) {
  let attempt = 0;

  while (attempt <= QUEUE_CONFIG.maxRetries) {
    try {
      if (attempt > 0) {
        const backoffDelay = 100 * Math.pow(2, attempt);
        console.warn(`⚠️ [RETRY ${attempt}/${QUEUE_CONFIG.maxRetries}] ${hash} - ${backoffDelay}ms 후 재시도`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }

      iframe.src = url;
      return true;

    } catch (error) {
      console.error(`❌ [LOAD ERROR] (${attempt + 1}회차) ${hash}:`, error);
      attempt++;
    }
  }

  return false;
}
async function loadAllChatsSequential() {
  if (!displayChannels || displayChannels.length === 0) return;
  if (activeChatChannel) {
    ensureChatIframeCreated(activeChatChannel);
  }
  for (const item of displayChannels) {
    if (item.hash === activeChatChannel) continue;

    ensureChatIframeCreated(item.hash);
  }
}

function getOrCreateVideoWrapper(item) {
  if (videoWrapperMap.has(item.hash)) {
    return videoWrapperMap.get(item.hash);
  }

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-hash', item.hash);
  wrapper.setAttribute('data-platform', item.platform);
  wrapper.style.setProperty('--tab-color', getPlatformColor(item.platform));
  wrapper.style.setProperty('--tab-color-rgb', getPlatformColorRGB(item.platform));
  wrapper.style.setProperty('--card-bg', getCardBgColor(item.platform));

  const iframe = document.createElement('iframe');
  iframe.src = 'about:blank';
  iframe.setAttribute("allow", IFRAME_ALLOW);

  if (item.platform === 'soop') {
    iframe.name = isNaN(Number(item.hash)) ? item.hash : `#${item.hash}`;
  }

  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  
  iframe.addEventListener('load', () => {
  if (iframe.src !== 'about:blank' && iframe.contentWindow) {
      setTimeout(() => {
        iframe?.contentWindow.postMessage({ type: 'APPLY_WIDE_MODE' }, '*');
      }, 1000);
      if (item.platform === 'soop') {
        setTimeout(() => markSoopVideoReady(item.hash), 6000);
      }
    }
  });

  setInterval(() => {
    videoWrapperMap.forEach((wrapper, hash) => {
      if (hash !== mainChannel) {
        const iframe = wrapper.querySelector('iframe');
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'SEEK_TO_LIVE' }, '*'); 
        }
      }
    });
  }, 300000);

  wrapper.appendChild(iframe);

  const edgeSensor = document.createElement('div');
  edgeSensor.className = 'video-edge-sensor';
  wrapper.appendChild(edgeSensor);

  iframeLoadQueue.push({
    iframe: iframe,
    url: getAdapter(item.platform).getVideoEmbedUrl(item.hash),
    hash: item.hash
  });
  processIframeQueue();
  const isMain = (mainChannel === item.hash);
  const channelIndex = channels.findIndex(c => c.hash === item.hash && c.platform === item.platform);
  const channelNumber = channelIndex !== -1 ? channelIndex : 0;
  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  overlay.style.pointerEvents = 'none';
  overlay.innerHTML = `
    <div class="channel-badge-group">
      <div class="channel-number-badge">
        ${channelNumber}
      </div>
      <button type="button" class="channel-home-btn" title="채널 홈으로 이동">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="7" y1="17" x2="17" y2="7"></line>
          <polyline points="8 7 17 7 17 16"></polyline>
        </svg>
      </button>
    </div>
    <div class="video-actions">
      <button type="button" class="drag-handle-btn" title="드래그하여 위치 이동" draggable="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="9" cy="5" r="1.5" fill="currentColor"/><circle cx="15" cy="5" r="1.5" fill="currentColor"/>
          <circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/>
          <circle cx="9" cy="19" r="1.5" fill="currentColor"/><circle cx="15" cy="19" r="1.5" fill="currentColor"/>
        </svg>
      </button>
      <button type="button" class="remove-card-btn" title="채널 삭제">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  `;

  const removeBtn = overlay.querySelector('.remove-card-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentHash = wrapper.getAttribute('data-hash') || item.hash;
      removeChannel(currentHash);
    });
  }
  const dragHandle = overlay.querySelector('.drag-handle-btn');
  if (dragHandle) {
    dragHandle.addEventListener('dragstart', (e) => {
      const currentHash = wrapper.getAttribute('data-hash') || item.hash;
      e.dataTransfer.setData('text/plain', currentHash);
      e.dataTransfer.effectAllowed = 'move';
      wrapper.classList.add('dragging');
      document.body.classList.add('is-dragging-card');
    });

    dragHandle.addEventListener('dragend', () => {
      wrapper.classList.remove('dragging');
      document.body.classList.remove('is-dragging-card');
      document.querySelectorAll('.video-wrapper').forEach(w => w.classList.remove('drag-over'));
    });
  }

  const homeBtn = overlay.querySelector('.channel-home-btn');
  if (homeBtn) {
    homeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentHash = wrapper.getAttribute('data-hash') || item.hash;
      const platform = wrapper.getAttribute('data-platform') || item.platform;
      const adapter = getAdapter(platform);
      if (typeof adapter.getChannelHomeUrl === 'function') {
        window.open(adapter.getChannelHomeUrl(currentHash), '_blank');
      }
    });
  }

  wrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!wrapper.classList.contains('drag-over')) {
      wrapper.classList.add('drag-over');
    }
  });

  wrapper.addEventListener('dragleave', (e) => {
    if (!wrapper.contains(e.relatedTarget)) {
      wrapper.classList.remove('drag-over');
    }
  });

  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrapper.classList.remove('drag-over');

    const draggedHash = e.dataTransfer.getData('text/plain');
    const targetHash = wrapper.getAttribute('data-hash') || item.hash;

    if (draggedHash && targetHash && draggedHash !== targetHash) {
      swapChannels(draggedHash, targetHash);
    }
  });

  wrapper.appendChild(overlay);
  videoGrid.appendChild(wrapper);
  videoWrapperMap.set(item.hash, wrapper);
  return wrapper;
}

function calcBestFit(total, width, height, maxCols = Infinity) {
  let bestWidth = 0;
  let bestHeight = 0;
  if (total <= 0 || width <= 0 || height <= 0) return { bestWidth: 0, bestHeight: 0 };

  const colLimit = Math.min(total, maxCols);
  for (let cols = 1; cols <= colLimit; cols++) {
    const rows = Math.ceil(total / cols);
    let maxWidth = Math.floor(width / cols);
    let maxHeight = Math.floor(height / rows);
    if ((maxWidth * 9) / 16 < maxHeight) {
      maxHeight = Math.floor((maxWidth * 9) / 16);
    } else {
      maxWidth = Math.floor((maxHeight * 16) / 9);
    }
    if (maxWidth > bestWidth) {
      bestWidth = maxWidth;
      bestHeight = maxHeight;
    }
  }
  return { bestWidth, bestHeight };
}

function renderVideo() {
  if (!videoGrid) return;

  if (displayChannels.length === 0) {
    videoGrid.innerHTML = '';
    videoWrapperMap.clear();
    return;
  }

  videoGrid.className = '';
  document.getElementById('main-sub-row-break')?.remove();

  if (currentLayout === 'grid') {
    const total = displayChannels.length;

    videoGrid.classList.add('grid-mode');

    const width = videoGrid.clientWidth;
    const height = videoGrid.clientHeight;

    const { bestWidth, bestHeight } = calcBestFit(total, width, height);

    videoGrid.style.display = 'flex';
    videoGrid.style.flexWrap = 'wrap';
    videoGrid.style.justifyContent = 'center';
    videoGrid.style.alignItems = 'center';
    videoGrid.style.alignContent = 'center';
    videoGrid.style.gridTemplateColumns = '';
    videoGrid.style.gridTemplateRows = '';

    displayChannels.forEach((item, index) => {
      const wrapper = getOrCreateVideoWrapper(item);
      if (!wrapper.parentNode) {
        videoGrid.appendChild(wrapper);
      }

      wrapper.style.display = 'block';
      wrapper.style.visibility = 'visible';
      wrapper.style.overflow = '';
      wrapper.style.pointerEvents = '';
      wrapper.style.position = '';

      wrapper.className = 'video-wrapper grid-item';
      wrapper.style.flexGrow = '0';
      wrapper.style.width = `${bestWidth}px`;
      wrapper.style.height = `${bestHeight}px`;
      wrapper.style.gridRow = '';
      wrapper.style.gridColumn = '';
      wrapper.style.justifySelf = '';
      wrapper.style.transform = '';
      wrapper.style.order = index;
    });

    return;
  }
  videoGrid.style.display = '';
  videoGrid.style.flexWrap = '';
  videoGrid.style.justifyContent = '';
  videoGrid.style.alignItems = '';
  videoGrid.style.alignContent = '';
  videoGrid.style.gridTemplateColumns = '';
  videoGrid.style.gridTemplateRows = '';
  videoGrid.classList.add('main_sub-mode');

  const mainItem = displayChannels.find(item => item.hash === mainChannel) || displayChannels[0];
  const subItemList = displayChannels.filter(item => item.hash !== mainItem.hash);
  const mainWrapper = getOrCreateVideoWrapper(mainItem);
  if (!mainWrapper.parentNode) {
    videoGrid.appendChild(mainWrapper);
  }

  mainWrapper.style.display = 'block';
  mainWrapper.style.visibility = 'visible';
  mainWrapper.style.width = '';
  mainWrapper.style.height = '';
  mainWrapper.style.overflow = '';
  mainWrapper.style.pointerEvents = '';
  mainWrapper.style.position = '';
  mainWrapper.style.gridRow = '';
  mainWrapper.style.gridColumn = '';
  mainWrapper.style.justifySelf = '';
  mainWrapper.style.transform = '';
  mainWrapper.className = 'video-wrapper main-session';
  mainWrapper.style.order = 0;

  if (subItemList.length > 0) {
    const rowBreak = document.createElement('div');
    rowBreak.id = 'main-sub-row-break';
    rowBreak.className = 'main-sub-row-break';
    videoGrid.appendChild(rowBreak);

    void mainWrapper.offsetHeight; 

    const gridStyle = window.getComputedStyle(videoGrid);
    const paddingX = parseFloat(gridStyle.paddingLeft || 0) + parseFloat(gridStyle.paddingRight || 0);
    const paddingY = parseFloat(gridStyle.paddingTop || 0) + parseFloat(gridStyle.paddingBottom || 0);

    const availableWidth = Math.max(videoGrid.clientWidth - paddingX, 0);
    const mainRect = mainWrapper.getBoundingClientRect();
    const availableHeight = Math.max(videoGrid.clientHeight - paddingY - mainRect.height, 60);
    const MAX_SUB_COLS = 5;
    const subCols = Math.min(subItemList.length, MAX_SUB_COLS);

    let bestWidth;
    let bestHeight;

    if (subItemList.length <= MAX_SUB_COLS) {
      ({ bestWidth, bestHeight } = calcBestFit(subItemList.length, availableWidth, availableHeight, subCols));
    } else {
      bestWidth = Math.floor(availableWidth / MAX_SUB_COLS);
      bestHeight = Math.floor((bestWidth * 9) / 16);
    }

    let subOrder = 1;
    subItemList.forEach(item => {
      const wrapper = getOrCreateVideoWrapper(item);
      if (!wrapper.parentNode) {
        videoGrid.appendChild(wrapper);
      }

      wrapper.style.display = 'block';
      wrapper.style.visibility = 'visible';
      wrapper.style.overflow = '';
      wrapper.style.pointerEvents = '';
      wrapper.style.position = '';
      wrapper.style.gridRow = '';
      wrapper.style.gridColumn = '';
      wrapper.style.justifySelf = '';
      wrapper.style.transform = '';

      wrapper.className = 'video-wrapper sub-session';
      wrapper.style.order = subOrder++;

      if (bestWidth > 0 && bestHeight > 0) {
        wrapper.style.width = `${bestWidth}px`;
        wrapper.style.height = `${bestHeight}px`;
      } else {
        wrapper.style.width = '';
        wrapper.style.height = '';
      }
    });
  }
}

function updateChatSession() {
  if (!chatTabs || !chatContainer) return;
  if (displayChannels.length === 0) {
    chatTabs.innerHTML = '';
    chatContainer.innerHTML = `<div class="chat-placeholder">${t('app.chatPlaceholder', '채널을 추가하면 채팅이 동기화됩니다.')}</div>`;
    activeChatChannel = null;
    return;
  }
  const isValidActive = displayChannels.some(c => c.hash === activeChatChannel);
  if (!activeChatChannel || !isValidActive) {
    activeChatChannel = displayChannels[0].hash;
  }
  const placeholder = chatContainer.querySelector('.chat-placeholder');
  if (placeholder) placeholder.remove();
  chatTabs.innerHTML = '';
  const fragment = document.createDocumentFragment();

  displayChannels.forEach(item => {
    const tab = document.createElement('div');
    const isActive = (item.hash === activeChatChannel);
    tab.className = `chat-tab ${isActive ? 'active' : ''}`;
    tab.setAttribute('data-hash', item.hash);
    tab.setAttribute('data-platform', item.platform);
    tab.style.setProperty('--tab-color', getPlatformColor(item.platform));

    const tabName = document.createElement('span');
    tabName.className = 'chat-tab-name';
    tabName.innerText = item.name;
    tab.addEventListener('click', () => {
      setChatChannel(item.hash);
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'chat-tab-refresh-btn';
    refreshBtn.innerHTML = '⟳';
    refreshBtn.title = '채팅 새로고침';
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshChatTab(item.hash, item.platform, refreshBtn);
    });

    tab.appendChild(tabName);
    tab.appendChild(refreshBtn);
    fragment.appendChild(tab);
  });
  
  chatTabs.appendChild(fragment);
  const existingIframes = chatContainer.querySelectorAll('iframe.chat-iframe');
  existingIframes.forEach(iframe => {
    const hash = iframe.getAttribute('data-hash');
    if (!displayChannels.some(c => c.hash === hash)) {
      iframe.src = 'about:blank'; 
      iframe.remove();
      reinitPendingHashes.delete(hash);
      const overlay = chatReinitOverlays.get(hash);
      if (overlay) { overlay.remove(); chatReinitOverlays.delete(hash); }
    }
  });
  ensureChatIframeCreated(activeChatChannel);
  syncChatVisibility();
}

async function loadChatIframe(iframe, hash, platform) {
  const adapter = getAdapter(platform);

  if (platform === 'youtube') {
    await refreshYoutubeVideoId(hash);
    const ch = getChannelObjByHash(hash);
    const videoId = ch && ch.videoId;
    if (!videoId) { iframe.src = 'about:blank'; return; }

    // 확장 origin(chrome-extension://...)에서 live_chat을 곧바로 열면
    // embed_domain 검증을 통과하지 못해 ERR_BLOCKED_BY_RESPONSE로 막힌다.
    // 우리가 소유한 실제 https 도메인(YT_RELAY_ORIGIN)의 중계 페이지가
    // 대신 embed_domain을 채워 요청하도록 위임한다. 자세한 배경은
    // PlatformAdapters.youtube.getChatEmbedUrl 주석 참고.
    iframe.src = getAdapter('youtube').getChatEmbedUrl(hash);
    return;
  }

  if (platform !== 'soop') {
    iframe.src = adapter.getChatEmbedUrl(hash);
    return;
  }

  const readyEntry = getSoopVideoReadyEntry(hash);
  const readyPromise = Promise.race([readyEntry.promise, new Promise((res) => setTimeout(res, 8000))]);
  const broadNoPromise = refreshSoopBroadNo(hash);
  const videoLoadPromise = new Promise((resolve) => {
    const onLoad = () => { iframe.removeEventListener('load', onLoad); resolve(); };
    iframe.addEventListener('load', onLoad);
  });
  iframe.src = adapter.getVideoEmbedUrl(hash);

  await Promise.all([readyPromise, broadNoPromise, videoLoadPromise]);

  const chatUrl = adapter.getChatEmbedUrl(hash);
  try {
    iframe.contentWindow.location.href = chatUrl;
  } catch (e) {
    iframe.src = chatUrl;  }
}

function refreshChatTab(hash, platform, btnEl) {
  if (!hash || !chatContainer) return;

  if (btnEl) {
    btnEl.classList.remove('is-spinning');
    void btnEl.offsetWidth;
    btnEl.classList.add('is-spinning');
    setTimeout(() => btnEl.classList.remove('is-spinning'), 700);
  }

  const iframe = chatContainer.querySelector(`iframe[data-hash="${hash}"]`);
  if (!iframe) {
    ensureChatIframeCreated(hash);
    return;
  }

  const wasVisible = chatVisible && hash === activeChatChannel;

  if (platform === 'soop') {
    soopVideoReadyMap.delete(hash);
    if (wasVisible) showChatReinitOverlay(hash);
    loadChatIframe(iframe, hash, 'soop').finally(() => { if (wasVisible) hideChatReinitOverlay(hash); });
  } else {
    // about:blank로 초기화 후 같은 iframe에 다시 src를 대입하는 방식은,
    // 프레임이 이전에 X-Frame-Options 등으로 chrome-error 상태에 빠진 적이
    // 있으면 재탐색 자체가 브라우저에 의해 거부될 수 있다. iframe 엘리먼트를
    // 새로 만들어 교체하면 이 문제를 원천적으로 피할 수 있다.
    recreateChatIframe(iframe, hash, platform);
  }
}

function createChatIframe(hash, platform) {
  const iframe = document.createElement('iframe');
  iframe.className = 'chat-iframe';
  iframe.setAttribute('data-hash', hash);
  iframe.setAttribute('allow', IFRAME_ALLOW);
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  chatContainer.appendChild(iframe);
  loadChatIframe(iframe, hash, platform);
  return iframe;
}

function recreateChatIframe(oldIframe, hash, platform) {
  const parent = oldIframe.parentNode;
  if (!parent) return oldIframe;
  const fresh = document.createElement('iframe');
  fresh.className = oldIframe.className || 'chat-iframe';
  fresh.setAttribute('data-hash', hash);
  fresh.setAttribute('allow', IFRAME_ALLOW);
  fresh.style.width = '100%';
  fresh.style.height = '100%';
  fresh.style.border = 'none';
  fresh.style.display = oldIframe.style.display || '';
  parent.replaceChild(fresh, oldIframe);
  loadChatIframe(fresh, hash, platform);
  return fresh;
}

function ensureChatIframeCreated(hash) {
  if (!hash || !chatContainer) return;

  let iframe = chatContainer.querySelector(`iframe[data-hash="${hash}"]`);
  if (!iframe) {
    const chObj = getChannelObjByHash(hash);
    const platform = chObj ? chObj.platform : 'chzzk';
    createChatIframe(hash, platform);
  }
}
function syncChatVisibility() {
  if (!chatContainer) return;

  const iframes = chatContainer.querySelectorAll('iframe.chat-iframe');
  iframes.forEach(iframe => {
    const hash = iframe.getAttribute('data-hash');
    if (hash === activeChatChannel) {
      iframe.style.display = 'block';
    } else {
      iframe.style.display = 'none';
    }
  });
  reinitPendingHashes.forEach(h => updateChatReinitOverlayVisibility(h));
}

function ensureChatIframeLoaded(hash) {
  if (!chatContainer || !hash) return;
  const iframes = chatContainer.querySelectorAll('iframe.chat-iframe');
  iframes.forEach(el => el.style.display = 'none');

  let iframe = chatContainer.querySelector(`iframe[data-hash="${hash}"]`);
  if (!iframe) {
    const chObj = getChannelObjByHash(hash);
    const platform = chObj ? chObj.platform : 'chzzk';
    iframe = createChatIframe(hash, platform);
  }

  iframe.style.display = 'block';
}
function loadChatForChannel(hash) {
  if (!chatContainer || !channels.some(c => c.hash === hash)) return;

  let iframe = chatContainer.querySelector(`iframe[data-hash="${hash}"]`);

  if (!iframe) {
    const chObj = getChannelObjByHash(hash);
    const platform = chObj ? chObj.platform : 'chzzk';
    createChatIframe(hash, platform);
  }

  syncChatVisibility();
}

function renderAll() {
  renderVideo();
  updateChatSession();
}

function removeChannel(hash) {
  console.log(`🔍 [ENTRY] removeChannel 함수 실행됨! 인자값(hash):`, hash);

  if (!hash) {
    console.error('❌ [ERROR] removeChannel: 전달된 hash 값이 없습니다.');
    return;
  }

  const dataTargetIndex = displayChannels.findIndex(c => c.hash === hash || c.name === hash);
  if (dataTargetIndex === -1) {
    console.warn(`⚠️ [REMOVE] displayChannels 목록에서 삭제 대상을 찾을 수 없습니다: ${hash}`);
    return;
  }
  const targetChannel = displayChannels[dataTargetIndex];
  const deleteHash = targetChannel.hash;
  const isZeroDeleted = (dataTargetIndex === 0);
  const isMainTarget = (mainChannel === deleteHash || mainChannel === hash);
  const firstChzzkHash = getFirstChzzkHash();
  const isFirstChzzkDeleted = targetChannel.platform === 'chzzk' && deleteHash === firstChzzkHash;
  const shouldReloadAll = isFirstChzzkDeleted;

  console.log(`🗑️ [REMOVE] 삭제 요청 - Target: ${targetChannel.name} (${deleteHash}) | IsFirstChzzkDeleted: ${isFirstChzzkDeleted} | IsMain: ${isMainTarget}`);

  channels = channels.filter(c => c.hash !== deleteHash && c.name !== deleteHash);
  displayChannels = displayChannels.filter(c => c.hash !== deleteHash && c.name !== deleteHash);
  channelAddOrder = channelAddOrder.filter(h => h !== deleteHash && h !== hash);

  if (displayChannels.length > 0) {
    if (isMainTarget || isZeroDeleted || !mainChannel) {
      mainChannel = displayChannels[0].hash;
      console.log(`📌 [RE-ASSIGN] 새 메인 채널 재할당: ${mainChannel}`);
    }
  } else {
    mainChannel = null;
    console.log(`📌 [RE-ASSIGN EMPTY] 모든 채널 삭제됨`);
  }

  if (activeChatChannel === deleteHash || activeChatChannel === hash) {
    activeChatChannel = mainChannel;
  }

  videoWrapperMap.forEach((wrapper, key) => {
    const wrapperDataHash = wrapper.getAttribute('data-hash');
    if (key === deleteHash || key === hash || wrapperDataHash === deleteHash || wrapperDataHash === hash) {
      const iframe = wrapper.querySelector('iframe');
      if (iframe) iframe.src = 'about:blank';
      wrapper.remove();
      videoWrapperMap.delete(key);
    }
  });

  if (chatContainer) {
    const chatIframe = chatContainer.querySelector(`iframe[data-hash="${deleteHash}"], iframe[data-hash="${hash}"]`);
    if (chatIframe) {
      chatIframe.src = 'about:blank';
      chatIframe.remove();
    }
  }

  saveChannelsToStorage();

  if (shouldReloadAll) {
    console.log('🔄 [RELOAD] 가장 먼저 추가된 치지직 채널 삭제(메인/서브 무관) ➔ 플레이어 전체 재할당!');
    if (typeof reloadAllVideoPlayers === 'function') {
      reloadAllVideoPlayers();
    }
  } else {
    console.log('✨ [NO RELOAD] 일반 채널 삭제 처리 완료');
    if (typeof renderVideo === 'function') {
      renderVideo();
    }
  }

  if (typeof updateChatSession === 'function') {
    updateChatSession();
  }
}

function saveActiveChatState() {
  const activeChatWrapper = document.querySelector('.chat-wrapper.active, [data-chat-active="true"]');
  if (activeChatWrapper) {
    const activeIndex = activeChatWrapper.getAttribute('data-channel-index') || '0';
    sessionStorage.setItem('LAST_ACTIVE_CHAT_INDEX', activeIndex);
  } else {
    sessionStorage.setItem('LAST_ACTIVE_CHAT_INDEX', '');
  }
}

function restoreActiveChatState() {
  const savedIndex = sessionStorage.getItem('LAST_ACTIVE_CHAT_INDEX');
  let targetIdx = 0;

  if (savedIndex !== null && savedIndex !== '') {
    targetIdx = parseInt(savedIndex, 10);
  }

  if (typeof displayChannels !== 'undefined' && displayChannels[targetIdx]) {
    setChatChannel(displayChannels[targetIdx].hash);
  }
}

function reloadAllVideoPlayers() {
  saveActiveChatState();

  videoWrapperMap.forEach((wrapper) => {
    const iframe = wrapper.querySelector('iframe');
    if (iframe) iframe.src = 'about:blank';
    wrapper.remove();
  });

  videoWrapperMap.clear();

  if (typeof renderVideo === 'function') {
    renderVideo();
  }

  setTimeout(() => {
    restoreActiveChatState();
  }, 100);
}

const mainRefreshBtn = document.getElementById('refresh-btn');
if (mainRefreshBtn) {
  const cleanMainBtn = mainRefreshBtn.cloneNode(true);
  mainRefreshBtn.parentNode.replaceChild(cleanMainBtn, mainRefreshBtn);

  cleanMainBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    reloadAllVideoPlayers();
  });
}

window.addEventListener('beforeunload', () => {
  saveActiveChatState();
});

document.addEventListener('DOMContentLoaded', () => {
  restoreActiveChatState();
});
document.getElementById('refresh-btn')?.addEventListener('click', reloadAllVideoPlayers);

document.getElementById('logo')?.addEventListener('click', () => {
  channels = [];
  displayChannels = [];
  channelAddOrder = [];
  mainChannel = null;
  activeChatChannel = null;
  isFirstZeroRemoved = false;

  if (typeof channelInput !== 'undefined' && channelInput) {
    channelInput.value = '';
  } else {
    const inputElem = document.getElementById('channel-input'); 
    if (inputElem) inputElem.value = '';
  }

  videoWrapperMap.forEach((wrapper) => {
    const iframe = wrapper.querySelector('iframe');
    if (iframe) iframe.src = 'about:blank';
    wrapper.remove();
  });
  videoWrapperMap.clear();

  if (videoGrid) videoGrid.innerHTML = '';
  if (chatContainer) chatContainer.innerHTML = '';

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.remove(['my_channels'], () => {
      renderAll();
    });
  } else {
    localStorage.removeItem('my_channels');
    renderAll();
  }
});

let isReloadingAll = false;

let mySetting = { name: '내 프로필', avatar: '', connections: { chzzk: false, soop: false } };
let profileConnectionChanged = false;

function loadSetting(callback) {
  const migrate = () => {
    if (!mySetting.connections) {
      mySetting.connections = { chzzk: !!mySetting.chzzkConnected, soop: false };
      delete mySetting.chzzkConnected;
    }
  };
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['my_profile'], (result) => {
      if (result.my_profile) mySetting = result.my_profile;
      migrate();
      callback && callback();
    });
  } else {
    const saved = localStorage.getItem('my_profile');
    if (saved) mySetting = JSON.parse(saved);
    migrate();
    callback && callback();
  }
}

function saveSetting() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ my_profile: mySetting });
  } else {
    localStorage.setItem('my_profile', JSON.stringify(mySetting));
  }
}

async function syncPlatformLoginStatus(platform) {
  const loggedIn = await getAdapter(platform).checkLoginStatus();
  if (!mySetting.connections) mySetting.connections = {};
  if (mySetting.connections[platform] !== loggedIn) {
    mySetting.connections[platform] = loggedIn;
    saveSetting();
    profileConnectionChanged = true;
  }
  return loggedIn;
}

async function syncAllLoginStatus() {
  const enabledPlatforms = Object.keys(PLATFORM_META).filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p]);
  const statuses = await Promise.all(enabledPlatforms.map(p => syncPlatformLoginStatus(p)));
  return Object.fromEntries(enabledPlatforms.map((p, i) => [p, statuses[i]]));
}

function renderPlatformRow(container, key) {
  const meta = PLATFORM_META[key];
  const connected = mySetting.connections ? !!mySetting.connections[key] : false;

  const row = document.createElement('div');
  row.className = 'platform-row' + (meta.enabled ? '' : ' disabled');

  const dot = document.createElement('div');
  dot.className = 'platform-dot';
  dot.style.backgroundColor = meta.color;
  row.appendChild(dot);

  const name = document.createElement('div');
  name.className = 'platform-name';
  name.textContent = getPlatformLabel(key);
  row.appendChild(name);

  if (!meta.enabled) {
    const btn = document.createElement('button');
    btn.className = 'platform-login-btn';
    btn.style.color = meta.color;
    btn.textContent = t('settings.platformPreparing', '준비중');
    btn.disabled = true;
    row.appendChild(btn);
  } else if (connected) {
    const status = document.createElement('span');
    status.className = 'platform-login-btn';
    status.style.color = meta.color;
    status.textContent = t('settings.platformConnected', '연동됨');
    row.appendChild(status);

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'platform-logout-btn';
    logoutBtn.style.borderColor = meta.color;
    logoutBtn.style.color = meta.color;
    logoutBtn.textContent = t('settings.platformLogout', '로그아웃');
    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      logoutBtn.classList.add('is-loading');
      logoutBtn.textContent = t('settings.platformLoggingOut', '로그아웃 중...');
      status.textContent = t('settings.platformLoggingOut', '로그아웃 중...');
      status.classList.add('is-loading');

      const adapter = getAdapter(key);
      if (typeof adapter.logout === 'function') {
        await adapter.logout();
      } else {
        window.open(adapter.getLogoutUrl(), '_blank');
      }
      setTimeout(() => syncPlatformLoginStatus(key).then(() => refreshSettingModal()), 1500);
    });
    row.appendChild(logoutBtn);
  } else {
    const btn = document.createElement('button');
    btn.className = 'platform-login-btn';
    btn.style.color = meta.color;
    btn.textContent = t('settings.platformLogin', '로그인');
    btn.addEventListener('click', () => {
      openLoginPopup(getAdapter(key).getLoginUrl()).then(() => {
        syncPlatformLoginStatus(key).then(() => refreshSettingModal());
      });
      pollPlatformLogin(key);
    });
    row.appendChild(btn);
  }

  container.appendChild(row);
}

function openLoginPopup(url, { width = 500, height = 650 } = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'OPEN_LOGIN_POPUP', url, width, height }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        window.open(url, '_blank');
        resolve();
        return;
      }

      const targetWindowId = response.windowId;
      function onClosedMessage(message) {
        if (!message || message.type !== 'LOGIN_POPUP_CLOSED') return;
        if (message.windowId !== targetWindowId) return;
        chrome.runtime.onMessage.removeListener(onClosedMessage);
        resolve();
      }
      chrome.runtime.onMessage.addListener(onClosedMessage);
    });
  });
}

function pollPlatformLogin(platform) {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    const loggedIn = await syncPlatformLoginStatus(platform);
    if (loggedIn || attempts >= 15) {
      clearInterval(interval);
      const modal = document.getElementById('setting-modal');
      if (modal && modal.classList.contains('active')) refreshSettingModal();
    }
  }, 2000);
}

function closeSettingModal() {
  const modal = document.getElementById('setting-modal');
  if (modal) modal.classList.remove('active');

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.classList.remove('active');

  if (profileConnectionChanged) {
    profileConnectionChanged = false;
    window.location.reload();
  }
}

async function openSettingModal() {
  profileConnectionChanged = false;
  let modal = document.getElementById('setting-modal');

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'setting-modal';
    modal.className = 'setting-modal-backdrop';
    modal.innerHTML = `
      <div class="setting-modal-content">
        <h3 data-i18n="settings.title">설정</h3>
        <div class="settings-tab-nav">
          <button type="button" class="settings-tab-btn active" data-tab="settings" data-i18n="settings.tabSettings">설정</button>
          <button type="button" class="settings-tab-btn" data-tab="info" data-i18n="settings.tabInfo">안내</button>
        </div>

        <div class="settings-tab-panel" data-panel="settings">
          <div class="setting-section-title" data-i18n="settings.uiLanguageSection">표시 언어</div>
          <div class="yt-settings-row">
            <label class="yt-settings-label" for="ui-language-select" data-i18n="settings.uiLanguageLabel">언어</label>
            <select id="ui-language-select" class="yt-settings-select"></select>
          </div>
          <div class="yt-settings-hint" data-i18n="settings.uiLanguageHint">CHEESE EYES 화면 전체에 표시되는 언어를 바꿉니다.</div>

          <div class="setting-section-title" data-i18n="settings.accountSection">연동 계정</div>
          <div id="platform-list"></div>
        </div>

        <div class="settings-tab-panel" data-panel="info" hidden>
          <div class="setting-section-title">CHEESE EYES</div>
          <div class="info-row"><span class="info-row-label" data-i18n="settings.versionLabel">버전</span><span id="info-version" class="info-row-value"></span></div>
          <div class="setting-section-title" data-i18n="settings.platformsSection">지원 플랫폼</div>
          <div class="info-platform-list" data-i18n="settings.platformsList">치지직(CHZZK) · 숲(SOOP) · 유튜브(YOUTUBE)</div>
          <div class="info-notice" data-i18n="settings.noticeStructure">플랫폼 구조 변경 시 정상 동작 하지 않을 수 있습니다.</div>
          <div class="info-notice" data-i18n="settings.noticeYoutubeTag">유튜브는 태그 검색을 지원하지 않습니다.</div>
          <div class="setting-section-title" data-i18n="settings.contactSection">문의 / 링크</div>
          <div class="info-link-row"><a href="mailto:seoldam82@gmail.com">seoldam82@gmail.com</a></div>
          <div class="info-link-row"><a href="https://github.com/seoldam82/CHEESE-EYES" target="_blank" rel="noopener" data-i18n="settings.githubRepo">GitHub 저장소</a></div>
          <div class="info-link-row"><a href="https://github.com/seoldam82/CHEESE-EYES/blob/main/PRIVACY_POLICY.md" target="_blank" rel="noopener" data-i18n="settings.privacyPolicy">개인정보처리방침</a></div>
        </div>

        <div class="setting-modal-actions">
          <button id="setting-close-btn" data-i18n="settings.closeButton">닫기</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('setting-close-btn').addEventListener('click', closeSettingModal);

    modal.querySelectorAll('.settings-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        modal.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        modal.querySelectorAll('.settings-tab-panel').forEach(p => {
          p.hidden = p.dataset.panel !== target;
        });
      });
    });

    const uiLanguageSelect = document.getElementById('ui-language-select');
    getUiLanguageOptions().forEach(opt => {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      uiLanguageSelect.appendChild(el);
    });
    uiLanguageSelect.addEventListener('change', () => {
      if (typeof window.setUiLanguage === 'function') window.setUiLanguage(uiLanguageSelect.value);
    });

    const infoVersion = document.getElementById('info-version');
    if (infoVersion) {
      try { infoVersion.textContent = `v${chrome.runtime.getManifest().version}`; }
      catch (e) { infoVersion.textContent = ''; }
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeSettingModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        const m = document.getElementById('setting-modal');
        if (m && m.classList.contains('active')) {
          closeSettingModal();
        }
      }
    });

  }

  await refreshSettingModal();
  modal.classList.add('active');

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.classList.add('active');
}

async function refreshSettingModal() {
  await syncAllLoginStatus();

  const platformList = document.getElementById('platform-list');
  platformList.innerHTML = '';
  Object.keys(PLATFORM_META).forEach(key => renderPlatformRow(platformList, key));

  const uiLanguageSelect = document.getElementById('ui-language-select');
  if (uiLanguageSelect) {
    uiLanguageSelect.value = window.CHEESE_EYES_CURRENT_LANG
      || (typeof window.CHEESE_EYES_SUPPORTED_LANGS !== 'undefined' && window.CHEESE_EYES_SUPPORTED_LANGS[0])
      || 'ko';
  }
}

loadSetting(() => {
  syncAllLoginStatus();
});

setInterval(syncAllLoginStatus, 30000);

const profileBtn = document.getElementById('settings-btn');
if (profileBtn) {
  profileBtn.addEventListener('click', openSettingModal);
}

document.addEventListener('cheeseeyes:i18n-ready', () => {
  const modal = document.getElementById('setting-modal');
  if (modal && modal.classList.contains('active')) refreshSettingModal();

  if (chatContainer && chatContainer.querySelector('.chat-placeholder')) {
    updateChatSession();
  }
});

(function setupFullscreenModeToolbar() {
  const appContainer = document.getElementById('app-container');
  const controlPanel = document.getElementById('control-panel');
  const modeButtons = document.getElementById('mode-buttons');
  const fsToolbar = document.getElementById('fs-mode-toolbar');
  if (!appContainer || !controlPanel || !modeButtons || !fsToolbar) return;

  function isNativeFullscreen() {
    if (document.fullscreenElement) return true;
    const heightGap = Math.abs(window.screen.height - window.innerHeight);
    const widthGap = Math.abs(window.screen.width - window.innerWidth);
    return heightGap <= 2 && widthGap <= 2;
  }

  function syncFullscreenState() {
    const isFs = isNativeFullscreen();
    const alreadyFs = appContainer.classList.contains('fs-mode');
    if (isFs === alreadyFs) return;
    appContainer.classList.toggle('fs-mode', isFs);
    if (!isFs) {
      if (typeof closeFsQuickSearch === 'function') closeFsQuickSearch();
    }
    requestAnimationFrame(() => {
      if (typeof renderVideo === 'function') renderVideo();
    });
  }

  window.addEventListener('resize', syncFullscreenState);
  document.addEventListener('fullscreenchange', syncFullscreenState);
  syncFullscreenState();
})();