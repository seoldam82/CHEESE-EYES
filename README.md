# CHEESE EYES (v1.4.3)

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
- 드래그로 자리 바꾸기는 같은 창 안에서만 (VOD는 다른 창으로 옮겨가도 보던 위치에서 이어서)
- **대표 창** 지정 (설정 > 비디오), 창마다 레이아웃·메인 채널·채팅 상태를 따로 기억

### 🔍 채널 추가 · 검색
- 채널명, 채널 해시, 태그로 라이브 검색 (라이브 중인 방송만 추가)
- 연관 검색어, 치지직·숲 영문 채널명 ↔ 한글 발음 매칭
- 최근 검색어 최대 10개 (개별 / 전체 삭제) — 채팅만 추가한 검색어는 "채팅" 탭에 따로 모여, 다시 고르면 바로 채팅만 추가됩니다
- **채팅만 추가 검색**: `c 채널명`(`ㅊ 채널명`)으로 검색하면 영상 없이 채팅만 추가합니다 (이 접두사로는 방송 중인 채널만 제안)
- **검색 결과 순서** (설정 > 일반): 전체 탭에서 어느 플랫폼을 먼저 보여줄지 정합니다
- **합방 멤버 추가 제안**: 멀티뷰 채팅에서 직접 "!멤버"를 보내면 이어지는 채팅에서 멤버를 찾아 방송 중인 채널을 카드로 보여주고 바로 추가
- **태그 검색**: 썸네일 카드로 표시, 클릭·드래그·Shift+클릭으로 선택
- **팔로우(구독) 목록**: 라이브 중인 채널을 카드로 보고 클릭 한 번에 추가

### 🖱️ 멀티뷰 트레이
- 시청 페이지에서 영상 위에 마우스를 두고 **왼쪽 Alt**(설정 > 조작에서 변경)를 누르면 사이드 트레이에 담김
- 원하는 것만 골라 멀티뷰로 한 번에 보내거나, 유튜브 영상은 대기열로
- 대기열 영상은 순서대로 빈자리를 자동으로 채움

### 📼 다시보기(VOD)
- 치지직 라이브가 끝나면 그 타일에 **최근 다시보기 목록**이 자동으로 뜸
- 다시보기 링크 붙여넣기, 또는 `r 채널명`(`ㄱ 채널명`) 검색으로 추가 (방송 중이 아닌 채널도 검색)
- 메인 채널(VOD)의 재생 속도를 바꾸면 나머지 VOD도 같은 속도로
- 치지직 VOD는 채팅(후원·구독 선물 포함)도 함께 재생, 유튜브 VOD는 댓글 표시(답글·번역)
- 보고 있는 시점 그대로 원본 방송을 새 탭에서 열기

### 💬 채팅
- 로그인 상태로 각 플랫폼 채팅 참여, 포인트도 실제 계정 기준으로 적립
  (치지직은 메인 채널만 통나무 포인트가 적립되는 것으로 확인됐습니다)
- 치지직 **통나무 파워 자동 받기** (멀티뷰 안에서도)
- 채팅 탭마다 새로고침 버튼
- 채팅 메시지를 클릭하면 그 자리에서 **번역** (번역 언어는 설정에서 지정)
- **채팅만 추가** (`c ` / `ㅊ ` 검색): 영상 없이 채팅탭만 추가 — 영상 프레임을 만들지 않아 화면·소리·트래픽을 쓰지 않고, 최대 채널 수·합방 감지에서도 빠집니다 (채팅탭의 눈 아이콘을 누르면 영상도 받아오고, 다시 누르면 채팅만으로 되돌아갑니다)
- **채팅 2분할** (설정 > 채팅): 사이드바를 두 칸으로 나눠 서로 다른 채널의 채팅을 같이 봅니다
  - 나누는 방향은 위아래 / 좌우 / 사이드(채팅 - 영상 - 채팅). 1번 칸이 왼쪽, 2번 칸이 오른쪽이고, 설정 창의 미리보기로 배치를 보고 고릅니다
  - 어느 칸에 떠 있는지 채팅탭의 1·2 번호와 칸 테두리 색으로 표시됩니다
  - **화면 전환 시 2번 칸**: 고정(직접 고른 채팅을 그대로) / 이어받기(1번 칸 채팅이 2번 칸으로 내려옴)
  - 1번 칸은 채팅탭 왼쪽 클릭, 2번 칸은 오른쪽 클릭 메뉴로 고릅니다 (메뉴에서 채널 삭제도 가능)
