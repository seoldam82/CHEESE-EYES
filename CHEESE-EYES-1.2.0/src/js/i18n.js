// ── CHEESE EYES 다국어(i18n) 로더 ──────────────────────────────────────
// 번역 데이터를 fetch가 아니라 파일에 직접 내장한다 — 콘텐츠 스크립트에서
// chrome-extension:// 리소스를 fetch하면 페이지 CSP/네트워크 제약으로
// "Failed to fetch"가 날 수 있어, 네트워크 요청 없이 즉시 쓰게 한다.
// 지원 언어: ko(기본값), en. 전역 t(key, fallback, vars) 헬퍼를 제공한다.
(function () {
  const LANG_STORAGE_KEY = 'ui_language';
  const DEFAULT_LANG = 'ko';
  const SUPPORTED_LANGS = ['ko', 'en'];

  const TRANSLATIONS = {
    ko: {
      app: {
        chatPlaceholder: '채널을 추가하면 채팅이 동기화됩니다.',
        chatReconnecting: '채팅 재연결 중...'
      },
      input: { placeholder: '채널명, 태그 혹은 해시 입력 (,로 구분 가능)' },
      button: { addChannel: '채널 추가', tagSearch: '태그 검색', following: '팔로우 목록', savePreset: '프리셋', importPreset: '가져오기' },
      mode: { grid: '그리드 모드', mainSub: '메인-서브 모드', chat: '채팅', queue: '대기열 (.)', settings: '설정 (v)', audioSettings: '채널별 오디오 설정 (`)', hideScreen: '화면 숨김(일시정지)', showScreen: '화면 표시' },
      platformTabs: { all: '전체' },
      video: {
        channelHome: '채널 홈으로 이동',
        dragHandle: '드래그하여 위치 이동',
        removeChannel: '채널 삭제'
      },
      chat: {
        refreshTooltip: '채팅 새로고침',
        subViewChat: '채팅',
        subViewComments: '댓글',
        commentsLoading: '댓글을 불러오는 중...',
        commentsLoadFailed: '댓글을 불러오지 못했습니다.',
        commentsEmpty: '댓글이 없습니다.',
        commentsLoadingMore: '더 불러오는 중...',
        commentPlaceholder: '댓글 추가...',
        replyPlaceholder: '답글 추가...',
        commentSubmit: '등록',
        commentPosting: '작성 중...',
        commentPostFailed: '작성에 실패했습니다. 로그인 상태를 확인해주세요.',
        commentsYou: '나',
        commentsJustNow: '방금 전',
        viewRepliesTemplate: '답글 {count}개 보기',
        hideReplies: '답글 숨기기',
        writeReply: '답글 달기',
        loadMoreReplies: '답글 더보기',
        repliesLoadFailed: '답글을 불러오지 못했습니다.'
      },
      queue: {
        title: '대기열',
        emptyState: '유튜브 추천 영상/영상 카드를 클릭하면 여기 대기열에 담깁니다. 슬롯이 자동으로 비면(영상 종료/라이브 오프라인) 이어서 채워 넣습니다.',
        pendingLabel: '대기 중',
        removeItem: '대기열에서 제거',
        addToGrid: '지정 안 된 영상 그리드에 추가',
        pause: '멈춤(자동 채우기 중지)',
        resume: '재생(자동 채우기 재개)',
        clearAll: '대기열 비우기',
        hide: '대기열 숨김',
        reservedForTemplate: '{name} 전용으로 예약됨',
        clearTarget: '지정 해제',
        clickToApply: '클릭하면 대기열에서 빼서 바로 멀티뷰에 추가합니다'
      },
      audio: {
        panelTitle: '채널별 오디오', roleMain: '메인', baselineLabel: '최대', playingLabel: '재생', manualLabel: '수동', resetLabel: '자동',
        collabSectionTitle: '합방 설정',
        collabAddGroup: '+ 그룹 추가',
        collabRemoveGroup: '그룹 삭제',
        collabUnnamedGroup: '새 합방 그룹',
        collabLeaderLabel: '대표',
        collabOverlapLabel: '겹침',
        collabMutedLabel: '음소거',
        collabMeasuringLabel: '측정 중',
        collabOverlapBadgeHintTemplate: '{partner} 채널과 음량이 같이 커지고 작아지는 정도(1차 신호) — 실제 음소거 여부는 옆의 파형 확인 결과도 함께 반영됩니다',
        collabOverlapBadgeHintGeneric: '음량이 같이 커지고 작아지는 정도(1차 신호) — 실제 음소거 여부는 옆의 파형 확인 결과도 함께 반영됩니다',
        collabWaveformScoreHintTemplate: '{partner} 채널과 파형 유사도: {score}% (기준 {threshold}%)',
        collabInOtherGroupLabel: '다른 그룹 소속',
        collabNoChannels: '채널이 2개 이상 있어야 합방 그룹을 만들 수 있습니다.',
        collabNoGroups: '합방 채널을 그룹으로 묶으면, 겹치는 채널들 중 하나만 남기고 자동 음소거합니다(대표로 지정한 채널이 있으면 항상 그 채널이 남습니다).',
        collabLatencySyncNotice: '채널을 추가했을 경우 새로고침 후 멤버를 추가하세요(레이턴시 동기화).',
        collabSetLeaderHint: '이 채널을 대표로 지정',
        collabInGroupHint: '합방 그룹 소속',
        groupedSectionLabel: '그룹',
        ungroupedSectionLabel: '그 외',
        collabWaveformUnavailableLabel: '파형 분석 불가',
        collabWaveformUnavailableHint: '이 채널은 오디오 최적화 워클릿을 쓸 수 없어(구형 브라우저 등) 파형 비교 없이 음량 타이밍만으로 판정합니다',
        collabWaveformMatchLabel: '같은 소리 확인됨',
        collabWaveformDifferentLabel: '다른 소리로 판단',
        collabWaveformPendingLabel: '파형 확인 중',
        collabWaveformPendingHint: '파형 비교 결과가 아직 없어 이 채널은 음소거하지 않습니다(확인될 때까지 대기)',
        collabWaveformGraceLabel: '이전 확인 유지 중',
        collabWaveformGraceHintTemplate: '{partner} 채널과 방금까지 같은 소리로 확인됐던 쌍입니다 — 말소리가 잠깐 없어 파형을 다시 확인하는 동안 이전 판정(음소거)을 유지합니다',
        collabWaveformResetHoldLabel: '전환 중 — 이전 상태 유지',
        collabWaveformResetHoldHint: '방금 시크/영상 전환이 있어 판정이 잠깐 불안정할 수 있는 구간이라, 그 직전의 음소거 상태를 그대로 유지하고 있습니다',
        collabModeLive: '라이브',
        collabModeVodSync: 'VOD',
        collabVodOffsetLabel: '오프셋(초)',
        collabVodOffsetHint: '대표 채널보다 이 채널이 몇 초 늦게 시작하는 VOD인지 직접 입력하세요. 비워두면 정렬 전으로 취급해 자동 음소거/시크를 하지 않습니다.',
        collabVodSyncPendingLabel: '정렬 전',
        collabVodSyncAlignedLabel: '동기화됨',
        collabVodAlignComputing: 'VOD 메타데이터로 오프셋 계산 중…',
        collabVodAlignFailedTemplate: '자동 계산 실패: {error} — 직접 입력하세요',
        collabVodScanTestLabel: '오디오 스캔 테스트',
        collabVodScanTestRunning: '스캔 중...',
        collabVodScanTestSuccessTemplate: '성공: {seconds}초 디코딩됨 ({sampleRate}Hz, {channels}ch, 세그먼트 {decoded}/{attempted})',
        collabVodScanTestFailTemplate: '실패: {error}',
        collabVodSpeechScanTestLabel: '발화 구간 탐지 테스트',
        collabVodSpeechScanProgressTemplate: '탐지 중... {processed}{total}',
        collabVodSpeechScanSecondsTemplate: '{n}초',
        collabVodSpeechScanOfTotalTemplate: ' / {n}초',
        collabVodSpeechScanSuccessTemplate: '성공: {blocks}개 발화 블록, {processed}초 처리(세그먼트 {decoded}/{attempted})',
        collabVodAlignTestLabel: '자동 정렬 시도(디버그)',
        collabVodAlignStageRep: '대표 채널 음량 분석 중',
        collabVodAlignStageMember: '멤버 채널 음량 분석 중',
        collabVodAlignStageCoarse: '코스 정렬 계산 중',
        collabVodAlignStageFine: '파인 정렬 계산 중',
        collabVodAlignSuccessTemplate: '성공: 오프셋 {offset}초 추정(파형 유사도 {score}) — 맞으면 위 입력칸에 직접 입력하세요',
        collabVodAlignProgressTemplate: '{label}... {processed}{total}',
        collabVodAlignProgressStageOnlyTemplate: '{label}...',
        debugPanelTitle: 'CHEESE EYES 디버그',
        debugPanelClose: '닫기',
        debugPanelNoChannels: '채널이 없습니다.',
        debugAudioSectionTitle: '오디오 디버그',
        debugVodSectionTitle: '방종 VOD 디버그',
        vodDebugToggleLabel: '방송 종료 시뮬레이션',
        vodDebugUnsupported: '치지직 라이브 채널만 테스트할 수 있습니다(VOD 자체/다른 플랫폼 제외).',
        vodDebugStatusShown: '시뮬레이션 중 — 다시보기 패널이 실제 라이브 상태와 무관하게 유지됩니다.',
        vodDebugStatusLoading: '다시보기 목록을 조회하는 중...',
        vodDebugStatusOff: '켜면 이 채널을 즉시 "방송 종료" 상태로 만들어 다시보기 패널을 띄웁니다.',
        vodDebugEffectNoTile: '실제 상태: 이 채널의 화면 타일을 찾을 수 없음(그리드에 그려지지 않음)',
        vodDebugEffectShown: '실제 상태: 다시보기 패널 표시 중',
        vodDebugEffectHidden: '실제 상태: 라이브 화면(패널 없음)',
        debugDbTitleTemplate: '{mark} 채널 음량(dB) 파형',
        debugDbDesc: '이 채널의 음량이 시간에 따라 어떻게 움직이는지 — 아래 모든 판정의 원본 신호입니다.',
        debugSamplesTemplate: '{count}개 샘플, {sec}초 범위',
        debugLatestSuffixTemplate: ' — 최신 {value}',
        debugDbLegendTemplate: '노랑: 실제 재생 볼륨 계산에 쓰이는 값 / 파랑: 합방 판정용 음성대역 값(참고용){voiceValue} / 빨강: 재생 볼륨(%)까지 반영해 실제로 들리는 크기',
        debugDbLegendVoiceSuffixTemplate: ' (최신 {value})',
        debugEffectiveDbTemplate: '지금 재생 볼륨({volume}%) 반영 시 체감 음량: {value}',
        debugDataNotReady: 'data not ready',
        debugClusterTemplate: '지금 {members}와 겹침으로 묶임 / 유지 채널: {keeper}',
        debugVadTitleTemplate: '{mark} 말소리 감지(AI 음성 활동 검출)',
        debugVadDesc: '이 채널이 실제로 말하고 있다고 판단된 구간(초록)만 다른 채널과의 겹침 비교에 쓰입니다.',
        debugVadLoading: '모델 로딩 중 — 그동안은 마스킹 없이 비교합니다.',
        debugVadUnavailable: '사용 불가 — 마스킹 없이 비교합니다.',
        debugVadStatsTemplate: '발화 구간 비율 {ratio}% (기준 {threshold}% 확률 이상) / {age}초 전 계산',
        debugVadPending: '아직 측정 전(합방 후보 쌍이 생기면 계산됩니다)',
        debugStage1TitleTemplate: '{mark} 1차 신호: {partner} 채널과의 겹침 패턴 상관관계',
        debugStage1Desc: '겹치는 다른 채널과 음량이 같이 커지고 작아지는 정도를 시간차(lag)별로 비교합니다 — 아직 "같은 소리"인지는 확인 전입니다.',
        debugStage1ValueTemplate: '최종 겹침 % 계산에 쓰는 값: {value}',
        debugStage1ValueNone: '아직 없음',
        debugStage2TitleTemplate: '{mark} 2차 신호: {partner} 채널과 파형 최종 확인',
        debugStage2Desc: '1차 신호로 후보가 된 쌍만 실제 파형을 비교해 "진짜 같은 소리"인지 최종 확인합니다 — 이 결과가 실제 음소거 여부를 결정합니다.',
        debugWaveformUnavailableDesc: '이 채널은 워클릿을 못 써서(구형 브라우저 등) 1차 신호만으로 판정합니다.',
        debugWaveformStatsTemplate: '유사도 {score}% (기준 {threshold}%) / lag {lag}s / {age}초 전 계산({compute})',
        debugWaveformPendingDesc: '아직 측정 전(캡처 워밍업 중이거나 아직 후보가 아님)',
        debugWaveformGraceDescTemplate: '{age}초 전 마지막으로 같은 소리로 확인됨 — 말소리가 없어 파형을 다시 확인하는 중이라(유예 최대 {grace}초) 그때까지는 이전 판정(음소거)을 유지합니다.',
        debugVadNoteReady: 'AI 음성 감지: 사용 중 — 위 ③·④ 계산 모두 두 채널 중 하나라도 말하는 구간만 사용',
        debugVadNoteLoading: 'AI 음성 감지: 모델 로딩 중(그동안은 마스킹 없이 비교)',
        debugVadNoteUnavailable: 'AI 음성 감지: 사용 불가(마스킹 없이 비교)'
      },
      preset: {
        modalTitle: '프리셋 저장',
        nameLabel: '프리셋 이름',
        namePlaceholder: '예) 종합게임 스트리머',
        colorLabel: '프리셋 색상',
        searchLabel: '채널 검색',
        searchPlaceholder: '채널명을 입력하세요',
        searchEmpty: '검색 결과가 없습니다.',
        add: '추가',
        added: '추가됨',
        selectedChannelsLabel: '추가된 채널',
        clearSelected: '전체 삭제',
        cancel: '취소',
        save: '저장',
        noChannels: '저장할 채널이 없습니다.',
        nameRequired: '프리셋 이름을 입력해주세요.',
        duplicateName: '이미 같은 이름의 프리셋이 있습니다.',
        clearAllConfirm: '저장된 모든 프리셋을 삭제하시겠습니까?',
        noLiveChannels: '현재 라이브 중인 채널이 없습니다.',
        loading: '불러오는 중...',
        shareTitle: '프리셋 공유',
        copyCode: '코드 복사',
        copied: '복사됨!',
        copyFailed: '복사 실패',
        importTitle: '프리셋 가져오기',
        importPlaceholder: '공유받은 코드를 붙여넣으세요',
        importConfirm: '가져오기',
        importFailed: '유효하지 않은 프리셋 코드입니다.',
        overwriteConfirm: '이 프리셋을 덮어쓰시겠습니까?',
        overwriteButton: '덮어쓰기',
        noticeTitle: '안내',
        noticeOk: '확인'
      },
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
        youtubeUnsupported: '유튜브는 별도의 태그 검색을 지원하지 않습니다.'
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
      vodPicker: {
        ended: '방송이 종료되었습니다',
        loading: '다시보기를 확인하는 중...',
        title: '다시보기 선택',
        empty: '다시보기를 찾을 수 없습니다.',
        refresh: '다시 확인',
        latestBadge: '최신',
        minuteSuffix: '분',
        tabStreams: '다시보기(VOD)',
        tabVideos: '채널 영상'
      },
      vodSearch: {
        chzzkOnlyNotice: '지금은 r(또는 ㄱ) 검색이 치지직/유튜브 채널만 지원합니다.',
        notFoundNotice: '"{name}" 채널을 찾을 수 없습니다.'
      },
      instanceLock: {
        messageDevice: '동일한 확장 앱으로 이미 다른 창(또는 탭)의 CHEESE EYES가 실행 중입니다.<br>그 창을 닫은 뒤 잠시 후 이 창을 새로고침해 주세요.',
        liveLoginRequired: '{platform} 라이브를 보려면 먼저 {platform}에 로그인해야 합니다.',
        liveAccountCollision: '{platform} 계정이 다른 곳에서 이미 CHEESE EYES로 사용 중이라, {platform} 라이브가 제한됩니다.'
      },
      settings: {
        title: '설정',
        tabSettings: '설정',
        tabLab: '실험실',
        tabInfo: '안내',
        uiLanguageSection: '표시 언어',
        uiLanguageLabel: '언어',
        uiLanguageHint: '화면에 표시되는 언어를 바꿉니다.',
        accountSection: '연동 계정',
        minViewersSection: '최소 시청자수',
        minViewersPlatformLabel: '플랫폼',
        minViewersValueLabel: '최소 시청자수',
        minViewersHint: '설정한 시청자수 미만인 라이브는 검색 결과에 표시되지 않습니다.',
        debugSection: '디버그',
        debugModeLabel: '디버그 모드',
        debugModeHint: '켜야 아래 디버그 기능이 보이고 적용됩니다.',
        debugAudioSectionTitle: '오디오 디버그',
        debugAudioToggleLabel: '오디오 디버그 표시',
        debugAudioToggleHint: '채널별 오디오 패널에 dB 파형과 합방 분석(lag별 상관계수, 파형 유사도)을 표시합니다.',
        debugVodSectionTitle: '방종 VOD 디버그',
        debugVodToggleLabel: '방종 VOD 디버그 표시',
        debugVodToggleHint: '치지직 라이브 채널에 "방송 종료 시뮬레이션" 토글을 표시해, 실제 방송 종료 없이 다시보기 패널을 테스트할 수 있게 합니다.',
        debugVodSyncSectionTitle: 'VOD 싱크 동기화 디버그',
        debugVodSyncToggleLabel: 'VOD 싱크 디버그 표시',
        debugVodSyncToggleHint: '합방 그룹 카드의 VOD 싱크 멤버(치지직)에 "오디오 스캔 테스트" 버튼을 표시합니다. 오디오 디버그(dB 파형 등)와 별개로 켜고 끌 수 있습니다.',
        gridVolumeLabel: '그리드 모드 최대 음량',
        subVolumeLabel: '메인-서브 모드 최대 음량',
        audioHint: '그리드/서브 모드 채널의 최대 음량입니다. 그리드는 그룹 중 가장 조용한 채널에 맞춰 나머지가 자동으로 낮아지고, 서브끼리는 평균 음량에 맞춰 조용한 채널은 볼륨을 더 받고 시끄러운 채널은 낮아집니다(모두 이 최대 음량을 넘지 않음). 거의 무음인 채널은 제외됩니다.',
        labSection: '실험실',
        experimentalLabel: '실험적 기능',
        experimentalHint: '켜야 아래 실험 기능이 보이고 적용됩니다.',
        audioOptimizationSection: '오디오 최적화',
        audioOptimizationLabel: '오디오 최적화 사용',
        audioOptimizationHint: '같은 그룹 채널의 체감 음량을 자동으로 맞춥니다. 플레이어 표시 음량과 다를 수 있으니 확장 프로그램 설정을 사용하세요.',
        dynamicsCompressorLabel: '다이나믹 컴프레서 사용',
        dynamicsCompressorHint: '채널별 음량 기복(비명·소곤거림 등)을 먼저 다듬은 뒤 채널 간 음량을 비교합니다.',
        collabSettingSection: '합방 설정',
        collabSettingLabel: '합방 설정 사용',
        collabSettingHint: '활성화 시 채널별 오디오 패널 하단에 합방 설정 섹션이 나타납니다. 합방 그룹으로 지정한 채널 중 일부끼리 겹치는 소리가 감지되면 그중 하나(대표로 지정해뒀다면 항상 대표)만 남기고 나머지를 자동으로 음소거합니다.',
        collabVadLabel: 'AI 음성 감지 사용',
        collabVadHint: '두 채널 중 하나라도 실제로 말하고 있는 구간만 골라 겹침을 비교해 정확도를 높입니다. 최초 사용 시 약 15MB를 내려받고 CPU 사용량이 늘어납니다.',
        collabVadStatusLoading: 'AI 음성 감지 모델을 불러오는 중입니다... (최초 1회, 최대 몇십 초)',
        collabVadStatusReady: 'AI 음성 감지 사용 중',
        collabVadStatusUnavailable: 'AI 음성 감지를 사용할 수 없어 이전 방식으로 대체합니다.',
        vodSyncLabel: 'VOD 합방 싱크 동기화 사용',
        vodSyncHint: '합방 그룹을 "VOD 싱크 동기화" 모드로 지정하면, 겹침 감지 대신 지정한 오프셋(초)만큼 재생 위치를 맞추고 대표 채널 외 나머지를 자동 음소거합니다.',
        versionLabel: '버전',
        platformsSection: '지원 플랫폼',
        platformsList: '치지직(CHZZK) · 숲(SOOP) · 유튜브(YOUTUBE)',
        noticeStructure: '플랫폼 구조 변경 시 정상 동작 하지 않을 수 있습니다.',
        noticeYoutubeTag: '유튜브는 별도의 태그 검색을 지원하지 않습니다.',
        noticeKoreanSearch: '치지직 / 숲은 한글 검색만을 지원합니다.',
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
      },
      multiviewTray: {
        title: '멀티뷰',
        emptyState: '시청 중인 영상을 마우스 가운데 버튼으로 클릭하면 여기에 담깁니다.',
        removeItem: '목록에서 제거',
        sendButtonTemplate: '멀티뷰로 보내기 ({count})',
        sendButtonEmpty: '멀티뷰로 보내기',
        sendToQueueButtonTemplate: '대기열에 추가 ({count})',
        sendToQueueButtonEmpty: '대기열에 추가',
        selectAll: '전체 선택',
        toggleHint: '멀티뷰 트레이 열기/닫기'
      }
    },
    en: {
      app: {
        chatPlaceholder: 'Chat will sync once you add a channel.',
        chatReconnecting: 'Reconnecting chat...'
      },
      input: { placeholder: 'Enter channel name, tag or hash' },
      button: { addChannel: 'Add Channel', tagSearch: 'Tag Search', following: 'Following List', savePreset: 'Preset', importPreset: 'Import' },
      mode: { grid: 'Grid Mode', mainSub: 'Main-Sub Mode', chat: 'Chat', queue: 'Queue (.)', settings: 'Settings (v)', audioSettings: 'Per-Channel Audio Settings (`)', hideScreen: 'Hide screen (pauses)', showScreen: 'Show screen' },
      platformTabs: { all: 'All' },
      video: {
        channelHome: 'Open channel home',
        dragHandle: 'Drag to reorder',
        removeChannel: 'Remove channel'
      },
      chat: {
        refreshTooltip: 'Refresh chat',
        subViewChat: 'Chat',
        subViewComments: 'Comments',
        commentsLoading: 'Loading comments...',
        commentsLoadFailed: 'Failed to load comments.',
        commentsEmpty: 'No comments yet.',
        commentsLoadingMore: 'Loading more...',
        commentPlaceholder: 'Add a comment...',
        replyPlaceholder: 'Add a reply...',
        commentSubmit: 'Post',
        commentPosting: 'Posting...',
        commentPostFailed: 'Failed to post. Please check that you\'re logged in.',
        commentsYou: 'You',
        commentsJustNow: 'Just now',
        viewRepliesTemplate: 'View {count} replies',
        hideReplies: 'Hide replies',
        writeReply: 'Reply',
        loadMoreReplies: 'Show more replies',
        repliesLoadFailed: 'Failed to load replies.'
      },
      queue: {
        title: 'Queue',
        emptyState: 'Click a YouTube suggested video or video card to stage it here. It fills any slot that empties automatically (video ended / channel went offline).',
        pendingLabel: 'Queued',
        removeItem: 'Remove from queue',
        addToGrid: 'Add unassigned videos to grid',
        pause: 'Pause (stop auto-fill)',
        resume: 'Resume (enable auto-fill)',
        clearAll: 'Clear queue',
        hide: 'Hide queue',
        reservedForTemplate: 'Reserved for {name}',
        clearTarget: 'Clear assignment',
        clickToApply: 'Click to remove from queue and add straight to multiview'
      },
      audio: {
        panelTitle: 'Per-Channel Audio', roleMain: 'Main', baselineLabel: 'Max', playingLabel: 'Playing', manualLabel: 'Manual', resetLabel: 'Auto',
        collabSectionTitle: 'Collab Settings',
        collabAddGroup: '+ Add Group',
        collabRemoveGroup: 'Remove group',
        collabUnnamedGroup: 'New collab group',
        collabLeaderLabel: 'Representative',
        collabOverlapLabel: 'Overlap',
        collabMutedLabel: 'Muted',
        collabMeasuringLabel: 'Measuring',
        collabOverlapBadgeHintTemplate: 'How closely this volume rises and falls together with the {partner} channel\'s (Stage 1 signal) — whether it actually mutes also depends on the waveform check next to it',
        collabOverlapBadgeHintGeneric: 'How closely this volume rises and falls together with another channel (Stage 1 signal) — whether it actually mutes also depends on the waveform check next to it',
        collabWaveformScoreHintTemplate: 'Waveform similarity with {partner}: {score}% (threshold {threshold}%)',
        collabInOtherGroupLabel: 'In another group',
        collabNoChannels: 'You need at least 2 channels to create a collab group.',
        collabNoGroups: 'Group channels broadcasting together — when a subset overlaps, only one of them stays audible and the rest mute automatically (the representative, if set, always stays).',
        collabLatencySyncNotice: 'If you just added a channel, refresh the page before adding it as a member (for latency sync).',
        collabSetLeaderHint: 'Set this channel as representative',
        collabInGroupHint: 'In a collab group',
        groupedSectionLabel: 'Group',
        ungroupedSectionLabel: 'Others',
        collabWaveformUnavailableLabel: 'Waveform analysis unavailable',
        collabWaveformUnavailableHint: "This channel can't use the audio optimization worklet (older browser, etc.), so it's judged by volume timing alone, without waveform comparison",
        collabWaveformMatchLabel: 'Same audio confirmed',
        collabWaveformDifferentLabel: 'Judged as different audio',
        collabWaveformPendingLabel: 'Checking waveform...',
        collabWaveformPendingHint: "No waveform comparison result yet, so this channel isn't muted (waiting until it's confirmed)",
        collabWaveformGraceLabel: 'Holding previous match',
        collabWaveformGraceHintTemplate: 'This pair was confirmed as the same audio as {partner} until just now — holding the previous verdict (muted) while re-checking the waveform during this brief silence',
        collabWaveformResetHoldLabel: 'Transitioning — holding previous state',
        collabWaveformResetHoldHint: "A seek or video change just happened, so the verdict could be briefly unstable — holding the mute state from right before that",
        collabModeLive: 'Live',
        collabModeVodSync: 'VOD',
        collabVodOffsetLabel: 'Offset (sec)',
        collabVodOffsetHint: 'Enter how many seconds later this channel\'s VOD starts compared to the representative channel. Leave blank to treat it as not yet aligned (no automatic muting/seeking).',
        collabVodSyncPendingLabel: 'Not aligned yet',
        collabVodSyncAlignedLabel: 'Synced',
        collabVodAlignComputing: 'Computing offset from VOD metadata…',
        collabVodAlignFailedTemplate: 'Auto-calculation failed: {error} — please enter it manually',
        collabVodScanTestLabel: 'Test audio scan',
        collabVodScanTestRunning: 'Scanning...',
        collabVodScanTestSuccessTemplate: 'Success: decoded {seconds}s ({sampleRate}Hz, {channels}ch, segments {decoded}/{attempted})',
        collabVodScanTestFailTemplate: 'Failed: {error}',
        collabVodSpeechScanTestLabel: 'Test speech block detection',
        collabVodSpeechScanProgressTemplate: 'Scanning... {processed}{total}',
        collabVodSpeechScanSecondsTemplate: '{n}s',
        collabVodSpeechScanOfTotalTemplate: ' / {n}s',
        collabVodSpeechScanSuccessTemplate: 'Success: {blocks} speech blocks, {processed}s processed (segments {decoded}/{attempted})',
        collabVodAlignTestLabel: 'Try auto-alignment (debug)',
        collabVodAlignStageRep: 'Analyzing loudness on representative',
        collabVodAlignStageMember: 'Analyzing loudness on member',
        collabVodAlignStageCoarse: 'Computing coarse alignment',
        collabVodAlignStageFine: 'Computing fine alignment',
        collabVodAlignSuccessTemplate: 'Success: estimated offset {offset}s (waveform similarity {score}) — if correct, enter it in the field above',
        collabVodAlignProgressTemplate: '{label}... {processed}{total}',
        collabVodAlignProgressStageOnlyTemplate: '{label}...',
        debugPanelTitle: 'CHEESE EYES Debug',
        debugPanelClose: 'Close',
        debugPanelNoChannels: 'No channels.',
        debugAudioSectionTitle: 'Audio Debug',
        debugVodSectionTitle: 'Ended-Broadcast VOD Debug',
        vodDebugToggleLabel: 'Simulate broadcast ended',
        vodDebugUnsupported: 'Only live CHZZK channels can be tested (not VODs or other platforms).',
        vodDebugStatusShown: 'Simulating — the replay panel stays up regardless of the real live status.',
        vodDebugStatusLoading: 'Loading replay list...',
        vodDebugStatusOff: 'Turn on to immediately mark this channel "ended" and show the replay panel.',
        vodDebugEffectNoTile: 'Actual state: this channel\'s tile could not be found (not rendered in the grid)',
        vodDebugEffectShown: 'Actual state: replay panel is showing',
        vodDebugEffectHidden: 'Actual state: live view (no panel)',
        debugDbTitleTemplate: '{mark} Channel volume (dB) waveform',
        debugDbDesc: "How this channel's volume moves over time — the raw signal behind every judgment below.",
        debugSamplesTemplate: '{count} samples, {sec}s range',
        debugLatestSuffixTemplate: ' — latest {value}',
        debugDbLegendTemplate: 'Yellow: value used for actual playback volume / Blue: voice-band value used for collab detection (reference only){voiceValue} / Red: perceived loudness with playback volume (%) applied',
        debugDbLegendVoiceSuffixTemplate: ' (latest {value})',
        debugEffectiveDbTemplate: 'Perceived loudness at current playback volume ({volume}%): {value}',
        debugDataNotReady: 'data not ready',
        debugClusterTemplate: 'Currently grouped with {members} as overlapping / channel kept audible: {keeper}',
        debugVadTitleTemplate: '{mark} Voice detection (AI voice activity detection)',
        debugVadDesc: 'Only segments (green) judged as this channel actually speaking are used when comparing overlap with other channels.',
        debugVadLoading: 'Loading model — comparing without masking in the meantime.',
        debugVadUnavailable: 'Unavailable — comparing without masking.',
        debugVadStatsTemplate: 'Speech ratio {ratio}% (threshold {threshold}%+ probability) / calculated {age}s ago',
        debugVadPending: 'Not measured yet (calculated once a collab candidate pair appears)',
        debugStage1TitleTemplate: '{mark} Stage 1 signal: overlap pattern correlation with {partner}',
        debugStage1Desc: 'Compares, per time lag, how closely this channel\'s volume rises and falls together with an overlapping channel\'s — not yet confirmed as "the same audio".',
        debugStage1ValueTemplate: 'Value used for the final overlap %: {value}',
        debugStage1ValueNone: 'None yet',
        debugStage2TitleTemplate: '{mark} Stage 2 signal: final waveform check with {partner}',
        debugStage2Desc: 'For pairs flagged as candidates by Stage 1, compares actual waveforms to confirm they are truly "the same audio" — this result decides whether muting actually happens.',
        debugWaveformUnavailableDesc: "This channel can't use the audio worklet (older browser, etc.), so judgment relies on Stage 1 alone.",
        debugWaveformStatsTemplate: 'Similarity {score}% (threshold {threshold}%) / lag {lag}s / calculated {age}s ago ({compute})',
        debugWaveformPendingDesc: 'Not measured yet (capture warming up, or not yet a candidate)',
        debugWaveformGraceDescTemplate: 'Last confirmed as the same audio {age}s ago — re-checking now since there\'s no speech (grace period up to {grace}s); holding the previous verdict (muted) until then.',
        debugVadNoteReady: 'AI voice detection: active — both ③ and ④ above use only segments where either channel is speaking',
        debugVadNoteLoading: 'AI voice detection: loading model (comparing without masking in the meantime)',
        debugVadNoteUnavailable: 'AI voice detection: unavailable (comparing without masking)'
      },
      preset: {
        modalTitle: 'Save Preset',
        nameLabel: 'Preset name',
        namePlaceholder: 'e.g. Variety game streamers',
        colorLabel: 'Preset color',
        searchLabel: 'Search channels',
        searchPlaceholder: 'Enter a channel name',
        searchEmpty: 'No results found.',
        add: 'Add',
        added: 'Added',
        selectedChannelsLabel: 'Added channels',
        clearSelected: 'Clear All',
        cancel: 'Cancel',
        save: 'Save',
        noChannels: 'There are no channels to save.',
        nameRequired: 'Please enter a preset name.',
        duplicateName: 'A preset with this name already exists.',
        clearAllConfirm: 'Delete all saved presets?',
        noLiveChannels: 'No channels in this preset are currently live.',
        loading: 'Loading...',
        shareTitle: 'Share Preset',
        copyCode: 'Copy Code',
        copied: 'Copied!',
        copyFailed: 'Copy failed',
        importTitle: 'Import Preset',
        importPlaceholder: 'Paste a shared preset code',
        importConfirm: 'Import',
        importFailed: 'Invalid preset code.',
        overwriteConfirm: 'Overwrite this preset?',
        overwriteButton: 'Overwrite',
        noticeTitle: 'Notice',
        noticeOk: 'OK'
      },
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
      vodPicker: {
        ended: 'Broadcast ended',
        loading: 'Checking for replays...',
        title: 'Choose a replay',
        empty: 'No replays found.',
        refresh: 'Check again',
        latestBadge: 'Latest',
        minuteSuffix: 'm',
        tabStreams: 'Replays (VOD)',
        tabVideos: 'Channel videos'
      },
      vodSearch: {
        chzzkOnlyNotice: 'r (or ㄱ) search only supports CHZZK/YouTube channels for now.',
        notFoundNotice: 'Could not find channel "{name}".'
      },
      instanceLock: {
        messageDevice: 'The same extension is already running CHEESE EYES in another window (or tab).<br>Close that window and refresh this one after a moment.',
        liveLoginRequired: 'Sign in to {platform} first to watch {platform} live.',
        liveAccountCollision: 'Your {platform} account is already in use by CHEESE EYES elsewhere, so only {platform} live is restricted.'
      },
      settings: {
        title: 'Settings',
        tabSettings: 'Settings',
        tabLab: 'Lab',
        tabInfo: 'Info',
        uiLanguageSection: 'Display Language',
        uiLanguageLabel: 'Language',
        uiLanguageHint: 'Changes the language shown on screen.',
        accountSection: 'Connected Accounts',
        minViewersSection: 'Minimum Viewers',
        minViewersPlatformLabel: 'Platform',
        minViewersValueLabel: 'Minimum viewers',
        minViewersHint: 'Live channels below this viewer count are hidden from search results.',
        debugSection: 'Debug',
        debugModeLabel: 'Debug mode',
        debugModeHint: 'Turn on to see and apply the debug features below.',
        debugAudioSectionTitle: 'Audio Debug',
        debugAudioToggleLabel: 'Show audio debug',
        debugAudioToggleHint: 'Shows dB waveforms and collab analysis (per-lag correlation, waveform similarity) in the per-channel audio panel.',
        debugVodSectionTitle: 'Ended-Broadcast VOD Debug',
        debugVodToggleLabel: 'Show ended-broadcast VOD debug',
        debugVodToggleHint: 'Shows a "simulate broadcast ended" toggle on live CHZZK channels, so you can test the replay panel without waiting for a real broadcast to end.',
        debugVodSyncSectionTitle: 'VOD Sync Debug',
        debugVodSyncToggleLabel: 'Show VOD sync debug',
        debugVodSyncToggleHint: 'Shows a "test audio scan" button on VOD-sync members (CHZZK) in the collab group card. Independent of audio debug (dB waveforms, etc.).',
        gridVolumeLabel: 'Grid mode max volume',
        subVolumeLabel: 'Main-Sub mode max volume',
        audioHint: 'Max volume per channel in Grid/Sub mode. In Grid, loud channels auto-lower to match the group\'s quietest one. Among Subs, channels normalize toward the group\'s average — quiet ones get boosted and loud ones lowered — but never above this max. Near-silent channels are excluded.',
        labSection: 'Lab',
        experimentalLabel: 'Experimental features',
        experimentalHint: 'Turn on to see and apply the experiments below.',
        audioOptimizationSection: 'Audio Optimization',
        audioOptimizationLabel: 'Use audio optimization',
        audioOptimizationHint: 'Auto-levels channel loudness within each group. May not match the player\'s shown volume — use the extension\'s own settings instead.',
        dynamicsCompressorLabel: 'Use dynamics compressor',
        dynamicsCompressorHint: 'Smooths a broadcast\'s own volume swings (screams, whispers) before comparing loudness across channels.',
        collabSettingSection: 'Collab Settings',
        collabSettingLabel: 'Use collab settings',
        collabSettingHint: 'Adds a Collab Settings section below the per-channel audio panel. When some of the channels grouped as a collab have overlapping audio, only one of them (always the representative, if set) stays audible and the rest mute automatically.',
        collabVadLabel: 'Use AI voice detection',
        collabVadHint: 'Compares overlap only during segments where either channel is actually speaking, for better accuracy. Downloads about 15MB the first time it\'s used, and increases CPU usage.',
        collabVadStatusLoading: 'Loading the AI voice detection model... (first time only, up to a few tens of seconds)',
        collabVadStatusReady: 'AI voice detection active',
        collabVadStatusUnavailable: 'AI voice detection is unavailable; falling back to the previous method.',
        vodSyncLabel: 'Use VOD collab sync alignment',
        vodSyncHint: 'Setting a collab group to "VOD sync alignment" mode replaces overlap detection with seeking to a fixed offset (in seconds) and automatically muting everyone but the representative channel.',
        versionLabel: 'Version',
        platformsSection: 'Supported Platforms',
        platformsList: 'CHZZK · SOOP · YouTube',
        noticeStructure: 'May not work correctly if a platform changes its structure.',
        noticeYoutubeTag: 'YouTube does not support tag search.',
        noticeKoreanSearch: 'CHZZK / SOOP only support search in Korean.',
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
      },
      multiviewTray: {
        title: 'Multiview',
        emptyState: 'Middle-click a video you\'re watching to stage it here.',
        removeItem: 'Remove from list',
        sendButtonTemplate: 'Send to Multiview ({count})',
        sendButtonEmpty: 'Send to Multiview',
        sendToQueueButtonTemplate: 'Add to queue ({count})',
        sendToQueueButtonEmpty: 'Add to queue',
        selectAll: 'Select all',
        toggleHint: 'Open/close the multiview tray'
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
        str = str.replaceAll(`{${k}}`, vars[k]);
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
    if (document.documentElement) document.documentElement.lang = safeLang;
    applyStaticTranslations();
    document.dispatchEvent(new CustomEvent('cheeseeyes:i18n-ready', { detail: { lang: safeLang } }));
  }

  // 저장된 언어 설정이 없는 최초 실행이면 무조건 한국어로 시작하지 않고
  // 브라우저 언어(navigator.language)를 참고한다 — 설정 패널에 닿기도
  // 전에 뜨는 계정 잠금 동의창 같은 화면에서 특히 중요하다.
  function detectBrowserLanguage() {
    try {
      const langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language];
      const match = langs.find((l) => typeof l === 'string' && l.toLowerCase().startsWith('en'));
      return match ? 'en' : DEFAULT_LANG;
    } catch (e) {
      return DEFAULT_LANG;
    }
  }

  function getSavedLanguage() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([LANG_STORAGE_KEY], (result) => {
          if (SUPPORTED_LANGS.includes(result[LANG_STORAGE_KEY])) {
            resolve(result[LANG_STORAGE_KEY]);
          } else {
            resolve(detectBrowserLanguage());
          }
        });
      } else {
        try {
          const saved = localStorage.getItem(LANG_STORAGE_KEY);
          resolve(SUPPORTED_LANGS.includes(saved) ? saved : detectBrowserLanguage());
        } catch (e) { resolve(detectBrowserLanguage()); }
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