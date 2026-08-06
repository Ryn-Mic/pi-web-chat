# pi-web-chat HANDOFF

> 작성일: 2026-07-18 · 갱신: 2026-07-18 · 브랜치 `main` · 최신 커밋 `80a8fdb`

pi 코딩 에이전트용 웹 UI (OpenWebUI 스타일, 모바일 지원).  
**pi package** 로 설치 가능 — `pi --web` 으로 백그라운드 기동.

이 문서는 다음 작업자를 위한 인수인계 문서다.

---

## 1. 빠른 시작

### 개발

```bash
npm install
npm run dev                 # 서버(3141) + vite(5173) → http://localhost:5173
npm run build && npm start  # 프로덕션 빌드 후 → http://localhost:3141
npm run typecheck
npm run pack:check          # build + npm pack --dry-run (배포물 확인)
```

### 사용자 설치 (pi package)

```bash
pi install /path/to/pi-web-chat   # 또는 git:… / npm:pi-web-chat
pi --web                     # 웹 UI 데몬만 기동, TUI 안 뜸, 셸 즉시 복귀
pi --web status
pi --web stop
pi --web restart             # stop + start (기존 port/host 유지)
pi --web 3200                # 포트 지정
pi --web --lan               # bind 0.0.0.0 (LAN)
pi --web --host 0.0.0.0      # bind 주소 명시
pi --web --token <값>         # 액세스 토큰 지정 (기본: 자동 생성)
```

- 인증: **토큰 + 2FA(TOTP)**. 첫 기동 시 `~/.pi/web-chat/token`(토큰, 재시작 유지)과
  `~/.pi/web-chat/2fa.secret`(TOTP 시크릿) 자동 생성. `pi --web rftoken`으로 토큰 교체(즉시 적용).
  2FA 코드는 서버 로그에 출력하지 않음 — 인증 앱으로 QR 등록 후 사용. `PI_WEB_2FA=off` 로 2FA 끔.
  LLM API 인증은 pi CLI와 동일한 `~/.pi/agent/auth.json`. **pi를 먼저 설정해 둘 것**
- `PI_WEB_CWD`: 에이전트 cwd (기본 `~/.pi/web-chat`, 없으면 자동 생성)
- `PORT`: 서버 포트 (기본 3141)
- `HOST`: bind 주소 (기본 `127.0.0.1`, LAN 공개 시만 `0.0.0.0`). CLI: `--lan` / `--host <addr>`
- 데몬 상태 파일: `~/.pi/web-chat/pi-web-chat.pid` / `.port` / `.host` / `.log`
- 모바일 개발: vite `host: true` → 같은 네트워크 `http://<맥IP>:5173`

---

## 2. 아키텍처

```
pi --web / pi-web-chat / npm start
   │  extensions/pi-web-chat.ts 가 detached node dist/index.js 스폰
   ▼
browser (React 19 + TanStack Query/Router + Base UI + Tailwind v4 + PWA)
   │  WebSocket /ws  +  HTTP /api/*
   ▼
dist/index.js  (esbuild 번들)  또는  dev: tsx server/index.ts
   │  @earendil-works/pi-coding-agent SDK
   ▼
AgentSessionRuntime
   · chat cwd: ~/.pi/web-chat  (PI_WEB_CWD)
   · 세션 파일: ~/.pi/agent/sessions  (pi CLI와 공유 가능)
```

| 경로 | 역할 |
|---|---|
| `bin/pi-web-chat.mjs` | CLI 엔트리 → `dist/index.js` |
| `extensions/pi-web-chat.ts` | pi package extension. `pi --web` 데몬 모드 + `/web` 커맨드 |
| `scripts/build.mjs` | vite 프론트(`dist/public`) + esbuild 서버(`dist/index.js`) |
| `server/index.ts` | 세션 런타임, WS, HTTP API, 정적 서빙 |
| `server/serialize.ts` | `AgentMessage[]` → `UIMessage[]` |
| `shared/protocol.ts` | **서버/클라 공용 타입. 프로토콜 변경 시 여기부터** |
| `src/lib/chat.ts` | WS 클라이언트 + 스토어, steer/fork/focusToken |
| `src/lib/api.ts` | `useSessions` `useModels` `useForkPoints` `useExtensions` |
| `src/lib/theme.ts` | theme preference `system`/`light`/`dark` |
| `src/lib/sidebar.ts` | 세션 사이드바 pin 상태 (localStorage) |
| `src/components/` | ChatPage, MessageList, Composer, Markdown, ModelMenu(검색), ThinkingMenu, SettingsMenu, ForkDialog, ExtensionsDialog, SessionsDrawer/Sidebar |

### 배포 빌드 산출물

```
dist/index.js       # 서버 번들 (peer/deps external)
dist/public/**      # 프론트 + PWA sw/manifest
```