- **채팅 위에 채널명 표시**: 채팅 맨 윗줄(플랫폼의 "채팅" 글자 자리)을 덮어 지금 보고 있는 채널명을 보여줍니다 (2분할이면 칸 번호도 함께)
- **채팅 표시 위치** (설정 > 채팅): 채팅 사이드바를 영상 좌측 / 우측에 둡니다

### ⭐ 프리셋
- 지금 채널 조합(플랫폼·라이브/VOD 혼합)을 이름과 색상으로 저장
- 프리셋 화면에서 방송 중이 아닌 채널도 미리 담기 (전체 / 라이브 / VOD 필터)
- 불러올 때 라이브 여부와 VOD 존재 여부를 다시 확인해 복원
- 프리셋 코드로 내보내기 / 가져오기 (담긴 채널 미리보기)

### ⏱️ 라이브 싱크
- 라이브 채널들의 지연을 하나로 맞춤: 메인 채널을 기준 지연(기본 1.5초)에 두고 나머지가 따라감 (설정 > 비디오)
- 작은 차이는 재생 속도를 살짝 조절(음정 유지)해 끊김 없이 따라가고, `S` 키로 지금 다시 맞춤
- 합방이 아닌 라이브는 `←` / `→`로 1초씩 당기기 / 늦추기

### 🔊 오디오
- **오디오 최적화**: 채널 간 체감 음량을 자동으로 맞춤
- **합방 자동 그룹**: 같은 소리가 겹치는 라이브 채널끼리 자동으로 묶어 하나만 남기고 음소거 (AI 음성 감지로 말하는 구간 비교 — 기본(Silero) / 정밀(pyannote) 모델 선택)
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
| 일반 | 언어, 연동 계정, 최소 시청자 수, 최대 채널 수, 검색 결과 순서 |
| 조작 | 단축키 확인·변경 |
| 비디오 | 대표 창, 메인 화면 크기, 라이브 싱크 |
| 오디오 | 오디오 최적화, 합방 설정(자동·수동, AI 음성 감지 모델, VOD 싱크) |
| 채팅 | 채팅 표시 위치, 채팅 2분할(나누는 방향, 화면 전환 시 2번 칸) |
| 디버그 | 디버그 모드와 진단 표시 |

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
| `.` | 대기열 열기/닫기 |
| `S` | 라이브 싱크 지금 맞추기 |
| `← / →` | 합방이 아닌 라이브 지연 1초 당기기 / 늦추기 |
| 왼쪽 `Alt` (시청 페이지) | 마우스를 올린 영상을 멀티뷰 트레이에 담기 |
| `/` | 채널 검색창 빠르게 열기 (검색창 포커스 중 Esc로 닫기) |
| `Ctrl(⌘) + ← / →` | 채팅 탭을 이전/다음 채널로 전환 (검색창 포커스 중에는 전체/치지직/숲/유튜브 검색 탭 전환) |
| `Ctrl(⌘) + ↑` | 현재 보고 있는 채팅 탭 새로고침 |
| `Ctrl(⌘) + ↓` | 현재 보고 있는 채팅 탭의 채널을 화면 숨김 모드로 전환/해제 |

- 한 글자 단축키와 트레이 키는 설정 > 조작에서 바꿀 수 있습니다.

## ⚠️ 이용 안내
- 숲(SOOP) 채널을 iframe 안에서도 로그인된 상태로 표시하기 위해, 브라우저에 저장된 숲 로그인 쿠키(`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`)를 같은 값의 파티션 쿠키로 동기화합니다. 이 동작은 브라우저 안에서만 처리되며 외부로 전송되지 않습니다.

