let presets = [];
let mainChannel = null;
let activeChatChannel = null;
let currentLayout = 'grid';
let chatVisible = false;
let queueSidebarVisible = false;
// 화면 왼쪽 대기열(전역 단일 목록, 채널별 아님). 항목: { videoId, title,
// channelName, targetHash }. targetHash=null이면 빈 슬롯에 순서대로 채워짐,
// 특정 hash면 드래그로 그 채널 전용 예약(§renderQueueSidebar).
let videoQueue = [];
// true면 슬롯이 자동으로 비어도(영상 종료/라이브 오프라인) 새 영상을 채우지
// 않는다. 사용자가 직접 삭제한 자리는 이 값과 무관하게 항상 빈다.
let queuePaused = false;
let searchDebounceTimer = null;
let currentSearchKeyword = '';
let fetchedTagChannels = [];
let selectedTagChannels = [];
let channels = [];

const DEFAULT_MAIN_VOLUME = 100;
const DEFAULT_CHANNEL_VOLUME = 100;
const DEFAULT_SUB_VOLUME = 25;

// collabGroups: [{ id, memberHashes: string[], mode: 'live'|'vod-sync',
// vodOffsetSecByHash: {[hash]: number} }] — 합방(동시 출연) 채널 그룹.
// "항상 들려줄 채널"(대표)은 별도 필드 없이 전역 mainChannel과 동일하다
// (2026-08-16 후속, 사용자 지시: "메인 채널 == 대표 채널로 해" — 예전엔
// 그룹마다 leaderHash를 따로 저장했지만, 레이아웃 불문 대표=메인으로
// 통일하면서 그 필드 자체를 없앴다). §getCollabLeaderHash. mode가
// 'live'(기본값)면 그룹 내 모든 쌍을 비교해
// "겹침 클러스터"를 만들고, 클러스터마다 대표(있으면) 또는 레이턴시 최저
// 멤버만 남기고 나머지를 자동 음소거한다(getGroupClusters,
// recomputeCollabMuting, docs/collab-latency-architecture.md). mode가
// 'vod-sync'면 겹침 감지 자체를 안 하고 대표 외 항상 음소거 +
// vodOffsetSecByHash 기반 재생위치 동기화를 한다
// (docs/vod-collab-sync-architecture.md). vodStartTimeMsByHash: {[hash]:
// epochMs} — VOD 채널(hash)의 "실제 방송 시작 시각" 캐시, 플랫폼별
// PlatformAdapters[platform].getVodStartTime로 채워진다(§ensureVodStartTimeCached
// 아래 주석, §docs/vod-collab-sync-architecture.md §10). group이 아니라 여기(최상위)에 두는 이유: 채널의 속성이지
// 그룹의 속성이 아니고(어느 그룹의 대표든 상관없이 같은 값), 대표가
// 바뀌어도 재계산 없이 바로 두 앵커의 차로 오프셋을 낼 수 있어야
// 한다(사용자 요청 — "양방향, 초기에 한번만 계산").
let audioState = { mainVolumeByChannel: {}, channelVolumeOverrides: {}, collabGroups: [], vodStartTimeMsByHash: {} };

// 채널별 평균 오디오 레벨(dBFS, content.js가 CHANNEL_AUDIO_LEVEL로 보고).
// 미측정 채널은 키 자체가 없다 — "값 없음"과 "무음"은 구분해야 한다(무음
// 취급 시 그룹 전체가 그 채널 기준으로 묶여 음소거될 수 있음).
let channelAudioLevels = {};

// 합방 오디오 유사도 계산용 — 채널별 최근 dB 샘플 이력(ring buffer, {t, db}
// 약 12초치). channelAudioLevels(최신값 1개)와 달리 시계열 상관관계 계산을
// 위해 구간 전체를 보관한다.
let channelAudioLevelHistory = {};

// 합방 겹침 판정으로 현재 강제 음소거 중인 채널 hash 집합. recomputeCollabMuting이
// 매 갱신 주기마다 다시 채워 넣는다.
let collabMutedHashes = new Set();

// 채널별 최신 레이턴시(content.js의 CHANNEL_LIVE_LATENCY, 라이브 엣지까지
// 초 단위, 최근 3표본 이동평균) — docs/collab-latency-architecture.md.
// 모든 쌍을 직접 비교하므로 전역 anchor로는 안 쓰고, 겹침 클러스터에 대표가
// 없을 때 "레이턴시 최저 멤버를 남긴다"는 타이브레이커로만 쓴다(pickClusterKeeper).
let channelLatencySecByHash = {};
let collabLatencySmoothBuffer = {};
const COLLAB_LATENCY_SMOOTH_SAMPLES = 3;
function smoothChannelLatency(hash, rawSec) {
  const buf = collabLatencySmoothBuffer[hash] || (collabLatencySmoothBuffer[hash] = []);
  buf.push(rawSec);
  if (buf.length > COLLAB_LATENCY_SMOOTH_SAMPLES) buf.shift();
  return buf.reduce((sum, v) => sum + v, 0) / buf.length;
}

const IFRAME_ALLOW = "autoplay *; fullscreen *; encrypted-media *; picture-in-picture *; local-network-access *; loopback-network *";

// ── 유튜브 영상/채팅 중계(오류153·embed_domain 우회용 실제 https 도메인) ──
// chrome-extension:// origin에서는 (1) 임베드 플레이어가 Referer를 못 받아
// 오류153이 나고, (2) live_chat은 embed_domain 검증 실패로 ERR_BLOCKED_BY_RESPONSE가
// 뜬다. 실제 도메인(GitHub Pages)에 올린 중계 페이지(relay.html, ?type=video|chat
// 분기)를 iframe으로 감싸 둘 다 우회한다. yt-video.html/yt-chat.html이던 것을
// 대역폭·캐시 효율을 위해 relay.html 하나로 통합했다.
// 아래 값을 실제 배포된 GitHub Pages 주소로 바꿔야 동작한다.
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
  el.innerHTML = `<div class="chat-reinit-spinner"></div><div class="chat-reinit-text" data-i18n="app.chatReconnecting">${t('app.chatReconnecting', '채팅 재연결 중...')}</div>`;
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

// ---- 플랫폼별 계정 중복 방지(라이브 전용) ----
// 시청자 수 집계에 영향을 주는 라이브 채널에 한해, 그 플랫폼 계정이 다른
// 곳에서 이미 쓰이고 있는지 확인한다(§ensurePlatformLiveLock). 플랫폼마다
// 서버에 독립 클레임하므로 한 플랫폼이 막혀도 나머지엔 영향 없음 — 막히면
// 알림만 띄우고 해당 채널만 거부/삭제한다. VOD는 실시간 중복 시청이 아니므로
// 대상 아님. 비로그인 상태에서도 앱은 자유롭게 쓸 수 있고, 로그인은 "그
// 플랫폼 라이브를 실제로 추가하려는 시점"에만 요구한다. 같은 프로필에서
// 대시보드 탭을 여러 개 여는 것 자체는 막지 않는다(VOD 멀티뷰 등도 자유롭게).
// 잠금 서버(server/, 계정ID는 해시로만 저장)에 연결 불가 시(미배포/장애)
// 핵심 기능을 막지 않도록 페일오픈한다.
const LOCK_SERVER_URL = 'https://cheese-eyes-lock.seoldam82.workers.dev';
const LOCK_HEARTBEAT_MS = 300000;
const INSTANCE_SESSION_STORAGE_KEY = 'cheeseEyesInstanceSessionId';
// 새로고침/재오픈 시 "직전 세션ID"를 여기서 읽어 recoverSessionId로 서버에 보낸다.
// 크래시 등으로 release가 못 나가 서버에 고아 잠금이 남아있는 경우, TTL(750s)을
// 기다리지 않고 즉시 되찾기 위함이다(server/src/index.js /claim 참고).
// sessionStorage는 탭 전용이라 다른 탭이 이 값을 알 수 없어 그대로 차단된다.
let recoverInstanceSessionId = null;
try { recoverInstanceSessionId = sessionStorage.getItem(INSTANCE_SESSION_STORAGE_KEY); } catch (err) { /* 무시 */ }
const instanceSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`;
try { sessionStorage.setItem(INSTANCE_SESSION_STORAGE_KEY, instanceSessionId); } catch (err) { /* 무시 */ }
let instanceLockHeartbeatTimer = null;
let cachedAccountKeys = null;
let cachedAccountInfo = null; // [{platform, id, label}] — 화면 표시용(닉네임 등), 잠금 키에는 id만 쓴다.
let lockedPlatformKeys = new Map(); // platform -> "platform:id" — 지금 서버에 실제로 클레임된 라이브 플랫폼 계정
let platformReconcileInFlight = new Set(); // 중복 재조정 방지(플랫폼별)

// 치지직: 네이버 로그인 상태 조회 API. userIdHash는 로그인된 네이버 계정
// 식별값(채팅 등과 동일). ⚠ 실제 로그인 상태로 미검증 — 응답 구조가 다르면
// 콘솔 경고를 보고 조정 필요.
async function getChzzkAccountKey() {
  try {
    const res = await apiFetch('https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus', { credentials: 'include' });
    if (!res.ok) {
      console.warn(`[CHEESE EYES][계정확인][치지직] 요청 실패: status=${res.status}`);
      return null;
    }
    const data = await res.json();
    const userIdHash = data?.content?.userIdHash;
    if (!userIdHash) {
      window.__cheeseDebugChzzkStatus = data;
      console.warn('[CHEESE EYES][계정확인][치지직] userIdHash를 찾지 못함. 콘솔에 copy(JSON.stringify(window.__cheeseDebugChzzkStatus)) 입력해서 확인:', data);
      return null;
    }
    const label = data?.content?.nickname || userIdHash;
    return { platform: 'chzzk', id: userIdHash, label };
  } catch (err) {
    console.warn('[CHEESE EYES] 치지직 계정 확인 실패(로그인 안 됨으로 간주):', err);
    return null;
  }
}

// 숲(SOOP): 실제 로그인 상태로 확인 완료. afevent2.sooplive.com(.co.kr 아님)의
// get_private_info.php가 CHANNEL.LOGIN_ID에 로그인 계정 아이디를 담아 응답한다.
async function getSoopAccountKey() {
  try {
    const res = await apiFetch('https://afevent2.sooplive.com/api/get_private_info.php', { credentials: 'include' });
    if (!res.ok) {
      console.warn(`[CHEESE EYES][계정확인][숲] 요청 실패: status=${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data || !data.CHANNEL || Number(data.CHANNEL.IS_LOGIN) !== 1) return null;
    const userId = data.CHANNEL.LOGIN_ID;
    if (!userId) {
      window.__cheeseDebugSoopLogin = data;
      console.warn('[CHEESE EYES][계정확인][숲] 로그인은 확인됐지만 LOGIN_ID가 비어있음. 콘솔에 copy(JSON.stringify(window.__cheeseDebugSoopLogin)) 입력해서 확인:', data);
      return null;
    }
    const label = data.CHANNEL.LOGIN_NICK || userId;
    return { platform: 'soop', id: userId, label };
  } catch (err) {
    console.warn('[CHEESE EYES] 숲 계정 확인 실패(로그인 안 됨으로 간주):', err);
    return null;
  }
}

// 유튜브: 이미 구현되어 있는 InnerTube SAPISID 인증으로 계정 메뉴를 조회한다.
// 실제 로그인 상태로 응답을 확인해서 확정한 경로: header.manageAccountTitle의
// "내 채널 보기" 링크 안 browseEndpoint.browseId가 실제 채널ID(UC...)다.
async function getYoutubeAccountKey() {
  try {
    const adapter = PlatformAdapters?.youtube;
    if (!adapter) return null;
    const context = await adapter._context();
    const data = await adapter._innerTubePost('account/account_menu', { context }, true);
    const header = data?.actions?.[0]?.openPopupAction?.popup?.multiPageMenuRenderer?.header?.activeAccountHeaderRenderer;
    const channelId = header?.manageAccountTitle?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
      || header?.channelHandle?.simpleText
      || header?.accountName?.simpleText;
    if (!channelId) {
      window.__cheeseDebugYoutubeAccountMenu = data;
      console.warn('[CHEESE EYES][계정확인][유튜브] 채널ID를 찾지 못함. 콘솔에 copy(JSON.stringify(window.__cheeseDebugYoutubeAccountMenu)) 입력해서 확인:', data);
      return null;
    }
    const label = header?.accountName?.simpleText || header?.channelHandle?.simpleText || channelId;
    return { platform: 'youtube', id: channelId, label };
  } catch (err) {
    console.warn('[CHEESE EYES] 유튜브 계정 확인 실패(로그인 안 됨으로 간주):', err);
    return null;
  }
}

async function getPlatformAccountKeys() {
  if (cachedAccountKeys !== null) return cachedAccountKeys;
  const results = await Promise.allSettled([getChzzkAccountKey(), getSoopAccountKey(), getYoutubeAccountKey()]);
  cachedAccountInfo = results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
  cachedAccountKeys = cachedAccountInfo.map((info) => `${info.platform}:${info.id}`);
  return cachedAccountKeys;
}

// ---- 잠금 대상 계정 범위(스코프) ----
// 서버에 실제로 클레임하는 계정은 "지금 멀티뷰에 라이브로 재생 중인 플랫폼"만
// (VOD 제외, 다시보기는 중복 시청 문제가 아님). 그래야 유튜브 라이브를 하나도
// 안 넣었는데 브라우저에 구글 로그인만 돼 있다는 이유로 잠겨서 무관한
// 치지직/숲 사용까지 막히는 오탐을 없앤다.
function getUsedLivePlatformsFromChannels() {
  return new Set((channels || []).filter((c) => c && !c.isVod).map((c) => c.platform).filter(Boolean));
}

async function getAccountKeyForPlatform(platform) {
  if ((cachedAccountInfo || []).some((info) => info.platform === platform)) {
    return cachedAccountInfo.find((info) => info.platform === platform);
  }
  let info = null;
  if (platform === 'chzzk') info = await getChzzkAccountKey();
  else if (platform === 'soop') info = await getSoopAccountKey();
  else if (platform === 'youtube') info = await getYoutubeAccountKey();
  if (info) {
    cachedAccountInfo = [...(cachedAccountInfo || []), info];
    cachedAccountKeys = cachedAccountInfo.map((i) => `${i.platform}:${i.id}`);
  }
  return info;
}

// ---- 알림창(토스트) ----
// 계정 충돌/로그인 필요 안내는 더 이상 전체 화면을 가리지 않는다 — 우측
// 상단에 잠깐 떴다 사라지는 알림으로만 표시하고, 나머지 기능(다른
// 플랫폼/VOD 등)은 그대로 동작한다.
function showPlatformNotice(message) {
  let container = document.getElementById('cheese-eyes-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'cheese-eyes-toast-container';
    container.style.cssText = [
      'position: fixed', 'top: 16px', 'right: 16px', 'z-index: 2147483647',
      'display: flex', 'flex-direction: column', 'gap: 8px',
      'pointer-events: none', 'max-width: 340px'
    ].join(';');
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.style.cssText = [
    'background: rgba(20,20,20,0.95)', 'color: #fff', 'border: 1px solid #ffc800',
    'border-radius: 8px', 'padding: 10px 14px', 'font-size: 13px', 'line-height: 1.5',
    "font-family: -apple-system, 'Malgun Gothic', sans-serif",
    'box-shadow: 0 4px 12px rgba(0,0,0,0.4)', 'pointer-events: auto', 'opacity: 0',
    'transition: opacity 0.2s'
  ].join(';');
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 6000);
}

function notifyPlatformLoginRequired(platform) {
  showPlatformNotice(t(
    'instanceLock.liveLoginRequired',
    '{platform} 라이브를 보려면 먼저 {platform}에 로그인해야 합니다.',
    { platform: getPlatformLabel(platform) }
  ));
}

function notifyPlatformCollision(platform) {
  showPlatformNotice(t(
    'instanceLock.liveAccountCollision',
    '{platform} 계정이 다른 곳에서 이미 CHEESE EYES로 사용 중이라, {platform} 라이브가 제한됩니다.',
    { platform: getPlatformLabel(platform) }
  ));
}

// 해당 플랫폼의 라이브 채널(VOD 제외)을 전부 제거한다 — 계정이 다른 곳에서
// 이미 쓰이고 있거나(collision) 로그인이 안 돼 있어서(login) 더 이상 이
// 플랫폼의 라이브를 화면에 올릴 수 없을 때 호출된다.
function removeLiveChannelsForPlatform(platform, reason) {
  const toRemove = channels.filter((c) => c.platform === platform && !c.isVod);
  if (toRemove.length > 0) {
    toRemove.forEach((c) => removeChannel(c.hash));
  }
  if (reason === 'login') notifyPlatformLoginRequired(platform);
  else if (reason === 'collision') notifyPlatformCollision(platform);
}

// 특정 플랫폼의 라이브 계정 잠금을 확보한다. 반환값: 'ok'(확보/이미 보유),
// 'login'(그 플랫폼에 로그인 안 됨), 'collision'(다른 곳에서 이미 사용 중).
async function ensurePlatformLiveLock(platform) {
  if (lockedPlatformKeys.has(platform)) return 'ok';

  const info = await getAccountKeyForPlatform(platform);
  if (!info) return 'login';

  const key = `${info.platform}:${info.id}`;
  try {
    // 플랫폼 키 하나만 단독 클레임한다 — 여러 키를 한 번에 보내면 서버가
    // all-or-nothing으로 처리해 하나만 막혀도 나머지까지 롤백된다
    // (server/src/index.js claimOrHeartbeatAll). 플랫폼별 독립 결과를 위해
    // 반드시 하나씩 호출.
    const result = await callLockServer('/claim', [key], recoverInstanceSessionId
      ? { recoverSessionId: recoverInstanceSessionId }
      : undefined);
    if (result && result.granted) {
      lockedPlatformKeys.set(platform, key);
      return 'ok';
    }
    return 'collision';
  } catch (err) {
    console.warn(`[CHEESE EYES] ${platform} 계정 잠금 확보 실패(페일오픈):`, err);
    return 'ok'; // 서버 연결 불가 시 막지 않는다
  }
}

function releasePlatformLock(platform) {
  const key = lockedPlatformKeys.get(platform);
  if (!key) return;
  lockedPlatformKeys.delete(platform);
  callLockServer('/release', [key]).catch(() => {});
}

// 채널 추가/삭제로 "사용 중인 라이브 플랫폼" 집합이 바뀔 때마다
// saveChannelsToStorage()가 호출해 잠금을 재조정한다. 플랫폼별 독립 처리라
// 한 플랫폼이 막혀도 다른 플랫폼/VOD엔 영향 없음.
async function reconcileInstanceLock() {
  const usedPlatforms = getUsedLivePlatformsFromChannels();

  // 더 이상 라이브로 쓰지 않는 플랫폼은 잠금을 반납한다.
  for (const platform of Array.from(lockedPlatformKeys.keys())) {
    if (!usedPlatforms.has(platform)) releasePlatformLock(platform);
  }

  // 새로 라이브로 쓰기 시작한 플랫폼만 확보를 시도한다(이미 확보돼 있으면
  // ensurePlatformLiveLock이 바로 'ok'를 돌려준다).
  for (const platform of usedPlatforms) {
    if (lockedPlatformKeys.has(platform)) continue;
    if (platformReconcileInFlight.has(platform)) continue;
    platformReconcileInFlight.add(platform);
    ensurePlatformLiveLock(platform).then((status) => {
      platformReconcileInFlight.delete(platform);
      if (status !== 'ok') removeLiveChannelsForPlatform(platform, status);
    }).catch(() => {
      platformReconcileInFlight.delete(platform);
    });
  }
}

async function callLockServer(path, accountKeys, extra) {
  const res = await apiFetch(`${LOCK_SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: instanceSessionId, accountKeys, ...extra })
  });
  return res.json();
}

// 확보한 플랫폼 계정 잠금들을 주기적으로 하트비트해 유효기간을 연장한다.
// 플랫폼별 독립 처리라 한 플랫폼을 다른 곳에 뺏겨도 나머지엔 영향 없음 —
// 뺏기면 해당 라이브만 내리고 알림을 띄운다.
function startPlatformLockHeartbeat() {
  if (instanceLockHeartbeatTimer) return;
  instanceLockHeartbeatTimer = setInterval(async () => {
    for (const [platform, key] of Array.from(lockedPlatformKeys.entries())) {
      try {
        const res = await callLockServer('/heartbeat', [key]);
        if (res && res.granted === false) {
          lockedPlatformKeys.delete(platform);
          removeLiveChannelsForPlatform(platform, 'collision');
        }
      } catch (err) {
        console.warn(`[CHEESE EYES] ${platform} 계정 잠금 하트비트 실패(페일오픈):`, err);
      }
    }
  }, LOCK_HEARTBEAT_MS);
}

// 첫 채널 추가 시 로그인 상태를 바로 알 수 있도록 미리 예열해둔다(막지는 않음).
// PlatformAdapters(유튜브 계정 조회용)는 아래쪽에서 선언되므로, 마이크로
// 태스크로 미뤄 스크립트 평가가 끝난 뒤 실행한다(안 그러면 미초기화 const 참조 에러).
Promise.resolve().then(() => getPlatformAccountKeys().catch(() => {}));
startPlatformLockHeartbeat();

window.addEventListener('beforeunload', () => {
  // release는(claim/heartbeat와 달리) 키별 독립 처리라(all-or-nothing 롤백
  // 없음, server/src/index.js releaseHashes) 여러 개를 묶어 보내도 안전하다.
  if (lockedPlatformKeys.size > 0) {
    callLockServer('/release', [...lockedPlatformKeys.values()]).catch(() => {});
  }
});

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
  chzzk:   { label: '치지직', brand: 'CHZZK',   color: '#00ffa3', enabled: true },
  soop:    { label: '숲',     brand: 'SOOP',    color: '#3385ff', enabled: true },
  youtube: { label: '유튜브', brand: 'YouTube', color: '#FF0000', enabled: true },
  twitch:  { label: '트위치', brand: 'Twitch',  color: '#9146FF', enabled: false }
};

function getPlatformLabel(key) {
  const meta = PLATFORM_META[key];
  return t(`platform.${key}`, meta ? meta.label : key);
}

// 설정 > 최소 시청자수 드롭다운은 UI 언어와 무관하게 항상 공식 영문
// 브랜드명(CHZZK/SOOP/YouTube)으로 표기한다 — 사용자 요청.
function getPlatformBrand(key) {
  const meta = PLATFORM_META[key];
  return (meta && meta.brand) || key;
}

const UI_LANGUAGE_LABELS = { ko: '한국어', en: 'English' };
function getUiLanguageOptions() {
  const supported = (typeof window !== 'undefined' && window.CHEESE_EYES_SUPPORTED_LANGS) || ['ko', 'en'];
  return supported.map(code => ({ value: code, label: UI_LANGUAGE_LABELS[code] || code }));
}

function getPlatformColor(platform) {
  return (PLATFORM_META[platform] && PLATFORM_META[platform].color) || PLATFORM_META.chzzk.color;
}

// 플랫폼별 "최소 시청자수" 설정 기본값. 채널 검색 / 태그 검색 결과에서
// 이 값보다 시청자수가 적은 라이브는 목록에서 제외하는 데 사용한다.
const DEFAULT_MIN_VIEWERS = { chzzk: 10, soop: 10, youtube: 50 };

function getMinViewers(platform) {
  const val = mySetting.minViewers && mySetting.minViewers[platform];
  return (typeof val === 'number' && !isNaN(val)) ? val : (DEFAULT_MIN_VIEWERS[platform] || 0);
}

// 실험실(설정 > 실험실) 기능 게이트. "실험적 기능" 총 스위치가 꺼져 있으면
// 하위 항목이 켜져 있어도(과거에 켜뒀던 값이 저장돼 있어도) 절대 적용되지
// 않는다 — 실험실 자체를 끄면 모든 실험적 동작이 한 번에 원상 복귀되어야
// 하기 때문.
function isExperimentalEnabled() {
  return !!mySetting.experimentalEnabled;
}

function isAudioOptimizationEnabled() {
  return isExperimentalEnabled() && !!mySetting.audioOptimizationEnabled;
}

function isCollabSettingEnabled() {
  return isExperimentalEnabled() && !!mySetting.collabSettingEnabled;
}

// "합방 설정" 하위의 AI 음성 감지(Silero VAD, §10) 서브 토글 — 합방
// 자체가 꺼져 있으면 당연히 의미가 없다.
function isCollabVadEnabled() {
  return isCollabSettingEnabled() && !!mySetting.collabVadEnabled;
}

// "합방 설정" 하위의 VOD 싱크 동기화(실험적,
// docs/vod-collab-sync-architecture.md) 서브 토글 — 라이브 겹침 감지와
// 완전히 다른 그룹 모드('vod-sync')를 켤 수 있게 해준다. 합방 설정
// 자체가 꺼지면(isCollabSettingEnabled) 기존 그룹의 mode 값과 무관하게
// vod-sync 동작도 같이 꺼진다(recomputeCollabMuting의 조기 반환).
function isVodSyncSettingEnabled() {
  return isCollabSettingEnabled() && !!mySetting.vodSyncEnabled;
}

// 실험실 게이트와 무관한 일반 진단 토글. "디버그 모드"는 실험실의
// "실험적 기능"과 같은 구조의 상위 스위치일 뿐이고(§설정 > 디버그), 실제로
// 뭘 보여줄지는 그 아래 두 하위 스위치가 각각 결정한다 — 상위가 꺼지면
// 하위가 켜져 있어도(과거에 켜뒀던 값이 저장돼 있어도) 전부 꺼진다.
function isDebugModeEnabled() {
  return !!mySetting.debugMode;
}

// 채널별 오디오 패널에 dB 파형/합방 분석 원본값을 표시할지
// (§renderChannelDebugPanel).
function isAudioDebugSectionEnabled() {
  return isDebugModeEnabled() && !!mySetting.audioDebugEnabled;
}

// 방송 종료 후 다시보기(VOD) 선택 패널을 디버그 패널에서 시뮬레이션할 수
// 있게 할지(§renderVodDebugSection, docs/vod-replay-architecture.md §8).
function isVodDebugSectionEnabled() {
  return isDebugModeEnabled() && !!mySetting.vodDebugEnabled;
}

// 다이나믹 컴프레서는 별도 토글 없이 "오디오 최적화"의 일부로 항상 같이
// 켜진다(사용자 요청). docs/audio-architecture.md §5.5.
function isDynamicsCompressorEnabled() {
  return isAudioOptimizationEnabled();
}

// 그리드 모드와 메인-서브 모드(서브)의 기준 음량은 오직 설정 화면에서만
// 바꿀 수 있다. 채널별 오디오 패널의 슬라이더는 이 기준 음량을 건드리지
// 않고, 대신 그 채널의 "수동 고정값"(getChannelOverride)을 다룬다.
function getGridDefaultVolume() {
  const val = mySetting.gridVolume;
  return (typeof val === 'number' && !isNaN(val)) ? val : DEFAULT_CHANNEL_VOLUME;
}

function getSubDefaultVolume() {
  const val = mySetting.subVolume;
  return (typeof val === 'number' && !isNaN(val)) ? val : DEFAULT_CHANNEL_VOLUME;
}

// "오디오 최적화"가 꺼져 있으면(UI도 숨김) 그리드/서브 기준 음량 설정은
// 의미가 없다 — 역할과 무관하게 기본값 100%로 재생, dB 평준화도 미지원.
function getChannelBaselineVolume(hash) {
  if (!isAudioOptimizationEnabled()) return DEFAULT_CHANNEL_VOLUME;
  return getChannelRole(hash) === 'sub' ? getSubDefaultVolume() : getGridDefaultVolume();
}

// 채널별 오디오 패널에서 슬라이더를 직접 조작하면 그 채널은 dB 자동 보정
// 대상에서 빠지고 그 값으로 고정된다("수동 고정값"). 그리드/메인-서브는
// 같은 채널도 다른 화면 구성이므로 고정값도 역할별로 따로 저장한다 —
// 그리드 고정값이 메인-서브 모드로 새어 들어가지 않게 하기 위함.
function getChannelOverride(hash) {
  const role = getChannelRole(hash);
  if (role === 'main') return null;
  const group = audioState.channelVolumeOverrides && audioState.channelVolumeOverrides[role];
  const override = group && group[hash];
  return (typeof override === 'number' && !isNaN(override)) ? override : null;
}

function setChannelOverride(hash, vol) {
  const role = getChannelRole(hash);
  if (role === 'main') return;
  if (!audioState.channelVolumeOverrides) audioState.channelVolumeOverrides = { grid: {}, sub: {} };
  if (!audioState.channelVolumeOverrides[role]) audioState.channelVolumeOverrides[role] = {};
  audioState.channelVolumeOverrides[role][hash] = vol;
}

function clearChannelOverride(hash) {
  const role = getChannelRole(hash);
  if (role === 'main') return;
  const group = audioState.channelVolumeOverrides && audioState.channelVolumeOverrides[role];
  if (group) delete group[hash];
}

// 예전엔 메인 볼륨이 채널 구분 없는 공용 값(audioState.mainVolume) 하나였다.
// 이제는 채널별로 "이 채널이 메인일 때 쓸 볼륨"을 따로 기억한다
// (audioState.mainVolumeByChannel[hash]) — 원래 작은 채널은 100%, 원래 큰
// 채널은 80%처럼 서로 다른 값을 유지한 채 번갈아 메인이 될 수 있다.
// 채널 전용 값이 없으면(최초 전환/이전 데이터) 예전 공용 값을 1회성
// 기본값으로 쓰고, 그것도 없으면 DEFAULT_MAIN_VOLUME으로 폴백한다 — 한 번
// 저장되면(setMainVolumeForChannel) 그 뒤론 공용 값과 무관해진다.
function getMainVolumeForChannel(hash) {
  if (!hash) return DEFAULT_MAIN_VOLUME;
  const stored = audioState.mainVolumeByChannel && audioState.mainVolumeByChannel[hash];
  if (typeof stored === 'number' && !isNaN(stored)) return stored;
  if (typeof audioState.mainVolume === 'number' && !isNaN(audioState.mainVolume)) return audioState.mainVolume;
  return DEFAULT_MAIN_VOLUME;
}

function setMainVolumeForChannel(hash, vol) {
  if (!hash) return;
  if (!audioState.mainVolumeByChannel) audioState.mainVolumeByChannel = {};
  audioState.mainVolumeByChannel[hash] = vol;
}

// 저장돼 있던 뮤트(0%) 상태를 전부 지운다 — 메인 볼륨이 0이면 기본값으로,
// 그리드/서브 오버라이드가 0이면 오버라이드 자체를 지워 역할 기본값을
// 따르게 한다. 0이 아닌 값은 건드리지 않는다. 뭔가 바뀌면 true 반환.
function resetMutedAudioStateOnLoad() {
  let changed = false;
  if (audioState.mainVolume === 0) {
    audioState.mainVolume = DEFAULT_MAIN_VOLUME;
    changed = true;
  }
  if (audioState.mainVolumeByChannel) {
    Object.keys(audioState.mainVolumeByChannel).forEach((hash) => {
      if (audioState.mainVolumeByChannel[hash] === 0) {
        audioState.mainVolumeByChannel[hash] = DEFAULT_MAIN_VOLUME;
        changed = true;
      }
    });
  }
  const overrides = audioState.channelVolumeOverrides;
  if (overrides) {
    ['grid', 'sub'].forEach((role) => {
      const group = overrides[role];
      if (!group) return;
      Object.keys(group).forEach((hash) => {
        if (group[hash] === 0) {
          delete group[hash];
          changed = true;
        }
      });
    });
  }
  return changed;
}

// 사실상 무음(오디오 트랙 없음/마이크 꺼짐)인 채널은 dB 평준화 대상에서
// 완전히 제외한다 — 기준 후보에서도, 자신의 감쇠 계산에서도 빠져 기준
// 음량 그대로 재생된다(무음을 기준 삼으면 나머지 전부가 거의 무음까지
// 깎임). 다시 커지면 다음 측정 주기에 자동으로 대상에 포함된다.
//
// docs/audio-architecture.md §5(K-weighted LUFS 전환) 이전엔 이 값이 dBFS
// 풀스케일 대비 진폭 비율(-40dB=1%)이었다. LUFS는 절대 단위라 그 정의를
// 재사용할 수 없고, BS.1770 절대 게이트(-70 LUFS)는 라우드니스 적분 제외용
// 이라 무음 판정과 용도가 달라 그대로 못 쓴다. 아래는 §5.6 잠정값(-50
// LUFS)이며, 실측 데이터로 재보정 전까지 확정치 아님.
const MIN_VALID_REFERENCE_DB = -50; // LUFS, 잠정값 — docs/audio-architecture.md §5.6

// 'sub'는 메인을 포함하지 않는다 — 메인은 항상 고정 음량으로 감쇠 대상이
// 아니라 서브 그룹의 감쇠 기준(getMainReferenceDbAtBaseline)으로만 쓰인다.
// 'grid'는 특정 채널 없이 전 채널(메인 지정 채널 포함)을 동등하게 평준화한다.
//
// 두 그룹 다 합방 멤버 중 리더만 포함한다 — 비리더 멤버는 이미 별도
// 로직(겹침 음소거/기준의 최대 10%, getDisplayVolumeForChannel)으로
// 처리되므로 "제일 조용한 채널" 후보에 넣으면 나머지가 불필요하게 더 깎인다.
//
// 유튜브 VOD/특정 영상 고정 항목은 예전엔 여기서 제외됐지만, 비동기
// 메타데이터 조회 완료 전엔 제외가 적용 안 돼 추가 타이밍에 따라 값이
// 들쭉날쭉했다(3%, 0%, 48%...). 사용자 요청으로 특수 취급을 없애고 일반
// 라이브 채널과 동일하게 다룬다.
function getGroupHashes(role) {
  const base = role === 'sub'
    ? displayChannels.filter(c => c.hash !== mainChannel)
    : displayChannels;
  return base.filter(c => !isNonLeaderCollabMember(c.hash)).map(c => c.hash);
}

// 선형보간 방식으로 백분위수를 계산한다. sortedAsc는 오름차순 정렬된
// 숫자 배열이어야 한다.
function percentileOf(sortedAsc, p) {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// 그룹 dB 평준화 비교에서 최신 측정치 1개만 보면 짧은 정적이나 순간
// 스파이크에도 기준(가장 조용한 채널)이 바뀌어 감쇠가 매초 요동쳤다.
// 메인 전용 getMainAverageDb()(§3.7)가 쓰는 "최근 샘플 사분위 트림 평균"을
// 전 채널로 일반화해 "최근 몇 초간 평소 크기"로 비교한다.
const CHANNEL_LEVELING_HISTORY_MAX_SAMPLES = 25; // content.js LEVEL_REPORT_INTERVAL_MS(200ms) 기준 약 5초
const CHANNEL_LEVELING_HISTORY_MIN_SAMPLES = 10; // 원래 500ms 기준 4개(≈2초) 비율 유지
let channelLevelingDbHistory = {};

function pushChannelLevelingDb(hash, db) {
  const arr = channelLevelingDbHistory[hash] || (channelLevelingDbHistory[hash] = []);
  arr.push(db);
  if (arr.length > CHANNEL_LEVELING_HISTORY_MAX_SAMPLES) arr.shift();
}

// 이 채널의 "평소" dB — 샘플이 아직 부족하면(막 추가된 채널 등) 최신
// 측정치 1개로 폴백한다.
function getChannelLevelingDb(hash) {
  const arr = channelLevelingDbHistory[hash];
  const latest = channelAudioLevels[hash];
  const latestFallback = (typeof latest === 'number' && isFinite(latest)) ? latest : null;
  if (!arr || arr.length < CHANNEL_LEVELING_HISTORY_MIN_SAMPLES) return latestFallback;
  const valid = arr.filter((db) => typeof db === 'number' && isFinite(db) && db >= MIN_VALID_REFERENCE_DB);
  if (valid.length < CHANNEL_LEVELING_HISTORY_MIN_SAMPLES) return latestFallback;
  const sorted = valid.slice().sort((a, b) => a - b);
  const q1 = percentileOf(sorted, 0.25);
  const q3 = percentileOf(sorted, 0.75);
  const trimmed = valid.filter((db) => db >= q1 && db <= q3);
  if (trimmed.length === 0) return (q1 + q3) / 2;
  return trimmed.reduce((sum, db) => sum + db, 0) / trimmed.length;
}

// "기준 채널"이 계속 바뀌는 걸 막는 히스테리시스 — 사용자 요청. 각 채널
// dB는 이미 ~5초 트림 평균으로 스무딩되지만, "누가 가장 조용한가" 순위는
// 두 채널 dB가 엇갈리는 순간 즉시 뒤바뀌어 나머지 전부가 다시 계산되고,
// 말을 멈췄다 시작할 때마다 그룹 음량이 출렁였다. 합방 겹침 감지와 같은
// 원리(§COLLAB_MUTE_SUSTAIN_MS)로, 도전자가 이 시간 이상 계속 더 조용해야
// 기준을 넘겨받는다.
const REFERENCE_SWITCH_SUSTAIN_MS = 3000;
// groupKey('grid'|'sub') -> 지금 잠겨 있는 기준 채널의 hash.
let groupReferenceHash = {};
// groupKey -> { hash, since } — 기존 기준보다 더 조용한 도전자가 언제부터
// 계속 최솟값이었는지. 도전자가 바뀌면(다른 채널이 새로 제일 조용해지면)
// 그 시점부터 다시 잰다.
let groupReferenceChallengerSince = {};

// 버그 수정: 위 히스테리시스만으론 부족했다 — 기준 채널 정체성은 안
// 바뀌어도 그 채널 자신의 말하기 기복으로 getChannelLevelingDb가 계속
// 오르내리고, MAX_GROUP_DB_DIFFERENCE 감쇠에 하한이 없어(§getChannelDbAttenuation)
// 나머지 채널 전부가 진동했다. 그래서 "기준 dB 값" 자체도 더 긴 시간
// 상수로 지수 스무딩한다 — 기준 채널이 바뀌어도 이 스무딩을 이어서 탄다.
const GROUP_REFERENCE_DB_SMOOTHING_TIME_CONSTANT_SEC = 10;
let smoothedGroupReferenceDb = {}; // groupKey -> 스무딩된 기준 dB
let smoothedGroupReferenceDbUpdatedAt = {}; // groupKey -> 마지막 갱신 시각(ms)

function smoothGroupReferenceDb(groupKey, targetDb) {
  const now = Date.now();
  const prev = smoothedGroupReferenceDb[groupKey];
  const prevAt = smoothedGroupReferenceDbUpdatedAt[groupKey];
  smoothedGroupReferenceDbUpdatedAt[groupKey] = now;
  if (typeof prev !== 'number' || !isFinite(prev) || typeof prevAt !== 'number') {
    smoothedGroupReferenceDb[groupKey] = targetDb;
    return targetDb;
  }
  const dtSec = Math.max(0, (now - prevAt) / 1000);
  const alpha = 1 - Math.exp(-dtSec / GROUP_REFERENCE_DB_SMOOTHING_TIME_CONSTANT_SEC);
  const next = prev + (targetDb - prev) * alpha;
  smoothedGroupReferenceDb[groupKey] = next;
  return next;
}

// 그룹의 "기준 채널"(감쇠 없이 기준 음량 그대로 재생) dB — 측정된 채널 중
// 가장 조용한 채널이 그룹의 최대 음량이 된다. 유효 측정치가 없으면(로딩
// 직후 등) null(호출부는 보정 없이 기준 음량 그대로 재생). groupKey는
// 히스테리시스 상태를 그리드/서브별로 추적하는 키.
function getGroupReferenceDb(hashes, groupKey) {
  let rawMinHash = null;
  let rawMinDb = null;
  hashes.forEach((hash) => {
    const db = getChannelLevelingDb(hash);
    if (typeof db !== 'number' || !isFinite(db) || db < MIN_VALID_REFERENCE_DB) return;
    if (rawMinDb === null || db < rawMinDb) {
      rawMinDb = db;
      rawMinHash = hash;
    }
  });
  if (rawMinHash === null) {
    delete groupReferenceHash[groupKey];
    delete groupReferenceChallengerSince[groupKey];
    delete smoothedGroupReferenceDb[groupKey];
    delete smoothedGroupReferenceDbUpdatedAt[groupKey];
    return null;
  }

  const currentHash = groupReferenceHash[groupKey];
  const currentDb = currentHash ? getChannelLevelingDb(currentHash) : null;
  const currentIsValid = !!currentHash
    && hashes.includes(currentHash)
    && typeof currentDb === 'number' && isFinite(currentDb) && currentDb >= MIN_VALID_REFERENCE_DB;

  let targetDb;
  if (!currentIsValid) {
    // 기존 기준이 없거나(최초) 더는 유효하지 않다(그룹을 떠났거나 무음이
    // 됨) — 대체할 다른 기준이 없으므로 히스테리시스 없이 즉시 넘겨받는다.
    groupReferenceHash[groupKey] = rawMinHash;
    delete groupReferenceChallengerSince[groupKey];
    targetDb = rawMinDb;
  } else if (rawMinHash === currentHash) {
    // 기존 기준이 여전히 가장 조용함 — 도전자 없음.
    delete groupReferenceChallengerSince[groupKey];
    targetDb = currentDb;
  } else {
    // 다른 채널이 지금 기존 기준보다 더 조용하다 — 도전자로 기록하고, 이
    // 상태가 REFERENCE_SWITCH_SUSTAIN_MS 이상 유지돼야 실제로 넘겨준다.
    const now = Date.now();
    const challenger = groupReferenceChallengerSince[groupKey];
    if (!challenger || challenger.hash !== rawMinHash) {
      groupReferenceChallengerSince[groupKey] = { hash: rawMinHash, since: now };
      targetDb = currentDb;
    } else if (now - challenger.since >= REFERENCE_SWITCH_SUSTAIN_MS) {
      groupReferenceHash[groupKey] = rawMinHash;
      delete groupReferenceChallengerSince[groupKey];
      targetDb = rawMinDb;
    } else {
      targetDb = currentDb;
    }
  }
  return smoothGroupReferenceDb(groupKey, targetDb);
}

// 버그 수정: 예전엔 감쇠 배율에 하한(0.25, 최대 -12dB)을 둬서 diffDb가
// 12dB 넘는(아주 시끄러운) 채널은 초과분이 그대로 남아 기준과 5dB 넘게
// 차이 났다. 하한을 없애고 diffDb가 5dB(MAX_GROUP_DB_DIFFERENCE) 넘는
// 초과분만 깎아 항상 이 한도 안에 들어오게 했다(5dB 이내면 손대지 않음).
// 그리드/서브 모두 같은 getGroupReferenceDb(그룹 최솟값) 기준을 쓴다.
const MAX_GROUP_DB_DIFFERENCE = 5; // dB — 이 값을 넘는 초과분만 깎는다

// 채널의 "평소" dB를 기준 dB(그룹 최솟값, getGroupEffectiveVolumeForChannel
// 참고)와 비교해 격차가 MAX_GROUP_DB_DIFFERENCE(5dB) 안에 들어오도록
// 조절할 배율을 계산한다. 기준보다 5dB 넘게 시끄러운 채널만 초과분만큼
// 깎는다. 증폭은 하지 않도록 항상 1(기준 음량)로 캡한다.
function getChannelDbAttenuation(hash, referenceDb) {
  const db = getChannelLevelingDb(hash);
  if (referenceDb === null || typeof db !== 'number' || !isFinite(db) || db < MIN_VALID_REFERENCE_DB) return 1;
  const diffDb = db - referenceDb;
  const excessDb = Math.max(0, diffDb - MAX_GROUP_DB_DIFFERENCE);
  return Math.min(1, Math.pow(10, -excessDb / 20));
}

// getChannelDbAttenuation과 같은 로그 스케일 계산이지만 "허용 격차"
// 개념이 없다 — diffDb 전체를 깎아 완전히 맞춘다. 그 허용 격차를 "서브는
// 메인보다 크면 안 된다" 제약(getMainReferenceDbAtBaseline)에도 그대로
// 적용했더니, 메인이 원래 아주 조용하면 서브를 충분히 못 낮춰 "메인을
// 최대로 올려도 서브가 더 크게 들리는" 버그가 있었다. "서브 ≤ 메인"은
// 예외 없이 보장돼야 하므로 이 하드 캡엔 허용 격차를 두지 않는다.
function getChannelDbAttenuationVsMain(hash, referenceDb) {
  const db = getChannelLevelingDb(hash);
  if (referenceDb === null || typeof db !== 'number' || !isFinite(db) || db < MIN_VALID_REFERENCE_DB) return 1;
  const diffDb = db - referenceDb;
  return Math.min(1, Math.pow(10, -diffDb / 20));
}

// 현재 메인 채널 전용 dB 샘플 누적 이력 — 이 채널이 메인인 동안 계속
// 쌓인다. 메인이 바뀌면 자동 초기화된다(mainDbSamplesHash로 자체 감지 —
// mainChannel이 바뀌는 지점이 여러 곳이라 각각 초기화하는 대신, 다음
// push/조회 시점에 추적 중인 해시와 다르면 그때 비운다).
let mainDbSamples = [];
let mainDbSamplesHash = null;

function pushMainDbSample(hash, db) {
  if (!mainChannel || hash !== mainChannel) return;
  if (mainDbSamplesHash !== mainChannel) {
    mainDbSamplesHash = mainChannel;
    mainDbSamples = [];
  }
  mainDbSamples.push(db);
}

// 최신 측정치 1개만 보면 순간 스파이크로 "메인의 평소 dB"가 과대평가될 수
// 있다. 너무 조용한 샘플(MIN_VALID_REFERENCE_DB 미만)을 먼저 거르고,
// 사분위 범위(IQR) 밖의 값을 다시 잘라낸 뒤 남은 값들의 평균을 쓴다.
// 유효 샘플이 부족하면(전환 직후 등) 최신 측정치로 폴백한다.
const MAIN_DB_MIN_SAMPLES = 10; // 원래 500ms 기준 4개(≈2초) 비율 유지

function getMainAverageDb() {
  if (!mainChannel || mainDbSamplesHash !== mainChannel) {
    const latest = channelAudioLevels[mainChannel];
    return (typeof latest === 'number' && isFinite(latest)) ? latest : null;
  }
  const valid = mainDbSamples.filter((db) => typeof db === 'number' && isFinite(db) && db >= MIN_VALID_REFERENCE_DB);
  if (valid.length < MAIN_DB_MIN_SAMPLES) {
    const latest = channelAudioLevels[mainChannel];
    return (typeof latest === 'number' && isFinite(latest)) ? latest : null;
  }
  const sorted = valid.slice().sort((a, b) => a - b);
  const q1 = percentileOf(sorted, 0.25);
  const q3 = percentileOf(sorted, 0.75);
  const trimmed = valid.filter((db) => db >= q1 && db <= q3);
  if (trimmed.length === 0) return (q1 + q3) / 2;
  return trimmed.reduce((sum, db) => sum + db, 0) / trimmed.length;
}

// 그리드/서브 채널끼리만 비교해서 감쇠하면(다들 비슷하면 거의 감쇠 안 됨)
// 원본 음량이 메인보다 큰 채널이 그대로 메인보다 크게 들리는 문제가 있었다.
// 메인은 고정값 그대로 재생(감쇠 대상 아님)하고, 나머지는 "메인을 지금
// 볼륨으로 들을 때의 체감 음량을 이 그룹 기준 음량으로 환산하면 몇 dB인지"
// 상한을 받는다 — getGroupEffectiveVolumeForChannel이 이 값과 그룹 기준 중
// 더 낮은 쪽으로 감쇠한다. 메인이 음소거거나 측정치가 없으면 null(캡 없음).
function getMainReferenceDbAtBaseline(groupBaseline) {
  if (!mainChannel || groupBaseline <= 0) return null;
  const mainVolume = getMainVolumeForChannel(mainChannel);
  if (mainVolume <= 0) return null;
  const mainDb = getMainAverageDb();
  if (typeof mainDb !== 'number' || !isFinite(mainDb) || mainDb < MIN_VALID_REFERENCE_DB) return null;
  const mainPerceivedDb = mainDb + 20 * Math.log10(mainVolume / 100);
  return mainPerceivedDb - 20 * Math.log10(groupBaseline / 100);
}

// 그룹(그리드 전체 또는 서브 그룹) 안에서 dB 평준화까지 반영한 채널의
// 실제 재생 음량. "기준 음량"은 항상 유지하고 그 위에 감쇠만 추가한다.
// "오디오 최적화"가 꺼져 있으면 감쇠를 건너뛰고 기준 음량 그대로 재생한다.
//
// 'sub'만 메인 기준 상한(getMainReferenceDbAtBaseline)을 추가로 받고,
// 나머지는 'grid'/'sub' 둘 다 그룹에서 제일 조용한 채널 기준으로 동등하게
// 평준화한다(사용자 요청으로 서브도 그리드와 같은 최솟값 기준으로 통일 —
// 예전 그룹 평균 기준 방식은 유독 조용한 서브가 있어도 그 채널 자신은
// 여전히 작게 들려 "균등화" 체감이 약했다).
function getGroupEffectiveVolumeForChannel(hash, role) {
  const baseline = getChannelBaselineVolume(hash);
  if (!isAudioOptimizationEnabled()) return baseline;
  // 유튜브 "특정 영상 고정" 항목은 예전엔 여기서 제외돼 항상 기준 음량
  // 그대로 재생됐다 — 유튜브 자체 라우드니스 정규화로 원본이 대체로
  // 조용하게 측정돼 "이 영상만 유독 작다"는 증상이 있었다. 사용자 요청으로
  // 특수 취급을 없애고 일반 라이브 채널과 동일하게 그룹 비교를 받는다
  // (getGroupHashes도 더는 이 채널들을 후보에서 빼지 않음). 증상이 재발하면
  // 원인은 그룹 비교가 아니라 개별 측정치(유튜브 라우드니스 정규화) 쪽일 가능성이 높다.
  const groupHashes = getGroupHashes(role);
  // "그룹에서 가장 조용한 채널" 기준(감쇠만, 증폭 없음). role을 그대로
  // 히스테리시스 상태 키로 쓴다 — 두 그룹은 후보 집합이 달라 기준도 독립 추적된다.
  const referenceDb = getGroupReferenceDb(groupHashes, role);
  let attenuation = getChannelDbAttenuation(hash, referenceDb);
  if (role === 'sub') {
    // "서브는 메인보다 크면 안 된다"는 별도 하드 캡 — attenuation과
    // 독립적으로 계산해 더 많이 깎는 쪽을 쓴다. 같은 referenceDb에 합치면
    // MAX_GROUP_DB_DIFFERENCE 허용 격차가 이 캡에도 적용돼, 메인이 아주
    // 조용할 때 서브를 충분히 못 낮추는 버그가 있었다(getChannelDbAttenuationVsMain 참고).
    const mainCapDb = getMainReferenceDbAtBaseline(baseline);
    if (mainCapDb !== null) {
      const mainAttenuation = getChannelDbAttenuationVsMain(hash, mainCapDb);
      attenuation = Math.min(attenuation, mainAttenuation);
    }
  }
  return Math.round(baseline * attenuation);
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

// ── 한글 로마자 음역(발음 기반 차자표기) — 오프라인 폴백용 ─────────────────
// 평소에는 구글 번역의 dt=rm(음역) 옵션으로 음역을 받아오지만, 네트워크
// 실패 등으로 그게 안 될 때를 대비한 최소한의 로컬 대체 수단이다. 국립
// 국어원 로마자 표기법을 단순화해 한글 음절을 소리 나는 대로 그대로
// 로마자로 옮겨 적는다(예: '모리 칼리오페' -> 'mori kariope'). 한글이
// 아닌 문자(공백, 영문, 숫자 등)는 그대로 둔다. 표의문자(한자 등)는
// 글자 자체에 고정된 발음이 없어 이 방식으로는 처리할 수 없다.
const HANGUL_INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const HANGUL_MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const HANGUL_FINALS = ['', 'g', 'kk', 'gs', 'n', 'nj', 'nh', 'd', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h'];

function romanizeHangulText(text) {
  const s = String(text || '');
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const base = code - 0xAC00;
      const initial = Math.floor(base / (21 * 28));
      const medial = Math.floor((base % (21 * 28)) / 28);
      const final = base % 28;
      out += HANGUL_INITIALS[initial] + HANGUL_MEDIALS[medial] + HANGUL_FINALS[final];
    } else {
      out += ch;
    }
  }
  return out;
}

const PlatformAdapters = {
  chzzk: {
    async _fetchChannelSearchRaw(keyword, size = 20) {
      try {
        const res = await apiFetch(`https://api.chzzk.naver.com/service/v1/search/channels?keyword=${encodeURIComponent(keyword)}&offset=0&size=${size}&withFirstChannelContent=true`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.content && data.content.data ? data.content.data : [];
      } catch (e) { return []; }
    },
    async searchAutocomplete(keyword, size = 10) {
      try {
        const queries = [keyword];
        const dataLists = await Promise.all(queries.map(q => this._fetchChannelSearchRaw(q)));

        const seenChannelId = new Set();
        const rawChannels = [];
        dataLists.forEach(list => {
          list.forEach(entry => {
            const c = entry.channel;
            if (!c || !c.channelId || !c.channelName || seenChannelId.has(c.channelId)) return;
            seenChannelId.add(c.channelId);
            rawChannels.push(c);
          });
        });

        const checked = await Promise.all(rawChannels.map(async (c) => {
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
        const queries = [name];
        for (const q of queries) {
          const list = await this._fetchChannelSearchRaw(q, 33);
          if (list.length > 0) {
            const c = list[0].channel;
            return { platform: 'chzzk', hash: c.channelId, name: c.channelName };
          }
        }
      } catch (err) { console.error(`'${name}' 치지직 채널 검색 실패:`, err); }
      return null;
    },
    // 라이브 여부와 무관하게 이름으로 후보를 찾는다(프리셋 채널 검색용).
    async searchCandidatesByKeyword(keyword) {
      const list = await this._fetchChannelSearchRaw(keyword, 33);
      const seen = new Set();
      const raw = [];
      list.forEach(entry => {
        const c = entry.channel;
        if (!c || !c.channelId || !c.channelName || seen.has(c.channelId)) return;
        seen.add(c.channelId);
        raw.push(c);
      });

      return await Promise.all(raw.map(async (c) => ({
        platform: 'chzzk',
        hash: c.channelId,
        name: c.channelName,
        live: await checkChzzkLiveByChannelId(c.channelId)
      })));
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
    // 방송 종료 채널의 VOD 목록 — docs/vod-replay-architecture.md §1. 비공식
    // 엔드포인트라 실패/스펙 변경 시 빈 배열로 폴백(호출부는 "다시보기 없음"과 동일 처리).
    // cursor는 페이지 번호(기본 0), "/vod" 모달 무한 스크롤용 nextCursor를
    // 돌려준다(§renderVodSearchModalList). 응답에 "다음 페이지 존재 여부"
    // 필드가 없어서, size만큼 꽉 채워 왔으면 다음 페이지 번호를 돌려주고
    // 실제로 없으면 다음 호출이 빈 배열로 자연스럽게 멈춘다.
    async getChannelVideos(channelId, size = 10, cursor = 0) {
      try {
        const page = typeof cursor === 'number' ? cursor : 0;
        const url = new URL(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/videos`);
        url.searchParams.set('sortType', 'LATEST');
        url.searchParams.set('pagingType', 'PAGE');
        url.searchParams.set('page', String(page));
        url.searchParams.set('size', String(size));
        const res = await apiFetch(url.toString());
        if (!res.ok) return { items: [], nextCursor: null };
        const data = await res.json();
        const list = data.content && data.content.data ? data.content.data : [];
        const items = list
          .filter(v => v && v.videoNo)
          .map(v => ({
            videoNo: v.videoNo,
            title: v.videoTitle || '',
            thumbnail: v.thumbnailImageUrl || '',
            duration: v.duration || 0,
            readCount: v.readCount || 0,
            publishDate: v.publishDate || ''
          }));
        return { items, nextCursor: items.length >= size ? page + 1 : null };
      } catch (err) {
        console.error(`[CHEESE EYES] ${channelId} 치지직 다시보기 목록 조회 실패:`, err);
        return { items: [], nextCursor: null };
      }
    },
    // 치지직 VOD 상세 정보 — 목록 API(getChannelVideos)에는 없는
    // liveOpenDate(방송 시작 시각, 초 단위)/livePv(라이브 세션 식별자)/
    // prevVideo·nextVideo(긴 라이브가 여러 VOD로 쪼개졌을 때 앞뒤 조각)를
    // 준다. VOD 합방 싱크 동기화의 메타데이터 기반 자동 오프셋 계산
    // (calculateChzzkVodStartTime)이 쓴다. 참고: github.com/AINukeHere/
    // VOD-Master의 ChzzkAPI.GetChzzkVodInfo와 같은 엔드포인트.
    async getVodDetail(videoNo) {
      try {
        const res = await apiFetch(`https://api.chzzk.naver.com/service/v2/videos/${videoNo}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.content || null;
      } catch (err) {
        console.error(`[CHEESE EYES] ${videoNo} 치지직 VOD 상세 조회 실패:`, err);
        return null;
      }
    },
    // VOD 합방 싱크 동기화 앵커 인터페이스(§docs/vod-collab-sync-
    // architecture.md §10.2) — 채널(hash=videoNo)의 실제 방송 시작
    // 시각을 epoch ms로 돌려준다. 실패 시 null(치지직 VOD가 아니거나
    // liveOpenDate가 없는 경우 등, calculateChzzkVodStartTime 참고).
    async getVodStartTime(ch) {
      const detail = await this.getVodDetail(ch.hash);
      if (!detail) return null;
      const start = calculateChzzkVodStartTime(detail);
      return start ? start.getTime() : null;
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
              const viewers = typeof item.concurrentUserCount === 'number' ? item.concurrentUserCount : null;
              if (viewers != null && viewers < getMinViewers('chzzk')) return;
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
    getVideoEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      return (ch && ch.isVod) ? `https://chzzk.naver.com/video/${id}` : `https://chzzk.naver.com/live/${id}`;
    },
    getChatEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      // VOD(다시보기)는 실시간 채팅 전용 iframe이 없다 — VOD 시청 페이지
      // 자체를 cheeseChatEmbed 마커를 붙여 불러오고, content.js가 채팅
      // aside(#vod-aside)만 뷰포트 전체로 끌어올린다
      // (§docs/vod-chat-architecture.md).
      if (ch && ch.isVod) {
        return `https://chzzk.naver.com/video/${id}?cheeseChatEmbed=1`;
      }
      return `https://chzzk.naver.com/live/${id}/chat`;
    },
    getChannelHomeUrl(id) {
      // VOD 채널은 hash가 채널ID가 아니라 그 영상의 videoNo다(§ 다시보기
      // 목록/피커에서 채널을 이 영상 하나로 대체할 때 hash에 videoNo를
      // 그대로 쓰기 때문 — §openVodSearchModal, §renderVodPickerList). 그
      // videoNo를 그대로 채널 홈 URL에 넣으면 "존재하지 않는 채널"로
      // 뜬다 — 실제 채널ID는 별도로 저장해둔 channelId를 써야 한다.
      const ch = getChannelObjByHash(id);
      if (ch && ch.isVod && ch.channelId) return `https://chzzk.naver.com/${ch.channelId}`;
      return `https://chzzk.naver.com/${id}`;
    },
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
        const queries = [keyword];
        const seen = new Set();
        const items = [];
        for (const q of queries) {
          const list = await this._liveSearch(q, { count: size });
          const kw = String(q || '').trim().toLowerCase();
          for (const raw of list) {
            const text = String(raw.user_nick || raw.user_id || '').trim();
            if (!text || seen.has(text)) continue;
            // 검색어를 포함하지 않는 연관 검색어(느슨한 매칭 결과)는 목록에서 제외한다.
            if (kw && !text.toLowerCase().includes(kw)) continue;
            seen.add(text);
            items.push({ platform: 'soop', type: 'bj', text, user_id: raw.user_id || '', broadNo: raw.broad_no || '' });
            if (items.length >= size) break;
          }
          if (items.length >= size) break;
        }
        return items;
      } catch (e) { return []; }
    },
    async searchChannelByName(name) {
      const queries = [name];
      for (const q of queries) {
        const list = await this._liveSearch(q);
        const first = list[0];
        if (first && String(first.user_nick || '').trim() === String(q).trim()) {
          return this._toChannelData(first);
        }
      }
      return null;
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
    // 라이브 여부와 무관하게 이름으로 후보를 찾는다(프리셋 채널 검색용).
    async searchCandidatesByKeyword(keyword) {
      const list = await this._liveSearch(keyword, { count: 20 });
      const seen = new Set();
      const results = [];
      list.forEach(raw => {
        const ch = this._toChannelData(raw);
        if (!ch || seen.has(ch.hash)) return;
        seen.add(ch.hash);
        results.push(ch);
      });
      return results;
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
          const viewers = item.total_view_cnt ?? item.view_cnt ?? item.m_current_view_cnt;
          const viewersNum = viewers != null ? Number(viewers) : null;
          if (viewersNum != null && !isNaN(viewersNum) && viewersNum < getMinViewers('soop')) return;
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
          console.warn(`[숲] 태그 '${keyword}' 요청 실패 (status=${res.status})`);
          return map;
        }
        const data = await res.json();
        const list = data?.REAL_BROAD;
        if (!Array.isArray(list)) {
          console.warn(`[숲] 태그 '${keyword}' 응답에서 REAL_BROAD 배열을 찾지 못함`, data);
          return map;
        }
        list.forEach(item => {
          const viewers = item.total_view_cnt ?? item.view_cnt ?? item.m_current_view_cnt;
          const viewersNum = viewers != null ? Number(viewers) : null;
          if (viewersNum != null && !isNaN(viewersNum) && viewersNum < getMinViewers('soop')) return;
          const c = this._toChannelData(item);
          if (c) map.set(c.hash, c);
        });
        console.log(`[숲] 태그 '${keyword}' 검색 결과: ${map.size}개`);
      } catch (err) {
        console.error(`[숲] 태그 '${keyword}' 검색 실패:`, err);
      }
      return map;
    },
    async searchTagLives(categoryNoList) {
      try {
        const perCategory = await Promise.all(categoryNoList.map(async (tag) => {
          const catMap = await this._fetchByCategoryNo(tag);
          if (catMap.size > 0) return catMap;
          console.log(`[숲] '${tag}' 카테고리 결과 없음 → 태그 검색으로 폴백`);
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
      // 쿠키가 브라우저에 남아있는 것과 서버가 그 세션을 아직 유효하다고
      // 인정하는 건 별개다 — 쿠키 존재만으로 true를 반환하면 서버 세션이
      // 만료된 뒤에도 로그인 상태로 오판한다. 항상 서버 응답(IS_LOGIN)으로만
      // 판단한다.
      try {
        const res = await apiFetch('https://afevent2.sooplive.com/api/get_private_info.php', { credentials: 'include' });
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
      if (ch && ch.isVod) return `https://vod.sooplive.com/player/${id}`;
      const broadNo = ch && ch.broadNo;
      return broadNo ? `https://play.sooplive.com/${id}/${broadNo}` : `https://play.sooplive.com/${id}`;
    },
    getChatEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      // VOD(다시보기)는 라이브 채팅이 없다 — 댓글 임베드는 아직 지원하지 않는다(보류).
      if (ch && ch.isVod) return 'about:blank';
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
    // 후보(검색 결과) 채널명을 음역한 값을 채널명 문자열 기준으로 캐싱한다.
    // 같은 채널이 여러 번 검색 결과에 등장하거나 여러 검색어로 검색이
    // 반복될 때 동일한 채널명을 구글 번역 API로 중복 호출하지 않기 위함.
    _channelNameTranslitCache: new Map(),
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
      try { return await res.json(); } catch (e) {
        console.warn(`[CHEESE EYES] InnerTube ${path} 응답 JSON 파싱 실패:`, e);
        return null;
      }
    },
    // VOD 합방 싱크 동기화 앵커 인터페이스(§docs/vod-collab-sync-
    // architecture.md §10.1/§10.2) — InnerTube player 응답의
    // microformat.playerMicroformatRenderer.liveBroadcastDetails.startTimestamp
    // (실측 확인: ISO8601, 초 단위 정밀도, 치지직 liveOpenDate와 대응)로
    // 실제 방송 시작 시각을 구한다. playabilityStatus가 UNPLAYABLE이어도
    // microformat은 채워지므로(재생이 아니라 메타데이터만 필요) 무시한다.
    // isLiveContent가 false면(일반 업로드 영상 등) 앵커 개념이 없어 null.
    async getVodStartTime(ch) {
      if (!ch || !ch.videoId) return null;
      const data = await this._innerTubePost('player', { context: await this._context(), videoId: ch.videoId });
      if (!data?.videoDetails?.isLiveContent) return null;
      const details = data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
      if (!details?.startTimestamp) return null;
      const start = new Date(details.startTimestamp);
      return isNaN(start.getTime()) ? null : start.getTime();
    },
    // 키 이름(videoRenderer 등)에 의존하지 않고, videoId + 라이브 배지/오버레이를 가진
    // 객체 자체를 구조적으로 탐색한다. 구독 피드는 레이아웃에 따라 videoRenderer 대신
    // gridVideoRenderer / compactVideoRenderer / videoWithContextRenderer / reelItemRenderer
    // 등 전혀 다른 최상위 렌더러 키를 쓰는 경우가 있어, 특정 키 이름만 찾으면 놓칠 수 있다.
    _isLiveVideoNode(node) {
      if (!node || typeof node !== 'object' || typeof node.videoId !== 'string') return false;
      const badges = node.badges || node.thumbnailOverlayBadges || [];
      const hasLiveBadge = Array.isArray(badges) && badges.some(b =>
        b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW'
        || b?.metadataBadgeRenderer?.label === 'LIVE'
      );
      const overlays = node.thumbnailOverlays || [];
      const hasLiveOverlay = Array.isArray(overlays) && overlays.some(o =>
        o?.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE'
        || o?.thumbnailOverlayTimeStatusRenderer?.icon?.iconType === 'LIVE'
      );
      return hasLiveBadge || hasLiveOverlay;
    },
    // 신형 "Kevlar" UI(구독 피드 등)는 videoRenderer 대신 lockupViewModel /
    // shortsLockupViewModel 구조를 쓴다. videoId 대신 contentId, 라이브 배지는
    // contentImage.thumbnailViewModel.overlays[].thumbnailBottomOverlayViewModel.badges[]
    // 안의 badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE'로 표시되고,
    // 채널 아바타 쪽에도 liveData가 붙는다(둘 중 하나만 있어도 라이브로 판단).
    _isLiveLockupNode(node) {
      if (!node || typeof node !== 'object' || typeof node.contentId !== 'string') return false;
      const overlays = node.contentImage?.thumbnailViewModel?.overlays || [];
      const hasLiveThumbBadge = Array.isArray(overlays) && overlays.some(o =>
        (o?.thumbnailBottomOverlayViewModel?.badges || []).some(b =>
          b?.thumbnailBadgeViewModel?.badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE'
        )
      );
      const avatarLiveData = node.metadata?.lockupMetadataViewModel?.image?.decoratedAvatarViewModel
        ?.avatar?.avatarViewModel?.liveData;
      return hasLiveThumbBadge || !!avatarLiveData;
    },
    _findContinuationTokens(node, out = []) {
      if (!node || typeof node !== 'object') return out;
      const token = node?.continuationEndpoint?.continuationCommand?.token
        || node?.continuationCommand?.token;
      if (typeof token === 'string' && token) out.push(token);
      for (const key in node) {
        const val = node[key];
        if (val && typeof val === 'object') this._findContinuationTokens(val, out);
      }
      return out;
    },
    _collectLiveVideoRenderers(node, out = [], seenRendererKeys = null) {
      if (!node || typeof node !== 'object') return out;
      if (this._isLiveVideoNode(node)) out.push(node);
      if (node.lockupViewModel && this._isLiveLockupNode(node.lockupViewModel)) out.push(node.lockupViewModel);
      // 쇼츠(shortsLockupViewModel)는 검색 결과에서 제외한다. 라이브 형태의
      // 쇼츠도 있을 수 있지만, 이 검색은 일반 라이브 방송만 대상으로 하므로
      // 수집 단계에서부터 shortsLockupViewModel은 넣지 않는다.
      for (const key in node) {
        const val = node[key];
        if (val && typeof val === 'object') {
          if (seenRendererKeys && /Renderer$/.test(key)) seenRendererKeys.add(key);
          this._collectLiveVideoRenderers(val, out, seenRendererKeys);
        }
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
    _lockupToChannel(node) {
      try {
        const videoId = node.contentId;
        const lm = node.metadata?.lockupMetadataViewModel;
        if (!videoId || !lm) return null;
        const title = lm.title?.content || '';
        const rows = lm.metadata?.contentMetadataViewModel?.metadataRows || [];
        const firstPart = rows[0]?.metadataParts?.[0];
        const name = firstPart?.text?.content || '';
        const channelId = firstPart?.text?.commandRuns?.[0]?.onTap?.innertubeCommand?.browseEndpoint?.browseId;
        if (!channelId || !videoId) return null;
        const viewersText = rows[1]?.metadataParts?.[0]?.text?.content || '';
        const thumbs = node.contentImage?.thumbnailViewModel?.image?.sources;
        const thumbnail = Array.isArray(thumbs) && thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
        return { platform: 'youtube', hash: channelId, name, videoId, title, thumbnail, viewersText };
      } catch (e) { return null; }
    },
    _anyLiveNodeToChannel(node) {
      if (!node) return null;
      if (typeof node.contentId === 'string') return this._lockupToChannel(node);
      if (typeof node.videoId === 'string') return this._videoRendererToChannel(node);
      return null;
    },
    // ── "/vod" 검색(§resolveAndOpenVodSearchModal)용 — 채널 업로드 목록을
    // 최신순으로 가져온다. 채널 "동영상" 탭 전용 공식 browse API가 없어서,
    // 채널ID의 UC를 UU로 바꾼 자동 업로드 재생목록(오래된 유튜브 관례)을 browse한다.
    _isVideoListNode(node) {
      if (!node || typeof node !== 'object') return false;
      if (typeof node.videoId === 'string' && (node.title || node.lengthText || node.thumbnailOverlays)) return true;
      return false;
    },
    _collectVideoListNodes(node, out = []) {
      if (!node || typeof node !== 'object') return out;
      if (this._isVideoListNode(node)) out.push(node);
      if (node.lockupViewModel && typeof node.lockupViewModel.contentId === 'string') out.push(node.lockupViewModel);
      for (const key in node) {
        const val = node[key];
        if (val && typeof val === 'object') this._collectVideoListNodes(val, out);
      }
      return out;
    },
    // videoRenderer/playlistVideoRenderer류(구형) 또는 lockupViewModel류
    // (신형 "Kevlar" UI) 노드에서 { videoId, title, thumbnail, duration(초),
    // publishDate(문자열) }을 뽑아낸다 — chzzk getChannelVideos와 같은
    // 필드명으로 맞춰서 renderVodSearchModalList가 플랫폼 구분 없이
    // 재사용 가능하게 한다.
    _anyVideoNodeToVideoItem(node) {
      try {
        if (typeof node.contentId === 'string') {
          const videoId = node.contentId;
          const lm = node.metadata?.lockupMetadataViewModel;
          const title = lm?.title?.content || '';
          if (!videoId || !title) return null;
          const thumbs = node.contentImage?.thumbnailViewModel?.image?.sources;
          const thumbnail = Array.isArray(thumbs) && thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
          const overlays = node.contentImage?.thumbnailViewModel?.overlays || [];
          const durationText = overlays
            .flatMap(o => (o?.thumbnailBottomOverlayViewModel?.badges || []))
            .map(b => b?.thumbnailBadgeViewModel?.text || '')
            .find(Boolean) || '';
          const rows = lm?.metadata?.contentMetadataViewModel?.metadataRows || [];
          const metaTexts = rows.flatMap(r => (r.metadataParts || []).map(p => p?.text?.content || '')).filter(Boolean);
          const publishDate = metaTexts[metaTexts.length - 1] || '';
          return { videoId, title, thumbnail, duration: youtubeTimestampToSeconds(durationText), publishDate };
        }
        if (typeof node.videoId === 'string') {
          const videoId = node.videoId;
          const title = node.title?.runs?.[0]?.text || node.title?.simpleText || '';
          if (!videoId || !title) return null;
          const thumbs = node.thumbnail?.thumbnails;
          const thumbnail = Array.isArray(thumbs) && thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
          const durationText = node.lengthText?.simpleText
            || (node.thumbnailOverlays || []).map(o => o?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText).find(Boolean)
            || '';
          const publishDate = node.publishedTimeText?.simpleText || '';
          return { videoId, title, thumbnail, duration: youtubeTimestampToSeconds(durationText), publishDate };
        }
        return null;
      } catch (e) { return null; }
    },
    // 채널의 "동영상"/"라이브" 탭 전환용 고정 params(비공식 — 여러 InnerTube
    // 리버스엔지니어링 사례로 교차확인, yt-dlp도 동일 값 사용). 스펙이
    // 바뀌면 빈 목록으로 조용히 폴백한다.
    _YT_CHANNEL_TAB_PARAMS: {
      videos: 'EgZ2aWRlb3PyBgQKAjoA',
      streams: 'EgdzdHJlYW1z8gYECgJ6AA=='
    },
    // cursor는 continuation 토큰(첫 페이지 null) — "/vod" 모달 무한 스크롤용
    // nextCursor를 돌려준다(chzzk getChannelVideos와 같은 { items, nextCursor }
    // 모양). tab은 'videos'/'streams'로 "동영상"/"라이브" 탭을 구분한다
    // (§openVodSearchModal). continuation은 최초 browse 때 이미 탭이 토큰에
    // 인코딩돼 있어 tab을 다시 넘길 필요 없다.
    async getChannelVideos(channelId, size = 20, cursor = null, tab = 'videos') {
      try {
        const context = await this._context();
        let data;
        if (cursor) {
          data = await this._innerTubePost('browse', { context, continuation: cursor });
        } else {
          if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) return { items: [], nextCursor: null };
          const params = this._YT_CHANNEL_TAB_PARAMS[tab] || this._YT_CHANNEL_TAB_PARAMS.videos;
          data = await this._innerTubePost('browse', { context, browseId: channelId, params });
        }
        if (!data) return { items: [], nextCursor: null };
        const nodes = this._collectVideoListNodes(data);
        const seen = new Set();
        const results = [];
        for (const node of nodes) {
          if (tab === 'streams' && this._isUpcomingOrLiveStreamNode(node)) continue;
          const v = this._anyVideoNodeToVideoItem(node);
          if (!v || seen.has(v.videoId)) continue;
          seen.add(v.videoId);
          results.push(v);
          if (results.length >= size) break;
        }
        const tokens = this._findContinuationTokens(data);
        return { items: results, nextCursor: tokens.length > 0 ? tokens[0] : null };
      } catch (err) {
        console.error(`[CHEESE EYES] ${channelId} 유튜브 업로드 목록 조회 실패:`, err);
        return { items: [], nextCursor: null };
      }
    },
    // "라이브"(streams) 탭엔 완료된 스트림뿐 아니라 진행 중/예약된 방송도
    // 섞여 온다 — 아직 다시보기가 아닌 그 둘을 걸러낸다. 구조적 신호(라이브
    // 배지·예약 데이터)를 우선 쓰고 ko/en 텍스트 신호를 보조로 쓴다. "이
    // 텍스트면 다시보기"가 아니라 "이 텍스트면 아직 아님"만 판정한다 —
    // 오래된 영상은 절대 날짜로 표기돼 상대 시간 패턴에 안 걸릴 수 있어서,
    // 오래된 다시보기를 실수로 걸러내지 않기 위함.
    _isUpcomingOrLiveStreamNode(node) {
      if (this._isLiveVideoNode(node) || this._isLiveLockupNode(node)) return true;
      if (node && typeof node === 'object' && node.upcomingEventData) return true;
      const overlays = (node && node.thumbnailOverlays) || [];
      if (Array.isArray(overlays) && overlays.some(o => o?.thumbnailOverlayTimeStatusRenderer?.style === 'UPCOMING')) return true;
      const metaRows = node?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const lockupText = metaRows.flatMap(r => (r.metadataParts || []).map(p => p?.text?.content || '')).join(' ');
      const text = [node?.publishedTimeText?.simpleText, node?.viewCountText?.simpleText, lockupText].filter(Boolean).join(' ');
      return this._looksLikeUpcomingOrLiveText(text);
    },
    _looksLikeUpcomingOrLiveText(text) {
      if (!text) return false;
      const s = String(text);
      if (/scheduled for/i.test(s)) return true;
      if (/\bwatching\b/i.test(s)) return true;
      if (/premieres?\b/i.test(s)) return true;
      if (/예정/.test(s)) return true;
      if (/시청\s*중/.test(s)) return true;
      if (/대기\s*중/.test(s)) return true;
      return false;
    },
    // 신형 "Kevlar" UI의 채널 카드(lockupViewModel)에서 채널 정보를
    // 뽑아낸다. 영상 lockup(§_lockupToChannel)과 완전히 같은 래퍼
    // 구조라 contentType 필드로 구분하는 대신, contentId 자체가 채널ID
    // 형식(UC+22자)인지로 구분한다 — 영상 lockup의 contentId는 11자
    // videoId라 형식이 겹치지 않는다.
    _channelLockupToChannel(node) {
      try {
        const channelId = node.contentId;
        const lm = node.metadata?.lockupMetadataViewModel;
        if (!channelId || !lm) return null;
        const name = lm.title?.content || '';
        if (!name) return null;
        const rows = lm.metadata?.contentMetadataViewModel?.metadataRows || [];
        const rowTexts = rows.flatMap(r => (r.metadataParts || []).map(p => p?.text?.content || '')).filter(Boolean);
        const handle = rowTexts.find(t => t.startsWith('@')) || '';
        const subscriberText = rowTexts.find(t => t !== handle) || '';
        return { platform: 'youtube', hash: channelId, name, handle, subscriberText };
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
      // 채널 검색(params EgIQAg)인데도 legacy channelRenderer 대신 신형
      // lockupViewModel로 오는 경우가 있다 — 놓치면 채널 검색이 전부 빈
      // 결과로 실패한다(실사용 확인 증상). contentId가 채널ID 형식일 때만 인정.
      if (node.lockupViewModel && typeof node.lockupViewModel.contentId === 'string'
        && /^UC[a-zA-Z0-9_-]{22}$/.test(node.lockupViewModel.contentId)) {
        const ch = this._channelLockupToChannel(node.lockupViewModel);
        if (ch) out.push(ch);
      }
      for (const key in node) {
        if (key === 'channelRenderer') continue;
        const val = node[key];
        if (val && typeof val === 'object') this._collectChannelRenderers(val, out);
      }
      return out;
    },
    // 이름 유사도 필터를 적용하기 전 원본 후보 목록만 모은다 — 핸들
    // 완전일치 검색(§_resolveByHandleOrText)처럼 검색어와 채널 "이름"이
    // 애초에 다른 표기 체계일 수 있는 경우엔 이 필터를 거치면 정답 채널이
    // 걸러질 수 있어, 그런 경로는 필터링 전 이 원본 목록을 직접 써야 한다.
    async _rawSearchChannelCandidates(keyword) {
      const context = await this._context();
      const matchTerms = await this._buildKeywordMatchTerms(keyword);

      // 원본어(한글 등) 그대로는 유튜브 검색 자체에서 결과가 아예 안 나오는
      // 경우가 많아(비공식 표기/애칭 등), 음역된 키워드로도 함께 검색해
      // 결과를 합친 뒤 유사도 필터를 적용한다.
      const searchQueries = new Set([keyword]);
      if (matchTerms.translated) searchQueries.add(matchTerms.translated);
      if (matchTerms.alias) searchQueries.add(matchTerms.alias);

      const dataList = await Promise.all(
        Array.from(searchQueries).map(q => this._innerTubePost('search', { context, query: q, params: 'EgIQAg%3D%3D' }))
      );

      const seenHash = new Set();
      const rawChannels = [];
      dataList.forEach(data => {
        if (!data) return;
        this._collectChannelRenderers(data).forEach(ch => {
          if (!ch.hash || !ch.name || seenHash.has(ch.hash)) return;
          seenHash.add(ch.hash);
          rawChannels.push(ch);
        });
      });
      return { rawChannels, matchTerms, searchQueries };
    },
    async _searchChannelRenderers(keyword) {
      const { rawChannels, matchTerms, searchQueries } = await this._rawSearchChannelCandidates(keyword);

      // _candidateMatchesKeyword가 채널명 음역 때문에 비동기(API 호출)로
      // 바뀌었으므로, 후보별 판정을 Promise.all로 동시에 실행해 순차
      // 대기로 인한 지연 누적을 막는다.
      const matchResults = await Promise.all(
        rawChannels.map(ch => this._candidateMatchesKeyword(ch, matchTerms))
      );
      const filtered = rawChannels.filter((_, idx) => matchResults[idx].matched);
      console.log(`[CHEESE EYES][음역 필터] '${keyword}' 채널명 검색 결과(검색어 ${searchQueries.size}개 합산): 통과 ${filtered.length}건 / 제외 ${rawChannels.length - filtered.length}건`);
      return filtered;
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
    // 핸들 입력으로 실제 확인된 채널 캐시(§rememberYoutubeHandle) 중
    // keyword로 시작하는 핸들만 골라준다 — 유튜브 자동완성이 핸들 완전일치를
    // 잘 못 띄우므로, 한 번 확인된 핸들이 더 신뢰도가 높다. 겹치면 count(입력 횟수) 큰 순 정렬.
    async _matchedCachedHandles(keyword) {
      try {
        const cached = await readYoutubeHandleCache();
        const kw = keyword.toLowerCase();
        return cached
          .filter(e => e && typeof e.handle === 'string' && e.handle.toLowerCase().startsWith(kw))
          .sort((a, b) => (b.count || 0) - (a.count || 0))
          .map(e => e.handle);
      } catch (e) { return []; }
    },
    async searchAutocomplete(keyword, size = 10) {
      const isHandleMode = keyword.startsWith('@');
      const cachedMatches = isHandleMode ? await this._matchedCachedHandles(keyword) : [];
      try {
        const hl = (typeof window !== 'undefined' && window.CHEESE_EYES_CURRENT_LANG) || 'ko';
        const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=${encodeURIComponent(hl)}&q=${encodeURIComponent(keyword)}`;
        const res = await apiFetch(url);

        let suggestions = [];
        if (res.ok) {
          try {
            const raw = await res.text();
            const parsed = JSON.parse(raw);
            suggestions = Array.isArray(parsed?.[1])
              ? parsed[1].map(s => Array.isArray(s) ? s[0] : s).filter(s => typeof s === 'string')
              : [];
          } catch (e) { suggestions = []; }
        }

        const filtered = isHandleMode
          ? suggestions.filter(s => s.startsWith('@'))
          : suggestions.filter(s => !this._looksLikeNonChannelQuery(s, keyword));

        // 캐시된 핸들을 API 추천보다 앞에 두고 합친다(중복 제거) — API가
        // 실패했거나(res.ok===false) 그 핸들을 아예 안 띄워줘도 캐시로
        // 보완된다.
        const seen = new Set();
        const merged = [];
        [...cachedMatches, ...filtered].forEach(text => {
          const key = text.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          merged.push(text);
        });

        return merged.slice(0, size).map(text => ({ platform: 'youtube', text }));
      } catch (e) {
        console.error('유튜브 자동완성(Stage A) 실패:', e);
        return cachedMatches.slice(0, size).map(text => ({ platform: 'youtube', text }));
      }
    },
    // 구분자는 '\s'(탭/개행 등 포함) 대신 순수 공백 문자(' ')만 센다.
    _countPlainSpaces(text) {
      return (String(text || '').match(/ /g) || []).length;
    },
    _looksLikeNonChannelQuery(text, queryText) {
      const s = String(text).trim();
      if (!s) return true;
      if (/[?!]/.test(s)) return true;

      // 연관 검색어의 띄어쓰기가 원래 검색어보다 많으면(단어 수 증가) 채널명이
      // 아닌 '주제성' 검색어로 보고 제외한다.
      const querySpaces = this._countPlainSpaces(String(queryText || '').trim());
      const suggestionSpaces = this._countPlainSpaces(s);
      if (suggestionSpaces > querySpaces) return true;

      const topicWords = ['리뷰', 'review', 'vs', '비교', '모음', '총정리', '순위', 'top', '베스트', 'best', '하는법', 'how to', 'tutorial'];
      const lower = s.toLowerCase();
      if (topicWords.some(w => lower.includes(w))) return true;

      if (s.split(' ').filter(Boolean).length > 5) return true;

      if (/\d/.test(s) && /(결산|가지|선정|추천)/.test(s)) return true;

      return false;
    },
    // 원본어 문자열에 일본어 가나(히라가나/가타카나) 또는 한자(CJK
    // 표의문자)가 포함돼 있는지 확인. 한글은 이 범위에 포함되지 않는다.
    // 표의문자는 글자 자체에 고정된 발음이 없어(문맥에 따라 음독/훈독이
    // 갈림) 로컬 변환표로는 음역이 불가능하므로, 이 경우에만 구글 음역
    // API를 사용한다.
    _containsCJKIdeographOrKana(text) {
      return /[\u3040-\u30FF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(text || ''));
    },
    // 언어별 차자표기 정책. 검색어/후보 채널명 음역 양쪽에 공통 사용.
    //  - 한글/기타: 구글 일반 번역 dt=t 사용. dt=rm은 비공식이라 표기가
    //    흔들리고, 로컬 변환표는 한글 전용이고 관용 표기와 어긋날 수 있어
    //    둘 다 배제. dt=t는 정식 엔드포인트라 안정적이고, 고유명사는
    //    로마자 표기를 결과로 주는 경우가 많아 음역 용도로도 충분하다.
    //  - 일본어/한자: 표의문자는 발음 사전이 필요해 dt=t로 복원 불가 —
    //    이 경우만 발음 표기 전용 dt=rm(_transliterateToLatin)을 쓴다.
    async _transliterateByLanguagePolicy(text) {
      const s = String(text || '').trim();
      if (!s) return '';
      if (this._containsCJKIdeographOrKana(s)) {
        return await this._transliterateToLatin(s);
      }
      return await this._translateGeneral(s);
    },
    // 구글 번역의 dt=t(일반/의미 번역) 옵션을 사용한다. dt=rm과 달리 구글이
    // 정식 지원하는 번역 엔드포인트라 응답 포맷이 안정적이다. 응답 구조는
    // data[0]이 [번역조각, 원문조각, ...] 배열들의 배열이므로, 번역조각만
    // 이어붙여서 반환한다.
    async _translateGeneral(text) {
      const s = String(text || '').trim();
      if (!s) return '';
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(s)}`;
        const res = await apiFetch(url);
        console.log(`[CHEESE EYES][번역] '${s}' 요청 -> ok=${res.ok} status=${res.status}`);
        if (!res.ok) throw new Error(`http_${res.status}`);
        const raw = await res.text();
        const data = JSON.parse(raw);
        const translated = Array.isArray(data?.[0])
          ? data[0].map(seg => (Array.isArray(seg) ? seg[0] : '') || '').join('').trim()
          : '';
        console.log(`[CHEESE EYES][번역] '${s}' -> '${translated}'`);
        return translated;
      } catch (e) {
        console.warn(`[CHEESE EYES][번역] '${s}' 구글 번역 실패:`, e);
        return '';
      }
    },
    // 의미 번역이 아닌 소리 나는 대로의 음역. 예: '모리 칼리오페' ->
    // 'mori kariope'. dt=rm(로마자 발음 표기)만 사용, 일본어/한자처럼
    // 발음 사전이 필요한 경우에만(_transliterateByLanguagePolicy 경유)
    // 호출된다. dt=rm 응답 포맷은 비공식이라 파싱을 방어적으로 처리한다.
    async _transliterateToLatin(text) {
      const s = String(text || '').trim();
      if (!s) return '';
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=rm&q=${encodeURIComponent(s)}`;
        const res = await apiFetch(url);
        console.log(`[CHEESE EYES][음역] '${s}' 요청 -> ok=${res.ok} status=${res.status}`);
        if (!res.ok) throw new Error(`http_${res.status}`);
        const raw = await res.text();
        const data = JSON.parse(raw);
        console.log(`[CHEESE EYES][음역] '${s}' 원본 응답:`, data);
        const pron = this._extractRomanizationFromResponse(data, s);
        if (!pron) throw new Error('empty_pronunciation');
        console.log(`[CHEESE EYES][음역] '${s}' -> '${pron}'`);
        return pron;
      } catch (e) {
        console.warn(`[CHEESE EYES][음역] '${s}' 구글 음역 실패, 오프라인 폴백 시도:`, e);
        // 네트워크 실패 등으로 구글 음역을 못 받으면, 한글이 섞여 있는
        // 경우에 한해 로컬 변환 테이블로 최소한의 음역을 시도한다.
        const romanized = romanizeHangulText(s).trim();
        if (romanized && romanized !== s) {
          console.log(`[CHEESE EYES][음역] '${s}' -> '${romanized}' (오프라인 폴백)`);
          return romanized;
        }
        return '';
      }
    },
    // dt=rm 응답 구조가 문서화되어 있지 않으므로, 전체 JSON을 재귀적으로
    // 훑어서 '순수 로마자(영문/숫자/공백/붙임표 등)로만 된' 문자열 중
    // 원본과 다른 값을 후보로 모은 뒤, 가장 긴 후보를 음역 결과로 본다.
    // (보통 전체 발음을 담은 문자열이 가장 길다.)
    _extractRomanizationFromResponse(data, original) {
      const candidates = [];
      const walk = (node) => {
        if (typeof node === 'string') {
          const v = node.trim();
          if (v && v !== original && /^[A-Za-z0-9 '\-.,!?]+$/.test(v)) candidates.push(v);
        } else if (Array.isArray(node)) {
          node.forEach(walk);
        }
      };
      walk(data);
      if (candidates.length === 0) return '';
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];
    },
    // 원본어 문자열이 이미 영어(ASCII)로만 이뤄져 있는지 확인.
    // 영어라면 음역해봐야 결과가 같거나 무의미하므로 음역 자체를 생략한다.
    _isEnglishQuery(text) {
      const s = String(text || '');
      if (!s) return false;
      return /^[\x00-\x7F]*$/.test(s);
    },
    // 태그 검색은 미지원이라, 검색어가 제목/채널명/핸들 어디에도(원본어든
    // 음역이든) 없는 결과는 제외한다. 영상 제목엔 크리에이터가 붙인
    // #태그가 텍스트로 들어있어 title 매칭이 태그 매칭도 대부분 커버한다.
    // 반환값 { original, translated }의 translated는 의미 번역이 아닌 로마자
    // 음역 — 매칭 단계에서 서로 다른 규칙(원본어: 단어 포함, 음역: 유사도)으로 쓰인다.
    // 정규화된 검색어가 애칭 테이블(youtube_aliases.js)에 있으면 실제
    // 채널명을 돌려준다 — 음역만으론 못 찾는 팬덤 애칭용 수동 보정.
    _lookupChannelAlias(normalizedText) {
      const map = window.CHEESE_EYES_YOUTUBE_ALIASES;
      if (!map || !normalizedText) return null;
      const textNoSpace = normalizedText.replace(/\s+/g, '');

      const exact = map.get(normalizedText) || map.get(textNoSpace);
      if (exact) return exact;

      // 정확히 일치하지 않아도 부가어가 섞였거나(예: "우사다 페코라 방송")
      // 별칭 일부만 입력한 경우(예: "페코라")를 위해 부분 포함도 확인한다.
      // 후보가 여럿이면 더 구체적인(긴) 별칭을 우선(짧을수록 우연히 걸릴
      // 위험 큼). 우연한 겹침 방지를 위해 최소 길이(2자)를 둔다.
      let bestKey = null;
      let bestName = null;
      for (const [key, name] of map.entries()) {
        const keyNoSpace = key.replace(/\s+/g, '');
        const matches =
          (key.length >= 2 && normalizedText.includes(key)) ||
          (normalizedText.length >= 2 && key.includes(normalizedText)) ||
          (keyNoSpace.length >= 2 && textNoSpace.includes(keyNoSpace)) ||
          (textNoSpace.length >= 2 && keyNoSpace.includes(textNoSpace));
        if (matches && (!bestKey || key.length > bestKey.length)) {
          bestKey = key;
          bestName = name;
        }
      }
      return bestName;
    },
    async _buildKeywordMatchTerms(query) {
      // NFKC 정규화: 전각/반각 문자(일본어 입력에서 흔함), 장음 기호 등
      // 표기만 다르고 실질적으로 같은 문자를 동일하게 취급해, 표기 차이
      // 때문에 매칭이 실패하는 경우를 줄인다.
      const original = String(query || '').trim().normalize('NFKC').toLowerCase();
      if (!original) return { original: '', translated: null, alias: null };

      const alias = this._lookupChannelAlias(original);
      if (alias) console.log(`[CHEESE EYES][별칭 보정] '${original}' → '${alias}'`);

      // 원본어가 이미 영어라면 음역할 필요가 없다.
      if (this._isEnglishQuery(original)) {
        console.log(`[CHEESE EYES][음역] '${original}' 은 이미 영어라 음역 생략`);
        return { original, translated: null, alias };
      }

      const translatedRaw = await this._transliterateByLanguagePolicy(original);
      let translated = null;
      if (translatedRaw) {
        // 음역 결과에 불필요한 공백이 섞여 들어가는 경우가 많으므로
        // (예: '브이 튜버' -> 'beuituyubeo') 매칭 정확도를 위해 공백을 제거한다.
        const normalized = translatedRaw.toLowerCase().replace(/\s+/g, '');
        if (normalized && normalized !== original) translated = normalized;
      }
      console.log(`[CHEESE EYES][음역] '${original}' 매칭 키워드: 원본="${original}" 음역="${translated || ''}"`);
      return { original, translated, alias };
    },
    // ── 2단계: 후보(검색 결과) 채널명 음역 ──────────────────────────────
    // 검색어만 음역하면(예: 'mori kariope') 후보 채널명이 원본어 그대로일
    // 때("모리 칼리오페") 표기 체계가 달라 유사도 비교가 무의미해진다.
    // 그래서 후보 채널명도 로마자로 음역해 로마자끼리 비교한다.
    //  - API 호출 여부는 _transliterateByLanguagePolicy를 따른다: 한글은
    //    로컬 변환만(API 미호출), 일본어/한자만 구글 음역 API 호출. 영어
    //    채널명은 여기서 걸러진다.
    //  - 음역 대상은 채널명(name)만 — title은 표기가 제각각이라 정확도가
    //    떨어지고 호출 비용도 커진다.
    //  - 같은 채널명은 세션 동안 캐싱해 API 호출 횟수를 줄인다.
    async _getCandidateNameTransliteration(name) {
      const s = String(name || '').trim().normalize('NFKC');
      if (!s) return '';
      if (this._isEnglishQuery(s)) return '';
      if (this._channelNameTranslitCache.has(s)) {
        return this._channelNameTranslitCache.get(s);
      }
      const translatedRaw = await this._transliterateByLanguagePolicy(s);
      const translated = translatedRaw ? translatedRaw.toLowerCase().replace(/\s+/g, '') : '';
      this._channelNameTranslitCache.set(s, translated);
      return translated;
    },
    // ── 문자열 유사도(Levenshtein) 기반 매칭 ──────────────────────────────
    // 음역 오차, 표기 차이(공백/특수문자/오탈자 등)로 인해 단순 includes()
    // 매칭으로는 실제로 관련 있는 채널이 걸러지는 경우가 많아, 완전 포함이
    // 안 될 때는 haystack 내 여러 구간(윈도우)과의 편집 거리를 계산해
    // 가장 유사한 구간의 유사도 점수로 판정한다.
    _levenshteinDistance(a, b) {
      const al = a.length, bl = b.length;
      if (al === 0) return bl;
      if (bl === 0) return al;
      const dp = new Array(bl + 1);
      for (let j = 0; j <= bl; j++) dp[j] = j;
      for (let i = 1; i <= al; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= bl; j++) {
          const temp = dp[j];
          dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
          prev = temp;
        }
      }
      return dp[bl];
    },
    _similarityRatio(a, b) {
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) return 1;
      return 1 - this._levenshteinDistance(a, b) / maxLen;
    },
    // haystack 안에서 term과 길이가 비슷한(±3) 구간들을 슬라이딩하며 가장
    // 높은 유사도를 반환한다. term이 그대로 포함되면 즉시 1. text가 term보다
    // 짧을 때는 호출 안 함(_bestSimilarityBidirectional이 인자를 바꿔 재사용).
    _bestSimilarityInText(term, text) {
      if (!term || !text) return 0;
      if (text.includes(term)) return 1;
      const termLen = term.length;
      // 음역 결과가 음절 하나 정도 더 붙거나 빠지는 경우까지 커버하기 위해
      // 윈도우 길이 허용 범위를 term 길이 기준 ±3으로 둔다.
      const minWin = Math.max(1, termLen - 3);
      const maxWin = Math.min(text.length, termLen + 3);
      let best = 0;
      for (let winLen = minWin; winLen <= maxWin; winLen++) {
        for (let i = 0; i + winLen <= text.length; i++) {
          const sim = this._similarityRatio(term, text.substr(i, winLen));
          if (sim > best) {
            best = sim;
            if (best >= 0.999) return best;
          }
        }
      }
      return best;
    },
    // term과 text 중 어느 쪽이 더 길든 상관없이 유사도를 측정한다.
    // (음역 매칭은 후보 문자열이 검색어보다 짧은 경우도 봐야 하므로 필요)
    _bestSimilarityBidirectional(term, text) {
      if (!term || !text) return 0;
      return text.length >= term.length
        ? this._bestSimilarityInText(term, text)
        : this._bestSimilarityInText(text, term);
    },
    // 채널명만으로 유사도를 측정한다 — 방송 제목/핸들은 검색어와 무관하게
    // 우연히 겹치는 경우가 많아(예: 제목에 들어간 흔한 단어) 비교 대상에
    // 포함하지 않는다.
    async _candidateMatchesKeyword(candidate, matchTerms) {
      if (!matchTerms || (!matchTerms.original && !matchTerms.translated)) return { matched: true, score: 1 };
      const haystack = (candidate?.name || '')
        .normalize('NFKC')
        .toLowerCase();
      if (!haystack) {
        console.log(`[CHEESE EYES][음역 필터] 제외 (haystack 없음) - name="${candidate?.name || ''}" title="${candidate?.title || ''}"`);
        return { matched: false, score: 0 };
      }
      const haystackNoSpace = haystack.replace(/\s+/g, '');

      // ── 별칭 보정 매칭(최우선) ────────────────────────────────────
      // youtube_aliases.js에 등록된 애칭이면, 실제 채널명이 후보명에
      // 그대로 들어있는지만 확인한다 — 이미 사람이 직접 확인해 등록한
      // 정확한 대응 관계라 음역/유사도 계산보다 신뢰도가 높으므로
      // 곧바로 통과시킨다.
      if (matchTerms.alias) {
        const aliasNorm = matchTerms.alias.normalize('NFKC').toLowerCase();
        const aliasNormNoSpace = aliasNorm.replace(/\s+/g, '');
        if (haystack.includes(aliasNorm) || haystackNoSpace.includes(aliasNormNoSpace)) {
          console.log(`[CHEESE EYES][별칭 필터] 통과(별칭-포함) - name="${candidate?.name || ''}" 별칭="${matchTerms.alias}"`);
          return { matched: true, score: 1 };
        }
      }

      const SIMILARITY_THRESHOLD = 0.72;
      let matched = false;
      let bestScore = 0;
      let matchedBy = '';

      // ── 원본어 매칭 ──────────────────────────────────────────────
      // 원본어는 음역 오차 없는 정확한 표기지만, 모든 단어를 다 요구하면
      // (부가어 섞인 검색어) 관련 채널까지 과도하게 걸러진다. 단어가 2개
      // 이상이면 과반만 포함돼도 통과, 1개면 그대로 포함 여부를 본다.
      const orig = matchTerms.original;
      if (orig) {
        const words = orig.split(' ').filter(Boolean);
        const presentCount = words.filter(w => haystack.includes(w) || haystackNoSpace.includes(w)).length;
        const requiredCount = words.length <= 1 ? words.length : Math.max(1, Math.ceil(words.length * 0.6));
        const allWordsPresent = words.length > 0 && presentCount >= requiredCount;
        if (allWordsPresent) {
          matched = true;
          bestScore = 1;
          matchedBy = `원본-단어포함(${presentCount}/${words.length})`;
        } else {
          const longerThanQuery = haystack.length > orig.length;
          const longerThanQueryNoSpace = haystackNoSpace.length > orig.length;
          if (longerThanQuery || longerThanQueryNoSpace) {
            const score = Math.max(
              longerThanQuery ? this._bestSimilarityInText(orig, haystack) : 0,
              longerThanQueryNoSpace ? this._bestSimilarityInText(orig, haystackNoSpace) : 0
            );
            if (score > bestScore) bestScore = score;
            if (score >= SIMILARITY_THRESHOLD) {
              matched = true;
              matchedBy = '원본-유사도';
            }
          }
        }
      }

      // ── 음역 매칭 (2단계) ──────────────────────────────────────
      // "이미 영어면 변환 생략"은 검색어/채널명 쪽에서 각각 독립 판단해야
      // 한다. 검색어는 translated(없으면 original), 채널명은 음역 결과
      // (없으면 원본 haystack)를 각각 준비해 비교한다. 예전엔 translated가
      // 없으면(검색어가 영어) 이 단계 자체를 건너뛰어 "영어로 검색했는데
      // 채널명은 한글/일본어인" 경우가 누락됐었다.
      if (!matched) {
        const queryLatin = matchTerms.translated || matchTerms.original;
        if (queryLatin) {
          const candidateNameHasCJK = this._containsCJKIdeographOrKana(candidate?.name || '');
          const nameTranslit = await this._getCandidateNameTransliteration(candidate?.name);
          // 채널명에 한자/가나가 섞이면 제대로 음역된 결과(nameTranslit)가
          // 있을 때만 그걸로 비교한다. 음역 실패로 빈 문자열이면 원문
          // (raw haystack)을 그대로 비교하면 안 된다 — 원문에 우연히 섞인
          // 영단어 조각("Live", "Channel" 등)이 검색어와 겹쳐 무관한
          // 채널이 오탐될 수 있다. 채널명이 애초에 영문이라 음역이 필요
          // 없는 경우에만 haystack을 그대로 비교 대상으로 쓴다.
          const compareTargets = candidateNameHasCJK
            ? [nameTranslit].filter(Boolean)
            : [haystack, haystackNoSpace].filter(Boolean);
          for (const hs of compareTargets) {
            if (hs.includes(queryLatin) || queryLatin.includes(hs)) {
              matched = true;
              bestScore = 1;
              matchedBy = '음역-포함';
              break;
            }
            const score = this._bestSimilarityBidirectional(queryLatin, hs);
            if (score > bestScore) bestScore = score;
            if (score >= SIMILARITY_THRESHOLD) {
              matched = true;
              matchedBy = '음역-유사도';
              break;
            }
          }
        }
      }

      console.log(`[CHEESE EYES][음역 필터] ${matched ? `통과(${matchedBy})` : '제외'} (유사도=${bestScore.toFixed(2)}) - name="${candidate?.name || ''}" title="${candidate?.title || ''}" 원본="${matchTerms.original}" 음역="${matchTerms.translated || ''}"`);
      return { matched, score: bestScore };
    },
    async _resolveKeywordCandidatesForStageB(query) {
      const matchTerms = await this._buildKeywordMatchTerms(query);

      // 원본어(한글 등) 그대로는 유튜브 라이브 검색에서 결과가 아예 안
      // 나오는 경우가 많아(비공식 표기/애칭 등), 음역된 키워드로도 함께
      // 검색해 결과를 합친 뒤 유사도 필터를 적용한다.
      const searchQueries = new Set([query]);
      if (matchTerms.translated) searchQueries.add(matchTerms.translated);
      if (matchTerms.alias) searchQueries.add(matchTerms.alias);

      const dataList = await Promise.all(
        Array.from(searchQueries).map(q => this._fetchLiveSearchResults(q))
      );

      const liveRenderers = [];
      dataList.forEach(data => {
        if (data) liveRenderers.push(...this._collectLiveVideoRenderers(data));
      });
      if (liveRenderers.length === 0) return [];

      // 1) 먼저 중복(같은 채널) 제거로 매칭 판정 대상을 만든다(매칭은 채널명
      //    음역 네트워크 호출이 있을 수 있어 같은 채널을 중복 판정하지 않도록).
      const seen = new Set();
      const dedupedChannels = [];
      for (const vr of liveRenderers) {
        const ch = this._anyLiveNodeToChannel(vr);
        if (!ch || seen.has(ch.hash)) continue;
        seen.add(ch.hash);
        const thumbnail = vr.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '';
        const viewersText = vr.viewCountText?.runs?.map(r => r.text).join('') || vr.viewCountText?.simpleText || '';
        const title = vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || '';
        dedupedChannels.push({ ...ch, thumbnail, viewersText, title });
      }

      // 1.5) 최소 시청자수 필터를 이름/음역 매칭보다 먼저 적용한다 — 매칭
      //    판정(특히 음역)은 채널명마다 API 호출이 필요해 비용이 크고, 어차피
      //    미달 후보는 노출 안 되므로 먼저 걸러 매칭 로직 변경과 무관하게
      //    최소 시청자수 기준이 항상 지켜지게 한다.
      const minViewers = getMinViewers('youtube');
      const viewerFiltered = dedupedChannels
        .map(c => ({ ...c, _viewers: this._parseViewerCountText(c.viewersText) }))
        // 시청자 수 표기 자체가 없어서 파싱이 안 된(_viewers === null) 채널은
        // 최소 시청자수 충족 여부를 판단할 수 없으므로 결과에서 제외한다.
        // (예전엔 이런 경우 일단 통과시켰는데, 시청자 수가 안 보이는
        // 라이브가 목록에 섞여 나오는 문제가 있었다.)
        .filter(c => c._viewers != null && c._viewers >= minViewers);
      const viewerExcludedCount = dedupedChannels.length - viewerFiltered.length;
      if (viewerExcludedCount > 0) {
        console.log(`[CHEESE EYES][최소 시청자수 필터] '${query}' : 시청자수 미달 ${viewerExcludedCount}건 선제외 (기준=${minViewers})`);
      }

      // 2) 매칭 판정을 병렬 처리한다 — 순차 await면 음역 API 호출 지연이
      //    후보 수만큼 누적되므로 Promise.all로 가장 느린 호출 1건 수준으로 줄인다.
      const matchResults = await Promise.all(
        viewerFiltered.map(c => this._candidateMatchesKeyword(c, matchTerms))
      );
      const candidates = [];
      viewerFiltered.forEach((c, idx) => {
        const r = matchResults[idx];
        if (r.matched) candidates.push({ ...c, _relevance: r.score });
      });
      const excludedCount = viewerFiltered.length - candidates.length;
      console.log(`[CHEESE EYES][음역 필터] '${query}' 라이브 검색 결과(검색어 ${searchQueries.size}개 합산, 최소 시청자수 통과 ${viewerFiltered.length}건 대상): 통과 ${candidates.length}건 / 제외 ${excludedCount}건`);

      const withIndex = candidates.map((c, idx) => ({ ...c, _idx: idx }));
      const filtered = withIndex;
      // 정렬: 관련성 우선, 같으면 시청자 수, 그마저 같으면 원래 순서. 예전엔
      // 시청자 수 최우선 정렬이라 관련성 낮은 후보가 시청자 수만으로 상위 노출됐었다.
      filtered.sort((a, b) => {
        if (b._relevance !== a._relevance) return b._relevance - a._relevance;
        if (a._viewers == null && b._viewers == null) return a._idx - b._idx;
        if (a._viewers == null) return 1;
        if (b._viewers == null) return -1;
        if (b._viewers !== a._viewers) return b._viewers - a._viewers;
        return a._idx - b._idx;
      });
      return filtered.map(({ _idx, _viewers, _relevance, ...rest }) => rest);
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
    // 라이브 여부와 무관하게 이름으로 후보를 찾는다(프리셋 채널 검색용).
    // _candidateMatchesKeyword가 항상 채널명만으로 비교하므로 기준 미달
    // 후보는 제외된다.
    async searchCandidatesByKeyword(keyword) {
      try {
        const context = await this._context();
        const matchTerms = await this._buildKeywordMatchTerms(keyword);

        // 원본어 그대로는 결과가 안 나오는 경우가 많아 음역·별칭 보정
        // 키워드로도 함께 검색해 합친 뒤 유사도 필터를 적용한다
        // (_searchChannelRenderers와 동일 패턴).
        const searchQueries = new Set([keyword]);
        if (matchTerms.translated) searchQueries.add(matchTerms.translated);
        if (matchTerms.alias) searchQueries.add(matchTerms.alias);

        const dataList = await Promise.all(
          Array.from(searchQueries).map(q => this._innerTubePost('search', { context, query: q, params: 'EgIQAg%3D%3D' }))
        );

        const seen = new Set();
        const rawCandidates = [];
        dataList.forEach(data => {
          if (!data) return;
          this._collectChannelRenderers(data).forEach(ch => {
            if (!ch.hash || !ch.name || seen.has(ch.hash)) return;
            seen.add(ch.hash);
            rawCandidates.push(ch);
          });
        });

        const matchResults = await Promise.all(
          rawCandidates.map(ch => this._candidateMatchesKeyword(ch, matchTerms))
        );

        return rawCandidates
          .filter((_, idx) => matchResults[idx].matched)
          .map(ch => ({ platform: 'youtube', hash: ch.hash, name: ch.name }));
      } catch (err) {
        console.error(`'${keyword}' 유튜브 채널 검색 실패:`, err);
        return [];
      }
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
          const match = liveRenderers.map(vr => this._anyLiveNodeToChannel(vr)).find(c => c && c.hash === channelId);
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

      // browse 응답에 라이브 카드가 없는 채널(레이아웃상 흔함)을 위한 폴백.
      // videoId 없이 /embed/live_stream?channel=...로 임베드하면 "오류 153"이
      // 자주 나므로, /channel/<id>/live가 라이브 중엔 watch 페이지로
      // 캐노니컬되는 점을 이용해 videoId만 안전하게 추출한다.
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
    // checkChannelStillLive 전용 — _resolveByChannelId를 재사용하지 않는
    // 이유: 그 함수의 /live 폴백은 방송이 막 끝난 직후에도 한동안 직전
    // 방송의 watch 페이지 캐노니컬을 그대로 돌려주는 지연이 있었다(유튜브
    // 캐시/전파 지연 추정). 이를 "아직 라이브" 증거로 믿으면 끝난 영상이
    // 계속 재생되며 대기열로 안 넘어가는 버그가 생긴다. 여기선 (1) browse
    // 응답에 실제 라이브 배지 카드가 있으면 확정 라이브, (2) /live 캐노니컬이
    // 기존 videoId와 다르면(새 방송 시작) 확정 라이브, (3) 그 외는 오프라인
    // 판정. 조회가 둘 다 실패하면 null(호출부는 "판단 불가 -> 안 지움" 처리).
    async _checkStillLive(channelId, knownVideoId) {
      let browseOk = false;
      try {
        const context = await this._context();
        const data = await this._innerTubePost('browse', { context, browseId: channelId });
        if (data) {
          browseOk = true;
          const liveRenderers = this._collectLiveVideoRenderers(data);
          const match = liveRenderers.map(vr => this._anyLiveNodeToChannel(vr)).find(c => c && c.hash === channelId);
          if (match) return true;
        }
      } catch (err) {
        console.error(`'${channelId}' 유튜브 라이브 재확인 browse 실패:`, err);
      }

      let liveVideoId = null;
      let liveCheckOk = false;
      try {
        liveVideoId = await this._resolveLiveVideoIdFromLivePage(channelId);
        liveCheckOk = true;
      } catch (err) {
        console.error(`'${channelId}' 유튜브 라이브 재확인 /live 페이지 조회 실패:`, err);
      }

      if (liveVideoId && liveVideoId !== knownVideoId) return true;
      if (!browseOk && !liveCheckOk) return null;
      return false;
    },
    async _resolveByHandleOrText(text) {
      try {
        if (text.startsWith('@')) {
          // 핸들("@abc")은 채널명과 표기 체계가 다른 경우가 흔해서(예:
          // "@sinonsinfonia" vs "시논신포니아") 이름 유사도 필터를 거치면
          // 정답이 걸러질 수 있다 — 필터링 전 원본 후보에서 핸들 완전일치부터 찾는다.
          const { rawChannels } = await this._rawSearchChannelCandidates(text);
          const exact = rawChannels.find(ch => ch.handle && ch.handle.toLowerCase() === text.toLowerCase());
          if (exact) return await this._resolveByChannelId(exact.hash);
        }
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
        // 영상 링크(또는 영상ID)를 직접 붙여넣어 추가하는 "특정 영상 고정"
        // 경로다. 예전에는 name에 영상ID 문자열을 그대로 넣어서 채팅
        // 탭/음량 조절 패널에 채널명 대신 영상ID가 표시됐다 — 실제 영상
        // 메타(next 엔드포인트)를 조회해 채널명/영상 제목/라이브챗 보유
        // 여부까지 채워 넣는다.
        const meta = await this._resolveVideoMeta(id);
        return {
          platform: 'youtube',
          hash: id,
          name: (meta && meta.channelName) || id,
          title: (meta && meta.title) || '',
          videoId: id,
          hasLiveChat: meta ? meta.hasLiveChat : true,
          channelId: (meta && meta.channelId) || null,
          // 이 슬롯이 "채널 추적"이 아니라 "특정 영상 고정"이라는 표식.
          // videoId는 엔딩화면 추천 영상 클릭(§handleVodVideoChanged)으로
          // 나중에 다른 값으로 바뀔 수 있어 hash===videoId 비교만으로는
          // 판정할 수 없다 — hash는 최초 슬롯 식별자로 항상 고정이다.
          isPinnedVideoSlot: true,
          // 직접 붙여넣은 영상ID는 라이브 방송일 수도, 그냥 업로드된
          // 일반 영상(VOD)일 수도 있다. meta.isLive(실시간 확인)로 정확히
          // 판정한다 — 이 값이 없으면(메타 조회 자체가 실패) 예전 동작과
          // 동일하게 라이브로 간주한다. isVod=true인 영상은 계정 중복
          // 잠금 대상에서 빠지고(§getUsedLivePlatformsFromChannels), 화면을
          // 숨겨도 재생이 멈춘다(§3520 근처 주석) — 일반 영상 링크를 붙여넣고
          // 로그인하라는 알림이 뜨던 문제가 바로 이 판정 누락 때문이었다.
          isVod: meta ? !meta.isLive : false
        };
      }
      const found = await this._resolveByHandleOrText(id);
      if (found) return found;
      return { platform: 'youtube', hash: id, name: id };
    },
    // 영상 하나(videoId)의 메타데이터(제목/채널명/라이브챗 보유 여부)를
    // InnerTube의 next 엔드포인트로 조회한다. embed_domain 검증 없이도
    // 응답이 오는 공개 엔드포인트라, 라이브 여부와 무관하게 항상 쓸 수 있다.
    // hasLiveChat은 twoColumnWatchNextResults.conversationBar.liveChatRenderer
    // 존재 여부로 판정 — 현재 라이브 중이거나 다시보기 채팅이 남은 과거
    // 라이브 영상에서만 채워진다. 일반 업로드 영상은 이 필드가 없어 false.
    async _resolveVideoMeta(videoId) {
      try {
        const context = await this._context();
        const data = await this._innerTubePost('next', { context, videoId });
        if (!data) return null;
        const twoCol = data?.contents?.twoColumnWatchNextResults;
        const contents = twoCol?.results?.results?.contents;
        const primary = Array.isArray(contents) ? contents.find(c => c.videoPrimaryInfoRenderer) : null;
        const secondary = Array.isArray(contents) ? contents.find(c => c.videoSecondaryInfoRenderer) : null;
        const title = (primary?.videoPrimaryInfoRenderer?.title?.runs || []).map(r => r.text).join('')
          || primary?.videoPrimaryInfoRenderer?.title?.simpleText || '';
        const ownerRenderer = secondary?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
        const channelName = ownerRenderer?.title?.runs?.[0]?.text || '';
        const channelId = ownerRenderer?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '';
        const hasLiveChat = !!twoCol?.conversationBar?.liveChatRenderer;
        // 계정 중복 잠금(§getUsedLivePlatformsFromChannels)이 "특정 영상 고정"
        // 슬롯을 라이브/VOD 중 뭘로 볼지 판정하는 데 쓴다 — hasLiveChat은 과거
        // 라이브의 다시보기 채팅에도 켜져 있어 신뢰할 수 없고, InnerTube가
        // 실제로 "지금 라이브 중"만 true로 채워주는 필드는
        // videoViewCountRenderer.isLive뿐이다.
        const isLive = !!primary?.videoPrimaryInfoRenderer?.viewCount?.videoViewCountRenderer?.isLive;
        return { title, channelName, channelId, hasLiveChat, isLive };
      } catch (err) {
        console.error(`[CHEESE EYES] 유튜브 영상 메타 조회 실패 (${videoId}):`, err);
        return null;
      }
    },
    // 라이브챗 없는 영상의 댓글을 InnerTube next 엔드포인트로 가져온다.
    // continuationToken이 없으면 첫 페이지(댓글 섹션 진입 토큰을 먼저
    // 찾아 한 번 더 호출), 있으면 다음 페이지. 실제 댓글 텍스트/작성자는
    // frameworkUpdates.entityBatchUpdate.mutations[]의 commentEntityPayload에
    // 따로 들어있어 Map으로 모아 commentKey로 조인한다.
    async _fetchComments(videoId, continuationToken) {
      try {
        const context = await this._context();
        let data;
        if (continuationToken) {
          data = await this._innerTubePost('next', { context, continuation: continuationToken });
        } else {
          const first = await this._innerTubePost('next', { context, videoId });
          const token = first && this._findCommentsSectionToken(first);
          if (!token) return { items: [], nextToken: null };
          data = await this._innerTubePost('next', { context, continuation: token });
        }
        if (!data) return null;

        let continuationItems = null;
        const endpoints = data.onResponseReceivedEndpoints || [];
        for (const ep of endpoints) {
          if (ep.reloadContinuationItemsCommand && ep.reloadContinuationItemsCommand.slot === 'RELOAD_CONTINUATION_SLOT_BODY') {
            continuationItems = ep.reloadContinuationItemsCommand.continuationItems;
            break;
          }
          if (ep.appendContinuationItemsAction) {
            continuationItems = ep.appendContinuationItemsAction.continuationItems;
            break;
          }
        }
        if (!Array.isArray(continuationItems)) return { items: [], nextToken: null };

        const entities = this._collectCommentEntities(data);
        const items = [];
        let nextToken = null;
        let commentNodeCount = 0;
        continuationItems.forEach((node) => {
          if (node.continuationItemRenderer) {
            const tok = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
            if (tok) nextToken = tok;
            return;
          }
          // 최상위 댓글은 commentThreadRenderer로 감싸져 오지만, 답글은
          // commentThreadRenderer 없이 { commentViewModel: {commentKey, ...} }
          // 형태로 바로 온다 — _parseCommentThread가 기대하는 모양으로
          // 맞춰준다(안 하면 답글이 조용히 전부 걸러짐, replyCount>0인데
          // 펼치면 비어있던 버그의 원인).
          let thread = node.commentThreadRenderer;
          if (!thread && node.commentViewModel) {
            thread = { commentViewModel: { commentViewModel: node.commentViewModel } };
          }
          if (thread) commentNodeCount++;
          const parsed = thread && this._parseCommentThread(thread, entities);
          if (parsed) items.push(parsed);
        });

        // 댓글/답글 노드는 왔는데 하나도 못 파싱했다 — entities 조인 실패
        // 등 구조가 예상과 달라진 경우. nextToken이 있어도 이번 페이지가
        // 통째로 실패한 거면 "더 있음" 취급하면 안 되므로 parseFailed로
        // 명시하고 원본 응답도 콘솔에 남긴다.
        const parseFailed = commentNodeCount > 0 && items.length === 0;
        if (parseFailed) {
          console.warn('[CHEESE EYES] 유튜브 댓글/답글: commentThreadRenderer는 왔는데 파싱된 항목이 0개입니다. 콘솔에 copy(JSON.stringify(window.__ceLastFailedCommentsResponse)) 입력해서 구조를 확인해주세요.', { commentNodeCount });
          window.__ceLastFailedCommentsResponse = data;
        }

        return { items, nextToken: parseFailed ? null : nextToken, parseFailed };
      } catch (err) {
        console.error(`[CHEESE EYES] 유튜브 댓글 조회 실패 (${videoId}):`, err);
        return null;
      }
    },
    _findCommentsSectionToken(data) {
      try {
        const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
        if (!Array.isArray(contents)) return null;
        for (const c of contents) {
          const items = c?.itemSectionRenderer?.contents;
          if (!Array.isArray(items)) continue;
          for (const it of items) {
            const token = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
            if (token) return token;
          }
        }
      } catch (e) {}
      return null;
    },
    _collectCommentEntities(data) {
      const map = new Map();
      const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations;
      if (Array.isArray(mutations)) {
        mutations.forEach((m) => {
          const payload = m?.payload?.commentEntityPayload;
          if (payload && m.entityKey) map.set(m.entityKey, payload);
        });
      }
      return map;
    },
    _parseCommentThread(thread, entities) {
      try {
        const key = thread.commentViewModel?.commentViewModel?.commentKey;
        const payload = key ? entities.get(key) : null;
        if (!payload) return null;
        const commentId = payload.properties?.commentId || key;
        const text = payload.properties?.content?.content || '';
        const author = payload.author?.displayName || '';
        const avatarUrl = payload.author?.avatarThumbnailUrl || '';
        const publishedTime = payload.properties?.publishedTime || '';
        const likeCount = payload.toolbar?.likeCountLiked || payload.toolbar?.likeCountNotliked || '';
        const isOwner = !!payload.author?.isCreator;
        const isPinned = thread.renderingPriority === 'RENDERING_PRIORITY_PINNED_COMMENT';
        const replyCount = parseInt(String(payload.toolbar?.replyCount || '').replace(/[^0-9]/g, ''), 10) || 0;
        // 답글 진입 토큰 — 이 확장이 보내는 "얇은" context(§_context)로는
        // 브라우저 세션에서 보이는 subThreads가 아니라 contents로 온다
        // (예전엔 subThreads만 보고 판단해 답글 개수는 표시되는데 펼치면
        // 항상 비어 있었다). contents 우선, subThreads도 대비해 남기고,
        // 마지막으로 _findContinuationTokens로 한 번 더 찾는다.
        const repliesToken = thread.replies?.commentRepliesRenderer?.contents?.[0]
          ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
          || thread.replies?.commentRepliesRenderer?.subThreads?.[0]
            ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
          || this._findContinuationTokens(thread.replies || {})[0]
          || null;
        // 로그인 상태면 답글 작성창(commentSimpleboxRenderer)이 이 스레드
        // 안에 같이 실려있을 수 있어(§_getReplyComposerParams) 원본 노드를
        // 들고 있는다. 다소 무겁지만 한 페이지(20개) 단위라 감당할 만하다.
        return { id: commentId, text, author, avatarUrl, publishedTime, likeCount, isOwner, isPinned, replyCount, repliesToken, _raw: thread };
      } catch (e) { return null; }
    },
    // 로그인 상태일 때만 채워지는 댓글 작성창(commentSimpleboxRenderer)의
    // createCommentParams를 트리 전체에서 구조적으로 찾는다(위치가 top-level
    // 댓글 헤더/답글 스레드 등으로 달라질 수 있음, §_findContinuationTokens와
    // 동일 방식). 비로그인이면 렌더러 자체가 없어 null.
    _findCreateCommentParams(node) {
      if (!node || typeof node !== 'object') return null;
      const params = node?.commentSimpleboxRenderer?.submitButton?.buttonRenderer
        ?.serviceEndpoint?.createCommentEndpoint?.createCommentParams;
      if (params) return params;
      for (const key in node) {
        const val = node[key];
        if (val && typeof val === 'object') {
          const found = this._findCreateCommentParams(val);
          if (found) return found;
        }
      }
      return null;
    },
    // 새 댓글을 작성하기 위한 params. 댓글 섹션 헤더(commentsHeaderRenderer)
    // 아래 작성창은 로그인 상태에서만 채워진다 — 비로그인이면 null을
    // 돌려주고, 호출부가 "로그인이 필요합니다" 안내를 띄운다.
    async _getCommentComposerParams(videoId) {
      try {
        const context = await this._context();
        const first = await this._innerTubePost('next', { context, videoId }, true);
        const token = first && this._findCommentsSectionToken(first);
        if (!token) return null;
        const data = await this._innerTubePost('next', { context, continuation: token }, true);
        return data ? this._findCreateCommentParams(data) : null;
      } catch (err) {
        console.error(`[CHEESE EYES] 유튜브 댓글 작성 파라미터 조회 실패 (${videoId}):`, err);
        return null;
      }
    },
    // 특정 댓글에 답글을 달기 위한 params. 이미 받아둔 댓글 스레드 안에
    // 답글 작성창이 함께 실려있으면(로그인 상태) 네트워크 호출 없이 바로
    // 찾고, 없으면 그 댓글의 답글 목록 진입 토큰으로 next를 인증 상태로
    // 다시 호출해 받아온다.
    async _getReplyComposerParams(comment) {
      try {
        if (comment._raw) {
          const found = this._findCreateCommentParams(comment._raw);
          if (found) return found;
        }
        if (!comment.repliesToken) return null;
        const context = await this._context();
        const data = await this._innerTubePost('next', { context, continuation: comment.repliesToken }, true);
        return data ? this._findCreateCommentParams(data) : null;
      } catch (err) {
        console.error('[CHEESE EYES] 유튜브 답글 작성 파라미터 조회 실패:', err);
        return null;
      }
    },
    async _postComment(createCommentParams, text) {
      try {
        const context = await this._context();
        const data = await this._innerTubePost('comment/create_comment', { context, createCommentParams, commentText: text }, true);
        return !!data;
      } catch (err) {
        console.error('[CHEESE EYES] 유튜브 댓글 작성 실패:', err);
        return false;
      }
    },
    async fetchFollowingLive() {
      const context = await this._context();
      const data = await this._innerTubePost('browse', { context, browseId: 'FEsubscriptions' }, true);
      if (!data) { const err = new Error('youtube_following_failed'); throw err; }

      const results = new Map();
      const collectFrom = (node) => {
        const liveNodes = this._collectLiveVideoRenderers(node);
        for (const n of liveNodes) {
          const ch = this._anyLiveNodeToChannel(n);
          if (ch && ch.videoId) results.set(ch.videoId, ch);
        }
      };
      collectFrom(data);

      // richGridRenderer 구독 피드는 첫 페이지 이후가 continuation으로
      // 추가 로드되는 구조라, 한 페이지 더 따라가서 합친다.
      const tokens = this._findContinuationTokens(data);
      if (tokens.length > 0) {
        const contData = await this._innerTubePost('browse', { context, continuation: tokens[0] }, true);
        if (contData) collectFrom(contData);
      }

      console.log(`[CHEESE EYES][YT-DEBUG] FEsubscriptions에서 라이브 채널 ${results.size}개 확보`);
      return Array.from(results.values());
    },
    async checkLoginStatus() {
      return await checkLoginCookie('https://www.youtube.com/', ['SAPISID', '__Secure-3PAPISID']);
    },
    getLoginUrl() { return 'https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&continue=https://www.youtube.com/'; },
    getLogoutUrl() { return 'https://www.youtube.com/logout'; },
    getVideoEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      const videoId = ch && ch.videoId;
      // 오류153은 확장 origin에서 Referer가 비어있어 발생 — 실제 https
      // 도메인의 중계 페이지(relay.html?type=video)를 거쳐 정상 Referer/origin으로
      // 요청한다(yt-video.html/yt-chat.html을 relay.html로 통합).
      // 새로고침/재추가로 iframe이 다시 만들어지면 마지막 재생 위치가
      // 있는 경우 거기서 이어 재생한다(§CHANNEL_PLAYBACK_TIME). 최초 추가는
      // 기록이 없어 0초(또는 라이브 엣지)부터 시작.
      const resumeAt = lastKnownPlaybackTimeSec[id];
      const startParam = (typeof resumeAt === 'number' && resumeAt > 1) ? `&start=${Math.floor(resumeAt)}` : '';
      const url = videoId
        ? `${YT_RELAY_ORIGIN}/relay.html?type=video&v=${encodeURIComponent(videoId)}&autoplay=1${startParam}`
        : `${YT_RELAY_ORIGIN}/relay.html?type=video&channel=${encodeURIComponent(id)}&autoplay=1`;
      console.log(`[CHEESE EYES][YT-DEBUG] getVideoEmbedUrl(${id}) -> videoId=${videoId || '(없음)'} url=${url}`);
      return url;
    },
    getChatEmbedUrl(id) {
      const ch = getChannelObjByHash(id);
      const videoId = ch && ch.videoId;
      if (!videoId) return 'about:blank';
      // is_popout=1도 확장 origin에서는 거부당해, 실제 https 도메인(YT_RELAY_ORIGIN)의
      // 중계 페이지(relay.html?type=chat)를 거쳐 embed_domain 검증을 통과시킨다.
      // 방송이 끝난 영상(ch.isVod, §getChannelById/_resolveVideoMeta의 isLive
      // 판정)은 live_chat이 아니라 live_chat_replay를 써야 한다 — 유튜브는
      // 둘을 별개 엔드포인트로 구분해서, 끝난 방송에 live_chat을 그대로
      // 쓰면 실제로 채팅 다시보기가 남아있어도("hasLiveChat" 판정 참) "채팅을
      // 사용할 수 없는 실시간 스트림입니다"만 뜬다('r'/'ㄱ' 다시보기 검색으로
      // 추가한 과거 라이브 영상에서 실사용으로 확인된 버그).
      const replayParam = (ch && ch.isVod) ? '&replay=1' : '';
      return `${YT_RELAY_ORIGIN}/relay.html?type=chat&v=${encodeURIComponent(videoId)}${replayParam}`;
    },
    getChannelHomeUrl(id) {
      const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;
      if (YT_CHANNEL_ID_RE.test(id)) return `https://www.youtube.com/channel/${id}`;
      // "특정 영상 고정" 채널(hash===videoId)은 id가 채널ID가 아니라
      // 영상ID라 그대로 붙이면 404 — getChannelById에서 받아둔 실제
      // 채널ID(§_resolveVideoMeta)를 대신 쓴다.
      const ch = getChannelObjByHash(id);
      if (ch && ch.channelId && YT_CHANNEL_ID_RE.test(ch.channelId)) {
        return `https://www.youtube.com/channel/${ch.channelId}`;
      }
      return `https://www.youtube.com/${id}`;
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

// "특정 영상 고정"(hash===videoId) 채널의 라이브챗 보유 여부. 새로 추가된
// 채널은 getChannelById에서 이미 값을 채워왔지만, 이 필드가 생기기 전에
// 저장돼 새로고침으로 복원된 채널은 undefined일 수 있다 — 그 경우에만
// 다시 조회해 channels/displayChannels 양쪽에 캐시해 둔다(매 채팅 탭
// 전환/새로고침마다 다시 조회하지 않기 위함).
async function ensureYoutubeHasLiveChat(ch) {
  if (!ch) return true;
  if (typeof ch.hasLiveChat === 'boolean') return ch.hasLiveChat;
  const meta = await PlatformAdapters.youtube._resolveVideoMeta(ch.videoId);
  const has = meta ? meta.hasLiveChat : true;
  [channels, displayChannels].forEach(arr => {
    const c = arr.find(x => x.hash === ch.hash && x.platform === 'youtube');
    if (c) c.hasLiveChat = has;
  });
  return has;
}

function buildTabsBar(tabs, activeTab, onSelect, extraClass) {
  const bar = document.createElement('div');
  bar.className = 'search-platform-tabs' + (extraClass ? ` ${extraClass}` : '');
  tabs.forEach(tabInfo => {
    const el = document.createElement('div');
    el.className = 'search-platform-tab' + (tabInfo.key === activeTab ? ' active' : '');
    el.textContent = tabInfo.label;
    if (tabInfo.color) el.style.setProperty('--tab-color', tabInfo.color);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onSelect(tabInfo.key);
    });
    bar.appendChild(el);
  });
  return bar;
}

function buildPlatformTabsBar(activeTab, onSelect, excludePlatforms = []) {
  const tabs = [
    { key: 'all', label: t('platformTabs.all', '전체'), color: '#FFC800' },
    ...Object.keys(PLATFORM_META)
      .filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p] && !excludePlatforms.includes(p))
      .map(p => ({ key: p, label: getPlatformLabel(p), color: PLATFORM_META[p].color }))
  ];
  return buildTabsBar(tabs, activeTab, onSelect);
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

// ── 플레이어 조작 잠금/해제(첫 클릭=선택만/조작 막힘, 두번째 클릭=조작 가능) ──
// video-select-catcher는 카드 전체를 덮는 투명 레이어라 기본적으로 아래
// iframe에 클릭이 전달되지 않는다. 채널 클릭 시 캐처가 그 클릭을 가로채
// (="첫 클릭은 막힘") 채널 선택(메인 승격/채팅 전환)을 수행한 뒤, 같은
// 핸들러 안에서 곧장 캐처를 pointer-events: none으로 꺼서 이후 클릭은
// iframe으로 바로 전달된다. mouseup/click이 mousedown 시작 대상에 묶여
// 같은 클릭 도중 대상을 못 바꾸므로, "두 번째 클릭에 풀린다"는 첫 클릭
// 처리 종료 시점에 미리 풀어두는 방식으로 구현한다. 다른 채널을 클릭하면
// 이전 채널은 다시 잠기고 새 채널이 "첫 클릭" 단계부터 시작한다.
let controlUnlockedHash = null; // 현재 조작(플레이어 직접 클릭) 가능한 채널

function lockChannelControl(hash) {
  if (!hash) return;
  const wrapper = videoWrapperMap.get(hash);
  const catcher = wrapper?.querySelector('.video-select-catcher');
  if (catcher) catcher.style.pointerEvents = '';
  wrapper?.classList.remove('control-unlocked');
  if (controlUnlockedHash === hash) controlUnlockedHash = null;
}

function unlockChannelControl(hash) {
  if (!hash) return;
  const wrapper = videoWrapperMap.get(hash);
  const catcher = wrapper?.querySelector('.video-select-catcher');
  if (catcher) catcher.style.pointerEvents = 'none';
  wrapper?.classList.add('control-unlocked');
  controlUnlockedHash = hash;
}

function resetChannelControlState() {
  if (controlUnlockedHash) lockChannelControl(controlUnlockedHash);
  controlUnlockedHash = null;
}


const videoGrid = document.getElementById('video-grid');

function clearVideoGrid() {
  videoWrapperMap.forEach((wrapper) => {
    const iframe = wrapper.querySelector('iframe');
    if (iframe) iframe.src = 'about:blank';
    wrapper.remove();
  });
  videoWrapperMap.clear();
  if (videoGrid) videoGrid.innerHTML = '';
}

const chatTabs = document.getElementById('chat-tabs');
const chatContainer = document.getElementById('chat-frame-container');
const chatSidebar = document.getElementById('chat-sidebar');
const channelInput = document.getElementById('channel-input');
const autocompleteList = document.getElementById('autocomplete-list');
const chatToggleBtn = document.getElementById('chat-toggle');
const presetContainer = document.getElementById('preset-container');
const controlPanel = document.getElementById('control-panel');
const queueSidebar = document.getElementById('queue-sidebar');
const queueToggleBtn = document.getElementById('queue-toggle');
const queueList = document.getElementById('queue-list');
const queuePauseBtn = document.getElementById('queue-pause-btn');

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
document.getElementById('audio-settings-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAudioSettingsPanel();
});
document.getElementById('mode-grid')?.addEventListener('click', () => switchLayout('grid'));
document.getElementById('mode-main_sub')?.addEventListener('click', () => switchLayout('main_sub'));
document.getElementById('chat-toggle')?.addEventListener('click', toggleChat);
document.getElementById('queue-toggle')?.addEventListener('click', toggleQueueSidebar);
document.getElementById('queue-add-btn')?.addEventListener('click', batchAddUntargetedToGrid);
document.getElementById('queue-pause-btn')?.addEventListener('click', toggleQueuePause);
document.getElementById('queue-clear-btn')?.addEventListener('click', clearQueue);
document.getElementById('queue-hide-btn')?.addEventListener('click', () => {
  if (queueSidebarVisible) toggleQueueSidebar();
});

// 대기열 사이드바는 열림/닫힘 상태만 저장하고(§toggleQueueSidebar) 별도
// 마이그레이션 없이 바로 복원한다 — "패널을 열어뒀었는지"만 기억하면 되기
// 때문(대기열 목록 자체는 my_video_queue로 별도 저장, §saveQueueToStorage).
(function restoreQueueSidebarVisible() {
  const apply = (visible) => {
    queueSidebarVisible = !!visible;
    queueSidebar?.classList.toggle('active', queueSidebarVisible);
    queueToggleBtn?.classList.toggle('active', queueSidebarVisible);
  };
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['my_queue_sidebar_visible'], (result) => apply(result.my_queue_sidebar_visible));
  } else {
    apply(localStorage.getItem('my_queue_sidebar_visible') === '1');
  }
})();

function toggleQueueSidebar() {
  queueSidebarVisible = !queueSidebarVisible;
  queueSidebar?.classList.toggle('active', queueSidebarVisible);
  queueToggleBtn?.classList.toggle('active', queueSidebarVisible);
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ my_queue_sidebar_visible: queueSidebarVisible });
  } else {
    localStorage.setItem('my_queue_sidebar_visible', queueSidebarVisible ? '1' : '0');
  }
  if (typeof renderVideo === 'function') renderVideo();
}

// ── 화면 숨김(채널별 개별 적용) ───────────────────────────
// 채널마다 독립적으로 켜고 끈다(전역 아님) — 자원을 아끼고 남은 채널을
// 더 크게 보여주기 위해, 숨긴 채널은 그리드에서 완전히 빠지고(0크기,
// .video-hidden-item) 나머지 채널 크기 계산도 "보이는" 채널 수 기준으로
// 다시 한다. VOD는 영상도 실제 일시정지(§setChannelVideoPlaying) — 안 보는
// 화면을 계속 디코딩하는 낭비를 막고, 다시 켜도 같은 위치에서 이어진다.
// 라이브는 일시정지하지 않고 화면만 숨긴다 — 재생 재개 시 라이브 엣지로
// 재연결되며 버퍼링/오디오 끊김이 생기는데, "화면만 끄고 소리는 계속
// 듣기"가 라이브에서 더 흔한 용도라서다. 카드가 사라져 호버로 다시 켤 수
// 없으므로 버튼은 카드가 아니라 채팅탭에 둔다.
let videoHiddenChannels = new Set();
// 메인-서브 모드에서 "메인" 채널을 화면 숨김하면 서브 중 하나를 임시로
// 메인으로 자동 승격한다(toggleChannelVideoHidden). 이 변수는 "숨겨지기
// 전 진짜 메인이었던 채널"의 hash를 기억했다가 숨김이 풀리면 다시 메인
// 자리로 돌려놓는다. 그 사이 사용자가 다른 채널을 직접 메인으로 승격하면
// (setMainChannel) 이 자동 복귀 약속은 취소된다.
let pendingMainRestoreHash = null;
// 위 자동 승격도 내부적으로 setMainChannel을 호출하는데, setMainChannel의
// 무효화 로직이 이를 "사용자의 직접 승격"으로 오인해 방금 세팅한
// pendingMainRestoreHash를 지워버리지 않도록 이 플래그로 감싼다.
let suppressPendingMainInvalidate = false;
const VIDEO_SCREEN_EYE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const VIDEO_SCREEN_EYE_OFF_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06"></path><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.79 21.79 0 0 1-3.22 4.44"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><path d="M1 1l22 22"></path></svg>`;

function isChannelVideoHidden(hash) {
  return videoHiddenChannels.has(hash);
}

// 채팅탭 안의 버튼 하나를 그 탭이 속한 채널(hash) 기준으로 맞춘다.
function applyVideoScreenToggleState(btn, hash) {
  if (!btn || !hash) return;
  const hidden = isChannelVideoHidden(hash);
  btn.classList.toggle('active', hidden);
  btn.innerHTML = hidden ? VIDEO_SCREEN_EYE_OFF_ICON : VIDEO_SCREEN_EYE_ICON;
  btn.title = hidden
    ? t('mode.showScreen', '화면 표시')
    : t('mode.hideScreen', '화면 숨김(일시정지)');
}

// 탭마다 버튼 인스턴스가 하나씩 있으므로, 전부 각자의 채널 상태에 맞춰
// 다시 그린다. data-hash는 탭(.chat-tab) 쪽에 있다.
function updateChatTabVideoToggleIcons() {
  if (!chatTabs) return;
  chatTabs.querySelectorAll('.chat-tab').forEach((tab) => {
    const btn = tab.querySelector('.chat-tab-video-toggle-btn');
    const hash = tab.getAttribute('data-hash');
    applyVideoScreenToggleState(btn, hash);
  });
}

function toggleChannelVideoHidden(hash) {
  if (!hash) return;
  if (videoHiddenChannels.has(hash)) {
    // 화면 숨김 해제. 이 채널이 숨겨지기 전 진짜 메인이었다면 메인 자리를
    // 돌려준다. 그 사이 다른 채널이 직접 메인으로 승격돼 약속이 취소됐다면
    // (pendingMainRestoreHash가 비었거나 다른 채널이면) 그냥 서브로 표시한다.
    videoHiddenChannels.delete(hash);
    setChannelVideoPlaying(hash, true);
    if (pendingMainRestoreHash === hash) {
      pendingMainRestoreHash = null;
      if (mainChannel !== hash) setMainChannel(hash);
    }
  } else {
    videoHiddenChannels.add(hash);
    // 라이브 방송은 일시정지하지 않고 화면만 숨긴다 — VOD만 실제로 멈춘다.
    // isVod가 없으면 라이브로 취급한다.
    const channelObj = getChannelObjByHash(hash);
    if (channelObj && channelObj.isVod) setChannelVideoPlaying(hash, false);
    // 숨긴 채널이 메인-서브 모드의 메인이면, 보이는 서브 중 첫 번째를
    // 임시로 메인으로 자동 승격한다(displayChannels 순서 기준 — 서브 배열은
    // 건드리지 않고, 승격 전 메인만 pendingMainRestoreHash에 기억해둔다).
    if (currentLayout === 'main_sub' && hash === mainChannel) {
      const fallback = displayChannels.find(c => c.hash !== hash && !videoHiddenChannels.has(c.hash));
      if (fallback) {
        pendingMainRestoreHash = hash;
        suppressPendingMainInvalidate = true;
        setMainChannel(fallback.hash);
        suppressPendingMainInvalidate = false;
      }
    }
  }
  // 숨김 개수가 바뀌면 보이는 채널 개수도 바뀌므로 레이아웃을 다시 계산해야
  // 남은 채널들이 실제로 커진다.
  renderVideo();
  updateChatTabVideoToggleIcons();
  // 보이는 채널이 1개가 되거나 1개에서 늘어나면 getChannelRole 판정이
  // 바뀌어(isMainSubTreatedAsGrid) 음량 계산 기준이 통째로 달라진다 —
  // switchLayout과 동일하게 전 채널 음량을 다시 계산해야 한다.
  if (isCollabSettingEnabled()) recomputeCollabMuting();
  applyVolumeToAllChannels(true);
  renderAudioSettingsList();
  renderCollabSettingsSection();
}

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
  // videoId/isVod를 안 옮기면 유튜브 "특정 영상 고정"/VOD 항목이 새로고침
  // 후 일반 채널처럼 취급돼 깨진다 — 채널 hash가 아니라 라이브 재조회/
  // videoId 자동 갱신을 전부 건너뛰는 대상인데 그 구분 정보가 사라지기 때문.
  const migrateChannel = (c) => ({ platform: c.platform || 'chzzk', hash: c.hash, name: c.name, broadNo: c.broadNo, videoId: c.videoId, isVod: c.isVod, title: c.title, hasLiveChat: c.hasLiveChat, startSec: c.startSec, channelId: c.channelId, isPinnedVideoSlot: c.isPinnedVideoSlot });

  const loadInitialData = (savedChannels, savedPresets, savedLayout, savedSearchTab, savedChatVisible, savedMainChannel, savedAudioState, savedVideoQueue, savedQueuePaused) => {
    channels = (savedChannels || []).map(migrateChannel);
    videoQueue = Array.isArray(savedVideoQueue) ? savedVideoQueue : [];
    queuePaused = !!savedQueuePaused;
    displayChannels = [...channels];
    channelAddOrder = channels.map(c => c.hash);
    // 새로고침 전 저장해둔 재생 위치(§persistYoutubePlaybackPositions)를
    // 복원한다 — getVideoEmbedUrl이 이 값을 읽어 start=초로 이어서 재생한다
    // (예전엔 새로고침하면 항상 0초부터 다시 시작했다).
    channels.forEach((c) => {
      if (typeof c.startSec === 'number' && c.startSec > 1) lastKnownPlaybackTimeSec[c.hash] = c.startSec;
    });
    presets = (savedPresets || []).map(p => ({ ...p, channels: (p.channels || []).map(migrateChannel) }));
    currentLayout = savedLayout || 'grid';
    currentSearchPlatformTab = savedSearchTab || 'all';
    audioState = {
      // 예전 공용 값(마이그레이션 폴백 전용) — 새로 쓰지 않는다.
      // getMainVolumeForChannel 참고.
      mainVolume: (savedAudioState && typeof savedAudioState.mainVolume === 'number') ? savedAudioState.mainVolume : undefined,
      mainVolumeByChannel: (savedAudioState && savedAudioState.mainVolumeByChannel && typeof savedAudioState.mainVolumeByChannel === 'object') ? savedAudioState.mainVolumeByChannel : {},
      channelVolumeOverrides: (savedAudioState && savedAudioState.channelVolumeOverrides) ? savedAudioState.channelVolumeOverrides : {},
      collabGroups: (savedAudioState && Array.isArray(savedAudioState.collabGroups)) ? savedAudioState.collabGroups : [],
      vodStartTimeMsByHash: (savedAudioState && savedAudioState.vodStartTimeMsByHash && typeof savedAudioState.vodStartTimeMsByHash === 'object') ? savedAudioState.vodStartTimeMsByHash : {}
    };
    // 채널을 다시 불러올 때는 항상 음소거가 풀린 상태로 시작해야 한다 —
    // 이전 세션 뮤트(0%) 값이 남아있으면 계속 무음으로 뜬다. "낮지만 0은
    // 아닌" 값은 사용자가 일부러 맞춘 설정이므로 그대로 두고 뮤트만 초기화한다.
    if (resetMutedAudioStateOnLoad()) saveAudioState();
    if (pruneCollabGroups()) saveAudioState();

    if (displayChannels.length > 0) {
      // 저장된 메인 채널(setMainChannel로 승격했던 채널)이 아직 목록에 남아있다면
      // 그 채널을 0번(배열 맨 앞)으로 이동시켜 "3번 메인으로 설정 → 리로드 →
      // 다시 0번이 메인으로 튀어나옴" 문제를 없앤다. 없거나 삭제된 경우에만
      // 기존처럼 배열상 0번을 메인으로 사용한다.
      const restoredMainHash = (savedMainChannel && displayChannels.some(c => c.hash === savedMainChannel))
        ? savedMainChannel
        : displayChannels[0].hash;

      if (restoredMainHash !== displayChannels[0].hash) {
        // 예전에는 splice+unshift로 "맨 앞으로 이동"시켰는데, 이 방식은
        // 대상과 0번 사이에 있던 채널들을 전부 한 칸씩 밀어버려서 사실상
        // 배열 전체가 바뀌는 것처럼 보였다. 메인/서브 두 채널의 위치만
        // 서로 맞바꾸도록(swap) 수정한다.
        const swapToFront = (arr) => {
          const idx = arr.findIndex(c => c.hash === restoredMainHash);
          if (idx > 0) {
            const temp = arr[0];
            arr[0] = arr[idx];
            arr[idx] = temp;
          }
        };
        swapToFront(channels);
        swapToFront(displayChannels);
      }

      mainChannel = restoredMainHash;
      activeChatChannel = restoredMainHash;
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
    renderQueueSidebar();
  };

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['my_channels', 'my_presets', 'my_layout', 'search_platform_tab', 'my_chat_visible', 'main_channel', 'my_audio_state', 'my_video_queue', 'my_queue_paused'], (result) => {
      loadInitialData(result.my_channels, result.my_presets, result.my_layout, result.search_platform_tab, result.my_chat_visible, result.main_channel, result.my_audio_state, result.my_video_queue, result.my_queue_paused);
      // 복원된 채널 중 라이브 플랫폼이 있으면 그 계정 잠금을 확보한다
      // (로그인 안 됐거나 다른 곳에서 이미 쓰는 중이면 그 플랫폼만 제거+알림).
      reconcileInstanceLock();
      processPendingMultiviewAdd();
      processPendingQueueAdd();
    });
  } else {
    const savedChannels = JSON.parse(localStorage.getItem('my_channels') || '[]');
    const savedPresets = JSON.parse(localStorage.getItem('my_presets') || '[]');
    const savedLayout = localStorage.getItem('my_layout') || 'grid';
    const savedSearchTab = localStorage.getItem('search_platform_tab') || 'all';
    const savedChatVisible = localStorage.getItem('my_chat_visible') === '1';
    const savedMainChannel = localStorage.getItem('main_channel') || null;
    const savedAudioState = JSON.parse(localStorage.getItem('my_audio_state') || 'null');
    const savedVideoQueue = JSON.parse(localStorage.getItem('my_video_queue') || '[]');
    const savedQueuePaused = localStorage.getItem('my_queue_paused') === '1';
    loadInitialData(savedChannels, savedPresets, savedLayout, savedSearchTab, savedChatVisible, savedMainChannel, savedAudioState, savedVideoQueue, savedQueuePaused);
    reconcileInstanceLock();
    processPendingMultiviewAdd();
    processPendingQueueAdd();
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
    // 유튜브는 임베드 URL에 채널 해시(UC...)가 아니라 videoId가 들어있으므로
    // (숲/치지직은 URL에 채널 hash가 그대로 포함됨) videoId로도 매칭한다.
    const matchedChannel = channels.find(c => clickedUrl.includes(c.hash) || (c.videoId && clickedUrl.includes(c.videoId)));
    if (!matchedChannel) return;

    // 2026-08-16 후속(사용자 지시: "커서로 채널 변경할 때는 바뀌어야지",
    // "메인 채널 == 대표 채널로 해") — 예전엔 메인-서브 레이아웃에서만
    // 클릭으로 메인이 바뀌었다. 이제 메인 채널이 곧 합방 대표이기도
    // 하므로(§getCollabLeaderHash), 어느 레이아웃이든 프레임을 클릭하면
    // 메인/대표가 그 채널로 바뀐다.
    if (mainChannel !== matchedChannel.hash) {
      setMainChannel(matchedChannel.hash);
    }

    if (activeChatChannel !== matchedChannel.hash) {
      setChatChannel(matchedChannel.hash);
    }
  }
});

function findChannelHashByWindow(sourceWindow) {
  let matchedHash = null;
  videoWrapperMap.forEach((wrapper, hash) => {
    if (matchedHash) return;
    const iframe = wrapper.querySelector('iframe');
    // 유튜브는 embed_domain/Referer 검증 우회를 위해 relay.html 중계 페이지를
    // 한 번 더 거친다(§getVideoEmbedUrl) — 그 안의 실제 youtube.com/embed
    // 프레임에서 온 메시지도 relay.html이 window.parent로 그대로 올려보내
    // 주므로(docs/relay.html RELAY_UP_TYPES), event.source는 항상 이
    // 직계 iframe(relay.html 또는 치지직/숲 자체 iframe)과 일치한다 —
    // cross-origin 자식 프레임까지 직접 비교할 필요는 없다.
    if (iframe && iframe.contentWindow === sourceWindow) matchedHash = hash;
  });
  return matchedHash;
}

// 위 findChannelHashByWindow는 videoWrapperMap(영상 타일)만 뒤진다 —
// 채팅탭 iframe은 거기 안 잡히므로, 채팅 iframe에서 온 메시지를 매칭할
// 때는 이걸 쓴다(§attachChzzkVodChatWatchdog의 CHZZK_CHAT_EMBED_READY).
function findChatHashByWindow(sourceWindow) {
  if (!chatContainer) return null;
  let matchedHash = null;
  chatContainer.querySelectorAll('iframe.chat-iframe').forEach((iframe) => {
    if (matchedHash) return;
    if (iframe.contentWindow === sourceWindow) matchedHash = iframe.getAttribute('data-hash');
  });
  return matchedHash;
}

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'USER_VOLUME_CHANGE') return;
  const matchedHash = findChannelHashByWindow(event.source);
  if (matchedHash) handleUserVolumeChange(matchedHash, event.data.volume);
});

// VOD(다시보기) 재생이 끝까지 도달했다는 신호(content.js의 video 'ended' →
// 유튜브는 docs/relay.html이 중계) — 그 채널을 그리드에서 자동으로 뺀다.
// 라이브 방송이 오프라인으로 전환되는 경우는 이 이벤트가 아니라
// pollLiveStatusAndAutoRemove()의 주기적 확인이 담당한다(§아래).
window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHANNEL_VIDEO_ENDED') return;
  const matchedHash = findChannelHashByWindow(event.source);
  if (!matchedHash) return;

  // 대기열(§tryConsumeQueueForSlot, 화면 왼쪽 대기열 사이드바)에 이 자리로
  // 예약해둔(드래그) 영상이나, 지정 안 된 대기열 항목이 있으면 챗탭이
  // 열려있는지와 무관하게 그 영상으로 채워 넣는다 — 사용자가 이미 "다음엔
  // 이걸 보겠다"고 골라둔 것이므로 삭제 보류/자동 삭제 판단보다 우선한다.
  if (tryConsumeQueueForSlot(matchedHash)) {
    console.log(`[CHEESE EYES] ${matchedHash}: 영상 재생 종료 감지 -> 대기열 영상으로 교체`);
    return;
  }

  // 챗탭(라이브챗 없는 영상이면 댓글 패널)이 지금 이 채널을 보여주고
  // 있으면, 영상은 끝났어도 사용자가 아직 댓글을 읽거나 쓰는 중일 수
  // 있어 화면에서 빼지 않는다. 이 시점에만 검사하고 끝 — 그 뒤 챗탭을
  // 벗어나도 되돌아가 지우지는 않으며, 원하면 직접 삭제하면 된다.
  if (chatVisible && activeChatChannel === matchedHash) {
    console.log(`[CHEESE EYES] ${matchedHash}: 영상 재생 종료 감지했지만 챗탭이 열려있어 자동 삭제 보류`);
    return;
  }
  console.log(`[CHEESE EYES] ${matchedHash}: 영상 재생 종료 감지 -> 자동 삭제`);
  removeChannel(matchedHash);
});

// 유튜브 임베드 안에서 추천 영상/영상 카드가 클릭됐다는 신호(§docs/relay.html,
// content.js) — 예전처럼 바로 갈아끼우지 않고 이 채널의 대기열에 담아둔다.
// 화면 왼쪽 대기열 사이드바(§renderQueueSidebar)에서 확인/삭제할 수 있고,
// 지금 영상이 끝나면(위 CHANNEL_VIDEO_ENDED) 자동으로 이어서 재생된다.
window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'YT_SUGGESTION_CLICKED') return;
  const matchedHash = findChannelHashByWindow(event.source);
  if (matchedHash) enqueueYoutubeVideo(matchedHash, event.data.videoId, undefined, undefined, true);
});

// 엔딩화면(추천 영상)에서 다른 영상을 클릭해 재생 중인 영상 자체가
// 바뀌었다는 신호 — 유튜브는 docs/relay.html이 IFrame Player API의
// infoDelivery(videoData.video_id)로 감지해 중계하고, 치지직 VOD는
// content.js가 페이지 URL(/video/ID) 변경을 감지해 직접 보낸다. 두 경우
// 다 그 채널 슬롯을 지웠다 새로 추가하는 대신 같은 자리에서 새 영상으로
// 바꿔 끼운다(§handleVodVideoChanged).
window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHANNEL_VIDEO_CHANGED') return;
  const matchedHash = findChannelHashByWindow(event.source);
  if (matchedHash) handleVodVideoChanged(matchedHash, event.data);
});

async function handleVodVideoChanged(hash, data) {
  const ch = getChannelObjByHash(hash);
  const newVideoId = data && data.videoId;
  if (!ch || !newVideoId) return;

  if (ch.platform === 'youtube') {
    if (ch.videoId === newVideoId) return; // 이미 반영된 값의 중복 보고
    console.log(`[CHEESE EYES] ${hash}: 엔딩화면에서 다른 영상 클릭 감지 -> ${newVideoId}로 교체`);
    // hash(channelId)는 그대로라 합방 뮤팅 상태(collabMutedHashes 등)는
    // 안 지워지는데, 재생 내용은 완전히 다른 영상으로 바뀐다 — 과도기
    // 판정이 방금까지의 결정을 뒤집지 않게 잠깐 보류한다(§collabResetHoldUntilByHash).
    markCollabResetHold(hash);
    [channels, displayChannels].forEach(arr => {
      const c = arr.find(x => x.hash === hash && x.platform === 'youtube');
      if (!c) return;
      c.videoId = newVideoId;
      if (data.author) c.name = data.author;
      if (data.title) c.title = data.title;
      // 새 영상 기준으로 다시 판정해야 하는 값들 — hasLiveChat은 다음
      // 챗탭 로드 때 ensureYoutubeHasLiveChat이, channelId는 아래 비동기
      // 조회가 채워 넣는다.
      c.hasLiveChat = undefined;
      c.channelId = undefined;
    });
    saveChannelsToStorage();
    removeYoutubeCommentsPanel(hash);
    const iframe = chatContainer && chatContainer.querySelector(`iframe[data-hash="${hash}"]`);
    if (iframe) recreateChatIframe(iframe, hash, 'youtube');
    updateChatSession();

    // 채널명/제목은 postMessage로 이미 즉시 반영했지만(위), 채널ID(채널
    // 홈 이동용)는 InnerTube 조회가 필요해 비동기로 마저 채운다.
    const meta = await PlatformAdapters.youtube._resolveVideoMeta(newVideoId);
    if (!meta) return;
    let stillCurrent = false;
    [channels, displayChannels].forEach(arr => {
      const c = arr.find(x => x.hash === hash && x.platform === 'youtube');
      if (!c || c.videoId !== newVideoId) return; // 그 사이 또 바뀌었으면 낡은 값 반영 안 함
      stillCurrent = true;
      c.channelId = meta.channelId || null;
      if (meta.channelName) c.name = meta.channelName;
      if (meta.title) c.title = meta.title;
    });
    if (stillCurrent) { saveChannelsToStorage(); updateChatSession(); }
    return;
  }

  if (ch.platform === 'chzzk') {
    if (ch.hash === newVideoId) return;
    console.log(`[CHEESE EYES] ${hash}: 엔딩화면에서 다른 치지직 VOD 클릭 감지 -> ${newVideoId}로 교체`);
    // 같은 채널의 다른 영상으로 바뀌는 것뿐이라 channelId(§getChannelHomeUrl)는
    // 그대로 물려준다 — 예전 값이 없으면(가능하면) hash가 채널ID였을 수도
    // 있는 경우까지 최대한 커버.
    replaceVodChannelInPlace(hash, { platform: 'chzzk', hash: newVideoId, name: newVideoId.substring(0, 8), isVod: true, channelId: ch.channelId || null });
  }
}

// ── 화면 왼쪽 대기열 ─────────────────────────────────────────────────
// 채널별이 아니라 전역 하나의 목록(videoQueue)이다. targetHash가 없는
// 항목은 "지정 안 됨" — 사용자가 직접 삭제한 게 아닌 자동으로 빈 자리
// (영상 종료/라이브 오프라인, §tryConsumeQueueForSlot)라면 어느 채널
// 이었든 앞순서대로 채워 넣는다. targetHash가 있으면(드래그로 특정
// 채널 타일에 지정, §renderQueueSidebar 드롭 핸들러) 그 채널 전용으로
// 예약된다.

// 그리드에 "언젠가 자연스럽게 끝날 수 있는" 슬롯(VOD류 또는 videoId가
// 잡힌 유튜브)이 하나도 없으면 대기열에 넣어봤자 영원히 소비될 일이
// 없다 — 그럴 때는 대기열에 쌓지 않고 곧장 새 타일로 그리드에 추가한다.
function hasEndableSlot() {
  return channels.some(ch => ch.isVod || (ch.platform === 'youtube' && ch.videoId));
}

// 대기열 항목 하나를 그리드 맨 끝에 새 채널 타일로 추가한다(교체가 아니라
// 신규 추가) — 이미 같은 videoId가 떠 있으면 중복 추가하지 않는다.
function appendQueueItemAsNewChannel(item) {
  const newCh = {
    platform: 'youtube',
    hash: item.videoId,
    // 채널명 조회가 실패해도(예: 일부 영상은 InnerTube 응답 구조가 달라
    // ownerRenderer를 못 찾는 경우) 챗탭에 videoId 원문이 그대로 뜨는 것보다는
    // 영상 제목이라도 보여주는 게 낫다 — 둘 다 없을 때만 최후 수단으로
    // videoId를 쓴다.
    name: item.channelName || item.title || item.videoId,
    videoId: item.videoId,
    title: item.title || '',
    isPinnedVideoSlot: true,
    // 대기열은 애초에 "영상을 순서대로 이어보는" VOD 시청 흐름을 위한
    // 기능이라(docs/vod-replay-architecture.md), 여기서 채워지는 항목은
    // 항상 VOD로 취급한다 — 계정 중복 잠금 대상에서 제외된다.
    isVod: true
  };
  if (channels.some(c => c.hash === newCh.hash) || displayChannels.some(c => c.hash === newCh.hash)) return false;
  channels.push(newCh);
  displayChannels.push(newCh);
  channelAddOrder.push(newCh.hash);
  if (!mainChannel) mainChannel = newCh.hash;
  if (!activeChatChannel) activeChatChannel = newCh.hash;
  saveChannelsToStorage();
  renderAll();
  return true;
}

// 유튜브 임베드에서 추천 영상/영상 카드를 클릭해도 바로 갈아끼우지 않고
// 대기열에 담아둔다(멀티뷰 전용 — 치지직은 자체 SPA가 클릭 즉시 URL을
// 바꿔버려 가로챌 수 없어 대상에서 뺐다). sourceHash는 지금은 표시에
// 쓰지 않지만 클릭이 발생한 채널을 알아야 할 때를 대비해 받아둔다.
// 이미 그리드에 떠 있거나 대기열에 있는 영상이면 무시한다.
// presetTitle/presetChannelName은 호출부가 이미 다른 경로로 확보해둔
// 값이 있을 때(예: §processPendingQueueAdd의 getChannelById 결과) 미리
// 채워 넣는 용도다 — _resolveVideoMeta가 실패하거나 빈 값을 돌려줘도
// 이미 알고 있던 좋은 값을 빈 값으로 덮어쓰지 않기 위함이다.
// toFront가 true면(엔딩화면/추천영상 클릭 — 지금 보던 영상과 이어지는
// 맥락이라 다른 대기열 항목보다 먼저 재생되는 게 자연스럽다) 맨 뒤가
// 아니라 맨 앞에 꽂는다 — tryConsumeQueueForSlot(§위)이 지정 안 된 항목
// 중 맨 앞을 소비하므로, 다음으로 빈 자리가 생기면 이 영상이 우선된다.
async function enqueueYoutubeVideo(sourceHash, videoId, presetTitle, presetChannelName, toFront) {
  if (!videoId) return;
  if (channels.some(c => c.platform === 'youtube' && c.videoId === videoId)) return;
  if (videoQueue.some(v => v.videoId === videoId)) return;

  const item = { videoId, title: presetTitle || '', channelName: presetChannelName || '', targetHash: null };
  if (toFront) videoQueue.unshift(item); else videoQueue.push(item);
  saveQueueToStorage();
  renderQueueSidebar();

  const meta = await PlatformAdapters.youtube._resolveVideoMeta(videoId);
  // 메타를 기다리는 동안 사용자가 이미 이 항목을 대기열에서 지웠을 수도,
  // 지금 보던 영상이 그새 끝나 이 항목이 곧장 채널 슬롯으로 소비됐을 수도
  // 있다(§tryConsumeQueueForSlot) — 소비된 경우 그 시점엔 아직 이름을
  // 몰라 videoId를 임시 이름으로 썼을 테니(§tryConsumeQueueForSlot의
  // name 폴백), 여기서 실제 채널명/제목이 도착하면 그 슬롯에 마저
  // 채워 넣는다(§handleVodVideoChanged의 stillCurrent 패턴과 동일).
  // 사용자가 그 사이 직접 지웠으면 채널이 없을 테니 자연히 아무 일도
  // 안 한다.
  if (!videoQueue.includes(item)) {
    if (meta && (meta.channelName || meta.title)) {
      let stillCurrent = false;
      [channels, displayChannels].forEach(arr => {
        const c = arr.find(x => x.platform === 'youtube' && x.hash === videoId);
        if (!c) return;
        stillCurrent = true;
        if (meta.channelName) c.name = meta.channelName;
        if (meta.title) c.title = meta.title;
        if (meta.channelId) c.channelId = meta.channelId;
      });
      if (stillCurrent) { saveChannelsToStorage(); updateChatSession(); }
    }
    return;
  }
  if (meta) {
    if (meta.title) item.title = meta.title;
    if (meta.channelName) item.channelName = meta.channelName;
  }

  if (!hasEndableSlot()) {
    videoQueue.splice(videoQueue.indexOf(item), 1);
    appendQueueItemAsNewChannel(item);
  }
  saveQueueToStorage();
  renderQueueSidebar();
}

// 슬롯 hash가 자동으로 비려는 시점(영상 종료/라이브 오프라인 — 사용자가
// 직접 삭제 버튼을 누른 경우는 이 함수를 거치지 않는다)에 호출한다.
// 대기열에서 이 hash로 예약해둔(드래그) 항목을 우선 찾고, 없으면 지정
// 안 된 맨 앞 항목을 그 자리에 채워 넣는다. 실제로 채워 넣었으면 true를
// 돌려주며, 호출부는 이 경우 기존 삭제 로직을 건너뛰어야 한다.
function tryConsumeQueueForSlot(hash) {
  if (queuePaused) return false;
  if (!Array.isArray(videoQueue) || videoQueue.length === 0) return false;
  let idx = videoQueue.findIndex(v => v.targetHash === hash);
  if (idx === -1) idx = videoQueue.findIndex(v => !v.targetHash);
  if (idx === -1) return false;

  const item = videoQueue[idx];
  videoQueue.splice(idx, 1);
  saveQueueToStorage();
  replaceVodChannelInPlace(hash, {
    platform: 'youtube',
    hash: item.videoId,
    name: item.channelName || item.title || item.videoId,
    videoId: item.videoId,
    title: item.title || '',
    isPinnedVideoSlot: true,
    isVod: true // §appendQueueItemAsNewChannel과 동일한 이유
  });
  renderQueueSidebar();
  return true;
}

function removeQueuedVideo(index) {
  if (index < 0 || index >= videoQueue.length) return;
  videoQueue.splice(index, 1);
  saveQueueToStorage();
  renderQueueSidebar();
}

// 대기열 카드를 클릭하면(§renderQueueSidebar) 슬롯이 자동으로 빌 때까지
// 기다리지 않고 곧장 그리드에 새 타일로 추가한다 — appendQueueItemAsNewChannel과
// 같은 동작을 배치 버튼이 아니라 항목 하나 단위로 즉시 실행한다.
function promoteQueueItemToGrid(index) {
  const item = videoQueue[index];
  if (!item) return;
  videoQueue.splice(index, 1);
  saveQueueToStorage();
  appendQueueItemAsNewChannel(item);
  renderQueueSidebar();
}

// 대기열 항목을 특정 채널 타일에 드래그해 놓으면(§renderQueueSidebar,
// getOrCreateVideoWrapper의 drop 핸들러) 그 채널 전용으로 예약한다.
// targetHash를 null로 주면 예약을 해제한다.
function setQueueItemTarget(index, targetHash) {
  const item = videoQueue[index];
  if (!item) return;
  item.targetHash = targetHash || null;
  saveQueueToStorage();
  renderQueueSidebar();
}

// 대기열 항목을 다른 항목 위에 드래그해 놓으면(§renderQueueSidebar) 그
// 자리로 순서를 바꾼다 — 지정 안 된 항목은 소비 순서(맨 앞부터)에 그대로
// 영향을 준다.
function reorderQueue(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= videoQueue.length) return;
  const [moved] = videoQueue.splice(fromIndex, 1);
  videoQueue.splice(toIndex, 0, moved);
  saveQueueToStorage();
  renderQueueSidebar();
}

function clearQueue() {
  if (videoQueue.length === 0) return;
  videoQueue = [];
  saveQueueToStorage();
  renderQueueSidebar();
}

function toggleQueuePause() {
  queuePaused = !queuePaused;
  saveQueueToStorage();
  renderQueueSidebar();
}

// '대기열에 추가' 버튼 — 지정 안 된(드래그로 특정 채널에 예약해두지
// 않은) 대기열 항목을 전부 그리드에 새 타일로 일괄 추가한다. 특정
// 채널에 예약해둔 항목은 그 채널이 끝날 때까지 대기열에 그대로 남는다.
function batchAddUntargetedToGrid() {
  const untargeted = videoQueue.filter(v => !v.targetHash);
  if (untargeted.length === 0) return;
  untargeted.forEach((item) => {
    const idx = videoQueue.indexOf(item);
    if (idx !== -1) videoQueue.splice(idx, 1);
    appendQueueItemAsNewChannel(item);
  });
  saveQueueToStorage();
  renderQueueSidebar();
}

function renderQueueSidebar() {
  if (!queueList) return;
  queueList.innerHTML = '';

  if (videoQueue.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'queue-empty-state';
    emptyEl.textContent = t('queue.emptyState', '유튜브 추천 영상/영상 카드를 클릭하면 여기 대기열에 담깁니다. 슬롯이 자동으로 비면(영상 종료/라이브 오프라인) 이어서 채워 넣습니다.');
    queueList.appendChild(emptyEl);
  } else {
    const fragment = document.createDocumentFragment();
    videoQueue.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
      });
      // 다른 대기열 항목 위에 놓으면 그 자리로 순서를 바꾼다(§reorderQueue).
      // 그리드 채널 타일 위에 놓는 것(§getOrCreateVideoWrapper)과는 별개
      // 동작 — 드롭 대상이 다르므로 서로 간섭하지 않는다.
      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drag-over');
        const raw = e.dataTransfer && e.dataTransfer.getData('text/plain');
        const fromIndex = raw ? parseInt(raw, 10) : NaN;
        if (Number.isNaN(fromIndex)) return;
        reorderQueue(fromIndex, index);
      });

      const thumb = document.createElement('img');
      thumb.className = 'queue-item-thumb';
      thumb.loading = 'lazy';
      thumb.src = `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`;
      thumb.alt = '';
      row.appendChild(thumb);

      const info = document.createElement('div');
      info.className = 'queue-item-info';
      const titleEl = document.createElement('div');
      titleEl.className = 'queue-item-title';
      titleEl.textContent = item.title || item.videoId;
      info.appendChild(titleEl);

      const metaEl = document.createElement('div');
      metaEl.className = 'queue-item-meta';
      if (item.targetHash) {
        const targetCh = getChannelObjByHash(item.targetHash);
        const label = document.createElement('span');
        label.textContent = t('queue.reservedForTemplate', '{name} 전용으로 예약됨', { name: (targetCh && targetCh.name) || item.targetHash });
        metaEl.appendChild(label);
        const clearTargetBtn = document.createElement('button');
        clearTargetBtn.type = 'button';
        clearTargetBtn.className = 'queue-item-clear-target';
        clearTargetBtn.textContent = '×';
        clearTargetBtn.title = t('queue.clearTarget', '지정 해제');
        clearTargetBtn.addEventListener('click', (e) => { e.stopPropagation(); setQueueItemTarget(index, null); });
        metaEl.appendChild(clearTargetBtn);
      } else {
        metaEl.textContent = t('queue.pendingLabel', '대기 중');
      }
      info.appendChild(metaEl);
      row.appendChild(info);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'queue-item-remove';
      removeBtn.textContent = '×';
      removeBtn.title = t('queue.removeItem', '대기열에서 제거');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeQueuedVideo(index);
      });
      row.appendChild(removeBtn);

      // 카드를 클릭하면(×/지정 해제 버튼 제외 — 둘 다 자기 클릭에서
      // stopPropagation) 대기열에서 빼서 곧바로 그리드에 새 타일로
      // 추가한다 — 지금 끝나는 슬롯이 생길 때까지 기다리지 않고 바로
      // 보고 싶을 때 쓴다.
      row.title = t('queue.clickToApply', '클릭하면 대기열에서 빼서 바로 멀티뷰에 추가합니다');
      row.addEventListener('click', () => promoteQueueItemToGrid(index));

      fragment.appendChild(row);
    });
    queueList.appendChild(fragment);
  }

  if (queuePauseBtn) {
    queuePauseBtn.classList.toggle('active', queuePaused);
    queuePauseBtn.title = queuePaused ? t('queue.resume', '재생(자동 채우기 재개)') : t('queue.pause', '멈춤(자동 채우기 중지)');
    queuePauseBtn.textContent = queuePaused ? '▶' : '⏸';
  }
}

// 유튜브 영상/라이브가 몇 초째 재생 중인지 3초마다 흘려보내는 값
// (content.js) — 새로고침/재추가로 그 채널의 iframe이 통째로 다시 만들어질
// 때 getVideoEmbedUrl이 이 값을 start=초 로 실어 보내서, 처음(0초)이 아니라
// 원래 보던 위치 근처에서 이어지게 한다. 요청-응답 왕복 없이 그냥 "가장
// 최근에 받은 값"을 쓰는 방식이라 별도 동기화가 필요 없다.
const lastKnownPlaybackTimeSec = {};

// 채널(hash)이 보고한 영상 총 길이(초) — content.js가 CHANNEL_PLAYBACK_TIME과
// 함께 실제 <video>의 duration을 그대로 흘려보낸다(메타데이터 로드 전엔
// null). vod-sync 그룹의 두 방송이 서로 다른 시간에 시작/끝나 겹치지
// 않는 구간이 있을 때(§아래 VOD_SYNC 교집합 판정, 2026-08-16 후속) 그
// 멤버가 "아직 시작 전"/"이미 끝남" 상태인지 판단하는 데 쓴다.
const channelDurationSecByHash = {};

// expectedSec(대표 위치 + 오프셋 — "지금 대표 위치에 대응하는 멤버 쪽
// 시각")이 그 멤버가 실제로 재생 가능한 구간 [0, duration] 안에 있는지.
// duration을 아직 모르면(메타데이터 로드 전) 위쪽 경계는 판단을 보류하고
// 열어둔다(fail-open) — 아래쪽 경계(0초)는 duration 없이도 항상 판단
// 가능하다. CHANNEL_PLAYBACK_TIME 핸들러(지속적인 드리프트 보정)와
// triggerVodMetadataAutoAlign(멤버를 막 추가한 시점의 최초 정렬) 둘 다
// 이 함수로 판정을 통일한다.
function isVodSyncExpectedSecInWindow(expectedSec, memberDurationSec) {
  if (expectedSec < 0) return false;
  if (typeof memberDurationSec === 'number' && expectedSec > memberDurationSec) return false;
  return true;
}

// VOD 합방 싱크 동기화(docs/vod-collab-sync-architecture.md §0/§4.8) —
// 대표 채널 기준 ±1.5초(=그룹 전체 스프레드 3초 이내)를 넘게 벌어졌을
// 때만 실제로 시크한다. 매초 미세하게 시크하면 오히려 재생이 끊기는
// 체감이 생긴다 — 기존 CHZZK_VOD_CHAT_SYNC의 "2초 넘게 벌어졌을 때만"
// 원칙과 같다.
const VOD_SYNC_DRIFT_THRESHOLD_SEC = 1.5;

// 멤버별 "마지막으로 우리가 명령한 재생 상태" — 매초 오는 대표 보고마다
// 무조건 PLAY/PAUSE를 다시 보내면 §audio-architecture.md §2.1의
// USER_VOLUME_CHANGE 무변화 재전송 버그(램프 잠금)와 같은 패턴이 재현될
// 수 있어, 값이 실제로 바뀔 때만 보낸다.
const vodSyncLastCommandedPlaying = {};

// 대표→멤버 한 방향만 지원한다(§4.9). 멤버를 사용자가 직접 정지했을 때
// 그걸 "사용자 조작"으로 구분해 정책을 달리하려면(계속 따라가게 강제할지,
// 그 멤버만 동기화에서 빠지게 할지) volumechange 에코 판별과 같은 급의
// 인프라가 필요한데, docs/vod-collab-sync-architecture.md §8/§4.9-2가
// 아직 정책 자체를 확정하지 않았다 — 정책 없이 인프라만 먼저 만들지
// 않는다. 지금은 항상 대표를 따라간다.
window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHANNEL_PLAYBACK_TIME') return;
  const matchedHash = findChannelHashByWindow(event.source);
  if (matchedHash && typeof event.data.currentTime === 'number' && isFinite(event.data.currentTime)) {
    lastKnownPlaybackTimeSec[matchedHash] = event.data.currentTime;
  }
  if (matchedHash && typeof event.data.duration === 'number' && isFinite(event.data.duration)) {
    channelDurationSecByHash[matchedHash] = event.data.duration;
  }
  // VOD 합방 싱크 동기화(§4.8/§4.9) — 방금 보고한 채널이 vod-sync 그룹의
  // 대표면, 그 재생 위치/정지 상태를 각 멤버에게 반영한다: ① 위치는
  // 멤버의 오프셋만큼 이동한 "기대 위치"와 실제 위치가 벌어졌을 때만
  // 시크로 보정 ② 정지 상태는 대표를 그대로 따라가게 한다. 오프셋이
  // 아직 없는(정렬 전) 멤버는 둘 다 건드리지 않는다(§4.5).
  if (matchedHash && typeof event.data.currentTime === 'number' && isFinite(event.data.currentTime)) {
    const group = findCollabGroupForChannel(matchedHash);
    if (group && isVodSyncGroup(group) && getCollabLeaderHash(group) === matchedHash) {
      const repTime = event.data.currentTime;
      const repPlaying = !event.data.paused;
      group.memberHashes.forEach((memberHash) => {
        if (memberHash === matchedHash) return;
        const offsetSec = getVodSyncOffsetSec(group, memberHash);
        if (offsetSec === null) return;

        // 2026-08-16 후속(사용자 지적: 방송 시간이 서로 달라 두 VOD가
        // 전체가 아니라 일부 구간만 겹치는 경우 — 예: A 5시간, B 7시간,
        // "B 3시간 단독 + 중복 4시간 + A 1시간 단독"). expectedSec은
        // "대표가 지금 위치일 때 멤버 쪽에서 대응하는 시각"인데, 대표가
        // 겹치는 구간 밖에 있으면(멤버가 아직 시작 전이거나 이미 끝난
        // 시점) 이 값이 음수이거나 멤버의 실제 길이를 넘는다. 그 값으로
        // 그대로 시크하면 음수는 0으로 뭉개져(§content.js SEEK_TO_TIME)
        // 매초 다시 0으로 끌려가고, 길이 초과는 멤버가 끝까지 튕겨
        // 'ended'로 잡혀 채널이 삭제됐다(§docs/vod-collab-sync-architecture.md).
        // 교집합 밖에서는 시크로 쫓아가지 않는다 — 대표만 자유롭게
        // 움직인다(위 이유). 2026-08-16 후속(사용자 요청) — 대신 이
        // 멤버는 정지시켜둔다: 관계없는 구간을 멤버 혼자 계속 재생하며
        // 낭비하는 대신, 교집합 밖에 있는 동안은 화면에 멈춰 있는 게
        // 자연스럽다. 이미 정지 명령을 보낸 상태면(vodSyncLastCommandedPlaying
        // === false) 매 틱 다시 보내지 않는다 — 아래 재생/정지 동기화와
        // 같은 중복 억제 패턴 재사용. 다시 교집합에 들어오면 이 값이
        // false로 남아있어(repPlaying이 보통 true이므로) 자연히
        // "달라짐"으로 인식돼 재생이 한 번 다시 적용된다.
        const expectedSec = repTime + offsetSec;
        const memberDurationSec = channelDurationSecByHash[memberHash];
        if (!isVodSyncExpectedSecInWindow(expectedSec, memberDurationSec)) {
          if (vodSyncLastCommandedPlaying[memberHash] !== false) {
            vodSyncLastCommandedPlaying[memberHash] = false;
            setChannelVideoPlaying(memberHash, false);
          }
          return;
        }

        if (vodSyncLastCommandedPlaying[memberHash] !== repPlaying) {
          vodSyncLastCommandedPlaying[memberHash] = repPlaying;
          setChannelVideoPlaying(memberHash, repPlaying);
        }

        const memberActualSec = lastKnownPlaybackTimeSec[memberHash];
        if (typeof memberActualSec !== 'number') return;
        if (Math.abs(memberActualSec - expectedSec) > VOD_SYNC_DRIFT_THRESHOLD_SEC) {
          seekChannelToTime(memberHash, expectedSec);
        }
      });
    }
  }
  // 치지직 VOD 채팅 다시보기(§docs/vod-chat-architecture.md)는 채팅탭에
  // VOD 페이지를 통째로 한 번 더 불러와서(cheeseChatEmbed) 그 안의 숨겨진
  // 음소거 영상으로 채팅 위치를 따라간다. 그 숨겨진 영상은 원래 항상
  // 강제 재생만 됐는데, 그러면 메인 재생 타일에서 사용자가 정지/탐색해도
  // 채팅탭 쪽은 계속 자기 혼자 진행돼서 서로 어긋난다. 여기서 메인
  // 타일의 실제 재생 위치/정지 상태를 그 채팅 iframe으로 그대로
  // 릴레이해서(content.js가 적용) 두 쪽이 같은 위치를 보게 맞춘다.
  const ch = matchedHash && getChannelObjByHash(matchedHash);
  if (ch && ch.platform === 'chzzk' && ch.isVod) {
    const chatIframe = chatContainer && chatContainer.querySelector(`iframe[data-hash="${matchedHash}"]`);
    if (chatIframe && chatIframe.contentWindow) {
      chatIframe.contentWindow.postMessage({
        type: 'CHZZK_VOD_CHAT_SYNC',
        currentTime: event.data.currentTime,
        paused: !!event.data.paused
      }, '*');
    }
  }
});

// lastKnownPlaybackTimeSec는 메모리에만 있어서, 예전에는 페이지를
// 새로고침하면(탭 새로고침/확장 리로드) 그 값이 통째로 날아가 항상
// 영상 URL 그대로(처음부터) 다시 열렸다. 채널 객체에 startSec로 얹어
// saveChannelsToStorage()로 저장해두면, 다음 로드 때 loadInitialData가
// 그 값을 lastKnownPlaybackTimeSec로 복원하고 getVideoEmbedUrl이
// "영상url + start=초" 형식으로 이어서 재생한다.
function persistYoutubePlaybackPositions() {
  let changed = false;
  channels.forEach((ch) => {
    if (ch.platform !== 'youtube') return;
    const sec = lastKnownPlaybackTimeSec[ch.hash];
    if (typeof sec !== 'number' || !isFinite(sec) || sec <= 1) return;
    const rounded = Math.floor(sec);
    if (ch.startSec !== rounded) { ch.startSec = rounded; changed = true; }
  });
  if (changed) saveChannelsToStorage();
}
window.addEventListener('beforeunload', persistYoutubePlaybackPositions);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistYoutubePlaybackPositions();
});

// 채널별 오디오 패널에서 슬라이더를 드래그하는 도중에는(pointerdown~pointerup)
// 실시간 dB 갱신으로 인한 목록 전체 재렌더링을 건너뛴다 — 그렇지 않으면
// 드래그 중인 슬라이더 DOM이 통째로 교체되면서 조작감이 끊긴다.
let audioSettingsDragActive = false;
document.addEventListener('pointerup', () => { audioSettingsDragActive = false; });

// 패널이 열려 있고 드래그 중이 아닐 때만 다시 그린다 — 열려 있지 않으면
// 할 일이 없고, 드래그 중이면 DOM 교체로 조작감이 끊긴다.
function refreshAudioSettingsListIfSafe() {
  if (!audioSettingsDragActive && document.getElementById('audio-settings-panel')) {
    renderAudioSettingsList();
    renderCollabSettingsSection();
  }
}

// content.js가 각 채널 iframe 안에서 Web Audio API로 측정한 평균 오디오
// 레벨(dBFS)을 주기적으로 보고해온다. 값이 갱신될 때마다 그룹(그리드/서브)
// 재생 음량이 바뀔 수 있으므로 다시 적용하되, 채널마다 들어오는 보고가
// 겹치며 과도하게 자주 재적용되지 않도록 살짝 묶어서 처리한다.
let audioLevelApplyTimer = null;
// 이 디바운스는 원래 500ms 보고 주기보다 짧게(150ms) 잡아 "한 라운드에
// 한 번만" 재렌더링하려는 용도였다. content.js LEVEL_REPORT_INTERVAL_MS를
// 200ms로 줄이며 150ms<200ms가 되어 디바운스가 무력화돼(매 보고마다 타이머가
// 풀렸다 바로 재설정) 목록이 초당 5번씩 다시 그려지며 버튼 클릭이 씹히는
// 버그가 있었다. dB 이력은 여전히 200ms마다 쌓이지만(§pushDebugDbHistory),
// 목록 재렌더링/음량 재적용은 원래 의도한 500ms로 되돌린다.
const AUDIO_LEVEL_APPLY_DEBOUNCE_MS = 500;

// 합방 유사도 계산용 이력 버퍼 — 200ms 기준 25개(약 5초)만 유지한다.
// 너무 길면(예전 12초) 겹치기 시작한 직후에도 창 대부분이 과거의 "안
// 겹치던" 샘플로 채워져 상관계수가 느리게 올라가고 음소거까지 오래
// 걸린다. COLLAB_LAG_RANGE_MS(±3초)만큼 앞뒤로 비교하므로 이 값이 너무
// 작으면 가장자리 lag는 표본 부족으로 null만 나온다(디버그 패널 그래프
// 가운데만 채워지는 원인).
const COLLAB_HISTORY_MAX_SAMPLES = 25;

function pushChannelAudioLevelHistory(hash, db, t) {
  const history = channelAudioLevelHistory[hash] || (channelAudioLevelHistory[hash] = []);
  history.push({ t, db });
  if (history.length > COLLAB_HISTORY_MAX_SAMPLES) history.shift();
}

// 디버그 패널 전용 dB 이력 — 합방 상관 계산용 channelAudioLevelHistory
// (25개, ≈5초)와 완전히 분리된 별도 배열. 합방 로직 윈도는 반응 속도
// 때문에 짧게 유지하고, "더 넓은 범위를 촘촘하게" 보여달라는 요청은 이
// 배열 길이만 늘려서 충족한다. 합방 설정이 꺼져 있어도 항상 쌓는다
// (디버그 모드를 막 켰을 때 그래프가 비어 보이지 않도록).
const DEBUG_DB_HISTORY_MAX_SAMPLES = 150; // content.js LEVEL_REPORT_INTERVAL_MS(200ms) 기준 약 30초
let debugDbHistory = {};

// db: 합방 겹침 판정용 음성대역(300~3400Hz) 값(§collab-architecture.md §9) —
// 배경음악/효과음이 섞여도 상관 계산이 덜 흔들리도록 우선 사용.
// levelDb: §3.4 dB 평준화에 실제로 쓰이는 전체 대역 LUFS 값 — "실제로 얼마나
// 크게 재생 중인지" 확인용(디버그 패널에 db와 같이 겹쳐 그림).
// volPercent: 그 순간 적용 중이던 재생 볼륨(%) — levelDb는 gainNode 이전
// 신호라 그것만으론 실제 체감 음량을 알 수 없어, 샘플마다 볼륨%를 같이
// 기록해야 볼륨이 바뀐 구간까지 정확한 체감 음량 시계열
// (levelDb + 20*log10(volPercent/100))을 그릴 수 있다.
function pushDebugDbHistory(hash, db, levelDb, volPercent, t) {
  const arr = debugDbHistory[hash] || (debugDbHistory[hash] = []);
  arr.push({ t, db, levelDb, volPercent });
  if (arr.length > DEBUG_DB_HISTORY_MAX_SAMPLES) arr.shift();
}

// content.js의 200ms 피크 추적(§2.2)은 스파이크를 놓치지 않으려 각 보고
// 구간의 최댓값을 그대로 보고한다. 배경음악 박자 주기가 이 보고 주기와
// 가까우면(BPM 120≈500ms/박자) 매 보고값이 출렁이는 에일리어싱이 생긴다
// (디버그 패널의 규칙적인 톱니파). leveling용 피크 추적은 그대로 두고,
// 합방 판정/디버그 표시용 값에만 짧은(8개, 약 1.6초) 이동평균을 얹어
// 완만하게 만든다. 개수는 보고 간격에 비례해야 한다 — 안 그러면 서로
// 무관한 채널의 박자끼리 우연히 상관돼 보이는 오탐(겹침 오판)이 늘어난다.
const COLLAB_DB_SMOOTH_SAMPLES = 8;
let collabDbSmoothBuffer = {};

function smoothCollabDb(hash, rawDb) {
  const buf = collabDbSmoothBuffer[hash] || (collabDbSmoothBuffer[hash] = []);
  buf.push(rawDb);
  if (buf.length > COLLAB_DB_SMOOTH_SAMPLES) buf.shift();
  return buf.reduce((sum, v) => sum + v, 0) / buf.length;
}

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHANNEL_AUDIO_LEVEL') return;
  const matchedHash = findChannelHashByWindow(event.source);
  if (!matchedHash) return;
  const db = event.data.db;
  if (typeof db !== 'number' || !isFinite(db)) return;
  // voiceDb(있으면)는 음성대역(300~3400Hz)만 남긴 신호의 dB다(§9,
  // docs/collab-architecture.md) — 서로 다른 배경음악/게임 효과음이 섞여
  // 있어도 합방 겹침 판정(Stage 1 엔벨로프 상관, 디버그 dB 파형)이 덜
  // 흔들리도록 이 값을 우선 쓴다. 레거시 AnalyserNode 폴백 경로는 이
  // 필드를 안 보내므로 그때는 db로 조용히 폴백한다. leveling(균등 dB
  // 평준화: channelAudioLevels/pushChannelLevelingDb/pushMainDbSample)은
  // "전체적으로(음성+배경음 다 포함) 얼마나 큰가"가 목적이라 계속 원본
  // db(LUFS)를 그대로 쓴다 — voiceDb로 바꾸지 않는다.
  const voiceDb = event.data.voiceDb;
  const collabDbRaw = (typeof voiceDb === 'number' && isFinite(voiceDb)) ? voiceDb : db;
  const collabDb = smoothCollabDb(matchedHash, collabDbRaw);
  // channelAudioLevels는 "최신 측정치 1개"로만 쓴다(샘플이 아직 부족할 때의
  // 폴백 등) — 그룹 dB 평준화 비교 자체는 pushChannelLevelingDb로 쌓는 최근
  // 몇 초치 평균(getChannelLevelingDb)을 쓴다.
  channelAudioLevels[matchedHash] = db;
  if (isAudioOptimizationEnabled()) pushChannelLevelingDb(matchedHash, db);
  if (isCollabSettingEnabled()) pushChannelAudioLevelHistory(matchedHash, collabDb, Date.now());
  if (isAudioOptimizationEnabled()) pushMainDbSample(matchedHash, db);
  pushDebugDbHistory(matchedHash, collabDb, db, getDisplayVolumeForChannel(matchedHash), Date.now());

  if (audioLevelApplyTimer) return;
  audioLevelApplyTimer = setTimeout(() => {
    audioLevelApplyTimer = null;
    if (isCollabSettingEnabled()) recomputeCollabMuting();
    // 측정치가 갱신될 때마다 자동으로 다시 계산되는 감쇠라 방송 음량이
    // 오르내릴 때마다 계속 발생한다 — 메인↔서브 전환(setMainChannel)처럼
    // 사용자가 직접 고른 즉시 반응이 필요한 전환이 아니므로, 값이 훅훅
    // 튀어 보이지 않도록 부드럽게 넘어가게 한다.
    applyVolumeToAllChannels(true);
    refreshAudioSettingsListIfSafe();
  }, AUDIO_LEVEL_APPLY_DEBOUNCE_MS);
});

// content.js가 라이브 엣지까지의 거리(레이턴시)를 주기적으로(1.5초 간격)
// 보고해온다 — docs/collab-latency-architecture.md §3.3. 음량 재적용/재렌더링을
// 트리거할 필요는 없다(재생 볼륨에는 관여하지 않고, 다음 recomputeCollabMuting
// 사이클에서 클러스터 keeper 선정에만 참고된다).
window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHANNEL_LIVE_LATENCY') return;
  const matchedHash = findChannelHashByWindow(event.source);
  if (!matchedHash) return;
  const latencySec = event.data.latencySec;
  if (typeof latencySec !== 'number' || !isFinite(latencySec)) return;
  channelLatencySecByHash[matchedHash] = smoothChannelLatency(matchedHash, latencySec);
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

  // 채널 구성이 바뀔 때마다 잠금 범위(사용 중인 플랫폼)도 함께 재조정한다.
  reconcileInstanceLock();
}

// 대기열은 채널 목록과 별도 키로 저장한다 — 채널이 하나도 없어도(대기열
// 항목이 아직 어느 슬롯에도 배정되지 않은 상태) 유지되어야 하기 때문.
// 추가/삭제/배정/일시정지 전환 등 대기열이 바뀔 때마다 호출한다.
function saveQueueToStorage() {
  const dataToSave = { 'my_video_queue': videoQueue, 'my_queue_paused': queuePaused };
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set(dataToSave);
  } else {
    localStorage.setItem('my_video_queue', JSON.stringify(videoQueue));
    localStorage.setItem('my_queue_paused', queuePaused ? '1' : '0');
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

function saveAudioState() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ 'my_audio_state': audioState });
  } else {
    localStorage.setItem('my_audio_state', JSON.stringify(audioState));
  }
}

// smooth=true면 content.js가 목표 음량까지 즉시 튀지 않고 약 0.5초에
// 걸쳐 자연스럽게 변화시킨다(모드 전환처럼 여러 채널의 목표 음량이 한꺼번에
// 크게 바뀌는 경우에 쓴다). 슬라이더 드래그나 dB 자동 보정처럼 이미 점진적인
// 조작에는 쓰지 않는다 — 그런 곳까지 매번 0.5초 지연을 더하면 오히려
// 굼뜨게 느껴진다.
//
// content.js에 마지막으로 보낸 값을 채널별로 기억해둔다 — dB 자동 평준화는
// 측정치 갱신마다(~500ms) 이 함수를 호출하는데, 계산 결과가 지난번과 같아도
// 예전엔 무조건 재전송했다. content.js는 smooth=true 재전송마다 새 1200ms
// 램프를 시작해서, 500ms 간격 재전송이 이전 램프가 끝나기 전에 또 새 램프를
// 걸어 __cheeseRampInProgress가 사실상 영구 true가 되고, 그동안 진짜
// 네이티브 플레이어 조작(volumechange)이 씹혀 "플레이어 조작이 멀티뷰에
// 반영 안 되는" 버그가 났다. 바뀐 게 없으면 재전송을 아예 안 하는 게 해법이다.
let lastSentVolumeMessage = {}; // hash -> { volume, needsGraph, compressorEnabled }

function postVolumeMessage(hash, value, smooth) {
  const wrapper = videoWrapperMap.get(hash);
  const iframe = wrapper && wrapper.querySelector('iframe');
  if (iframe && iframe.contentWindow) {
    // needsGraph: content.js가 dB 측정용 Web Audio 그래프를 만들지 판단하는
    // 신호. 합방 설정이 켜져 있고 이 채널이 합방 그룹 소속이면 "오디오
    // 최적화"가 꺼져 있어도 유사도 계산용 dB 이력을 위해 그래프를 강제로
    // 만든다. 오디오 디버그 섹션이 켜져 있을 때도 마찬가지(디버그 패널의
    // dB 파형은 항상 보여줘야 하므로). 볼륨 자체는 그래프 유무와 무관하게
    // 항상 content.js의 video.volume이 담당하므로 "오디오 최적화" 체크박스
    // 상태를 따로 넘길 필요는 없다.
    const needsGraph = isAudioOptimizationEnabled()
      || isAudioDebugSectionEnabled()
      || (isCollabSettingEnabled() && !!findCollabGroupForChannel(hash));
    const compressorEnabled = isDynamicsCompressorEnabled();
    // docs/collab-architecture.md §13 — 합방 음소거는 더 이상 volume을
    // 0으로 접어서 보내지 않는다(호출부가 항상 "진짜" 목표를 넘긴다,
    // §applyVolumeToAllChannels 등). 대신 이 여부만 별도로 실어 보내서
    // content.js가 video.volume은 그대로 두고 gainNode로만 스피커 출력을
    // 죽이게 한다 — 측정 탭이 gainNode보다 앞이라 측정은 계속 산다.
    const collabMuted = isCollabMutedNow(hash);

    const last = lastSentVolumeMessage[hash];
    if (last && last.volume === value && last.needsGraph === needsGraph
      && last.compressorEnabled === compressorEnabled && last.collabMuted === collabMuted) {
      return;
    }
    lastSentVolumeMessage[hash] = { volume: value, needsGraph, compressorEnabled, collabMuted };

    iframe.contentWindow.postMessage({
      type: 'SET_CHANNEL_VOLUME',
      volume: value,
      smooth: !!smooth,
      needsGraph,
      // 다이나믹 컴프레서 서브 토글 상태(§5.5). 오디오 그래프 자체를 만들지
      // 않는 채널(needsGraph=false)에서는 content.js가 이 값을 그냥 무시한다.
      compressorEnabled,
      collabMuted
    }, '*');
  }
}

// 버그 수정("메인-서브에서 자꾸 자동→수동으로 바뀐다", §content.js
// volumeReportSuppressedUntil) — 메인 채널 전환/레이아웃 전환은 <video>
// 엘리먼트를 새로 만들지 않고 같은 엘리먼트의 렌더링 크기만 바꾸는데, 이때
// 치지직/숲 플레이어가 순간적으로 video.volume/muted를 건드리는 경우가
// 있다. 그 직후 짧은 구간만 모든 채널의 volumechange "사용자 조작" 보고를
// 추가로 억제해서, 그 순간값이 수동 고정값으로 잘못 저장되는 걸 막는다 —
// 실제 볼륨 재적용(SET_CHANNEL_VOLUME)은 이 함수와 무관하게 평소대로
// 일어나므로 소리 자체에는 영향이 없다.
function suppressVolumeEchoReports(durationMs) {
  videoWrapperMap.forEach((wrapper) => {
    const iframe = wrapper.querySelector('iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'SUPPRESS_VOLUME_ECHO', durationMs }, '*');
    }
  });
}

// 채널을 해당 지점(초)으로 이동시킨다. postVolumeMessage와 동일하게
// videoWrapperMap에서 이 채널의 실제 iframe을 찾아 SEEK_TO_TIME을
// 보낸다 — 유튜브는 relay.html이 이걸 받아 안쪽 embed 프레임에 공식
// seekTo 명령으로 릴레이하고(§docs/relay.html), 치지직/숲은 이 iframe이
// 곧 content.js가 주입된 실제 시청 페이지라 같은 메시지를 직접 받아
// video.currentTime을 설정한다(§content.js SEEK_TO_TIME 핸들러). 원래
// 댓글 타임스탬프 클릭(§renderYoutubeCommentTextWithTimestamps, 유튜브
// 전용) 용도로 만들어졌지만 이름과 달리 구현 자체는 플랫폼 무관이라
// VOD 합방 싱크 동기화(docs/vod-collab-sync-architecture.md §4.7/§4.8)도
// 그대로 재사용한다.
function seekChannelToTime(hash, seconds) {
  const wrapper = videoWrapperMap.get(hash);
  const iframe = wrapper && wrapper.querySelector('iframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'SEEK_TO_TIME', seconds }, '*');
    // 모든 시크(드리프트 보정 §4.8, vod-sync 정렬/보정 시크, 댓글 타임스탬프
    // 클릭)가 이 함수 하나를 거치므로 여기 한 곳에서만 표시해도 전부
    // 덮인다(§collabResetHoldUntilByHash).
    markCollabResetHold(hash);
  }
}

// 화면 숨김(§toggleChannelVideoHidden)한 채널의 영상을 실제로
// 멈춰/이어서 재생한다. 유튜브는 이 iframe이 relay.html이라 'PAUSE'/'PLAY'를
// 유튜브 공식 IFrame Player API 명령(pauseVideo/playVideo)으로 릴레이하고
// (§docs/relay.html), 치지직/숲은 이 iframe이 곧 content.js가 주입된 실제
// 시청 페이지라 같은 메시지를 직접 받아 <video> 엘리먼트를 멈추고/재생한다.
function setChannelVideoPlaying(hash, playing) {
  const wrapper = videoWrapperMap.get(hash);
  const iframe = wrapper && wrapper.querySelector('iframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: playing ? 'PLAY' : 'PAUSE' }, '*');
  }
}

// 메인-서브 모드인데 실제로 화면에 보이는(화면 숨김 아닌) 채널이 1개뿐이면
// "메인/서브"라는 구분 자체가 의미가 없다 — 서브가 아예 없는 셈이므로 이때는
// 그리드 모드와 완전히 동일하게 취급한다(오디오 역할·화면 레이아웃 모두).
// 화면 숨김은 "화면만 빠지고 오디오는 계속 재생"이므로(2596번째 줄 근처
// 주석 참고) 숨긴 채널도 오디오 채널 수에는 여전히 잡혀야 하지만, 여기서는
// "메인 옆에 실제로 보이는 서브가 있는지"만 보면 되므로 화면 숨김 채널은
// 제외하고 센다. currentLayout 값 자체(사용자가 고른 모드)는 건드리지
// 않는다 — 채널을 다시 추가하면 곧바로 원래의 메인-서브 레이아웃으로
// 돌아와야 하기 때문이다.
function isMainSubTreatedAsGrid() {
  if (currentLayout !== 'main_sub') return false;
  const visibleCount = displayChannels.filter(c => !videoHiddenChannels.has(c.hash)).length;
  return visibleCount === 1;
}

// 채널이 현재 오디오 관점에서 어떤 역할인지("main"/"sub"/"grid")를 한 곳에서만
// 판정한다. 볼륨을 읽고/쓰고/보여주는 모든 곳이 currentLayout/mainChannel을
// 각자 다시 비교하지 않고 이 함수를 거치도록 해서 판정 기준이 갈라지는 것을 막는다.
// "메인" 역할은 메인-서브 모드 전용이다 — 그리드 모드에서는 mainChannel로
// 지정해 둔 채널도 특별 취급 없이 그냥 'grid'다(전 채널 동등 평준화,
// getMainReferenceDbAtBaseline 참고). isMainSubTreatedAsGrid는 "화면에 보이는
// 서브가 없을 때 화면 배열만 그리드처럼 채운다"는 뜻일 뿐, 오디오 역할까지
// 그리드로 바꾸는 게 아니다 — 숨긴 서브도 계속 오디오를 재생 중이므로 여기서는
// 건드리지 않는다.
function getChannelRole(hash) {
  if (currentLayout !== 'main_sub') return 'grid';
  return hash === mainChannel ? 'main' : 'sub';
}

// ── 합방(동시 출연) 그룹 헬퍼 ──────────────────────────────────────────
function findCollabGroupForChannel(hash) {
  return audioState.collabGroups.find(g => g.memberHashes.includes(hash)) || null;
}

// docs/vod-collab-sync-architecture.md §5 — 'vod-sync' 그룹은 라이브
// 겹침 감지(Stage1/2)를 전혀 돌리지 않고, 대표 채널 외 항상 음소거 +
// 재생위치 동기화라는 별도 규칙을 따른다. mode 필드가 없는(기존 저장된)
// 그룹은 항상 'live'로 취급한다.
function isVodSyncGroup(group) {
  return !!group && group.mode === 'vod-sync';
}

// 'vod-sync' 그룹 멤버의 현재 대표 채널 대비 재생위치 오프셋(초) — 양수면
// 그 멤버가 대표보다 그만큼 늦게 시작한 VOD라는 뜻(§4.4). vodStartTimeMsByHash
// (§calculateChzzkVodStartTime 아래)에 대표/멤버 둘 다의 "실제 방송 시작
// 시각" 캐시가 있으면 그 자리에서 빼서 바로 돌려준다 — 대표가 바뀌어도
// 저장된 값을 다시 계산할 필요가 없다(사용자 요청: "양방향, 초기에
// 한번만 계산, 나머지는 캐싱된거를 이용"). 둘 중 하나라도 캐시가 없으면
// (비치지직 멤버, API 실패 등) group.vodOffsetSecByHash에 저장된 값(수동
// 입력 폴백, §렌더 함수의 offsetInput 핸들러)으로 물러난다. 어느 쪽도
// 없으면(=값이 없으면) "아직 정렬 안 됨" 상태로 취급해 자동 음소거/시크
// 대상에서 제외한다(§4.5의 "정렬 실패/미완료는 예외" 정책과 동일 취급).
function getVodSyncOffsetSec(group, hash) {
  if (!group) return null;
  const representativeHash = getCollabLeaderHash(group);
  if (representativeHash && representativeHash !== hash) {
    const repStartMs = audioState.vodStartTimeMsByHash[representativeHash];
    const memberStartMs = audioState.vodStartTimeMsByHash[hash];
    if (typeof repStartMs === 'number' && typeof memberStartMs === 'number') {
      return (repStartMs - memberStartMs) / 1000;
    }
  }
  const v = group.vodOffsetSecByHash && group.vodOffsetSecByHash[hash];
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

// 그룹의 "리더"(오디오를 살려둘 채널) = 메인 채널. 2026-08-16 후속
// (사용자 지시: "메인 채널 == 대표 채널로 해, 기존 그리드/메인-서브
// 레이아웃 설정을 그대로 따라 새로 설정하지 말고") — 예전엔 레이아웃
// 별로 기준이 갈렸다(메인-서브: mainChannel 우선 / 그리드: 별도
// leaderHash 수동 지정 또는 자동 판정). 이제 레이아웃과 무관하게
// mainChannel이 그룹 소속이면 무조건 그게 리더다 — 별도 leaderHash
// 개념 자체를 없앴다(§renderCollabGroupCard 리더 라디오가 이제
// setMainChannel을 직접 호출). mainChannel이 이 그룹 소속이 아니면
// (그룹에 아직 메인 채널이 없는 경우) 첫 멤버로 결정적으로 폴백한다.
function getCollabLeaderHash(group) {
  if (!group || group.memberHashes.length === 0) return null;
  if (mainChannel && group.memberHashes.includes(mainChannel)) {
    return mainChannel;
  }
  return group.memberHashes[0];
}

// 더 이상 존재하지 않는 채널(삭제됨)을 모든 합방 그룹에서 제거하고, 멤버가
// 1명 이하로 줄어든(더 이상 "겹칠" 상대가 없는) 그룹은 통째로 지운다.
function pruneCollabGroups() {
  const validHashes = new Set(displayChannels.map(c => c.hash));
  const before = JSON.stringify(audioState.collabGroups);
  audioState.collabGroups = audioState.collabGroups
    .map((g) => {
      const memberHashes = g.memberHashes.filter(h => validHashes.has(h));
      const mode = g.mode === 'vod-sync' ? 'vod-sync' : 'live';
      // 저장된 그룹에 없던 필드라 기존 사용자 데이터엔 없을 수 있다 — 항상
      // 존재를 보장해 이후 코드가 매번 null 체크를 안 해도 되게 한다.
      const vodOffsetSecByHash = {};
      if (g.vodOffsetSecByHash) {
        memberHashes.forEach((h) => {
          const v = g.vodOffsetSecByHash[h];
          if (typeof v === 'number' && isFinite(v)) vodOffsetSecByHash[h] = v;
        });
      }
      return { ...g, memberHashes, mode, vodOffsetSecByHash };
    })
    .filter(g => g.memberHashes.length >= 2);
  return JSON.stringify(audioState.collabGroups) !== before;
}

function isChannelCollabMuted(hash) {
  return collabMutedHashes.has(hash);
}

// 쌍(pair) 단위 상태(Stage1/2 점수, 히스테리시스 등)를 hash 2개가 아니라
// 정렬된 문자열 키 하나로 관리하기 위한 헬퍼 — 순서와 무관하게 항상 같은
// 키가 나오게 한다(pairKey(a,b) === pairKey(b,a)).
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// 채널이 완전히 삭제될 때(removeChannel) 그 채널이 관여한 쌍(pairKey) 상태를
// 전부 지운다. recomputeCollabMuting이 다음 사이클에 트래킹 대상에서 빠진
// 쌍을 알아서 정리하긴 하지만(collabActiveEdges 등), 디버그 표시용
// collabDebugLagCorrByPair는 그 정리 대상에 포함되지 않아 여기서 명시적으로
// 지워야 한다 — 나머지도 한 번에 같이 정리해 삭제 직후 한 사이클 동안
// 유령 상태가 보이지 않게 한다.
function deletePairEntriesForHash(hash) {
  [collabDebugLagCorrByPair, collabEdgeMuteCandidateSince, collabEdgeUnmuteCandidateSince,
    collabWaveformScoreByPair, collabPairCandidateLastSeenAt, collabPairLastConfirmedAt].forEach((map) => {
    Object.keys(map).forEach((key) => {
      if (key.split('|').includes(hash)) delete map[key];
    });
  });
  [collabActiveEdges, collabWaveformRefreshInFlight].forEach((set) => {
    Array.from(set).forEach((key) => {
      if (key.split('|').includes(hash)) set.delete(key);
    });
  });
}

// 그룹 멤버 전원의 모든 미순서쌍을 반환한다 — docs/collab-latency-architecture.md
// 적용 이후로는 "대표 vs 나머지"(별 모양)가 아니라 그룹 내 모든 쌍을 직접
// 비교해서 대표가 관여하지 않는 부분집합 겹침(예: 4명 중 2명끼리만 대화)도
// 잡는다.
function getGroupPairs(group) {
  const hashes = group.memberHashes;
  const pairs = [];
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      pairs.push([hashes[i], hashes[j]]);
    }
  }
  return pairs;
}

// 이 채널이 속한 그룹에서, 이 채널이 관여한 쌍만 골라낸다(디버그 패널/배지
// 요약용). 그룹이 없으면 빈 배열.
function getPairsForHash(hash) {
  const group = findCollabGroupForChannel(hash);
  if (!group) return [];
  return getGroupPairs(group).filter(([a, b]) => a === hash || b === hash);
}

function getPartnerInPair(hash, pair) {
  return pair[0] === hash ? pair[1] : pair[0];
}

// hash가 관여한 쌍 중 Stage1 유사도가 가장 높은 쌍을 고른다 — 설정 카드
// 배지·디버그 패널에 "이 채널이 지금 누구와 가장 강하게 겹치는지"를 한
// 줄로 요약해서 보여주기 위함이다. 값이 있는 쌍을 값이 없는(아직 측정
// 전) 쌍보다 우선하고, 그다음 유사도 내림차순. 관여한 쌍 자체가 없으면
// null.
function getStrongestPairForHash(hash) {
  const pairs = getPairsForHash(hash);
  let best = null;
  pairs.forEach((pair) => {
    const key = pairKey(pair[0], pair[1]);
    const similarity = collabPairSimilarity[key];
    if (best === null) {
      best = { partner: getPartnerInPair(hash, pair), key, similarity };
      return;
    }
    const bestHasValue = typeof best.similarity === 'number';
    const curHasValue = typeof similarity === 'number';
    if (curHasValue && (!bestHasValue || similarity > best.similarity)) {
      best = { partner: getPartnerInPair(hash, pair), key, similarity };
    }
  });
  return best;
}

// ── 합방 오디오 유사도 계산 ─────────────────────────────────────────────
// 원본 파형을 직접 비교할 방법이 없어(크로스오리진 iframe), 이미 흐르고
// 있는 채널별 dB 시계열(§pushChannelAudioLevelHistory)의 상관관계로
// "같은 소리가 섞여 들리는지"를 근사한다. 두 스트림의 인코딩/네트워크
// 지연이 서로 달라도 말하고/쉬는 타이밍(음량 변화 패턴)은 일정한 시간
// 지연을 두고 비슷하게 나타난다는 전제 — 완벽한 지문 인식은 아니지만
// 추가 크롬 권한 없이 구현 가능한 현실적 근사치다.
const COLLAB_LAG_RANGE_MS = 3000;
const COLLAB_LAG_STEP_MS = 500;
const COLLAB_MATCH_TOLERANCE_MS = 260;
// COLLAB_MIN_SAMPLES/COLLAB_MIN_PAIRS는 channelAudioLevelHistory의 "샘플
// 개수"를 기준으로 삼는데, 그 버퍼가 보고 간격이 촘촘해진 만큼(§3.6
// COLLAB_HISTORY_MAX_SAMPLES) 더 많은 샘플을 담게 됐다 — 원래 500ms 기준
// 값(각 6개·4개)을 그대로 두면 실제로는 훨씬 적은 시간(≈1.2초/0.8초)만
// 지나도 판정을 시작해버려서, 통계적으로 미덥지 않은 이른 판정(오탐 증가)
// 원인이 된다. 같은 비율로 늘려서 원래 의도한 시간(≈3초/2초)을 유지한다.
const COLLAB_MIN_SAMPLES = 15;
const COLLAB_MIN_PAIRS = 10;

// 합방 멤버(리더 아님)의 음량 판정은 레이아웃과 무관하게 항상 동일하다 —
// 합방 설정이 균등(dB 평준화)보다 우선이라, 비리더 멤버는 균등 로직에서
// 아예 제외되고 항상 음소거된다(getGroupHashes 후보 제외 +
// getDisplayVolumeForChannel에서 덮어씀). 아래 두 임계값은 최종 음량과
// 무관하고 UI의 "겹침 %"/음소거 배지 표시용 collabMutedHashes 판정에만
// 쓰인다(예전엔 살짝만 낮췄는데 메아리처럼 들려서 완전 음소거로 바꿨다).
const COLLAB_OVERLAP_MUTE_THRESHOLD = 0.10;
const COLLAB_OVERLAP_UNMUTE_THRESHOLD = 0.10;

// pairKey → 그 쌍에 대해 가장 최근에 계산한 Stage1 유사도(-1~1, 데이터
// 부족 시 null) — 합방 설정 UI에 "겹침 %"로 표시한다. 전체 쌍 비교로
// 바뀌면서 "멤버 하나당 값 하나"가 아니라 "쌍 하나당 값 하나"가 됐다 —
// 멤버별 배지에는 그 멤버가 관여한 쌍 중 가장 강한 것을 골라서 보여준다
// (getStrongestPairForHash).
let collabPairSimilarity = {};

// pairKey → computeCollabSimilarity가 마지막으로 계산한 13개 lag별 원본
// 상관계수 배열(스무딩 전) — 디버그 모드(§isDebugModeEnabled)에서만 화면에
// 그려서 보여준다. 평소에는 그냥 들고만 있고 아무 데도 안 쓴다.
let collabDebugLagCorrByPair = {};

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX / n, meanY = sumY / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

// 두 채널의 실측 레이턴시 차이(channelLatencySecByHash)로 Stage1 상관 탐색의
// 중심 lag(ms)를 추정한다. 데이터 없으면 0(예전처럼 lag=0 중심 탐색).
//
// **부호**: t는 "이 dB 표본을 받은 로컬 시각". 발화 시각 T에 대해 A는
// T+latencyA에, B는 T+latencyB에 보고하므로(레이턴시 큰 쪽이 더 늦게
// 보고), targetT = sampleA.t + lag로 sampleB를 찾을 때 같은 사건을
// 맞히려면 lag ≈ latencyB - latencyA.
function getEstimatedLagMsForPair(hashA, hashB) {
  const latA = channelLatencySecByHash[hashA];
  const latB = channelLatencySecByHash[hashB];
  if (typeof latA !== 'number' || typeof latB !== 'number' || !isFinite(latA) || !isFinite(latB)) return 0;
  return (latB - latA) * 1000;
}

// 두 채널의 dB 이력을 lag(레이턴시 차이 추정치 중심 ±3초, 500ms 단위)만큼
// 밀어가며 정렬한 뒤 각 lag에서 상관계수를 구한다. 표본 부족하면 null.
//
// §8.5: 13개 lag 중 최댓값 하나만 쓰면 다중비교 문제가 생긴다 — 표본이
// 적은 피어슨 상관은 무관한 채널끼리도 우연히 어느 한 lag에서 튈 수 있는데,
// 최댓값만 고르면 그 우연한 튐이 "겹침 높음"으로 오탐되기 쉽다. 진짜 지연
// 상관이면 최적 lag 이웃에서도 완만하게 높게 나온다는 점을 이용해, 각 lag를
// 이웃(±1칸)과 평균 낸 뒤 그 완만한 봉우리들 중 최댓값을 쓴다 — 고립된 튐은 걸러진다.
//
// 탐색 폭(±3초)은 그대로, 중심만 getEstimatedLagMsForPair로 옮긴다 —
// 레이턴시 차이가 커질수록 진짜 크로스토크 피크가 lag=0에서 멀어지는데
// 중심을 안 옮기면 잡음만 비교하게 돼 오탐이 늘어난다. 레이턴시는 1.5초
// 간격으로 계속 갱신되므로 중심도 매 사이클 새로 맞춰진다.
//
// 균등(dB 평준화) 로직처럼 MIN_VALID_REFERENCE_DB(-50) 미만은 무음으로
// 보고 비교에서 뺀다 — 안 그러면 둘 다 조용해지는 우연의 일치가 상관계수를
// 밀어올릴 수 있다.
function computeCollabSimilarity(hashA, hashB) {
  const histA = channelAudioLevelHistory[hashA];
  const histB = channelAudioLevelHistory[hashB];
  if (!histA || !histB || histA.length < COLLAB_MIN_SAMPLES || histB.length < COLLAB_MIN_SAMPLES) return null;

  const centerLagMs = getEstimatedLagMsForPair(hashA, hashB);
  const perLagCorr = [];
  for (let lag = centerLagMs - COLLAB_LAG_RANGE_MS; lag <= centerLagMs + COLLAB_LAG_RANGE_MS; lag += COLLAB_LAG_STEP_MS) {
    const xs = [];
    const ys = [];
    histA.forEach((sampleA) => {
      if (sampleA.db < MIN_VALID_REFERENCE_DB) return;
      const targetT = sampleA.t + lag;
      let closest = null;
      let closestDiff = Infinity;
      histB.forEach((sampleB) => {
        const diff = Math.abs(sampleB.t - targetT);
        if (diff < closestDiff) { closestDiff = diff; closest = sampleB; }
      });
      if (closest && closestDiff <= COLLAB_MATCH_TOLERANCE_MS && closest.db >= MIN_VALID_REFERENCE_DB) {
        xs.push(sampleA.db);
        ys.push(closest.db);
      }
    });
    perLagCorr.push(xs.length >= COLLAB_MIN_PAIRS ? pearsonCorrelation(xs, ys) : null);
  }
  collabDebugLagCorrByPair[pairKey(hashA, hashB)] = perLagCorr;

  let best = null;
  for (let i = 0; i < perLagCorr.length; i++) {
    const neighborhood = [perLagCorr[i - 1], perLagCorr[i], perLagCorr[i + 1]]
      .filter((v) => typeof v === 'number');
    if (neighborhood.length < 2) continue; // 이웃 lag와 함께 확인 안 되면 신뢰하지 않는다
    const smoothed = neighborhood.reduce((sum, v) => sum + v, 0) / neighborhood.length;
    if (best === null || smoothed > best) best = smoothed;
  }
  return best;
}

// 음소거를 걸거나 풀기 전에 "그 상태가 일정 시간 계속 유지됐는지"를
// 확인한다 — 한 번의 측정치만 보고 바로 전환하면, 대화 중 잠깐의 텀이나
// 순간적인 노이즈로 유사도가 튀었을 때 음소거가 깜빡일 수 있다. 임계값을
// 넘거나(음소거 후보) 밑돈(해제 후보) 시점을 기록해두고, 그 상태가
// 중간에 끊기지 않고 이 시간만큼 이어져야 실제로 전환한다.
const COLLAB_MUTE_SUSTAIN_MS = 800;
const COLLAB_UNMUTE_SUSTAIN_MS = 2500;

// pairKey → 그 쌍의 겹침 판정이 음소거 임계값을 처음 넘긴 시각(연속 유지
// 확인용). 아직 "활성 간선"(collabActiveEdges)이 아닌 쌍만 값을 가진다.
// 별 모양(대표 vs 나머지) 비교에서 전체 쌍 비교로 바뀌면서 히스테리시스도
// hash 단위가 아니라 쌍(edge) 단위로 유지한다 — 겹침 자체가 두 채널
// "사이"의 관계이기 때문.
let collabEdgeMuteCandidateSince = {};
// pairKey → 해제 임계값을 처음 밑돈 시각(연속 유지 확인용). 이미 활성
// 간선인 쌍만 값을 가진다.
let collabEdgeUnmuteCandidateSince = {};
// 지금 "겹침 확정"으로 판정된 쌍(pairKey) 집합 — 이 간선들로 그래프를 만들어
// 연결 요소(cluster)를 구한다(getGroupClusters). 서로 활성 간선으로 연결되지
// 않은 멤버는 정상 재생된다.
let collabActiveEdges = new Set();

// 2026-08-16 후속(사용자 실사용 지적: "채널 변경시 잠깐 기존 상태가
// 풀림", "음소거 -> 파형 분석으로 갑자기 바뀜") — 채널의 재생 내용이
// 실제로 바뀐 걸 우리가 이미 아는 순간(시크, 유튜브 엔딩화면에서 다른
// 영상 클릭 등)이 있다. 그 직후 몇 초는 Stage1(dB 이력)/Stage2(파형
// 캡처) 둘 다 아직 새 내용을 반영 못 한 과도기라, 이 시점의 판정을
// 그대로 믿으면 우연히 "다른 소리"로 보여 방금까지 맞던 음소거가
// 잠깐 풀렸다 다시 걸리는 플리커가 났다. hash → 이 시각까지는 이
// 채널이 낀 모든 쌍의 겹침 판정을 이번 사이클에 건너뛰고(마지막 상태
// 그대로 유지) — recomputeCollabMuting에서 씀.
let collabResetHoldUntilByHash = {};
// 4초 — Stage1 dB 이력이 COLLAB_MIN_SAMPLES만큼 다시 쌓이고 Stage2
// 캡처 버퍼가 최소한 한 번은 새로 찰 시간을 대략 여유 있게 잡은
// 추정치(실측 아님) — 너무 길면 진짜 전환도 그만큼 늦게 반영된다.
const COLLAB_RESET_HOLD_MS = 4000;
function markCollabResetHold(hash) {
  collabResetHoldUntilByHash[hash] = Date.now() + COLLAB_RESET_HOLD_MS;
}
function isCollabResetHoldActive(hash) {
  const until = collabResetHoldUntilByHash[hash];
  return typeof until === 'number' && Date.now() < until;
}

// ── 합방 겹침 감지 — Stage 2: 파형 GCC-PHAT ────────────────────────────
// Stage 1(computeCollabSimilarity, dB 엔벨로프 상관)은 "둘 다 지금
// 말하고 있는가"만 보고 "같은 소리인가"는 못 본다 — 타이밍만 맞으면
// 서로 다른 말도 걸린다. Stage 1이 후보로 걸러낸 쌍만 실제 파형(다운샘플
// 스니펫)을 받아 GCC-PHAT 교차상관으로 "한쪽 소리가 다른 쪽에 새어 들어온
// 건지"를 확인한다(모든 쌍에 항상 파형을 주고받으면 비용이 크므로 Stage 1을
// 저비용 예비 필터로 재사용). 그룹 내 모든 쌍에 대해 이 파이프라인이 돈다.

// 탐색 lag 범위는 Stage 1과 동일하게 맞춘다(±3초).
const COLLAB_WAVEFORM_MAX_LAG_SEC = COLLAB_LAG_RANGE_MS / 1000;

// VOD 합방 싱크 전용 — 메타데이터 오프셋 잔차가 라이브 레이턴시 차이보다
// 훨씬 클 수 있다는 게 실사용으로 확인됐다(사용자 지적: "2~3초 수준보다
// 더 차이가 나나본데? 음소거 판단을 못하네"). ±3초 창에 잔차가 없으면
// Stage1(dB 엔벨로프, 5초 이력)도 Stage2(GCC-PHAT, 3초 캡처)도 애초에
// 겹침 구간을 볼 수가 없어 확인이 영원히 안 된다 — 라이브용 값을 그대로
// 쓰면 안 되는 이유. vod-sync 쌍에 한해 캡처 창(§lufs-worklet-processor.js
// setCapture의 windowSec)과 GCC-PHAT 탐색 범위를 이 값으로 넓힌다.
// 15초 캡처 중 ±12초까지만 탐색하는 건 상관 계산이 버퍼 끝 쪽(겹치는
// 표본이 적어짐)에서 신뢰도가 떨어지기 때문 — 3초 여유를 남긴다.
const VOD_SYNC_CAPTURE_WINDOW_SEC = 15;
const VOD_SYNC_WAVEFORM_MAX_LAG_SEC = 12;
// vod-sync 쌍 전용 Stage2 유예 기간(§getWaveformVerdict) — 캡처 창
// 자체가 15초(VOD_SYNC_CAPTURE_WINDOW_SEC)라 라이브용 유예(8초,
// COLLAB_WAVEFORM_CONFIRM_GRACE_MS)보다 훨씬 길게 잡아야 한다 —
// 캡처가 리셋된(forceReset) 직후엔 그 15초가 다 찰 때까지 Stage2가
// 새 값을 못 내는데, 유예가 그보다 짧으면 리셋될 때마다 예외 없이
// "다시보기 정렬 시크할 때마다 몇 초간 음소거가 풀린다"가 재현된다.
// 15초 + 여유(Stage2 주기·스니펫 타임아웃) 2초.
const VOD_SYNC_WAVEFORM_CONFIRM_GRACE_MS = 17000;
// 파형 유사도 임계값. gcc-phat.js의 score는 대략 -1~1 정규화 상관계수다.
// 공유 배경 잡음을 흉내낸 합성 신호로 검증 시 진짜 크로스토크는 평균 ~0.17,
// 크로스토크 없을 때는 평균 ~0.03으로 나와 0.10을 중간값으로 잡았다 —
// 실제 방송 데이터 검증은 아니라 실측 후 재조정 필요.
const COLLAB_WAVEFORM_MATCH_THRESHOLD = 0.10;
// Stage 2 재계산 주기. 3초 스니펫 + FFT라 Stage 1(수백 ms)만큼 자주 돌릴
// 필요는 없다 — 후보 쌍에서만, 이 주기로만 갱신한다.
const COLLAB_WAVEFORM_REFRESH_MS = 1200;
const COLLAB_WAVEFORM_SNIPPET_TIMEOUT_MS = 800;
// 이보다 오래된 Stage 2 점수는 "신선하지 않음"으로 본다. Stage 2가 아직
// 준비 안 됐을 때(캡처 워밍업 중) Stage 1 단독으로 폴백하면 "다른 말인데
// 음소거"가 재현되므로(§getCombinedOverlapValue에서 이 폴백을 걷어냄),
// 이 상수는 "얼마나 오래된 Stage 2 값까지 믿을지"에만 쓰인다.
const COLLAB_WAVEFORM_MAX_AGE_MS = COLLAB_WAVEFORM_REFRESH_MS * 3;
// 말소리가 없다가 다시 생기면, Stage 2가 3초 캡처 버퍼를 다시 채우는 동안
// "아직 확인 전"이라 getCombinedOverlapValueForPair가 -1을 반환한다 — 직전에
// 같은 소리로 확인된 쌍도 이 워밍업 동안은 UNMUTE 후보가 돼, 2.5초 뒤
// 음소거가 풀렸다 재확인되면 재음소거되는 깜빡임이 생긴다. 이를 막기 위해
// "최근에 확인됐던" 쌍은 Stage 2가 재확인할 때까지 이 유예 시간만큼 직전
// 상태(겹침)를 유지한다 — 워밍업 최대 시간(3초+1.2초+0.8초)보다 넉넉히 크게 잡는다.
const COLLAB_WAVEFORM_CONFIRM_GRACE_MS = 8000;

// 현재 캡처(파형 링 버퍼 유지)를 켜둔 채널 집합 — Stage 1 후보 쌍
// 어느 한쪽에라도 속한 채널이면 포함된다(§refreshCollabCaptureState).
const collabCaptureHashes = new Set();
// pairKey → { score, lagSec, at, computeMs } — 그 쌍의 가장 최근 Stage 2
// 판정(둘 다 filled:true일 때만 기록됨).
let collabWaveformScoreByPair = {};
// pairKey → Stage 2가 마지막으로 "같은 소리"(score >= COLLAB_WAVEFORM_MATCH_THRESHOLD)로
// 확인해준 시각. Stage 2가 명시적으로 "다른 소리"라고 판정하면 즉시 지워진다
// — 유예(COLLAB_WAVEFORM_CONFIRM_GRACE_MS)는 "아직 재확인 전" 상태에서만
// 적용되고, "확인해봤더니 다른 소리"인 경우는 적용하지 않는다.
let collabPairLastConfirmedAt = {};
// 이미 왕복 중인 pairKey — 이전 요청이 안 끝났는데 또 요청하지 않도록.
const collabWaveformRefreshInFlight = new Set();
// content.js가 unavailable:true로 명시적으로 답한 채널(레거시 RMS 폴백 등,
// Stage 2를 영구적으로 못 씀) — 이 집합에 들어간 채널만 getCombinedOverlapValue가
// Stage 1 단독으로 폴백한다. "아직 준비 안 됨"과는 구분해야 한다(§18 참고).
const collabWaveformUnavailableHashes = new Set();

let collabSnippetRequestSeq = 0;
const pendingSnippetRequests = {};

function setChannelCapture(hash, enabled, windowSec, forceReset) {
  const wrapper = videoWrapperMap.get(hash);
  const iframe = wrapper && wrapper.querySelector('iframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'SET_CHANNEL_CAPTURE', enabled, windowSec, forceReset }, '*');
  }
}

// content.js(워클릿)에 현재 파형 스니펫을 요청하고 Promise로 기다린다.
// 워클릿이 없는 채널(레거시 폴백/오디오 최적화 꺼짐 등)은 content.js가
// samples:null로 즉시 답해주므로, 타임아웃은 "iframe이 아예 응답 안 하는"
// 예외적인 경우에만 걸린다.
function requestAudioSnippet(hash, timeoutMs) {
  return new Promise((resolve) => {
    const wrapper = videoWrapperMap.get(hash);
    const iframe = wrapper && wrapper.querySelector('iframe');
    if (!iframe || !iframe.contentWindow) { resolve(null); return; }
    const requestId = `snip-${++collabSnippetRequestSeq}`;
    const timer = setTimeout(() => {
      delete pendingSnippetRequests[requestId];
      resolve(null);
    }, timeoutMs);
    pendingSnippetRequests[requestId] = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
    iframe.contentWindow.postMessage({ type: 'REQUEST_AUDIO_SNIPPET', requestId }, '*');
  });
}

window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHANNEL_AUDIO_SNIPPET') return;
  const { requestId, samples, sampleRate, filled, unavailable } = event.data;
  const resolver = pendingSnippetRequests[requestId];
  if (!resolver) return;
  delete pendingSnippetRequests[requestId];
  // samples가 없는 두 경우를 구분해서 넘긴다: unavailable(이 채널은 Stage 2를
  // 영구적으로 못 씀, §getCombinedOverlapValue) vs 그냥 이번엔 못 받음(재시도
  // 대상, 왕복 타임아웃 등) — requestAudioSnippet의 타임아웃 케이스는 이
  // 리스너를 거치지 않고 그냥 null이라 여기서는 후자만 해당.
  resolver(samples ? { samples, sampleRate, filled } : { samples: null, unavailable: !!unavailable });
});

// VOD 합방 싱크 동기화 — 메타데이터 기반 오프셋 계산
// (docs/vod-collab-sync-architecture.md §8, 2026-08-16 갱신 참고).
// 이전엔 여기서 HLS 재생목록을 관찰해 오디오를 직접 받아 디코딩하고
// (WebCodecs) VAD/음량 상관관계로 오프셋을 추정하는 파이프라인
// (requestVodManifestUrls~alignChzzkVodOffset, 약 1300줄)이 있었다.
// 오픈소스 확장 VOD Master(github.com/AINukeHere/VOD-Master)를 사용자가
// 실사용 비교해본 결과 그쪽이 정확도·속도 모두 압도적이었고, 그 방식은
// 오디오 처리를 전혀 안 하고 치지직 VOD 상세 API의 liveOpenDate(방송
// 시작 시각, 초 단위)만으로 오프셋을 계산한다는 게 드러나 그 알고리즘을
// 그대로 이식했다(원본: src/module/chzzk_api.js의 calculateVodStartTime).
// 오디오 파이프라인은 통째로 삭제 — gcc-phat.js/vad-worker.js 등 라이브
// 합방(Stage 2)과 공유하던 인프라는 그대로 남아있다(아래 §GCC-PHAT
// 워커 풀부터).

// 긴 라이브 방송(치지직 VOD 최대 길이인 17시간=61200초에 근접)은 VOD가
// 여러 개로 쪼개져 게시된다 — 뒤쪽 조각의 liveOpenDate는 "그 조각이
// 처리되기 시작한 시각"이라 실제 방송 시작 시각이 아니다. livePv(같은
// 라이브 세션인지 식별하는 값)로 앞/뒤 VOD가 이 VOD와 한 방송인지
// 확인하고, 그 인접 VOD의 duration이 17시간에 근접하면 그만큼을
// liveOpenDate에 더해 보정한다.
function calculateChzzkVodStartTime(vodDetail) {
  if (!vodDetail || !vodDetail.liveOpenDate) return null;
  const liveOpenDate = new Date(String(vodDetail.liveOpenDate).replace(' ', 'T'));
  if (isNaN(liveOpenDate.getTime())) return null;

  const curLivePv = vodDetail.livePv;
  const prevLivePv = vodDetail.prevVideo?.livePv;
  const nextLivePv = vodDetail.nextVideo?.livePv;
  const prevDuration = vodDetail.prevVideo?.duration;
  const nextDuration = vodDetail.nextVideo?.duration;
  const CHZZK_VOD_MAX_DURATION_SEC = 61200; // 17시간
  const prevIsNearMaxDuration = typeof prevDuration === 'number' && Math.abs(prevDuration - CHZZK_VOD_MAX_DURATION_SEC) <= 1;
  const nextIsNearMaxDuration = typeof nextDuration === 'number' && Math.abs(nextDuration - CHZZK_VOD_MAX_DURATION_SEC) <= 1;
  const isPrevLivePvSame = !!prevLivePv && curLivePv === prevLivePv;
  const isNextLivePvSame = !!nextLivePv && curLivePv === nextLivePv;

  if (isPrevLivePvSame && isNextLivePvSame) {
    // 세 조각의 livePv가 모두 같다 — 이 VOD가 중간 조각일 수 있어, 앞뒤
    // 어느 쪽이든 17시간에 근접하면 그 조각만큼 더한다(둘 다일 수도 있음 —
    // curDuration이 17시간이어도 순서를 이것만으론 알 수 없기 때문).
    let startDate = liveOpenDate;
    if (prevIsNearMaxDuration) startDate = new Date(startDate.getTime() + prevDuration * 1000);
    if (nextIsNearMaxDuration) startDate = new Date(startDate.getTime() + nextDuration * 1000);
    return startDate;
  }
  if (isPrevLivePvSame) {
    return prevIsNearMaxDuration ? new Date(liveOpenDate.getTime() + prevDuration * 1000) : liveOpenDate;
  }
  if (isNextLivePvSame) {
    return nextIsNearMaxDuration ? new Date(liveOpenDate.getTime() + nextDuration * 1000) : liveOpenDate;
  }
  return liveOpenDate;
}

// 채널(hash)의 "실제 방송 시작 시각"(ms epoch) 캐시 — audioState.
// vodStartTimeMsByHash(§40줄)에 저장한다. 대표가 바뀌어도 그대로 유효한
// 절대 기준점이다(사용자 요청: "양방향, 초기에 한번만 계산, 나머지는
// 캐싱된거를 이용"). 두 채널 사이의 갭(오프셋)은 언제든
// audioState.vodStartTimeMsByHash[A] - [...][B]로 즉시 구할 수 있어, 어느
// 쪽이 대표가 되든 재계산이 필요 없다(§getVodSyncOffsetSec). audioState에
// 있으므로 saveAudioState()로 저장소에 영속화된다 — 새로고침해도, Stage2가
// 손봐준 보정치(§maybeRefineVodSyncOffsetFromLag)까지 그대로 남는다.

// hash 하나의 실제 방송 시작 시각을 캐시에서 찾고, 없으면 API로 계산해
// 채운 뒤 돌려준다. PlatformAdapters[ch.platform].getVodStartTime로
// 플랫폼별 앵커 조회를 디스패치한다(§docs/vod-collab-sync-architecture.md
// §10.2) — 치지직/유튜브는 구현돼 있고, 숲처럼 아직 없는 플랫폼이거나
// 앵커를 못 구한 경우(liveOpenDate/liveBroadcastDetails 없음 등)는 null.
// 캐시를 새로 채운 경우에만 호출부가 saveAudioState()로 영속화해야 한다.
async function ensureVodStartTimeCached(hash) {
  if (typeof audioState.vodStartTimeMsByHash[hash] === 'number') return audioState.vodStartTimeMsByHash[hash];
  const ch = displayChannels.find((c) => c.hash === hash);
  if (!ch || !ch.isVod) return null;
  const adapter = PlatformAdapters[ch.platform];
  if (!adapter || typeof adapter.getVodStartTime !== 'function') return null;
  const startMs = await adapter.getVodStartTime(ch);
  if (startMs === null || typeof startMs !== 'number' || isNaN(startMs)) return null;
  audioState.vodStartTimeMsByHash[hash] = startMs;
  return audioState.vodStartTimeMsByHash[hash];
}

// 대표/멤버 두 VOD(같은 플랫폼이든 서로 다른 플랫폼이든)의 방송 시작
// 시각 차이로 오프셋(초)을 계산한다(ensureVodStartTimeCached를 통해
// 각자 최초 1회만 API를 부른다 — §10.3, 크로스플랫폼 조합도 이 함수
// 자체는 변경 없이 그대로 지원). 부호는 실제 시크에 쓰이는 식
// (CHANNEL_PLAYBACK_TIME 핸들러의 expectedSec = repTime + offsetSec,
// §약 4004줄)에서 역산했다 — "멤버가 몇 초 늦게 시작하는지"라는 오프셋
// 입력칸의 안내 문구만 보고 부호를 다시 유추하면 반대로 짚기 쉬우니,
// 바꿀 일이 있으면 반드시 그 시크 계산식을 기준으로 검증할 것.
async function computeVodMetadataOffsetSec(representativeHash, memberHash) {
  const [repStartMs, memberStartMs] = await Promise.all([
    ensureVodStartTimeCached(representativeHash),
    ensureVodStartTimeCached(memberHash)
  ]);
  if (repStartMs === null) return { ok: false, error: '대표 VOD의 방송 시작 시각을 가져오지 못함(liveOpenDate/liveBroadcastDetails 없음, 지원하지 않는 플랫폼 등)' };
  if (memberStartMs === null) return { ok: false, error: '멤버 VOD의 방송 시작 시각을 가져오지 못함(liveOpenDate/liveBroadcastDetails 없음, 지원하지 않는 플랫폼 등)' };

  const offsetSec = (repStartMs - memberStartMs) / 1000;
  return { ok: true, offsetSec };
}

// computeGccPhat은 3초 스니펫에 FFT를 세 번 돌리는 실제 신호처리라, 후보
// 쌍이 늘어날수록 메인 스레드에서 수십 ms씩 잡아먹어 그 타이밍에 클릭하면
// UI가 순간 먹통처럼 느껴지는 원인이었다. 전용 워커로 옮겨 메인 스레드를 안 막는다.
//
// 워커 1개만 두면 메시지가 직렬 처리돼 뒤에 큐잉된 쌍은 앞선 계산이 끝날
// 때까지 기다려야 한다 — computeMs가 순수 연산 시간이 아니라 이 대기 시간까지
// 포함해 특정 채널만 유난히 오래 걸리는 것처럼 보였다. 작은 워커 풀을 두고
// 가장 한가한 워커에 맡겨 병렬 처리한다.
const GCC_PHAT_WORKER_POOL_SIZE = 2;
let gccPhatWorkers = [];
let gccPhatWorkerBusyCount = [];
let gccPhatWorkerRequestSeq = 0;
const gccPhatWorkerPending = {};

function createGccPhatWorker(idx) {
  let worker;
  try {
    worker = new Worker(chrome.runtime.getURL('src/js/audio/gcc-phat-worker.js'));
  } catch (err) {
    return null;
  }
  worker.onmessage = (event) => {
    const { requestId, result } = event.data || {};
    const pending = gccPhatWorkerPending[requestId];
    if (pending) {
      delete gccPhatWorkerPending[requestId];
      pending.resolve(result);
    }
    gccPhatWorkerBusyCount[idx] = Math.max(0, gccPhatWorkerBusyCount[idx] - 1);
  };
  // [CHEESE EYES] 이 워커가 죽었을 때 워커 슬롯만 비우고 그 워커에 요청
  // 중이던 Promise를 그대로 두면, 그 Promise를 기다리는
  // refreshWaveformScoreForPair가 영원히 안 끝나고 → collabWaveformRefreshInFlight
  // 에서 해당 채널이 영원히 안 지워져서 → ③ 2차 신호(파형)가 페이지를
  // 새로고침하기 전까지 영구히 "확인 중"에 멈추는 실사용 버그였다(§8.6).
  // 이 워커에 걸려 있던 요청들을 전부 null로 즉시 풀어줘서 호출 쪽이
  // "이번엔 실패"로 인식하고 다음 주기에 다시 시도할 수 있게 한다.
  worker.onerror = () => {
    gccPhatWorkers[idx] = null; // 이 워커만 폐기 — 나머지 풀은 계속 쓴다.
    Object.keys(gccPhatWorkerPending).forEach((requestId) => {
      const pending = gccPhatWorkerPending[requestId];
      if (pending.idx !== idx) return;
      delete gccPhatWorkerPending[requestId];
      pending.resolve(null);
    });
    gccPhatWorkerBusyCount[idx] = 0;
  };
  return worker;
}

if (typeof Worker !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
  for (let i = 0; i < GCC_PHAT_WORKER_POOL_SIZE; i++) {
    gccPhatWorkers.push(createGccPhatWorker(i));
    gccPhatWorkerBusyCount.push(0);
  }
}

// 살아있는 워커 중 대기 중인 요청이 가장 적은 워커의 인덱스. 전부 죽었으면
// (또는 애초에 하나도 못 만들었으면) -1 — 호출 쪽이 메인 스레드 폴백으로
// 넘어간다.
function pickLeastBusyGccPhatWorkerIndex() {
  let bestIdx = -1;
  let bestCount = Infinity;
  for (let i = 0; i < gccPhatWorkers.length; i++) {
    if (!gccPhatWorkers[i]) continue;
    if (gccPhatWorkerBusyCount[i] < bestCount) {
      bestCount = gccPhatWorkerBusyCount[i];
      bestIdx = i;
    }
  }
  return bestIdx;
}

// 워커가 응답도 없고 error 이벤트도 안 터뜨리는(조용히 멈추는) 극단적인
// 경우까지 대비한 안전장치 — 이 시간 안에 못 받으면 포기하고 null로
// 풀어준다. onerror 핸들러(§8.6.1)로 대부분 커버되지만, 이건 마지막 방어선.
const GCC_PHAT_WORKER_TIMEOUT_MS = 5000;

// timeoutMs(옵션): 기본은 라이브 합방 Stage2(3초 스니펫, 수십 ms면 끝남)
// 기준으로 잡은 GCC_PHAT_WORKER_TIMEOUT_MS. VOD 정렬 파인 단계처럼 훨씬
// 큰 버퍼(수백만 샘플)를 돌릴 땐 그보다 오래 걸릴 수 있어 호출부가 더
// 넉넉한 값을 넘길 수 있게 했다 — 전역 기본값 자체를 늘리면 라이브
// 합방 쪽 "워커가 죽었을 때 빨리 포기하고 다음 주기에 재시도" 반응성이
// 불필요하게 느려지므로, 호출부별로 다르게 주는 쪽을 택했다.
function computeGccPhatAsync(bufA, rateA, bufB, rateB, maxLagSec, centerLagSec, timeoutMs) {
  const effectiveTimeoutMs = timeoutMs || GCC_PHAT_WORKER_TIMEOUT_MS;
  const idx = pickLeastBusyGccPhatWorkerIndex();
  if (idx === -1) {
    if (typeof computeGccPhat !== 'function') return Promise.resolve(null);
    return Promise.resolve(computeGccPhat(bufA, rateA, bufB, rateB, maxLagSec, undefined, centerLagSec));
  }
  return new Promise((resolve) => {
    const requestId = ++gccPhatWorkerRequestSeq;
    const timer = setTimeout(() => {
      if (!gccPhatWorkerPending[requestId]) return;
      delete gccPhatWorkerPending[requestId];
      resolve(null);
    }, effectiveTimeoutMs);
    gccPhatWorkerPending[requestId] = {
      idx,
      resolve: (result) => { clearTimeout(timer); resolve(result); }
    };
    gccPhatWorkerBusyCount[idx]++;
    gccPhatWorkers[idx].postMessage({ requestId, bufA, rateA, bufB, rateB, maxLagSec, centerLagSec });
  });
}

// ── 합방 겹침 감지 — Stage 2 보조: Silero VAD 음성 활동 검출 ───────────────
// docs/collab-architecture.md §10. §9(밴드패스)만으로는 게임 대사·효과음
// 처럼 같은 300~3400Hz 대역에 걸친 소리를 걸러내지 못한다 — 리더가 실제로
// 말하는 구간만 골라 Stage 2 상관을 계산하면, 서로 다른 배경음악이 만드는
// 무관한 상관을 줄이면서 진짜 크로스토크는 더 잘 잡는다.
//
// 모델(약 2.3MB) + onnxruntime-web WASM 런타임(약 13.5MB)을 전용 워커에서
// 비동기로 불러온다 — "합방 설정 사용"만으로는 자동으로 켜지지 않고,
// 사용자가 별도로 "AI 음성 감지 사용"을 켰을 때만 로딩을 시작한다(용량이
// 커서 원치 않는 사용자에게 강제로 받게 하지 않기 위해). 로딩은 절대
// 다른 동작을 막지 않는다 — 켜는 즉시 UI는 그대로 반응하고, 로딩 중에는
// 마스킹 없이(예전 동작 그대로) 계속 진행하다가, 로딩이 끝나는 순간부터
// 자동으로 마스킹이 적용된다(활성화 요청 자체를 잃어버리지 않고 준비되는
// 대로 이어서 처리한다는 점에서 content.js의 captureEnabledPending과 같은
// 패턴).
let vadState = 'idle'; // 'idle' | 'loading' | 'ready' | 'unavailable'
let vadWorker = null;
let vadInitPromise = null;
let vadRequestSeq = 0;
const vadPending = {};
const VAD_SPEECH_THRESHOLD = 0.5;
// 이 구간(원본 샘플 기준) 미만으로만 "말하는 중"이면 이번 주기는 판정을
// 건너뛴다 — 리더가 3초 내내 조용했던 창을 그대로 상관계산하면(전부
// 마스킹돼 0에 가까운 신호) 의미 없는 값만 나온다. §3.2 폴백 정책대로
// "아직 확인 전"으로 남겨두고 다음 주기에 다시 시도한다.
const VAD_MIN_ACTIVE_RATIO = 0.15;
// hash → 그 채널에 대해 마지막으로 계산한 VAD 결과(프레임별 발화 확률 +
// 자기 자신 기준 활성 비율) — 디버그 패널의 "말소리 감지" 그래프 전용
// 캐시다. 전체 쌍 비교로 바뀌면서 특정 "리더" 한 명이 아니라 VAD 추론이
// 돌아간 모든 채널에 대해 채워진다. 실제 마스킹 로직(getVadMaskedSnippets)
// 과는 별개로, 표시만을 위해 들고 있는다.
let collabVadDebugByHash = {};

function updateVadStatusUI() {
  const statusEl = document.getElementById('collab-vad-status');
  if (!statusEl) return;
  if (vadState === 'loading') {
    statusEl.textContent = t('settings.collabVadStatusLoading', 'AI 음성 감지 모델을 불러오는 중입니다... (최초 1회, 최대 몇십 초)');
    statusEl.className = 'yt-settings-hint collab-vad-status loading';
  } else if (vadState === 'ready') {
    statusEl.textContent = t('settings.collabVadStatusReady', 'AI 음성 감지 사용 중');
    statusEl.className = 'yt-settings-hint collab-vad-status ready';
  } else if (vadState === 'unavailable') {
    statusEl.textContent = t('settings.collabVadStatusUnavailable', 'AI 음성 감지를 사용할 수 없어 이전 방식으로 대체합니다.');
    statusEl.className = 'yt-settings-hint collab-vad-status unavailable';
  } else {
    statusEl.textContent = '';
    statusEl.className = 'yt-settings-hint collab-vad-status';
  }
}

// 여러 곳(토글 change, 최초 로딩)에서 여러 번 불러도 안전하다 — 이미
// 로딩 중이거나 끝났으면 그 상태를 그대로 재사용한다.
function ensureVadWorker() {
  if (vadWorker) return vadInitPromise;
  if (typeof Worker === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
    vadState = 'unavailable';
    updateVadStatusUI();
    return Promise.resolve(false);
  }
  vadState = 'loading';
  updateVadStatusUI();
  try {
    vadWorker = new Worker(chrome.runtime.getURL('src/js/audio/ort/vad-worker.js'));
  } catch (err) {
    vadState = 'unavailable';
    updateVadStatusUI();
    return Promise.resolve(false);
  }
  const modelUrl = chrome.runtime.getURL('src/js/audio/silero_vad.onnx');
  const wasmBaseUrl = chrome.runtime.getURL('src/js/audio/ort/');
  vadInitPromise = new Promise((resolve) => {
    vadWorker.addEventListener('error', () => {
      vadState = 'unavailable';
      updateVadStatusUI();
      resolve(false);
    }, { once: true });
    vadWorker.addEventListener('message', function onInit(event) {
      const data = event.data || {};
      if (data.type !== 'init-result') return;
      vadWorker.removeEventListener('message', onInit);
      vadState = data.ok ? 'ready' : 'unavailable';
      updateVadStatusUI();
      resolve(!!data.ok);
    });
    vadWorker.postMessage({ cmd: 'init', modelUrl, wasmBaseUrl });
  });
  // init 응답과는 별개로, 계속 살아있는 리스너 — infer-result는 여러 번
  // 오가므로 { once: true }를 쓰지 않는다.
  vadWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type !== 'infer-result') return;
    const resolve = vadPending[data.requestId];
    if (!resolve) return;
    delete vadPending[data.requestId];
    resolve(data.error ? null : data);
  });
  return vadInitPromise;
}

function requestVadInference(samples, sampleRate) {
  if (!vadWorker || vadState !== 'ready') return Promise.resolve(null);
  return new Promise((resolve) => {
    const requestId = ++vadRequestSeq;
    vadPending[requestId] = resolve;
    vadWorker.postMessage({ cmd: 'infer', requestId, samples, sampleRate });
  });
}

// vadResult(리더 스니펫 기준 프레임별 발화 확률)를 targetRate/targetLength
// (마스킹하려는 버퍼 자신의 샘플레이트·길이)로 확장해 0/1 마스크를 만든다.
// 리더와 멤버 스니펫은 서로 다른 iframe의 AudioContext.sampleRate를 각자
// 다운샘플한 거라 실제 캡처 레이트가 다를 수 있어(§gcc-phat.js
// resampleLinear 주석 참고), 인덱스가 아니라 "시간"으로 프레임을 찾는다.
function buildVadMask(vadResult, targetRate, targetLength) {
  const mask = new Float32Array(targetLength);
  const frameDurationSec = vadResult.frameSamplesAtOutputRate / vadResult.outputSampleRate;
  const lastFrameIdx = vadResult.probs.length - 1;
  for (let i = 0; i < targetLength; i++) {
    const tSec = i / targetRate;
    let frameIdx = Math.floor(tSec / frameDurationSec);
    if (frameIdx < 0) frameIdx = 0;
    if (frameIdx > lastFrameIdx) frameIdx = lastFrameIdx;
    mask[i] = vadResult.probs[frameIdx] >= VAD_SPEECH_THRESHOLD ? 1 : 0;
  }
  return mask;
}

function applyMask(samples, mask) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * mask[i];
  return out;
}

function maskActiveRatio(mask) {
  let active = 0;
  for (let i = 0; i < mask.length; i++) active += mask[i];
  return mask.length > 0 ? active / mask.length : 0;
}

// 같은 Stage2 리프레시 틱(1.2초마다 도는 refreshAllWaveformScores 한 번의
// 호출) 안에서 허브 멤버(여러 쌍에 동시에 속한 채널)의 스니펫 요청/VAD
// 추론이 쌍 개수만큼 중복되지 않도록, 이번 틱에서 이미 가져온 결과를
// hash별로 재사용한다. 틱이 끝나면(다음 refreshAllWaveformScores 호출 시)
// 캐시를 비워 항상 최신 스니펫을 쓴다 — 별 모양(대표 1명과만 비교) 구조
// 였을 때는 한 채널이 최대 한 쌍에만 속했으니 필요 없던 최적화다.
let collabSnippetCycleCache = {};
let collabVadResultCycleCache = {};

function getOrRequestSnippetForCycle(hash) {
  if (!collabSnippetCycleCache[hash]) {
    collabSnippetCycleCache[hash] = requestAudioSnippet(hash, COLLAB_WAVEFORM_SNIPPET_TIMEOUT_MS);
  }
  return collabSnippetCycleCache[hash];
}

function getOrComputeVadResultForCycle(hash, snip) {
  if (!collabVadResultCycleCache[hash]) {
    collabVadResultCycleCache[hash] = requestVadInference(snip.samples, snip.sampleRate);
  }
  return collabVadResultCycleCache[hash];
}

// 특정 시간 격자(targetRate/targetLength) 위에서 vadResultA·vadResultB
// 둘 중 하나라도 "말하는 중"이면 1인 합집합 마스크를 만든다. 쌍(i, j)에는
// 어느 한쪽만 신뢰할 "진짜 화자" 특권이 없으므로(§핵심 결정 4) — 크로스토크는
// 어느 방향으로든 새어 들어갈 수 있다 — 둘 중 아무나 말하는 구간을 전부
// 살려서 비교한다.
function buildUnionVadMask(vadResultA, vadResultB, targetRate, targetLength) {
  const maskA = buildVadMask(vadResultA, targetRate, targetLength);
  const maskB = buildVadMask(vadResultB, targetRate, targetLength);
  const out = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i++) out[i] = (maskA[i] || maskB[i]) ? 1 : 0;
  return out;
}

// 쌍(hashA, hashB) 양쪽 스니펫에 각자 VAD를 돌려 "둘 중 하나라도 말하는
// 구간"만 남긴(나머지는 0으로 지운) 버퍼 쌍을 돌려준다. 어느 한쪽이라도
// VAD 추론에 실패하면(로딩 중/실패) 마스킹 자체를 포기하고 null을
// 돌려줘서 호출 쪽이 예전처럼 원본 버퍼로 비교하게 한다. 합집합 마스크의
// 활성 비율이 VAD_MIN_ACTIVE_RATIO 미만이면(둘 다 이 3초 창에서 거의
// 안 말함) 'insufficient'를 돌려줘 이번 주기를 건너뛴다.
async function getVadMaskedSnippets(hashA, snipA, hashB, snipB) {
  const [vadResultA, vadResultB] = await Promise.all([
    getOrComputeVadResultForCycle(hashA, snipA),
    getOrComputeVadResultForCycle(hashB, snipB)
  ]);
  if (!vadResultA || !vadResultB) return null;

  // 디버그 패널의 "말소리 감지" 그래프 전용 — 이제 특정 "리더" 카드에만
  // 뜨는 게 아니라 VAD가 실행된 모든 채널 각자의 카드에, 자기 자신의
  // 발화 확률(자기 마스크 기준 활성 비율)을 보여준다.
  const ownMaskA = buildVadMask(vadResultA, snipA.sampleRate, snipA.samples.length);
  const ownMaskB = buildVadMask(vadResultB, snipB.sampleRate, snipB.samples.length);
  collabVadDebugByHash[hashA] = {
    probs: vadResultA.probs,
    frameSamplesAtOutputRate: vadResultA.frameSamplesAtOutputRate,
    outputSampleRate: vadResultA.outputSampleRate,
    activeRatio: maskActiveRatio(ownMaskA),
    at: Date.now(),
  };
  collabVadDebugByHash[hashB] = {
    probs: vadResultB.probs,
    frameSamplesAtOutputRate: vadResultB.frameSamplesAtOutputRate,
    outputSampleRate: vadResultB.outputSampleRate,
    activeRatio: maskActiveRatio(ownMaskB),
    at: Date.now(),
  };

  const maskForA = buildUnionVadMask(vadResultA, vadResultB, snipA.sampleRate, snipA.samples.length);
  const maskForB = buildUnionVadMask(vadResultA, vadResultB, snipB.sampleRate, snipB.samples.length);
  const activeRatio = Math.max(maskActiveRatio(maskForA), maskActiveRatio(maskForB));
  if (activeRatio < VAD_MIN_ACTIVE_RATIO) return 'insufficient';
  return {
    samplesA: applyMask(snipA.samples, maskForA),
    samplesB: applyMask(snipB.samples, maskForB),
  };
}

// gcc-phat.js computeGccPhat의 centerLagSec으로 넘길 값 — Stage1의
// getEstimatedLagMsForPair와 같은 레이턴시 데이터를 쓰지만 **부호가 반대다**.
// gcc-phat.js의 lagSec는 "A[m] ≈ B[m-lag]" 관계로 정의되는데, 실측 검증
// 결과 "A가 B보다 latencyA-latencyB만큼 더 지연"이면 peak lag가
// (latencyA-latencyB)로 나온다 — Stage1의 정의(lag=latencyB-latencyA)와
// 유도 과정이 달라 부호가 뒤집힌다. 두 함수를 절대 하나로 합치지 말 것.
function getEstimatedGccCenterLagSec(hashA, hashB) {
  const latA = channelLatencySecByHash[hashA];
  const latB = channelLatencySecByHash[hashB];
  if (typeof latA !== 'number' || typeof latB !== 'number' || !isFinite(latA) || !isFinite(latB)) return 0;
  return latA - latB;
}

// VOD 합방 싱크 동기화 — 메타데이터 오프셋(liveOpenDate 기반, 실사용
// 오차 ±2~3초)의 잔차를 라이브 합방 Stage 2(이 아래 refreshWaveformScoreForPair)가
// 매 사이클 재사용해서 깎아낸다(사용자 요청 — "이거는 기존 라이브 방식으로
// 맞추는게 좋겠어"). 오디오 상관관계 파이프라인을 따로 다시 만들지 않고,
// 이미 모든 합방 쌍에 대해 항상 도는 Stage 2 계산 결과에 얹혀가는 방식 —
// vod-sync 쌍도 getGroupPairs(group)에 포함되므로 이 함수는 이미
// vod-sync 쌍에 대해서도 호출되고 있었다(예전엔 recomputeCollabMuting이
// 그 결과를 무시하고 무조건 음소거했을 뿐).
//
// 부호 유도: gcc-phat.js의 lagSec는 "A[m] ≈ B[m-lag]"로 정의된다. rep의
// 현재 재생 위치를 repTime, 멤버가 실제로 강제되고 있는 위치를 repTime+
// offsetSec_current라 하면(§CHANNEL_PLAYBACK_TIME 핸들러), 참오프셋과의
// 오차 residualErrorSec = offsetSec_true - offsetSec_current에 대해
// bufA(rep)의 dt 시점 콘텐츠는 bufB(멤버)의 (dt+residualErrorSec) 시점과
// 같다 — 즉 A[dt] ≈ B[dt+residualErrorSec], gcc-phat 정의와 비교하면
// lag = -residualErrorSec. 따라서 offsetSec_true = offsetSec_current -
// lagSec(hashA=대표, hashB=멤버 순서일 때). 쌍 순서가 반대면 부호도
// 반대(cross-correlation은 A/B를 바꾸면 lag 부호가 뒤집힌다).
const VOD_SYNC_OFFSET_REFINE_DEADBAND_SEC = 0.3;

// 쌍(hashA, hashB)이 vod-sync 그룹의 "대표-멤버" 쌍이면 그 역할을 돌려주고,
// 아니면(라이브 그룹, 또는 vod-sync라도 멤버끼리의 쌍) null을 돌려준다.
// 오프셋 보정(아래 maybeRefineVodSyncOffsetFromLag)과 Stage2 탐색 범위 확장
// (§refreshWaveformScoreForPair)·최종 음소거 판정(§recomputeCollabMuting)
// 셋 다 같은 판별이 필요해서 뽑아냈다. sign은 lagSec(hashA 기준)을
// residualErrorSec(항상 "대표 - 멤버" 관점)로 바꿀 때 곱하는 부호 — 대표가
// hashB 쪽이면 상관관계 A/B가 뒤바뀐 셈이라 부호도 뒤집힌다.
function getVodSyncRepMemberPair(hashA, hashB) {
  const group = findCollabGroupForChannel(hashA);
  if (!group || !isVodSyncGroup(group)) return null;
  const representativeHash = getCollabLeaderHash(group);
  if (!representativeHash) return null;
  if (hashA === representativeHash && hashB !== representativeHash) {
    return { group, representativeHash, memberHash: hashB, sign: -1 };
  }
  if (hashB === representativeHash && hashA !== representativeHash) {
    return { group, representativeHash, memberHash: hashA, sign: 1 };
  }
  return null;
}

// **버그 수정(실사용 지적 — "아까보다 더 차이가 심해졌는데 지금은
// 양쪽 싱크가 10초이상 차이나는거 같아"): 캡처 창을 15초로 넓힌 뒤
// 폭주(runaway) 오탐 루프가 있었다.** 원인: 보정이 offsetSec을 바꾸면
// 다음 CHANNEL_PLAYBACK_TIME 사이클에서 바로 새 시크가 걸리는데, 그
// 시크 전후로 워클릿 링 버퍼가 계속 채워지고 있어서 "시크 전 오디오 +
// 시크 후 오디오"가 한 버퍼에 섞인 채로 다음 GCC-PHAT에 들어갔다 —
// 이런 섞인 버퍼에서 우연히 짧은 구간이 맞아떨어지는 오탐이 나오면 또
// 틀린 보정 → 또 시크 → 또 섞인 버퍼로 이어져, 한 번 어긋나면 스스로
// 점점 더 벌어지는 피드백 루프가 됐다. 넓힌 창(15초, ±12초 탐색) 자체가
// 좁은 창보다 우연한 오탐 확률도 더 높다는 것도 겹쳤다.
//
// 대응 두 가지(당시):
// 1) 보정을 실제로 적용한 직후, 그 멤버의 캡처 버퍼를 강제로 리셋한다
//    (setChannelCapture의 forceReset). 다음 시크가 곧 일어날 걸 알고
//    있으므로 미리 비워서, 시크 전/후가 섞이는 대신 시크 후 오디오만
//    깨끗하게 다시 채워지게 한다 — refreshWaveformScoreForPair의
//    filled 체크가 그 15초가 다 찰 때까지 자연히 재상관을 미룬다.
// 2) 오프셋을 실제로 바꾸는 데는(음소거 판정보다 훨씬 위험 — 되돌리기
//    어렵고 다음 측정까지 오염시킴) 단일 틱에 훨씬 높은 점수(0.35)를
//    요구했다.
//
// 2026-08-16 후속(사용자 실사용 지적: "음소거는 제대로 되는데 방송
// 자체는 차이가 좀 나 — 음소거 판단이 유지되면 오프셋도 더 정확하게
// 맞추면 좋겠어") — 위 2)를 바꿨다. 음소거 임계값(COLLAB_WAVEFORM_
// MATCH_THRESHOLD=0.10)과 오프셋 보정 임계값(0.35) 사이 점수가 실사용
// 에서 흔해서, 음소거는 계속 맞게 유지되는데도 그 신호로는 오프셋을
// 못 고치는 구간이 넓었다 — 단일 틱 기준을 높이는 접근 자체가 문제였다.
// 단일 틱의 점수를 더 높게 요구하는 대신, **음소거 판정이 여러 틱
// 연속으로 유지되는지**로 신뢰도를 쌓는 방식으로 바꾼다 — 폭주 루프
// (바로 위 문단)를 다시 만들지 않으려면 그 신뢰가 "여러 독립된 관측이
// 서로 동의할 때"만 나와야 하므로, 단일 고임계값 대신 (a) 매 틱은
// 음소거와 같은 낮은 문턱만 넘으면 되고 (b) 최근 몇 틱의 잔차가 서로
// 일치할 때만 실제로 적용한다.
const VOD_SYNC_OFFSET_REFINE_MIN_SCORE = COLLAB_WAVEFORM_MATCH_THRESHOLD;
// 이만큼 최근 확인이 쌓여야("음소거 판단이 유지됨") 보정을 고려한다.
const VOD_SYNC_OFFSET_REFINE_MIN_CONFIRMATIONS = 3;
// 최근 확인들끼리 이 이내로 일치해야 진짜 신호로 본다 — 흩어져 있으면
// (예: 서로 다른 소리에 우연히 잠깐씩 걸림) 아직 믿지 않고 계속 관찰만
// 한다. 폭주 루프의 근본 원인이 "우연한 단발 오탐"이었으므로, 이 합의
// 조건이 예전의 높은 단일 임계값(0.35)을 대신하는 안전장치다.
const VOD_SYNC_OFFSET_REFINE_AGREEMENT_SEC = 0.5;
// 확인 기록의 유효 기간 — Stage2 주기(COLLAB_WAVEFORM_REFRESH_MS=1.2초)
// 기준 3틱이면 최소 3.6초, 대화가 잠깐 끊겨 몇 틱 비는 경우까지 감안해
// 여유를 둔다. 이보다 오래된 확인은 "유지"로 안 쳐준다.
const VOD_SYNC_OFFSET_REFINE_HISTORY_MAX_AGE_MS = 10000;

// memberHash → 최근 "음소거 판정이 유지되는 동안" 관측된 잔차
// (residualErrorSec) 기록. 점수가 문턱 아래로 떨어지면(음소거 판정
// 자체가 흔들림) 즉시 비운다 — "유지"가 아니게 됐으므로.
const vodSyncRefineHistoryByMemberHash = {};

function maybeRefineVodSyncOffsetFromLag(hashA, hashB, lagSec, score) {
  const pair = getVodSyncRepMemberPair(hashA, hashB);
  if (!pair) return;
  const { group, representativeHash, memberHash, sign } = pair;

  if (typeof score !== 'number' || score < VOD_SYNC_OFFSET_REFINE_MIN_SCORE) {
    // 2026-08-16 후속(사용자 지적: "소리가 같다고 판단하면 오프셋이
    // 정확하게 맞춰지는데, 판단이 왔다갔다 하니까 오프셋이 안 맞아서
    // 계속 플리커가 생기는 것 같다" — 되먹임 고리 진단). 예전엔 단
    // 한 번 낮은 점수만 나와도 그동안 쌓은 확인 기록을 통째로 지웠다
    // — 노이즈로 가끔 낮게 나오는 정도만으로도 "연속 3회 확인"이
    // 영원히 못 쌓여, 오프셋이 부정확한 채로 남고 그 부정확함이 다시
    // 점수를 borderline으로 만드는 원인이 되는 악순환이었다. 이제
    // 낮은 점수는 그냥 무시(새 기록은 안 남기되 기존 기록도 안
    // 지움)만 한다 — 아래에서 매번 새로 필터링하는 시간 기반 트리밍
    // (VOD_SYNC_OFFSET_REFINE_HISTORY_MAX_AGE_MS, 10초)이 알아서 오래된
    // 항목을 걸러내므로, 10초 안에 좋은 확인이 3번만 모이면(그 사이에
    // 노이즈 섞인 낮은 점수가 끼어도) 여전히 보정이 걸린다. 서로 다른
    // 시점의 진짜 값을 잘못 섞어 쓰는 위험은 그대로 남아있는 합의 검증
    // (VOD_SYNC_OFFSET_REFINE_AGREEMENT_SEC, 최근 3개끼리 0.5초 이내
    // 일치)이 막아준다 — 진짜 드리프트가 있었다면 오래된 값과 안
    // 맞아 자연히 걸러진다.
    return;
  }
  const residualErrorSec = sign * lagSec;

  const repStartMs = audioState.vodStartTimeMsByHash[representativeHash];
  if (typeof repStartMs !== 'number') return; // 대표 쪽 앵커가 없으면(비치지직 등) 보정 불가
  const currentOffset = getVodSyncOffsetSec(group, memberHash);
  if (currentOffset === null) return; // 메타데이터 오프셋 자체가 아직 없음

  const now = Date.now();
  const history = (vodSyncRefineHistoryByMemberHash[memberHash] || [])
    .filter((entry) => now - entry.at < VOD_SYNC_OFFSET_REFINE_HISTORY_MAX_AGE_MS);
  history.push({ residualErrorSec, at: now });
  vodSyncRefineHistoryByMemberHash[memberHash] = history;

  if (history.length < VOD_SYNC_OFFSET_REFINE_MIN_CONFIRMATIONS) return; // 아직 "유지"라 부를 만큼 안 쌓임

  const recent = history.slice(-VOD_SYNC_OFFSET_REFINE_MIN_CONFIRMATIONS);
  const values = recent.map((e) => e.residualErrorSec);
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > VOD_SYNC_OFFSET_REFINE_AGREEMENT_SEC) return; // 최근 확인들끼리 안 맞음 — 아직 믿지 않고 계속 관찰

  const sorted = [...values].sort((a, b) => a - b);
  const medianResidualSec = sorted[Math.floor(sorted.length / 2)];
  if (Math.abs(medianResidualSec) < VOD_SYNC_OFFSET_REFINE_DEADBAND_SEC) {
    delete vodSyncRefineHistoryByMemberHash[memberHash]; // 이미 충분히 정확함
    return;
  }

  // 멤버의 절대 시작 시각(앵커)을 보정한다 — 대표 쪽 앵커는 항상 고정
  // 기준점으로 취급(시크가 대표 위치 기준으로 돌기 때문)하고, 멤버 쪽만
  // 밀어서 새 오프셋(currentOffset + medianResidualSec)이 나오게 역산한다.
  // group.vodOffsetSecByHash가 아니라 audioState.vodStartTimeMsByHash(전역
  // 앵커 캐시)에 반영해야 대표가 나중에 바뀌어도 이 보정이 그대로
  // 유효하다(§양방향).
  audioState.vodStartTimeMsByHash[memberHash] = repStartMs - (currentOffset + medianResidualSec) * 1000;
  saveAudioState();
  // 보정을 적용했으니 이 확인들은 다 소비됐다 — 곧 시크가 일어나 다음
  // 관측부터는 새 위치 기준으로 다시 쌓아야 한다(아래 forceReset과 같은 이유).
  delete vodSyncRefineHistoryByMemberHash[memberHash];

  // 곧 새 오프셋으로 시크가 일어난다(§CHANNEL_PLAYBACK_TIME 핸들러) —
  // 그 전에 멤버 쪽 캡처를 미리 비워, 다음 15초는 시크 후 오디오로만
  // 깨끗하게 다시 채워지게 한다(위 대응 1번).
  setChannelCapture(memberHash, true, VOD_SYNC_CAPTURE_WINDOW_SEC, true);
}

// 쌍 하나(hashA, hashB)의 파형 스니펫을 받아 정규화 교차상관(§8, 기본값은
// PHAT 아님)을 계산하고 pairKey로 캐시한다.
// requestAudioSnippet의 결과는 세 가지: null(타임아웃 — 다음 주기 재시도),
// {samples:null, unavailable:true}(이 채널은 Stage 2를 영구적으로 못 씀),
// {samples, sampleRate, filled}(성공 — filled는 3초 창이 다 찼는지).
async function refreshWaveformScoreForPair(hashA, hashB) {
  const [snipA, snipB] = await Promise.all([
    getOrRequestSnippetForCycle(hashA),
    getOrRequestSnippetForCycle(hashB)
  ]);
  if (snipA && snipA.unavailable) collabWaveformUnavailableHashes.add(hashA);
  if (snipB && snipB.unavailable) collabWaveformUnavailableHashes.add(hashB);
  if (!snipA || !snipB || !snipA.samples || !snipB.samples) return;
  // 캡처가 막 시작돼 3초 창이 아직 안 찼으면(zero-padding 섞인 상태) 신뢰할
  // 수 없는 값이 나올 수 있다 — 다음 주기에 다시 시도한다(§실사용 버그 수정).
  if (!snipA.filled || !snipB.filled) return;

  // AI 음성 감지(§10)가 켜져 있고 준비돼 있으면, 둘 중 하나라도 실제로
  // 말하는 구간만 남긴 버퍼로 상관을 계산한다 — 로딩 중/실패면
  // masked===null이라 예전처럼 원본 버퍼 그대로 쓰고, 둘 다 이 3초 창에서
  // 거의 안 말했으면 masked==='insufficient'라 이번 주기는 건너뛴다(§3.2
  // 폴백 정책).
  let bufA = snipA.samples;
  let bufB = snipB.samples;
  if (isCollabVadEnabled()) {
    const masked = await getVadMaskedSnippets(hashA, snipA, hashB, snipB);
    if (masked === 'insufficient') return;
    if (masked) {
      bufA = masked.samplesA;
      bufB = masked.samplesB;
    }
  }

  // vod-sync 대표-멤버 쌍은 메타데이터 오프셋 잔차가 라이브 레이턴시
  // 차이보다 훨씬 클 수 있어(§VOD_SYNC_WAVEFORM_MAX_LAG_SEC 주석, 사용자
  // 실사용 지적) 더 넓은 범위로 찾는다 — 캡처 창 자체도
  // refreshCollabCaptureState가 이미 이 쌍에 한해 넓게 요청해뒀다.
  const isVodSyncPair = !!getVodSyncRepMemberPair(hashA, hashB);
  const maxLagSec = isVodSyncPair ? VOD_SYNC_WAVEFORM_MAX_LAG_SEC : COLLAB_WAVEFORM_MAX_LAG_SEC;
  const centerLagSec = isVodSyncPair ? 0 : getEstimatedGccCenterLagSec(hashA, hashB);

  // computeMs는 디버그 패널에서 워커 오프로딩(§8.6)이 실제로 메인 스레드를
  // 얼마나 비웠는지 눈으로 확인할 수 있게 재는 값이다 — Promise 왕복 시간
  // (워커 큐잉 등)까지 포함하므로 순수 FFT 연산 시간보다는 약간 크게
  // 나올 수 있다.
  const computeStart = performance.now();
  const result = await computeGccPhatAsync(
    bufA, snipA.sampleRate,
    bufB, snipB.sampleRate,
    maxLagSec,
    centerLagSec
  );
  const computeMs = performance.now() - computeStart;
  if (!result) return;
  collabWaveformScoreByPair[pairKey(hashA, hashB)] = { score: result.score, lagSec: result.lagSec, at: Date.now(), computeMs };
  if (isVodSyncPair) {
    // 음소거 판정(COLLAB_WAVEFORM_MATCH_THRESHOLD, getWaveformVerdict를
    // 통해 recomputeCollabMuting에서 씀)보다 오프셋을 실제로 바꾸는 쪽이
    // 훨씬 위험하므로, maybeRefineVodSyncOffsetFromLag는 매 틱은 같은
    // 문턱(VOD_SYNC_OFFSET_REFINE_MIN_SCORE=COLLAB_WAVEFORM_MATCH_THRESHOLD)
    // 만 넘으면 되지만 여러 틱이 서로 합의할 때만 실제로 적용한다(§위
    // 2026-08-16 후속 주석).
    maybeRefineVodSyncOffsetFromLag(hashA, hashB, result.lagSec, result.score);
  }
}

// Stage 1 후보로 걸린 모든 쌍을 훑어 Stage 2 재계산을 트리거한다(진행
// 중인 쌍은 건너뜀). setInterval로 주기 실행(아래). 매 틱 시작 시 이번
// 틱 전용 스니펫/VAD 캐시를 비운다(위 참고).
function refreshAllWaveformScores() {
  if (!isCollabSettingEnabled()) return;
  collabSnippetCycleCache = {};
  collabVadResultCycleCache = {};
  audioState.collabGroups.forEach((group) => {
    getGroupPairs(group).forEach(([a, b]) => {
      if (!collabCaptureHashes.has(a) || !collabCaptureHashes.has(b)) return;
      const key = pairKey(a, b);
      if (collabWaveformRefreshInFlight.has(key)) return;
      collabWaveformRefreshInFlight.add(key);
      refreshWaveformScoreForPair(a, b).finally(() => {
        collabWaveformRefreshInFlight.delete(key);
      });
    });
  });
}
setInterval(refreshAllWaveformScores, COLLAB_WAVEFORM_REFRESH_MS);

// 대화 중 자연스러운 텀만으로 Stage 1 엔벨로프 상관이 잠깐 임계값 아래로
// 내려갈 수 있는데, 그때마다 캡처를 바로 끄면 3초 링 버퍼가 리셋되고
// 다시 처음부터 채워야 한다 — 그 사이 계속 새로 "Stage 2 워밍업 중"
// 상태가 반복돼 사실상 Stage 2가 영원히 확정되지 못하는 실사용 버그가
// 있었다. 마지막으로 후보였던 시점 기준 이 시간 안에는 캡처를 계속
// 유지한다(§docs/collab-architecture.md §6).
const COLLAB_CAPTURE_LINGER_MS = 5000;
// pairKey → 마지막으로 Stage 1 후보 조건을 만족했던 시각.
const collabPairCandidateLastSeenAt = {};

// Stage 1이 (최근 COLLAB_CAPTURE_LINGER_MS 이내에) 후보로 판단한 쌍의 양쪽
// hash에서만 워클릿 파형 캡처를 켜고, 그 기간이 다 지나야 끈다(캡처 자체가
// 비용이라 필요할 때만, 그러나 너무 자주 리셋되지 않게). recomputeCollabMuting
// 이 매 사이클 collabPairSimilarity를 갱신한 뒤 호출한다.
//
// vod-sync 대표-멤버 쌍은 이 Stage 1 게이트를 아예 안 거친다 — 애초에 어느
// 쌍을 봐야 하는지 메타데이터 오프셋으로 이미 알고 있으므로 "후보인지
// Stage1로 먼저 확인"이 필요 없고(라이브 그리드에서 Stage1이 존재하는
// 이유는 O(n²) 쌍 전부에 Stage2를 돌리지 않기 위한 저비용 예비 필터일
// 뿐), 오히려 Stage1의 ±3초/5초 창이 메타데이터 오프셋의 잔차보다 좁으면
// 후보로도 못 잡혀 캡처 자체가 안 켜진다(사용자 실사용 지적의 원인).
// 캡처 창도 VOD_SYNC_CAPTURE_WINDOW_SEC(15초)로 넓게 요청한다.
// hash → 이번 사이클에 요청할 캡처 창(초). undefined면 워클릿 기본값(3초).
let collabCaptureWindowSecByHash = {};
function refreshCollabCaptureState() {
  const now = Date.now();
  const needed = {}; // hash -> windowSec(undefined 가능) — Object.keys로 순회하므로 Map 대신 사용
  if (isCollabSettingEnabled()) {
    audioState.collabGroups.forEach((group) => {
      if (isVodSyncGroup(group)) {
        const representativeHash = getCollabLeaderHash(group);
        if (!representativeHash) return;
        let anyAligned = false;
        group.memberHashes.forEach((h) => {
          if (h === representativeHash) return;
          if (getVodSyncOffsetSec(group, h) === null) return;
          anyAligned = true;
          needed[h] = VOD_SYNC_CAPTURE_WINDOW_SEC;
        });
        if (anyAligned) needed[representativeHash] = VOD_SYNC_CAPTURE_WINDOW_SEC;
        return;
      }
      getGroupPairs(group).forEach(([a, b]) => {
        const key = pairKey(a, b);
        const similarity = collabPairSimilarity[key];
        if (typeof similarity === 'number' && similarity >= COLLAB_OVERLAP_MUTE_THRESHOLD) {
          collabPairCandidateLastSeenAt[key] = now;
        }
        const lastSeen = collabPairCandidateLastSeenAt[key];
        if (typeof lastSeen === 'number' && now - lastSeen <= COLLAB_CAPTURE_LINGER_MS) {
          if (!(a in needed)) needed[a] = undefined;
          if (!(b in needed)) needed[b] = undefined;
        }
      });
    });
  }
  Object.keys(needed).forEach((hash) => {
    const windowSec = needed[hash];
    if (!collabCaptureHashes.has(hash) || collabCaptureWindowSecByHash[hash] !== windowSec) {
      collabCaptureHashes.add(hash);
      collabCaptureWindowSecByHash[hash] = windowSec;
      setChannelCapture(hash, true, windowSec);
    }
  });
  Array.from(collabCaptureHashes).forEach((hash) => {
    if (!(hash in needed)) {
      collabCaptureHashes.delete(hash);
      delete collabCaptureWindowSecByHash[hash];
      setChannelCapture(hash, false);
    }
  });
}

// Stage 2(파형 GCC-PHAT)의 현재 판정 상태를 하나로 정리한 표준 뷰.
// 실제 음소거 판정과 화면 표시(배지, 디버그 패널)가 각자 따로 "fresh 여부"를
// 판단하다 서로 어긋나던 버그(디버그 패널은 캐시된 오래된 값으로 "다른
// 소리"를 보여주는데 배지는 "확인 중"을 보여주는 등)를 막기 위해, 판정
// 로직을 이 함수 하나로 모은다 — 배지·디버그 패널·실제 음소거 판정이 전부
// 이 함수 결과만 보고 그린다.
//   'unavailable' — 이 쌍의 한쪽 이상이 Stage 2를 영구적으로 못 씀
//   'match'       — Stage 2가 신선하게 "같은 소리"로 확인함
//   'different'   — Stage 2가 신선하게 "다른 소리"로 확인함
//   'grace'       — 신선한 값은 없지만, 최근(COLLAB_WAVEFORM_CONFIRM_GRACE_MS
//                   이내)에 "같은 소리"로 확인된 적이 있어 그 판정을 유예 중
//   'pending'     — 신선한 값도, 최근 확인 이력도 없음(진짜 첫 측정 대기)
// 2026-08-16 후속(사용자 실사용 지적 — "한 번 음소거가 유지되면 다른
// 대화를 해도 잘 안 풀림" + "채널 변경/시크 시 잠깐 상태가 풀림") 두
// 가지를 같이 고쳤다:
// 1) "확인 기록"(collabPairLastConfirmedAt) 갱신을 이 함수 하나로
//    모았다 — 예전엔 getCombinedOverlapValueForPair(라이브 쌍 경로)
//    에서만 기록해서, vod-sync 쌍(§아래 recomputeCollabMuting에서
//    getWaveformVerdict를 직접 씀)은 한 번도 "확인됨"으로 기록되지
//    않아 grace를 영영 못 받았다 — Stage2가 조금만 stale해도(예:
//    forceReset 직후 15초 캡처가 다시 찰 때까지, §VOD_SYNC_CAPTURE_
//    WINDOW_SEC) 바로 'pending'으로 떨어져 음소거가 풀렸다.
// 2) grace 자격을 "Stage1이 아직 이 쌍을 후보로 보고 있어(캡처가
//    켜져 있어) Stage2만 잠깐 늦은 경우"로 좁혔다(stillCandidate) —
//    Stage1이 이미 COLLAB_CAPTURE_LINGER_MS 내내 낮아서 캡처 자체가
//    꺼졌다면 이건 "확인 지연"이 아니라 "진짜 다른 소리"일 가능성이
//    높으므로 grace를 주지 않는다. 이게 없으면 grace가 무조건 8초
//    (vod-sync는 17초)씩 붙어서, 대화가 갈라져도 그만큼 오래 음소거가
//    안 풀리는 게 "잘 안 풀림" 문제의 원인이었다. vod-sync 쌍은
//    오프셋이 있는 한 캡처가 항상 켜져 있으므로(§refreshCollabCaptureState)
//    이 조건에 사실상 항상 통과 — Stage1 개념 자체가 없는 vod-sync엔
//    원래도 해당 안 되는 제약이라 자연스럽다.
function getWaveformVerdict(hashA, hashB) {
  if (collabWaveformUnavailableHashes.has(hashA) || collabWaveformUnavailableHashes.has(hashB)) {
    return { state: 'unavailable' };
  }
  const key = pairKey(hashA, hashB);
  const waveform = collabWaveformScoreByPair[key];
  const fresh = waveform && (Date.now() - waveform.at) <= COLLAB_WAVEFORM_MAX_AGE_MS;
  if (fresh) {
    if (waveform.score >= COLLAB_WAVEFORM_MATCH_THRESHOLD) {
      collabPairLastConfirmedAt[key] = Date.now();
      return { state: 'match', waveform };
    }
    delete collabPairLastConfirmedAt[key]; // 명시적으로 "다른 소리"로 확인됨 — 이전 확인 기록은 폐기
    return { state: 'different', waveform };
  }
  const stillCandidate = collabCaptureHashes.has(hashA) && collabCaptureHashes.has(hashB);
  const lastConfirmedAt = collabPairLastConfirmedAt[key];
  const isVodSyncPair = !!getVodSyncRepMemberPair(hashA, hashB);
  const graceMs = isVodSyncPair ? VOD_SYNC_WAVEFORM_CONFIRM_GRACE_MS : COLLAB_WAVEFORM_CONFIRM_GRACE_MS;
  if (stillCandidate && typeof lastConfirmedAt === 'number' && Date.now() - lastConfirmedAt <= graceMs) {
    return { state: 'grace', waveform, lastConfirmedAt };
  }
  return { state: 'pending', waveform };
}

// Stage 1 값(엔벨로프 상관)에 Stage 2(파형 GCC-PHAT, getWaveformVerdict)를
// 얹어 최종 음소거 판정에 쓸 값을 만든다. UI에 보여주는 "겹침 %"는 항상
// Stage 1 원본값(collabPairSimilarity)을 그대로 쓴다 — 이 함수의 결과는
// 임계값 비교에만 쓴다.
//
// 실사용 중 확인된 버그: 원래 "Stage 2가 신선하지 않으면 Stage 1 단독
// 폴백"이었는데, 캡처가 3초 창을 채우는 데 최소 3초 걸리는 반면 mute
// 판정은 800ms면 나서 매번 새 후보가 될 때마다 Stage 2가 준비되기 전에
// Stage 1 단독으로 먼저 음소거돼 "다른 말을 해도 음소거"가 재현됐다.
// 오탐(다른 말인데 음소거) 비용이 지연(겹치는데 몇 초 늦게 음소거) 비용보다
// 크므로 정책을 바꾼다: Stage 2를 아예 못 쓰는 채널만 Stage 1 단독 폴백,
// 그 외 "아직 확인 전"은 무조건 안 겹침(-1)으로 취급한다(§12 유예 기간은 예외).
//
// 2026-08-16 후속 — grace의 반환값을 Stage1 원값에서 "겹침 유지"로
// 바꿨다. 예전엔 grace 기간에도 envelopeSimilarity를 그대로 돌려줘서,
// 채널 전환/캡처 리셋 직후처럼 Stage1이 우연히 낮게 나오는 과도기에
// 방금 Stage2가 확인해준 결과를 뒤집어버렸다(§COLLAB_WAVEFORM_CONFIRM_
// GRACE_MS 원래 설계 의도 — "직전 상태를 유지한다"— 와 실제 구현이
// 어긋나 있던 버그). grace 자격 자체가 이제 위 stillCandidate로
// 좁혀졌으니, Stage1을 다시 참고할 필요 없이 무조건 겹침 유지로 반환해도
// 안전하다(§getWaveformVerdict 주석).
function getCombinedOverlapValueForPair(hashA, hashB, envelopeSimilarity) {
  const verdict = getWaveformVerdict(hashA, hashB);
  if (verdict.state === 'unavailable' || verdict.state === 'match') {
    return envelopeSimilarity;
  }
  if (verdict.state === 'grace') {
    return COLLAB_OVERLAP_MUTE_THRESHOLD;
  }
  return -1; // 'different' 또는 'pending'
}

// 활성 간선(collabActiveEdges) 중 이 그룹 멤버들 사이의 것만으로 그래프를
// 만들어 연결 요소(cluster)를 구한다 — BFS. 크기 1(고립 멤버, 아무와도
// 활성 간선이 없음)도 결과 배열에 포함되지만, 뮤팅 로직(recomputeCollabMuting)
// 에서 크기 ≥2인 것만 다루므로 고립 멤버는 자연히 음소거 대상에서 빠진다.
function getGroupClusters(group) {
  const members = group.memberHashes;
  const adjacency = new Map(members.map((h) => [h, []]));
  getGroupPairs(group).forEach(([a, b]) => {
    if (!collabActiveEdges.has(pairKey(a, b))) return;
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  });
  const visited = new Set();
  const clusters = [];
  members.forEach((start) => {
    if (visited.has(start)) return;
    const cluster = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift();
      cluster.push(cur);
      adjacency.get(cur).forEach((next) => {
        if (visited.has(next)) return;
        visited.add(next);
        queue.push(next);
      });
    }
    clusters.push(cluster);
  });
  return clusters;
}

// group.id → 대표가 마지막으로 바뀐 시각. 그 이후로 새 대표와 클러스터의
// 다른 멤버들 사이에 Stage2(파형 분석)가 아직 한 번도 신선하게 안 돌았으면
// (§hasFreshWaveformSinceLeaderChange) pickClusterKeeper의 규칙 1번(대표면
// 무조건 keeper)을 잠깐 보류한다 — 사용자 요청: "교집합 내에서 대표
// 채널이 바뀌면 기본적으로 이전 상태를 유지해줘(파형 분석 전까지)".
// 확인이 끝나면(또는 너무 오래 안 끝나면, §아래 최대 대기) 항목을 지운다.
let leaderChangedAtByGroupId = {};
// 파형 분석이 끝없이 안 돌아 무기한 대기하는 걸 막는 안전판(예: 새
// 대표가 다른 멤버들과 Stage1 후보 조건 자체를 못 만나 Stage2가 영영
// 안 도는 조합) — 실측 근거 없는 잠정치.
const LEADER_CHANGE_KEEPER_HOLD_MAX_MS = 6000;

// 새 대표와 클러스터의 다른 멤버 각각 사이에, changedAt(대표가 바뀐 시각)
// 이후로 찍힌 신선한 Stage2 결과가 있는지 — 전부 있어야 "확인 끝"이다.
function hasFreshWaveformSinceLeaderChange(representative, cluster, changedAt) {
  const others = cluster.filter((h) => h !== representative);
  if (others.length === 0) return true; // 대표 혼자인 클러스터 — 확인할 상대가 없음
  return others.every((h) => {
    const waveform = collabWaveformScoreByPair[pairKey(representative, h)];
    return waveform && waveform.at >= changedAt;
  });
}

// 겹침 클러스터 안에서 계속 들려줄(음소거하지 않을) 채널 하나를 정한다
// (docs/collab-latency-architecture.md — 레이턴시 측정의 새 역할).
// 1) 그룹 대표 채널이 이 클러스터 안에 있으면 무조건 대표(항상 예외) —
//    단, 대표가 막 바뀐 직후라면 Stage2가 새 대표를 재확인할 때까지
//    (또는 LEADER_CHANGE_KEEPER_HOLD_MAX_MS가 지날 때까지) 이 규칙을
//    보류하고 아래 2번으로 넘어간다(§leaderChangedAtByGroupId, 2026-08-16
//    후속 — 대표 교체 직후 keeper가 파형 분석도 없이 즉시 뒤집히는 걸 막음).
// 2) 없으면, 직전 사이클에 이미 음소거 상태가 아니었던 멤버를 그대로
//    유지한다(sticky) — 클러스터 구성이 조금씩 바뀔 때마다 keeper가 매번
//    바뀌는 걸 막기 위해 별도 히스테리시스 상수 없이 자연스럽게 안정된다.
// 3) 그것도 없으면(새로 생긴 클러스터) 레이턴시가 가장 낮은(가장 실시간에
//    가까운) 멤버.
// 4) 레이턴시 데이터가 아무도 없으면 그룹 내 순서상 첫 멤버로 결정적으로
//    폴백.
function pickClusterKeeper(cluster, representative, groupId) {
  if (representative && cluster.includes(representative)) {
    const changedAt = groupId != null ? leaderChangedAtByGroupId[groupId] : undefined;
    const holdExpired = typeof changedAt === 'number' && (Date.now() - changedAt) > LEADER_CHANGE_KEEPER_HOLD_MAX_MS;
    if (typeof changedAt !== 'number' || holdExpired || hasFreshWaveformSinceLeaderChange(representative, cluster, changedAt)) {
      if (typeof changedAt === 'number') delete leaderChangedAtByGroupId[groupId]; // 확인 끝 — 더 볼 필요 없음
      return representative;
    }
    // 아직 확인 전 — 규칙 1번을 이번 사이클엔 보류하고 아래로 넘어간다.
  }
  const stillUnmuted = cluster.find((h) => !collabMutedHashes.has(h));
  if (stillUnmuted) return stillUnmuted;
  let bestHash = null;
  let bestLatency = Infinity;
  cluster.forEach((h) => {
    const lat = channelLatencySecByHash[h];
    if (typeof lat === 'number' && isFinite(lat) && lat < bestLatency) {
      bestLatency = lat;
      bestHash = h;
    }
  });
  return bestHash || cluster[0];
}

// 그룹마다 모든 쌍을 비교해 겹침 그래프(활성 간선)를 갱신하고, 연결 요소
// (클러스터)마다 keeper 하나만 남기고 나머지를 음소거한다. 더 이상
// 추적되지 않는(그룹에서 빠진) 쌍/채널의 상태는 함께 정리한다.
function recomputeCollabMuting() {
  if (!isCollabSettingEnabled()) {
    collabMutedHashes.clear();
    collabPairSimilarity = {};
    collabEdgeMuteCandidateSince = {};
    collabEdgeUnmuteCandidateSince = {};
    collabActiveEdges = new Set();
    collabWaveformScoreByPair = {};
    collabPairLastConfirmedAt = {};
    refreshCollabCaptureState(); // needed셋이 비어있으므로 켜져 있던 캡처를 전부 끈다
    updateChatTabCollabIcons();
    return;
  }

  const now = Date.now();
  const muteThreshold = COLLAB_OVERLAP_MUTE_THRESHOLD;
  const unmuteThreshold = COLLAB_OVERLAP_UNMUTE_THRESHOLD;
  const nextSimilarity = {};
  const trackedPairKeys = new Set();
  const nextMutedHashes = new Set();

  audioState.collabGroups.forEach((group) => {
    const representative = getCollabLeaderHash(group);

    // vod-sync 그룹도 이제 라이브와 같은 클러스터 음소거 골격(2)을 그대로
    // 탄다(사용자 요청 — "싱크가 맞은 시점부터는 라이브 방식과 동일하게
    // 음량 제어해"). 예전엔 여기서 "오프셋이 설정돼 있으면 무조건
    // 음소거"로 건너뛰었는데, 메타데이터 오프셋 자체에 오차가 있어(§위
    // maybeRefineVodSyncOffsetFromLag 주석) 그 오차가 큰 동안에도 무조건
    // 음소거되는 게 부자연스러웠다. 대신 실제로 겹침이 확인된 뒤에만
    // 음소거하도록 바꿨다 — 다만 그 "확인"은 아래(1)에서 대표-멤버 쌍에
    // 한해 Stage1을 건너뛰고 Stage2로 직접 한다(별도 분기 있음, 이유는
    // 바로 아래 주석). "정렬 전"(오프셋 자체가 없음)이나 "오프셋은
    // 있지만 아직 안 맞음"이나 결과적으로 똑같이 "안 겹침"으로 처리된다.

    // 1) 모든 쌍의 Stage1 유사도 → Stage1+2 결합 판정 → 쌍(edge) 단위
    // mute/unmute 히스테리시스로 collabActiveEdges 갱신.
    //
    // vod-sync 대표-멤버 쌍은 Stage1(computeCollabSimilarity)을 아예
    // 건너뛰고 Stage2 판정을 직접 쓴다(사용자 실사용 지적 — "2~3초
    // 수준보다 더 차이가 나나본데? 음소거 판단을 못하네"). 원인: Stage1은
    // ±3초/5초 이력 창이 라이브 레이턴시 차이에 맞춰져 있어, 그보다 큰
    // 메타데이터 오프셋 잔차에서는 similarity가 계속 null이거나 우연한
    // 잡음 수준에 머물러 아래 if(similarity===null) return에 걸려 Stage2
    // 결과(이미 넓은 창으로 확인해뒀을 수 있음, §refreshWaveformScoreForPair)
    // 까지 아예 도달을 못 했다 — Stage2가 진짜 정답을 갖고 있어도 Stage1이
    // 문지기 역할을 하며 막아버린 것. vod-sync는 애초에 "이 쌍을 봐야
    // 한다"는 걸 메타데이터로 이미 알고 있어 Stage1의 예비 필터 역할
    // 자체가 필요 없다(라이브 그리드처럼 O(n²) 쌍 전부를 훑어야 하는
    // 상황이 아님) — 그래서 Stage2 단독으로도 안전하다.
    getGroupPairs(group).forEach(([a, b]) => {
      const key = pairKey(a, b);
      trackedPairKeys.add(key);

      if (isCollabResetHoldActive(a) || isCollabResetHoldActive(b)) {
        // 방금 시크/영상 전환이 있었던 쪽이 낀 쌍 — Stage1/2가 아직 새
        // 내용을 다 못 반영한 과도기라, 이 사이클의 판정으로 기존 결정
        // (음소거 여부)을 뒤집지 않고 그대로 건너뛴다(§collabResetHoldUntilByHash,
        // 2026-08-16 후속 — "채널 변경시 잠깐 기존 상태가 풀림" 버그).
        return;
      }

      let decision;
      const vodSyncPair = getVodSyncRepMemberPair(a, b);
      if (vodSyncPair) {
        // "겹침 %" UI 배지는 vod-sync 카드에 안 쓰이므로 null로 둔다.
        nextSimilarity[key] = null;
        const verdict = getWaveformVerdict(a, b);
        decision = (verdict.state === 'match' || verdict.state === 'grace') ? 1 : -1;
      } else {
        const similarity = computeCollabSimilarity(a, b);
        nextSimilarity[key] = similarity; // UI "겹침 %"는 항상 이 Stage 1 원본값
        if (similarity === null) return;
        decision = getCombinedOverlapValueForPair(a, b, similarity);
      }

      const isActive = collabActiveEdges.has(key);
      if (!isActive) {
        delete collabEdgeUnmuteCandidateSince[key];
        if (decision >= muteThreshold) {
          if (!collabEdgeMuteCandidateSince[key]) collabEdgeMuteCandidateSince[key] = now;
          if (now - collabEdgeMuteCandidateSince[key] >= COLLAB_MUTE_SUSTAIN_MS) {
            collabActiveEdges.add(key);
            delete collabEdgeMuteCandidateSince[key];
          }
        } else {
          delete collabEdgeMuteCandidateSince[key];
        }
      } else {
        delete collabEdgeMuteCandidateSince[key];
        if (decision < unmuteThreshold) {
          if (!collabEdgeUnmuteCandidateSince[key]) collabEdgeUnmuteCandidateSince[key] = now;
          if (now - collabEdgeUnmuteCandidateSince[key] >= COLLAB_UNMUTE_SUSTAIN_MS) {
            collabActiveEdges.delete(key);
            delete collabEdgeUnmuteCandidateSince[key];
          }
        } else {
          delete collabEdgeUnmuteCandidateSince[key];
        }
      }
    });

    // 2) 활성 간선으로 클러스터를 구하고, 크기 ≥2인 클러스터마다 keeper
    // 하나만 남기고 나머지를 음소거 대상에 넣는다. 대표는 자기 클러스터가
    // 없어도(고립 상태여도) 애초에 음소거 대상이 아니므로 별도 처리가
    // 필요 없다.
    getGroupClusters(group).forEach((cluster) => {
      if (cluster.length < 2) return;
      const keeper = pickClusterKeeper(cluster, representative, group.id);
      cluster.forEach((h) => {
        if (h !== keeper) nextMutedHashes.add(h);
      });
    });
  });

  collabMutedHashes = nextMutedHashes;
  collabPairSimilarity = nextSimilarity;

  Object.keys(collabEdgeMuteCandidateSince).forEach((key) => {
    if (!trackedPairKeys.has(key)) delete collabEdgeMuteCandidateSince[key];
  });
  Object.keys(collabEdgeUnmuteCandidateSince).forEach((key) => {
    if (!trackedPairKeys.has(key)) delete collabEdgeUnmuteCandidateSince[key];
  });
  Array.from(collabActiveEdges).forEach((key) => {
    if (!trackedPairKeys.has(key)) collabActiveEdges.delete(key);
  });
  Object.keys(collabWaveformScoreByPair).forEach((key) => {
    if (!trackedPairKeys.has(key)) delete collabWaveformScoreByPair[key];
  });
  Object.keys(collabPairCandidateLastSeenAt).forEach((key) => {
    if (!trackedPairKeys.has(key)) delete collabPairCandidateLastSeenAt[key];
  });
  Object.keys(collabPairLastConfirmedAt).forEach((key) => {
    if (!trackedPairKeys.has(key)) delete collabPairLastConfirmedAt[key];
  });

  refreshCollabCaptureState();
  updateChatTabCollabIcons();
}

function getEffectiveVolumeForChannel(hash) {
  const role = getChannelRole(hash);
  if (role === 'main') return getMainVolumeForChannel(hash);
  const override = getChannelOverride(hash);
  if (override !== null) return override;
  return getGroupEffectiveVolumeForChannel(hash, role);
}

// 실제로 채널에 적용/표시되는 최종 음량. 오디오 패널의 슬라이더·상태
// 문구도 전부 이 값을 써야 "표시되는 값"과 "실제로 재생되는 값"이 항상
// 일치한다.
// 이 채널이 (리더가 정해진) 합방 그룹의 리더가 아닌 멤버인지.
function isNonLeaderCollabMember(hash) {
  if (!isCollabSettingEnabled()) return false;
  const group = findCollabGroupForChannel(hash);
  if (!group) return false;
  const leader = getCollabLeaderHash(group);
  return !!leader && leader !== hash;
}

function getDisplayVolumeForChannel(hash) {
  let vol = getEffectiveVolumeForChannel(hash);
  // 합방 겹침이 실제로 감지된 멤버만 음소거한다 — 항상 음소거하면 자동
  // 판정의 의미가 없어진다. 저장된 기준 음량/수동 오버라이드는 건드리지
  // 않고 마지막에 얹는 임시 효과다. 레이아웃과 무관하게 항상 동일 적용 —
  // 합방 설정이 균등 설정보다 우선이라 비리더 멤버는 이미 균등 계산
  // 후보에서 빠져 있고 그 결과도 여기서 덮어쓴다. 겹침 감지 시 예전처럼
  // 살짝만 낮추지 않고 완전 음소거한다 — 리더-멤버 스트림 지연 차이 때문에
  // 살짝만 낮추면 메아리처럼 들렸다.
  if (isCollabMutedNow(hash)) {
    vol = 0;
  }
  return vol;
}

// 채널별로 마지막에 실제 적용(전송)한 재생 음량 — 자동 조정(smooth) 폭을
// 제한하는 데 쓴다. 처음 적용되는 채널은 기록이 없어(=undefined) 캡 없이
// 그대로 적용된다(초기 로딩 시 굳이 여러 단계에 걸쳐 서서히 커질 필요는
// 없다).
let lastAppliedDisplayVolume = {};

// docs/collab-architecture.md §13 — 합방 음소거 중에도 측정이 계속
// 진짜 신호를 보게 하려면 content.js에 보내는 video.volume 목표
// ("진짜" 목표, 합방 음소거와 무관)와 화면에 보여주는 값(합방 음소거면
// 0, §lastAppliedDisplayVolume)이 서로 달라야 한다 — clampVolumeStep의
// 이전값 기준을 화면용 값(0으로 떨어질 수 있음)으로 쓰면, 실제로는
// 안 바뀐 "진짜" 목표를 "0에서 급하게 튀어 오른 값"으로 오판해 엉뚱하게
// 스텝 제한을 건다. 그래서 "진짜" 목표 전용 이전값을 따로 추적한다.
let lastAppliedRealVolume = {};

// 한 번의 자동 재조정(dB 평준화 재계산, 합방 겹침 태그 전환 등)으로 한
// 채널의 음량이 한 번에 바뀔 수 있는 최대 폭(%p). 목표값이 이보다 더
// 멀리 있으면 이번엔 이 폭만큼만 다가가고, 나머지는 다음 재조정 주기
// (수백 ms 뒤)에 이어서 다가간다 — smooth 램프(SMOOTH_RAMP_MS)가 "얼마나
// 부드럽게"를 담당한다면, 이건 "한 번에 얼마나 멀리"를 제한한다.
const MAX_AUTO_VOLUME_STEP_PERCENT = 25;

function clampVolumeStep(hash, targetVol) {
  const prev = lastAppliedRealVolume[hash];
  if (typeof prev !== 'number') return targetVol;
  const diff = targetVol - prev;
  if (Math.abs(diff) <= MAX_AUTO_VOLUME_STEP_PERCENT) return targetVol;
  return prev + Math.sign(diff) * MAX_AUTO_VOLUME_STEP_PERCENT;
}

// docs/collab-architecture.md §13 — 합방 음소거가 지금 이 순간 실제로
// 걸려 있는지. isChannelCollabMuted 하나만 보면 "합방 설정 자체가
// 꺼진" 경우에도 과거에 계산된 값이 남아 true를 돌려줄 수 있어, 항상
// 상위 게이트(isCollabSettingEnabled)와 함께 확인한다.
function isCollabMutedNow(hash) {
  return isCollabSettingEnabled() && isChannelCollabMuted(hash);
}

function applyVolumeToAllChannels(smooth) {
  // dB 보정 배율은 채널마다(측정치가 다르므로) 다를 수 있어 그룹 전체에
  // 하나의 값을 재사용할 수 없다 — 채널마다 다시 계산한다.
  videoWrapperMap.forEach((wrapper, hash) => {
    // displayVol: 화면(슬라이더/디버그 패널)에 보여줄 값 — 합방 음소거면
    // 여전히 0이어야 "지금 안 들린다"는 게 화면에도 정확히 보인다.
    // realVol: content.js에 실제로 보내는 video.volume 목표 — 합방
    // 음소거와 완전히 무관하게 항상 "합방이 없다면 나왔을 값"을 유지한다
    // (docs/collab-architecture.md §13). 스피커 출력은 content.js가
    // collabMuted 플래그로 gainNode를 통해 별도로 죽인다.
    const displayVol = getDisplayVolumeForChannel(hash);
    let realVol = getEffectiveVolumeForChannel(hash);
    // 폭 제한은 자동(smooth) 조정에만 건다 — 메인↔서브 전환처럼 사용자가
    // 직접 고른 즉시 반응이 필요한 경우(smooth=false)는 그대로 즉시
    // 적용한다.
    if (smooth) realVol = clampVolumeStep(hash, realVol);
    lastAppliedDisplayVolume[hash] = displayVol;
    lastAppliedRealVolume[hash] = realVol;
    postVolumeMessage(hash, realVol, smooth);
  });
}

let volumeSaveDebounceTimer = null;

// 채널별 오디오 패널의 슬라이더를 사용자가 직접 조작했을 때 호출된다.
// 메인은 이 채널 전용 메인 볼륨(getMainVolumeForChannel/setMainVolumeForChannel)
// 을 바꾸고, 그리드/서브 채널은 이제 기준 음량 자체가 아니라 "수동
// 고정값"을 설정한다 — 그 뒤로는 이 채널만 dB 자동 보정에서 빠지고 이
// 값 그대로 재생된다.
function setChannelVolume(hash, value) {
  const role = getChannelRole(hash);
  const vol = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));

  if (role === 'main') {
    setMainVolumeForChannel(hash, vol);
  } else {
    setChannelOverride(hash, vol);
  }

  // 슬라이더를 드래그하는 동안 input 이벤트가 초당 수십 번 발생할 수 있어
  // chrome.storage 쓰기는 드래그가 끝난 뒤 한 번만 하도록 디바운스한다
  // (실제 소리 반영은 아래에서 즉시 이루어지므로 체감 반응성은 그대로다).
  if (volumeSaveDebounceTimer) clearTimeout(volumeSaveDebounceTimer);
  volumeSaveDebounceTimer = setTimeout(saveAudioState, 300);

  // 이 채널을 고정하는 건 이 채널 자신의 출력에만 영향을 준다 — 그룹의
  // dB 기준(가장 조용한 채널)은 실측 오디오 레벨로 정해지지 이 값으로
  // 정해지는 게 아니므로, 같은 그룹의 다른 채널들을 다시 계산할 필요는
  // 없다.
  //
  // vol은 사용자가 직접 고른 "진짜" 목표이므로 postVolumeMessage에
  // 그대로 넘긴다 — 지금 이 채널이 합방 음소거 중이면 postVolumeMessage가
  // collabMuted:true도 같이 실어 보내므로, content.js는 video.volume은
  // 이 값으로 맞추되 gainNode는 계속 0으로 둬 스피커로는 안 나간다(§docs/
  // collab-architecture.md §13) — 그래서 화면(lastAppliedDisplayVolume)엔
  // 사용자가 지금 드래그하는 값을 그대로 보여주면서도 소리는 여전히
  // 안 나는, 매끄러운 동작이 된다.
  lastAppliedDisplayVolume[hash] = vol;
  lastAppliedRealVolume[hash] = vol;
  postVolumeMessage(hash, vol);
}

// 사용자가 채널별 오디오 패널이 아니라 플레이어를 직접 조작(음소거·볼륨
// 드래그)했을 때 호출된다. content.js는 그래프 유무와 무관하게 항상 이
// 이벤트를 보고한다 — video.volume이 유일한 실제 컨트롤이라 에코 판별이
// 항상 안전하다(GainNode가 따로 볼륨을 갖던 예전 구조에서만 에코 순환
// 문제가 있었다). 이미 그 값으로 재생 중이므로 SET_CHANNEL_VOLUME을 다시
// 보낼 필요 없이(드래그 중 값을 되돌리면 조작감이 끊긴다) 대시보드 상태/표시만 갱신한다.
function handleUserVolumeChange(hash, value) {
  const role = getChannelRole(hash);
  const vol = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));

  if (role === 'main') {
    setMainVolumeForChannel(hash, vol);
  } else {
    setChannelOverride(hash, vol);
  }

  if (volumeSaveDebounceTimer) clearTimeout(volumeSaveDebounceTimer);
  volumeSaveDebounceTimer = setTimeout(saveAudioState, 300);

  // 이 채널을 고정하는 건 이 채널 자신의 출력에만 영향을 준다 — 그룹의
  // dB 기준(가장 조용한 채널)은 실측 오디오 레벨로 정해지지 이 값으로
  // 정해지는 게 아니므로, 같은 그룹의 다른 채널들을 다시 계산할 필요는
  // 없다.
  lastAppliedDisplayVolume[hash] = vol;
  renderAudioSettingsList();
}

function positionAudioSettingsPanel() {
  const btn = document.getElementById('audio-settings-btn');
  const panel = document.getElementById('audio-settings-panel');
  if (!btn || !panel) return;
  const rect = btn.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.left = `${rect.left}px`;
}

function handleAudioPanelOutsideClick(e) {
  const panel = document.getElementById('audio-settings-panel');
  const btn = document.getElementById('audio-settings-btn');
  if (!panel) return;
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeAudioSettingsPanel();
}

// 패널 내용이 max-height를 넘겨 스크롤이 생겨도, 딱 끝에서 잘려 있으면
// "더 있다"는 게 안 보여서 스크롤할 생각을 못 할 수 있다. 실제로 더 볼
// 내용이 남아있을 때만(스크롤이 끝까지 안 내려갔을 때만) 패널에
// has-more-below 클래스를 달아 하단에 그라데이션+화살표 힌트를 보여준다.
let audioPanelScrollObserver = null;

function updateAudioPanelScrollHint() {
  const panel = document.getElementById('audio-settings-panel');
  const scrollBody = panel && panel.querySelector('.audio-settings-scroll-body');
  if (!panel || !scrollBody) return;
  const hasMore = scrollBody.scrollHeight - scrollBody.scrollTop - scrollBody.clientHeight > 2;
  panel.classList.toggle('has-more-below', hasMore);
}

function closeAudioSettingsPanel() {
  const panel = document.getElementById('audio-settings-panel');
  if (panel) panel.remove();
  document.getElementById('audio-settings-btn')?.classList.remove('active');
  document.removeEventListener('click', handleAudioPanelOutsideClick, true);
  window.removeEventListener('resize', positionAudioSettingsPanel);
  if (audioPanelScrollObserver) {
    audioPanelScrollObserver.disconnect();
    audioPanelScrollObserver = null;
  }
}

function openAudioSettingsPanel() {
  const btn = document.getElementById('audio-settings-btn');
  if (!btn) return;

  const panel = document.createElement('div');
  panel.id = 'audio-settings-panel';
  panel.className = 'audio-settings-panel';
  panel.innerHTML = `
    <div class="audio-settings-scroll-body">
      <div class="audio-settings-header">${t('audio.panelTitle', '채널별 오디오')}</div>
      <div id="audio-settings-list" class="audio-settings-list"></div>
      <div id="collab-settings-section" class="collab-settings-section"></div>
    </div>
    <div class="audio-settings-scroll-hint"><span class="audio-settings-scroll-hint-arrow">▾</span></div>
  `;
  document.body.appendChild(panel);

  positionAudioSettingsPanel();
  btn.classList.add('active');
  renderAudioSettingsList();
  renderCollabSettingsSection();

  document.addEventListener('click', handleAudioPanelOutsideClick, true);
  window.addEventListener('resize', positionAudioSettingsPanel);

  // 목록 내용은 슬라이더 조작·dB 갱신·합방 유사도 갱신 등으로 패널을 열어둔
  // 채로도 계속 다시 그려진다 — 매 렌더 호출부를 일일이 붙잡는 대신,
  // 내용 변화 자체를 MutationObserver로 감지해 힌트 상태를 갱신한다.
  panel.querySelector('.audio-settings-scroll-body')?.addEventListener('scroll', updateAudioPanelScrollHint);
  audioPanelScrollObserver = new MutationObserver(() => updateAudioPanelScrollHint());
  audioPanelScrollObserver.observe(panel, { childList: true, subtree: true });
  updateAudioPanelScrollHint();
}

function toggleAudioSettingsPanel() {
  if (document.getElementById('audio-settings-panel')) {
    closeAudioSettingsPanel();
  } else {
    openAudioSettingsPanel();
  }
}

// 메인 볼륨은 채널별로 따로 저장된다(getMainVolumeForChannel) — 그리드/
// 서브처럼 "그룹 공통 기준 음량 + 오버라이드" 이원 구조가 아니라 이
// 채널이 메인일 때 쓸 값 하나뿐이라 "기준 음량" 개념은 여전히 없다.
// 그 외(그리드의 모든 채널, 메인-서브의 서브 채널)는 수동으로 고정한
// 값이 있으면 그 값을, 없으면 기준 음량과 — 그룹 내 다른 채널 때문에
// 실제로는 더 낮게 재생 중이라면 — 실제 재생 음량을 같이 보여준다.
function renderAudioModesStatus(container, hash) {
  container.innerHTML = '';

  if (getChannelRole(hash) === 'main') {
    const mainVolume = getMainVolumeForChannel(hash);
    const mainSpan = document.createElement('span');
    mainSpan.className = 'audio-settings-mode-status active';
    // 오디오 최적화가 꺼져 있으면 "메인"이라는 역할 구분이 그룹 기준 음량과
    // 얽힌 개념이 아니게 되므로 라벨 없이 퍼센트만 보여준다.
    mainSpan.textContent = isAudioOptimizationEnabled()
      ? `${t('audio.roleMain', '메인')} ${mainVolume}%`
      : `${mainVolume}%`;
    container.appendChild(mainSpan);
    return;
  }

  const override = getChannelOverride(hash);
  if (override !== null) {
    const manualSpan = document.createElement('span');
    manualSpan.className = 'audio-settings-mode-status active';
    manualSpan.textContent = `${t('audio.manualLabel', '수동')} ${override}%`;
    container.appendChild(manualSpan);

    const resetBtn = document.createElement('span');
    resetBtn.className = 'audio-settings-mode-reset';
    resetBtn.textContent = t('audio.resetLabel', '자동');
    resetBtn.addEventListener('click', () => {
      clearChannelOverride(hash);
      if (volumeSaveDebounceTimer) clearTimeout(volumeSaveDebounceTimer);
      volumeSaveDebounceTimer = setTimeout(saveAudioState, 300);
      const resetVol = getDisplayVolumeForChannel(hash);
      const realResetVol = getEffectiveVolumeForChannel(hash);
      lastAppliedDisplayVolume[hash] = resetVol;
      lastAppliedRealVolume[hash] = realResetVol;
      postVolumeMessage(hash, realResetVol, true);
      renderAudioSettingsList();
    });
    container.appendChild(resetBtn);
    return;
  }

  // 오디오 최적화가 꺼져 있으면 그룹 기준 음량이라는 개념 자체가 없다
  // (모든 채널이 그냥 100%로 고정) — "기준" 문구 없이 퍼센트만 보여준다.
  if (!isAudioOptimizationEnabled()) {
    const plainSpan = document.createElement('span');
    plainSpan.className = 'audio-settings-mode-status active';
    plainSpan.textContent = `${getDisplayVolumeForChannel(hash)}%`;
    container.appendChild(plainSpan);
    return;
  }

  const baseline = getChannelBaselineVolume(hash);
  // "재생 X%" 라벨도 슬라이더(§buildAudioSettingsItem)와 같은 이유로 같은
  // 해법을 쓴다 — 실제로 마지막에 적용한 값이 있으면 그걸 우선 써서 트림
  // 평균 창이 흔들릴 때마다 이 라벨만 미세하게 왔다갔다하는 걸 막는다.
  const effective = (typeof lastAppliedDisplayVolume[hash] === 'number')
    ? lastAppliedDisplayVolume[hash]
    : getDisplayVolumeForChannel(hash);

  const baseSpan = document.createElement('span');
  baseSpan.className = 'audio-settings-mode-status active';
  baseSpan.textContent = `${t('audio.baselineLabel', '최대')} ${baseline}%`;
  container.appendChild(baseSpan);

  // dB 평준화가 지금 이 순간 얼마나 감쇠 중인지 항상 옆에 회색으로 같이
  // 보여준다 — 기준과 같을 때도(감쇠가 0일 때도) 보여줘야 "지금 감쇠가
  // 안 걸려 있다"는 것 자체를 알 수 있다. 예전엔 기준과 다를 때만
  // 보여줬는데, 그러면 감쇠가 0인지 아직 측정치가 안 왔는지 구분이 안 됐다.
  {
    const sep = document.createElement('span');
    sep.className = 'audio-settings-mode-sep';
    sep.textContent = '→';
    container.appendChild(sep);

    const effSpan = document.createElement('span');
    effSpan.className = 'audio-settings-mode-status';
    effSpan.textContent = `${t('audio.playingLabel', '재생')} ${effective}%`;
    container.appendChild(effSpan);
  }
}

// ── 디버그 모드(§isDebugModeEnabled) — dB 파형/합방 분석 시각화 ──────────
// chrome-extension:// 페이지는 외부 자동화 도구가 콘솔·스크린샷에 접근할
// 수 없어서(크롬이 확장 프로그램끼리 서로의 페이지를 못 보게 막음),
// 실사용 중 문제(엉뚱한 겹침 %, 버튼 반응 지연 등)를 개발자 도구 없이도
// 화면에서 바로 확인할 수 있도록 만든 진단용 패널이다. 실제 볼륨/음소거
// 판정 로직에는 전혀 관여하지 않는다 — 순수 표시 전용.

// 이전엔 "-19.2dB" → "19.2dB"처럼 마이너스만 떼고 절댓값을 보여줬는데,
// 소리가 클수록 숫자가 작아지고 작을수록 커지는 체감과 반대인 표기가
// 됐다("23dB가 5dB보다 조용하다"는 지적) — 고쳤다.
//
// 브라우저는 디지털 신호 크기(LUFS/dBFS)만 잴 수 있고 실제 SPL은 알 수
// 없다. "사실상 무음" 하한(MIN_VALID_REFERENCE_DB, -50)을 0으로 놓고 그보다
// 얼마나 큰지 보여줘서 조용할수록 0에 가깝고 클수록 큰 숫자가 되게 한다.
//
// 볼륨(%)까지 반영한 "체감 음량"은 원본과 다른 하한을 써야 한다 — 버그
// 수정: 같은 하한을 쓰면 서브(25%)처럼 낮은 볼륨으로 재생만 해도
// 20*log10(volPercent/100)만큼 더 내려가 실제로 들리는 채널이 "사실상
// 무음"으로 오표기됐다. 최저 음량(1%)까지 반영한 최악의 경우(-40dB)까지
// 담을 수 있는 더 낮은 하한을 따로 둔다.
const MIN_VALID_EFFECTIVE_DB = MIN_VALID_REFERENCE_DB + 20 * Math.log10(1 / 100);

function formatDebugDb(db, floor = MIN_VALID_REFERENCE_DB) {
  return `${Math.max(0, db - floor).toFixed(1)}dB`;
}

// values: 숫자(또는 구멍 표시용 null/undefined) 배열. min/max 생략 시
// 배열 자체의 최소/최대로 자동 스케일한다(절대 dB값보다 "모양"이 중요).
// opts.series: [{ values, color }, ...]를 넘기면 같은 축 위에 여러 선을
// 겹쳐 그린다(예: leveling에 실제 쓰이는 dB와 합방용 음성대역 dB를 같이
// 비교 — §renderChannelDebugPanel). 넘기면 두 번째 인자(values)는 무시된다.
function drawDebugSparkline(canvas, values, opts) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const seriesList = (opts && Array.isArray(opts.series) && opts.series.length > 0)
    ? opts.series
    : [{ values: values || [], color: (opts && opts.color) || '#FFC800' }];

  const allNums = seriesList.reduce((acc, s) => {
    s.values.forEach((v) => { if (typeof v === 'number' && isFinite(v)) acc.push(v); });
    return acc;
  }, []);
  if (allNums.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px sans-serif';
    ctx.fillText(t('audio.debugDataNotReady', 'data not ready'), 4, h / 2 + 3);
    return;
  }
  const min = (opts && typeof opts.min === 'number') ? opts.min : Math.min(...allNums);
  const max = (opts && typeof opts.max === 'number') ? opts.max : Math.max(...allNums);
  const range = (max - min) || 1;

  // opts.gridLines: 채널마다 자기 min/max로 스케일하면(기본 동작) 그래프
  // 모양은 보이지만 절대 음량은 비교할 수 없다(항상 -40dB인 채널과
  // -10dB인 채널이 같은 물결로 보임). opts.min/max를 고정값으로 넘긴
  // 호출은 옅은 기준선과 숫자를 왼쪽에 함께 그려 절대 음량을 비교 가능하게 한다.
  if (opts && Array.isArray(opts.gridLines) && opts.gridLines.length > 0) {
    ctx.font = '8px sans-serif';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    opts.gridLines.forEach((db) => {
      if (db < min || db > max) return;
      const y = h - ((db - min) / range) * (h - 2) - 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      const labelY = Math.max(8, Math.min(h - 2, y - 1));
      // formatDebugDb와 같은 규칙(하한을 0으로 놓고 그 위로 얼마나 큰지)으로
      // 라벨을 매긴다. 축 눈금은 정수로 충분해 여기서 직접 반올림한다.
      // 버그 수정: 이 하한을 MIN_VALID_REFERENCE_DB로 고정했었는데,
      // 텍스트 라벨(§dbEffectiveLabel)은 더 낮은 하한(MIN_VALID_EFFECTIVE_DB)을
      // 써서 같은 빨간 선인데 눈금과 텍스트 숫자가 서로 어긋나 보였다 —
      // opts.labelFloor로 호출 쪽이 실제 축 범위와 같은 하한을 넘기게 한다.
      const labelFloor = (opts && typeof opts.labelFloor === 'number') ? opts.labelFloor : MIN_VALID_REFERENCE_DB;
      ctx.fillText(`${Math.round(db - labelFloor)}dB`, 2, labelY);
    });
  }

  seriesList.forEach((series) => {
    ctx.strokeStyle = series.color || '#FFC800';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    const n = series.values.length;
    series.values.forEach((v, i) => {
      const x = n > 1 ? (i / (n - 1)) * w : 0;
      if (typeof v !== 'number' || !isFinite(v)) { started = false; return; }
      // 버그 수정: min~max 범위 밖 값을 그대로 좌표로 환산하면 캔버스
      // 바깥으로 나가 안 그려진 것처럼 보인다("파형이 안 보인다" 오해).
      // min/max로 클램프해 범위 밖 값도 가장자리에 납작한 선으로 보이게 한다.
      const clamped = Math.min(max, Math.max(min, v));
      const y = h - ((clamped - min) / range) * (h - 2) - 1;
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
  });
}

// perLagCorr: computeCollabSimilarity가 스무딩 전에 저장해둔 13개 lag별
// 원본 상관계수(-1~1, 표본 부족 시 null). 0을 중앙에 두고 위/아래로
// 막대를 그린다 — 진짜 지연 상관이면 이웃 lag들도 같이 솟아 있어야
// 하고(§docs/collab-architecture.md §8.5), 한 칸만 고립되어 튄 값은
// 통계적 우연일 가능성이 높다는 걸 눈으로 바로 확인할 수 있다.
function drawDebugLagBars(canvas, perLagCorr) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = perLagCorr.length;
  if (n === 0) return;
  const zeroY = h / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(w, zeroY);
  ctx.stroke();
  const barW = w / n;
  perLagCorr.forEach((v, i) => {
    if (typeof v !== 'number' || !isFinite(v)) return;
    const clamped = Math.max(-1, Math.min(1, v));
    const barH = Math.abs(clamped) * (h / 2 - 1);
    const x = i * barW + 1;
    const bw = Math.max(1, barW - 2);
    ctx.fillStyle = clamped >= 0 ? 'rgba(120, 200, 255, 0.8)' : 'rgba(255, 120, 120, 0.8)';
    ctx.fillRect(x, clamped >= 0 ? zeroY - barH : zeroY, bw, barH);
  });
}

// AI 음성 감지(Silero VAD, §10) 프레임별 발화 확률(0~1)을 막대로 그린다.
// threshold 이상(=말하는 중으로 판정)은 초록, 미만은 회색 — 실제 마스킹에
// 쓰이는 것과 같은 기준(VAD_SPEECH_THRESHOLD)이라 여기 초록 구간이 곧
// Stage 2 비교에 실제로 쓰이는 구간이다.
function drawDebugProbBars(canvas, probs, threshold) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = probs.length;
  if (n === 0) return;
  const thresholdY = h * (1 - threshold);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, thresholdY);
  ctx.lineTo(w, thresholdY);
  ctx.stroke();
  ctx.setLineDash([]);
  const barW = w / n;
  for (let i = 0; i < n; i++) {
    const p = Math.max(0, Math.min(1, probs[i]));
    const barH = p * h;
    const x = i * barW + 1;
    const bw = Math.max(1, barW - 2);
    ctx.fillStyle = p >= threshold ? 'rgba(0, 255, 163, 0.8)' : 'rgba(255,255,255,0.25)';
    ctx.fillRect(x, h - barH, bw, barH);
  }
}

// 채널 하나의 디버그 정보(dB 파형 + 합방 그룹 소속이면 Stage1/Stage2
// 분석까지)를 container 안에 그린다. renderAudioSettingsList가 오디오
// 레벨 갱신마다 다시 호출되므로 별도 폴링 없이 자연스럽게 최신 상태로
// 갱신된다.
const DEBUG_CANVAS_WIDTH = 340; // .audio-debug-section 고정 폭(340px, dashboard.css)과 맞춤 — 가로 배치 시 그래프 폭이 전부 동일하게 보이도록.
const DEBUG_CANVAS_HEIGHT = 70; // .audio-debug-canvas 높이(70px, dashboard.css)와 맞춤 — 그래프를 더 크게 봐달라는 요청으로 40에서 키움.

// title(굵게, 이 그래프가 "무엇"인지) + desc(연하게, "왜/어떻게 쓰이는지"
// 한 줄 설명)를 section에 붙인다 — 그래프마다 반복되는 패턴이라 헬퍼로 뺐다.
function appendDebugSectionHeader(section, title, desc) {
  const titleEl = document.createElement('div');
  titleEl.className = 'audio-debug-title';
  titleEl.textContent = title;
  section.appendChild(titleEl);
  if (desc) {
    const descEl = document.createElement('div');
    descEl.className = 'audio-debug-desc';
    descEl.textContent = desc;
    section.appendChild(descEl);
  }
}

function renderChannelDebugPanel(container, hash) {
  container.innerHTML = '';
  container.className = 'audio-debug-panel';

  // VAD/Stage1/Stage2 섹션은 조건(AI 음성 감지 on/off, 관여한 쌍 유무)에
  // 따라 나타났다 안 나타났다 하므로, 번호를 고정 상수로 박아두면 어떤
  // 조합에서는 번호가 건너뛰어 보인다(예: VAD 꺼짐이면 ①③④처럼) — 실제로
  // 렌더링되는 순서대로 매기는 카운터를 쓴다.
  const CIRCLED_DIGITS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  let sectionNo = 1;
  const nextSectionMark = () => CIRCLED_DIGITS[sectionNo++ - 1] || `(${sectionNo - 1})`;

  const history = debugDbHistory[hash] || [];
  const dbSection = document.createElement('div');
  dbSection.className = 'audio-debug-section';
  appendDebugSectionHeader(
    dbSection,
    t('audio.debugDbTitleTemplate', '{mark} 채널 음량(dB) 파형', { mark: nextSectionMark() }),
    t('audio.debugDbDesc', '이 채널의 음량이 시간에 따라 어떻게 움직이는지 — 아래 모든 판정의 원본 신호입니다.')
  );
  // levelDb: §3.4 dB 평준화(실제 재생 볼륨 계산)에 쓰이는 전체 대역 값 —
  // "메인이 서브보다 왜 작게 들리는지" 같은 걸 확인하려면 이 숫자를 봐야
  // 한다. db(voiceDb 기반): 합방 겹침 판정 전용 음성대역 값으로, 참고용
  // 비교 대상일 뿐 실제 볼륨 계산에는 안 쓰인다(§collab-architecture.md §9).
  const latest = history.length ? history[history.length - 1] : null;
  const latestLevelDb = latest && typeof latest.levelDb === 'number' ? latest.levelDb : null;
  const latestVoiceDb = latest && typeof latest.db === 'number' ? latest.db : null;
  const spanSec = history.length > 1 ? ((history[history.length - 1].t - history[0].t) / 1000).toFixed(1) : '0';
  const dbLabel = document.createElement('div');
  dbLabel.className = 'audio-debug-label';
  dbLabel.textContent = t('audio.debugSamplesTemplate', '{count}개 샘플, {sec}초 범위', { count: history.length, sec: spanSec })
    + (typeof latestLevelDb === 'number' ? t('audio.debugLatestSuffixTemplate', ' — 최신 {value}', { value: formatDebugDb(latestLevelDb) }) : '');
  dbSection.appendChild(dbLabel);
  const dbLegend = document.createElement('div');
  dbLegend.className = 'audio-debug-label';
  dbLegend.textContent = t('audio.debugDbLegendTemplate', '노랑: 실제 재생 볼륨 계산에 쓰이는 값 / 파랑: 합방 판정용 음성대역 값(참고용){voiceValue} / 빨강: 재생 볼륨(%)까지 반영해 실제로 들리는 크기', {
    voiceValue: typeof latestVoiceDb === 'number' ? t('audio.debugDbLegendVoiceSuffixTemplate', ' (최신 {value})', { value: formatDebugDb(latestVoiceDb) }) : ''
  });
  dbSection.appendChild(dbLegend);
  // 위 그래프/라벨은 "원본 방송 자체가 얼마나 큰가"(gainNode 이전 신호)만
  // 잰다. 실제 체감 음량은 여기에 재생 볼륨(%)까지 곱해진 값이라, 원본
  // dB가 같아도 재생 볼륨이 다르면 들리는 크기가 크게 달라진다 — "표기상
  // dB 차이는 안 나는데 왜 다르게 들리나"에 답하기 위해 지금 볼륨까지
  // 반영한 체감 음량을 따로 계산해 보여준다.
  //
  // getDisplayVolumeForChannel(hash)는 "다시 계산하면 나올 목표 볼륨"이라,
  // ±25%p 스텝 제한으로 아직 목표까지 못 따라간 상태에선 실제로 보낸 값과
  // 다를 수 있다 — 마지막 적용값이 있으면 그걸 우선 쓴다.
  const currentVolumePercent = (typeof lastAppliedDisplayVolume[hash] === 'number')
    ? lastAppliedDisplayVolume[hash]
    : getDisplayVolumeForChannel(hash);
  const effectiveDb = (typeof latestLevelDb === 'number' && currentVolumePercent > 0)
    ? latestLevelDb + 20 * Math.log10(currentVolumePercent / 100)
    : null;
  const dbEffectiveLabel = document.createElement('div');
  dbEffectiveLabel.className = 'audio-debug-label';
  dbEffectiveLabel.textContent = t('audio.debugEffectiveDbTemplate', '지금 재생 볼륨({volume}%) 반영 시 체감 음량: {value}', {
    volume: currentVolumePercent,
    value: effectiveDb !== null ? formatDebugDb(effectiveDb, MIN_VALID_EFFECTIVE_DB) : t('audio.debugStage1ValueNone', '아직 없음')
  });
  dbSection.appendChild(dbEffectiveLabel);
  // 빨강: 위 "체감 음량" 요약을 시계열 전체로 넓힌 것 — 각 샘플의
  // volPercent(pushDebugDbHistory가 같이 기록)를 그 샘플의 levelDb에
  // 곱해(로그 스케일이라 20*log10 덧셈) "그 순간 실제로 들렸을 크기"를
  // 재구성한다. 지금 볼륨 하나로 과거 전체를 계산하면 볼륨이 바뀐 구간이 왜곡된다.
  const effectiveDbSeries = history.map((s) => {
    if (typeof s.levelDb !== 'number' || !(s.volPercent > 0)) return null;
    return s.levelDb + 20 * Math.log10(s.volPercent / 100);
  });
  const dbCanvas = document.createElement('canvas');
  dbCanvas.width = DEBUG_CANVAS_WIDTH;
  dbCanvas.height = DEBUG_CANVAS_HEIGHT;
  dbCanvas.className = 'audio-debug-canvas';
  dbSection.appendChild(dbCanvas);
  container.appendChild(dbSection);
  // 채널마다 자기 min/max로 스케일하지 않고 고정 범위를 써서 채널 간 실제
  // 음량 차이가 눈에 보이게 한다. 버그 수정: 하한을 MIN_VALID_REFERENCE_DB로
  // 잡았었는데, 빨간 선(체감 음량)은 볼륨까지 반영돼 그보다 낮게 내려갈
  // 수 있어 볼륨이 많이 깎인 채널은 그래프 맨 아래에 눌리고 텍스트 라벨과
  // 다른 값처럼 보였다. 하한을 MIN_VALID_EFFECTIVE_DB로 넓혀 텍스트 라벨과
  // 같은 기준을 쓰게 한다(labelFloor로 눈금도 맞춤). 노랑/파랑은 정의상
  // MIN_VALID_REFERENCE_DB 밑으로 안 내려가 그래프 위쪽에만 나타나고,
  // 세 선이 같은 축을 공유해야 비교가 되므로 빨간 선만 별도 축으로 늘리지 않는다.
  drawDebugSparkline(dbCanvas, null, {
    min: MIN_VALID_EFFECTIVE_DB,
    max: 0,
    labelFloor: MIN_VALID_EFFECTIVE_DB,
    gridLines: [0, MIN_VALID_EFFECTIVE_DB / 2, MIN_VALID_EFFECTIVE_DB],
    series: [
      { values: history.map((s) => s.levelDb), color: '#FFC800' },
      { values: history.map((s) => s.db), color: 'rgba(120, 200, 255, 0.85)' },
      { values: effectiveDbSeries, color: '#FF4D4D' }
    ]
  });

  const group = findCollabGroupForChannel(hash);
  if (!isCollabSettingEnabled() || !group) return;

  // 지금 이 채널이 겹침 클러스터에 묶여 있으면(§getGroupClusters) 누구와
  // 묶였는지, 그중 누가 계속 들리는 채널(keeper)인지 한 줄로 보여준다 —
  // docs/collab-latency-architecture.md §2 "디버그 패널에는 표시" 요구사항.
  const myCluster = getGroupClusters(group).find((c) => c.includes(hash));
  if (myCluster && myCluster.length >= 2) {
    const keeperHash = myCluster.find((h) => !collabMutedHashes.has(h)) || null;
    const clusterLabel = document.createElement('div');
    clusterLabel.className = 'audio-debug-label';
    clusterLabel.textContent = t('audio.debugClusterTemplate', '지금 {members}와 겹침으로 묶임 / 유지 채널: {keeper}', {
      members: myCluster.filter((h) => h !== hash).map(getChannelNameByHash).join(', '),
      keeper: keeperHash ? getChannelNameByHash(keeperHash) : t('audio.debugStage1ValueNone', '아직 없음')
    });
    container.appendChild(clusterLabel);
  }

  // 자기 자신의 VAD 발화 확률 그래프 — 이제 특정 "리더" 카드에만 뜨는 게
  // 아니라, VAD가 실행된 모든 채널이 자기 카드에 자기 발화 확률을 보여준다
  // (§10 일반화, 쌍 양쪽 다 VAD를 돌리므로).
  if (mySetting.collabVadEnabled) {
    const vadSection = document.createElement('div');
    vadSection.className = 'audio-debug-section';
    appendDebugSectionHeader(
      vadSection,
      t('audio.debugVadTitleTemplate', '{mark} 말소리 감지(AI 음성 활동 검출)', { mark: nextSectionMark() }),
      t('audio.debugVadDesc', '이 채널이 실제로 말하고 있다고 판단된 구간(초록)만 다른 채널과의 겹침 비교에 쓰입니다.')
    );
    const vadInfo = collabVadDebugByHash[hash];
    const vadLabel = document.createElement('div');
    vadLabel.className = 'audio-debug-label';
    if (vadState !== 'ready') {
      vadLabel.textContent = vadState === 'loading'
        ? t('audio.debugVadLoading', '모델 로딩 중 — 그동안은 마스킹 없이 비교합니다.')
        : t('audio.debugVadUnavailable', '사용 불가 — 마스킹 없이 비교합니다.');
      vadSection.appendChild(vadLabel);
    } else if (vadInfo) {
      const vadCanvas = document.createElement('canvas');
      vadCanvas.width = DEBUG_CANVAS_WIDTH;
      vadCanvas.height = DEBUG_CANVAS_HEIGHT;
      vadCanvas.className = 'audio-debug-canvas';
      vadSection.appendChild(vadCanvas);
      drawDebugProbBars(vadCanvas, vadInfo.probs, VAD_SPEECH_THRESHOLD);
      const ageSec = ((Date.now() - vadInfo.at) / 1000).toFixed(1);
      vadLabel.textContent = t('audio.debugVadStatsTemplate', '발화 구간 비율 {ratio}% (기준 {threshold}% 확률 이상) / {age}초 전 계산', {
        ratio: (vadInfo.activeRatio * 100).toFixed(0),
        threshold: Math.round(VAD_SPEECH_THRESHOLD * 100),
        age: ageSec
      });
      vadSection.appendChild(vadLabel);
    } else {
      vadLabel.textContent = t('audio.debugVadPending', '아직 측정 전(합방 후보 쌍이 생기면 계산됩니다)');
      vadSection.appendChild(vadLabel);
    }
    container.appendChild(vadSection);
  }

  // Stage1/2는 이 채널이 관여한 쌍 중 지금 가장 강한(유사도가 가장 높은)
  // 쌍 하나를 대표로 보여준다 — 전체 쌍 비교로 바뀌면서 채널 하나가 여러
  // 관계를 가질 수 있게 됐지만, 카드 하나에 전부 나열하면 산만해지므로
  // "지금 가장 관련 있어 보이는 상대"만 요약한다.
  const strongest = getStrongestPairForHash(hash);
  if (!strongest) return;
  const { partner, key } = strongest;
  const partnerName = getChannelNameByHash(partner);

  const corrSection = document.createElement('div');
  corrSection.className = 'audio-debug-section';
  appendDebugSectionHeader(
    corrSection,
    t('audio.debugStage1TitleTemplate', '{mark} 1차 신호: {partner} 채널과의 겹침 패턴 상관관계', { mark: nextSectionMark(), partner: partnerName }),
    t('audio.debugStage1Desc', '겹치는 다른 채널과 음량이 같이 커지고 작아지는 정도를 시간차(lag)별로 비교합니다 — 아직 "같은 소리"인지는 확인 전입니다.')
  );
  const perLagCorr = collabDebugLagCorrByPair[key] || [];
  const smoothed = collabPairSimilarity[key];
  const corrLabel = document.createElement('div');
  corrLabel.className = 'audio-debug-label';
  corrLabel.textContent = t('audio.debugStage1ValueTemplate', '최종 겹침 % 계산에 쓰는 값: {value}', {
    value: typeof smoothed === 'number' ? (smoothed * 100).toFixed(1) + '%' : t('audio.debugStage1ValueNone', '아직 없음')
  });
  const corrCanvas = document.createElement('canvas');
  corrCanvas.width = DEBUG_CANVAS_WIDTH;
  corrCanvas.height = DEBUG_CANVAS_HEIGHT;
  corrCanvas.className = 'audio-debug-canvas';
  corrSection.appendChild(corrCanvas);
  corrSection.appendChild(corrLabel);
  container.appendChild(corrSection);
  drawDebugLagBars(corrCanvas, perLagCorr);

  // Stage2(파형 GCC-PHAT)의 최종 판정을 badge와 같은 문구("같은 소리
  // 확인됨"/"다른 소리로 판단")로 보여준다 — 숫자(파형 유사도 %)만
  // 보여주면 매번 COLLAB_WAVEFORM_MATCH_THRESHOLD와 직접 비교해야 해서,
  // 실제로 어느 쪽으로 판정됐는지 한눈에 보이게 한다.
  const wavSection = document.createElement('div');
  wavSection.className = 'audio-debug-section';
  appendDebugSectionHeader(
    wavSection,
    t('audio.debugStage2TitleTemplate', '{mark} 2차 신호: {partner} 채널과 파형 최종 확인', { mark: nextSectionMark(), partner: partnerName }),
    t('audio.debugStage2Desc', '1차 신호로 후보가 된 쌍만 실제 파형을 비교해 "진짜 같은 소리"인지 최종 확인합니다 — 이 결과가 실제 음소거 여부를 결정합니다.')
  );
  const waveVerdict = document.createElement('div');
  waveVerdict.className = 'audio-debug-verdict';
  const waveLabel = document.createElement('div');
  waveLabel.className = 'audio-debug-label';
  // getWaveformVerdict는 배지·실제 음소거 판정과 같은 판정 함수다 — 예전엔
  // 여기서 fresh 여부를 확인 안 하고 값이 "있기만 하면" 보여줘서, 캡처
  // 재시작 후 오래된 값으로 "다른 소리"를 계속 보여주는 버그가 있었다.
  // 판정 함수를 공유해 항상 같은 상태를 보여준다.
  const verdict = getWaveformVerdict(hash, partner);
  if (verdict.state === 'unavailable') {
    waveVerdict.textContent = t('audio.collabWaveformUnavailableLabel', '파형 분석 불가');
    waveVerdict.classList.add('unavailable');
    waveLabel.textContent = t('audio.debugWaveformUnavailableDesc', '이 채널은 워클릿을 못 써서(구형 브라우저 등) 1차 신호만으로 판정합니다.');
  } else if (verdict.state === 'match' || verdict.state === 'different') {
    const waveform = verdict.waveform;
    waveVerdict.textContent = verdict.state === 'match'
      ? t('audio.collabWaveformMatchLabel', '같은 소리 확인됨')
      : t('audio.collabWaveformDifferentLabel', '다른 소리로 판단');
    waveVerdict.classList.add(verdict.state);
    const ageSec = ((Date.now() - waveform.at) / 1000).toFixed(1);
    const computeStr = typeof waveform.computeMs === 'number' ? `${waveform.computeMs.toFixed(1)}ms` : '?';
    waveLabel.textContent = t('audio.debugWaveformStatsTemplate', '유사도 {score}% (기준 {threshold}%) / lag {lag}s / {age}초 전 계산({compute})', {
      score: (waveform.score * 100).toFixed(1),
      threshold: Math.round(COLLAB_WAVEFORM_MATCH_THRESHOLD * 100),
      lag: waveform.lagSec.toFixed(2),
      age: ageSec,
      compute: computeStr
    });
  } else if (verdict.state === 'grace') {
    waveVerdict.textContent = t('audio.collabWaveformGraceLabel', '이전 확인 유지 중');
    waveVerdict.classList.add('grace');
    const graceAgeSec = ((Date.now() - verdict.lastConfirmedAt) / 1000).toFixed(1);
    waveLabel.textContent = t('audio.debugWaveformGraceDescTemplate', '{age}초 전 마지막으로 같은 소리로 확인됨 — 말소리가 없어 파형을 다시 확인하는 중이라(유예 최대 {grace}초) 그때까지는 이전 판정(음소거)을 유지합니다.', {
      age: graceAgeSec,
      grace: (COLLAB_WAVEFORM_CONFIRM_GRACE_MS / 1000).toFixed(0)
    });
  } else {
    waveVerdict.textContent = t('audio.collabWaveformPendingLabel', '파형 확인 중');
    waveVerdict.classList.add('pending');
    waveLabel.textContent = t('audio.debugWaveformPendingDesc', '아직 측정 전(캡처 워밍업 중이거나 아직 후보가 아님)');
  }
  wavSection.appendChild(waveVerdict);
  wavSection.appendChild(waveLabel);
  container.appendChild(wavSection);

  if (mySetting.collabVadEnabled) {
    const vadNoteLabel = document.createElement('div');
    vadNoteLabel.className = 'audio-debug-label';
    vadNoteLabel.textContent = vadState === 'ready'
      ? t('audio.debugVadNoteReady', 'AI 음성 감지: 사용 중 — 위 ③·④ 계산 모두 두 채널 중 하나라도 말하는 구간만 사용')
      : vadState === 'loading'
        ? t('audio.debugVadNoteLoading', 'AI 음성 감지: 모델 로딩 중(그동안은 마스킹 없이 비교)')
        : t('audio.debugVadNoteUnavailable', 'AI 음성 감지: 사용 불가(마스킹 없이 비교)');
    container.appendChild(vadNoteLabel);
  }
}

// 디버그 패널은 채널별 오디오 패널 안에 끼워 넣지 않고, 독립된 떠있는
// 창으로 띄운다 — 오디오 패널을 열지 않아도(또는 다른 걸 조작하면서
// 동시에) 항상 볼 수 있고, chrome-extension:// 페이지라 외부 개발자
// 도구가 못 들어오는 상황에서도 이 창 하나로 상태를 확인할 수 있다.
let debugPanelEl = null;
let debugPanelRefreshTimer = null;
const DEBUG_PANEL_REFRESH_MS = 200; // content.js LEVEL_REPORT_INTERVAL_MS와 맞춰 새 샘플 나오는 대로 다시 그림
// 뜨는 그래프 창의 "×"만 눌러서 창을 치웠을 때 — 예전엔 이게
// mySetting.debugMode 자체를 꺼버려서, 창(그래프)만 안 보고 싶었던
// 사용자가 다른 곳(합방 그룹 카드의 "VOD 싱크 디버그" 버튼 등,
// isDebugModeEnabled()에 같이 의존)까지 전부 꺼지는 부작용을 겪었다
// (사용자 요청으로 수정). "창을 닫음"과 "디버그 모드 자체를 끔"을
// 분리한다 — 이 플래그가 true인 동안은 debugMode가 켜져 있어도 창만
// 숨긴다. 설정 화면에서 디버그 모드를 다시 켜면(명시적 재활성화) 이
// 창도 다시 보이도록 리셋한다(§debugModeToggle 핸들러).
let debugPanelManuallyClosed = false;

function makeDebugPanelDraggable(panel, handle) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.debug-panel-close')) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const maxLeft = window.innerWidth - panel.offsetWidth;
    const maxTop = window.innerHeight - panel.offsetHeight;
    panel.style.left = `${Math.min(Math.max(0, e.clientX - offsetX), Math.max(0, maxLeft))}px`;
    panel.style.top = `${Math.min(Math.max(0, e.clientY - offsetY), Math.max(0, maxTop))}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

function ensureDebugPanel() {
  if (debugPanelEl) return debugPanelEl;
  const panel = document.createElement('div');
  panel.id = 'cheese-debug-panel';
  panel.innerHTML = `
    <div class="debug-panel-header">
      <span class="debug-panel-title">${t('audio.debugPanelTitle', 'CHEESE EYES 디버그')}</span>
      <button type="button" class="debug-panel-close" title="${t('audio.debugPanelClose', '닫기')}">×</button>
    </div>
    <div class="debug-panel-body"></div>
  `;
  document.body.appendChild(panel);
  // 오른쪽 고정 앵커(CSS의 right:16px)를 그대로 두고 크기 조절(resize:both)
  // 핸들을 끌면, 오른쪽 변은 그 자리에 고정된 채 왼쪽 변만 반대로 밀려나
  // "오른쪽 아래로 끄는데 왼쪽으로 커지는" 것처럼 보인다 — 생성 직후 현재
  // 위치를 left/top 절대값으로 고정해 right 앵커를 떼어내면, 화면상 위치는
  // 그대로 두면서 이후 크기 조절이 마우스를 끄는 방향(오른쪽 아래)으로
  // 자연스럽게 확장된다.
  const initialRect = panel.getBoundingClientRect();
  panel.style.left = `${initialRect.left}px`;
  panel.style.top = `${initialRect.top}px`;
  panel.style.right = 'auto';
  panel.querySelector('.debug-panel-close').addEventListener('click', () => {
    // 디버그 모드 자체는 그대로 둔다 — 창(그래프)만 치운다(§위 주석).
    debugPanelManuallyClosed = true;
    updateDebugPanelVisibility();
  });
  makeDebugPanelDraggable(panel, panel.querySelector('.debug-panel-header'));
  debugPanelEl = panel;
  return panel;
}

// 방종 VOD 디버그 섹션 — 실제 방송 종료를 기다리지 않고 "방송 종료
// 시뮬레이션" 토글로 다시보기 패널을 테스트할 수 있게 한다. 토글 on은
// 실사용 경로(showVodPickerForChannel)를 그대로 타고, debugForcedEndedHashes에
// 있는 동안은 pollLiveStatusAndAutoRemove가 실제 라이브 상태를 재조회하지
// 않아 패널이 곧바로 도로 걷히지 않는다.
//
// "체크박스 클릭이 안 되는 것 같다" 리포트로 두 가지를 분리했다:
// 1) 체크박스 DOM을 매 틱(200ms) 새로 만들지 않고, 있으면 재사용(상태만
//    갱신)한다 — 그래야 클릭 직후 다음 틱에 리스너가 날아가지 않는다.
// 2) 체크박스(사용자 의도)와 "실제 상태"(타일 존재 여부, 패널 표시 여부)를
//    별도 줄로 나눠 "클릭이 안 먹었다"와 "클릭은 됐는데 뒤에서 실패했다"를 구분한다.
function renderVodDebugSection(container, ch) {
  const supported = ch.platform === 'chzzk' && !ch.isVod;
  const forced = debugForcedEndedHashes.has(ch.hash);

  let checkbox = container.querySelector('.vod-debug-toggle-input');
  let status, effect;
  if (!checkbox) {
    container.innerHTML = '';
    container.className = 'vod-debug-section';

    const toggleRow = document.createElement('label');
    toggleRow.className = 'vod-debug-toggle-row';
    checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'vod-debug-toggle-input';
    toggleRow.appendChild(checkbox);
    const toggleLabel = document.createElement('span');
    toggleLabel.textContent = t('audio.vodDebugToggleLabel', '방송 종료 시뮬레이션');
    toggleRow.appendChild(toggleLabel);
    container.appendChild(toggleRow);

    status = document.createElement('div');
    status.className = 'audio-debug-label vod-debug-status';
    container.appendChild(status);

    effect = document.createElement('div');
    effect.className = 'audio-debug-label vod-debug-effect';
    container.appendChild(effect);

    // ch는 이 컨테이너가 처음 만들어질 때의 채널 객체를 클로저로 들고
    // 있는다 — displayChannels 안의 같은 객체를 매 틱 새로 넘겨받으므로
    // (hash가 바뀌지 않는 한) 최신 name/title도 그대로 반영된다.
    checkbox.addEventListener('change', () => {
      simulateBroadcastEnded(ch, checkbox.checked);
    });
  } else {
    status = container.querySelector('.vod-debug-status');
    effect = container.querySelector('.vod-debug-effect');
  }

  checkbox.checked = forced;
  checkbox.disabled = !supported;

  if (!supported) {
    status.textContent = t('audio.vodDebugUnsupported', '치지직 라이브 채널만 테스트할 수 있습니다(VOD 자체/다른 플랫폼 제외).');
  } else if (forced) {
    status.textContent = vodPickerShownByHash[ch.hash]
      ? t('audio.vodDebugStatusShown', '시뮬레이션 중 — 다시보기 패널이 실제 라이브 상태와 무관하게 유지됩니다.')
      : t('audio.vodDebugStatusLoading', '다시보기 목록을 조회하는 중...');
  } else {
    status.textContent = t('audio.vodDebugStatusOff', '켜면 이 채널을 즉시 "방송 종료" 상태로 만들어 다시보기 패널을 띄웁니다.');
  }

  // "실제 상태" — 체크박스(의도)와 별개로, 지금 그 채널 타일에 실제로
  // 무슨 일이 벌어졌는지를 videoWrapperMap/DOM에서 직접 읽어 보여준다.
  const wrapper = videoWrapperMap.get(ch.hash);
  if (!wrapper) {
    effect.textContent = t('audio.vodDebugEffectNoTile', '실제 상태: 이 채널의 화면 타일을 찾을 수 없음(그리드에 그려지지 않음)');
  } else {
    const panelVisible = wrapper.classList.contains('vod-picker-active')
      && !!wrapper.querySelector('.vod-picker-panel.visible');
    effect.textContent = panelVisible
      ? t('audio.vodDebugEffectShown', '실제 상태: 다시보기 패널 표시 중')
      : t('audio.vodDebugEffectHidden', '실제 상태: 라이브 화면(패널 없음)');
  }
}

// 채널 hash별로 디버그 패널의 행 DOM을 재사용한다 — 매 200ms 틱마다
// body.innerHTML을 통째로 비우고 다시 만들면 그 안의 방종 VOD 디버그
// 체크박스도 매번 새 엘리먼트로 바뀌어(리스너까지 포함) 사실상 "클릭
// 직후 다음 틱에 원상태로 보이는" 것처럼 느껴질 수 있다. 오디오 디버그
// 섹션(캔버스 그래프)은 여전히 매 틱 다시 그려야 하지만, 그 컨테이너
// 자체(row, 하위 div들)는 고정해 둔다.
const debugPanelRowByHash = new Map();

function getOrCreateDebugPanelRow(ch) {
  let entry = debugPanelRowByHash.get(ch.hash);
  if (!entry) {
    const row = document.createElement('div');
    row.className = 'debug-panel-channel';

    const nameEl = document.createElement('div');
    nameEl.className = 'debug-panel-channel-name';
    row.appendChild(nameEl);

    const audioTitle = document.createElement('div');
    audioTitle.className = 'debug-subsection-title';
    audioTitle.textContent = t('audio.debugAudioSectionTitle', '오디오 디버그');
    row.appendChild(audioTitle);
    const debugEl = document.createElement('div');
    row.appendChild(debugEl);

    const vodTitle = document.createElement('div');
    vodTitle.className = 'debug-subsection-title';
    vodTitle.textContent = t('audio.debugVodSectionTitle', '방종 VOD 디버그');
    row.appendChild(vodTitle);
    const vodDebugEl = document.createElement('div');
    row.appendChild(vodDebugEl);

    entry = { row, nameEl, audioTitle, debugEl, vodTitle, vodDebugEl };
    debugPanelRowByHash.set(ch.hash, entry);
  }
  return entry;
}

function renderDebugPanel() {
  if (!debugPanelEl || debugPanelEl.hidden) return;
  const body = debugPanelEl.querySelector('.debug-panel-body');
  if (!displayChannels || displayChannels.length === 0) {
    body.innerHTML = `<div class="audio-debug-label">${t('audio.debugPanelNoChannels', '채널이 없습니다.')}</div>`;
    debugPanelRowByHash.clear();
    return;
  }

  // 더 이상 그리드에 없는 채널의 행은 정리한다.
  const liveHashes = new Set(displayChannels.map(c => c.hash));
  for (const hash of [...debugPanelRowByHash.keys()]) {
    if (liveHashes.has(hash)) continue;
    debugPanelRowByHash.get(hash).row.remove();
    debugPanelRowByHash.delete(hash);
  }

  displayChannels.forEach((ch, index) => {
    const entry = getOrCreateDebugPanelRow(ch);
    entry.nameEl.style.color = getPlatformColor(ch.platform);
    entry.nameEl.textContent = `${ch.name} (${getChannelRole(ch.hash)})`;

    // 두 섹션 모두 "설정 > 디버그"의 하위 스위치로 각자 켜고 끌 수 있다
    // (실험실의 "실험적 기능" → 하위 기능 목록과 같은 구조).
    const audioOn = isAudioDebugSectionEnabled();
    entry.audioTitle.hidden = !audioOn;
    entry.debugEl.hidden = !audioOn;
    if (audioOn) {
      renderChannelDebugPanel(entry.debugEl, ch.hash);
    } else {
      entry.debugEl.innerHTML = '';
    }

    const vodOn = isVodDebugSectionEnabled();
    entry.vodTitle.hidden = !vodOn;
    entry.vodDebugEl.hidden = !vodOn;
    if (vodOn) {
      renderVodDebugSection(entry.vodDebugEl, ch);
    } else {
      entry.vodDebugEl.innerHTML = '';
    }

    // body 안 정렬 순서를 채널 순서와 맞춘다(정렬 자체가 바뀌는 경우는
    // 드물어 대부분 no-op — appendChild는 이미 그 위치에 있으면 이동
    // 없이 그대로 둔다).
    if (body.children[index] !== entry.row) {
      body.insertBefore(entry.row, body.children[index] || null);
    }
  });
}

// 디버그 모드 토글이 바뀔 때마다(설정 저장 직후, 최초 로딩 직후) 호출해서
// 창을 띄우거나 접고, 창이 떠 있는 동안만 주기적으로 다시 그린다 — 안
// 떠 있을 때 백그라운드에서 계속 그릴 필요는 없다.
function updateDebugPanelVisibility() {
  if (isDebugModeEnabled() && !debugPanelManuallyClosed) {
    ensureDebugPanel().hidden = false;
    if (!debugPanelRefreshTimer) {
      debugPanelRefreshTimer = setInterval(renderDebugPanel, DEBUG_PANEL_REFRESH_MS);
    }
    renderDebugPanel();
  } else {
    if (debugPanelEl) debugPanelEl.hidden = true;
    if (debugPanelRefreshTimer) {
      clearInterval(debugPanelRefreshTimer);
      debugPanelRefreshTimer = null;
    }
  }
}

function buildAudioSettingsItem(ch) {
  const item = document.createElement('div');
  item.className = 'audio-settings-item';
  item.style.setProperty('--item-color', getPlatformColor(ch.platform));

  const row = document.createElement('div');
  row.className = 'audio-settings-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'audio-settings-name';
  nameEl.textContent = ch.name;
  row.appendChild(nameEl);

  // 버그 수정(UI 전용, 실제 재생엔 문제없었음): getDisplayVolumeForChannel은
  // "지금 다시 계산하면 나올 목표 볼륨"이라, getChannelLevelingDb의 ~5초
  // 트림 평균 창이 매 500ms(§refreshAudioSettingsListIfSafe)마다 한 칸씩
  // 밀리면서 반올림 경계 근처에서 ±1~2%p씩 계속 흔들릴 수 있다. 이 패널이
  // 열려 있는 동안 그 값을 그대로 슬라이더/숫자에 반영해왔기 때문에, 실제
  // 소리는 clampVolumeStep+스무스 램프로 안정적으로 재생되는데도 패널만
  // 미세하게 계속 왔다갔다하는 것처럼 보였다(§renderChannelDebugPanel의
  // currentVolumePercent와 같은 이유로 같은 해법 — 실제로 마지막에 적용한
  // 값이 있으면 그걸 우선 쓴다). 드래그해서 직접 바꾸면 그 순간부터 이
  // 채널은 수동 고정값으로 전환된다 — 기준 음량 자체는 설정 화면에서만
  // 바뀐다.
  const currentVol = (typeof lastAppliedDisplayVolume[ch.hash] === 'number')
    ? lastAppliedDisplayVolume[ch.hash]
    : getDisplayVolumeForChannel(ch.hash);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.className = 'audio-settings-slider';
  slider.value = String(currentVol);

  const valueEl = document.createElement('span');
  valueEl.className = 'audio-settings-value';
  valueEl.textContent = `${currentVol}%`;

  const modesEl = document.createElement('div');
  modesEl.className = 'audio-settings-modes';

  slider.addEventListener('pointerdown', () => { audioSettingsDragActive = true; });
  slider.addEventListener('input', () => {
    valueEl.textContent = `${slider.value}%`;
    setChannelVolume(ch.hash, slider.value);
    renderAudioModesStatus(modesEl, ch.hash);
  });

  row.appendChild(slider);
  row.appendChild(valueEl);
  item.appendChild(row);
  item.appendChild(modesEl);
  renderAudioModesStatus(modesEl, ch.hash);

  return item;
}

function renderAudioSettingsList() {
  const listEl = document.getElementById('audio-settings-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (displayChannels.length === 0) {
    listEl.innerHTML = `<div class="tag-notice-empty">${t('preset.noChannels', '저장할 채널이 없습니다.')}</div>`;
    return;
  }

  // 합방 설정이 켜져 있고 실제로 그룹에 속한 채널이 있으면, 목록을
  // "그룹"/"그 외" 두 구역으로 나눠 보여준다 — 슬라이더 목록만 봐도 어느
  // 채널이 합방 대상인지 바로 구분되게 하기 위함. 그렇지 않으면(합방
  // 미사용) 기존처럼 평평한 목록 그대로 보여준다.
  const groupedChannels = isCollabSettingEnabled()
    ? displayChannels.filter(ch => !!findCollabGroupForChannel(ch.hash))
    : [];

  if (groupedChannels.length === 0) {
    displayChannels.forEach(ch => listEl.appendChild(buildAudioSettingsItem(ch)));
    return;
  }

  const otherChannels = displayChannels.filter(ch => !findCollabGroupForChannel(ch.hash));

  const groupSectionTitle = document.createElement('div');
  groupSectionTitle.className = 'audio-settings-section-title';
  groupSectionTitle.textContent = t('audio.groupedSectionLabel', '그룹');
  listEl.appendChild(groupSectionTitle);
  groupedChannels.forEach(ch => listEl.appendChild(buildAudioSettingsItem(ch)));

  if (otherChannels.length > 0) {
    const otherSectionTitle = document.createElement('div');
    otherSectionTitle.className = 'audio-settings-section-title';
    otherSectionTitle.textContent = t('audio.ungroupedSectionLabel', '그 외');
    listEl.appendChild(otherSectionTitle);
    otherChannels.forEach(ch => listEl.appendChild(buildAudioSettingsItem(ch)));
  }
}

function createCollabGroupId() {
  return `collab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getChannelNameByHash(hash) {
  const ch = displayChannels.find(c => c.hash === hash);
  return ch ? ch.name : hash;
}

// "겹침 %" 배지(위)는 항상 Stage 1(음량 타이밍) 원본값만 보여줘서, Stage 2
// (파형 비교)가 실제로 뭘 하고 있는지는 그 배지만 봐서는 알 수 없었다 —
// 그래서 "다른 말을 해도 겹침 %가 높게 나오고 아무 효과가 없어 보인다"는
// 혼동이 생겼다(실사용 피드백). Stage 2의 실제 판정 상태를 별도 배지로
// 보여줘서, 지금 음소거 여부가 Stage 1 원본값이 아니라 이 상태를 반영한
// 결과임을 직접 확인할 수 있게 한다.
// hash가 관여한 쌍 중 가장 강한 쌍(getStrongestPairForHash)의 Stage2
// 판정을 보여준다. 관여한 쌍 자체가 없으면(아직 아무와도 후보가 아님)
// "측정 중"과 동일하게 보이는 빈 배지를 돌려준다.
function buildCollabWaveformBadge(hash) {
  const badge = document.createElement('span');
  badge.className = 'collab-member-waveform-badge';

  // 실제 음소거 판정(recomputeCollabMuting)이 방금 시크/영상 전환 때문에
  // 이 쌍을 건너뛰고 있는 동안(§collabResetHoldUntilByHash)은, 배지도
  // 그 사실을 그대로 보여준다 — 아니면 실제로는 이전 판정이 그대로
  // 유지되고 있는데도 배지만 "파형 확인 중"으로 잠깐 바뀌어(2026-08-16
  // 사용자 실사용 지적) 마치 음소거가 풀린 것처럼 보이는 혼란이 있었다.
  if (isCollabResetHoldActive(hash)) {
    badge.classList.add('grace');
    badge.textContent = t('audio.collabWaveformResetHoldLabel', '전환 중 — 이전 상태 유지');
    badge.title = t('audio.collabWaveformResetHoldHint', '방금 시크/영상 전환이 있어 판정이 잠깐 불안정할 수 있는 구간이라, 그 직전의 음소거 상태를 그대로 유지하고 있습니다');
    return badge;
  }

  const strongest = getStrongestPairForHash(hash);
  if (!strongest) {
    badge.classList.add('pending');
    badge.textContent = t('audio.collabWaveformPendingLabel', '파형 확인 중');
    return badge;
  }
  const { partner } = strongest;
  const partnerName = getChannelNameByHash(partner);
  const verdict = getWaveformVerdict(hash, partner);

  if (verdict.state === 'unavailable') {
    badge.classList.add('unavailable');
    badge.textContent = t('audio.collabWaveformUnavailableLabel', '파형 분석 불가');
    badge.title = t('audio.collabWaveformUnavailableHint', '이 채널은 오디오 최적화 워클릿을 쓸 수 없어(구형 브라우저 등) 파형 비교 없이 음량 타이밍만으로 판정합니다');
    return badge;
  }

  if (verdict.state === 'pending') {
    badge.classList.add('pending');
    badge.textContent = t('audio.collabWaveformPendingLabel', '파형 확인 중');
    badge.title = t('audio.collabWaveformPendingHint', '파형 비교 결과가 아직 없어 이 채널은 음소거하지 않습니다(확인될 때까지 대기)');
    return badge;
  }

  if (verdict.state === 'grace') {
    badge.classList.add('grace');
    badge.textContent = t('audio.collabWaveformGraceLabel', '이전 확인 유지 중');
    badge.title = t('audio.collabWaveformGraceHintTemplate', '{partner} 채널과 방금까지 같은 소리로 확인됐던 쌍입니다 — 말소리가 잠깐 없어 파형을 다시 확인하는 동안 이전 판정(음소거)을 유지합니다', { partner: partnerName });
    return badge;
  }

  const scorePct = Math.round(verdict.waveform.score * 100);
  if (verdict.state === 'match') {
    badge.classList.add('match');
    badge.textContent = t('audio.collabWaveformMatchLabel', '같은 소리 확인됨');
  } else {
    badge.classList.add('different');
    badge.textContent = t('audio.collabWaveformDifferentLabel', '다른 소리로 판단');
  }
  badge.title = t('audio.collabWaveformScoreHintTemplate', '{partner} 채널과 파형 유사도: {score}% (기준 {threshold}%)', {
    partner: partnerName,
    score: scorePct,
    threshold: Math.round(COLLAB_WAVEFORM_MATCH_THRESHOLD * 100)
  });
  return badge;
}

// 메타데이터 자동 계산이 진행 중/실패한 멤버 hash 집합·사유 — 오디오
// 상관관계 파이프라인과 달리 API 왕복 한 번뿐이라 단계별 진행도는
// 필요 없고, "계산 중"과 "실패 사유"만 오디오 패널에 짧게 보여준다.
const vodAutoAlignPendingHashes = new Set();
const vodAutoAlignErrorByHash = {};

// vod-sync 그룹에 멤버가 추가될 때마다 버튼 없이 바로 VOD 메타데이터
// (liveOpenDate/liveBroadcastDetails 등, 플랫폼별 §PlatformAdapters[platform].
// getVodStartTime)로 오프셋을 계산해 오프셋(초) 입력칸에 자동으로
// 채운다(computeVodMetadataOffsetSec). "조용히 확정"이 아니라 "미리
// 채워주는 것"에 가깝다 — 값이 사용자가 보기에 틀렸다 싶으면 그
// 입력칸에 그냥 다시 입력하면 되고(§렌더 함수의 change 핸들러), 이
// 함수가 다시 그 값을 덮어쓰지 않는다.
//
// 대표 자신을 추가한 경우(멤버 hash === 대표 hash)나 대표/멤버 둘 중
// 하나라도 앵커를 지원하지 않으면(PlatformAdapters[platform].getVodStartTime이
// 없거나 VOD가 아님) 조용히 건너뛴다 — 같은 플랫폼일 필요는 없다,
// 두 채널 각각 앵커를 구할 수 있으면 충분하다(§docs/vod-collab-sync-
// architecture.md §10.3, 크로스플랫폼 지원의 핵심). isVodSyncSettingEnabled()
// (설정 > 실험적 기능 > "VOD 합방 싱크 동기화 사용")로만 게이팅한다 —
// group.mode가 'vod-sync'가 되려면 애초에 이 설정이 켜져 있어야 모드
// 선택 라디오 자체가 보이지만, 나중에 이 설정을 껐을 때도(그룹의
// mode 값 자체는 저장소에 남아있음) 자동 계산이 계속 몰래 도는 걸
// 막기 위한 이중 확인이다.
async function triggerVodMetadataAutoAlign(group, memberHash) {
  if (!isVodSyncSettingEnabled()) return;
  const representativeHash = getCollabLeaderHash(group);
  if (!representativeHash || representativeHash === memberHash) return;

  const repCh = displayChannels.find((c) => c.hash === representativeHash);
  const memberCh = displayChannels.find((c) => c.hash === memberHash);
  if (!repCh || !memberCh) return;
  const supportsVodAnchor = (c) => c.isVod && typeof PlatformAdapters[c.platform]?.getVodStartTime === 'function';
  if (!supportsVodAnchor(repCh) || !supportsVodAnchor(memberCh)) return;

  delete vodAutoAlignErrorByHash[memberHash];
  vodAutoAlignPendingHashes.add(memberHash);
  refreshAudioSettingsListIfSafe();
  renderCollabSettingsSection();
  try {
    const result = await computeVodMetadataOffsetSec(representativeHash, memberHash);
    if (result.ok) {
      // audioState.vodStartTimeMsByHash(ensureVodStartTimeCached 내부)에
      // 이미 반영됐다 — group.vodOffsetSecByHash에 따로 쓸 게 없다.
      // getVodSyncOffsetSec가 다음 호출부터 바로 이 값을 되돌려주고,
      // 대표가 나중에 바뀌어도(사용자 요청, §양방향) 다시 계산할 필요가
      // 없다. audioState가 바뀌었으니 저장은 여기서 한다.
      saveAudioState();
      recomputeCollabMuting();
      applyVolumeToAllChannels(true);

      // 2026-08-16 후속(사용자 지적: "처음에 교집합 상태가 아닌 상태로
      // 합방 멤버를 추가하면 자동 계산이 안 되네 -> 초기 계산에서는
      // 교집합의 시작 부분으로 강제 시커 이동 해줘"). 오프셋 자체는
      // 방금 위에서 정상 계산됐지만, 지금 대표 위치가 이 멤버의 교집합
      // 밖이면(§CHANNEL_PLAYBACK_TIME 핸들러, isVodSyncExpectedSecInWindow)
      // 그 핸들러가 이 멤버를 계속 건드리지 않는다 — 대표가 나중에 이
      // 구간에 자연히(사용자가 재생하다 보니) 도달할 때까지 동기화가
      // 영영 시작되지 않는 것처럼 보인다. 멤버를 막 맞춘 이 순간에만,
      // 대표를 이 멤버와의 교집합 시작점으로 한 번 강제 이동시켜 바로
      // 동기화가 걸리게 한다. offsetSec = repStart - memberStart(초)이므로
      // expectedSec(=repTime+offsetSec)가 0이 되는 repTime은 -offsetSec —
      // 음수면(대표가 더 늦게 시작해 교집합이 대표의 0초부터 바로
      // 시작함) 0으로 자른다.
      const offsetSec = getVodSyncOffsetSec(group, memberHash);
      const repTimeNow = lastKnownPlaybackTimeSec[representativeHash];
      if (offsetSec !== null && typeof repTimeNow === 'number') {
        const expectedSecNow = repTimeNow + offsetSec;
        const memberDurationSec = channelDurationSecByHash[memberHash];
        if (!isVodSyncExpectedSecInWindow(expectedSecNow, memberDurationSec)) {
          seekChannelToTime(representativeHash, Math.max(0, -offsetSec));
        }
      }
    } else {
      vodAutoAlignErrorByHash[memberHash] = result.error;
      console.warn('[CHEESE EYES] VOD 메타데이터 자동 오프셋 계산 실패:', result.error);
    }
  } finally {
    vodAutoAlignPendingHashes.delete(memberHash);
    refreshAudioSettingsListIfSafe();
    renderCollabSettingsSection();
  }
}

// 채널 하나는 동시에 최대 한 그룹에만 속한다 — 여러 그룹에 걸치면 리더/
// 음소거 판정이 모호해지므로, 이미 다른 그룹 소속인 채널은 체크박스를
// 비활성화해서 보여주기만 한다.
function renderCollabGroupCard(container, group) {
  const card = document.createElement('div');
  card.className = 'collab-group-card';

  const header = document.createElement('div');
  header.className = 'collab-group-header';

  const title = document.createElement('span');
  title.className = 'collab-group-title';
  title.textContent = group.memberHashes.length > 0
    ? group.memberHashes.map(getChannelNameByHash).join(' + ')
    : t('audio.collabUnnamedGroup', '새 합방 그룹');
  header.appendChild(title);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'collab-group-remove';
  removeBtn.textContent = '×';
  removeBtn.title = t('audio.collabRemoveGroup', '그룹 삭제');
  removeBtn.addEventListener('click', () => {
    audioState.collabGroups = audioState.collabGroups.filter(g => g.id !== group.id);
    delete leaderChangedAtByGroupId[group.id];
    saveAudioState();
    recomputeCollabMuting();
    applyVolumeToAllChannels(true);
    renderCollabSettingsSection();
  });
  header.appendChild(removeBtn);
  card.appendChild(header);

  // VOD 싱크 동기화 모드 선택(§설정 > 실험적 기능 > VOD 합방 싱크 동기화가
  // 켜져 있을 때만 노출 — 꺼져 있으면 그룹은 항상 'live'로 고정돼 기존
  // 화면 그대로 보인다). docs/vod-collab-sync-architecture.md §5/§6.
  if (isVodSyncSettingEnabled()) {
    const modeRow = document.createElement('div');
    modeRow.className = 'collab-group-mode-row';
    [
      { value: 'live', label: t('audio.collabModeLive', '라이브') },
      { value: 'vod-sync', label: t('audio.collabModeVodSync', 'VOD') }
    ].forEach(({ value, label }) => {
      const modeLabel = document.createElement('label');
      modeLabel.className = 'collab-group-mode-option';
      const modeRadio = document.createElement('input');
      modeRadio.type = 'radio';
      modeRadio.name = `collab-mode-${group.id}`;
      modeRadio.checked = (group.mode === 'vod-sync' ? 'vod-sync' : 'live') === value;
      modeRadio.addEventListener('change', () => {
        group.mode = value;
        saveAudioState();
        recomputeCollabMuting();
        applyVolumeToAllChannels(true);
        renderCollabSettingsSection();
      });
      modeLabel.appendChild(modeRadio);
      modeLabel.appendChild(document.createTextNode(label));
      modeRow.appendChild(modeLabel);
    });
    card.appendChild(modeRow);
  }

  const representative = getCollabLeaderHash(group);

  const memberList = document.createElement('div');
  memberList.className = 'collab-group-members';
  displayChannels.forEach((ch) => {
    const inThisGroup = group.memberHashes.includes(ch.hash);
    const otherGroup = !inThisGroup ? findCollabGroupForChannel(ch.hash) : null;

    // 체크박스(멤버 여부)와 라디오(리더 지정)는 둘 다 클릭 가능한
    // 컨트롤이라, 하나의 <label>로 함께 감싸면 브라우저가 라디오 클릭을
    // 감싸고 있는 label의 "연결된 컨트롤" 클릭으로 오인해 체크박스까지
    // 같이 토글될 수 있다. row 자체는 <label>로 만들지 않고, 체크박스+
    // 이름만 별도 <label>로 묶어 그 부분을 클릭했을 때만 멤버 토글이
    // 일어나게 하고, 라디오는 완전히 분리된 형제 엘리먼트로 둔다.
    const row = document.createElement('div');
    row.className = 'collab-member-row' + (otherGroup ? ' disabled' : '');

    const memberLabel = document.createElement('label');
    memberLabel.className = 'collab-member-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'collab-member-checkbox';
    checkbox.checked = inThisGroup;
    checkbox.disabled = !!otherGroup;
    checkbox.addEventListener('change', () => {
      const wasChecked = checkbox.checked;
      if (checkbox.checked) {
        if (!group.memberHashes.includes(ch.hash)) group.memberHashes.push(ch.hash);
      } else {
        group.memberHashes = group.memberHashes.filter(h => h !== ch.hash);
      }
      if (group.memberHashes.length === 0) {
        audioState.collabGroups = audioState.collabGroups.filter(g => g.id !== group.id);
        delete leaderChangedAtByGroupId[group.id];
      }
      saveAudioState();
      recomputeCollabMuting();
      applyVolumeToAllChannels(true);
      renderCollabSettingsSection();

      // vod-sync 그룹에 멤버를 추가하는 순간 버튼 클릭 없이 바로 치지직
      // VOD 메타데이터로 오프셋을 계산해 오프셋(초) 입력칸에 채운다.
      if (wasChecked && isVodSyncGroup(group)) {
        triggerVodMetadataAutoAlign(group, ch.hash);
      }
    });
    memberLabel.appendChild(checkbox);

    const nameEl = document.createElement('span');
    nameEl.className = 'collab-member-name';
    nameEl.textContent = ch.name;
    memberLabel.appendChild(nameEl);
    row.appendChild(memberLabel);

    if (inThisGroup) {
      // 리더(=대표)는 사용자가 직접 고른다 — 라디오로 그룹 내 한 명만
      // 선택할 수 있게 하고, 현재 리더로 표시한다. 2026-08-16 후속(사용자
      // 지시: "메인 채널 == 대표 채널로 해") — 대표는 별도 상태가 아니라
      // 곧 전역 mainChannel이므로, 이 라디오는 setMainChannel을 직접
      // 호출한다(§getCollabLeaderHash). 레이아웃과 무관하게 항상 동작해서
      // 더 이상 비활성화할 이유가 없다.
      const leaderRadio = document.createElement('input');
      leaderRadio.type = 'radio';
      leaderRadio.name = `collab-leader-${group.id}`;
      leaderRadio.className = 'collab-leader-radio';
      leaderRadio.checked = ch.hash === representative;
      leaderRadio.title = t('audio.collabSetLeaderHint', '이 채널을 대표로 지정');
      leaderRadio.addEventListener('change', () => {
        // 재판정/keeper 보류(leaderChangedAtByGroupId)/저장/렌더는
        // setMainChannel이 전부 처리한다(§setMainChannel).
        setMainChannel(ch.hash);
        // 대표가 바뀌어도 vodStartTimeMsByHash(양방향 앵커 캐시)에 이미
        // 새 대표/기존 멤버들의 값이 있으면 getVodSyncOffsetSec가 그
        // 자리에서 바로 새 오프셋을 내주므로 재계산이 필요 없다. 다만
        // 새 대표가 이번이 처음 대표/멤버로 얽힌 채널이면(예: 아직 한
        // 번도 다른 누구와도 짝지어진 적 없는 채널) 그 앵커 자체가 아직
        // 없을 수 있어, 정렬 안 된 멤버만 골라 다시 시도한다(캐시 있으면
        // ensureVodStartTimeCached가 API를 다시 안 부르므로 대부분
        // 즉시 끝난다).
        if (isVodSyncGroup(group)) {
          group.memberHashes.forEach((h) => {
            if (h === ch.hash) return;
            if (getVodSyncOffsetSec(group, h) !== null) return;
            triggerVodMetadataAutoAlign(group, h);
          });
        }
      });
      row.appendChild(leaderRadio);
    }

    if (inThisGroup) {
      const badge = document.createElement('span');
      if (ch.hash === representative) {
        badge.className = 'collab-member-badge leader';
        badge.textContent = t('audio.collabLeaderLabel', '대표');
        row.appendChild(badge);
      } else if (isVodSyncGroup(group)) {
        // 멤버 체크 시 VOD 메타데이터(플랫폼별 getVodStartTime, §10)로
        // 오프셋을 자동 계산해 이 입력칸에 채운다(triggerVodMetadataAutoAlign).
        // 값은 언제든 직접 수정 가능 — 계산이 안 됐거나(앵커 미지원
        // 플랫폼, API 실패, 라이브 유래가 아닌 영상 등) 사용자가 보기에
        // 틀렸으면 직접 입력한다. 값이 비어있으면 "정렬 전"으로 취급해
        // 음소거/시크 대상에서 제외된다(§4.5, recomputeCollabMuting).
        const offsetLabel = document.createElement('span');
        offsetLabel.className = 'collab-vod-offset-label';
        offsetLabel.textContent = t('audio.collabVodOffsetLabel', '오프셋(초)');
        offsetLabel.title = t('audio.collabVodOffsetHint', '대표 채널보다 이 채널이 몇 초 늦게 시작하는 VOD인지 직접 입력하세요. 비워두면 정렬 전으로 취급해 자동 음소거/시크를 하지 않습니다.');
        row.appendChild(offsetLabel);

        const offsetInput = document.createElement('input');
        offsetInput.type = 'number';
        offsetInput.step = '0.1';
        offsetInput.className = 'collab-vod-offset-input';
        const currentOffset = getVodSyncOffsetSec(group, ch.hash);
        offsetInput.value = currentOffset === null ? '' : String(Math.round(currentOffset * 10) / 10);
        offsetInput.addEventListener('change', () => {
          const parsed = parseFloat(offsetInput.value);
          if (!isFinite(parsed)) {
            // 비움 = "정렬 전"으로 되돌림 — leader-relative 폴백 저장값과
            // 양방향 앵커 캐시 둘 다 지운다(앵커가 남아있으면 이 그룹
            // 안에서는 안 보여도 대표가 바뀌면 다시 유효해져 버려 혼란).
            delete group.vodOffsetSecByHash?.[ch.hash];
            delete audioState.vodStartTimeMsByHash[ch.hash];
            delete vodSyncRefineHistoryByMemberHash[ch.hash]; // 쌓인 잔차 확인 기록도 같이 버림 — 재정렬 시 옛 값에 오염되지 않게
          } else {
            // 대표 쪽 앵커가 있으면 이 값을 "멤버의 실제 방송 시작 시각"
            // 으로 역산해 캐시에 반영한다 — 이렇게 하면 수동 입력도
            // 대표가 바뀌어도 그대로 유효하다(사용자 요청, §양방향).
            // 대표 쪽 앵커가 없으면(비치지직 대표 등) 예전처럼 이 그룹·
            // 이 대표 한정 값으로만 저장한다.
            const representativeHash = getCollabLeaderHash(group);
            const repStartMs = representativeHash ? audioState.vodStartTimeMsByHash[representativeHash] : undefined;
            if (typeof repStartMs === 'number') {
              audioState.vodStartTimeMsByHash[ch.hash] = repStartMs - parsed * 1000;
              delete group.vodOffsetSecByHash?.[ch.hash];
            } else {
              if (!group.vodOffsetSecByHash) group.vodOffsetSecByHash = {};
              group.vodOffsetSecByHash[ch.hash] = parsed;
            }
          }
          saveAudioState();
          recomputeCollabMuting();
          applyVolumeToAllChannels(true);
          renderCollabSettingsSection();
        });
        row.appendChild(offsetInput);

        const statusBadge = document.createElement('span');
        const muted = isChannelCollabMuted(ch.hash);
        statusBadge.className = 'collab-member-badge' + (muted ? ' muted' : '');
        statusBadge.textContent = currentOffset === null
          ? t('audio.collabVodSyncPendingLabel', '정렬 전')
          : (muted ? t('audio.collabMutedLabel', '음소거') : t('audio.collabVodSyncAlignedLabel', '동기화됨'));
        row.appendChild(statusBadge);
      } else {
        // 이 멤버가 관여한 쌍 중 가장 강한(유사도가 가장 높은) 쌍을 골라
        // "겹침 %" 배지에 요약한다 — 전체 쌍 비교로 바뀌면서 한 멤버가 여러
        // 상대와 관계를 가질 수 있어, 그중 지금 가장 두드러진 것만 보여준다.
        const strongest = getStrongestPairForHash(ch.hash);
        const similarity = strongest ? strongest.similarity : null;
        const muted = isChannelCollabMuted(ch.hash);
        badge.className = 'collab-member-badge' + (muted ? ' muted' : '');
        const pct = typeof similarity === 'number' ? Math.round(Math.max(0, similarity) * 100) : null;
        badge.textContent = muted
          ? t('audio.collabMutedLabel', '음소거')
          : (pct !== null ? `${t('audio.collabOverlapLabel', '겹침')} ${pct}%` : t('audio.collabMeasuringLabel', '측정 중'));
        badge.title = strongest
          ? t('audio.collabOverlapBadgeHintTemplate', '{partner} 채널과 음량이 같이 커지고 작아지는 정도(1차 신호) — 실제 음소거 여부는 옆의 파형 확인 결과도 함께 반영됩니다', { partner: getChannelNameByHash(strongest.partner) })
          : t('audio.collabOverlapBadgeHintGeneric', '음량이 같이 커지고 작아지는 정도(1차 신호) — 실제 음소거 여부는 옆의 파형 확인 결과도 함께 반영됩니다');
        row.appendChild(badge);
        row.appendChild(buildCollabWaveformBadge(ch.hash));
      }
    } else if (otherGroup) {
      const badge = document.createElement('span');
      badge.className = 'collab-member-badge disabled';
      badge.textContent = t('audio.collabInOtherGroupLabel', '다른 그룹 소속');
      row.appendChild(badge);
    }

    memberList.appendChild(row);

    // 메타데이터 자동 계산이 진행 중이거나 실패했을 때만 row 밑에 짧은
    // 상태 줄을 붙인다(row 안에 넣으면 flex라 옆으로 붙으므로 형제
    // 엘리먼트로 추가) — 성공하면 오프셋 입력칸에 값이 바로 보이므로
    // 별도 텍스트가 필요 없다.
    if (vodAutoAlignPendingHashes.has(ch.hash)) {
      const progressEl = document.createElement('div');
      progressEl.className = 'collab-member-align-progress';
      progressEl.textContent = t('audio.collabVodAlignComputing', 'VOD 메타데이터로 오프셋 계산 중…');
      memberList.appendChild(progressEl);
    } else if (vodAutoAlignErrorByHash[ch.hash]) {
      const errorEl = document.createElement('div');
      errorEl.className = 'collab-member-align-progress';
      errorEl.textContent = t('audio.collabVodAlignFailedTemplate', '자동 계산 실패: {error} — 직접 입력하세요', { error: vodAutoAlignErrorByHash[ch.hash] });
      memberList.appendChild(errorEl);
    }
  });
  card.appendChild(memberList);

  container.appendChild(card);
}

function renderCollabSettingsSection() {
  const section = document.getElementById('collab-settings-section');
  if (!section) return;

  // 2026-08-16 후속(사용자 지적: "합방 멤버 추가 시 새로고침 되듯이
  // 됨") — innerHTML을 통째로 비우고 다시 그리므로, 그룹/멤버가 많아
  // 패널을 스크롤해서 보고 있던 중에 멤버 하나만 체크해도 스크롤이
  // 맨 위로 튀어 "새로고침"처럼 느껴졌다. 재생성 전 스크롤 위치를
  // 기억했다가 끝에 그대로 되돌린다(try/finally — 이 함수에 이른
  // return이 여러 곳이라 어느 경로로 끝나든 항상 복원되게).
  const scrollBody = section.closest('.audio-settings-scroll-body');
  const prevScrollTop = scrollBody ? scrollBody.scrollTop : null;
  try {
    renderCollabSettingsSectionBody(section);
  } finally {
    if (scrollBody && prevScrollTop !== null) scrollBody.scrollTop = prevScrollTop;
  }
}

function renderCollabSettingsSectionBody(section) {
  if (!isCollabSettingEnabled()) {
    section.hidden = true;
    section.innerHTML = '';
    return;
  }
  section.hidden = false;
  section.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'collab-settings-header';

  const title = document.createElement('span');
  title.className = 'collab-settings-title';
  title.textContent = t('audio.collabSectionTitle', '합방 설정');
  header.appendChild(title);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'collab-add-group-btn';
  addBtn.textContent = t('audio.collabAddGroup', '+ 그룹 추가');
  addBtn.disabled = displayChannels.length < 2;
  addBtn.addEventListener('click', () => {
    audioState.collabGroups.push({ id: createCollabGroupId(), memberHashes: [], mode: 'live', vodOffsetSecByHash: {} });
    saveAudioState();
    renderCollabSettingsSection();
  });
  header.appendChild(addBtn);
  section.appendChild(header);

  const latencySyncNotice = document.createElement('div');
  latencySyncNotice.className = 'info-notice';
  latencySyncNotice.textContent = t('audio.collabLatencySyncNotice', '채널을 추가했을 경우 새로고침 후 멤버를 추가하세요(레이턴시 동기화).');
  section.appendChild(latencySyncNotice);

  if (displayChannels.length < 2) {
    const empty = document.createElement('div');
    empty.className = 'tag-notice-empty';
    empty.textContent = t('audio.collabNoChannels', '채널이 2개 이상 있어야 합방 그룹을 만들 수 있습니다.');
    section.appendChild(empty);
    return;
  }

  if (audioState.collabGroups.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'yt-settings-hint';
    hint.textContent = t('audio.collabNoGroups', '합방 채널을 그룹으로 묶으면, 겹치는 채널들 중 하나만 남기고 자동 음소거합니다(대표로 지정한 채널이 있으면 항상 그 채널이 남습니다).');
    section.appendChild(hint);
    return;
  }

  const list = document.createElement('div');
  list.className = 'collab-group-list';
  audioState.collabGroups.forEach(group => renderCollabGroupCard(list, group));
  section.appendChild(list);
}

function getParsedKeywords(input) {
  if (!input) return [];
  // 구분자는 쉼표(,) 또는 "쉼표+공백" 만 허용한다 (공백만으로는 나누지 않음).
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
  stopFollowingPoll();
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

const FOLLOWING_CACHE_KEY = 'following_live_cache';
// 캐시가 이 시간보다 오래됐으면 "일단 옛날 목록 보여주고 뒤에서 새로
// 불러오기"를 하지 않는다 — 라이브 여부가 그새 크게 바뀌었을 수 있는
// 오래된 목록을 잠깐이라도 보여주는 대신, 로딩 중 표시만 하고 새로
// 불러온 결과만 보여준다.
const FOLLOWING_CACHE_MAX_AGE_MS = 3 * 60 * 1000;
let followingRequestSeq = 0;

function readFollowingCache() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([FOLLOWING_CACHE_KEY], (result) => {
        const cached = result && result[FOLLOWING_CACHE_KEY];
        if (!cached || !Array.isArray(cached.groups)) { resolve(null); return; }
        if (typeof cached.cachedAt !== 'number' || Date.now() - cached.cachedAt > FOLLOWING_CACHE_MAX_AGE_MS) {
          resolve(null);
          return;
        }
        resolve(cached);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function writeFollowingCache(groups, loggedOutPlatforms) {
  try {
    chrome.storage.local.set({
      [FOLLOWING_CACHE_KEY]: { groups, loggedOutPlatforms, cachedAt: Date.now() }
    });
  } catch (e) {
    console.warn('[CHEESE EYES] 팔로우 목록 캐시 저장 실패:', e);
  }
}

function getFollowingSignature(groups, loggedOutPlatforms) {
  const groupPart = (groups || []).map(g => [
    g.platform,
    (g.candidates || []).map(ch => `${ch.platform}:${ch.hash}:${ch.name}`).join('|')
  ]);
  return JSON.stringify([groupPart, (loggedOutPlatforms || []).slice().sort()]);
}

function renderFollowingState(groups, loggedOutPlatforms) {
  const bodyContainer = document.getElementById('tag-notice-body');
  const flatChannels = (groups || []).reduce((acc, g) => acc.concat(g.candidates || []), []);

  fetchedTagChannels = flatChannels;
  selectedTagChannels = selectedTagChannels
    .map(sel => flatChannels.find(c => c.hash === sel.hash && c.platform === sel.platform))
    .filter(Boolean);

  listNoticeBuilder = null;
  if ((loggedOutPlatforms || []).length > 0) {
    listNoticeBuilder = () => {
      const wrap = document.createElement('div');
      loggedOutPlatforms.forEach(p => wrap.appendChild(buildFollowingLoginRow(p)));
      return wrap;
    };
  }

  if (flatChannels.length === 0 && !listNoticeBuilder) {
    bodyContainer.innerHTML = `<div class="tag-notice-empty">${t('following.empty', '라이브 중인 채널이 없습니다.')}</div>`;
    return;
  }
  if (flatChannels.length === 0) {
    bodyContainer.innerHTML = '';
    bodyContainer.appendChild(listNoticeBuilder());
    const empty = document.createElement('div');
    empty.className = 'tag-notice-empty';
    empty.textContent = t('following.empty', '라이브 중인 채널이 없습니다.');
    bodyContainer.appendChild(empty);
    return;
  }

  renderFollowingColumns(groups);
}

let followingRenderedSignature = null;
let followingPollTimer = null;
const FOLLOWING_POLL_INTERVAL_MS = 75000;

function startFollowingPoll() {
  stopFollowingPoll();
  followingPollTimer = setInterval(() => {
    const modal = document.getElementById('tag-notice-modal');
    if (!modal || !modal.classList.contains('active') || currentNoticeMode !== 'following') {
      stopFollowingPoll();
      return;
    }
    refreshFollowingChannelsQuietly();
  }, FOLLOWING_POLL_INTERVAL_MS);
}

function stopFollowingPoll() {
  if (followingPollTimer) {
    clearInterval(followingPollTimer);
    followingPollTimer = null;
  }
}

async function fetchMyFollowingChannels() {
  const bodyContainer = document.getElementById('tag-notice-body');
  const requestId = ++followingRequestSeq;

  fetchedTagChannels = [];
  selectedTagChannels = [];
  listNoticeBuilder = null;
  followingRenderedSignature = null;

  bodyContainer.innerHTML = `<div class="tag-notice-empty">${t('following.loading', '팔로우 채널 목록을 불러오는 중...')}</div>`;

  const cached = await readFollowingCache();
  if (requestId !== followingRequestSeq) return;

  if (cached) {
    renderFollowingState(cached.groups, cached.loggedOutPlatforms || []);
    followingRenderedSignature = getFollowingSignature(cached.groups, cached.loggedOutPlatforms || []);
  }

  await fetchFollowingOnce(requestId);
  startFollowingPoll();
}

// 패널이 열려있는 동안 주기적으로 조용히(로딩 표시·선택 상태 초기화 없이)
// 다시 조회한다. 실제로 목록이 바뀐 경우에만 다시 그린다(fetchFollowingOnce의
// 시그니처 비교 로직).
async function refreshFollowingChannelsQuietly() {
  const requestId = ++followingRequestSeq;
  await fetchFollowingOnce(requestId);
}

async function fetchFollowingOnce(requestId) {
  const enabledPlatforms = Object.keys(PLATFORM_META).filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p]);
  const loginStatuses = await Promise.all(enabledPlatforms.map(p => PlatformAdapters[p].checkLoginStatus()));
  const loginStatusByPlatform = Object.fromEntries(enabledPlatforms.map((p, i) => [p, loginStatuses[i]]));

  const loggedInPlatforms = enabledPlatforms.filter(p => loginStatusByPlatform[p]);
  // 플랫폼별로 병렬 요청하되, 화면에는 모든 플랫폼의 응답이 다 도착한 뒤 한 번에만
  // 표시한다(먼저 도착한 플랫폼 결과를 바로 띄우지 않음).
  const settled = await Promise.allSettled(loggedInPlatforms.map(p => PlatformAdapters[p].fetchFollowingLive()));
  if (requestId !== followingRequestSeq) return;

  const followingGroups = [];
  loggedInPlatforms.forEach((p, i) => {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      followingGroups.push({ platform: p, candidates: outcome.value || [] });
    } else {
      console.error(`${PLATFORM_META[p].label} 팔로우 목록 요청 실패:`, outcome.reason);
      // 현재 화면에 그려져 있는(=마지막으로 성공했던) 목록을 그대로 유지한다.
      followingGroups.push({ platform: p, candidates: fetchedTagChannels.filter(c => c.platform === p) });
    }
  });

  const loggedOutPlatforms = enabledPlatforms.filter(p => !loginStatusByPlatform[p]);
  writeFollowingCache(followingGroups, loggedOutPlatforms);

  const freshSignature = getFollowingSignature(followingGroups, loggedOutPlatforms);
  if (followingRenderedSignature !== null && freshSignature === followingRenderedSignature) {
    const freshChannels = followingGroups.reduce((acc, g) => acc.concat(g.candidates || []), []);
    fetchedTagChannels.forEach(ch => {
      const fresh = freshChannels.find(c => c.hash === ch.hash && c.platform === ch.platform);
      if (fresh) Object.assign(ch, fresh);
    });
    return;
  }

  followingRenderedSignature = freshSignature;
  renderFollowingState(followingGroups, loggedOutPlatforms);
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

  // 드래그/shift+클릭 다중 선택 시 hash+platform으로 채널 원본 객체를
  // 찾아야 하므로(태그 목록의 fetchedTagChannels와 동일 역할), 현재 탭에
  // 표시되는 채널들을 평탄화해 둔다.
  const flatFollowingChannels = [];

  groups.forEach(group => {
    if (currentListPlatformTab !== 'all' && group.platform !== currentListPlatformTab) return;
    (group.candidates || []).forEach(ch => {
      flatFollowingChannels.push(ch);
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

  initTagChipDragSelect(
    listWrap,
    '.selectable-channel-item',
    (hash, platform) => flatFollowingChannels.find(c => c.hash === hash && c.platform === platform)
  );
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
        notice.textContent = t('tagSearch.youtubeUnsupported', '유튜브는 별도의 태그 검색을 지원하지 않습니다.');
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

function initTagChipDragSelect(scrollContainer, itemSelector, findChannel) {
  itemSelector = itemSelector || '.tag-chip-item';
  findChannel = findChannel || ((hash, platform) => fetchedTagChannels.find(c => c.hash === hash && c.platform === platform));

  let isMouseDown = false;
  let isDragging = false;
  let startAbsX = 0;
  let startAbsY = 0;
  let dragRect = null;
  let dragEntries = new Map();
  let autoScrollTimer = null;
  let lastMouseEvt = null;
  let lastShiftStartAbsX = null;
  let lastShiftStartAbsY = null;
  let startChip = null;
  function toggleChipState(chip) {
    if (!chip) return;
    const hash = chip.getAttribute('data-hash');
    const platform = chip.getAttribute('data-platform');
    const channelObj = findChannel(hash, platform);
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

    // updateDragSelection()이 이 칩을 다시 훑을 때 방금 반영한 상태를
    // 그대로 최신값으로 보도록, 캐시된 드래그 엔트리도 함께 갱신한다.
    const entry = dragEntries.get(chip);
    if (entry) entry.current = !isSelected;
  }

  scrollContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;

    isMouseDown = true;
    isDragging = false;
    scrollContainer.classList.remove('has-dragged');

    const rect = scrollContainer.getBoundingClientRect();
    const currentChip = e.target.closest(itemSelector);
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

    // 칩 위치(offsetLeft 등)와 소속 채널은 드래그 도중 바뀌지 않으므로
    // 여기서 한 번만 읽어 캐시해두고, updateDragSelection()은 매
    // mousemove마다 DOM을 재조회/재측정하지 않고 이 캐시만 사용한다.
    dragEntries = new Map();
    scrollContainer.querySelectorAll(itemSelector).forEach(chip => {
      const hash = chip.getAttribute('data-hash');
      const platform = chip.getAttribute('data-platform');
      const wasSelected = chip.classList.contains('selected');
      dragEntries.set(chip, {
        hash,
        platform,
        channelObj: findChannel(hash, platform),
        left: chip.offsetLeft,
        top: chip.offsetTop,
        right: chip.offsetLeft + chip.offsetWidth,
        bottom: chip.offsetTop + chip.offsetHeight,
        wasSelected,
        current: wasSelected,
      });
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

  let dragUpdateQueued = false;
  window.addEventListener('mousemove', (e) => {
    if (!isMouseDown) return;
    if (!isDragging) {
      isDragging = true;
      scrollContainer.classList.add('has-dragged');
      document.body.classList.add('drag-selecting');
      startAutoScroll();
    }

    lastMouseEvt = e;
    // 마우스가 화면 주사율보다 빠르게 mousemove를 쏟아내는 경우(고폴링레이트
    // 마우스 등)가 있어, rAF 한 프레임당 한 번만 계산하도록 묶는다.
    if (!dragUpdateQueued) {
      dragUpdateQueued = true;
      requestAnimationFrame(() => {
        dragUpdateQueued = false;
        updateDragSelection();
      });
    }
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
    dragEntries.clear();
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
    const rectRight = rectLeft + rectWidth;
    const rectBottom = rectTop + rectHeight;

    dragRect.style.left = `${rectLeft}px`;
    dragRect.style.top = `${rectTop}px`;
    dragRect.style.width = `${rectWidth}px`;
    dragRect.style.height = `${rectHeight}px`;

    // 칩 목록/좌표는 mousedown 시점에 캐시된 dragEntries를 그대로 쓰고,
    // 실제로 선택 상태가 바뀌는 칩에 대해서만 classList와
    // selectedTagChannels를 건드린다(매 프레임 모든 칩을 다시 쓰지 않음).
    dragEntries.forEach((entry, chip) => {
      const isIntersecting = !(
        rectRight < entry.left ||
        rectLeft > entry.right ||
        rectBottom < entry.top ||
        rectTop > entry.bottom
      );

      const shouldBeSelected = isIntersecting ? !entry.wasSelected : entry.wasSelected;
      if (shouldBeSelected === entry.current) return;
      entry.current = shouldBeSelected;

      if (shouldBeSelected) {
        chip.classList.add('selected');
        if (entry.channelObj && !selectedTagChannels.some(c => c.hash === entry.hash && c.platform === entry.platform)) {
          selectedTagChannels.push(entry.channelObj);
        }
      } else {
        chip.classList.remove('selected');
        const idx = selectedTagChannels.findIndex(c => c.hash === entry.hash && c.platform === entry.platform);
        if (idx > -1) selectedTagChannels.splice(idx, 1);
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

let presetModalChannels = [];
let presetSearchDebounceTimer = null;
let presetSearchToken = 0;
let presetSearchSections = [];
let currentPresetSearchKeywordTab = 'all';

function openPresetModal() {
  let modal = document.getElementById('preset-modal');

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'preset-modal';
    modal.className = 'preset-modal-backdrop';
    modal.innerHTML = `
      <div class="preset-modal-content preset-modal-content-wide">
        <h3 data-i18n="preset.modalTitle">${t('preset.modalTitle', '프리셋 저장')}</h3>
        <div class="modal-field">
          <label data-i18n="preset.nameLabel">${t('preset.nameLabel', '프리셋 이름')}</label>
          <input type="text" id="preset-name-input" data-i18n-placeholder="preset.namePlaceholder" placeholder="${t('preset.namePlaceholder', '예) 종합게임 스트리머')}" />
        </div>
        <div class="modal-field">
          <label data-i18n="preset.colorLabel">${t('preset.colorLabel', '프리셋 색상')}</label>
          <input type="color" id="preset-color-input" value="#FFFFFF" />
        </div>
        <div class="modal-field">
          <label data-i18n="preset.searchLabel">${t('preset.searchLabel', '채널 검색')}</label>
          <input type="text" id="preset-channel-search-input" data-i18n-placeholder="preset.searchPlaceholder" placeholder="${t('preset.searchPlaceholder', '채널명을 입력하세요')}" autocomplete="off" />
          <div id="preset-search-results" class="preset-search-results"></div>
        </div>
        <div class="modal-field">
          <div class="preset-selected-header">
            <label>${t('preset.selectedChannelsLabel', '추가된 채널')} (<span id="preset-selected-count">0</span>)</label>
            <button type="button" id="preset-clear-selected-btn" class="preset-clear-selected-btn" data-i18n="preset.clearSelected">${t('preset.clearSelected', '전체 삭제')}</button>
          </div>
          <div id="preset-selected-channels" class="preset-selected-channels"></div>
        </div>
        <div class="modal-actions">
          <button id="preset-import-trigger-btn" data-i18n="button.importPreset">${t('button.importPreset', '가져오기')}</button>
          <div class="modal-actions-right">
            <button id="preset-cancel-btn" data-i18n="preset.cancel">${t('preset.cancel', '취소')}</button>
            <button id="preset-save-confirm-btn" class="primary" data-i18n="preset.save">${t('preset.save', '저장')}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('preset-cancel-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });

    document.getElementById('preset-save-confirm-btn').addEventListener('click', confirmSavePreset);
    document.getElementById('preset-import-trigger-btn').addEventListener('click', openPresetImportModal);
    document.getElementById('preset-clear-selected-btn').addEventListener('click', clearPresetModalChannels);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });

    const searchInput = document.getElementById('preset-channel-search-input');
    searchInput.addEventListener('input', () => {
      const rawValue = searchInput.value;
      if (presetSearchDebounceTimer) clearTimeout(presetSearchDebounceTimer);
      if (splitPresetSearchKeywords(rawValue).length === 0) {
        presetSearchToken++;
        presetSearchSections = [];
        currentPresetSearchKeywordTab = 'all';
        renderPresetSearchResults();
        return;
      }
      presetSearchDebounceTimer = setTimeout(() => fetchPresetSearchResults(rawValue), 250);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
  }

  presetModalChannels = [...channels];
  document.getElementById('preset-name-input').value = '';
  document.getElementById('preset-color-input').value = '#FFFFFF';
  document.getElementById('preset-channel-search-input').value = '';
  presetSearchSections = [];
  currentPresetSearchKeywordTab = 'all';
  renderPresetSearchResults();
  renderPresetSelectedChannels();
  modal.classList.add('active');
  document.getElementById('preset-name-input').focus();
}

function splitPresetSearchKeywords(input) {
  return String(input || '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function sameChannel(a, b) {
  return a.platform === b.platform && a.hash === b.hash;
}

function dedupeChannels(list) {
  const seen = new Set();
  return list.filter(ch => {
    const key = `${ch.platform}:${ch.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchPresetSearchResults(rawInput) {
  const myToken = ++presetSearchToken;
  const keywords = splitPresetSearchKeywords(rawInput);

  if (keywords.length === 0) {
    presetSearchSections = [];
    currentPresetSearchKeywordTab = 'all';
    renderPresetSearchResults();
    return;
  }

  const enabledPlatforms = Object.keys(PLATFORM_META)
    .filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p] && typeof PlatformAdapters[p].searchCandidatesByKeyword === 'function');

  const sections = await Promise.all(keywords.map(async (keyword) => {
    const resultsByPlatform = await Promise.all(
      enabledPlatforms.map(p => PlatformAdapters[p].searchCandidatesByKeyword(keyword).catch(() => []))
    );
    return { keyword, results: dedupeChannels(resultsByPlatform.flat()) };
  }));

  if (presetSearchToken !== myToken) return;

  presetSearchSections = sections;
  currentPresetSearchKeywordTab = 'all';
  renderPresetSearchResults();
}

function buildPresetKeywordTabsBar(activeTab, onSelect) {
  const tabs = [
    { key: 'all', label: t('platformTabs.all', '전체') },
    ...presetSearchSections.map(section => ({ key: section.keyword, label: section.keyword }))
  ];
  return buildTabsBar(tabs, activeTab, onSelect, 'search-keyword-tabs');
}

function renderPresetSearchResults() {
  const resultsEl = document.getElementById('preset-search-results');
  if (!resultsEl) return;
  resultsEl.innerHTML = '';

  if (presetSearchSections.length === 0) {
    resultsEl.innerHTML = `<div class="tag-notice-empty">${t('preset.searchEmpty', '검색 결과가 없습니다.')}</div>`;
    return;
  }

  if (presetSearchSections.length > 1) {
    const tabsBar = buildPresetKeywordTabsBar(currentPresetSearchKeywordTab, (tab) => {
      currentPresetSearchKeywordTab = tab;
      renderPresetSearchResults();
    });
    resultsEl.appendChild(tabsBar);
  }

  let items;
  if (currentPresetSearchKeywordTab === 'all') {
    items = dedupeChannels(presetSearchSections.flatMap(section => section.results));
  } else {
    const target = presetSearchSections.find(s => s.keyword === currentPresetSearchKeywordTab);
    items = target ? target.results : [];
  }

  if (items.length === 0) {
    resultsEl.insertAdjacentHTML('beforeend', `<div class="tag-notice-empty">${t('preset.searchEmpty', '검색 결과가 없습니다.')}</div>`);
    return;
  }

  items.forEach(ch => {
    const row = document.createElement('div');
    row.className = 'preset-search-row';
    row.setAttribute('data-platform', ch.platform);
    row.setAttribute('data-hash', ch.hash);
    row.style.setProperty('--item-color', getPlatformColor(ch.platform));

    const badge = document.createElement('span');
    badge.className = 'preset-search-platform-badge';
    badge.textContent = getPlatformLabel(ch.platform);
    row.appendChild(badge);

    const nameEl = document.createElement('span');
    nameEl.className = 'preset-search-name';
    nameEl.textContent = ch.name;
    row.appendChild(nameEl);

    if (ch.live) {
      const liveEl = document.createElement('span');
      liveEl.className = 'preset-search-live-badge';
      liveEl.textContent = t('following.titleLive', '라이브');
      row.appendChild(liveEl);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'preset-search-add-btn';
    const already = presetModalChannels.some(c => sameChannel(c, ch));
    addBtn.textContent = already ? t('preset.added', '추가됨') : t('preset.add', '추가');
    addBtn.disabled = already;
    addBtn.addEventListener('click', () => {
      if (presetModalChannels.some(c => sameChannel(c, ch))) return;
      const channelData = { platform: ch.platform, hash: ch.hash, name: ch.name };
      if (ch.broadNo) channelData.broadNo = ch.broadNo;
      presetModalChannels.push(channelData);
      renderPresetSelectedChannels();
      addBtn.textContent = t('preset.added', '추가됨');
      addBtn.disabled = true;
    });
    row.appendChild(addBtn);

    resultsEl.appendChild(row);
  });
}

function renderPresetSelectedChannels() {
  const wrap = document.getElementById('preset-selected-channels');
  const countEl = document.getElementById('preset-selected-count');
  if (countEl) countEl.textContent = String(presetModalChannels.length);
  if (!wrap) return;
  wrap.innerHTML = '';

  if (presetModalChannels.length === 0) {
    wrap.innerHTML = `<div class="tag-notice-empty">${t('preset.noChannels', '저장할 채널이 없습니다.')}</div>`;
    return;
  }

  presetModalChannels.forEach(ch => {
    const chip = document.createElement('div');
    chip.className = 'preset-selected-chip';
    chip.style.setProperty('--item-color', getPlatformColor(ch.platform));

    const nameSpan = document.createElement('span');
    nameSpan.textContent = ch.name;
    chip.appendChild(nameSpan);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'preset-selected-remove-btn';
    removeBtn.innerHTML = '✕';
    removeBtn.addEventListener('click', () => {
      presetModalChannels = presetModalChannels.filter(c => !sameChannel(c, ch));
      renderPresetSelectedChannels();

      const resultsEl = document.getElementById('preset-search-results');
      const row = resultsEl && resultsEl.querySelector(`.preset-search-row[data-platform="${ch.platform}"][data-hash="${CSS.escape(ch.hash)}"]`);
      const btn = row && row.querySelector('.preset-search-add-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('preset.add', '추가');
      }
    });
    chip.appendChild(removeBtn);

    wrap.appendChild(chip);
  });
}

function clearPresetModalChannels() {
  if (presetModalChannels.length === 0) return;
  presetModalChannels = [];
  renderPresetSelectedChannels();
  renderPresetSearchResults();
}

function confirmSavePreset() {
  const nameInput = document.getElementById('preset-name-input');
  const colorInput = document.getElementById('preset-color-input');
  const name = nameInput.value.trim();
  const color = colorInput.value || '#ffffff';

  if (!name) {
    showPresetNotice(t('preset.nameRequired', '프리셋 이름을 입력해주세요.'));
    return;
  }

  if (presetModalChannels.length === 0) {
    showPresetNotice(t('preset.noChannels', '저장할 채널이 없습니다.'));
    return;
  }

  if (presets.some(p => p.name === name)) {
    showPresetNotice(t('preset.duplicateName', '이미 같은 이름의 프리셋이 있습니다.'));
    return;
  }

  const newPreset = {
    id: Date.now(),
    name: name,
    color: color,
    channels: [...presetModalChannels]
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
    item.setAttribute('data-preset-id', String(preset.id));

    const bgColor = preset.color || '#ffffff';
    const textColor = getContrastTextColor(bgColor);

    item.style.backgroundColor = bgColor;
    item.style.color = textColor;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'preset-name';
    nameSpan.textContent = preset.name;
    nameSpan.addEventListener('click', () => loadPreset(preset.id));

    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'preset-share-btn';
    shareBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="18" cy="5" r="3"></circle>
        <circle cx="6" cy="12" r="3"></circle>
        <circle cx="18" cy="19" r="3"></circle>
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
      </svg>
    `;
    shareBtn.style.color = textColor;
    shareBtn.title = t('preset.shareTitle', '프리셋 공유');
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPresetShareModal(preset.id);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'preset-delete-btn';
    deleteBtn.innerHTML = '✕';
    deleteBtn.style.color = textColor;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePreset(preset.id);
    });

    item.appendChild(nameSpan);
    item.appendChild(shareBtn);
    item.appendChild(deleteBtn);
    presetContainer.appendChild(item);
  });
}

async function getFreshLiveChannelData(ch) {
  if (ch.platform === 'chzzk') {
    const isLive = await checkChzzkLiveByChannelId(ch.hash);
    return isLive ? { ...ch } : null;
  }

  if (ch.platform === 'soop') {
    try {
      const fresh = await PlatformAdapters.soop.searchChannelById(ch.hash);
      if (fresh && fresh.broadNo) return { ...ch, name: fresh.name || ch.name, broadNo: fresh.broadNo };
    } catch (e) {}
    return null;
  }

  if (ch.platform === 'youtube') {
    try {
      const resolved = await PlatformAdapters.youtube._resolveByChannelId(ch.hash);
      if (resolved && resolved.videoId) return { ...ch, name: resolved.name || ch.name, videoId: resolved.videoId };
    } catch (e) {}
    return null;
  }

  return { ...ch };
}

async function loadPreset(presetId) {
  const target = presets.find(p => p.id === presetId);
  if (!target) return;

  const presetChannels = target.channels || [];
  if (presetChannels.length === 0) return;

  const presetItemEl = presetContainer && presetContainer.querySelector(`.preset-item[data-preset-id="${presetId}"]`);
  if (presetItemEl) presetItemEl.classList.add('preset-loading');

  // 라이브 상태를 새로 확인하는 동안, 캐시된 것처럼 보일 수 있는 이전
  // 화면을 그대로 두지 않고 로딩 중임을 오버레이로 명확히 보여준다 —
  // 실패(라이브 채널 없음)하면 그대로 걷어내고 원래 화면을 복원한다.
  let loadingOverlay = null;
  if (videoGrid) {
    loadingOverlay = document.createElement('div');
    loadingOverlay.className = 'preset-loading-overlay';
    loadingOverlay.textContent = t('preset.loading', '불러오는 중...');
    videoGrid.appendChild(loadingOverlay);
  }

  const freshResults = await Promise.all(presetChannels.map(getFreshLiveChannelData));

  if (presetItemEl) presetItemEl.classList.remove('preset-loading');
  if (loadingOverlay) loadingOverlay.remove();

  const liveChannels = freshResults.filter(Boolean);
  if (liveChannels.length === 0) {
    showPresetNotice(t('preset.noLiveChannels', '현재 라이브 중인 채널이 없습니다.'));
    return;
  }

  clearVideoGrid();
  controlUnlockedHash = null;
  channels = [...liveChannels];
  displayChannels = [...liveChannels];
  channelAddOrder = liveChannels.map(c => c.hash);
  mainChannel = displayChannels[0].hash;
  activeChatChannel = displayChannels[0].hash;
  saveChannelsToStorage();
  renderAll();
}

function deletePreset(presetId) {
  presets = presets.filter(p => p.id !== presetId);
  savePresetsToStorage();
  renderPresets();
}

function clearAllPresets() {
  if (presets.length === 0) return;
  showPresetConfirm(t('preset.clearAllConfirm', '저장된 모든 프리셋을 삭제하시겠습니까?'), () => {
    presets = [];
    savePresetsToStorage();
    renderPresets();
  });
}

function createSimpleModal(id, { windowClass = '', titleKey, titleFallback, bodyHtml, footerHtml }) {
  const modal = document.createElement('div');
  modal.id = id;
  modal.className = 'tag-notice-backdrop';
  modal.innerHTML = `
    <div class="tag-notice-window${windowClass ? ' ' + windowClass : ''}">
      <div class="tag-notice-header">
        <h3 data-i18n="${titleKey}">${t(titleKey, titleFallback)}</h3>
        <button class="tag-notice-close" id="${id}-close-btn">✕</button>
      </div>
      <div class="tag-notice-body">${bodyHtml}</div>
      <div class="tag-notice-footer" style="justify-content:flex-end; gap:8px;">${footerHtml}</div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.classList.remove('active');
  document.getElementById(`${id}-close-btn`).addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  return modal;
}

function ensurePresetNoticeModal() {
  let modal = document.getElementById('preset-notice-modal');
  if (modal) return modal;

  modal = createSimpleModal('preset-notice-modal', {
    windowClass: 'preset-notice-window',
    titleKey: 'preset.noticeTitle',
    titleFallback: '안내',
    bodyHtml: `<p id="preset-notice-message" class="preset-notice-message"></p>`,
    footerHtml: `<button id="preset-notice-ok-btn" class="preset-modal-primary-btn" data-i18n="preset.noticeOk">${t('preset.noticeOk', '확인')}</button>`
  });

  document.getElementById('preset-notice-ok-btn').addEventListener('click', () => modal.classList.remove('active'));

  return modal;
}

function showPresetNotice(message) {
  const modal = ensurePresetNoticeModal();
  document.getElementById('preset-notice-message').textContent = message;
  modal.classList.add('active');
}

function ensurePresetConfirmModal() {
  let modal = document.getElementById('preset-confirm-modal');
  if (modal) return modal;

  modal = createSimpleModal('preset-confirm-modal', {
    windowClass: 'preset-notice-window',
    titleKey: 'preset.noticeTitle',
    titleFallback: '안내',
    bodyHtml: `<p id="preset-confirm-message" class="preset-notice-message"></p>`,
    footerHtml: `
      <button id="preset-confirm-cancel-btn" class="preset-modal-cancel-btn" data-i18n-title="preset.cancel" title="${t('preset.cancel', '취소')}">✕</button>
      <button id="preset-confirm-ok-btn" class="preset-modal-primary-btn" data-i18n="preset.noticeOk">${t('preset.noticeOk', '확인')}</button>
    `
  });

  document.getElementById('preset-confirm-cancel-btn').addEventListener('click', () => modal.classList.remove('active'));

  return modal;
}

function showPresetConfirm(message, onConfirm) {
  const modal = ensurePresetConfirmModal();
  document.getElementById('preset-confirm-message').textContent = message;
  document.getElementById('preset-confirm-ok-btn').onclick = () => {
    modal.classList.remove('active');
    onConfirm();
  };
  modal.classList.add('active');
}

// CE1: 예전 포맷(필드명 반복되는 객체 JSON + base64, 압축 없음) — 이미 공유된
// 코드가 있을 수 있으니 해독은 계속 지원한다. CE2: 새 포맷 — 채널을 필드명
// 없는 배열로 담고([platform, hash, name, broadNo?]) gzip으로 압축한 뒤
// base64로 감싼다. 새로 만드는 코드는 항상 CE2를 쓴다.
const PRESET_SHARE_CODE_PREFIX = 'CE1:';
const PRESET_SHARE_CODE_PREFIX_V2 = 'CE2:';

const PRESET_SHARE_PLATFORM_CODE = { chzzk: 'c', soop: 's', youtube: 'y', twitch: 't' };
const PRESET_SHARE_CODE_PLATFORM = { c: 'chzzk', s: 'soop', y: 'youtube', t: 'twitch' };

function toShareChannelEntry(c) {
  const entry = { platform: c.platform, hash: c.hash, name: c.name };
  if (c.broadNo) entry.broadNo = c.broadNo;
  return entry;
}

function toCompactShareChannelEntry(c) {
  const platform = PRESET_SHARE_PLATFORM_CODE[c.platform] || c.platform;
  return c.broadNo ? [platform, c.hash, c.name, c.broadNo] : [platform, c.hash, c.name];
}

function fromCompactShareChannelEntry(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const [code, hash, name, broadNo] = arr;
  const platform = PRESET_SHARE_CODE_PLATFORM[code] || code;
  if (!platform || !hash || !name) return null;
  const entry = { platform, hash, name };
  if (broadNo) entry.broadNo = broadNo;
  return entry;
}

async function gzipTextToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  compressed.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

async function gzipBase64ToText(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const decompressed = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(decompressed);
}

async function encodePresetShareCode(preset) {
  const payload = {
    n: preset.name,
    c: preset.color,
    ch: (preset.channels || []).map(toCompactShareChannelEntry)
  };
  const json = JSON.stringify(payload);
  try {
    const b64 = await gzipTextToBase64(json);
    return PRESET_SHARE_CODE_PREFIX_V2 + b64;
  } catch (e) {
    // CompressionStream을 쓸 수 없는 아주 예외적인 환경 대비 — 예전 방식으로 폴백.
    const legacyPayload = { name: preset.name, color: preset.color, channels: (preset.channels || []).map(toShareChannelEntry) };
    return PRESET_SHARE_CODE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(legacyPayload))));
  }
}

async function decodePresetShareCode(code) {
  const trimmed = String(code || '').trim();

  if (trimmed.startsWith(PRESET_SHARE_CODE_PREFIX_V2)) {
    try {
      const json = await gzipBase64ToText(trimmed.slice(PRESET_SHARE_CODE_PREFIX_V2.length));
      const data = JSON.parse(json);
      if (!data || typeof data.n !== 'string' || !Array.isArray(data.ch)) return null;

      const channels = data.ch.map(fromCompactShareChannelEntry).filter(Boolean);
      if (channels.length === 0) return null;

      return { name: data.n, color: typeof data.c === 'string' ? data.c : '#FFC800', channels };
    } catch (e) {
      return null;
    }
  }

  if (trimmed.startsWith(PRESET_SHARE_CODE_PREFIX)) {
    try {
      const json = decodeURIComponent(escape(atob(trimmed.slice(PRESET_SHARE_CODE_PREFIX.length))));
      const data = JSON.parse(json);
      if (!data || typeof data.name !== 'string' || !Array.isArray(data.channels)) return null;

      const channels = data.channels
        .filter(c => c && c.platform && c.hash && c.name)
        .map(toShareChannelEntry);
      if (channels.length === 0) return null;

      return { name: data.name, color: typeof data.color === 'string' ? data.color : '#FFC800', channels };
    } catch (e) {
      return null;
    }
  }

  return null;
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function ensurePresetShareModal() {
  let modal = document.getElementById('preset-share-modal');
  if (modal) return modal;

  return createSimpleModal('preset-share-modal', {
    windowClass: 'preset-share-window',
    titleKey: 'preset.shareTitle',
    titleFallback: '프리셋 공유',
    bodyHtml: `<textarea id="preset-share-code" class="preset-share-textarea" readonly></textarea>`,
    footerHtml: `<button id="preset-share-copy-btn" class="preset-modal-primary-btn" data-i18n="preset.copyCode">${t('preset.copyCode', '코드 복사')}</button>`
  });
}

async function openPresetShareModal(presetId) {
  const preset = presets.find(p => p.id === presetId);
  if (!preset) return;

  const modal = ensurePresetShareModal();
  const textarea = document.getElementById('preset-share-code');
  textarea.value = '';

  const copyBtn = document.getElementById('preset-share-copy-btn');
  copyBtn.textContent = t('preset.copyCode', '코드 복사');
  // 복사 시점의 textarea.value를 그대로 읽는다(클로저로 옛 code를 들고
  // 있지 않게) — gzip 인코딩이 비동기라 값이 늦게 채워질 수 있어서다.
  copyBtn.onclick = async () => {
    const ok = await copyTextToClipboard(textarea.value);
    copyBtn.textContent = ok ? t('preset.copied', '복사됨!') : t('preset.copyFailed', '복사 실패');
    setTimeout(() => { copyBtn.textContent = t('preset.copyCode', '코드 복사'); }, 1500);
  };

  modal.classList.add('active');
  textarea.focus();

  textarea.value = await encodePresetShareCode(preset);
  textarea.select();
}

function ensurePresetImportModal() {
  let modal = document.getElementById('preset-import-modal');
  if (modal) return modal;

  modal = createSimpleModal('preset-import-modal', {
    windowClass: 'preset-share-window',
    titleKey: 'preset.importTitle',
    titleFallback: '프리셋 가져오기',
    bodyHtml: `<textarea id="preset-import-code" class="preset-share-textarea" data-i18n-placeholder="preset.importPlaceholder" placeholder="${t('preset.importPlaceholder', '공유받은 코드를 붙여넣으세요')}"></textarea>`,
    footerHtml: `<button id="preset-import-confirm-btn" class="preset-modal-primary-btn" data-i18n="preset.importConfirm">${t('preset.importConfirm', '가져오기')}</button>`
  });

  document.getElementById('preset-import-confirm-btn').addEventListener('click', confirmImportPreset);

  return modal;
}

function openPresetImportModal() {
  const modal = ensurePresetImportModal();
  document.getElementById('preset-import-code').value = '';
  modal.classList.add('active');
  document.getElementById('preset-import-code').focus();
}

function ensurePresetOverwriteModal() {
  let modal = document.getElementById('preset-overwrite-modal');
  if (modal) return modal;

  modal = createSimpleModal('preset-overwrite-modal', {
    windowClass: 'preset-share-window',
    titleKey: 'preset.noticeTitle',
    titleFallback: '안내',
    bodyHtml: `
      <p class="preset-notice-message" data-i18n="preset.overwriteConfirm">이 프리셋을 덮어쓰시겠습니까?</p>
      <div class="preset-overwrite-compare">
        <div class="preset-overwrite-col">
          <div class="preset-overwrite-col-title" id="preset-overwrite-old-name"></div>
          <ul class="preset-overwrite-channel-list" id="preset-overwrite-old-list"></ul>
        </div>
        <div class="preset-overwrite-arrow">→</div>
        <div class="preset-overwrite-col">
          <div class="preset-overwrite-col-title" id="preset-overwrite-new-name"></div>
          <ul class="preset-overwrite-channel-list" id="preset-overwrite-new-list"></ul>
        </div>
      </div>
    `,
    footerHtml: `
      <button id="preset-overwrite-cancel-btn" class="preset-modal-cancel-btn" data-i18n-title="preset.cancel" title="${t('preset.cancel', '취소')}">✕</button>
      <button id="preset-overwrite-confirm-btn" class="preset-modal-primary-btn" data-i18n="preset.overwriteButton">${t('preset.overwriteButton', '덮어쓰기')}</button>
    `
  });

  document.getElementById('preset-overwrite-cancel-btn').addEventListener('click', () => modal.classList.remove('active'));

  return modal;
}

// "채널 추가" 모달의 칩(.preset-selected-chip)을 그대로 재사용한다 —
// 비슷하게 따로 만든 CSS를 유지하면 두 곳이 미묘하게 어긋날 수 있으니,
// 아예 같은 클래스를 써서 항상 물리적으로 동일하게 보이도록 한다.
function renderPresetOverwriteChannelList(listEl, channels) {
  listEl.innerHTML = '';
  (channels || []).forEach(ch => {
    const li = document.createElement('li');
    li.className = 'preset-selected-chip';
    li.style.setProperty('--item-color', getPlatformColor(ch.platform));
    li.textContent = ch.name || ch.hash;
    listEl.appendChild(li);
  });
}

// 기존 프리셋(existingPreset)과 새로 가져온 프리셋(newPreset)의 스트리머
// 구성을 나란히 보여주고, 확인을 누르면 onConfirm으로 실제 덮어쓰기를
// 위임한다(이름이 같은 프리셋 두 개가 따로 생기는 대신 항상 하나만 남도록).
function showPresetOverwriteConfirm(existingPreset, newPreset, onConfirm) {
  const modal = ensurePresetOverwriteModal();
  document.getElementById('preset-overwrite-old-name').textContent = existingPreset.name;
  document.getElementById('preset-overwrite-new-name').textContent = newPreset.name;
  renderPresetOverwriteChannelList(document.getElementById('preset-overwrite-old-list'), existingPreset.channels);
  renderPresetOverwriteChannelList(document.getElementById('preset-overwrite-new-list'), newPreset.channels);
  document.getElementById('preset-overwrite-confirm-btn').onclick = () => {
    modal.classList.remove('active');
    onConfirm();
  };
  modal.classList.add('active');
}

async function confirmImportPreset() {
  const codeInput = document.getElementById('preset-import-code');
  const decoded = await decodePresetShareCode(codeInput.value);
  if (!decoded) {
    showPresetNotice(t('preset.importFailed', '유효하지 않은 프리셋 코드입니다.'));
    return;
  }

  const existing = presets.find(p => p.name === decoded.name);
  if (existing) {
    showPresetOverwriteConfirm(existing, decoded, () => {
      existing.color = decoded.color;
      existing.channels = decoded.channels;
      savePresetsToStorage();
      renderPresets();
      document.getElementById('preset-import-modal').classList.remove('active');
      document.getElementById('preset-modal')?.classList.remove('active');
      loadPreset(existing.id);
    });
    return;
  }

  const importedPreset = { id: Date.now(), name: decoded.name, color: decoded.color, channels: decoded.channels };
  presets.push(importedPreset);
  savePresetsToStorage();
  renderPresets();

  document.getElementById('preset-import-modal').classList.remove('active');
  document.getElementById('preset-modal')?.classList.remove('active');
  loadPreset(importedPreset.id);
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
    if (document.getElementById('audio-settings-panel')) {
      closeAudioSettingsPanel();
      return;
    }

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
    toggleSettingModal();
  } else if (e.key === '`') {
    toggleAudioSettingsPanel();
  } else if (e.key === '.') {
    toggleQueueSidebar();
  } else if (e.key === 'f' || e.key === 'F') {
    const noticeModal = document.getElementById('tag-notice-modal');
    if (noticeModal && noticeModal.classList.contains('active') && currentNoticeMode === 'following') {
      closeTagNoticeModal();
    } else {
      openList('following');
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

  const active = document.activeElement;
  const isChannelInputFocused = active === channelInput;

  if (isChannelInputFocused) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
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
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();

    toggleChannelVideoHidden(activeChatChannel);
  }
});

// 메인-서브 모드일 때는 (전체화면 여부와 상관없이) 방향키만으로 메인
// 채널을 순환 전환할 수 있다 — 오른쪽: 서브 목록 순서대로 다음(서브1→서브2→
// 서브3…), 왼쪽: 반대 방향(서브1→마지막 서브(-1번)→그 앞(-2번)…).
// 그리드 모드에는 "메인" 개념이 없으므로 대상이 아니다.
//
// setMainChannel은 이전 메인/새 메인의 배열 위치를 서로 swap하기
// 때문에(승격된 채널이 항상 옛 메인 자리를 차지), "현재 메인의 배열
// 인덱스 + 1"로 다음 대상을 고르면 다음 입력 때 방금 밀려난 옛
// 메인(=이제 서브가 된 채널) 쪽으로 되돌아가 버린다. 그래서 매 입력마다
// "현재 메인을 제외한 서브 목록"을 새로 계산하고, 방향키를 누른
// 누적 횟수(fsMainCycleStep)로 그 목록을 순회한다 — 실제 채널이
// 몇 번 승격되었든 목록 순서 자체(메인을 제외한 나머지끼리의 상대
// 순서)는 swap 한 쌍 외에는 바뀌지 않으므로 이 방식이면 항상 아직
// 승격되지 않은 다음 서브로 정확히 넘어간다.
let fsMainCycleStep = 0;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // 보이는 채널이 1개뿐이면 그리드 모드와 동일 취급되어(isMainSubTreatedAsGrid)
  // "메인" 개념이 없다 — 순환 전환 대상이 아니다. displayChannels에 화면
  // 숨김된 다른 채널이 남아있어도(오디오는 계속 재생 중) 화면에 보이는
  // 서브가 없으므로 넘어갈 이유가 없다.
  if (currentLayout !== 'main_sub' || isMainSubTreatedAsGrid()) return;

  const active = document.activeElement;
  const isTyping = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable
  );
  if (isTyping) return;
  if (!displayChannels) return;

  const subList = displayChannels.filter(c => c.hash !== mainChannel);
  if (subList.length === 0) return;

  e.preventDefault();
  e.stopPropagation();

  fsMainCycleStep += (e.key === 'ArrowRight' ? 1 : -1);
  const len = subList.length;
  const idx = fsMainCycleStep > 0
    ? (fsMainCycleStep - 1) % len
    : (len + (fsMainCycleStep % len)) % len;
  setMainChannel(subList[idx].hash);
});

function parseDirectInput(rawToken) {
  const str = (rawToken || '').trim();
  if (!str) return null;

  // 치지직 VOD(다시보기) — 채널이 아니라 특정 영상 하나를 가리킨다.
  const chzzkVodMatch = str.match(/chzzk\.naver\.com\/video\/(\d+)/);
  if (chzzkVodMatch) {
    return { platform: 'chzzk', id: chzzkVodMatch[1], isVod: true };
  }

  let chzzkCandidate = str;
  if (chzzkCandidate.includes('chzzk.naver.com/')) {
    const parts = chzzkCandidate.split('/');
    chzzkCandidate = parts[parts.length - 1].split('?')[0];
  }
  if (/^[a-f0-9]{32}$/i.test(chzzkCandidate)) {
    return { platform: 'chzzk', id: chzzkCandidate };
  }

  // 숲 VOD(vod.sooplive.com)는 제3자 iframe에서 재생 자체가 시작되지 않아
  // 지원하지 않는다(§ parsePageUrlToChannelRef와 동일한 이유). 다음 버전에서
  // 재검토.

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

// "r " 접두사(§addChannelFromInput, VOD_SEARCH_PREFIX_RE — 예전엔
// "/vod"·"/팽"이었다가 사용자 요청으로 "r"·"ㄱ"로 변경됨)가 맨 앞에
// 있으면 그 부분만 통째로 떼어 돌려준다 — 뒤쪽 키워드 파싱은 항상 이걸
// 뗀 나머지에 대해서만 이뤄져야, 접두사 유무와 무관하게 연관검색어
// 로직이 완전히 동일하게 동작한다.
const VOD_SEARCH_PREFIX_RE = /^(r|ㄱ)\s+/i;
function splitVodSearchPrefix(value) {
  const m = VOD_SEARCH_PREFIX_RE.exec(value);
  return m ? { vodPrefix: m[0], rest: value.slice(m[0].length) } : { vodPrefix: '', rest: value };
}

function getLastKeywordInfo(value) {
  const { vodPrefix, rest } = splitVodSearchPrefix(value);
  // 구분자는 쉼표(,)만 사용한다. 공백까지 구분자로 두면 'mori calliope'처럼
  // 띄어쓰기가 있는 채널명/검색어를 입력할 때마다 단어가 잘려서, 스페이스를
  // 누르는 순간 연관 검색어가 사라졌다가 다음 단어부터 새로 뜨는 문제가 있었다.
  const parts = rest.split(',').map(p => p.trim());
  const lastPart = parts.pop() || '';
  const validPreviousParts = parts.filter(p => p.length > 0);
  // vodPrefix는 여기(prefix)에 다시 붙여서 selectAutocompleteItem이 입력을
  // 다시 조립할 때(§selectAutocompleteItem) "r " 표시가 그대로 남게
  // 한다 — 아니면 자동완성 항목을 고르는 순간 vod 검색 모드가 풀려버린다.
  const prefix = vodPrefix + (validPreviousParts.length > 0 ? validPreviousParts.join(', ') + ', ' : '');
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
  channelInput.addEventListener('input', (e) => {
    if (e.data === ',' && !e.isComposing) {
      const pos = channelInput.selectionStart;
      const before = channelInput.value.slice(0, pos);
      const after = channelInput.value.slice(pos);
      if (!after.startsWith(' ')) {
        channelInput.value = before + ' ' + after;
        channelInput.setSelectionRange(pos + 1, pos + 1);
      }
    }

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

async function fetchAutocompleteItems(keyword) {
  const enabledPlatforms = Object.keys(PLATFORM_META)
    .filter(p => PLATFORM_META[p].enabled && PlatformAdapters[p]);

  if (enabledPlatforms.includes(currentSearchPlatformTab)) {
    return await PlatformAdapters[currentSearchPlatformTab].searchAutocomplete(keyword, 10);
  }

  // "@"로 시작하는 핸들 검색은 유튜브 전용 문법이다(§PlatformAdapters.youtube.searchAutocomplete
  // isHandleMode). 치지직/숲 자동완성은 핸들 개념이 없어 "@abc"를 그냥
  // 평범한 검색어로 취급해 사실상 무관한 결과를 내는데, 그게 다른
  // 플랫폼과 함께 관련성 점수로 섞이면(§mergeAutocompleteByRelevance)
  // 유튜브 핸들 캐시(§_matchedCachedHandles — 이미 확인된 핸들이라 가장
  // 신뢰도 높은 추천)가 우연히 점수가 더 높은 다른 플랫폼 결과에 밀려
  // 맨 위를 못 차지하는 경우가 있었다. 핸들 모드에서는 애초에 유튜브만
  // 조회해서 이 경쟁 자체를 없앤다.
  if (keyword.startsWith('@') && enabledPlatforms.includes('youtube')) {
    return await PlatformAdapters.youtube.searchAutocomplete(keyword, 10);
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

// ── 라이브 방송 오프라인 자동 감지 → 그리드에서 자동 삭제 ──────────────────
// VOD 재생 종료(§CHANNEL_VIDEO_ENDED 리스너)와 달리, 라이브 방송은 보통
// video 'ended' 이벤트가 발화하지 않고 그냥 화면이 멈추거나 사이트가 자체
// "방송 종료" 오버레이를 띄운다 — 그래서 여기서는 플랫폼 API로 주기적으로
// 라이브 상태를 다시 확인한다.
const LIVE_STATUS_POLL_INTERVAL_MS = 60000;
// 네트워크 순간 오류 한 번만으로 성급하게 지우지 않도록, 연속으로 이만큼
// "오프라인"으로 확인돼야 실제로 삭제한다.
const OFFLINE_CONFIRM_THRESHOLD = 2;
const offlineStreakByHash = {};
// 방송 종료 확정된 치지직 채널에 다시보기 선택 패널을 보여준 적 있는지 —
// 한 번 보여준 뒤엔 재조회하지 않고 그 상태를 유지한다(docs/vod-replay-architecture.md §3, §6).
const vodPickerShownByHash = {};
// 디버그 패널의 "방송 종료 시뮬레이션" 토글로 강제된 채널 — 실제 방송
// 종료를 기다리지 않고도 다시보기 패널을 테스트할 수 있게 한다. 이 Set에
// 있는 동안은 실제 라이브 상태를 폴링하지 않으므로(바로 아래
// pollLiveStatusAndAutoRemove), 진짜로는 아직 라이브라서 되돌려지는 일이
// 없다 — 토글을 다시 끌 때까지 시뮬레이션 상태가 그대로 유지된다.
const debugForcedEndedHashes = new Set();

async function checkChannelStillLive(ch) {
  // VOD(다시보기)는 hash가 채널 식별자가 아니라 특정 영상 번호라 라이브
  // 조회 API에 그대로 넣으면 항상 "없음"으로 나와 오프라인으로 오판, 곧바로
  // 자동 삭제돼버린다 — VOD는 CHANNEL_VIDEO_ENDED(video 'ended' 이벤트)로만
  // 종료를 판단한다.
  if (ch.isVod) return true;
  try {
    if (ch.platform === 'chzzk') {
      return await checkChzzkLiveByChannelId(ch.hash);
    }
    if (ch.platform === 'soop') {
      const found = await PlatformAdapters.soop.searchChannelById(ch.hash);
      return !!found;
    }
    if (ch.platform === 'youtube') {
      // 채널 hash가 아니라 특정 영상(videoId)을 그대로 고정해 추가한
      // 항목(hash === videoId)은 채널 라이브 재조회 대상이 아니다 —
      // 그런 항목은 CHANNEL_VIDEO_ENDED(video 'ended' 이벤트)로만 판단한다.
      if (!ch.videoId || ch.isPinnedVideoSlot || ch.hash === ch.videoId) return true;
      // _resolveByChannelId를 그대로 쓰지 않는다 — 그 /live 페이지 폴백이
      // 방송 종료 직후에도 한동안 예전 videoId를 그대로 돌려주는 지연 때문에
      // 실제로 끝난 방송을 계속 "라이브"로 오판해왔다(§PlatformAdapters.youtube._checkStillLive
      // 주석). null(조회 실패)이면 기존 정책대로 지우지 않는다.
      const stillLive = await PlatformAdapters.youtube._checkStillLive(ch.hash, ch.videoId);
      return stillLive === null ? true : stillLive;
    }
  } catch (e) {
    console.error(`[CHEESE EYES] ${ch.platform}:${ch.hash} 라이브 상태 확인 실패:`, e);
  }
  return true; // 알 수 없는 플랫폼이거나 확인 자체가 실패하면 지우지 않는다.
}

async function pollLiveStatusAndAutoRemove() {
  const snapshot = [...channels];
  for (const ch of snapshot) {
    // 디버그 패널에서 "방송 종료 시뮬레이션"을 켠 채널은 실제 라이브 상태를
    // 아예 재조회하지 않는다 — 그러지 않으면 여기서 곧 "아직 진짜로는
    // 라이브"임을 확인하고 방금 띄운 시뮬레이션 패널을 도로 걷어버린다.
    if (debugForcedEndedHashes.has(ch.hash)) continue;
    const stillLive = await checkChannelStillLive(ch);
    if (stillLive) {
      delete offlineStreakByHash[ch.hash];
      // 다시보기 패널을 보여준 뒤 방송이 재개된 경우 — 패널을 걷고 라이브
      // 화면으로 되돌린다(docs/vod-replay-architecture.md §4).
      if (vodPickerShownByHash[ch.hash]) hideVodPickerPanel(ch.hash);
      continue;
    }
    // 이미 다시보기 패널을 보여준 채널은 재조회/자동 삭제 대상에서 뺀다 —
    // 사용자가 고를 때까지 그 상태를 유지한다(§3, §6: 자동 재시도 없음).
    if (vodPickerShownByHash[ch.hash]) continue;
    const streak = (offlineStreakByHash[ch.hash] || 0) + 1;
    offlineStreakByHash[ch.hash] = streak;
    if (streak < OFFLINE_CONFIRM_THRESHOLD) continue;
    delete offlineStreakByHash[ch.hash];
    console.log(`[CHEESE EYES] ${ch.platform}:${ch.hash} 방송 종료 확정(연속 ${OFFLINE_CONFIRM_THRESHOLD}회 오프라인)`);
    // 버그 수정("방종했을 때 다시보기 목록이 안 뜬다"): 치지직 라이브 채널
    // (VOD 자체는 제외)이면 곧바로 지우지 않고 다시보기 선택 패널을 그
    // 자리에 띄운다(docs/vod-replay-architecture.md §3~§5). 이 분기는 같은
    // 채널의 영상 영역 위에 오버레이만 얹을 뿐 챗탭/채널 자체를 바꾸지
    // 않으므로, 아래 "챗탭이 열려있으면 보류" 게이트(채널이 통째로
    // 사라지거나 바뀌는 removeChannel/큐 교체용)보다 먼저 처리한다 — 게이트를
    // 그대로 거치게 두면 정작 사용자가 지금 보고 있는(챗탭이 열려있는)
    // 채널일수록 스트릭이 계속 리셋만 되고 패널이 영영 안 뜨는 문제가 있었다.
    if (ch.platform === 'chzzk' && !ch.isVod) {
      console.log(`[CHEESE EYES] ${ch.platform}:${ch.hash} 방송 종료 -> 다시보기 선택 패널 표시`);
      showVodPickerForChannel(ch);
      continue;
    }
    // 챗탭(라이브챗 없는 영상이면 댓글 패널)이 지금 이 채널을 보여주고
    // 있으면 화면에서 빼지 않는다(§CHANNEL_VIDEO_ENDED 리스너와 동일 규칙) —
    // 단순히 챗 사이드바가 열려 있다는 것만으로는(다른 채널 탭을 보는 중일
    // 수 있으므로) 부족하고, activeChatChannel이 정확히 이 채널이어야 한다.
    // 이 시점에만 검사하고 끝 — 다음 폴링 주기에 다시 오프라인이 확인되면
    // (스트릭은 이미 리셋됐으니 처음부터) 그때 챗탭 상태를 또 검사한다.
    if (chatVisible && activeChatChannel === ch.hash) {
      console.log(`[CHEESE EYES] ${ch.platform}:${ch.hash} 방송 종료 확정했지만 챗탭이 열려있어 처리 보류`);
      continue;
    }
    if (tryConsumeQueueForSlot(ch.hash)) {
      console.log(`[CHEESE EYES] ${ch.platform}:${ch.hash} 방송 종료 -> 대기열 영상으로 교체`);
      continue;
    }
    removeChannel(ch.hash);
  }
}

setInterval(() => {
  if (channels.length > 0) pollLiveStatusAndAutoRemove();
}, LIVE_STATUS_POLL_INTERVAL_MS);

// ── 방송 종료 후 다시보기(VOD) 선택 패널 ────────────────────────────────
// docs/vod-replay-architecture.md 참고. wrapper(§getOrCreateVideoWrapper)를
// 그대로 두고 그 안에 패널만 얹었다 지웠다 하는 방식이라, 감지 시점엔
// channels/displayChannels를 건드리지 않고(그리드 재계산 없음) 사용자가
// 실제로 VOD를 고른 순간에만 replaceVodChannelInPlace로 커밋한다.

function getOrCreateVodPickerPanel(wrapper) {
  let panel = wrapper.querySelector(':scope > .vod-picker-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'vod-picker-panel';
    wrapper.appendChild(panel);
  }
  wrapper.classList.add('vod-picker-active');
  return panel;
}

function formatVodDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}${t('vodPicker.minuteSuffix', '분')}`;
}

// "/vod" 검색 모달 카드 전용(§appendVodSearchModalItems) — 타일 오버레이
// 패널(§formatVodDuration)의 "37분" 식 표기는 좁은 공간용이라 그대로
// 두고, 이 모달은 초 단위까지 정확한 mm:ss(시간 있으면 h:mm:ss)로
// 보여준다.
function formatVodDurationClock(sec) {
  if (!sec && sec !== 0) return '';
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

function renderVodPickerLoading(wrapper) {
  const panel = getOrCreateVodPickerPanel(wrapper);
  panel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'vod-picker-header';
  header.textContent = t('vodPicker.ended', '방송이 종료되었습니다');
  panel.appendChild(header);

  const loading = document.createElement('div');
  loading.className = 'vod-picker-empty';
  loading.textContent = t('vodPicker.loading', '다시보기를 확인하는 중...');
  panel.appendChild(loading);

  panel.classList.add('visible');
}

function renderVodPickerEmpty(wrapper, ch) {
  const panel = getOrCreateVodPickerPanel(wrapper);
  panel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'vod-picker-header';
  header.textContent = t('vodPicker.ended', '방송이 종료되었습니다');
  panel.appendChild(header);

  const empty = document.createElement('div');
  empty.className = 'vod-picker-empty';

  const msg = document.createElement('div');
  msg.textContent = t('vodPicker.empty', '다시보기를 찾을 수 없습니다.');
  empty.appendChild(msg);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'vod-picker-refresh-btn';
  refreshBtn.textContent = t('vodPicker.refresh', '다시 확인');
  refreshBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showVodPickerForChannel(ch, { forceRefresh: true });
  });
  empty.appendChild(refreshBtn);

  panel.appendChild(empty);
  panel.classList.add('visible');
}

function renderVodPickerList(wrapper, ch, videos) {
  const panel = getOrCreateVodPickerPanel(wrapper);
  panel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'vod-picker-header';
  header.textContent = t('vodPicker.title', '다시보기 선택');
  panel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'vod-picker-list';
  // 패널이 타일 안에 떠 있는 오버레이라 목록이 넉넉히 커지면 스크롤이
  // 필요한데, overflow-y:auto만으로는 이 타일이 main_sub 모드의 스크롤
  // 컨테이너(§.main_sub-mode) 안에 있을 때 휠 이벤트가 바깥으로 새어나가
  // 페이지 전체가 같이 스크롤될 수 있다 — 기존 채널 자동완성 목록
  // (§positionAutocompleteList 근처)과 같은 패턴으로 휠을 직접 받아
  // 이 목록 안에서만 처리한다.
  list.addEventListener('wheel', (e) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    e.stopPropagation();
    list.scrollTop += e.deltaY;
  }, { passive: false });

  videos.forEach((video, index) => {
    const row = document.createElement('div');
    row.className = 'vod-picker-row';

    if (video.thumbnail) {
      const img = document.createElement('img');
      img.className = 'vod-picker-thumb';
      img.src = video.thumbnail;
      row.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'vod-picker-info';

    const title = document.createElement('div');
    title.className = 'vod-picker-title';
    // 정렬 기준이 LATEST라 목록의 첫 항목이 곧 가장 최근 방송의 다시보기다
    // (docs/vod-replay-architecture.md §5 "방금 끝난 그 방송" 강조).
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'vod-picker-latest-badge';
      badge.textContent = t('vodPicker.latestBadge', '최신');
      title.appendChild(badge);
    }
    title.appendChild(document.createTextNode(video.title || ch.name));
    info.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'vod-picker-sub';
    const parts = [];
    if (video.publishDate) parts.push(video.publishDate);
    const durationText = formatVodDuration(video.duration);
    if (durationText) parts.push(durationText);
    sub.textContent = parts.join(' · ');
    info.appendChild(sub);

    row.appendChild(info);

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const oldHash = ch.hash;
      replaceVodChannelInPlace(oldHash, {
        platform: 'chzzk',
        hash: String(video.videoNo),
        name: ch.name,
        title: video.title || ch.name,
        isVod: true,
        // 채널이 라이브였을 때는 hash 자체가 채널ID였다 — VOD로 바뀌기
        // 전 값을 넘겨받아 채널 홈 이동용으로 저장해둔다(§getChannelHomeUrl).
        channelId: ch.channelId || ch.hash
      });
      delete vodPickerShownByHash[oldHash];
    });

    list.appendChild(row);
  });

  panel.appendChild(list);
  panel.classList.add('visible');
}

function hideVodPickerPanel(hash) {
  delete vodPickerShownByHash[hash];
  const wrapper = videoWrapperMap.get(hash);
  if (!wrapper) return;
  wrapper.classList.remove('vod-picker-active');
  const panel = wrapper.querySelector(':scope > .vod-picker-panel');
  if (panel) panel.remove();
}

async function showVodPickerForChannel(ch, opts = {}) {
  const wrapper = videoWrapperMap.get(ch.hash);
  if (!wrapper) { removeChannel(ch.hash); return; }
  if (vodPickerShownByHash[ch.hash] && !opts.forceRefresh) return;
  vodPickerShownByHash[ch.hash] = true;

  renderVodPickerLoading(wrapper);
  const { items: videos } = await PlatformAdapters.chzzk.getChannelVideos(ch.hash, 10);

  // 조회하는 동안 채널이 그리드에서 사라졌거나(수동 삭제 등) 방송이 재개돼
  // 패널이 이미 걷혔으면 여기서 중단 — 결과를 뒤늦게 그려 넣지 않는다.
  if (!channels.some(c => c.hash === ch.hash)) return;
  const currentWrapper = videoWrapperMap.get(ch.hash);
  if (!currentWrapper || !currentWrapper.classList.contains('vod-picker-active')) return;

  if (videos.length === 0) {
    renderVodPickerEmpty(currentWrapper, ch);
    return;
  }
  renderVodPickerList(currentWrapper, ch, videos);
}

// 디버그 패널의 "방송 종료 시뮬레이션" 토글(§renderVodDebugSection)에서
// 호출한다 — 실제 방종을 기다리지 않고도 다시보기 패널을 켜고 끌 수 있게.
// on일 때 showVodPickerForChannel과 완전히 같은 함수를 타므로, 실사용
// 경로와 동일한 코드로 테스트된다(별도 목/스텁 아님).
function simulateBroadcastEnded(ch, on) {
  if (on) {
    debugForcedEndedHashes.add(ch.hash);
    if (ch.platform === 'chzzk' && !ch.isVod) {
      // showVodPickerForChannel은 wrapper를 못 찾으면 실사용 경로 기준으로
      // removeChannel까지 불러버린다(§showVodPickerForChannel) — 그건 "진짜
      // 방종인데 그릴 곳이 없으면 예전처럼 채널을 지운다"는 프로덕션 폴백이지,
      // 디버그 시뮬레이션에서 원하는 동작이 아니다(사용자가 테스트하려고 켠
      // 채널이 갑자기 사라지면 안 됨). 여기서는 wrapper가 있을 때만 호출하고,
      // 없으면 그냥 아무 것도 안 한다 — renderVodDebugSection의 "실제 상태"
      // 줄이 "타일을 찾을 수 없음"으로 그 이유를 보여준다.
      if (videoWrapperMap.get(ch.hash)) {
        showVodPickerForChannel(ch, { forceRefresh: true });
      }
    }
  } else {
    debugForcedEndedHashes.delete(ch.hash);
    hideVodPickerPanel(ch.hash);
  }
}

let autocompletePlatformHints = new Map();
// "r"·"ㄱ" 검색 전용 플랫폼 힌트 — autocompletePlatformHints와 달리
// 유튜브도 예외 없이 기록한다. autocompletePlatformHints가 유튜브를
// 일부러 빼는 이유(§selectAutocompleteItem)는 일반 채널 추가 플로우의
// "즉시 추가 시 라이브 여부를 강제 true로 본다"는 부작용을 피하기
// 위함인데, r 검색은 라이브 여부와 무관하게 채널만 찾으면 되므로 그
// 제약이 적용되면 안 된다 — 적용되면 유튜브 채널명으로 r 검색 시
// 힌트가 없어 기본값인 chzzk로 잘못 검색돼 목록이 안 뜨는 문제가 있었다.
let vodSearchPlatformHints = new Map();

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
  vodSearchPlatformHints.set(obj.text.trim(), obj.platform);
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

// ── "r 채널명" 검색 — 라이브 여부와 무관하게 그 채널의 다시보기(VOD)
// 목록을 모달로 보여준다(§addChannelFromInput). 치지직/유튜브를
// 지원한다(숲은 아직). 자동완성/연관검색어 자체는 손대지 않고
// (§getLastKeywordInfo), 최종 커밋 시점에만 동작이 갈린다.
let vodSearchModalToken = 0;

function ensureVodSearchModal() {
  let modal = document.getElementById('vod-search-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'vod-search-modal';
  modal.className = 'tag-notice-backdrop';
  modal.innerHTML = `
    <div class="tag-notice-window">
      <div class="tag-notice-header">
        <h3 id="vod-search-title">${t('vodPicker.title', '다시보기 선택')}</h3>
        <button class="tag-notice-close" id="vod-search-close-btn">✕</button>
      </div>
      <div class="tag-notice-body" id="vod-search-body"></div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('vod-search-close-btn').addEventListener('click', closeVodSearchModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeVodSearchModal();
  });
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('active')) return;
    if (e.key === 'Escape' || e.key === 'Esc') closeVodSearchModal();
  });

  return modal;
}

function closeVodSearchModal() {
  vodSearchModalToken++;
  vodSearchModalState = null;
  const modal = document.getElementById('vod-search-modal');
  if (modal) modal.classList.remove('active');
  const body = document.getElementById('vod-search-body');
  if (body) body.removeEventListener('scroll', onVodSearchModalScroll);
}

const VOD_SEARCH_SUPPORTED_PLATFORMS = ['chzzk', 'youtube'];

const YOUTUBE_HANDLE_CACHE_KEY = 'youtube_handle_search_cache';
const YOUTUBE_HANDLE_CACHE_MAX = 30;

function readYoutubeHandleCache() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([YOUTUBE_HANDLE_CACHE_KEY], (result) => {
        const cached = result && result[YOUTUBE_HANDLE_CACHE_KEY];
        resolve(Array.isArray(cached) ? cached : []);
      });
    } catch (e) { resolve([]); }
  });
}

// 핸들(@abc) 입력으로 "/vod" 모달이 실제로 열릴 만큼 정상 해석된 채널을
// 기억해 둔다 — 유튜브 자동완성 API는 핸들 완전일치를 잘 못 띄워주는
// 경우가 많아(§_resolveByHandleOrText가 이름 유사도 필터를 우회해서 겨우
// 찾아내는 사례들과 같은 이유), 한 번 성공적으로 찾은 핸들은 다음부터
// 로컬 캐시에서 바로 연관검색어로 추천해 준다(§PlatformAdapters.youtube.searchAutocomplete).
// count(입력 횟수)를 같이 저장해서, 여러 캐시 항목이 후보로 겹칠 때
// 많이 입력한 순으로 정렬할 수 있게 한다(§_matchedCachedHandles).
function rememberYoutubeHandle(handle, name, hash) {
  if (!handle || !hash) return;
  try {
    chrome.storage.local.get([YOUTUBE_HANDLE_CACHE_KEY], (result) => {
      const list = Array.isArray(result && result[YOUTUBE_HANDLE_CACHE_KEY]) ? result[YOUTUBE_HANDLE_CACHE_KEY] : [];
      const existing = list.find(e => e && e.handle && e.handle.toLowerCase() === handle.toLowerCase());
      const count = (existing && typeof existing.count === 'number' ? existing.count : 0) + 1;
      const filtered = list.filter(e => e && e.handle && e.handle.toLowerCase() !== handle.toLowerCase());
      filtered.unshift({ handle, name: name || handle, hash, count });
      chrome.storage.local.set({ [YOUTUBE_HANDLE_CACHE_KEY]: filtered.slice(0, YOUTUBE_HANDLE_CACHE_MAX) });
    });
  } catch (e) { console.warn('[CHEESE EYES] 유튜브 핸들 캐시 저장 실패:', e); }
}

const VOD_LIST_CACHE_KEY = 'vod_search_list_cache';
// 다시보기 목록은 새 방송으로 계속 바뀌므로 너무 오래 캐시를 쓰면 최신
// 항목을 놓친다 — §readFollowingCache와 같은 자릿수(수 분)로 짧게 둔다.
const VOD_LIST_CACHE_MAX_AGE_MS = 3 * 60 * 1000;
// 채널/탭 조합을 계속 옮겨다니면 무한정 쌓이는 걸 막는다.
const VOD_LIST_CACHE_MAX_ENTRIES = 20;

function vodListCacheKeyFor(platform, channelId, tab) {
  return `${platform}:${channelId}:${tab || ''}`;
}

// "/vod" 검색 모달(§loadVodSearchModalTab)에서 이미 불러온 적 있는
// 채널+탭 조합이면, 무한 스크롤로 지금까지 이어받은 전체 목록을 그대로
// 즉시 보여준다 — 같은 채널을 여러 번 열어보거나 탭을 왔다갔다 할 때마다
// 매번 네트워크로 다시 긁어오지 않기 위함.
function readVodListCache(platform, channelId, tab) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([VOD_LIST_CACHE_KEY], (result) => {
        const store = result && result[VOD_LIST_CACHE_KEY];
        const entry = store && store[vodListCacheKeyFor(platform, channelId, tab)];
        if (!entry || !Array.isArray(entry.items) || entry.items.length === 0
          || typeof entry.cachedAt !== 'number' || Date.now() - entry.cachedAt > VOD_LIST_CACHE_MAX_AGE_MS) {
          resolve(null);
          return;
        }
        resolve(entry);
      });
    } catch (e) { resolve(null); }
  });
}

// items는 그 채널+탭에서 무한 스크롤로 지금까지 누적된 전체 목록(첫
// 페이지만이 아니라)이다 — 다시 열었을 때 이어받은 지점 그대로 복원하기
// 위함(§vodSearchModalState.allItems).
function writeVodListCache(platform, channelId, tab, items, cursor, exhausted) {
  if (!items || items.length === 0) return;
  try {
    chrome.storage.local.get([VOD_LIST_CACHE_KEY], (result) => {
      const store = (result && result[VOD_LIST_CACHE_KEY]) || {};
      const key = vodListCacheKeyFor(platform, channelId, tab);
      store[key] = { items, cursor, exhausted, cachedAt: Date.now() };
      const keys = Object.keys(store);
      if (keys.length > VOD_LIST_CACHE_MAX_ENTRIES) {
        // 가장 오래된(cachedAt이 가장 작은) 것부터 정리 — LRU에 가깝게.
        keys.sort((a, b) => (store[a].cachedAt || 0) - (store[b].cachedAt || 0));
        delete store[keys[0]];
      }
      chrome.storage.local.set({ [VOD_LIST_CACHE_KEY]: store });
    });
  } catch (e) { console.warn('[CHEESE EYES] 다시보기 목록 캐시 저장 실패:', e); }
}

// token 하나("r " 뗀 뒤의 채널명 또는 채널 URL/해시 하나)를 실제
// 채널(치지직/유튜브)로 풀어서 다시보기 목록 모달을 띄운다. 다른
// 플랫폼으로 풀리면(자동완성에서 숲을 골랐거나, 그 이름으로 못 찾으면)
// 아직 지원하지 않는다는 안내만 띄운다.
async function resolveAndOpenVodSearchModal(token) {
  const direct = parseDirectInput(token);
  if (direct) {
    if (!VOD_SEARCH_SUPPORTED_PLATFORMS.includes(direct.platform)) {
      showPlatformNotice(t('vodSearch.chzzkOnlyNotice', '지금은 r(또는 ㄱ) 검색이 치지직/유튜브 채널만 지원합니다.'));
      return;
    }
    if (direct.platform === 'chzzk' && direct.isVod) {
      // 이미 특정 다시보기 영상 하나를 가리키는 URL이면 목록을 보여줄
      // 필요 없이 그 영상을 바로 추가한다(§parseDirectInput, addChannelFromInput
      // 의 일반 경로와 동일한 처리).
      commitChannels([{ platform: 'chzzk', hash: direct.id, name: direct.id, isVod: true }]);
      return;
    }
    if (direct.platform === 'youtube') {
      // parseDirectInput은 유튜브 영상 URL도 채널 URL/핸들도 똑같이
      // { platform:'youtube', id }로만 돌려준다(§parseDirectInput) — id
      // 형태로 구분한다. 채널ID(UC...)/핸들(@...)이 아니면 영상 하나를
      // 직접 가리키는 것으로 보고 바로 추가한다.
      const looksLikeChannelRef = /^UC[a-zA-Z0-9_-]{22}$/.test(direct.id) || direct.id.startsWith('@');
      if (!looksLikeChannelRef) {
        const meta = await PlatformAdapters.youtube._resolveVideoMeta(direct.id);
        commitChannels([{
          platform: 'youtube',
          hash: direct.id,
          videoId: direct.id,
          name: (meta && meta.channelName) || direct.id,
          title: (meta && meta.title) || '',
          channelId: (meta && meta.channelId) || null,
          isPinnedVideoSlot: true,
          isVod: true
        }]);
        return;
      }
    }
    const channelData = await getAdapter(direct.platform).getChannelById(direct.id);
    if (channelData && channelData.hash) {
      // 핸들(@abc)로 직접 입력해서 모달이 실제로 열릴 만큼(=진짜 채널ID까지
      // 확보) 정상 해석된 경우만 기억해 둔다 — 해석 실패 폴백
      // (§PlatformAdapters.youtube.getChannelById)은 hash가 핸들 문자열
      // 그대로라 UC... 패턴이 아니므로 여기 안 걸린다.
      if (direct.platform === 'youtube' && direct.id.startsWith('@') && /^UC[a-zA-Z0-9_-]{22}$/.test(channelData.hash)) {
        rememberYoutubeHandle(direct.id, channelData.name, channelData.hash);
      }
      openVodSearchModal(direct.platform, channelData.hash, channelData.name || direct.id);
    }
    return;
  }

  const hintPlatform = vodSearchPlatformHints.get(token);
  if (hintPlatform && !VOD_SEARCH_SUPPORTED_PLATFORMS.includes(hintPlatform)) {
    showPlatformNotice(t('vodSearch.chzzkOnlyNotice', '지금은 r(또는 ㄱ) 검색이 치지직/유튜브 채널만 지원합니다.'));
    return;
  }
  const platform = VOD_SEARCH_SUPPORTED_PLATFORMS.includes(hintPlatform) ? hintPlatform : 'chzzk';

  try {
    const channelData = await getAdapter(platform).searchChannelByName(token);
    if (channelData && channelData.hash) {
      openVodSearchModal(platform, channelData.hash, channelData.name || token);
    } else {
      showPlatformNotice(t('vodSearch.notFoundNotice', '"{name}" 채널을 찾을 수 없습니다.', { name: token }));
    }
  } catch (err) {
    console.error(`'${token}' ${platform} 채널 검색 실패(/vod):`, err);
    showPlatformNotice(t('vodSearch.notFoundNotice', '"{name}" 채널을 찾을 수 없습니다.', { name: token }));
  }
}

// 모달이 열려있는 동안의 무한 스크롤 상태 — 채널/플랫폼별로 다음 페이지를
// 어디서부터 이어받을지(cursor), 지금 로딩 중인지, 더 없는지를 들고
// 있는다. 모달을 다시 열 때마다(§openVodSearchModal) 새로 만든다.
let vodSearchModalState = null;

// 유튜브 전용 — 채널의 "다시보기(VOD)"와 "채널 영상"을 같은 모달 안에서
// 탭으로 전환해서 볼 수 있게 한다(치지직은 애초에 이 엔드포인트 하나가
// 다시보기 목록이라 탭이 필요 없음). "/vod" 검색의 주 목적은 다시보기라
// streams를 기본 탭으로 연다.
const YOUTUBE_VOD_MODAL_TABS = [
  { key: 'streams', labelKey: 'vodPicker.tabStreams', labelDefault: '다시보기(VOD)' },
  { key: 'videos', labelKey: 'vodPicker.tabVideos', labelDefault: '채널 영상' }
];

async function openVodSearchModal(platform, channelId, channelName) {
  const modal = ensureVodSearchModal();
  const titleEl = document.getElementById('vod-search-title');
  const myToken = ++vodSearchModalToken;

  titleEl.textContent = `${channelName} - ${t('vodPicker.title', '다시보기 선택')}`;
  // 제목 색/탭 강조색/카드 배경(§dashboard.css .vod-search-modal-row,
  // .vod-search-modal-tabs)이 전부 --tab-color를 참조하도록 돼 있어,
  // 모달 최상단에서 한 번만 채널의 실제 플랫폼 색으로 지정해두면
  // 나머지는 CSS 상속으로 자동으로 맞춰진다(치지직은 초록, 유튜브는
  // 빨강 — 손대기 전엔 항상 --platform-default 기본값(초록)으로만
  // 보였다).
  modal.style.setProperty('--tab-color', getPlatformColor(platform));
  modal.classList.add('active');

  const defaultTab = platform === 'youtube' ? 'streams' : null;
  await loadVodSearchModalTab(platform, channelId, channelName, defaultTab, myToken);
}

// 탭(또는 최초 진입) 전환 시 목록을 새로 불러와 렌더링한다. openVodSearchModal과
// 탭 클릭 핸들러 양쪽에서 공유하는 로직이라 따로 뺐다 — 무한 스크롤 상태
// (vodSearchModalState)도 여기서 새로 만든다.
async function loadVodSearchModalTab(platform, channelId, channelName, tab, myToken) {
  const body = document.getElementById('vod-search-body');
  body.innerHTML = '';

  if (platform === 'youtube') {
    const tabsBar = buildTabsBar(
      YOUTUBE_VOD_MODAL_TABS.map(tb => ({ key: tb.key, label: t(tb.labelKey, tb.labelDefault) })),
      tab,
      (newTab) => {
        if (!vodSearchModalState || vodSearchModalState.tab === newTab) return;
        loadVodSearchModalTab(platform, channelId, channelName, newTab, ++vodSearchModalToken);
      },
      'vod-search-modal-tabs'
    );
    body.appendChild(tabsBar);
  }

  vodSearchModalState = {
    token: myToken, platform, channelId, channelName, tab,
    cursor: platform === 'chzzk' ? 0 : null,
    loading: true, exhausted: false, count: 0, list: null, autoFillAttempts: 0, allItems: []
  };

  // 캐시에 이 채널+탭 조합이 있으면(§writeVodListCache) 네트워크 요청 없이
  // 지금까지 이어받은 목록 그대로 바로 렌더링한다.
  const cached = await readVodListCache(platform, channelId, tab);
  if (vodSearchModalToken !== myToken) return;
  if (cached) {
    const list = document.createElement('div');
    list.className = 'vod-search-modal-list';
    body.appendChild(list);

    vodSearchModalState.list = list;
    vodSearchModalState.loading = false;
    vodSearchModalState.cursor = cached.cursor;
    vodSearchModalState.exhausted = cached.exhausted;
    vodSearchModalState.allItems = cached.items;
    appendVodSearchModalItems(list, channelName, cached.items, channelId, platform, 0, tab);
    vodSearchModalState.count = cached.items.length;

    body.removeEventListener('scroll', onVodSearchModalScroll);
    body.addEventListener('scroll', onVodSearchModalScroll);
    maybeAutoLoadMoreVodSearchModalResults();
    return;
  }

  const loadingEl = document.createElement('div');
  loadingEl.className = 'tag-notice-empty';
  loadingEl.textContent = t('vodPicker.loading', '다시보기를 확인하는 중...');
  body.appendChild(loadingEl);

  const { items, nextCursor } = await getAdapter(platform).getChannelVideos(channelId, 20, vodSearchModalState.cursor, tab);
  if (vodSearchModalToken !== myToken) return; // 그 사이 닫혔거나 다른 검색/탭으로 넘어갔으면 중단.

  loadingEl.remove();
  if (!items || items.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'tag-notice-empty';
    emptyEl.textContent = t('vodPicker.empty', '다시보기를 찾을 수 없습니다.');
    body.appendChild(emptyEl);
    vodSearchModalState.exhausted = true;
    return;
  }

  const list = document.createElement('div');
  list.className = 'vod-search-modal-list';
  body.appendChild(list);

  vodSearchModalState.list = list;
  vodSearchModalState.loading = false;
  vodSearchModalState.cursor = nextCursor;
  vodSearchModalState.exhausted = nextCursor === null;
  vodSearchModalState.allItems = items;
  appendVodSearchModalItems(list, channelName, items, channelId, platform, vodSearchModalState.count, tab);
  vodSearchModalState.count += items.length;
  writeVodListCache(platform, channelId, tab, items, nextCursor, nextCursor === null);

  body.removeEventListener('scroll', onVodSearchModalScroll);
  body.addEventListener('scroll', onVodSearchModalScroll);

  // 첫 페이지(20개)가 모달이 커질 수 있는 최대 높이(80vh)보다 작은
  // 화면에서는, 모달이 그냥 내용만큼 커져버려서 스크롤할 게 아예 안
  // 생긴다 — 그러면 스크롤 이벤트 자체가 안 일어나 무한 스크롤이 영영
  // 발동을 못 한다(실사용에서 확인된 증상: scrollHeight===clientHeight).
  // 그래서 렌더링 직후 실제로 넘치는 상태인지 확인해서, 안 넘치면
  // 스크롤 가능해지거나(모달이 꽉 참) 더 없을 때까지 자동으로 이어
  // 불러온다.
  maybeAutoLoadMoreVodSearchModalResults();
}

// 스크롤이 바닥 근처(200px 이내)에 닿으면 다음 페이지를 이어붙인다.
function onVodSearchModalScroll(e) {
  const body = e.target;
  if (body.scrollHeight - body.scrollTop - body.clientHeight > 200) return;
  loadMoreVodSearchModalResults();
}

function maybeAutoLoadMoreVodSearchModalResults() {
  const state = vodSearchModalState;
  if (!state || state.loading || state.exhausted || !state.list) return;
  const body = document.getElementById('vod-search-body');
  if (!body || body.scrollHeight > body.clientHeight) return; // 이미 스크롤 가능 — 자동으로 더 불러올 필요 없음.
  // 혹시라도 계속 안 넘치는 이상 상태(빈 썸네일 등)에서 끝없이 이어받지
  // 않도록 자동 이어받기 횟수를 안전장치로 제한한다 — 이 이상이면
  // 이례적인 상황이라 사용자가 직접 스크롤/재시도하게 둔다.
  if (state.autoFillAttempts >= 10) return;
  state.autoFillAttempts++;
  loadMoreVodSearchModalResults();
}

async function loadMoreVodSearchModalResults() {
  const state = vodSearchModalState;
  if (!state || state.loading || state.exhausted) return;
  state.loading = true;
  const footer = document.createElement('div');
  footer.className = 'vod-search-modal-loading-more';
  footer.textContent = t('chat.commentsLoadingMore', '더 불러오는 중...');
  state.list.parentElement.appendChild(footer);

  const myToken = state.token;
  const { items, nextCursor } = await getAdapter(state.platform).getChannelVideos(state.channelId, 20, state.cursor, state.tab);
  footer.remove();
  if (vodSearchModalToken !== myToken || vodSearchModalState !== state) return; // 그 사이 모달이 닫혔거나 다른 검색으로 넘어감.

  state.loading = false;
  state.cursor = nextCursor;
  state.exhausted = nextCursor === null || items.length === 0;
  if (items.length === 0 || !state.list) return;
  appendVodSearchModalItems(state.list, state.channelName, items, state.channelId, state.platform, state.count, state.tab);
  state.count += items.length;
  state.allItems = (state.allItems || []).concat(items);
  // 지금까지 이어받은 전체 목록으로 캐시를 다시 써서(§writeVodListCache),
  // 다음에 이 채널+탭을 열 때 여기까지 불러온 상태 그대로 즉시 보여준다.
  writeVodListCache(state.platform, state.channelId, state.tab, state.allItems, state.cursor, state.exhausted);
  // 방금 이어붙인 뒤에도 여전히 안 넘치면(20개씩 더해도 화면이 워낙
  // 큰 경우) 다시 확인해서 계속 이어간다.
  maybeAutoLoadMoreVodSearchModalResults();
}

function appendVodSearchModalItems(list, channelName, videos, channelId, platform, startIndex, tab) {
  videos.forEach((video, i) => {
    const index = startIndex + i;
    // .vod-picker-row(가로 배치)는 타일 안에 뜨는 좁은 오버레이 패널용이라
    // 그대로 재사용하면 4열 그리드에 안 맞는다 — 이 모달 전용으로 썸네일이
    // 위, 텍스트가 아래인 세로 카드 레이아웃을 따로 쓴다(§dashboard.css
    // .vod-search-modal-row).
    const row = document.createElement('div');
    row.className = 'vod-search-modal-row';

    if (video.thumbnail) {
      const img = document.createElement('img');
      img.className = 'vod-search-modal-thumb';
      img.src = video.thumbnail;
      row.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'vod-picker-info';

    const title = document.createElement('div');
    title.className = 'vod-picker-title';
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'vod-picker-latest-badge';
      badge.textContent = t('vodPicker.latestBadge', '최신');
      title.appendChild(badge);
    }
    title.appendChild(document.createTextNode(video.title || channelName));
    info.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'vod-picker-sub';
    const parts = [];
    if (video.publishDate) parts.push(video.publishDate);
    const durationText = formatVodDurationClock(video.duration);
    if (durationText) parts.push(durationText);
    sub.textContent = parts.join(' · ');
    info.appendChild(sub);

    row.appendChild(info);

    row.addEventListener('click', () => {
      // 치지직은 videoNo, 유튜브는 videoId 필드로 영상을 식별한다
      // (§PlatformAdapters.chzzk/youtube.getChannelVideos).
      const videoIdentifier = String(video.videoNo ?? video.videoId);
      commitChannels([platform === 'youtube' ? {
        platform: 'youtube',
        hash: videoIdentifier,
        videoId: videoIdentifier,
        name: channelName,
        title: video.title || channelName,
        // 채널 홈 이동 버튼/구독 채널 판별용.
        channelId,
        isPinnedVideoSlot: true,
        isVod: true,
        // hasLiveChat을 실시간 판정(ensureYoutubeHasLiveChat)에 맡기지 않고
        // 이 모달의 탭 구분을 그대로 믿는다 — "채널 영상(videos)" 탭에는
        // 프리미어로 올린 편집 영상처럼, 순수 업로드인데도 유튜브 자체
        // conversationBar에 채팅 다시보기가 실제로 남아있는 경우가 있다
        // (실사용으로 확인됨). 모달이 이미 "다시보기(streams)"와
        // "채널 영상(videos)"으로 정확히 나눠서 보여주고 있으므로, 그
        // 사용자 의도를 그대로 존중해 videos 탭에서 고른 건 무조건
        // 댓글만 보여준다.
        hasLiveChat: tab === 'streams'
      } : {
        platform: 'chzzk',
        hash: videoIdentifier,
        name: channelName,
        title: video.title || channelName,
        isVod: true,
        // 채널 홈으로 이동 버튼용(§PlatformAdapters.chzzk.getChannelHomeUrl) —
        // hash는 이 영상의 videoNo라 채널ID로 못 쓴다.
        channelId
      }]);
      closeVodSearchModal();
    });

    list.appendChild(row);
  });
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
  const queries = [keyword];
  const dataLists = await Promise.all(queries.map(async (q) => {
    try {
      const res = await apiFetch(`https://api.chzzk.naver.com/service/v1/search/channels?keyword=${encodeURIComponent(q)}&offset=0&size=20&withFirstChannelContent=true`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.content && data.content.data ? data.content.data : [];
    } catch (e) { return []; }
  }));

  const seenChannelId = new Set();
  const rawChannels = [];
  dataLists.forEach(list => {
    list.forEach(entry => {
      const c = entry.channel;
      if (!c || !c.channelId || !c.channelName || seenChannelId.has(c.channelId)) return;
      seenChannelId.add(c.channelId);
      rawChannels.push(c);
    });
  });

  const checked = await Promise.all(rawChannels.map(async (c) => {
    try {
      const detailRes = await apiFetch(`https://api.chzzk.naver.com/service/v2/channels/${c.channelId}/live-detail`);
      if (!detailRes.ok) return null;
      const detail = await detailRes.json();
      const content = detail && detail.content;
      if (!content || content.status !== 'OPEN') return null;
      const viewersNum = typeof content.concurrentUserCount === 'number' ? content.concurrentUserCount : null;
      if (viewersNum != null && viewersNum < getMinViewers('chzzk')) return null;
      return {
        platform: 'chzzk',
        hash: c.channelId,
        name: c.channelName,
        title: content.liveTitle || '',
        thumbnail: content.liveImageUrl ? content.liveImageUrl.replace('{type}', '270') : '',
        viewersText: viewersNum != null ? viewersNum.toLocaleString() : ''
      };
    } catch (e) { return null; }
  }));

  return checked.filter(Boolean);
}

async function fetchSoopLiveCandidatesByName(keyword) {
  const queries = [keyword];
  const seenId = new Set();
  const results = [];
  for (const q of queries) {
    const list = await PlatformAdapters.soop._liveSearch(q, { count: 20 });
    const kw = String(q || '').trim().toLowerCase();
    list.forEach(raw => {
      const ch = PlatformAdapters.soop._toChannelData(raw);
      if (!ch || seenId.has(ch.hash)) return;
      if (kw && !String(ch.name || '').toLowerCase().includes(kw)) return;
      const viewers = raw.total_view_cnt ?? raw.view_cnt ?? raw.m_current_view_cnt;
      const viewersNum = viewers != null ? Number(viewers) : null;
      if (viewersNum != null && !isNaN(viewersNum) && viewersNum < getMinViewers('soop')) return;
      seenId.add(ch.hash);
      results.push({
        ...ch,
        title: raw.broad_title || raw.title || '',
        thumbnail: raw.broad_img || raw.thumbnail || '',
        viewersText: viewersNum != null ? viewersNum.toLocaleString() : ''
      });
    });
  }
  return results;
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
  row.addEventListener('click', () => {
    if (row.parentElement && row.parentElement.classList.contains('has-dragged')) return;
    onToggle(row);
  });

  return row;
}

let currentLiveConfirmPlatformTab = 'all';
let currentLiveConfirmKeywordTab = 'all';

function buildKeywordTabsBar(activeTab, onSelect) {
  const tabs = [
    { key: 'all', label: t('platformTabs.all', '전체') },
    ...liveConfirmSections.map(section => ({ key: section.keyword, label: section.keyword }))
  ];
  return buildTabsBar(tabs, activeTab, onSelect, 'search-keyword-tabs');
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

// 이미 그리드에 있는 채널의 iframe만 새로 불러오게 강제한다(디스플레이
// 배열상의 위치는 건드리지 않는다 — videoWrapperMap에서만 지워서, 다음
// renderVideo()가 지금 배열 순서 그대로 그 자리에 새 iframe을 만들게 한다).
// getOrCreateVideoWrapper()는 이미 videoWrapperMap에 있으면 그대로
// 재사용하므로, 최신 데이터(예: 새로 갱신된 유튜브 videoId)를 실제로
// 반영하려면 이렇게 먼저 비워둬야 한다.
function refreshChannelVideoWrapper(hash) {
  const wrapper = videoWrapperMap.get(hash);
  if (!wrapper) return;
  const iframe = wrapper.querySelector('iframe');
  if (iframe) iframe.src = 'about:blank';
  wrapper.remove();
  videoWrapperMap.delete(hash);
}

function commitChannels(channelDataList) {
  let hasAdded = false;
  let hasRefreshed = false;
  channelDataList.forEach(ch => {
    if (!ch || !ch.hash) return;

    // 라이브 채널은 그 플랫폼에 로그인이 돼 있어야 추가할 수 있다(VOD는
    // 예외 — §getUsedLivePlatformsFromChannels 주석). 로그인 여부가 이미
    // 확인된 상태(cachedAccountInfo가 채워짐)라면 여기서 바로 걸러 알림을
    // 띄운다 — 계정 충돌(다른 곳에서 이미 사용 중) 쪽은 서버 확인이 필요해
    // reconcileInstanceLock이 추가 이후 비동기로 처리한다(§commitChannels
    // 호출 뒤 saveChannelsToStorage가 트리거).
    if (!ch.isVod && cachedAccountInfo && !cachedAccountInfo.some((info) => info.platform === ch.platform)) {
      notifyPlatformLoginRequired(ch.platform);
      return;
    }

    const existingChannel = channels.find(c => c.platform === ch.platform && c.hash === ch.hash);
    if (existingChannel) {
      // 이미 그리드에 있는 채널을 다시 담은 경우 — 특히 유튜브는 시간이
      // 지나면 이전에 저장해둔 videoId가 무효해질 수 있는데, 방금 새로
      // 조회한 최신 데이터가 있는데도 그냥 무시하고 끝내버리면(예전 동작)
      // 새로고침해도 계속 "이 동영상을 재생할 수 없습니다"로 남는다.
      // 배열상 위치는 그대로 두고 최신 값만 반영한 뒤 그 채널의 화면만
      // 다시 불러온다.
      let needsRefresh = false;
      if (ch.platform === 'youtube' && ch.videoId && ch.videoId !== existingChannel.videoId) {
        existingChannel.videoId = ch.videoId;
        needsRefresh = true;
      }
      if (ch.platform === 'soop' && ch.broadNo && ch.broadNo !== existingChannel.broadNo) {
        existingChannel.broadNo = ch.broadNo;
        needsRefresh = true;
      }
      const displayChannel = displayChannels.find(c => c.platform === ch.platform && c.hash === ch.hash);
      if (displayChannel && displayChannel !== existingChannel) {
        displayChannel.videoId = existingChannel.videoId;
        displayChannel.broadNo = existingChannel.broadNo;
      }
      if (needsRefresh) {
        refreshChannelVideoWrapper(existingChannel.hash);
        hasRefreshed = true;
      }
      return;
    }

    const channelData = { platform: ch.platform, hash: ch.hash, name: ch.name };
    if (ch.broadNo) channelData.broadNo = ch.broadNo;
    if (ch.videoId) channelData.videoId = ch.videoId;
    if (ch.isVod) channelData.isVod = true;
    if (ch.title) channelData.title = ch.title;
    if (ch.channelId) channelData.channelId = ch.channelId;
    if (typeof ch.hasLiveChat === 'boolean') channelData.hasLiveChat = ch.hasLiveChat;
    if (ch.isPinnedVideoSlot) channelData.isPinnedVideoSlot = true;
    if (ch.platform === 'youtube') {
      console.log(`[CHEESE EYES][YT-DEBUG] commitChannels: ${ch.name}(${ch.hash}) videoId=${ch.videoId || '(없음)'}`);
    }

    channels.push(channelData);
    displayChannels.push(channelData);
    channelAddOrder.push(channelData.hash);
    hasAdded = true;
  });

  if (!hasAdded && !hasRefreshed) return;

  if (hasAdded) {
    if (!mainChannel) mainChannel = displayChannels[0].hash;
    if (!activeChatChannel) activeChatChannel = displayChannels[0].hash;
    saveChannelsToStorage();
  }

  renderAll();
}

// ── 사이드바(사이드패널)에서 "멀티뷰로 보내기"로 넘어온 채널 처리 ──────────
// background.js가 chrome.storage.session의 'pending_multiview_add'에 담아둔
// {platform,id,broadNo,title} 목록을, 수동 채널 추가(addChannelFromInput)와
// 동일한 방식(getAdapter().getChannelById)으로 실제 채널 데이터로 해석해
// commitChannels로 반영한다. 페이지 최초 로드 시와, 이미 열려 있는 대시보드
// 탭이 'MULTIVIEW_PENDING_ADD_READY' 브로드캐스트를 받았을 때 둘 다 호출된다.
async function processPendingMultiviewAdd() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;

  let data;
  try {
    data = await chrome.storage.session.get('pending_multiview_add');
  } catch (e) {
    return;
  }
  const items = data && data.pending_multiview_add;
  if (!items || items.length === 0) return;

  await chrome.storage.session.remove('pending_multiview_add');

  const resolved = [];
  // §addChannelFromInput의 offlineChzzkOnAdd와 동일한 이유 — 사이드바에서
  // 담아뒀던 채널이 그 사이 방송을 종료했을 수 있다.
  const offlineChzzkOnAdd = [];
  for (const item of items) {
    try {
      let channelData = null;
      if (item.isVod) {
        // VOD(다시보기)는 채널이 아니라 특정 영상 하나다 — 라이브 채널 조회
        // API를 호출하면 안 되므로(치지직은 존재하지 않는 채널로, 숲은
        // 라이브 검색으로 오인될 수 있다) 직접 채널 데이터를 구성한다.
        channelData = { platform: item.platform, hash: item.id, name: item.title || item.id, isVod: true };
      } else if (item.platform === 'soop' && item.broadNo) {
        channelData = { platform: 'soop', hash: item.id, broadNo: item.broadNo, name: item.title || item.id };
      } else {
        channelData = await getAdapter(item.platform).getChannelById(item.id);
        if (channelData && channelData.hash && item.platform === 'chzzk') {
          const isLive = await checkChzzkLiveByChannelId(channelData.hash);
          if (!isLive) offlineChzzkOnAdd.push(channelData);
        }
      }
      if (channelData && channelData.hash) resolved.push(channelData);
    } catch (err) {
      console.error('[CHEESE EYES] 사이드바에서 추가된 채널 처리 실패:', item, err);
    }
  }

  if (resolved.length > 0) {
    commitChannels(resolved);
    offlineChzzkOnAdd.forEach((ch) => showVodPickerForChannel(ch));
  }
}

// ── 사이드바(멀티뷰 트레이)에서 "대기열에 추가"로 넘어온 항목 처리 ──────────
// background.js가 chrome.storage.session의 'pending_queue_add'에 담아둔
// {platform:'youtube', id, title} 목록을 처리한다. 트레이에 담긴 id는
// 채널ID/videoId/handle 등 형태가 제각각일 수 있어(§background.js
// parsePageUrlToChannelRef) processPendingMultiviewAdd와 동일하게
// getChannelById로 먼저 해석해 실제 videoId를 얻은 뒤, 그 videoId를
// enqueueYoutubeVideo(대기열 추가 함수, §위)에 그대로 넘긴다 — 대기열은
// 지금 유튜브 videoId 기준으로만 동작하므로 치지직/숲 항목은 애초에
// background.js가 이 목록에 넣지 않는다.
async function processPendingQueueAdd() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;

  let data;
  try {
    data = await chrome.storage.session.get('pending_queue_add');
  } catch (e) {
    return;
  }
  const items = data && data.pending_queue_add;
  if (!items || items.length === 0) return;

  await chrome.storage.session.remove('pending_queue_add');

  for (const item of items) {
    try {
      const channelData = await getAdapter('youtube').getChannelById(item.id);
      if (channelData && channelData.videoId) {
        // getChannelById가 이미 채널명/제목을 정확히 알아낸 경우가 많다 —
        // enqueueYoutubeVideo 안의 _resolveVideoMeta가 별도로 실패해도
        // (§enqueueYoutubeVideo) 이 값들이 대신 쓰이도록 미리 넘긴다.
        await enqueueYoutubeVideo(null, channelData.videoId, channelData.title, channelData.name);
      }
    } catch (err) {
      console.error('[CHEESE EYES] 사이드바에서 대기열로 추가된 항목 처리 실패:', item, err);
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'MULTIVIEW_PENDING_ADD_READY') {
      processPendingMultiviewAdd();
    } else if (message && message.type === 'QUEUE_PENDING_ADD_READY') {
      processPendingQueueAdd();
    } else if (message && message.type === 'CHEESE_YT_NEWTAB_SUGGESTION' && message.videoId) {
      // background.js의 chrome.tabs.onCreated 최후 방어선(§background.js
      // interceptYoutubeSuggestionNewTab)이 페이지 JS 가로채기를 전부
      // 빠져나간 새 탭을 잡아 닫고 알려준 경우 — 다른 경로(postMessage
      // 체인의 YT_SUGGESTION_CLICKED)와 똑같이 대기열에 담는다.
      enqueueYoutubeVideo(null, message.videoId, undefined, undefined, true);
    }
  });
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

  // "r 채널명" — 라이브 채널을 바로 추가하는 대신 그 채널의 다시보기
  // (VOD) 목록을 모달로 보여준다. 연관검색어(자동완성) 자체는
  // getLastKeywordInfo/splitVodSearchPrefix가 접두사를 떼고 처리해서
  // 평소와 완전히 동일하게 동작한다 — 여기서는 최종 커밋 시점의 동작만
  // 갈라준다. 지금은 치지직/유튜브만 지원한다.
  const { vodPrefix, rest: vodStripped } = splitVodSearchPrefix(value);
  if (vodPrefix) {
    const vodTokens = vodStripped.split(',').map(t => t.trim()).filter(t => t.length > 0);
    channelInput.value = '';
    for (const token of vodTokens) {
      await resolveAndOpenVodSearchModal(token);
    }
    return;
  }

  // 구분자는 쉼표(,) 또는 "쉼표+공백" 만 허용한다. 공백만으로 나누면
  // '모리 칼리오페'처럼 띄어쓰기가 포함된 채널명/검색어가 '모리'와
  // '칼리오페'로 쪼개져 각각 검색되는 문제가 있었다.
  const rawTokens = value.split(',').map(t => t.trim()).filter(t => t.length > 0);

  const directChannels = [];
  const pendingKeywords = [];
  // 버그 수정("오프라인 라이브 채널을 불러오면 목록이 안 뜬다"): 라이브
  // 링크/해시를 직접 붙여넣었는데 실제로는 방송 중이 아닌 치지직 채널 —
  // 예전엔 라이브 여부 확인 없이 그냥 빈 화면으로 추가됐다. 방송 종료
  // 감지 때(§pollLiveStatusAndAutoRemove)와 동일하게, 추가는 그대로 하되
  // 커밋 직후 다시보기 선택 패널을 바로 띄운다.
  const offlineChzzkOnAdd = [];

  for (const token of rawTokens) {
    const direct = parseDirectInput(token);

    if (direct) {
      let channelData = null;
      if (direct.isVod) {
        // VOD(다시보기)는 채널이 아니라 특정 영상 하나다 — 라이브 채널 조회
        // API로 넘기면 안 된다(§processPendingMultiviewAdd와 동일한 이유).
        channelData = { platform: direct.platform, hash: direct.id, name: direct.id, isVod: true };
      } else if (direct.platform === 'soop' && direct.broadNo) {
        channelData = { platform: 'soop', hash: direct.id, broadNo: direct.broadNo, name: direct.id };
      } else {
        channelData = await getAdapter(direct.platform).getChannelById(direct.id);
        if (channelData && channelData.hash && direct.platform === 'chzzk') {
          const isLive = await checkChzzkLiveByChannelId(channelData.hash);
          if (!isLive) offlineChzzkOnAdd.push(channelData);
        }
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
    // commitChannels가 renderAll까지 동기적으로 끝내므로, 이 시점엔 타일
    // wrapper가 이미 만들어져 있다(§showVodPickerForChannel이 wrapper를
    // 요구함).
    offlineChzzkOnAdd.forEach((ch) => showVodPickerForChannel(ch));
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
  suppressVolumeEchoReports(2000);
  renderVideo();
  // 2026-08-16 후속 — 예전엔 합방 리더 판정 기준 자체가 레이아웃마다
  // 달라서(그리드: leaderHash/첫 멤버, 메인-서브: 메인 채널) 여기서
  // 즉시 재판정이 필요했다. 이제 대표는 레이아웃과 무관하게 항상
  // mainChannel이라(§getCollabLeaderHash) 순수 레이아웃 전환만으로는
  // 대표가 바뀌지 않으므로 이 재판정이 더 이상 필요 없다.
  // 모드 전환은 여러 채널의 기준 음량(그리드 100%/서브 30% 등)이 한꺼번에
  // 바뀌는 순간이라, 즉시 적용하면 소리가 뚝 끊기듯 튀어 보인다 — 부드럽게
  // 넘어가도록 한다.
  applyVolumeToAllChannels(true);
  renderAudioSettingsList();
  renderCollabSettingsSection();
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
  // mainChannel은 배열 인덱스가 아니라 hash로 추적되므로, 관계없는 두 채널의
  // 위치를 바꾼다고 해서 메인 채널이 바뀔 이유가 없다. 예전에는 여기서
  // displayChannels[0]을 강제로 메인으로 재할당해서, 서브 채널 2개만 스왑해도
  // 메인 채널이 바뀌고 그로 인해 나머지 서브 채널들 위치까지 덩달아 밀리는
  // 것처럼 보이는 버그가 있었다. mainChannel은 건드리지 않는다.

  saveChannelsToStorage();
  renderAll();
}

function setMainChannel(hash) {
  if (!hash || mainChannel === hash) return;

  // 화면 숨김으로 자동 승격된 임시 메인이 아니라 사용자가 다른 채널을
  // 직접 메인으로 지정한 경우다 — "화면 숨김이 풀리면 원래 메인으로
  // 되돌린다"는 자동 복귀 약속은 더 이상 유효하지 않으므로 취소한다.
  if (pendingMainRestoreHash && hash !== pendingMainRestoreHash && !suppressPendingMainInvalidate) {
    pendingMainRestoreHash = null;
  }

  const prevMainHash = mainChannel;

  // [CHEESE EYES] 예전엔 배열을 아예 건드리지 않고 mainChannel 값만
  // 바꿨다. 그런데 main-sub 서브 목록은 배열 순서를 그대로 filter해서
  // 그리기 때문에, "이전 메인"은 항상 자기가 원래 있던 자리(주로 0번)에
  // 그대로 남아버려서 서브로 내려가도 계속 맨 왼쪽에 고정되는 문제가
  // 있었다. 반대로 그 이전 버전은 새 메인을 무조건 0번으로 강제
  // 이동시켜서 채팅 탭 순서가 튀는 부작용이 있었다. 이번엔 "이전 메인"과
  // "새 메인" 딱 2개 채널의 배열 위치만 서로 swap한다 — 그 외 채널은
  // 위치가 전혀 바뀌지 않으므로 채팅 탭 순서도 이 두 채널만큼만 바뀐다.
  //
  // 2026-08-16 후속(사용자 지적: "그리드에서는 채널 클릭 시 메인 채널
  // 전환되도 디스플레이 배열 유지 (아니 도대체 왜 바뀐거지?)") — 이
  // swap은 원래 main_sub 전용으로 의미가 있는 동작이었는데(서브 목록
  // 순서 문제), 레이아웃 조건 없이 항상 실행되고 있었다. 예전엔
  // setMainChannel을 부르는 경로 자체가 main_sub에서만 열려 있어서
  // 무해했지만, 방금 대표=메인 통합(§getCollabLeaderHash)으로
  // 그리드에서도 프레임 클릭이 setMainChannel을 부르게 되면서 그리드
  // 타일까지 자리를 바꾸는 부작용이 드러났다. 그리드는 클릭 순서로
  // 타일이 재배치될 이유가 없으므로 main_sub에서만 돈다.
  if (prevMainHash && currentLayout === 'main_sub') {
    const swapPositions = (arr) => {
      const idxOld = arr.findIndex(c => c.hash === prevMainHash);
      const idxNew = arr.findIndex(c => c.hash === hash);
      if (idxOld !== -1 && idxNew !== -1 && idxOld !== idxNew) {
        const temp = arr[idxOld];
        arr[idxOld] = arr[idxNew];
        arr[idxNew] = temp;
      }
    };
    swapPositions(channels);
    swapPositions(displayChannels);
  }

  mainChannel = hash;
  suppressVolumeEchoReports(2000);

  // 2026-08-16 후속(사용자 지시: "메인 채널 == 대표 채널로 해, 기존
  // 그리드/메인-서브 레이아웃 설정을 그대로 따라 새로 설정하지 말고") —
  // 메인 채널은 이제 레이아웃과 무관하게 곧 합방 대표다(§getCollabLeaderHash).
  // 그래서 재판정도 예전처럼 main_sub에서만이 아니라 항상 돈다. leaderRadio
  // 변경과 마찬가지로, 이 대표 교체로 영향받는 그룹(이전/새 메인이 속한
  // 그룹)은 Stage2가 재확인할 때까지 keeper를 즉시 뒤집지 않게 표시해둔다
  // (§pickClusterKeeper, leaderChangedAtByGroupId).
  if (isCollabSettingEnabled()) {
    audioState.collabGroups.forEach((group) => {
      if (group.memberHashes.includes(prevMainHash) || group.memberHashes.includes(hash)) {
        leaderChangedAtByGroupId[group.id] = Date.now();
        // 2026-08-17 후속(사용자 지적: "vod 합방에서 재생/정지가 이상해
        // — 한쪽은 재생, 다른쪽은 정지 상태에서 재생 시점만 갱신"). 대표가
        // 바뀌면 이전 대표(prevMainHash)는 "대표"에서 "멤버" 역할로
        // 바뀔 수 있는데, vodSyncLastCommandedPlaying[hash]("마지막으로
        // 이 채널에 보낸 재생/정지 명령")는 그 채널이 예전에 멤버였을
        // 때의 낡은 값을 그대로 들고 있었다 — 새 대표의 현재 재생 상태와
        // 그 낡은 값이 우연히 같으면 "이미 보냈다"고 착각해 실제로는
        // 재생/정지 명령을 다시 안 보냈다(위치는 매번 새로 계산하는
        // 시크로는 맞지만 재생/정지 상태만 안 맞는 원인). 이 그룹이
        // vod-sync면 멤버 전원의 기록을 지워, 역할이 바뀐 직후엔 무조건
        // 한 번 다시 확인해서 보내게 한다.
        if (isVodSyncGroup(group)) {
          group.memberHashes.forEach((h) => { delete vodSyncLastCommandedPlaying[h]; });
        }
      }
    });
    recomputeCollabMuting();
    applyVolumeToAllChannels();
    renderCollabSettingsSection();
  }

  if (currentLayout === 'main_sub') {
    activeChatChannel = mainChannel;
    updateChatSession();
    renderAudioSettingsList();
  }

  saveChannelsToStorage();
  renderAll();
}

function setChatChannel(hash) {
  if (!hash) return;
  // 챗탭 자체가 없는 채널(치지직/숲 VOD)을 그리드에서 클릭해 선택해도
  // 채팅 패널은 건드리지 않는다 — 없는 탭으로 전환을 시도하면 iframe만
  // 만들고 탭은 없는 불일치 상태가 된다.
  const ch = getChannelObjByHash(hash);
  if (ch && !channelSupportsChatTab(ch)) return;
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

  try {
    // [CHEESE EYES] 유튜브는 videoId 조회가 browse -> /live 폴백까지 이어지는
    // 여러 단계 네트워크 요청이라 채널마다 완료 시점이 제각각이다. 기존
    // 코드는 while(iframeLoadQueue.length > 0) 구간이 "그 시점까지 큐에
    // 들어와 있던 항목"만 처리하고 끝나버려서, 그 구간을 빠져나간 직후
    // (Promise.all로 버퍼링 대기하는 동안 등)에 다른 채널의 videoId 조회가
    // 뒤늦게 끝나 큐에 추가되면 아무도 그 항목을 처리하지 않았다. 그 채널의
    // processIframeQueue() 재호출도 isProcessingQueue 가드에 막혀 조용히
    // 무시됐기 때문에, iframe.src가 끝까지 할당되지 않고 검은 화면으로
    // 남는 채널이 생겼다(원인 확인됨). 큐가 실제로 빌 때까지 바깥 루프로
    // 반복 처리해서 이 경합을 없앤다.
    while (true) {
      let currentDelay = QUEUE_CONFIG.initialDelay;
      const loadingPromises = [];

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

      // 처리하는 동안(특히 위 Promise.all 대기 중) 새로 들어온 항목이
      // 있으면 큐를 실제로 비울 때까지 바깥 루프를 계속 돈다.
      if (iframeLoadQueue.length === 0) break;
    }

  } catch (error) {
    console.error(`💥 [QUEUE ERROR] 큐 내부 예외 발생:`, error);
  } finally {
    isProcessingQueue = false;
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
      hash: item.hash || iframe.getAttribute('data-hash') || `채널 #${i + 1}`,
      // relay.html(유튜브)인지 구분 — 아래 SET_VOLUME/PLAY 중복 전송을
      // 스킵할지 판단하는 데 쓴다.
      isYoutube: iframe.closest('.video-wrapper')?.getAttribute('data-platform') === 'youtube'
    };
  }

  requestAnimationFrame(() => {
    const triggerStart = performance.now();
    const clockTime = new Date().toISOString().split('T')[1].slice(0, -1);

    for (let i = 0; i < len; i++) {
      const target = targets[i];
      if (!target || !target.win) continue;

      target.win.postMessage({ action: 'SYNC_PLAY', type: 'SET_VOLUME', value: 100 }, '*');
      // 버그 수정: 유튜브는 위 SET_VOLUME이 relay.html의 unmuteAndPlay()를
      // 거쳐 이미 재생을 시도한다(§docs/relay.html — 사용자가 그새 직접
      // 일시정지했으면 재생을 강제하지 않도록 가드가 있음). 그런데 바로
      // 아래에서 무조건 { type: 'PLAY' }까지 또 보내면 그 가드를 그냥
      // 우회해버려서, 채널을 추가하고 버퍼링되는 사이 사용자가 일시정지해도
      // 이 일괄 재생 신호가 뒤늦게 도착하며 재생이 도로 시작돼버렸다.
      // 치지직/숲은 이런 가드가 없고(§content.js PLAY 핸들러가 항상
      // video.play()) 지금까지 이 문제가 보고되지 않아 그대로 둔다.
      if (!target.isYoutube) {
        target.win.postMessage({ type: 'PLAY' }, '*');
      }

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
        const initVol = getDisplayVolumeForChannel(item.hash);
        const realInitVol = getEffectiveVolumeForChannel(item.hash);
        lastAppliedDisplayVolume[item.hash] = initVol;
        lastAppliedRealVolume[item.hash] = realInitVol;
        postVolumeMessage(item.hash, realInitVol);
      }, 1000);
      // 방금 불러온 채널이 플랫폼 자체 정책(자동재생은 음소거 상태로만
      // 허용 등)으로 뒤늦게 다시 음소거될 수 있어, 한 번 더 같은 값을
      // 재전송해 확실히 풀어준다(이미 정상이면 값이 같아 아무 변화 없음) —
      // content.js 몰래 플랫폼이 상태를 되돌렸을 수 있는 경우라 이번만은
      // §postVolumeMessage의 중복 억제 캐시를 일부러 우회해야 한다.
      setTimeout(() => {
        const reVol = getDisplayVolumeForChannel(item.hash);
        const realReVol = getEffectiveVolumeForChannel(item.hash);
        lastAppliedDisplayVolume[item.hash] = reVol;
        lastAppliedRealVolume[item.hash] = realReVol;
        delete lastSentVolumeMessage[item.hash];
        postVolumeMessage(item.hash, realReVol);
      }, 3000);
      if (item.platform === 'soop') {
        setTimeout(() => markSoopVideoReady(item.hash), 6000);
      }
    }
  });

  wrapper.appendChild(iframe);

  // [CHEESE EYES] 대기열(§renderQueueSidebar) 항목을 이 타일 위에 드래그해
  // 놓으면 그 채널 전용으로 예약한다(§setQueueItemTarget) — 지금 재생
  // 중인 영상이 자동으로 빠질 때(영상 종료/라이브 오프라인) 이 예약을
  // 우선 소비한다(§tryConsumeQueueForSlot). data-hash는 이 타일이 나중에
  // replaceVodChannelInPlace로 다른 채널로 바뀌어도 항상 최신 값을
  // 반영하므로, 클로저의 item.hash 대신 매 드롭 시점에 다시 읽는다.
  wrapper.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    wrapper.classList.add('queue-drop-target');
  });
  wrapper.addEventListener('dragleave', () => {
    wrapper.classList.remove('queue-drop-target');
  });
  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    wrapper.classList.remove('queue-drop-target');
    const raw = e.dataTransfer && e.dataTransfer.getData('text/plain');
    const index = raw ? parseInt(raw, 10) : NaN;
    if (Number.isNaN(index)) return;
    const currentHash = wrapper.getAttribute('data-hash') || item.hash;
    setQueueItemTarget(index, currentHash);
  });

  // iframe은 교차 출처(cross-origin)라 그 위에서 발생하는 클릭이 부모 문서로
  // 전달되지 않는다(호버만 CSS로 감지 가능). video-edge-sensor는 가장자리
  // 4px 프레임만 덮는 도넛 모양이라 클릭 캐칭용으로 쓸 수 없으므로, 카드
  // 전체를 덮는 투명 레이어를 별도로 두고 여기서 클릭을 받아 채널 선택
  // 동작(그리드: 채팅 전환 / main_sub: 메인 승격)으로 연결한다.
  const selectCatcher = document.createElement('div');
  selectCatcher.className = 'video-select-catcher';
  selectCatcher.addEventListener('click', () => {
    const currentHash = wrapper.getAttribute('data-hash') || item.hash;

    // 다른 채널이 조작 가능 상태였다면 다시 잠근다. (이 채널 자신이 이미
    // 조작 가능 상태였다면 캐처가 pointer-events: none이라 애초에 이
    // 리스너까지 클릭이 도달하지 않으므로, 여기 들어왔다는 건 항상
    // "이 채널에 대한 첫 클릭"이라는 뜻이다.)
    if (controlUnlockedHash && controlUnlockedHash !== currentHash) {
      lockChannelControl(controlUnlockedHash);
    }

    if (wrapper.classList.contains('sub-session')) {
      setMainChannel(currentHash);
    } else if (wrapper.classList.contains('grid-item')) {
      setChatChannel(currentHash);
      // 2026-08-17 후속(사용자 지적: "그리드에서 대표 채널 전환은 한 번
      // 클릭(오버레이 단계)해도 되게 해 — 지금은 2번 클릭해야 바뀜") —
      // 대표=메인 채널 통합(§getCollabLeaderHash) 이후로 그리드에서도
      // 대표를 바꾸려면 setMainChannel이 필요해졌는데, 이 첫 클릭(캐처
      // 단계)은 원래 채팅 전환만 하고 메인 승격은 두 번째 클릭(캐처가
      // 풀린 뒤 iframe에 직접 닿는 FRAME_CLICKED)에만 맡겨져 있었다 —
      // 통합 이전엔 그리드에 메인 개념이 필요 없었으니 무해했지만, 이제는
      // 대표 전환에 클릭이 두 번 필요해지는 부작용이었다. 첫 클릭에서도
      // 같이 호출해 한 번에 바뀌게 한다.
      setMainChannel(currentHash);
    }

    // 이 클릭 자체는 캐처가 가로채 선택만 하고 끝난다(=조작 막힘). 처리가
    // 끝나는 즉시 캐처를 꺼서, 바로 다음 클릭(=두 번째 클릭)부터는 캐처를
    // 거치지 않고 아래 iframe으로 직접 전달되어 조작 가능해진다.
    unlockChannelControl(currentHash);
  });
  wrapper.appendChild(selectCatcher);

  const edgeSensor = document.createElement('div');
  edgeSensor.className = 'video-edge-sensor';
  wrapper.appendChild(edgeSensor);

  (async () => {
    // 새로고침 직후에는 channels/displayChannels가 chrome.storage에 저장돼있던
    // "예전" videoId를 그대로 들고 있을 수 있다. 유튜브 라이브는 재인코딩/재연결
    // 등으로 videoId가 바뀌거나 방송이 끝나면 곧바로 그 값이 무효가 되므로,
    // 채팅 쪽(loadChatIframe)과 동일하게 URL을 만들기 직전에 최신 videoId로
    // 한 번 갱신한다. 이걸 안 하면 채팅은 정상인데 영상만 "이 동영상을 볼 수
    // 없습니다"가 뜨는 문제가 생긴다.
    if (item.platform === 'youtube') {
      await refreshYoutubeVideoId(item.hash);
    }
    iframeLoadQueue.push({
      iframe: iframe,
      url: getAdapter(item.platform).getVideoEmbedUrl(item.hash),
      hash: item.hash
    });
    processIframeQueue();
  })();
  const isMain = (mainChannel === item.hash);
  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  overlay.style.pointerEvents = 'none';
  // 삭제/드래그/홈 버튼을 오른쪽에 세로로 묶는다(.channel-badge-group,
  // CSS 참고) — 오른손잡이가 조작하기 편하도록 오른쪽에 두되, 유튜브
  // 임베드 플레이어 자체의 설정(톱니바퀴)·전체화면 아이콘이 있는 우상단
  // "모서리"는 피해서 그 아래로 내려 배치한다. 화면 숨김/표시 버튼은
  // 여기 없다 — 숨긴 채널은 카드 자체가 화면에서 완전히 빠지므로(0크기,
  // 아래 CSS) 카드를 호버해서 다시 켤 방법이 없다. 그래서 그 버튼은
  // 채팅탭(항상 보이는 목록)에 둔다 — updateChatSession 참고.
  // 치지직 VOD를 URL 직접 붙여넣기로 추가하면(§parseDirectInput
  // chzzkVodMatch) 실제 채널ID를 알아낼 방법이 없다(§getChannelHomeUrl
  // 주석) — 검색으로 추가한 VOD/라이브/유튜브처럼 channelId가 있는
  // 경우만 버튼을 보여주고, 없으면 아예 렌더링하지 않는다(눌러도 항상
  // 존재하지 않는 채널로 가는 죽은 버튼을 두는 것보다 낫다).
  const canShowChannelHome = !(item.platform === 'chzzk' && item.isVod && !item.channelId);
  const channelHomeBtnHtml = canShowChannelHome ? `
      <button type="button" class="channel-home-btn" data-i18n-title="video.channelHome" title="${t('video.channelHome', '채널 홈으로 이동')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="7" y1="17" x2="17" y2="7"></line>
          <polyline points="8 7 17 7 17 16"></polyline>
        </svg>
      </button>` : '';
  overlay.innerHTML = `
    <div class="channel-badge-group">
      <button type="button" class="remove-card-btn" data-i18n-title="video.removeChannel" title="${t('video.removeChannel', '채널 삭제')}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <button type="button" class="drag-handle-btn" data-i18n-title="video.dragHandle" title="${t('video.dragHandle', '드래그하여 위치 이동')}" draggable="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="9" cy="5" r="1.5" fill="currentColor"/><circle cx="15" cy="5" r="1.5" fill="currentColor"/>
          <circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/>
          <circle cx="9" cy="19" r="1.5" fill="currentColor"/><circle cx="15" cy="19" r="1.5" fill="currentColor"/>
        </svg>
      </button>
      ${channelHomeBtnHtml}
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

// 버그 수정: 예전엔 이 setInterval이 getOrCreateVideoWrapper 안에 있어서
// 새 타일(채널)이 생성될 때마다 매번 새로 등록됐다 — 채널을 추가/삭제/재추가
// 할수록 같은 일을 하는 인터벌이 계속 누적되는 누수였다(정리되지 않음).
// 지역 변수를 클로저로 참조하지 않으므로(videoWrapperMap/mainChannel 모두
// 전역) 모듈 스코프로 옮겨 한 번만 등록한다.
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

  // 메인-서브 모드라도 보이는 채널이 1개뿐이면(isMainSubTreatedAsGrid)
  // 서브 자리가 아예 없으므로 그리드 모드와 동일한 렌더링 경로를 탄다 —
  // 메인 전용 테두리/글로우/72vh 높이 제한 없이 그리드처럼 화면 전체를
  // 꽉 채운다. currentLayout 값 자체는 그대로 'main_sub'로 남아있으므로
  // 채널이 다시 늘어나면 다음 renderVideo 호출에서 자동으로 원래
  // 메인-서브 레이아웃으로 돌아간다.
  if (currentLayout === 'grid' || isMainSubTreatedAsGrid()) {
    const total = displayChannels.length;
    // 화면 숨김한 채널은 작은 썸네일로 고정되므로(.video-hidden-item CSS),
    // "나머지가 커지는" 계산은 실제로 보이는 채널 수만 기준으로 한다.
    // 전부 숨겨져 있으면(0개) 의미가 없으니 전체 개수로 되돌아간다.
    const visibleCount = displayChannels.filter(c => !videoHiddenChannels.has(c.hash)).length || total;

    videoGrid.classList.add('grid-mode');

    const width = videoGrid.clientWidth;
    const height = videoGrid.clientHeight;

    const { bestWidth, bestHeight } = calcBestFit(visibleCount, width, height);

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
      wrapper.classList.toggle('video-hidden-item', videoHiddenChannels.has(item.hash));
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
  // 메인 채널 자체를 화면 숨김했다면(.video-hidden-item, CSS !important)
  // 아래 mainRect 측정도 이 작은 크기 기준으로 이뤄져서, 서브들이 그만큼
  // 더 넓은 높이를 확보하게 된다.
  mainWrapper.classList.toggle('video-hidden-item', videoHiddenChannels.has(mainItem.hash));
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
    // 화면 숨김한 서브도 작은 썸네일로 고정되므로, "나머지가 커지는"
    // 계산은 실제로 보이는 서브 수만 기준으로 한다.
    const visibleSubCount = subItemList.filter(c => !videoHiddenChannels.has(c.hash)).length || subItemList.length;
    const MAX_SUB_COLS = 5;
    const subCols = Math.min(visibleSubCount, MAX_SUB_COLS);

    let bestWidth;
    let bestHeight;

    if (visibleSubCount <= MAX_SUB_COLS) {
      ({ bestWidth, bestHeight } = calcBestFit(visibleSubCount, availableWidth, availableHeight, subCols));
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
      wrapper.classList.toggle('video-hidden-item', videoHiddenChannels.has(item.hash));
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

// 채팅탭 이름 옆에 합방 상태를 아이콘 하나로 보여준다 — 리더는 ★, 리더가
// 아닌 그룹 멤버는 🔗, 겹침으로 강제 음소거된 멤버는 🔇. 탭 DOM 자체를
// 다시 만들지 않고 아이콘 span만 갱신하므로 유사도가 바뀔 때마다(수백ms
// 간격) 호출해도 탭 목록이 깜빡이지 않는다.
function updateChatTabCollabIcons() {
  if (!chatTabs) return;
  chatTabs.querySelectorAll('.chat-tab').forEach((tab) => {
    const icon = tab.querySelector('.chat-tab-collab-icon');
    if (!icon) return;
    const hash = tab.getAttribute('data-hash');
    const group = isCollabSettingEnabled() ? findCollabGroupForChannel(hash) : null;
    if (!group) {
      icon.hidden = true;
      icon.className = 'chat-tab-collab-icon';
      icon.textContent = '';
      icon.removeAttribute('title');
      return;
    }
    const leaderHash = getCollabLeaderHash(group);
    const isLeader = hash === leaderHash;
    const isMuted = !isLeader && isChannelCollabMuted(hash);
    icon.hidden = false;
    icon.className = 'chat-tab-collab-icon' + (isMuted ? ' muted' : (isLeader ? ' leader' : ''));
    icon.textContent = isMuted ? '🔇' : (isLeader ? '★' : '🔗');
    icon.title = isMuted
      ? t('audio.collabMutedLabel', '음소거')
      : (isLeader ? t('audio.collabLeaderLabel', '대표') : t('audio.collabInGroupHint', '합방 그룹 소속'));
  });
}

// 숲 VOD(다시보기)는 채팅 다시보기 임베드가 검증되지 않았고, 그냥 없는
// 채널처럼 챗탭 자체를 만들지 않는다. 유튜브는 라이브/다시보기 챗이
// 있으면 live_chat 임베드로, 없으면(일반 업로드 영상) 댓글 패널로 대신
// 채워서(§ensureYoutubeHasLiveChat, loadYoutubeComments) 항상 챗탭이
// 있는 것으로 취급한다. 치지직 VOD는 실시간 채팅이 아니라 "댓글" 기능만
// 있고 그 API를 찾지 못해(§getChatEmbedUrl) VOD 페이지 자체를 그대로
// iframe으로 띄우는 방식으로 챗탭을 지원한다.
function channelSupportsChatTab(item) {
  return item.platform === 'youtube' || item.platform === 'chzzk' || !item.isVod;
}

function updateChatSession() {
  if (!chatTabs || !chatContainer) return;
  const chatCapableChannels = displayChannels.filter(channelSupportsChatTab);
  if (chatCapableChannels.length === 0) {
    chatTabs.innerHTML = '';
    chatContainer.innerHTML = `<div class="chat-placeholder">${t('app.chatPlaceholder', '채널을 추가하면 채팅이 동기화됩니다.')}</div>`;
    activeChatChannel = null;
    // 버그 수정: 채팅/댓글 토글 바(§ensureChatSubViewToggle)는
    // chatContainer의 자식이 아니라 형제 노드라 위 innerHTML 초기화로는
    // 안 지워진다 — 채널이 하나도 안 남으면 activeChatChannel도 null이라
    // 버튼을 눌러도 아무 반응이 없는 채로(§setYoutubeChatSubView의
    // activeChatChannel 가드) 화면에만 남아있는 상태가 됐었다.
    if (chatSubViewToggleEl) chatSubViewToggleEl.hidden = true;
    return;
  }
  const isValidActive = chatCapableChannels.some(c => c.hash === activeChatChannel);
  if (!activeChatChannel || !isValidActive) {
    activeChatChannel = chatCapableChannels[0].hash;
  }
  const placeholder = chatContainer.querySelector('.chat-placeholder');
  if (placeholder) placeholder.remove();
  chatTabs.innerHTML = '';
  const fragment = document.createDocumentFragment();

  chatCapableChannels.forEach(item => {
    const tab = document.createElement('div');
    const isActive = (item.hash === activeChatChannel);
    tab.className = `chat-tab ${isActive ? 'active' : ''}`;
    tab.setAttribute('data-hash', item.hash);
    tab.setAttribute('data-platform', item.platform);
    tab.style.setProperty('--tab-color', getPlatformColor(item.platform));

    // 합방 그룹 소속 여부/리더·음소거 상태 아이콘. 내용은 여기서 채우지
    // 않고 updateChatTabCollabIcons()가 일괄 채운다(탭이 새로 만들어질
    // 때뿐 아니라, 유사도 재계산으로 음소거 상태만 바뀔 때도 탭 전체를
    // 다시 만들지 않고 이 아이콘만 갱신하기 위해서다).
    const collabIcon = document.createElement('span');
    collabIcon.className = 'chat-tab-collab-icon';
    collabIcon.hidden = true;
    tab.appendChild(collabIcon);

    const tabName = document.createElement('span');
    tabName.className = 'chat-tab-name';
    tabName.innerText = item.name;
    tab.addEventListener('click', () => {
      setChatChannel(item.hash);
    });

    // 화면 숨김/표시 토글 — 숨긴 채널은 카드가 화면에서 완전히 빠지므로
    // (renderVideo/dashboard.css의 .video-hidden-item) 카드를 호버해서
    // 다시 켤 방법이 없다. 항상 떠 있는 채팅탭에 둬야 언제든 다시 켤 수
    // 있다. 아이콘/상태는 여기서 채우지 않고 updateChatTabVideoToggleIcons()가
    // 일괄 채운다.
    const videoToggleBtn = document.createElement('button');
    videoToggleBtn.type = 'button';
    videoToggleBtn.className = 'chat-tab-video-toggle-btn';
    videoToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChannelVideoHidden(item.hash);
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'chat-tab-refresh-btn';
    refreshBtn.innerHTML = '⟳';
    refreshBtn.title = t('chat.refreshTooltip', '채팅 새로고침');
    refreshBtn.setAttribute('data-i18n-title', 'chat.refreshTooltip');
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshChatTab(item.hash, item.platform, refreshBtn);
    });

    tab.appendChild(tabName);
    tab.appendChild(videoToggleBtn);
    tab.appendChild(refreshBtn);
    fragment.appendChild(tab);
  });

  chatTabs.appendChild(fragment);
  updateChatTabCollabIcons();
  updateChatTabVideoToggleIcons();
  const existingIframes = chatContainer.querySelectorAll('iframe.chat-iframe');
  existingIframes.forEach(iframe => {
    const hash = iframe.getAttribute('data-hash');
    if (!chatCapableChannels.some(c => c.hash === hash)) {
      iframe.src = 'about:blank';
      iframe.remove();
      reinitPendingHashes.delete(hash);
      const overlay = chatReinitOverlays.get(hash);
      if (overlay) { overlay.remove(); chatReinitOverlays.delete(hash); }
      removeYoutubeCommentsPanel(hash);
      youtubeChatSubView.delete(hash);
      youtubeChatToggleEligible.delete(hash);
    }
  });
  ensureChatIframeCreated(activeChatChannel);
  syncChatVisibility();
}

// 유튜브 영상은 "라이브챗 다시보기"와 "댓글"을 동시에 가질 수 있는데,
// 예전엔 라이브챗이 없다고 판정될 때만 댓글로 대체해서 — 라이브챗이
// 있어도 댓글을 볼 방법이 아예 없었고, 판정이 틀리면(예: 방금 끝난
// 라이브라 아직 다시보기 채팅이 안 걸린 경우) 채팅을 볼 방법도 없었다.
// hash -> 'chat' | 'comments'로 지금 어느 쪽을 보고 있는지 기억해서,
// 채팅탭 위 토글 버튼으로 언제든 반대쪽도 볼 수 있게 한다(§loadChatIframe,
// §ensureChatSubViewToggle). 예전에 한 번 구현했다가(2026-08-15) 되돌렸던
// 기능인데, 그때는 getChatEmbedUrl이 종료된 영상에도 무조건 live_chat을
// 써서 토글로 "채팅"을 눌러도 항상 에러만 떴다 — replay=1(§getChatEmbedUrl,
// docs/relay.html) 수정으로 그 근본 원인이 고쳐져서 다시 넣는다.
const youtubeChatSubView = new Map();
function getYoutubeChatSubView(hash) {
  return youtubeChatSubView.get(hash) || 'chat';
}

// 토글 바를 보여줄지는 오직 여기(§loadChatIframe)에서만 결정한다 —
// hasLiveChat 판정을 syncChatSubViewToggleUI가 채널 객체에서 따로
// 다시 읽어 재계산하게 했다가, "방금 추가돼 아직 판정 전(undefined)"
// 상태를 두 곳이 서로 다르게 해석해 토글이 계속 떠 있는 버그가 났다
// (실사용 확인). loadChatIframe이 실제로 판정을 끝낸 hash만 이 Set에
// 넣는 것으로 단일 진실 공급원을 하나로 좁힌다 — 판정 전/없음은 항상
// "토글 없음"으로 취급된다.
const youtubeChatToggleEligible = new Set();

let chatSubViewToggleEl = null;
function ensureChatSubViewToggle() {
  // updateChatSession()이 채팅 가능 채널이 하나도 없을 때
  // chatContainer.innerHTML을 통째로 비우는데(placeholder만 남김), 그때
  // 이 바도 같이 날아간다 — 캐시된 참조만 보고 재사용하면 DOM에서 떨어져
  // 나간(보이지 않는) 엘리먼트를 계속 돌려주게 되므로 isConnected를 확인한다.
  if (chatSubViewToggleEl && chatSubViewToggleEl.isConnected) return chatSubViewToggleEl;
  if (!chatContainer || !chatContainer.parentElement) return null;
  const bar = document.createElement('div');
  bar.className = 'chat-subview-toggle';
  bar.hidden = true;
  ['chat', 'comments'].forEach((view) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-subview-btn';
    btn.dataset.view = view;
    btn.textContent = view === 'chat' ? t('chat.subViewChat', '채팅') : t('chat.subViewComments', '댓글');
    btn.addEventListener('click', () => {
      if (activeChatChannel) setYoutubeChatSubView(activeChatChannel, view);
    });
    bar.appendChild(btn);
  });
  // chatContainer 안에 겹쳐 띄우지 않고(댓글 작성창이 패널 맨 위에
  // sticky로 고정돼 있어 곂쳤다), 그 바로 위에 별도 행으로 끼워 넣는다 —
  // 보통의 문서 흐름이라 콘텐츠와 자리를 다툴 일이 없다.
  chatContainer.parentElement.insertBefore(bar, chatContainer);
  chatSubViewToggleEl = bar;
  return bar;
}

function setYoutubeChatSubView(hash, view) {
  if (view !== 'chat' && view !== 'comments') return;
  youtubeChatSubView.set(hash, view);
  if (view === 'comments' && !getYoutubeCommentsPanel(hash)) {
    const ch = getChannelObjByHash(hash);
    if (ch && ch.videoId) loadYoutubeComments(hash, ch.videoId);
  }
  syncChatVisibility();
}

// 지금 활성 채널이 유튜브고, 영상ID가 있고, 라이브챗(다시보기 포함)이
// 실제로 있을 때만 토글 바를 보여준다 — 볼 게 댓글 하나뿐인 일반
// 업로드 영상까지 토글을 띄우면 눌러도 항상 에러만 나는 죽은 버튼이
// 되므로(§loadChatIframe의 !hasLiveChat 분기와 짝).
function syncChatSubViewToggleUI() {
  const bar = ensureChatSubViewToggle();
  if (!bar) return;
  const ch = activeChatChannel && getChannelObjByHash(activeChatChannel);
  // loadChatIframe이 실제로 라이브챗(다시보기 포함) 있음을 확인해 넣어둔
  // hash만 토글을 보여준다(§youtubeChatToggleEligible) — 아직 판정 전이거나
  // 애초에 없는 일반 업로드 영상은 항상 "토글 없음"으로 취급된다.
  const show = !!(ch && ch.platform === 'youtube' && ch.videoId && youtubeChatToggleEligible.has(activeChatChannel));
  bar.hidden = !show;
  if (!show) return;
  const current = getYoutubeChatSubView(activeChatChannel);
  bar.querySelectorAll('.chat-subview-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === current);
  });
}

// ── 라이브챗이 없는 유튜브 영상(§ensureYoutubeHasLiveChat)의 댓글을 채팅
// 탭 자리에 대신 그려주는 패널. iframe으로 유튜브 댓글을 그대로 embed할
// 공식 방법이 없어서, InnerTube에서 받아온 데이터를 우리가 직접 DOM으로
// 그린다 — 목록/답글 보기뿐 아니라 댓글 작성·답글 작성도 지원한다(로그인
// 상태 필요, §PlatformAdapters.youtube._postComment).
// hash -> { videoId, items, nextToken, loading, loadingMore, exhausted,
//           errored, composerParams, composerBusy, composerError }
// items[i]에는 답글 UI 상태(repliesExpanded/repliesLoaded/...)와 답글
// 작성창 상태(replyComposerOpen/...)도 함께 붙는다.
const youtubeCommentsState = new Map();

function getYoutubeCommentsPanel(hash) {
  return chatContainer ? chatContainer.querySelector(`.chat-comments-panel[data-hash="${hash}"]`) : null;
}

function ensureYoutubeCommentsPanel(hash) {
  if (!chatContainer) return null;
  let panel = getYoutubeCommentsPanel(hash);
  if (panel) return panel;
  panel = document.createElement('div');
  panel.className = 'chat-comments-panel';
  panel.setAttribute('data-hash', hash);

  const composer = buildYoutubeCommentComposer(hash, {
    placeholder: t('chat.commentPlaceholder', '댓글 추가...'),
    onSubmit: (text) => submitYoutubeComment(hash, text)
  });
  composer.classList.add('chat-comment-composer-root');
  panel.appendChild(composer);

  const list = document.createElement('div');
  list.className = 'chat-comments-list';
  panel.appendChild(list);
  panel.addEventListener('scroll', () => onYoutubeCommentsScroll(hash));
  chatContainer.appendChild(panel);
  // 이 패널은 loadYoutubeComments()의 비동기 조회가 끝난 뒤에야 만들어지는
  // 경우가 많아, 패널을 새로 만든 시점에 updateChatSession()의
  // syncChatVisibility()는 이미 지나가버린 뒤일 수 있다(§채널이 1개뿐이라
  // 이후 다른 렌더링 트리거가 없으면 영영 숨김 상태로 남는 버그였음).
  // 새로 만든 직후 한 번 더 동기화한다.
  syncChatVisibility();
  return panel;
}

function removeYoutubeCommentsPanel(hash) {
  const panel = getYoutubeCommentsPanel(hash);
  if (panel) panel.remove();
  youtubeCommentsState.delete(hash);
}

// 댓글 작성창(최상위 댓글용/답글용 공용). onSubmit이 true를 돌려주면
// 입력창을 비우고, 실패(false)면 에러 문구를 보여준다.
function buildYoutubeCommentComposer(hash, { placeholder, onSubmit, submitLabel, autofocus, draftKey, initialText } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-comment-composer';

  const textarea = document.createElement('textarea');
  textarea.className = 'chat-comment-composer-input';
  textarea.placeholder = placeholder || '';
  textarea.rows = 1;
  if (initialText) textarea.value = initialText;
  if (draftKey) textarea.setAttribute('data-draft-key', draftKey);
  wrap.appendChild(textarea);

  const row = document.createElement('div');
  row.className = 'chat-comment-composer-row';
  const status = document.createElement('span');
  status.className = 'chat-comment-composer-status';
  row.appendChild(status);
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'chat-comment-composer-submit';
  submitBtn.textContent = submitLabel || t('chat.commentSubmit', '등록');
  row.appendChild(submitBtn);
  wrap.appendChild(row);

  const doSubmit = async () => {
    const text = textarea.value.trim();
    if (!text || submitBtn.disabled) return;
    submitBtn.disabled = true;
    status.textContent = t('chat.commentPosting', '작성 중...');
    status.classList.remove('chat-comments-error');
    const ok = await onSubmit(text);
    submitBtn.disabled = false;
    if (ok) {
      textarea.value = '';
      status.textContent = '';
    } else {
      status.textContent = t('chat.commentPostFailed', '작성에 실패했습니다. 로그인 상태를 확인해주세요.');
      status.classList.add('chat-comments-error');
    }
  };
  submitBtn.addEventListener('click', doSubmit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSubmit(); }
  });
  if (autofocus) setTimeout(() => textarea.focus(), 0);

  return wrap;
}

// 유튜브 댓글 관례대로 "1:57", "1:23:45" 같은 타임스탬프를 눌러서 그
// 지점으로 이동할 수 있게 한다. 나머지 텍스트는 그대로 두고(innerHTML
// 아님 — XSS 방지) 타임스탬프 부분만 클릭 가능한 링크로 바꿔치기한다.
const YOUTUBE_COMMENT_TIMESTAMP_RE = /\b((?:\d{1,2}:)?\d{1,2}:\d{2})\b/g;
function youtubeTimestampToSeconds(str) {
  const parts = str.split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function renderYoutubeCommentTextWithTimestamps(container, text, hash) {
  const re = new RegExp(YOUTUBE_COMMENT_TIMESTAMP_RE);
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const seconds = youtubeTimestampToSeconds(match[1]);
    if (seconds === null) {
      container.appendChild(document.createTextNode(match[0]));
    } else {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'chat-comment-timestamp';
      link.textContent = match[1];
      link.addEventListener('click', (e) => {
        e.preventDefault();
        seekChannelToTime(hash, seconds);
      });
      container.appendChild(link);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderYoutubeCommentRow(hash, c, depth, parentComment) {
  if (c.repliesExpanded === undefined) {
    c.repliesExpanded = false;
    c.repliesLoaded = [];
    c.repliesNextToken = c.repliesToken;
    c.repliesExhausted = !c.repliesToken;
    c.repliesLoading = false;
    c.repliesErrored = false;
    c.replyComposerOpen = false;
  }

  const row = document.createElement('div');
  row.className = 'chat-comment-row' + (c.isPinned ? ' pinned' : '') + (c.isOwner ? ' owner-reply' : '') + (depth > 0 ? ' reply' : '');

  const avatar = document.createElement('img');
  avatar.className = 'chat-comment-avatar';
  avatar.src = c.avatarUrl || '';
  avatar.alt = '';
  avatar.loading = 'lazy';
  row.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'chat-comment-body';

  const head = document.createElement('div');
  head.className = 'chat-comment-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'chat-comment-author';
  nameEl.textContent = c.author;
  head.appendChild(nameEl);
  if (c.publishedTime) {
    const timeEl = document.createElement('span');
    timeEl.className = 'chat-comment-time';
    timeEl.textContent = c.publishedTime;
    head.appendChild(timeEl);
  }
  body.appendChild(head);

  const textEl = document.createElement('div');
  textEl.className = 'chat-comment-text';
  renderYoutubeCommentTextWithTimestamps(textEl, c.text, hash);
  body.appendChild(textEl);

  if (c.likeCount) {
    const likeEl = document.createElement('div');
    likeEl.className = 'chat-comment-likes';
    likeEl.textContent = `👍 ${c.likeCount}`;
    body.appendChild(likeEl);
  }

  // 답글 보기(펼치기/접기·더보기)는 최상위 댓글에서만 보여준다(유튜브도
  // 답글의 답글은 지원하지 않는다, 1단계까지만). 답글 달기는 답글 자체에도
  // 보여준다 — 다만 유튜브 데이터 모델상 "답글의 답글"이라는 게 따로 없어,
  // 답글에 달면 그 답글이 속한 최상위 댓글의 같은 답글 목록에 @멘션을
  // 붙여 추가된다(실제 유튜브 UI와 동일한 동작).
  const actions = document.createElement('div');
  actions.className = 'chat-comment-actions';

  if (depth === 0 && (c.replyCount > 0 || c.repliesLoaded.length > 0)) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'chat-comment-action-btn chat-comment-view-replies';
    const setToggleLabel = () => {
      toggleBtn.textContent = c.repliesExpanded
        ? t('chat.hideReplies', '답글 숨기기')
        : t('chat.viewRepliesTemplate', '답글 {count}개 보기', { count: c.replyCount || c.repliesLoaded.length });
    };
    setToggleLabel();
    toggleBtn.addEventListener('click', async () => {
      if (!c.repliesExpanded && c.repliesLoaded.length === 0 && !c.repliesLoading) {
        await fetchMoreYoutubeReplies(hash, c);
      }
      c.repliesExpanded = !c.repliesExpanded;
      renderYoutubeCommentsList(hash);
    });
    actions.appendChild(toggleBtn);
  }

  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'chat-comment-action-btn';
  replyBtn.textContent = t('chat.writeReply', '답글 달기');
  replyBtn.addEventListener('click', () => {
    c.replyComposerOpen = !c.replyComposerOpen;
    renderYoutubeCommentsList(hash);
  });
  actions.appendChild(replyBtn);

  body.appendChild(actions);

  if (c.replyComposerOpen) {
    // depth 0(최상위 댓글)이면 자기 자신, depth 1(답글)이면 그 답글이 속한
    // 최상위 댓글이 실제로 답글 작성 params/목록을 가진 대상이다.
    const target = depth === 0 ? c : parentComment;
    const replyComposer = buildYoutubeCommentComposer(hash, {
      placeholder: t('chat.replyPlaceholder', '답글 추가...'),
      submitLabel: t('chat.commentSubmit', '등록'),
      autofocus: true,
      draftKey: `reply:${c.id}`,
      initialText: depth > 0 ? `@${c.author} ` : '',
      onSubmit: async (text) => {
        const params = await PlatformAdapters.youtube._getReplyComposerParams(target);
        if (!params) return false;
        const ok = await PlatformAdapters.youtube._postComment(params, text);
        if (!ok) return false;
        target.repliesLoaded.push({
          id: `local-${Date.now()}`,
          text,
          author: getYoutubeSelfLabel(),
          avatarUrl: '',
          publishedTime: t('chat.commentsJustNow', '방금 전'),
          likeCount: '',
          isOwner: false,
          isPinned: false,
          replyCount: 0,
          repliesToken: null,
          _raw: null
        });
        target.replyCount = (target.replyCount || 0) + 1;
        target.repliesExpanded = true;
        c.replyComposerOpen = false;
        renderYoutubeCommentsList(hash);
        return true;
      }
    });
    body.appendChild(replyComposer);
  }

  if (depth === 0 && c.repliesExpanded) {
    const repliesWrap = document.createElement('div');
    repliesWrap.className = 'chat-comment-replies';
    c.repliesLoaded.forEach(r => repliesWrap.appendChild(renderYoutubeCommentRow(hash, r, depth + 1, c)));
    if (c.repliesLoading) {
      const loadingEl = document.createElement('div');
      loadingEl.className = 'chat-comments-status chat-comments-loading-more';
      loadingEl.textContent = t('chat.commentsLoadingMore', '더 불러오는 중...');
      repliesWrap.appendChild(loadingEl);
    } else if (c.repliesErrored && c.repliesLoaded.length === 0) {
      const errEl = document.createElement('div');
      errEl.className = 'chat-comments-status chat-comments-error chat-comments-loading-more';
      errEl.textContent = t('chat.repliesLoadFailed', '답글을 불러오지 못했습니다.');
      repliesWrap.appendChild(errEl);
    } else if (!c.repliesExhausted && c.repliesLoaded.length > 0) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'chat-comment-action-btn chat-comment-more-replies';
      moreBtn.textContent = t('chat.loadMoreReplies', '답글 더보기');
      moreBtn.addEventListener('click', () => fetchMoreYoutubeReplies(hash, c));
      repliesWrap.appendChild(moreBtn);
    }
    body.appendChild(repliesWrap);
  }

  row.appendChild(body);
  return row;
}

function getYoutubeSelfLabel() {
  const info = (cachedAccountInfo || []).find(a => a.platform === 'youtube');
  return (info && info.label) || t('chat.commentsYou', '나');
}

async function fetchMoreYoutubeReplies(hash, comment) {
  if (comment.repliesLoading || comment.repliesExhausted) return;
  if (!comment.repliesNextToken) {
    // 답글 개수(replyCount)는 있는데 답글 진입 토큰을 못 찾은 경우 — 예전엔
    // 버튼을 눌러도 조용히 아무 일도 안 일어나는 것처럼 보였다. 눈에 보이는
    // 에러로 바꿔서 최소한 "안 뜨는 게 아니라 실패했다"는 걸 알 수 있게 한다.
    console.warn(`[CHEESE EYES] 유튜브 답글 토큰을 찾지 못함 (commentId=${comment.id}, replyCount=${comment.replyCount})`);
    comment.repliesErrored = true;
    comment.repliesExhausted = true;
    return;
  }
  comment.repliesLoading = true;
  comment.repliesErrored = false;
  renderYoutubeCommentsList(hash);
  const page = await PlatformAdapters.youtube._fetchComments(null, comment.repliesNextToken);
  comment.repliesLoading = false;
  if (!page || page.parseFailed) {
    // page가 아예 null(요청 실패)이거나, 응답은 왔지만 항목을 하나도
    // 못 파싱한 경우(§_fetchComments의 parseFailed) — 둘 다 "정상적으로
    // 답글이 없다"가 아니라 실패이므로 조용히 빈 채로 두지 않고 에러로
    // 표시한다. 다음 페이지 토큰도 신뢰하지 않는다(이번 페이지가 실패면
    // 이어붙일 게 없다).
    comment.repliesExhausted = true;
    comment.repliesErrored = comment.repliesLoaded.length === 0;
  } else {
    comment.repliesLoaded.push(...page.items);
    comment.repliesNextToken = page.nextToken;
    comment.repliesExhausted = !page.nextToken;
  }
  renderYoutubeCommentsList(hash);
}

async function submitYoutubeComment(hash, text) {
  const state = youtubeCommentsState.get(hash);
  if (!state) return false;
  if (state.composerParams === undefined) {
    state.composerParams = await PlatformAdapters.youtube._getCommentComposerParams(state.videoId);
  }
  if (!state.composerParams) return false;
  const ok = await PlatformAdapters.youtube._postComment(state.composerParams, text);
  if (!ok) return false;
  // 방금 작성한 댓글의 서버측 렌더 데이터(commentId/entity 등)는 InnerTube
  // 응답 파싱이 불확실해 신뢰하지 않고, 사용자가 입력한 내용 그대로를
  // 목록 맨 위에 낙관적으로 얹는다.
  state.items.unshift({
    id: `local-${Date.now()}`,
    text,
    author: getYoutubeSelfLabel(),
    avatarUrl: '',
    publishedTime: t('chat.commentsJustNow', '방금 전'),
    likeCount: '',
    isOwner: false,
    isPinned: false,
    replyCount: 0,
    repliesToken: null,
    _raw: null
  });
  renderYoutubeCommentsList(hash);
  return true;
}

function renderYoutubeCommentsList(hash) {
  const state = youtubeCommentsState.get(hash);
  const panel = getYoutubeCommentsPanel(hash);
  if (!state || !panel) return;
  const list = panel.querySelector('.chat-comments-list');
  if (!list) return;

  // 답글 작성창은 이 목록(list) 안에서 만들어지므로, 답글 보기/더보기/댓글
  // 작성 등 다른 조작으로 목록 전체가 다시 그려지면 입력 중이던 답글
  // 초안이 그대로 날아간다 — 다시 그리기 전에 값을 걷어뒀다가, 다시
  // 그린 뒤 같은 draftKey를 가진 입력창에 되돌려 놓는다.
  const drafts = new Map();
  list.querySelectorAll('[data-draft-key]').forEach((el) => {
    if (el.value) drafts.set(el.getAttribute('data-draft-key'), el.value);
  });

  list.innerHTML = '';

  if (state.errored) {
    list.innerHTML = `<div class="chat-comments-status chat-comments-error">${t('chat.commentsLoadFailed', '댓글을 불러오지 못했습니다.')}</div>`;
    return;
  }
  if (state.items.length === 0) {
    list.innerHTML = `<div class="chat-comments-status">${state.loading ? t('chat.commentsLoading', '댓글을 불러오는 중...') : t('chat.commentsEmpty', '댓글이 없습니다.')}</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  state.items.forEach(c => fragment.appendChild(renderYoutubeCommentRow(hash, c, 0)));
  list.appendChild(fragment);

  if (state.loadingMore) {
    const moreEl = document.createElement('div');
    moreEl.className = 'chat-comments-status chat-comments-loading-more';
    moreEl.textContent = t('chat.commentsLoadingMore', '더 불러오는 중...');
    list.appendChild(moreEl);
  }

  if (drafts.size > 0) {
    list.querySelectorAll('[data-draft-key]').forEach((el) => {
      const draft = drafts.get(el.getAttribute('data-draft-key'));
      if (draft) el.value = draft;
    });
  }
}

async function loadYoutubeComments(hash, videoId) {
  ensureYoutubeCommentsPanel(hash);
  const state = { videoId, items: [], nextToken: null, loading: true, loadingMore: false, exhausted: false, errored: false, composerParams: undefined };
  youtubeCommentsState.set(hash, state);
  renderYoutubeCommentsList(hash);

  const page = await PlatformAdapters.youtube._fetchComments(videoId);
  // 로딩 도중 다른 채널로 새로고침/전환됐을 수 있다 — 그 사이 state가
  // 교체됐다면 낡은 응답을 반영하지 않는다.
  if (youtubeCommentsState.get(hash) !== state) return;
  state.loading = false;
  if (!page || page.parseFailed) {
    state.errored = true;
  } else {
    state.items = page.items;
    state.nextToken = page.nextToken;
    state.exhausted = !page.nextToken;
  }
  renderYoutubeCommentsList(hash);
}

async function fetchMoreYoutubeComments(hash) {
  const state = youtubeCommentsState.get(hash);
  if (!state || state.loading || state.loadingMore || state.exhausted || !state.nextToken) return;
  state.loadingMore = true;
  renderYoutubeCommentsList(hash);

  const page = await PlatformAdapters.youtube._fetchComments(state.videoId, state.nextToken);
  if (youtubeCommentsState.get(hash) !== state) return;
  state.loadingMore = false;
  if (!page || page.parseFailed) {
    // 실패 시 재시도 폭주를 막기 위해 더 이상 다음 페이지를 시도하지 않는다.
    state.exhausted = true;
  } else {
    state.items.push(...page.items);
    state.nextToken = page.nextToken;
    state.exhausted = !page.nextToken;
  }
  renderYoutubeCommentsList(hash);
}

function onYoutubeCommentsScroll(hash) {
  const panel = getYoutubeCommentsPanel(hash);
  if (!panel) return;
  const remaining = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
  if (remaining > 200) return;
  fetchMoreYoutubeComments(hash);
}

// 치지직 VOD 채팅 다시보기는 실제 VOD 시청 페이지를 채팅탭 iframe으로
// 그대로 불러온다 — PlatformAdapters.chzzk.getChatEmbedUrl이
// cheeseChatEmbed 마커를 붙여주면 content.js가 그 프레임 안에서 채팅
// aside(#vod-aside)만 뷰포트 전체로 끌어올리고 영상은 강제 음소거한다
// (§docs/vod-chat-architecture.md). 그래서 이 채널도 loadChatIframe의
// 일반 iframe 경로를 그대로 탄다 — 치지직 VOD 전용 분기가 따로 필요 없다.

async function loadChatIframe(iframe, hash, platform) {
  const adapter = getAdapter(platform);

  if (platform === 'youtube') {
    await refreshYoutubeVideoId(hash);
    const ch = getChannelObjByHash(hash);
    const videoId = ch && ch.videoId;
    if (!videoId) {
      iframe.src = 'about:blank';
      removeYoutubeCommentsPanel(hash);
      youtubeChatSubView.delete(hash);
      youtubeChatToggleEligible.delete(hash);
      return;
    }

    // "특정 영상 고정" 채널만 실제로 확인한다 — 채널 자체를 추적하는
    // 항목(hash가 채널ID)은 이미 라이브 중임이 확인된 videoId만 갖고
    // 있어 라이브챗이 있다고 가정해도 된다(§channelSupportsChatTab 주석).
    const isPinnedVideo = ch.isPinnedVideoSlot || ch.hash === ch.videoId;
    const hasLiveChat = isPinnedVideo ? await ensureYoutubeHasLiveChat(ch) : true;

    if (!hasLiveChat) {
      // 라이브챗/채팅 다시보기 자체가 없는 일반 업로드 영상 — 토글 없이
      // 댓글만 보여준다(§syncChatSubViewToggleUI가 youtubeChatToggleEligible만
      // 본다). live_chat iframe을 굳이 로드해봐야 항상 에러만 뜨므로
      // about:blank로 비워 불필요한 요청을 만들지 않는다.
      iframe.src = 'about:blank';
      youtubeChatSubView.set(hash, 'comments');
      youtubeChatToggleEligible.delete(hash);
      loadYoutubeComments(hash, videoId);
      syncChatVisibility();
      return;
    }
    youtubeChatToggleEligible.add(hash);

    // 채팅/댓글을 서로 배타적으로 취급하지 않는다 — 라이브챗(다시보기
    // 포함)이 있으면 기본으로 채팅을 보여주되, 댓글도 언제든 토글
    // 버튼으로 볼 수 있게 둘 다 준비해둔다(§ensureChatSubViewToggle).
    if (!youtubeChatSubView.has(hash)) {
      youtubeChatSubView.set(hash, 'chat');
    }
    if (getYoutubeChatSubView(hash) === 'comments') {
      loadYoutubeComments(hash, videoId);
    }

    // 확장 origin(chrome-extension://...)에서 live_chat을 곧바로 열면
    // embed_domain 검증을 통과하지 못해 ERR_BLOCKED_BY_RESPONSE로 막힌다.
    // 우리가 소유한 실제 https 도메인(YT_RELAY_ORIGIN)의 중계 페이지가
    // 대신 embed_domain을 채워 요청하도록 위임한다. 자세한 배경은
    // PlatformAdapters.youtube.getChatEmbedUrl 주석 참고.
    iframe.src = getAdapter('youtube').getChatEmbedUrl(hash);
    syncChatVisibility();
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

// 치지직 VOD 채팅탭은 라이브(`/live/{id}/chat`, 가벼운 전용 페이지)와 달리
// VOD 시청 페이지 자체를 통째로 다시 불러온다(§docs/vod-chat-architecture.md
// §2 cheeseChatEmbed) — 메인 영상 타일도 같은 무거운 페이지를 동시에 띄우고
// 있어서, 새로고침 때 두 개가 한꺼번에 네트워크/렌더링 자원을 다투다가
// 체감상 "무한로딩"처럼 보일 정도로 느려지는 경우가 있었다.
function isChzzkVodChatChannel(hash) {
  const ch = getChannelObjByHash(hash);
  return !!(ch && ch.platform === 'chzzk' && ch.isVod);
}

const CHZZK_VOD_CHAT_LOAD_TIMEOUT_MS = 20000;
const CHZZK_VOD_CHAT_STAGGER_MS = 600;

// hash -> "지금 대기 중인 감시를 해제하는 함수". iframe의 load 이벤트만
// 보고 오버레이를 껐더니, 치지직 페이지 뼈대(HTML)는 떴지만 SPA 자체가
// 자기 로딩 화면("열심히 불러오는 중...")에 갇혀 안 넘어가는 상태에서도
// 오버레이가 먼저 사라지는 오탐이 있었다 — load는 "탐색이 끝났다"는
// 뜻일 뿐 "채팅이 실제로 준비됐다"는 뜻이 아니었다. 그래서 content.js가
// #vod-aside가 실제로 DOM에 나타난 순간 보내주는 CHZZK_CHAT_EMBED_READY
// 신호를 대신 기다린다(§content.js promoteVodAside).
const chzzkVodChatWatchdogs = new Map();
window.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CHZZK_CHAT_EMBED_READY') return;
  const hash = findChatHashByWindow(event.source);
  const settle = hash && chzzkVodChatWatchdogs.get(hash);
  if (settle) settle();
});

// 로딩 중엔 재연결 오버레이(스피너)를 보여주고, 위 준비 신호가 오기 전에
// 타임아웃이 지나면 — 정말로 멈춰버린 것으로 보고 — iframe을 통째로 새로
// 만들어 스스로 재시도한다. "새로고침해도 계속 무한로딩"이던 증상에
// 대한 자동 회복 장치다.
function attachChzzkVodChatWatchdog(iframe, hash) {
  if (!isChzzkVodChatChannel(hash)) return;
  const wasVisible = chatVisible && hash === activeChatChannel;
  if (wasVisible) showChatReinitOverlay(hash);

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    chzzkVodChatWatchdogs.delete(hash);
    if (wasVisible) hideChatReinitOverlay(hash);
  };
  chzzkVodChatWatchdogs.set(hash, finish);

  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    chzzkVodChatWatchdogs.delete(hash);
    console.warn('[CHEESE EYES] 치지직 VOD 채팅탭 로딩이 오래 걸려 다시 시도합니다:', hash);
    if (wasVisible) hideChatReinitOverlay(hash);
    const current = chatContainer && chatContainer.querySelector(`iframe[data-hash="${hash}"]`);
    if (current === iframe) {
      recreateChatIframe(iframe, hash, 'chzzk');
    }
  }, CHZZK_VOD_CHAT_LOAD_TIMEOUT_MS);
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
  attachChzzkVodChatWatchdog(iframe, hash);
  if (isChzzkVodChatChannel(hash)) {
    // 메인 영상 타일과 동시에 같은 무거운 페이지를 두 번 요청하지 않도록
    // 살짝 늦춰서, 초기 네트워크 폭주를 줄인다.
    setTimeout(() => loadChatIframe(iframe, hash, platform), CHZZK_VOD_CHAT_STAGGER_MS);
  } else {
    loadChatIframe(iframe, hash, platform);
  }
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
  attachChzzkVodChatWatchdog(fresh, hash);
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
// 유튜브는 채팅/댓글 둘 다 준비해두고 토글로 전환하므로(§loadChatIframe,
// §youtubeChatSubView), "지금 채널이 맞는가"뿐 아니라 "지금 그 채널의
// 서브뷰가 이거 맞는가"까지 같이 봐야 한다. 다른 플랫폼은 서브뷰
// 개념이 없어 그냥 활성 채널인지만 본다.
function shouldShowYoutubeSubView(hash, view) {
  const ch = getChannelObjByHash(hash);
  if (!ch || ch.platform !== 'youtube' || !ch.videoId) return true;
  return getYoutubeChatSubView(hash) === view;
}

function syncChatVisibility() {
  if (!chatContainer) return;

  const iframes = chatContainer.querySelectorAll('iframe.chat-iframe');
  iframes.forEach(iframe => {
    const hash = iframe.getAttribute('data-hash');
    const isActive = hash === activeChatChannel && shouldShowYoutubeSubView(hash, 'chat');
    iframe.style.display = isActive ? 'block' : 'none';
  });
  const commentsPanels = chatContainer.querySelectorAll('.chat-comments-panel');
  commentsPanels.forEach(panel => {
    const hash = panel.getAttribute('data-hash');
    const isActive = hash === activeChatChannel && shouldShowYoutubeSubView(hash, 'comments');
    panel.style.display = isActive ? 'flex' : 'none';
  });
  reinitPendingHashes.forEach(h => updateChatReinitOverlayVisibility(h));
  syncChatSubViewToggleUI();
}

function ensureChatIframeLoaded(hash) {
  if (!chatContainer || !hash) return;

  let iframe = chatContainer.querySelector(`iframe[data-hash="${hash}"]`);
  if (!iframe) {
    const chObj = getChannelObjByHash(hash);
    const platform = chObj ? chObj.platform : 'chzzk';
    iframe = createChatIframe(hash, platform);
  }

  // 직접 display를 만지지 않고 syncChatVisibility에 맡긴다 — 유튜브는
  // 채팅/댓글 서브뷰(§youtubeChatSubView)에 따라 어느 쪽을 보여줄지가
  // 활성 채널 여부만으로는 안 정해진다.
  syncChatVisibility();
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
  renderAudioSettingsList();
  renderCollabSettingsSection();
}

function removeChannel(hash, opts) {
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
  const isMainTarget = (mainChannel === deleteHash || mainChannel === hash);
  const firstChzzkHash = getFirstChzzkHash();
  const isFirstChzzkDeleted = targetChannel.platform === 'chzzk' && deleteHash === firstChzzkHash;
  const shouldReloadAll = isFirstChzzkDeleted;

  console.log(`🗑️ [REMOVE] 삭제 요청 - Target: ${targetChannel.name} (${deleteHash}) | IsFirstChzzkDeleted: ${isFirstChzzkDeleted} | IsMain: ${isMainTarget}`);

  channels = channels.filter(c => c.hash !== deleteHash && c.name !== deleteHash);
  displayChannels = displayChannels.filter(c => c.hash !== deleteHash && c.name !== deleteHash);
  channelAddOrder = channelAddOrder.filter(h => h !== deleteHash && h !== hash);
  if (audioState.channelVolumeOverrides) {
    ['grid', 'sub'].forEach((role) => {
      const group = audioState.channelVolumeOverrides[role];
      if (!group) return;
      delete group[deleteHash];
      delete group[hash];
    });
    saveAudioState();
  }
  if (audioState.mainVolumeByChannel) {
    delete audioState.mainVolumeByChannel[deleteHash];
    delete audioState.mainVolumeByChannel[hash];
  }
  delete channelAudioLevels[deleteHash];
  delete channelAudioLevels[hash];
  delete channelAudioLevelHistory[deleteHash];
  delete channelAudioLevelHistory[hash];
  delete channelLevelingDbHistory[deleteHash];
  delete channelLevelingDbHistory[hash];
  delete debugDbHistory[deleteHash];
  delete debugDbHistory[hash];
  delete collabDbSmoothBuffer[deleteHash];
  delete collabDbSmoothBuffer[hash];
  delete collabVadDebugByHash[deleteHash];
  delete collabVadDebugByHash[hash];
  delete lastAppliedDisplayVolume[deleteHash];
  delete lastAppliedDisplayVolume[hash];
  delete lastAppliedRealVolume[deleteHash];
  delete lastAppliedRealVolume[hash];
  delete lastSentVolumeMessage[deleteHash];
  delete lastSentVolumeMessage[hash];
  ['grid', 'sub'].forEach((groupKey) => {
    if (groupReferenceHash[groupKey] === deleteHash || groupReferenceHash[groupKey] === hash) {
      delete groupReferenceHash[groupKey];
    }
    const challenger = groupReferenceChallengerSince[groupKey];
    if (challenger && (challenger.hash === deleteHash || challenger.hash === hash)) {
      delete groupReferenceChallengerSince[groupKey];
    }
  });
  delete offlineStreakByHash[deleteHash];
  delete offlineStreakByHash[hash];
  delete vodPickerShownByHash[deleteHash];
  delete vodPickerShownByHash[hash];
  debugForcedEndedHashes.delete(deleteHash);
  debugForcedEndedHashes.delete(hash);
  delete channelLatencySecByHash[deleteHash];
  delete channelLatencySecByHash[hash];
  delete lastKnownPlaybackTimeSec[deleteHash];
  delete lastKnownPlaybackTimeSec[hash];
  delete vodSyncLastCommandedPlaying[deleteHash];
  delete vodSyncLastCommandedPlaying[hash];
  vodAutoAlignPendingHashes.delete(deleteHash);
  vodAutoAlignPendingHashes.delete(hash);
  delete vodAutoAlignErrorByHash[deleteHash];
  delete vodAutoAlignErrorByHash[hash];
  delete audioState.vodStartTimeMsByHash[deleteHash];
  delete audioState.vodStartTimeMsByHash[hash];
  delete vodSyncRefineHistoryByMemberHash[deleteHash];
  delete vodSyncRefineHistoryByMemberHash[hash];
  delete collabResetHoldUntilByHash[deleteHash];
  delete collabResetHoldUntilByHash[hash];
  delete channelDurationSecByHash[deleteHash];
  delete channelDurationSecByHash[hash];
  delete collabLatencySmoothBuffer[deleteHash];
  delete collabLatencySmoothBuffer[hash];
  collabMutedHashes.delete(deleteHash);
  collabMutedHashes.delete(hash);
  deletePairEntriesForHash(deleteHash);
  deletePairEntriesForHash(hash);
  collabCaptureHashes.delete(deleteHash);
  collabCaptureHashes.delete(hash);
  collabWaveformUnavailableHashes.delete(deleteHash);
  collabWaveformUnavailableHashes.delete(hash);
  videoHiddenChannels.delete(deleteHash);
  videoHiddenChannels.delete(hash);
  if (pendingMainRestoreHash === deleteHash || pendingMainRestoreHash === hash) pendingMainRestoreHash = null;
  if (pruneCollabGroups()) saveAudioState();

  if (displayChannels.length > 0) {
    // (0번이었다는 이유만으로 재할당하던 isZeroDeleted 조건은 제거함.
    // 메인이 아닌, 우연히 0번 자리에 있던 채널을 지웠다고 해서 실제
    // 메인 채널이 다른 걸로 바뀌어버리는 버그였다. 삭제된 게 진짜 메인
    // 이었거나, 메인이 아예 없는 경우에만 새로 배정한다.)
    if (isMainTarget || !mainChannel) {
      mainChannel = displayChannels[0].hash;
    }
  } else {
    mainChannel = null;
  }

  if (activeChatChannel === deleteHash || activeChatChannel === hash) {
    activeChatChannel = mainChannel;
  }

  if (controlUnlockedHash === deleteHash || controlUnlockedHash === hash) controlUnlockedHash = null;

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
  // iframe이 아니라 네이티브 DOM으로 그리는 유튜브 댓글 패널은 위 iframe
  // 제거만으로는 안 지워진다 — 버그 수정: 지금까지 채널 삭제 시 정리가
  // 아예 빠져 있었다(패널 DOM + youtubeCommentsState가 그대로 남는 누수).
  removeYoutubeCommentsPanel(deleteHash);
  removeYoutubeCommentsPanel(hash);
  youtubeChatSubView.delete(deleteHash);
  youtubeChatSubView.delete(hash);
  youtubeChatToggleEligible.delete(deleteHash);
  youtubeChatToggleEligible.delete(hash);

  saveChannelsToStorage();
  renderQueueSidebar();

  if (shouldReloadAll && !(opts && opts.skipFullReload)) {
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

// 엔딩화면(추천 영상)에서 다른 영상을 클릭했을 때(§content.js의 치지직 VOD
// URL 변경 감지), 그 채널 "슬롯"을 통째로 지웠다 새로 추가하는 대신 같은
// 자리에 새 영상으로 바꿔 끼운다. 치지직 VOD는 hash 자체가 영상 식별자라
// (유튜브처럼 hash/videoId가 분리돼 있지 않음) 값을 직접 바꾸려면
// audioState/합방그룹/dB 이력 등 hash로 키를 삼는 모든 상태를 옮겨야
// 하는데, 그 목록을 여기서 손으로 다시 나열하면 하나라도 빠뜨리기 쉽다.
// 이미 정확하게 정리해주는 removeChannel을 그대로 재사용하고(단, 그
// 채널이 "가장 먼저 추가된 치지직 채널"이었어도 전체 재로드는 건너뛴다
// — 슬롯 하나만 바꾸는 거라 화면 전체를 새로고침할 필요가 없다), 지운
// 자리 그대로에 새 채널을 다시 끼워 넣는다. 오디오 오버라이드 등 이전
// 영상에 달려있던 상태는 자연스럽게 사라지고 새 채널은 기본값("자동")으로
// 시작한다.
function replaceVodChannelInPlace(oldHash, newChannelData) {
  if (!oldHash || !newChannelData || !newChannelData.hash) return;
  if (channels.some(c => c.hash === newChannelData.hash) || displayChannels.some(c => c.hash === newChannelData.hash)) {
    // 이미 같은 영상이 그리드에 있다(예: 추천 영상이 마침 다른 슬롯에도
    // 떠 있는 경우) — hash 충돌을 피하기 위해 그냥 기존 슬롯을 지우기만
    // 한다.
    removeChannel(oldHash);
    return;
  }

  const chIdx = channels.findIndex(c => c.hash === oldHash);
  const dispIdx = displayChannels.findIndex(c => c.hash === oldHash);
  const orderIdx = channelAddOrder.indexOf(oldHash);
  const wasMain = (mainChannel === oldHash);
  const wasActiveChat = (activeChatChannel === oldHash);

  removeChannel(oldHash, { skipFullReload: true });

  channels.splice(Math.min(Math.max(chIdx, 0), channels.length), 0, newChannelData);
  displayChannels.splice(Math.min(Math.max(dispIdx, 0), displayChannels.length), 0, newChannelData);
  channelAddOrder.splice(Math.min(Math.max(orderIdx, 0), channelAddOrder.length), 0, newChannelData.hash);
  if (wasMain) mainChannel = newChannelData.hash;
  if (wasActiveChat) activeChatChannel = newChannelData.hash;

  saveChannelsToStorage();
  renderAll();
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

  clearVideoGrid();

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

document.getElementById('logo')?.addEventListener('click', () => {
  channels = [];
  displayChannels = [];
  channelAddOrder = [];
  mainChannel = null;
  activeChatChannel = null;
  isFirstZeroRemoved = false;
  controlUnlockedHash = null;

  if (typeof channelInput !== 'undefined' && channelInput) {
    channelInput.value = '';
  } else {
    const inputElem = document.getElementById('channel-input'); 
    if (inputElem) inputElem.value = '';
  }

  clearVideoGrid();
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

let mySetting = {
  name: '내 프로필', avatar: '', connections: { chzzk: false, soop: false },
  minViewers: { ...DEFAULT_MIN_VIEWERS }, gridVolume: DEFAULT_CHANNEL_VOLUME, subVolume: DEFAULT_SUB_VOLUME,
  experimentalEnabled: false, audioOptimizationEnabled: false, collabSettingEnabled: false,
  dynamicsCompressorEnabled: false,
  // 디버그 모드 하위 두 섹션 — 실험실과 달리 상위(디버그 모드) 자체가
  // 기본 꺼짐이라, 하위는 켰을 때 예전 "디버그 모드 하나만 있던" 동작과
  // 같아지도록 기본값을 true로 둔다(둘 다 켜진 것처럼 보임).
  audioDebugEnabled: true, vodDebugEnabled: true
};
let profileConnectionChanged = false;

function loadSetting(callback) {
  const migrate = () => {
    if (!mySetting.connections) {
      mySetting.connections = { chzzk: !!mySetting.chzzkConnected, soop: false };
      delete mySetting.chzzkConnected;
    }
    // 최소 시청자수 설정: 저장된 값이 없거나 새로 추가된 플랫폼이면 기본값으로 채운다.
    mySetting.minViewers = { ...DEFAULT_MIN_VIEWERS, ...(mySetting.minViewers || {}) };
    if (typeof mySetting.gridVolume !== 'number' || isNaN(mySetting.gridVolume)) mySetting.gridVolume = DEFAULT_CHANNEL_VOLUME;
    if (typeof mySetting.subVolume !== 'number' || isNaN(mySetting.subVolume)) mySetting.subVolume = DEFAULT_SUB_VOLUME;
    // 실험실 기능은 전부 기본값이 꺼짐(false) — 저장된 값이 없으면 꺼진 채로 둔다.
    mySetting.experimentalEnabled = !!mySetting.experimentalEnabled;
    mySetting.audioOptimizationEnabled = !!mySetting.audioOptimizationEnabled;
    mySetting.collabSettingEnabled = !!mySetting.collabSettingEnabled;
    mySetting.dynamicsCompressorEnabled = !!mySetting.dynamicsCompressorEnabled;
    // 디버그 하위 스위치: 저장된 값이 아예 없는 경우(신규 사용자 또는
    // 이 기능 이전 버전에서 넘어온 경우)에만 true로 채운다 — 사용자가
    // 명시적으로 꺼둔 값(false)은 그대로 존중한다.
    if (typeof mySetting.audioDebugEnabled !== 'boolean') mySetting.audioDebugEnabled = true;
    if (typeof mySetting.vodDebugEnabled !== 'boolean') mySetting.vodDebugEnabled = true;
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

// 인스턴스 잠금용 캐시(cachedAccountInfo)와 별개로, 설정 화면을 열 때마다
// 최신 상태를 보여주기 위해 매번 새로 조회한다.
async function getAccountLabelForPlatform(platform) {
  try {
    let info = null;
    if (platform === 'chzzk') info = await getChzzkAccountKey();
    else if (platform === 'soop') info = await getSoopAccountKey();
    else if (platform === 'youtube') info = await getYoutubeAccountKey();
    return info ? info.label : null;
  } catch (err) {
    return null;
  }
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

  if (meta.enabled && connected) {
    const accountIdEl = document.createElement('span');
    accountIdEl.className = 'platform-account-id';
    accountIdEl.style.cssText = 'margin-left:6px; font-size:12px; color:#999;';
    row.appendChild(accountIdEl);
    getAccountLabelForPlatform(key).then((label) => {
      if (label) accountIdEl.textContent = `(${label})`;
    });
  }

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

function toggleSettingModal() {
  const modal = document.getElementById('setting-modal');
  if (modal && modal.classList.contains('active')) {
    closeSettingModal();
  } else {
    openSettingModal();
  }
}

function bindVolumeSettingInput(inputId, settingKey) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('change', () => {
    let value = parseInt(input.value, 10);
    if (isNaN(value) || value < 0) value = 0;
    if (value > 100) value = 100;
    input.value = value;
    mySetting[settingKey] = value;
    saveSetting();
    applyVolumeToAllChannels(true);
    renderAudioSettingsList();
  });
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
          <button type="button" class="settings-tab-btn" data-tab="lab" data-i18n="settings.tabLab">실험실</button>
          <button type="button" class="settings-tab-btn" data-tab="info" data-i18n="settings.tabInfo">안내</button>
        </div>

        <div class="settings-tab-panel" data-panel="settings">
          <div class="setting-section-title" data-i18n="settings.uiLanguageSection">표시 언어</div>
          <div class="yt-settings-row">
            <label class="yt-settings-label" for="ui-language-select" data-i18n="settings.uiLanguageLabel">언어</label>
            <select id="ui-language-select" class="yt-settings-select"></select>
          </div>
          <div class="yt-settings-hint" data-i18n="settings.uiLanguageHint">화면에 표시되는 언어를 바꿉니다.</div>

          <div class="setting-section-title" data-i18n="settings.accountSection">연동 계정</div>
          <div id="platform-list"></div>

          <div class="setting-section-title" data-i18n="settings.minViewersSection">최소 시청자수</div>
          <div class="yt-settings-row">
            <label class="yt-settings-label" for="min-viewer-platform-select" data-i18n="settings.minViewersPlatformLabel">플랫폼</label>
            <select id="min-viewer-platform-select" class="yt-settings-select"></select>
          </div>
          <div class="yt-settings-row">
            <label class="yt-settings-label" for="min-viewer-input" data-i18n="settings.minViewersValueLabel">최소 시청자수</label>
            <input type="number" id="min-viewer-input" class="yt-settings-select" min="0" step="1" />
          </div>
          <div class="yt-settings-hint" data-i18n="settings.minViewersHint">설정한 시청자수 미만인 라이브는 검색 결과에 표시되지 않습니다.</div>

          <div class="setting-section-title" data-i18n="settings.debugSection">디버그</div>
          <div class="yt-settings-row">
            <label class="yt-settings-label" for="debug-mode-toggle" data-i18n="settings.debugModeLabel">디버그 모드</label>
            <label class="setting-toggle">
              <input type="checkbox" id="debug-mode-toggle" />
              <span class="setting-toggle-track"></span>
            </label>
          </div>
          <div class="yt-settings-hint" data-i18n="settings.debugModeHint">켜야 아래 디버그 기능이 보이고 적용됩니다.</div>

          <div id="debug-feature-list" class="experimental-feature-list" hidden>
            <div class="setting-section-title" data-i18n="settings.debugAudioSectionTitle">오디오 디버그</div>
            <div class="yt-settings-row">
              <label class="yt-settings-label" for="audio-debug-toggle" data-i18n="settings.debugAudioToggleLabel">오디오 디버그 표시</label>
              <label class="setting-toggle">
                <input type="checkbox" id="audio-debug-toggle" />
                <span class="setting-toggle-track"></span>
              </label>
            </div>
            <div class="yt-settings-hint" data-i18n="settings.debugAudioToggleHint">채널별 오디오 패널에 dB 파형과 합방 분석(lag별 상관계수, 파형 유사도)을 표시합니다.</div>

            <div class="setting-section-title" data-i18n="settings.debugVodSectionTitle">방종 VOD 디버그</div>
            <div class="yt-settings-row">
              <label class="yt-settings-label" for="vod-debug-toggle" data-i18n="settings.debugVodToggleLabel">방종 VOD 디버그 표시</label>
              <label class="setting-toggle">
                <input type="checkbox" id="vod-debug-toggle" />
                <span class="setting-toggle-track"></span>
              </label>
            </div>
            <div class="yt-settings-hint" data-i18n="settings.debugVodToggleHint">치지직 라이브 채널에 "방송 종료 시뮬레이션" 토글을 표시해, 실제 방송 종료 없이 다시보기 패널을 테스트할 수 있게 합니다.</div>
          </div>
        </div>

        <div class="settings-tab-panel" data-panel="lab" hidden>
          <div class="setting-section-title" data-i18n="settings.labSection">실험실</div>
          <div class="yt-settings-row">
            <label class="yt-settings-label" for="experimental-toggle" data-i18n="settings.experimentalLabel">실험적 기능</label>
            <label class="setting-toggle">
              <input type="checkbox" id="experimental-toggle" />
              <span class="setting-toggle-track"></span>
            </label>
          </div>
          <div class="yt-settings-hint" data-i18n="settings.experimentalHint">켜야 아래 실험 기능이 보이고 적용됩니다.</div>

          <div id="experimental-feature-list" class="experimental-feature-list" hidden>
            <div class="setting-section-title" data-i18n="settings.audioOptimizationSection">오디오 최적화</div>
            <div class="yt-settings-row">
              <label class="yt-settings-label" for="audio-optimization-toggle" data-i18n="settings.audioOptimizationLabel">오디오 최적화 사용</label>
              <label class="setting-toggle">
                <input type="checkbox" id="audio-optimization-toggle" />
                <span class="setting-toggle-track"></span>
              </label>
            </div>
            <div class="yt-settings-hint" data-i18n="settings.audioOptimizationHint">같은 그룹 채널의 체감 음량을 자동으로 맞춥니다. 플레이어 표시 음량과 다를 수 있으니 확장 프로그램 설정을 사용하세요.</div>

            <div id="audio-optimization-detail" hidden>
              <div class="yt-settings-row">
                <label class="yt-settings-label" for="grid-volume-input" data-i18n="settings.gridVolumeLabel">그리드 모드 최대 음량</label>
                <input type="number" id="grid-volume-input" class="yt-settings-select" min="0" max="100" step="1" />
              </div>
              <div class="yt-settings-row">
                <label class="yt-settings-label" for="sub-volume-input" data-i18n="settings.subVolumeLabel">메인-서브 모드 최대 음량</label>
                <input type="number" id="sub-volume-input" class="yt-settings-select" min="0" max="100" step="1" />
              </div>
              <div class="yt-settings-hint" data-i18n="settings.audioHint">그리드/서브 모드 채널의 최대 음량입니다. 그리드는 그룹 중 가장 조용한 채널에 맞춰 나머지가 자동으로 낮아지고, 서브끼리는 평균 음량에 맞춰 조용한 채널은 볼륨을 더 받고 시끄러운 채널은 낮아집니다(모두 이 최대 음량을 넘지 않음). 거의 무음인 채널은 제외됩니다.</div>
            </div>

            <div class="setting-section-title" data-i18n="settings.collabSettingSection">합방 설정</div>
            <div class="yt-settings-row">
              <label class="yt-settings-label" for="collab-setting-toggle" data-i18n="settings.collabSettingLabel">합방 설정 사용</label>
              <label class="setting-toggle">
                <input type="checkbox" id="collab-setting-toggle" />
                <span class="setting-toggle-track"></span>
              </label>
            </div>
            <div class="yt-settings-hint" data-i18n="settings.collabSettingHint">활성화 시 채널별 오디오 패널 하단에 합방 설정 섹션이 나타납니다. 합방 그룹으로 지정한 채널 중 일부끼리 겹치는 소리가 감지되면 그중 하나(대표로 지정해뒀다면 항상 대표)만 남기고 나머지를 자동으로 음소거합니다.</div>

            <div id="collab-setting-detail">
              <div class="yt-settings-row">
                <label class="yt-settings-label" for="collab-vad-toggle" data-i18n="settings.collabVadLabel">AI 음성 감지 사용</label>
                <label class="setting-toggle">
                  <input type="checkbox" id="collab-vad-toggle" />
                  <span class="setting-toggle-track"></span>
                </label>
              </div>
              <div class="yt-settings-hint" data-i18n="settings.collabVadHint">두 채널 중 하나라도 실제로 말하고 있는 구간만 골라 겹침을 비교해 정확도를 높입니다. 최초 사용 시 약 15MB를 내려받고 CPU 사용량이 늘어납니다.</div>
              <div id="collab-vad-status" class="yt-settings-hint collab-vad-status"></div>

              <div class="yt-settings-row">
                <label class="yt-settings-label" for="vod-sync-toggle" data-i18n="settings.vodSyncLabel">VOD 합방 싱크 동기화 사용</label>
                <label class="setting-toggle">
                  <input type="checkbox" id="vod-sync-toggle" />
                  <span class="setting-toggle-track"></span>
                </label>
              </div>
              <div class="yt-settings-hint" data-i18n="settings.vodSyncHint">합방 그룹을 "VOD 싱크 동기화" 모드로 지정하면, 겹침 감지 대신 지정한 오프셋(초)만큼 재생 위치를 맞추고 대표 채널 외 나머지를 자동 음소거합니다.</div>
            </div>
          </div>
        </div>

        <div class="settings-tab-panel" data-panel="info" hidden>
          <div class="setting-section-title">CHEESE EYES</div>
          <div class="info-row"><span class="info-row-label" data-i18n="settings.versionLabel">버전</span><span id="info-version" class="info-row-value"></span></div>
          <div class="setting-section-title" data-i18n="settings.platformsSection">지원 플랫폼</div>
          <div class="info-platform-list" data-i18n="settings.platformsList">치지직(CHZZK) · 숲(SOOP) · 유튜브(YOUTUBE)</div>
          <div class="info-notice" data-i18n="settings.noticeStructure">플랫폼 구조 변경 시 정상 동작 하지 않을 수 있습니다.</div>
          <div class="info-notice" data-i18n="settings.noticeYoutubeTag">유튜브는 별도의 태그 검색을 지원하지 않습니다.</div>
          <div class="info-notice" data-i18n="settings.noticeKoreanSearch">치지직 / 숲은 한글 검색만을 지원합니다.</div>
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
    if (typeof window.applyStaticTranslations === 'function') window.applyStaticTranslations();

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

    const minViewerPlatformSelect = document.getElementById('min-viewer-platform-select');
    const minViewerInput = document.getElementById('min-viewer-input');
    if (minViewerPlatformSelect) {
      Object.keys(PLATFORM_META)
        .filter(key => PLATFORM_META[key].enabled)
        .forEach(key => {
          const el = document.createElement('option');
          el.value = key;
          el.textContent = getPlatformBrand(key);
          minViewerPlatformSelect.appendChild(el);
        });
    }
    if (minViewerPlatformSelect && minViewerInput) {
      minViewerPlatformSelect.addEventListener('change', () => {
        minViewerInput.value = getMinViewers(minViewerPlatformSelect.value);
      });
      minViewerInput.addEventListener('change', () => {
        const platform = minViewerPlatformSelect.value;
        let value = parseInt(minViewerInput.value, 10);
        if (isNaN(value) || value < 0) value = 0;
        minViewerInput.value = value;
        if (!mySetting.minViewers) mySetting.minViewers = { ...DEFAULT_MIN_VIEWERS };
        mySetting.minViewers[platform] = value;
        saveSetting();
      });
    }

    bindVolumeSettingInput('grid-volume-input', 'gridVolume');
    bindVolumeSettingInput('sub-volume-input', 'subVolume');

    const experimentalToggle = document.getElementById('experimental-toggle');
    const experimentalList = document.getElementById('experimental-feature-list');
    const audioOptimizationToggle = document.getElementById('audio-optimization-toggle');

    if (experimentalToggle) {
      experimentalToggle.addEventListener('change', () => {
        mySetting.experimentalEnabled = experimentalToggle.checked;
        saveSetting();
        if (experimentalList) experimentalList.hidden = !experimentalToggle.checked;
        recomputeCollabMuting();
        applyVolumeToAllChannels(true);
        refreshAudioSettingsListIfSafe();
      });
    }
    const audioOptimizationDetail = document.getElementById('audio-optimization-detail');
    if (audioOptimizationToggle) {
      audioOptimizationToggle.addEventListener('change', () => {
        mySetting.audioOptimizationEnabled = audioOptimizationToggle.checked;
        saveSetting();
        if (audioOptimizationDetail) audioOptimizationDetail.hidden = !audioOptimizationToggle.checked;
        applyVolumeToAllChannels(true);
      });
    }

    const collabSettingToggle = document.getElementById('collab-setting-toggle');
    const collabSettingDetail = document.getElementById('collab-setting-detail');
    if (collabSettingToggle) {
      collabSettingToggle.addEventListener('change', () => {
        mySetting.collabSettingEnabled = collabSettingToggle.checked;
        saveSetting();
        if (collabSettingDetail) collabSettingDetail.hidden = !collabSettingToggle.checked;
        recomputeCollabMuting();
        applyVolumeToAllChannels(true);
        refreshAudioSettingsListIfSafe();
      });
    }

    const collabVadToggle = document.getElementById('collab-vad-toggle');
    if (collabVadToggle) {
      collabVadToggle.addEventListener('change', () => {
        mySetting.collabVadEnabled = collabVadToggle.checked;
        saveSetting();
        // 켜는 즉시 로딩을 시작한다 — 준비되는 대로(=vadState가 'ready'로
        // 바뀌는 대로) 다음 Stage 2 재계산부터 자동으로 마스킹이 적용된다.
        // 여기서 응답을 기다리지 않는다(await 없음) — UI는 바로 반응하고,
        // 로딩 상태는 updateVadStatusUI가 별도로 반영한다.
        if (collabVadToggle.checked) ensureVadWorker();
      });
    }

    const vodSyncToggle = document.getElementById('vod-sync-toggle');
    if (vodSyncToggle) {
      vodSyncToggle.addEventListener('change', () => {
        mySetting.vodSyncEnabled = vodSyncToggle.checked;
        saveSetting();
        recomputeCollabMuting();
        renderCollabSettingsSection();
      });
    }

    const debugModeToggle = document.getElementById('debug-mode-toggle');
    const debugFeatureList = document.getElementById('debug-feature-list');
    if (debugModeToggle) {
      debugModeToggle.addEventListener('change', () => {
        mySetting.debugMode = debugModeToggle.checked;
        saveSetting();
        if (debugFeatureList) debugFeatureList.hidden = !debugModeToggle.checked;
        // 설정 화면에서 디버그 모드를 다시 켜는 건 "그래프 창을 다시
        // 보고 싶다"는 명시적 신호로 본다 — 예전에 ×로 창만 닫아뒀던
        // 상태(debugPanelManuallyClosed)를 여기서 리셋해야 창이 다시
        // 뜬다(§debugPanelManuallyClosed 주석).
        if (debugModeToggle.checked) debugPanelManuallyClosed = false;
        updateDebugPanelVisibility();
        // needsGraph(§postVolumeMessage)가 isAudioDebugSectionEnabled()도
        // 보므로(그 안에 isDebugModeEnabled()가 포함됨), 이미 로드돼 있는
        // 채널들에도 갱신된 needsGraph 플래그를 다시 보내줘야 한다 — 안
        // 그러면 다음 볼륨 변경 전까지는 합방 그룹 소속이 아닌 채널의 dB
        // 이력이 계속 텅 빈 채로 남는다.
        applyVolumeToAllChannels(true);
      });
    }

    const audioDebugToggle = document.getElementById('audio-debug-toggle');
    if (audioDebugToggle) {
      audioDebugToggle.addEventListener('change', () => {
        mySetting.audioDebugEnabled = audioDebugToggle.checked;
        saveSetting();
        applyVolumeToAllChannels(true); // needsGraph 갱신(위와 같은 이유)
      });
    }

    const vodDebugToggle = document.getElementById('vod-debug-toggle');
    if (vodDebugToggle) {
      vodDebugToggle.addEventListener('change', () => {
        mySetting.vodDebugEnabled = vodDebugToggle.checked;
        saveSetting();
      });
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
  // 준비중(미지원) 플랫폼은 연동 계정 목록에 노출하지 않는다. (예: 트위치)
  Object.keys(PLATFORM_META)
    .filter(key => PLATFORM_META[key].enabled)
    .forEach(key => renderPlatformRow(platformList, key));

  const uiLanguageSelect = document.getElementById('ui-language-select');
  if (uiLanguageSelect) {
    uiLanguageSelect.value = window.CHEESE_EYES_CURRENT_LANG
      || (typeof window.CHEESE_EYES_SUPPORTED_LANGS !== 'undefined' && window.CHEESE_EYES_SUPPORTED_LANGS[0])
      || 'ko';
  }

  const minViewerPlatformSelect = document.getElementById('min-viewer-platform-select');
  const minViewerInput = document.getElementById('min-viewer-input');
  if (minViewerPlatformSelect && minViewerInput) {
    if (!minViewerPlatformSelect.value && minViewerPlatformSelect.options.length > 0) {
      minViewerPlatformSelect.selectedIndex = 0;
    }
    minViewerInput.value = getMinViewers(minViewerPlatformSelect.value);
  }

  const populateVolumeInput = (id, getter) => {
    const el = document.getElementById(id);
    if (el) el.value = getter();
  };
  populateVolumeInput('grid-volume-input', getGridDefaultVolume);
  populateVolumeInput('sub-volume-input', getSubDefaultVolume);

  const experimentalToggle = document.getElementById('experimental-toggle');
  if (experimentalToggle) experimentalToggle.checked = isExperimentalEnabled();
  const experimentalList = document.getElementById('experimental-feature-list');
  if (experimentalList) experimentalList.hidden = !isExperimentalEnabled();
  const audioOptimizationToggle = document.getElementById('audio-optimization-toggle');
  if (audioOptimizationToggle) audioOptimizationToggle.checked = !!mySetting.audioOptimizationEnabled;
  const audioOptimizationDetail = document.getElementById('audio-optimization-detail');
  if (audioOptimizationDetail) audioOptimizationDetail.hidden = !mySetting.audioOptimizationEnabled;

  const collabSettingToggle = document.getElementById('collab-setting-toggle');
  if (collabSettingToggle) collabSettingToggle.checked = !!mySetting.collabSettingEnabled;
  const collabSettingDetail = document.getElementById('collab-setting-detail');
  if (collabSettingDetail) collabSettingDetail.hidden = !mySetting.collabSettingEnabled;
  const collabVadToggle = document.getElementById('collab-vad-toggle');
  if (collabVadToggle) collabVadToggle.checked = !!mySetting.collabVadEnabled;
  updateVadStatusUI();
  const vodSyncToggle = document.getElementById('vod-sync-toggle');
  if (vodSyncToggle) vodSyncToggle.checked = !!mySetting.vodSyncEnabled;

  const debugModeToggle = document.getElementById('debug-mode-toggle');
  if (debugModeToggle) debugModeToggle.checked = !!mySetting.debugMode;
  const debugFeatureList = document.getElementById('debug-feature-list');
  if (debugFeatureList) debugFeatureList.hidden = !mySetting.debugMode;
  const audioDebugToggle = document.getElementById('audio-debug-toggle');
  if (audioDebugToggle) audioDebugToggle.checked = !!mySetting.audioDebugEnabled;
  const vodDebugToggle = document.getElementById('vod-debug-toggle');
  if (vodDebugToggle) vodDebugToggle.checked = !!mySetting.vodDebugEnabled;
}

loadSetting(() => {
  syncAllLoginStatus();
  applyVolumeToAllChannels();
  updateDebugPanelVisibility();
  // 이전 세션에 "AI 음성 감지"를 켜둔 채로 저장했다면, 설정 창을 열지
  // 않아도 페이지 로딩과 동시에 다시 로딩을 시작한다 — 매번 설정을 열어야
  // 켜지는 건 아니어야 하므로.
  if (isCollabVadEnabled()) ensureVadWorker();
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

  // 정적 data-i18n-title 일괄 적용(applyStaticTranslations)이 이 버튼의
  // 상태에 따라 달라지는 타이틀("화면 숨김" ↔ "화면 표시")을 기본 문구로
  // 덮어썼을 수 있어, 언어가 바뀔 때마다 상태에 맞는 문구로 다시 맞춘다.
  updateChatTabVideoToggleIcons();
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