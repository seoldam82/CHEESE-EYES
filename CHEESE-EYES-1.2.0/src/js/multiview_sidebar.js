// [CHEESE EYES] 멀티뷰 스테이징 트레이 — 페이지에 직접 그려 넣는 오버레이.
// chrome.sidePanel 대신 이 방식을 쓰는 이유는 background.js 상단 주석 참고.
// Shadow DOM으로 격리해 치지직/숲/유튜브 페이지 CSS와 충돌하지 않게 한다.
// all_frames를 안 켰으므로 최상위 시청 탭에서만 그려진다. 목록 자체는
// background.js가 관리하는 전역 공유 목록이고, 이 스크립트는 탭마다 하나씩
// 그려지는 "화면"일 뿐이라 어느 탭에서 봐도 같은 데이터를 보여준다.
(function () {
  const PLATFORM_COLORS = {
    chzzk: '#00ffa3',
    soop: '#3385ff',
    youtube: '#ff0000'
  };

  let items = [];
  let expanded = false;
  let shadowRoot = null;
  let panelEl = null;
  let listEl = null;
  let handleBadgeEl = null;
  let sendBtnEl = null;
  let queueBtnEl = null;
  let selectAllEl = null;

  // "전송/대기열 추가" 버튼이 대상으로 삼을 항목을 platform+id 키로
  // "체크 해제한 것"만 추적한다(기본은 전부 선택) — 새로 담긴 항목은
  // 자연히 선택 상태로 시작한다.
  let deselectedKeys = new Set();
  function itemKey(it) { return `${it.platform}:${it.id}`; }
  function isSelected(it) { return !deselectedKeys.has(itemKey(it)); }
  function selectedItems() { return items.filter(isSelected); }

  // 드래그로 순서를 바꾸면(§render의 dragstart/dragover/drop) 바뀐 순서를
  // background.js의 staged_items에도 반영해 다른 탭 트레이와 어긋나지 않게 한다.
  function reorderItems(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const reordered = items.slice();
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    items = reordered;
    render();
    try {
      chrome.runtime.sendMessage({ type: 'REORDER_STAGED', order: items.map(itemKey) });
    } catch (err) {}
  }

  function platformLabel(platform) {
    return (window.t && t(`platform.${platform}`, platform)) || platform;
  }

  function tr(key, fallback, vars) {
    return (window.t && t(`multiviewTray.${key}`, fallback, vars)) || fallback;
  }

  // 목록을 통째로 다시 그리지 않고 버튼/배지만 가볍게 갱신하는 경로.
  function updateSendButtons() {
    handleBadgeEl.textContent = String(items.length);

    if (selectAllEl) {
      selectAllEl.checked = items.length > 0 && items.every(isSelected);
      selectAllEl.indeterminate = items.length > 0 && !selectAllEl.checked && items.some(isSelected);
    }

    const selected = selectedItems();
    sendBtnEl.disabled = selected.length === 0;
    sendBtnEl.textContent = selected.length > 0
      ? tr('sendButtonTemplate', `멀티뷰로 보내기 (${selected.length})`, { count: selected.length })
      : tr('sendButtonEmpty', '멀티뷰로 보내기');

    // 대기열(dashboard.js videoQueue)은 지금 유튜브 videoId 기준으로만
    // 동작해서(§background.js sendStagedToQueue) 치지직/숲 항목은 대상이
    // 아니다 — 선택된 항목 중 유튜브만 세어서 그 개수로 버튼을 표시한다.
    const youtubeCount = selected.filter((it) => it.platform === 'youtube').length;
    queueBtnEl.disabled = youtubeCount === 0;
    queueBtnEl.textContent = youtubeCount > 0
      ? tr('sendToQueueButtonTemplate', `대기열에 추가 (${youtubeCount})`, { count: youtubeCount })
      : tr('sendToQueueButtonEmpty', '대기열에 추가');
  }

  // 썸네일은 이제 다른 플랫폼(CDN)의 URL이라, 이 트레이가 떠 있는 페이지의
  // CSP(img-src)가 그 출처를 막으면 로드가 실패할 수 있다 — 실패 시 플랫폼
  // 아이콘 대체화면으로 넘어간다.
  function buildThumbFallback() {
    const fallback = document.createElement('div');
    fallback.className = 'item-thumb-fallback';
    fallback.textContent = '📺';
    return fallback;
  }

  function buildThumbEl(item) {
    if (!item.thumbnail) return buildThumbFallback();
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = item.title || item.id;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(buildThumbFallback()), { once: true });
    return img;
  }

  function render() {
    if (!shadowRoot) return;
    const host = shadowRoot.host;
    host.classList.toggle('cheese-tray-visible', items.length > 0);
    host.classList.toggle('cheese-tray-expanded', expanded && items.length > 0);

    listEl.innerHTML = '';
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'item';
      li.classList.toggle('deselected', !isSelected(item));
      li.style.setProperty('--platform-color', PLATFORM_COLORS[item.platform] || '#00ffa3');

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'item-thumb';
      thumbWrap.appendChild(buildThumbEl(item));

      // 항목별 체크박스(§sendToMultiview/sendToQueue에서 선택 항목만 전송) —
      // 기본은 전부 선택 상태.
      const checkLabel = document.createElement('label');
      checkLabel.className = 'item-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isSelected(item);
      // li 전체가 draggable(§아래)이라 체크박스 위에서 드래그가 시작되면
      // 클릭 대신 드래그로 해석될 수 있다 — 체크박스는 드래그 시작점에서 제외.
      checkbox.addEventListener('mousedown', (e) => e.stopPropagation());
      checkbox.addEventListener('change', () => {
        const key = itemKey(item);
        if (checkbox.checked) deselectedKeys.delete(key);
        else deselectedKeys.add(key);
        render();
      });
      checkLabel.appendChild(checkbox);
      thumbWrap.appendChild(checkLabel);

      const platformTag = document.createElement('span');
      platformTag.className = 'item-platform-tag';
      platformTag.textContent = platformLabel(item.platform);
      thumbWrap.appendChild(platformTag);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'item-remove';
      removeBtn.textContent = '×';
      removeBtn.title = tr('removeItem', '목록에서 제거');
      removeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeItem(index);
      });
      thumbWrap.appendChild(removeBtn);

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.title || item.id;

      // 드래그로 순서 변경(§reorderItems) — 놓은 위치의 항목 자리로 옮겨 들어간다.
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData('text/plain', String(index));
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        const raw = e.dataTransfer && e.dataTransfer.getData('text/plain');
        const fromIndex = raw ? parseInt(raw, 10) : NaN;
        if (Number.isNaN(fromIndex)) return;
        reorderItems(fromIndex, index);
      });

      li.appendChild(thumbWrap);
      li.appendChild(title);
      listEl.appendChild(li);
    });

    updateSendButtons();
  }

  function loadStaged() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_STAGED' }, (response) => {
        if (chrome.runtime.lastError) return;
        items = (response && response.items) || [];
        render();
      });
    } catch (err) {
      // 확장 컨텍스트 무효화 — 조용히 무시.
    }
  }

  function removeItem(index) {
    try {
      chrome.runtime.sendMessage({ type: 'REMOVE_STAGED_ITEM', index }, (response) => {
        if (chrome.runtime.lastError) return;
        items = (response && response.items) || items;
        render();
      });
    } catch (err) {}
  }

  function sendToMultiview() {
    const keys = selectedItems().map(itemKey);
    if (keys.length === 0) return;
    sendBtnEl.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: 'SEND_STAGED_TO_MULTIVIEW', keys }, () => {
        loadStaged();
      });
    } catch (err) { sendBtnEl.disabled = false; }
  }

  // 대기열에는 유튜브 항목만 들어간다. 이 트레이는 대시보드와 다른 탭에
  // 떠 있어 드래그로 바로 채널을 지정할 수 없으므로, 일단 미지정 상태로
  // 담아두고 대시보드의 대기열 사이드바에서 그리드 타일로 드래그해
  // 지정하게 한다(§dashboard.js setQueueItemTarget).
  function sendToQueue() {
    const keys = selectedItems().filter((it) => it.platform === 'youtube').map(itemKey);
    if (keys.length === 0) return;
    queueBtnEl.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: 'SEND_STAGED_TO_QUEUE', keys }, () => {
        loadStaged();
      });
    } catch (err) { queueBtnEl.disabled = false; }
  }

  function flashHandle() {
    const handle = shadowRoot.querySelector('.handle');
    handle.classList.remove('pulse');
    // eslint-disable-next-line no-unused-expressions
    handle.offsetWidth; // 리플로우 강제 — 애니메이션 재시작을 위해
    handle.classList.add('pulse');
  }

  function buildUi() {
    const host = document.createElement('div');
    host.id = 'cheese-eyes-multiview-tray-host';
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed !important;
        top: 50% !important;
        right: 0 !important;
        transform: translateY(-50%);
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        display: none;
      }
      :host(.cheese-tray-visible) { display: block; }

      .tray { display: flex; flex-direction: row; align-items: stretch; }

      .handle {
        flex: none;
        width: 26px;
        min-height: 72px;
        background: #13131a;
        border: 1px solid #323246;
        border-right: none;
        border-radius: 10px 0 0 10px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        cursor: pointer;
        color: #ffffff;
        box-shadow: -2px 0 10px rgba(0,0,0,0.35);
      }
      .handle .icon { font-size: 13px; line-height: 1; }
      .handle .badge {
        min-width: 16px;
        padding: 1px 4px;
        border-radius: 8px;
        background: #00ffa3;
        color: #04140d;
        font-size: 10px;
        font-weight: 700;
        text-align: center;
        line-height: 1.4;
      }
      @keyframes cheese-pulse {
        0% { box-shadow: -2px 0 10px rgba(0,255,163,0.0); }
        30% { box-shadow: -2px 0 18px rgba(0,255,163,0.85); }
        100% { box-shadow: -2px 0 10px rgba(0,0,0,0.35); }
      }
      .handle.pulse { animation: cheese-pulse 900ms ease-out; }

      .panel {
        width: 0;
        overflow: hidden;
        background: #13131a;
        border: 1px solid #323246;
        border-right: none;
        border-radius: 10px 0 0 10px;
        box-shadow: -2px 0 14px rgba(0,0,0,0.4);
        display: flex;
        flex-direction: column;
        transition: width 160ms ease-out;
      }
      :host(.cheese-tray-expanded) .panel { width: 220px; }

      .panel-inner { width: 220px; display: flex; flex-direction: column; max-height: 70vh; }

      .header {
        padding: 10px 12px 8px;
        border-bottom: 1px solid #1f1f2e;
        font-size: 12px;
        font-weight: 700;
        color: #ffffff;
        flex: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }

      .select-all {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        font-weight: 400;
        color: #8e8e99;
        cursor: pointer;
      }
      .select-all input { margin: 0; cursor: pointer; }

      .list-container { flex: 1 1 auto; overflow-y: auto; padding: 8px; }
      .list-container::-webkit-scrollbar { width: 0; height: 0; }

      ul.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

      .item {
        display: flex;
        flex-direction: column;
        background: #1a1a24;
        border: 1px solid #1f1f2e;
        border-radius: 8px;
        overflow: hidden;
        cursor: grab;
        user-select: none;
      }
      .item:active { cursor: grabbing; }
      .item.deselected { opacity: 0.45; }
      .item.drag-over { outline: 2px dashed #ffc800; outline-offset: -2px; }
      .item-thumb {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #000;
        border-bottom: 2px solid var(--platform-color, #00ffa3);
      }
      .item-check {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.55);
        border-radius: 5px;
        cursor: pointer;
      }
      .item-check input { margin: 0; cursor: pointer; }
      .item-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .item-thumb-fallback {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        background: #14141c;
      }
      .item-platform-tag {
        position: absolute;
        left: 4px;
        bottom: 4px;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--platform-color, #00ffa3);
        color: #04140d;
        font-size: 9px;
        font-weight: 700;
      }
      .item-remove {
        position: absolute;
        top: 3px;
        right: 3px;
        width: 18px;
        height: 18px;
        border: none;
        border-radius: 5px;
        background: rgba(0,0,0,0.55);
        color: #ffffff;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      .item-remove:hover { background: rgba(0,0,0,0.8); }
      .item-title {
        padding: 5px 7px 6px;
        font-size: 11px;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .footer { flex: none; padding: 8px; border-top: 1px solid #1f1f2e; display: flex; flex-direction: column; gap: 6px; }
      .send-btn, .queue-btn {
        width: 100%;
        padding: 8px 10px;
        border: none;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .send-btn { background: #ffc800; color: #000000; }
      .send-btn:disabled { background: #1c1c26; color: #8e8e99; cursor: default; }
      .queue-btn { background: #2f2f40; color: #ffffff; border: 1px solid #3d3d52; }
      .queue-btn:disabled { background: #1c1c26; color: #8e8e99; border-color: #262636; cursor: default; }
    `;
    shadowRoot.appendChild(style);

    const tray = document.createElement('div');
    tray.className = 'tray';

    const panel = document.createElement('div');
    panel.className = 'panel';
    panelEl = panel;

    const panelInner = document.createElement('div');
    panelInner.className = 'panel-inner';

    const header = document.createElement('div');
    header.className = 'header';
    const headerTitle = document.createElement('span');
    headerTitle.textContent = tr('title', '멀티뷰');
    header.appendChild(headerTitle);

    const selectAllLabel = document.createElement('label');
    selectAllLabel.className = 'select-all';
    const selectAllCheckbox = document.createElement('input');
    selectAllCheckbox.type = 'checkbox';
    selectAllCheckbox.addEventListener('change', () => {
      if (selectAllCheckbox.checked) {
        deselectedKeys.clear();
      } else {
        deselectedKeys = new Set(items.map(itemKey));
      }
      render();
    });
    selectAllEl = selectAllCheckbox;
    const selectAllText = document.createElement('span');
    selectAllText.textContent = tr('selectAll', '전체 선택');
    selectAllLabel.appendChild(selectAllCheckbox);
    selectAllLabel.appendChild(selectAllText);
    header.appendChild(selectAllLabel);

    const listContainer = document.createElement('div');
    listContainer.className = 'list-container';
    const list = document.createElement('ul');
    list.className = 'list';
    listEl = list;
    listContainer.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'footer';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'send-btn';
    sendBtn.addEventListener('click', sendToMultiview);
    sendBtnEl = sendBtn;
    footer.appendChild(sendBtn);

    const queueBtn = document.createElement('button');
    queueBtn.type = 'button';
    queueBtn.className = 'queue-btn';
    queueBtn.addEventListener('click', sendToQueue);
    queueBtnEl = queueBtn;
    footer.appendChild(queueBtn);

    panelInner.appendChild(header);
    panelInner.appendChild(listContainer);
    panelInner.appendChild(footer);
    panel.appendChild(panelInner);

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.title = tr('toggleHint', '멀티뷰 트레이 열기/닫기');
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '🧀';
    const badge = document.createElement('span');
    badge.className = 'badge';
    handleBadgeEl = badge;
    handle.appendChild(icon);
    handle.appendChild(badge);
    handle.addEventListener('click', () => {
      expanded = !expanded;
      render();
    });

    tray.appendChild(panel);
    tray.appendChild(handle);
    shadowRoot.appendChild(tray);
  }

  function whenBodyReady(cb) {
    if (document.documentElement) { cb(); return; }
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        cb();
      }
    });
    observer.observe(document, { childList: true });
  }

  function init() {
    buildUi();
    loadStaged();
    render();

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'STAGED_UPDATED') return;
      const prevCount = items.length;
      chrome.runtime.sendMessage({ type: 'GET_STAGED' }, (response) => {
        if (chrome.runtime.lastError) return;
        items = (response && response.items) || [];
        if (items.length > prevCount) {
          expanded = true;
          flashHandle();
        }
        render();
      });
    });
  }

  whenBodyReady(() => {
    if (document.addEventListener) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
      } else {
        init();
      }
    }
  });
})();
