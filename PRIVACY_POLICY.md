# CHEESE EYES 개인정보 처리방침

**[→ English (reference translation)](#english-reference-translation)** — The Korean text above is the authoritative document; the English version below is a reference translation only.

최종 수정일: 2026-08-08

CHEESE EYES(이하 "본 확장 프로그램")는 라이브 방송을 한 화면에서 다중으로 시청할 수 있도록 돕는 비공식 확장 프로그램으로, 현재 치지직(chzzk.naver.com), 숲(SOOP, sooplive.com/afreecatv.com), 유튜브(youtube.com)를 지원합니다. 본 확장 프로그램은 네이버·치지직, 숲(SOOP)·AfreecaTV, 또는 구글·유튜브가 공식적으로 제공, 운영, 승인한 프로그램이 아닙니다.

## 1. 수집하는 정보와 이용 목적

본 확장 프로그램이 저장하는 데이터는 원칙적으로 이용자의 브라우저(기기) 내부에만 남습니다. 다만 여러 창에서 같은 계정으로 동시에 실행되는 것을 막기 위한 목적(1-3항)에 한해, 계정을 식별할 수 없는 형태로 가공한 최소한의 정보를 자체 운영 서버로 전송합니다.

| 구분 | 항목 | 저장 위치 | 목적 | 외부 전송 여부 |
|---|---|---|---|---|
| 로컬 설정 데이터 | 추가한 채널 목록(`my_channels`) | `chrome.storage.local` | 다중 시청 화면 구성 | 없음 |
| 로컬 설정 데이터 | 저장한 프리셋(`my_presets`) | `chrome.storage.local` | 채널 조합 프리셋 저장/불러오기 | 없음 |
| 로컬 설정 데이터 | 레이아웃 모드(`my_layout`) | `chrome.storage.local` | 그리드/메인-서브 등 화면 모드 유지 | 없음 |
| 로컬 설정 데이터 | 개인 설정(`my_profile`) | `chrome.storage.local` | 사용자 환경설정 유지(합방 겹침 감지 등 실험적 기능의 온/오프 포함) | 없음 |
| 인증 관련 정보 | 치지직 로그인 세션 쿠키 | 브라우저 쿠키(치지직 도메인 소유) | ① 팔로우 중인 채널의 라이브 목록을 불러오기 위해 `api.chzzk.naver.com` 요청 시 자동 포함(`credentials: include`)<br>② 다중 화면에 임베드된 치지직 채팅 페이지(iframe)가 로그인 상태를 인식하도록 `comm-api.game.naver.com`으로의 요청에도 함께 전송됨(치지직 자체 스크립트가 보내는 요청이며, 본 확장 프로그램 코드가 직접 호출하지 않음) | 치지직 자체 서버로만 전송되며, 본 확장 프로그램 개발자에게는 전달·저장되지 않음 |
| 인증 관련 정보 | 숲(SOOP) 로그인 세션 쿠키(`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`) | 브라우저 쿠키(숲 도메인 소유) 및 동일 값의 파티션 쿠키(CHIPS) | ① 로그인 상태 확인(`chapi.sooplive.co.kr/api/my/station`) 및 팔로우 목록·태그 검색·채널 검색 API(`sch.sooplive.com`) 호출 시 자동 포함<br>② 다중 화면에 임베드된 숲 영상/채팅 페이지(iframe)가 로그인 상태를 인식할 수 있도록, 본 확장 프로그램이 `chrome.cookies` API로 원본 로그인 쿠키를 읽어 동일한 값을 파티션 쿠키로 복제·동기화함(설치 시, 브라우저 시작 시, 쿠키 값 변경 시 자동 수행) | 숲(SOOP)/AfreecaTV 자체 서버로만 전송되며, 본 확장 프로그램 개발자에게는 전달·저장되지 않음 |
| 인증 관련 정보 | 유튜브 로그인 세션 쿠키(`SAPISID`, `__Secure-3PAPISID` 등) | 브라우저 쿠키(구글 도메인 소유) | 로그인 여부 확인(쿠키 존재 여부만 확인) 및, 로그인이 필요한 요청(예: 구독 중인 채널의 라이브 여부 확인)에 한해 `chrome.cookies` API로 쿠키 값을 읽어 구글 자체 인증 방식(SAPISIDHASH — 타임스탬프·쿠키 값·요청 origin을 SHA-1로 해시)에 따라 요청 헤더를 로컬에서 계산 | 쿠키 원본 값 자체는 어디로도 전송되지 않으며, 그 값으로 로컬에서 계산한 해시값만 유튜브 자체 서버로 향하는 요청 헤더에 포함됨. 본 확장 프로그램 개발자에게는 전달·저장되지 않음 |

본 확장 프로그램은 이용자의 치지직·숲(SOOP)·유튜브 계정 자격 증명(아이디/비밀번호)을 직접 입력받거나 저장하지 않습니다. 로그인 상태는 오직 브라우저에 이미 존재하는 각 플랫폼 자체 로그인 쿠키를 통해서만 확인되며, 이는 이용자가 해당 웹사이트에 로그인되어 있는 동안에만 유효합니다.

치지직/숲(SOOP)의 채널 검색·태그 검색·팔로우 목록 조회 API는 브라우저 보안 정책(CORS)상 확장 프로그램 페이지에서 직접 호출할 수 없어, 백그라운드 서비스 워커가 대신 요청을 전달하는 내부 중계(프록시) 방식을 사용합니다. 이 중계는 `host_permissions`에 명시된 도메인으로만 요청하도록 제한되어 있으며, 그 외 도메인으로는 요청을 전달하지 않습니다.

검색창에 입력한 채널명/키워드는 검색 결과 보정을 위해 유튜브 자동완성 API(`suggestqueries-clients6.youtube.com`)와 구글 번역 API(`translate.googleapis.com`, 언어 자동 감지 및 로마자 표기 변환 용도)로 전송될 수 있습니다. 이 요청에는 로그인 쿠키나 그 밖의 이용자 식별 정보가 포함되지 않으며, 입력한 검색어 텍스트만 구글 서버로 전달됩니다.

### 1-1. 오디오 처리(다중 채널 음량 자동 조절, 실험적 기능)

본 확장 프로그램의 오디오 최적화·합방(합동 방송) 겹침 감지 기능은 각 채널 영상의 오디오 신호를 분석해 음량을 자동으로 조절하거나, 서로 다른 채널에서 같은 소리가 겹쳐 들리는지 판단합니다. 이 분석(K-weighted 음량 측정, AI 음성 활동 감지, 파형 유사도 비교)은 전부 이용자의 브라우저 안에서만 실시간으로 이루어지며, 원본 오디오나 그 분석 결과는 어디로도 전송·저장되지 않고 화면이 갱신될 때마다 버려집니다.

### 1-2. 유튜브 팔로우(구독) 라이브 목록 조회 방식

로그인이 필요 없는 유튜브 검색은 확장 프로그램이 자체적으로 띄우는 보이지 않는 오프스크린 문서 안의 iframe(익명 상태, 로그인 쿠키를 포함하지 않음)을 통해 처리합니다.

로그인이 필요한 요청(예: 구독 중인 채널의 라이브 여부 확인)은 익명 iframe으로는 처리할 수 없어, 이용자가 이미 열어 둔 유튜브 탭이 있으면 그 탭을, 없으면 화면 전환 없이(포커스를 가져가지 않는) 새 유튜브 탭을 하나 열어 그 탭 안에서 요청을 실행합니다(`tabs`, `scripting` 권한 사용). 이 방식은 이용자가 실제로 유튜브에 로그인되어 있는 자기 자신의 세션으로 요청하는 것과 동일하며, 요청 결과(예: 구독 채널의 라이브 상태)는 대시보드 화면 표시에만 사용되고 별도로 저장되지 않습니다. 이 탭에서 이루어지는 요청은 유튜브(구글) 서버로만 전송됩니다.

### 1-3. 중복 실행 방지(단일 인스턴스 잠금) 서버

같은 실제 시청자가 CHEESE EYES 대시보드를 여러 창(또는 여러 브라우저 프로필)에서 동시에 열어 방송 시청자 수 집계가 부풀려지는 것을 막기 위해, 본 확장 프로그램은 개발자가 직접 운영하는 별도 서버(Cloudflare Worker, `cheese-eyes-lock.seoldam82.workers.dev`)에 아래 정보를 전송합니다.

- 이용자가 로그인 중인 치지직/숲(SOOP)/유튜브 계정 식별자("플랫폼:계정ID" 형태 문자열)
- 이 확장 프로그램이 설치된 폴더를 식별하는 값(`chrome.runtime.id`, 무작위로 생성되는 값이 아니라 설치 경로를 해싱한 값)
- 대시보드 탭 하나를 식별하는 임의의 세션 ID(브라우저를 새로 열 때마다 새로 생성됨)

서버는 위 계정 식별자·설치 식별자를 수신 즉시 서버만 아는 비밀 키로 HMAC-SHA256 해시하며, 원본 값은 어디에도 저장하지 않고 그 자리에서 버립니다(로그에도 남기지 않음). 저장되는 것은 해시값과 세션 ID, 만료 시각뿐입니다. 대시보드를 정상적으로 켜 둔 동안에는 5분마다 자동으로 하트비트를 보내 만료 시각을 계속 미루므로, 실제 사용 중에는 잠금이 풀리지 않습니다. 창을 닫으면 그 즉시 삭제 요청을 보내 바로 해제되고, 브라우저가 강제 종료되는 등 그 삭제 요청조차 전달되지 못한 예외적인 경우에 한해서만, 마지막 하트비트로부터 최대 약 12.5분 뒤 서버가 스스로 만료·삭제합니다(즉, "12.5분이 지나면 다른 창이 열린다"는 뜻이 아니라, 비정상 종료 시에도 잠금이 영원히 남지 않도록 하는 안전장치입니다). 이 서버는 잠금 판정(이미 같은 계정으로 다른 창이 열려 있는지 여부)에만 쓰이며, 그 외 어떤 목적으로도 이용·분석되지 않고 제3자에게 제공되지 않습니다.

## 2. 실시간 채팅 표시 방식

본 확장 프로그램은 각 채널의 채팅을 아래 방식으로 iframe에 그대로 불러와 화면에 표시합니다. 채팅 메시지 내용은 본 확장 프로그램이 별도로 수집, 저장, 가공, 전송하지 않습니다.

- 치지직: `https://chzzk.naver.com/live/{채널ID}/chat`
- 숲(SOOP): `https://play.sooplive.com/{채널ID}/{스트림번호}?vtype=chat`
- 유튜브: `https://www.youtube.com/live_chat?...`

숲(SOOP)의 채팅 페이지는 원래 실제 `window.open()`으로 열린 팝업 창임을 전제로, 자신을 연 창(`window.opener`)을 통해 로그인 세션을 인식하도록 설계되어 있습니다. 본 확장 프로그램은 채팅을 별도 팝업이 아닌 iframe으로 대시보드 안에 표시하므로, 같은 화면 안에 함께 열려 있는 해당 채널의 영상 iframe을 `window.opener`로 참조하도록 대체 구현되어 있습니다. 이 동작은 이용자의 브라우저 화면 내부에서만 일어나며, 자격 증명을 열람·전송하거나 외부로 데이터를 보내지 않고, 오직 정상 로그인된 이용자 본인의 세션으로 채팅을 읽고 쓸 수 있게 하기 위한 목적으로만 사용됩니다.

## 3. 웹페이지 화면 수정에 대한 안내

본 확장 프로그램은 아래 페이지에서 콘텐츠 스크립트(CSS/JS)를 실행하여 화면 표시 방식을 변경합니다.
- `chzzk.naver.com/content/multiview`: 확장 프로그램의 대시보드 UI 스크립트 실행
- `chzzk.naver.com/live/*`, `/chat/*`: 스크롤바 숨김, 헤더/사이드바/채팅 영역 등 UI 요소 숨김, 영상 영역을 화면 전체로 확장, 넓은 화면(극장) 모드 자동 적용
- `play.sooplive.com/*`, `bj.afreecatv.com/*`: 스크롤바 숨김, 영상 화면 모드(고화질) 버튼 자동 클릭, 채팅 프레임의 `window.opener` 대체 구현(위 2번 항목 참고)
- `www.youtube.com/embed/*`, `/live_chat*`: 스크롤바 숨김, 넓은 화면 모드 자동 적용

이 변경은 오직 이용자의 브라우저 화면에서만 일어나며, 치지직·숲(SOOP)·유튜브 서버에 저장되거나 다른 이용자에게 영향을 주지 않습니다.

## 4. 권한 사용 목적

| 권한 | 목적 |
|---|---|
| `storage` | 채널 목록, 프리셋, 레이아웃, 설정을 기기 내에 저장 |
| `cookies` | 숲(SOOP) 로그인 쿠키를 읽어 파티션 쿠키로 동기화하고 로그아웃 시 관련 쿠키를 삭제(위 1번 항목 참고), 유튜브 로그인 쿠키의 존재 여부 확인 및 인증 헤더 계산(위 1번 항목 참고). 치지직 로그인 쿠키는 별도로 읽거나 수정하지 않으며, 브라우저가 요청에 자동으로 포함시키는 방식 그대로 이용됨 |
| `tabs` | 유튜브 로그인이 필요한 요청을 처리하기 위해 기존 유튜브 탭을 찾거나 새 백그라운드 탭을 여는 데 사용(위 1-2항 참고). 대시보드 자체를 새 탭으로 여는 데에도 사용됨 |
| `scripting` | 위 유튜브 탭 안에서 로그인 세션을 이용한 요청을 실행하기 위해 사용(위 1-2항 참고) |
| `offscreen` | 로그인이 필요 없는 유튜브 검색을 처리하는 보이지 않는 익명 프록시 문서를 띄우기 위해 사용(위 1-2항 참고) |
| `host_permissions (chzzk.naver.com, sooplive.com/sooplive.co.kr/afreecatv.com 등)` | 다중 화면 iframe 로딩, 채널/태그 검색, 팔로우 목록 조회를 위한 API 호출 |
| `host_permissions (comm-api.game.naver.com)` | 본 확장 프로그램이 직접 호출하지는 않으나, 다중 시청 화면에 임베드되는 치지직 채팅 페이지(iframe)가 내부적으로 이 도메인에 요청하여 로그인 세션을 검증합니다. 이 도메인이 host_permissions 목록에 없으면 Chrome이 해당 iframe을 확장 프로그램에 임베드된 제3자 콘텐츠로 간주해 로그인 세션 쿠키 전송을 차단하며, 그 결과 iframe 안에서 치지직 채팅 로그인이 풀린 상태로 표시됩니다. 목록에 포함하면 이 쿠키 파티셔닝 차단에 대한 예외가 적용되어 정상적으로 로그인된 채팅이 표시됩니다. |
| `host_permissions (http://*.sooplive.com/*)` | 본 확장 프로그램이 직접 http(비암호화)로 요청을 보내는 곳은 없습니다. comm-api.game.naver.com과 같은 목적으로, 다중 시청 화면에 임베드되는 숲(SOOP) 영상/채팅 페이지(iframe)가 내부적으로 이 주소로 로그인 세션을 검증하는 것으로 파악되며, 이 예외가 없으면 Chrome이 제3자 콘텐츠로 간주해 로그인 세션 쿠키 전송을 차단해 채팅 로그인이 인식되지 않게 됩니다. |
| `host_permissions (youtube.com)` | 다중 화면 iframe 로딩, 유튜브 영상/채팅 임베드, 로그인 탭 프록시(위 1-2항 참고) |
| `host_permissions (suggestqueries-clients6.youtube.com)` | 채널 검색 시 유튜브 자동완성(제안 검색어) API 호출 |
| `host_permissions (translate.googleapis.com)` | 검색어의 언어 자동 감지 및 로마자 표기 변환(번역 API 호출) |
| `host_permissions (accounts.google.com)` | 유튜브 로그인 팝업 창을 여는 목적으로만 사용(페이지 이동 대상일 뿐, 이 도메인에 별도로 요청을 보내지 않음) |
| `host_permissions (cheese-eyes-lock.seoldam82.workers.dev)` | 중복 실행 방지 서버 호출(위 1-3항 참고) |

## 5. 제3자 제공

본 확장 프로그램은 이용자의 어떠한 정보도 제3자에게 판매, 대여, 제공하지 않습니다. 위 1번 항목에 설명된 각 플랫폼(치지직/숲/유튜브) 자체 서버로의 전송, 검색어 보정을 위한 구글 API 호출, 중복 실행 방지를 위한 자체 서버(1-3항) 전송을 제외하고는 어떠한 외부 전송도 이루어지지 않습니다.

## 6. 데이터 삭제

- 이용자는 브라우저의 확장 프로그램 관리 메뉴에서 본 확장 프로그램을 삭제하면 `chrome.storage.local`에 저장된 모든 데이터가 함께 삭제됩니다.
- 확장 프로그램 설정 메뉴에서 숲(SOOP) 로그아웃을 실행하면, 원본 및 파티션 로그인 쿠키(`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`)가 즉시 삭제됩니다.
- 중복 실행 방지 서버(1-3항)에 남아 있는 해시값은 대시보드를 닫으면 즉시 삭제 요청이 전송되며, 브라우저 강제 종료 등으로 그 요청이 전달되지 못한 경우에만 마지막 하트비트 후 최대 약 12.5분 뒤 서버에서 자동으로 만료·삭제됩니다.

## 7. 문의

본 확장 프로그램 관련 문의는 seoldam82@gmail.com으로 연락해 주시기 바랍니다.

## 8. 방침 변경

본 방침은 확장 프로그램 기능 변경에 따라 갱신될 수 있으며, 변경 시 이 문서 상단의 최종 수정일을 갱신합니다.

---

## English (Reference Translation)

> This English text is a **reference translation only**. The Korean text above is the authoritative version of this privacy policy; if the two ever disagree, the Korean text controls.

Last updated: 2026-08-08

CHEESE EYES (the "extension") is an unofficial browser extension that helps you watch multiple live broadcasts in a single screen. It currently supports CHZZK (chzzk.naver.com), SOOP (sooplive.com/afreecatv.com), and YouTube (youtube.com). This extension is not officially provided, operated, or endorsed by Naver/CHZZK, SOOP/AfreecaTV, or Google/YouTube.

### 1. Information Collected and Purpose of Use

Data the extension stores generally stays only inside the user's browser (device). The one exception is described in section 1-3 below: to prevent the same account from running multiple dashboards at once, the extension sends a minimal amount of information, in a form that cannot identify the account, to a server it operates itself.

| Category | Item | Storage location | Purpose | Sent externally? |
|---|---|---|---|---|
| Local settings data | Added channel list (`my_channels`) | `chrome.storage.local` | Building the multi-view layout | No |
| Local settings data | Saved presets (`my_presets`) | `chrome.storage.local` | Saving/loading channel-combination presets | No |
| Local settings data | Layout mode (`my_layout`) | `chrome.storage.local` | Persisting grid/main-sub screen mode | No |
| Local settings data | Personal settings (`my_profile`) | `chrome.storage.local` | Persisting user preferences (including the on/off state of experimental features such as collab overlap detection) | No |
| Authentication-related | CHZZK login session cookie | Browser cookie (owned by the CHZZK domain) | ① Automatically included (`credentials: include`) in requests to `api.chzzk.naver.com` to load the live list of followed channels<br>② Also sent along with requests to `comm-api.game.naver.com` so that the CHZZK chat page embedded as an iframe in the multi-view can recognize the login state (this request is made by CHZZK's own script, not called directly by this extension's code) | Sent only to CHZZK's own servers; never passed to or stored by this extension's developer |
| Authentication-related | SOOP login session cookies (`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`) | Browser cookies (owned by the SOOP domain) and partitioned (CHIPS) cookies with the same values | ① Automatically included when checking login status (`chapi.sooplive.co.kr/api/my/station`) and calling the followed-channel/tag-search/channel-search APIs (`sch.sooplive.com`)<br>② So that the SOOP video/chat pages embedded as iframes in the multi-view can recognize the login state, this extension reads the original login cookies via the `chrome.cookies` API and duplicates/syncs the same values into partitioned cookies (done automatically on install, on browser startup, and whenever the cookie value changes) | Sent only to SOOP/AfreecaTV's own servers; never passed to or stored by this extension's developer |
| Authentication-related | YouTube login session cookies (`SAPISID`, `__Secure-3PAPISID`, etc.) | Browser cookies (owned by Google's domain) | Used to check login status (only checks whether the cookie exists) and, only for requests that require login (e.g., checking whether a subscribed channel is currently live), the `chrome.cookies` API reads the cookie's value to locally compute a request header following Google's own authentication scheme (SAPISIDHASH — a SHA-1 hash of a timestamp, the cookie value, and the request origin) | The raw cookie value itself is never sent anywhere; only the hash computed locally from it is included in a request header sent to YouTube's own servers. Never passed to or stored by this extension's developer |

This extension never collects or stores the user's CHZZK/SOOP/YouTube account credentials (username/password) directly. Login state is confirmed solely through each platform's own login cookies already present in the browser, and is valid only while the user remains logged in to that website.

CHZZK's and SOOP's channel-search, tag-search, and followed-channel-list APIs cannot be called directly from an extension page due to browser CORS policy, so the background service worker relays these requests on the extension's behalf. This relay is restricted to only the domains listed in `host_permissions`, and never forwards requests to any other domain.

Channel names/keywords typed into the search box may be sent to the YouTube autocomplete API (`suggestqueries-clients6.youtube.com`) and the Google Translate API (`translate.googleapis.com`, used for automatic language detection and romanization) to improve search results. These requests never include login cookies or any other user-identifying information — only the typed search text is sent to Google's servers.

#### 1-1. Audio Processing (automatic multi-channel volume leveling, experimental)

This extension's audio-optimization and collab (joint-broadcast) overlap-detection features analyze each channel's audio signal to automatically adjust volume, or to determine whether the same sound is audibly overlapping between different channels. All of this analysis (K-weighted loudness measurement, AI voice-activity detection, waveform-similarity comparison) happens entirely and in real time inside the user's browser. The raw audio and the results of this analysis are never sent or stored anywhere, and are discarded on every refresh.

#### 1-2. How Followed/Subscribed YouTube Live Status Is Retrieved

YouTube searches that don't require login are handled through an invisible iframe inside an offscreen document the extension creates itself (in an anonymous state, never carrying login cookies).

Requests that require login (e.g., checking whether a subscribed channel is currently live) cannot be handled by that anonymous iframe. Instead, if the user already has a YouTube tab open, that tab is reused; otherwise a new YouTube tab is opened in the background (without taking focus), and the request is executed inside that tab (using the `tabs` and `scripting` permissions). This is equivalent to the user making the request themselves, using their own logged-in YouTube session. The result of the request (e.g., a subscribed channel's live status) is used only to update the dashboard display and is not stored separately. Requests made from this tab are sent only to YouTube's (Google's) servers.

#### 1-3. Duplicate-Instance Prevention (Single-Instance Lock) Server

To prevent the same real viewer from inflating a broadcast's viewer count by opening the CHEESE EYES dashboard in multiple windows (or multiple browser profiles) at once, this extension sends the following information to a separate server the developer operates directly (a Cloudflare Worker at `cheese-eyes-lock.seoldam82.workers.dev`):

- Identifiers for the CHZZK/SOOP/YouTube accounts the user is currently logged into (strings of the form "platform:accountID")
- A value identifying the folder this extension is installed in (`chrome.runtime.id`, which is not randomly generated but is a hash of the install path)
- A random session ID identifying a single dashboard tab (newly generated each time a browser is opened)

As soon as the server receives the account identifiers and install identifier above, it hashes them with HMAC-SHA256 using a secret key known only to the server, and discards the original values immediately without storing them anywhere (not even in logs). Only the hash value, the session ID, and an expiration time are stored. While the dashboard stays open normally, it automatically sends a heartbeat every 5 minutes that pushes the expiration time back, so the lock does not expire during actual use. Closing the window sends a deletion request immediately, releasing the lock right away; only in the exceptional case where that deletion request never arrives (e.g., the browser is force-closed) does the server expire and delete the entry on its own, at most about 12.5 minutes after the last heartbeat. (In other words, this is not "another window becomes available after 12.5 minutes" — it is a safety net so a lock never lingers forever after an abnormal shutdown.) This server is used only to decide lock status (whether the same account already has another window open) and is never used or analyzed for any other purpose, nor provided to any third party.

### 2. How Live Chat Is Displayed

This extension loads each channel's chat as-is into an iframe, as described below, and displays it on screen. This extension never separately collects, stores, processes, or transmits chat message content.

- CHZZK: `https://chzzk.naver.com/live/{channelId}/chat`
- SOOP: `https://play.sooplive.com/{channelId}/{streamNumber}?vtype=chat`
- YouTube: `https://www.youtube.com/live_chat?...`

SOOP's chat page is designed on the assumption that it was opened as an actual popup window via `window.open()`, and recognizes the login session through a reference to the window that opened it (`window.opener`). Since this extension displays chat inside the dashboard as an iframe rather than as a separate popup, it substitutes a reference to that same channel's video iframe (already open on the same screen) as `window.opener`. This happens entirely within the user's browser screen; it never reads or transmits credentials, and is used solely so that the user's own, already-logged-in session can read and post chat normally.

### 3. Notice on Webpage Display Modifications

This extension runs content scripts (CSS/JS) on the pages below to change how they are displayed.
- `chzzk.naver.com/content/multiview`: runs the extension's dashboard UI script
- `chzzk.naver.com/live/*`, `/chat/*`: hides the scrollbar, hides UI elements such as the header/sidebar/chat area, expands the video area to fill the screen, and automatically applies wide (theater) mode
- `play.sooplive.com/*`, `bj.afreecatv.com/*`: hides the scrollbar, automatically clicks the video screen-mode (high-quality) button, and substitutes the chat frame's `window.opener` (see section 2 above)
- `www.youtube.com/embed/*`, `/live_chat*`: hides the scrollbar and automatically applies wide mode

These changes occur only within the user's browser screen; they are never stored on CHZZK/SOOP/YouTube's servers and do not affect other users.

### 4. Purpose of Each Permission

| Permission | Purpose |
|---|---|
| `storage` | Stores the channel list, presets, layout, and settings on the device |
| `cookies` | Reads SOOP login cookies to sync them into partitioned cookies, and deletes related cookies on logout (see section 1 above); checks whether YouTube login cookies exist and computes the auth header (see section 1 above). CHZZK login cookies are never read or modified separately — they are used exactly as the browser automatically includes them in requests |
| `tabs` | Used to find an existing YouTube tab or open a new background tab to handle requests that require YouTube login (see section 1-2 above). Also used to open the dashboard itself in a new tab |
| `scripting` | Used to execute login-session requests inside the YouTube tab above (see section 1-2 above) |
| `offscreen` | Used to open the invisible anonymous proxy document that handles YouTube searches that don't require login (see section 1-2 above) |
| `host_permissions (chzzk.naver.com, sooplive.com/sooplive.co.kr/afreecatv.com, etc.)` | API calls for loading multi-view iframes, channel/tag search, and followed-channel-list lookups |
| `host_permissions (comm-api.game.naver.com)` | Not called directly by this extension. The CHZZK chat page embedded as an iframe in the multi-view calls this domain internally to verify the login session. Without this domain in host_permissions, Chrome would treat that iframe as third-party content embedded by the extension and block login-session cookies from being sent to it, causing CHZZK chat to appear logged out inside the iframe. Including it grants an exception to that cookie-partitioning block, so logged-in chat displays correctly. |
| `host_permissions (http://*.sooplive.com/*)` | This extension never makes a request to this address directly (unencrypted http). It is understood to serve the same purpose as `comm-api.game.naver.com` above: the SOOP video/chat pages embedded as iframes in the multi-view are believed to call this address internally to verify the login session, and without this exception Chrome would treat it as third-party content and block login-session cookies, causing chat login to go unrecognized. |
| `host_permissions (youtube.com)` | Loading multi-view iframes, embedding YouTube video/chat, and the login-tab proxy (see section 1-2 above) |
| `host_permissions (suggestqueries-clients6.youtube.com)` | Calls the YouTube autocomplete (suggested search terms) API during channel search |
| `host_permissions (translate.googleapis.com)` | Automatic language detection and romanization of search terms (calls the Translate API) |
| `host_permissions (accounts.google.com)` | Used only as the destination page for the YouTube login popup window (just a navigation target — no separate requests are sent to this domain) |
| `host_permissions (cheese-eyes-lock.seoldam82.workers.dev)` | Calls the duplicate-instance-prevention server (see section 1-3 above) |

### 5. Sharing with Third Parties

This extension does not sell, rent, or provide any of the user's information to third parties. Aside from the transmissions to each platform's own servers (CHZZK/SOOP/YouTube) described in section 1, the Google API calls used to refine search terms, and the transmission to the duplicate-instance-prevention server described in section 1-3, no other external transmission takes place.

### 6. Data Deletion

- If the user removes this extension from the browser's extension management menu, all data stored in `chrome.storage.local` is deleted along with it.
- Running SOOP logout from the extension's settings menu immediately deletes the original and partitioned login cookies (`AuthTicket`, `UserTicket`, `sck_session_key`, `RDB`).
- Any hash value remaining on the duplicate-instance-prevention server (section 1-3) is deleted immediately when a deletion request is sent as the dashboard closes; only if that request never arrives (e.g., the browser is force-closed) does it automatically expire and get deleted from the server, at most about 12.5 minutes after the last heartbeat.

### 7. Contact

For inquiries about this extension, please contact seoldam82@gmail.com.

### 8. Changes to This Policy

This policy may be updated as the extension's features change; when it is, the "last updated" date at the top of this document is updated accordingly.
