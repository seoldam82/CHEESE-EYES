// ── CHEESE EYES 다국어(i18n) 로더 ──────────────────────────────────────
// 번역 데이터를 fetch로 불러오지 않고 이 파일 안에 직접 내장한다.
// (콘텐츠 스크립트 컨텍스트에서 chrome-extension:// 리소스를 fetch할 때
//  페이지 CSP/네트워크 제약으로 "Failed to fetch"가 발생할 수 있어, 이를
//  근본적으로 없애기 위해 네트워크 요청 없이 즉시 사용 가능하도록 한다.)
// 지원 언어: ko(기본값), ja, en. 전역 t(key, fallback, vars) 헬퍼를 제공한다.
(function () {
  const LANG_STORAGE_KEY = 'ui_language';
  const DEFAULT_LANG = 'ko';
  const SUPPORTED_LANGS = ['ko', 'ja', 'en'];

  const TRANSLATIONS = {
    ko: {
      app: { chatPlaceholder: '채널을 추가하면 채팅이 동기화됩니다.' },
      input: { placeholder: '채널명, 태그 혹은 해시 입력 (,로 구분 가능)' },
      button: { addChannel: '채널 추가', tagSearch: '태그 검색', following: '팔로우 목록', savePreset: '프리셋 저장' },
      mode: { grid: '그리드 모드', mainSub: '메인-서브 모드', chat: '채팅', settings: '설정' },
      platformTabs: { all: '전체' },
      modal: {
        searchResultTitle: '검색 결과',
        liveConfirmLoading: '라이브 여부를 확인하는 중...',
        selectAll: '전체 선택',
        addSelected: '선택한 채널 추가',
        emptyPlatformResult: '해당 플랫폼의 채널이 없습니다.'
      },
      tagSearch: {
        titleTemplate: "'{keywords}' 태그 방송 채널",
        loading: '전체 태그 방송 정보를 불러오는 중...',
        noKeyword: '검색할 태그가 없습니다.',
        emptyResult: '해당 태그들을 모두 만족하는 방송 채널이 없습니다.',
        error: '데이터를 불러오지 못했습니다. 콘솔을 확인하세요.',
        youtubeUnsupported: '유튜브는 해시태그 기반 태그 검색을 지원하지 않습니다.'
      },
      following: {
        titlePrefix: '팔로우 채널 중 ',
        titleLive: '라이브',
        titleSuffix: ' 목록',
        loading: '팔로우 채널 목록을 불러오는 중...',
        empty: '라이브 중인 채널이 없습니다.',
        loginRequiredTemplate: '{platform} 로그인이 필요합니다.',
        loginButtonTemplate: '{platform} 로그인',
        loginDone: '로그인 완료'
      },
      settings: {
        title: '설정',
        tabSettings: '설정',
        tabInfo: '안내',
        uiLanguageSection: '표시 언어',
        uiLanguageLabel: '언어',
        uiLanguageHint: 'CHEESE EYES 화면 전체에 표시되는 언어를 바꿉니다.',
        accountSection: '연동 계정',
        versionLabel: '버전',
        platformsSection: '지원 플랫폼',
        platformsList: '치지직(CHZZK) · 숲(SOOP) · 유튜브(YOUTUBE)',
        noticeStructure: '플랫폼 구조 변경 시 정상 동작 하지 않을 수 있습니다.',
        noticeYoutubeTag: '유튜브는 태그 검색을 지원하지 않습니다.',
        contactSection: '문의 / 링크',
        githubRepo: 'GitHub 저장소',
        privacyPolicy: '개인정보처리방침',
        closeButton: '닫기',
        platformPreparing: '준비중',
        platformConnected: '연동됨',
        platformLogout: '로그아웃',
        platformLoggingOut: '로그아웃 중...',
        platformLogin: '로그인'
      },
      platform: {
        chzzk: '치지직',
        soop: '숲',
        youtube: '유튜브',
        twitch: '트위치'
      }
    },
    ja: {
      app: { chatPlaceholder: 'チャンネルを追加するとチャットが同期されます。' },
      input: { placeholder: 'チャンネル名、タグまたはハッシュを入力（,で区切り可能）' },
      button: { addChannel: 'チャンネル追加', tagSearch: 'タグ検索', following: 'フォロー一覧', savePreset: 'プリセット保存' },
      mode: { grid: 'グリッドモード', mainSub: 'メイン-サブモード', chat: 'チャット', settings: '設定' },
      platformTabs: { all: 'すべて' },
      modal: {
        searchResultTitle: '検索結果',
        liveConfirmLoading: 'ライブ配信を確認しています...',
        selectAll: 'すべて選択',
        addSelected: '選択したチャンネルを追加',
        emptyPlatformResult: '該当プラットフォームのチャンネルがありません。'
      },
      tagSearch: {
        titleTemplate: '「{keywords}」タグ配信チャンネル',
        loading: 'タグ配信情報を読み込み中...',
        noKeyword: '検索するタグがありません。',
        emptyResult: '該当するタグをすべて満たす配信チャンネルがありません。',
        error: 'データを読み込めませんでした。コンソールを確認してください。',
        youtubeUnsupported: 'YouTubeはハッシュタグによるタグ検索に対応していません。'
      },
      following: {
        titlePrefix: 'フォロー中チャンネルの',
        titleLive: 'ライブ',
        titleSuffix: '一覧',
        loading: 'フォローチャンネル一覧を読み込み中...',
        empty: '配信中のチャンネルがありません。',
        loginRequiredTemplate: '{platform}のログインが必要です。',
        loginButtonTemplate: '{platform}ログイン',
        loginDone: 'ログイン完了'
      },
      settings: {
        title: '設定',
        tabSettings: '設定',
        tabInfo: '案内',
        uiLanguageSection: '表示言語',
        uiLanguageLabel: '言語',
        uiLanguageHint: 'CHEESE EYES 画面全体に表示される言語を変更します。',
        accountSection: '連携アカウント',
        versionLabel: 'バージョン',
        platformsSection: '対応プラットフォーム',
        platformsList: 'CHZZK · SOOP · YouTube',
        noticeStructure: 'プラットフォームの構造が変更されると正常に動作しない場合があります。',
        noticeYoutubeTag: 'YouTubeはタグ検索に対応していません。',
        contactSection: 'お問い合わせ / リンク',
        githubRepo: 'GitHubリポジトリ',
        privacyPolicy: 'プライバシーポリシー',
        closeButton: '閉じる',
        platformPreparing: '準備中',
        platformConnected: '連携済み',
        platformLogout: 'ログアウト',
        platformLoggingOut: 'ログアウト中...',
        platformLogin: 'ログイン'
      },
      platform: {
        chzzk: 'CHZZK',
        soop: 'SOOP',
        youtube: 'YouTube',
        twitch: 'Twitch'
      }
    },
    en: {
      app: { chatPlaceholder: 'Chat will sync once you add a channel.' },
      input: { placeholder: 'Enter channel name, tag, or hashtag (comma-separated)' },
      button: { addChannel: 'Add Channel', tagSearch: 'Tag Search', following: 'Following List', savePreset: 'Save Preset' },
      mode: { grid: 'Grid Mode', mainSub: 'Main-Sub Mode', chat: 'Chat', settings: 'Settings' },
      platformTabs: { all: 'All' },
      modal: {
        searchResultTitle: 'Search Results',
        liveConfirmLoading: 'Checking who is live...',
        selectAll: 'Select All',
        addSelected: 'Add Selected Channels',
        emptyPlatformResult: 'No channels for this platform.'
      },
      tagSearch: {
        titleTemplate: "Live channels tagged '{keywords}'",
        loading: 'Loading tagged live channels...',
        noKeyword: 'No tag to search for.',
        emptyResult: 'No live channels match all of the given tags.',
        error: 'Failed to load data. Check the console.',
        youtubeUnsupported: 'YouTube does not support hashtag-based tag search.'
      },
      following: {
        titlePrefix: '',
        titleLive: 'Live',
        titleSuffix: ' channels you follow',
        loading: 'Loading followed channels...',
        empty: 'No channels are currently live.',
        loginRequiredTemplate: 'Sign-in to {platform} required.',
        loginButtonTemplate: 'Sign in to {platform}',
        loginDone: 'Signed in'
      },
      settings: {
        title: 'Settings',
        tabSettings: 'Settings',
        tabInfo: 'Info',
        uiLanguageSection: 'Display Language',
        uiLanguageLabel: 'Language',
        uiLanguageHint: 'Changes the language shown across the whole CHEESE EYES screen.',
        accountSection: 'Connected Accounts',
        versionLabel: 'Version',
        platformsSection: 'Supported Platforms',
        platformsList: 'CHZZK · SOOP · YouTube',
        noticeStructure: 'May not work correctly if a platform changes its structure.',
        noticeYoutubeTag: 'YouTube does not support tag search.',
        contactSection: 'Contact / Links',
        githubRepo: 'GitHub Repository',
        privacyPolicy: 'Privacy Policy',
        closeButton: 'Close',
        platformPreparing: 'Coming soon',
        platformConnected: 'Connected',
        platformLogout: 'Log out',
        platformLoggingOut: 'Logging out...',
        platformLogin: 'Log in'
      },
      platform: {
        chzzk: 'CHZZK',
        soop: 'SOOP',
        youtube: 'YouTube',
        twitch: 'Twitch'
      }
    }
  };

  let I18N = TRANSLATIONS[DEFAULT_LANG];

  function resolveKey(key) {
    return key.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), I18N);
  }

  // t('following.loginRequiredTemplate', '{platform} 로그인이 필요합니다.', { platform: '치지직' })
  window.t = function (key, fallback, vars) {
    let str = resolveKey(key);
    if (str === undefined) str = fallback !== undefined ? fallback : key;
    if (typeof str === 'string' && vars) {
      Object.keys(vars).forEach((k) => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), vars[k]);
      });
    }
    return str;
  };

  function applyStaticTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key, el.textContent);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = t(key, el.placeholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      el.title = t(key, el.title);
    });
    document.querySelectorAll('[data-i18n-alt]').forEach((el) => {
      const key = el.getAttribute('data-i18n-alt');
      el.alt = t(key, el.alt);
    });
  }
  window.applyStaticTranslations = applyStaticTranslations;

  function loadLanguage(lang) {
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
    I18N = TRANSLATIONS[safeLang] || TRANSLATIONS[DEFAULT_LANG];
    window.CHEESE_EYES_CURRENT_LANG = safeLang;
    applyStaticTranslations();
    document.dispatchEvent(new CustomEvent('cheeseeyes:i18n-ready', { detail: { lang: safeLang } }));
  }

  function getSavedLanguage() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([LANG_STORAGE_KEY], (result) => {
          resolve(SUPPORTED_LANGS.includes(result[LANG_STORAGE_KEY]) ? result[LANG_STORAGE_KEY] : DEFAULT_LANG);
        });
      } else {
        try {
          const saved = localStorage.getItem(LANG_STORAGE_KEY);
          resolve(SUPPORTED_LANGS.includes(saved) ? saved : DEFAULT_LANG);
        } catch (e) { resolve(DEFAULT_LANG); }
      }
    });
  }

  // 설정 UI 등에서 언어를 바꿀 때 호출
  window.setUiLanguage = async function (lang) {
    if (!SUPPORTED_LANGS.includes(lang)) return;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [LANG_STORAGE_KEY]: lang });
    } else {
      try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch (e) {}
    }
    loadLanguage(lang);
  };

  window.CHEESE_EYES_SUPPORTED_LANGS = SUPPORTED_LANGS;

  getSavedLanguage().then(loadLanguage);
  document.addEventListener('DOMContentLoaded', applyStaticTranslations);
})();