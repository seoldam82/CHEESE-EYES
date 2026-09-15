# CHEESE EYES (v1.4.1)

**[→ English](#english)**

치지직 · 숲(SOOP) · 유튜브 라이브를 한 화면에서 여러 개 동시에 보는 멀티뷰 확장 프로그램입니다.

> ※ 본 확장 프로그램은 치지직(CHZZK)·네이버(NAVER), 숲(SOOP)·AfreecaTV, 구글(Google)·유튜브(YouTube)와 무관한 비공식 서드파티 도구입니다.

## 📌 주요 기능

### 🖥️ 멀티뷰 화면
- **그리드 / 메인-서브 레이아웃** (`Z` / `X` 키로 전환)
- 드래그 앤 드롭으로 채널 위치 변경
- **화면 숨김 모드**: 영상은 끄고 소리만 듣기
- 메인-서브에서 메인 화면 우하단 모서리를 드래그해 크기 조절
- 여러 플랫폼 채널을 한 화면에 자유롭게 섞어서 배치
- **최대 채널 수 설정** (기본 12개)

### 🪟 여러 창 · 다중 모니터 (동일 프로필)
- 대시보드 창을 여러 개 열어 모니터마다 다른 채널 배치
- 같은 채널은 한 창에만 표시 — 다른 창에서 추가하면 그 창으로 옮겨옴
- 타일의 **"다른 창·모니터로 보내기"** 버튼이나 드래그로 창 사이 이동 (VOD는 보던 위치에서 이어서)
  - 다른 창 타일 위에 놓으면 두 채널을 맞바꾸지만, 재생이 잠시 멈출 수 있어 **권장하지 않습니다**
- **대표 창** 지정 (설정 > 비디오), 창마다 레이아웃·메인 채널·채팅 상태를 따로 기억
- **다중 디스플레이 모드**
  - 일반: 창마다 자기 채널로 메인-서브
  - 확장: 창이 2개이고 대표 창이 메인-서브면, 대표 창에는 메인 채널만 / 다른 창에는 나머지 채널

### 🔍 채널 추가 · 검색
- 채널명, 채널 해시, 태그로 라이브 검색 (라이브 중인 방송만 추가)
- 연관 검색어, 치지직·숲 영문 채널명 ↔ 한글 발음 매칭
- 최근 검색어 최대 10개 (개별 / 전체 삭제)
- **태그 검색**: 썸네일 카드로 표시, 클릭·드래그·Shift+클릭으로 선택
- **팔로우(구독) 목록**: 라이브 중인 채널을 카드로 보고 클릭 한 번에 추가

### 🖱️ 가운데클릭 트레이
- 시청 페이지에서 영상을 가운데클릭하면 사이드 트레이에 담김
- 원하는 것만 골라 멀티뷰로 한 번에 보내거나, 유튜브 영상은 대기열로
- 대기열 영상은 순서대로 빈자리를 자동으로 채움

### 📼 다시보기(VOD)
- 치지직 라이브가 끝나면 그 타일에 **최근 다시보기 목록**이 자동으로 뜸
- 다시보기 링크 붙여넣기, 또는 `r 채널명`(`ㄱ 채널명`) 검색으로 추가
- 치지직 VOD는 채팅(후원·구독 선물 포함)도 함께 재생, 유튜브 VOD는 댓글 표시(답글·번역)
- 보고 있는 시점 그대로 원본 방송을 새 탭에서 열기

### 💬 채팅
- 로그인 상태로 각 플랫폼 채팅 참여, 포인트도 실제 계정 기준으로 적립
  (치지직은 메인 채널만 통나무 포인트가 적립되는 것으로 확인됐습니다)
- 채팅 탭마다 새로고침 버튼
- 채팅 메시지를 클릭하면 그 자리에서 **번역** (번역 언어는 설정에서 지정)

### ⭐ 프리셋
- 지금 채널 조합(플랫폼·라이브/VOD 혼합)을 이름과 색상으로 저장
- 프리셋 화면에서 방송 중이 아닌 채널도 미리 담기 (전체 / 라이브 / VOD 필터)
- 불러올 때 라이브 여부와 VOD 존재 여부를 다시 확인해 복원
- 프리셋 코드로 내보내기 / 가져오기

### 🔊 오디오
- **오디오 최적화**: 채널 간 체감 음량을 자동으로 맞춤
- **합방 자동 그룹**: 같은 소리가 겹치는 라이브 채널끼리 자동으로 묶어 하나만 남기고 음소거 (AI 음성 감지로 말하는 구간 비교)
  - 그룹 이름을 정해두면 같은 채널이 다시 묶일 때 그 이름 사용
  - 그룹마다 색으로 구분(오디오 패널·채팅 탭·타일 테두리, 색 변경 가능), 음소거된 채널에는 어느 방송으로 듣는 중인지 표시
  - 잘못 묶이면 **"합방 해제"** 로 그룹 전체 또는 채널 하나만 풀기
  - 채널별 오디오 패널도 그룹별(그룹 1, 그룹 2…)로 나눠 표시
- **수동 합방 그룹**: 방송 싱크가 크게 어긋나 자동으로 안 묶이는 합방은 채널을 골라 직접 묶기 (소리 비교 없이 항상 하나만 남기고 음소거)
- **VOD 합방 싱크**: 서로 다른 채널의 다시보기를 방송 시작 시각 기준으로 자동 정렬 (VOD 싱크 그룹은 직접 추가)
- 설정 > 오디오에서 켜고 끌 수 있으며, 모든 분석은 브라우저 안에서만 처리

### ⚙️ 설정

| 탭 | 항목 |
|---|---|
| 일반 | 언어, 연동 계정, 최소 시청자 수, 최대 채널 수, 디버그 모드 |
| 비디오 | 대표 창, 메인 화면 크기 |
| 실험실 | 다중 디스플레이 모드(일반/확장) |
| 오디오 | 오디오 최적화, 합방 설정 |

## 🌐 플랫폼 지원 현황

| 기능 | 치지직 | 숲(SOOP) | 유튜브 |
|---|:-:|:-:|:-:|
| 라이브 추가 | ✅ | ✅ | ✅ |
| VOD 추가 (URL / 트레이 / `r`·`ㄱ` 검색) | ✅ | ❌ | ✅ |
| 실시간 채팅 | ✅ | ✅ | ✅ |
| VOD 채팅 다시보기 | ✅ | ❌ | 댓글로 대체 |
| VOD 댓글 | ✅ | ❌ | ✅ |
| 태그 / 카테고리 검색 | ✅ | ✅ | ❌ |
| 팔로우 라이브 자동 추가 | ✅ | ✅ | ✅ (구독) |
| 팔로우 / 언팔로우 토글 | ✅ | ✅ | ❌ |
| 로그인 연동 | ✅ | ✅ | ✅ |
| 라이브 합방 | ✅ | ✅ | ✅ |
| VOD 합방 싱크 | ✅ | ❌ | ✅ |

- 숲(SOOP) VOD 기능은 숲 플레이어의 임베드 제한으로 보류 중입니다.
- VOD 합방 싱크는 치지직↔치지직, 유튜브↔유튜브, 치지직↔유튜브 조합에서 지원됩니다.

## ⌨️ 단축키

| 단축키 | 동작 |
|---|---|
| `Z` | 그리드 레이아웃으로 전환 |
| `X` | 메인-서브 레이아웃으로 전환 |
| `V` | 설정 창 열기 |
| `C` | 채팅창 열기/닫기 |
| `` ` `` (백틱) | 채널별 오디오 설정 열기/닫기 |
| `F` | 팔로우(구독) 목록 열기/닫기 |
| `/` | 채널 검색창 빠르게 열기 (검색창 포커스 중 Esc로 닫기) |
| `Ctrl(⌘) + ← / →` | 채팅 탭을 이전/다음 채널로 전환 (검색창 포커스 중에는 전체/치지직/숲/유튜브 검색 탭 전환) |
| `Ctrl(⌘) + ↑` | 현재 보고 있는 채팅 탭 새로고침 |
| `Ctrl(⌘) + ↓` | 현재 보고 있는 채팅 탭의 채널을 화면 숨김 모드로 전환/해제 |

## ⚠️ 이용 안내
- 숲(SOOP) 채널을 iframe 안에서도 로그인된 상태로 표시하기 위해, 브라우저에 저장된 숲 로그인 쿠키(`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`)를 같은 값의 파티션 쿠키로 동기화합니다. 이 동작은 브라우저 안에서만 처리되며 외부로 전송되지 않습니다.
- 같은 계정을 여러 곳(다른 기기·다른 브라우저 프로필)의 CHEESE EYES에서 동시에 쓰면 시청자 수가 부풀려질 수 있어, 그 플랫폼 라이브 타일이 대기 화면으로 바뀝니다. 다른 곳에서 끄면 자동으로 다시 불러오며, 같은 프로필에서 창을 여러 개 여는 것은 제한되지 않습니다.

## 🔒 개인정보 및 보안
- 채널 목록, 레이아웃, 프리셋 등 설정 데이터는 사용자의 브라우저에만 저장됩니다.
- 각 플랫폼 로그인 세션은 해당 플랫폼(치지직/숲/유튜브) 자체 서버와의 통신에만 사용되며, 개발자 서버로는 전달·저장되지 않습니다.
- 위 "같은 계정 중복 사용 방지"를 위해서만, 라이브 채널을 추가한 플랫폼에 한해 로그인 중인 계정 식별자를 개발자가 운영하는 별도 서버로 전송합니다. 서버는 받는 즉시 해시(HMAC-SHA256)하고 원본은 저장하지 않으며, 그 외 목적으로 쓰지 않습니다.
- 자세한 수집 항목·전송 범위·보관 기간은 [개인정보처리방침](https://github.com/seoldam82/CHEESE-EYES/blob/main/PRIVACY_POLICY.md)을 참고해 주세요.

## 💡 문의 및 피드백
- 개발자 문의: [seoldam82@gmail.com](mailto:seoldam82@gmail.com)
- GitHub: [seoldam82/CHEESE-EYES](https://github.com/seoldam82/CHEESE-EYES)

---

> ※ 본 확장 프로그램은 치지직(Chzzk)·네이버(Naver), 숲(SOOP)·AfreecaTV, 구글(Google)·유튜브(YouTube)와 관계없는 개인 개발 프로젝트입니다.
>
> ※ 본 프로젝트는 소스 공개형(Source-Available) 라이선스인 Business Source License 1.1(수정본)을 따르며, 비상업적 목적의 이용·수정·배포는 자유롭습니다. 상업적 이용은 별도의 라이선스가 필요합니다.

---

## English

A multi-view extension for watching several CHZZK · SOOP · YouTube live broadcasts at once on a single screen.

> ※ This extension is an unofficial third-party tool unaffiliated with CHZZK/Naver, SOOP/AfreecaTV, or Google/YouTube.

### 📌 Key Features

#### 🖥️ Multi-view Screen
- **Grid / Main-Sub layout** (switch with `Z` / `X`)
- Rearrange channels with drag and drop
- **Screen-hidden mode**: turn off a channel's video and keep listening
- In Main-Sub, drag the main screen's bottom-right corner to resize it
- Mix channels from different platforms freely on one screen
- **Maximum channels setting** (default 12)

#### 🪟 Multiple Windows · Multi-monitor (Same Profile)
- Open several dashboard windows and put different channels on each monitor
- A channel shows in only one window — adding it from another window moves it there
- Move channels between windows with the tile's **"Send to another window or monitor"** button or by dragging (VODs continue where you left off)
  - Dropping onto a tile in another window swaps the two channels, but playback may stall for a while, so it's **not recommended**
- Pick the **main window** (Settings > Video); each window remembers its own layout, main channel and chat
- **Multi-display mode**
  - Normal: each window lays out its own channels in Main-Sub
  - Extended: with two windows and the main window in Main-Sub, the main window shows only the main channel and the other window shows the rest

#### 🔍 Adding · Searching Channels
- Search live broadcasts by channel name, channel hash, or tag (only live broadcasts can be added)
- Related search suggestions; CHZZK/SOOP English channel names also match their Korean pronunciation
- Up to 10 recent searches (remove one or all)
- **Tag search** shows thumbnail cards; select with click, drag, or Shift+click
- **Following/subscriptions list** shows live channels as cards — add with one click

#### 🖱️ Middle-click Tray
- Middle-click a video on a watch page to stage it in the side tray
- Send the ones you pick to the multi-view at once, or send YouTube videos to the queue
- Queued videos fill open slots in order automatically

#### 📼 Replays (VOD)
- When a CHZZK live ends, its tile automatically shows that channel's **recent replays**
- Paste a replay link, or search `r <channel name>` (or `ㄱ <channel name>`)
- CHZZK replays play their chat too (including donation/gift cards); YouTube replays show comments (reply, translate)
- Open the original broadcast in a new tab at the moment you're watching

#### 💬 Chat
- Join each platform's chat while logged in; points accrue to your real account
  (On CHZZK, only the main channel has been confirmed to accrue "log" points)
- Refresh button on every chat tab
- Click a chat message to **translate** it in place (set the target language in Settings)

#### ⭐ Presets
- Save the current channel set (mixed platforms, live/VOD) with a name and color
- Add offline channels from the preset screen (All / Live / VOD filters)
- Loading re-checks live status and whether VODs still exist
- Export / import as a preset code

#### 🔊 Audio
- **Audio optimization**: automatically levels perceived loudness across channels
- **Automatic collab groups**: live channels with overlapping audio are grouped automatically; one stays audible and the rest are muted (AI voice detection compares speech segments)
  - Name a group and that name is reused when the same channels group again
  - Each group has its own color (audio panel, chat tabs, tile borders; you can change it), and muted channels show which broadcast you're listening through
  - **"Split collab"** undoes a wrong grouping for the whole group or just one channel
  - The per-channel audio panel is split by group (Group 1, Group 2…)
- **Manual collab groups**: pick channels to group a collab that isn't detected because the streams are far out of sync (one always stays audible, the rest are muted, without comparing audio)
- **VOD collab sync**: aligns replays from different channels by their real broadcast start time (VOD sync groups are added manually)
- Turn these on/off in Settings > Audio; all analysis runs only inside your browser

#### ⚙️ Settings

| Tab | Items |
|---|---|
| General | Language, linked accounts, minimum viewers, maximum channels, debug mode |
| Video | Main window, main screen size |
| Lab | Multi-display mode (Normal/Extended) |
| Audio | Audio optimization, collab settings |

### 🌐 Platform Support

| Feature | CHZZK | SOOP | YouTube |
|---|:-:|:-:|:-:|
| Add live channels | ✅ | ✅ | ✅ |
| Add VODs (URL / tray / `r`·`ㄱ` search) | ✅ | ❌ | ✅ |
| Live chat | ✅ | ✅ | ✅ |
| VOD chat replay | ✅ | ❌ | Comments instead |
| VOD comments | ✅ | ❌ | ✅ |
| Tag / category search | ✅ | ✅ | ❌ |
| Auto-add followed lives | ✅ | ✅ | ✅ (subscriptions) |
| Follow / unfollow toggle | ✅ | ✅ | ❌ |
| Login integration | ✅ | ✅ | ✅ |
| Live collab | ✅ | ✅ | ✅ |
| VOD collab sync | ✅ | ❌ | ✅ |

- SOOP VOD features are on hold due to embed restrictions in SOOP's player.
- VOD collab sync works for CHZZK↔CHZZK, YouTube↔YouTube, and CHZZK↔YouTube pairs.

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Z` | Switch to Grid layout |
| `X` | Switch to Main-Sub layout |
| `V` | Open settings |
| `C` | Open/close chat |
| `` ` `` (backtick) | Open/close per-channel audio settings |
| `F` | Open/close the following/subscriptions list |
| `/` | Quickly open the channel search box (press Esc while focused to close it) |
| `Ctrl(⌘) + ← / →` | Switch the chat tab to the previous/next channel (cycles the All/CHZZK/SOOP/YouTube search tab instead if the search box is focused) |
| `Ctrl(⌘) + ↑` | Refresh the chat tab currently being viewed |
| `Ctrl(⌘) + ↓` | Toggle screen-hidden mode for the channel in the chat tab currently being viewed |

### ⚠️ Usage Notes
- To keep SOOP channels showing as logged in inside an iframe, the extension syncs your existing SOOP login cookies (`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`) into partitioned cookies with the same values. This happens only inside your browser and is never sent anywhere.
- Using the same account in CHEESE EYES from more than one place (another device or browser profile) at once can inflate viewer counts, so that platform's live tiles switch to a waiting screen. They reload automatically once the other place closes. Opening multiple windows in the same profile is not restricted.

### 🔒 Privacy & Security
- Settings data such as your channel list, layout, and presets are stored only in your browser.
- Each platform's login session is used only to communicate with that platform's own servers (CHZZK/SOOP/YouTube) and is never passed to or stored by the developer.
- Solely for the duplicate-use prevention above, the identifier of your logged-in account is sent to a separate server the developer operates — only for platforms where you've added a live channel. The server hashes it (HMAC-SHA256) immediately, never stores the original, and uses it for nothing else.
- For the full list of what's collected, where it's sent, and how long it's retained, please see the [privacy policy](https://github.com/seoldam82/CHEESE-EYES/blob/main/PRIVACY_POLICY.md).

### 💡 Contact & Feedback
- Developer contact: [seoldam82@gmail.com](mailto:seoldam82@gmail.com)
- GitHub: [seoldam82/CHEESE-EYES](https://github.com/seoldam82/CHEESE-EYES)

---

> ※ This extension is an independent personal project unaffiliated with CHZZK/Naver, SOOP/AfreecaTV, or Google/YouTube.
>
> ※ This project is licensed under a modified Business Source License 1.1 (source-available). Non-commercial use, modification, and distribution are free; commercial use requires a separate license.