## 🔒 개인정보 및 보안
- 채널 목록, 레이아웃, 프리셋 등 설정 데이터는 사용자의 브라우저에만 저장됩니다.
- 각 플랫폼 로그인 세션은 해당 플랫폼(치지직/숲/유튜브) 자체 서버와의 통신에만 사용되며, 개발자 서버로는 전달·저장되지 않습니다.
- 자세한 수집 항목·전송 범위·보관 기간은 [개인정보처리방침](https://github.com/seoldam82/CHEESE-EYES/blob/main/PRIVACY_POLICY.md)을 참고해 주세요.

## 💡 문의 및 피드백
- 개발자 문의: [seoldam82@gmail.com](mailto:seoldam82@gmail.com)
- GitHub: [seoldam82/CHEESE-EYES](https://github.com/seoldam82/CHEESE-EYES)

---

> ※ 본 확장 프로그램은 치지직(Chzzk)·네이버(Naver), 숲(SOOP)·AfreecaTV, 구글(Google)·유튜브(YouTube)와 관계없는 개인 개발 프로젝트입니다.
>
> ※ 본 프로젝트는 GNU 일반 공중 사용 허가서 버전 3(GPL-3.0)을 따릅니다. 상업적 목적을 포함해 누구나 자유롭게 이용·수정·배포할 수 있으며, 수정본을 배포할 때는 같은 GPL-3.0으로 소스를 함께 공개해야 합니다. 전문은 LICENSE 파일을 참고하세요.

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
- Drag to rearrange within a window (a VOD moved to another window continues where you left off)
- Pick the **main window** (Settings > Video); each window remembers its own layout, main channel and chat

#### 🔍 Adding · Searching Channels
- Search live broadcasts by channel name, channel hash, or tag (only live broadcasts can be added)
- Related search suggestions; CHZZK/SOOP English channel names also match their Korean pronunciation
- Up to 10 recent searches (remove one or all) — chat-only searches are kept under their own "Chat" tab, so picking one adds just the chat again
- **Chat-only search**: search `c <channel name>` (or `ㅊ <channel name>`) to add the chat without the video (with this prefix, only channels that are currently live are suggested)
- **Search result order** (Settings > General): choose which platform comes first in the All tab
- **Collab member suggestions**: send "!멤버" in a multi-view chat yourself and the members named in the following chats are shown as live channel cards, ready to add
- **Tag search** shows thumbnail cards; select with click, drag, or Shift+click
- **Following/subscriptions list** shows live channels as cards — add with one click

#### 🖱️ Multi-view Tray
- Hover a video on a watch page and press **Left Alt** (change it in Settings > Controls) to stage it in the side tray
- Send the ones you pick to the multi-view at once, or send YouTube videos to the queue
- Queued videos fill open slots in order automatically

#### 📼 Replays (VOD)
- When a CHZZK live ends, its tile automatically shows that channel's **recent replays**
- Paste a replay link, or search `r <channel name>` (or `ㄱ <channel name>`; offline channels are found too)
- Changing the main channel's (VOD) playback speed changes the other VODs to match
- CHZZK replays play their chat too (including donation/gift cards); YouTube replays show comments (reply, translate)
- Open the original broadcast in a new tab at the moment you're watching

#### 💬 Chat
- Join each platform's chat while logged in; points accrue to your real account
  (On CHZZK, only the main channel has been confirmed to accrue "log" points)
- CHZZK **log power auto-claim** (inside the multi-view too)
- Refresh button on every chat tab
- Click a chat message to **translate** it in place (set the target language in Settings)
- **Chat-only add** (`c ` / `ㅊ ` search): add just the chat tab, with no video — no video frame is created, so it uses no screen, sound or bandwidth and is left out of the channel limit and collab detection (press the eye icon on its chat tab to pull in the video, press it again to go back to chat only)
- **Split chat** (Settings > Chat): split the sidebar into two panes to follow two channels' chat at once
  - Split vertically, horizontally, or to the sides (chat - video - chat). Pane 1 is on the left and pane 2 on the right; a preview in the settings window shows each layout
  - Chat tabs show a 1 or 2 badge in the pane's color, and each pane is outlined in the same color
  - **Pane 2 on screen change**: pinned (pane 2 keeps the chat you picked) or hand down (the chat in pane 1 moves down to pane 2)
  - Left-click a chat tab for pane 1, right-click it for pane 2 (the same menu removes the channel)
- **Channel name over the chat**: the top row of the chat (where the platform prints "chat") is covered with the channel you are watching, plus the pane number when split
- **Chat position** (Settings > Chat): put the chat sidebar on the left or the right of the video

#### ⭐ Presets
- Save the current channel set (mixed platforms, live/VOD) with a name and color
- Add offline channels from the preset screen (All / Live / VOD filters)
- Loading re-checks live status and whether VODs still exist
- Export / import as a preset code (with a preview of the included channels)

#### ⏱️ Live Sync
- Aligns live channels to one delay: the main channel is held at the target delay (default 1.5s) and the others follow it (Settings > Video)
- Small drifts are followed by gently nudging playback speed (pitch preserved), and `S` realigns right away
- For a live channel that isn't in a collab, `←` / `→` pulls or delays it by 1s

#### 🔊 Audio
- **Audio optimization**: automatically levels perceived loudness across channels
- **Automatic collab groups**: live channels with overlapping audio are grouped automatically; one stays audible and the rest are muted (AI voice detection compares speech segments — choose the Basic (Silero) or Precise (pyannote) model)
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
| General | Language, linked accounts, minimum viewers, maximum channels, search result order |
| Controls | View and change shortcuts |
| Video | Main window, main screen size, live sync |
| Audio | Audio optimization, collab settings (auto/manual, AI voice detection model, VOD sync) |
| Chat | Chat position, split chat (direction, pane 2 on screen change) |
| Debug | Debug mode and diagnostic overlays |

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
| `.` | Open/close the queue |
| `S` | Realign live sync now |
| `← / →` | Pull / delay a non-collab live channel by 1s |
| Left `Alt` (on a watch page) | Stage the hovered video in the multi-view tray |
| `/` | Quickly open the channel search box (press Esc while focused to close it) |
| `Ctrl(⌘) + ← / →` | Switch the chat tab to the previous/next channel (cycles the All/CHZZK/SOOP/YouTube search tab instead if the search box is focused) |
| `Ctrl(⌘) + ↑` | Refresh the chat tab currently being viewed |
| `Ctrl(⌘) + ↓` | Toggle screen-hidden mode for the channel in the chat tab currently being viewed |

- Single-key shortcuts and the tray key can be changed in Settings > Controls.

### ⚠️ Usage Notes
- To keep SOOP channels showing as logged in inside an iframe, the extension syncs your existing SOOP login cookies (`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`) into partitioned cookies with the same values. This happens only inside your browser and is never sent anywhere.

### 🔒 Privacy & Security
- Settings data such as your channel list, layout, and presets are stored only in your browser.
- Each platform's login session is used only to communicate with that platform's own servers (CHZZK/SOOP/YouTube) and is never passed to or stored by the developer.
- For the full list of what's collected, where it's sent, and how long it's retained, please see the [privacy policy](https://github.com/seoldam82/CHEESE-EYES/blob/main/PRIVACY_POLICY.md).

### 💡 Contact & Feedback
- Developer contact: [seoldam82@gmail.com](mailto:seoldam82@gmail.com)
- GitHub: [seoldam82/CHEESE-EYES](https://github.com/seoldam82/CHEESE-EYES)

---

> ※ This extension is an independent personal project unaffiliated with CHZZK/Naver, SOOP/AfreecaTV, or Google/YouTube.
>
> ※ This project is licensed under the GNU General Public License v3.0 (GPL-3.0). Anyone may use, modify, and distribute it, including commercially; distributed modifications must also be released under GPL-3.0 with their source. See the LICENSE file for the full text.