- `package.json` `files`: `bin`, `dist`, `extensions`, `README.md`
- `prepack` → `npm run build` (publish 시 자동 빌드)
- 런타임 deps: `@earendil-works/pi-coding-agent`, `ws`
- React/Vite 등은 **devDependencies** (사용자 install에 불필요)
- git install은 `npm install --omit=dev` 이라 **dist를 tarball/릴리스에 포함**해야 함 (npm publish 권장)

### 핵심 동작 원리

- **스냅샷 + 델타 하이브리드**: text/thinking 델타 스트리밍, 완결 시 스냅샷.
  클라이언트는 스냅샷 수신 시 스트림 버퍼 clear (`chat.ts`).
- **`agent_end` 시 isStreaming 강제 false**: SDK가 잠시 true로 남을 수 있어
  서버·클라 모두 명시적으로 내린다. typing `…` 잔상 방지.
- **세션 교체 시 `bindSession()` 재구독 필수** (`newSession`/`switch`/`fork`).
- **스트리밍 중 prompt → steer** 자동.
- **fork**: `/api/fork-points` → WS `fork` → `forked.selectedText` → composer 주입.
- **thinking level 필터**: `reasoning` / `thinkingLevelMap` (xhigh/max는 명시 매핑만).
- **`pi --web`**: extension factory 시점에 argv를 읽어 서버를 detached 스폰 후
  `process.exit(0)` — TUI를 열지 않음. `/web` 은 일반 세션 안 slash command.

---

## 3. 완료된 작업

| 커밋 | 내용 |
|---|---|
| `27cfd65` | 초기 스캐폴드: SDK 서버 + WS + 채팅 UI + 세션/모델 + 모바일 |
| `5134819` | 마크다운, fork UI, thinking level, 이미지 첨부, dark/light |
| `b5456dc` | HANDOFF, dev 기동 race 수정 (`wait-on`) |
| `23aa994` | 테마 preference: system / light / dark |
| `4f6dd97` | 모델 피커 검색 |
| `d335184` | 스트리밍 종료 UX (typing 잔상 제거), composer focus·스크롤바 숨김 |
| `5ad9a2a` | 세션 사이드바 고정(dock) + 드로어, 목록 자동 갱신 |
| `3c74fd1` | SettingsMenu 통합, ForkDialog, Extensions 브라우저 (`/api/extensions`) |
| `a4ba58e` | PWA (manifest, icons, sw, vite-plugin-pwa) |
| `80a8fdb` | **pi package** + `pi --web` 백그라운드 데몬, production build 파이프라인 |

### 기능 요약 (현재 main)

**배포 / 실행**
- [x] pi package (`pi install`, keywords `pi-package`)
- [x] `pi --web` / `status` / `stop` / 포트 — TUI 없이 데몬
- [x] `/web` slash command (세션 안)
- [x] `pi-web-chat` bin, `npm start` → 빌드 산출물 실행
- [x] esbuild 서버 + vite `dist/public` 빌드
- [x] 기본 chat cwd = `~/.pi/web-chat`

**UI**
- [x] 설정 메뉴(톱니): 테마 3단, fork, 확장 목록, 로그아웃
- [x] 세션 드로어 + 데스크톱 사이드바 pin
- [x] 프로젝트 그룹: 마지막 디렉토리명 표시(대문자 제거), 접기/펼치기, 그룹별 + 새 세션
- [x] 세션 삭제(확인 후) / 이름 변경(인라인 입력)
- [x] 모델/thinking 선택 → 컴포저 하단 행으로 이동
- [x] Markdown H1~H6 축소, `✻ Turn took` 메타 줄 흐리게 표시, ANSI 코드 서버에서 제거
- [x] JetBrainsMono Nerd Font webfont 번들 (@font-face, 전체 UI)
- [x] 인증: 액세스 토큰 + 2FA(TOTP, 기본 켜짐) — 로그인 페이지, API/WS 전부 검증
- [x] 모델 검색
- [x] Extensions 다이얼로그 (로드된 패키지/툴/커맨드/플래그)
- [x] 마크다운·thinking·이미지·fork·PWA
- [x] 스트리밍 종료 시 typing indicator 잔상 수정

**검증해 둔 것**
- `npm run build` / `typecheck`
- `npm pack --dry-run` (dist·bin·extensions 포함, ~282KB)
- `pi install <local path>` 후 extension `/web` 로드
- `pi --web` → 즉시 exit, `http://localhost:3141` 200
- `pi --web status` / `stop`

### 검증 규칙 (Verification rules)

- **절대 프로덕션 daemon 을 건드리지 않는다**: 실제 서버는 기본 포트(3141)에서
  돌고 있다. 모든 스모크 테스트/재시작은 전용 임시 포트(예: 43xxx)를 사용하고
  메인 daemon 을 죽이거나 재시작하지 않는다.
- **상태 파일을 덮어쓰지 않는다**: 임시 서버는 `~/.pi/web-chat/*` 상태 파일을
  덮어쓰면 메인 daemon 이 orphan 이 된다. 반드시 격리된 HOME 으로 띄운다:
  `HOME=/tmp/pwc-verify PORT=43150 node dist/index.js`
  (상태 파일이 /tmp/pwc-verify/.pi/web-chat/ 에 생성됨)
- 서버 동작 확인은 `/api/health` 와 같은 읽기 전용 엔드포인트로만 한다.

### 설정 메뉴 확장 가이드

저빈도 액션은 `SettingsMenu` 항목으로:
- 세션 이름 변경 / HTML 내보내기 / steer·followUp / cwd 전환 등
- 모델·thinking·새 세션·abort 는 헤더/컴포저 유지

---

## 4. TODO (우선순위순)

### P1

- [ ] **에러 토스트 UI**: 서버 `error` → 현재 `console.error` only (`chat.ts`)
- [x] ~~**세션 이름 변경**: `session.setSessionName`~~ — 완료 (드로어 인라인 입력)
- [ ] **번들 사이즈**: JS ~821kB. `manualChunks` / dynamic import (markdown·hljs)
- [ ] **컨텍스트/비용 표시**: `getContextUsage()` / `getSessionStats()` → 헤더
- [ ] **npm/git 공개 배포**: 패키지명·repo 필드·README 설치 예 정리 후 publish
      (git install 시 dist 포함 전략 결정: 릴리스 태그에 dist 또는 npm only)

### P2

- [ ] **멀티 클라이언트**: 현재 전 탭이 단일 runtime 공유. 탭별 세션 원하면 WS×runtime 맵
- [ ] **followUp**: 스트리밍 중 전송이 전부 steer. UI 토글 → `streamingBehavior: "followUp"`
- [ ] **스냅샷 이미지 최적화**: base64 매 스냅샷 → `/api/image/:hash` 등
- [ ] **마크다운 스트리밍 성능**: 델타 전체 re-parse throttle
- [ ] **navigateTree**: 같은 파일 내 브랜치 이동 + 트리 UI
- [ ] **테스트**: `serialize.ts` / protocol 라운드트립 vitest

### P3

- [x] ~~PWA~~ (a4ba58e) — 오프라인 셸/실기기 홈화면 추가는 더 다듬을 여지
- [ ] 세션 HTML 내보내기 (`exportToHtml`) → Settings
- [ ] compaction 상태 표시
- [x] ~~인증 레이어~~ — 완료: 토큰 + 2FA(TOTP). `--token` / `PI_WEB_TOKEN` / `PI_WEB_2FA=off`
      원격 접속 시 HTTPS는 역방향 프록시(Caddy/nginx) 또는 터널(Tailscale)에서 처리
- [ ] 다중 프로젝트 cwd 전환 (`cwdOverride`) — 사이드바 그룹별 새 세션(`?cwd=`)으로 일부 구현됨

---

## 5. 알려진 이슈 / 엣지케이스

- **스트리밍 중 새 클라이언트 접속**: 이미 보낸 델타 유실 → 다음 스냅샷까지 빈 메시지처럼 보일 수 있음
- **fork 인라인 버튼**: 스냅샷 메시지에 entryId 없음 (메뉴/다이얼로그 entryId 기반은 OK)
- **일부 모델 thinking off 불가**: `thinkingLevelMap.off === null` 이면 UI에서 off 숨김이 정상
- **iOS Safari**: safe-area/`h-dvh` 적용, 키보드 업 레이아웃은 실기기 미검증
- **`pi --web` 과 TUI 동시 사용**: `--web`은 데몬만 띄우고 종료. 웹+TUI 같이 쓰려면
  일반 `pi` 세션에서 `/web` 또는 별도 `pi-web-chat`
- **웹 서버 runtime ≠ TUI runtime**: 웹은 자체 `AgentSessionRuntime` (cwd `~/.pi/web-chat`).
  TUI 현재 프로젝트 cwd 와 세션 공간이 다를 수 있음
- **로컬 path 패키지 표시명**: settings에 `../../dev/pi-web-chat` 처럼 상대경로로 들어갈 수 있음

---

## 6. 참고 자료

- README: 설치/`pi --web`/개발 절차
- pi packages: `docs/packages.md` (pi 설치 경로)
- pi extensions / `registerFlag`: `docs/extensions.md`
- SDK: `@earendil-works/pi-coding-agent` → `docs/sdk.md`, `examples/sdk/`
- 타입: 패키지 `dist/**/*.d.ts` grep  
  (`core/agent-session.d.ts`, `core/agent-session-runtime.d.ts`)
