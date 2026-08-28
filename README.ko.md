# pi-web-chat

pi 코딩 에이전트용 웹 UI (OpenWebUI 스타일). 모바일 지원.

[English](./README.md)

## Install & run

의도한 사용 흐름:

```bash
# 1) pi 설치 (이미 있으면 skip)
npm i -g @earendil-works/pi-coding-agent

# 2) pi-web-chat 패키지 설치
pi install npm:@ryn-mic/web-chat
# pi install /path/to/pi-web-chat          # 로컬
# pi install git:github.com/Ryn-Mic/pi-web-chat@v0.1.108

# 3) 웹 UI만 백그라운드 기동 (TUI 안 뜸, 바로 셸 복귀)
pi --web
# → pi-web-chat started — http://localhost:3141

pi --web status
pi --web stop
pi --web 3141 restart        # 프로덕션 재시작 (포트 명시 필수)
pi --web 3200                # 포트 지정
pi --web --lan               # 0.0.0.0 바인드 (LAN)
pi --web --host 0.0.0.0      # 동일, bind 주소 명시
pi --web 3200 --host 0.0.0.0
```

`pi --web`은 **pi와 Codex를 함께 제공하는 하나의 웹 서버 데몬**을 띄우고 즉시 종료합니다. 새 세션의 백엔드는 Web 설정에서 선택할 수 있으며 pi TUI는 열리지 않습니다.
이미 떠 있으면 URL만 다시 보여 줍니다.

> `--lan` / `--host 0.0.0.0` 은 모든 인터페이스에 서버를 엽니다. 토큰 및 2FA 인증을 유지하고 신뢰할 수 있는 네트워크에서만 사용하세요.

### 다른 실행 방법

```bash
# 단독 CLI (pi 세션 없이)
pi-web-chat
# HOST=0.0.0.0 pi-web-chat   # env로 LAN 바인드

# pi 세션 안 slash command
/web                    # start (기본 포트 3141, bind 127.0.0.1)
/web 3200               # 포트 지정
/web --lan              # 0.0.0.0 바인드
/web --host 0.0.0.0     # bind 주소 명시
/web status
/web stop
/web restart
```

상태 파일: `~/.pi/web-chat/pi-web-chat.pid`, `pi-web-chat.port`, `pi-web-chat.host`, `pi-web-chat.log`

> `pi install`은 production deps만 설치합니다. 프론트는 `dist/public` 빌드 산출물로 포함되므로 사용자 PC에 Vite/React가 필요 없습니다.

## 개발

```bash
npm install

# 개발 (서버:3141 + vite:5173, /api·/ws 프록시)
npm run dev
# → http://localhost:5173

# 프로덕션 빌드 + 실행
npm run build
npm start
# → http://localhost:3141
```

### 패키지 배포 체크

```bash
npm run pack:check   # build + npm pack --dry-run
npm pack             # pi-web-chat-*.tgz 생성
pi install ./pi-web-chat-0.1.1.tgz
# 또는 디렉터리 직접
pi install .
```

### GitHub Actions 릴리스

repo **Actions → Release → Run workflow**

| input | 설명 |
|---|---|
| `mode` | `release` (bump+tag+publish) 또는 `publish-only` (현재 `package.json` 버전만 npm 배포, git bump 없음) |
| `bump` | `patch` / `minor` / `major` (`release` 모드만) |
| `publish_npm` | 태그 후 npm publish (`release` 모드; `publish-only`는 항상 배포) |
| `dry_run` | git push 생략 + `npm publish --dry-run` |

**release**: `npm ci` → `typecheck` → `build` → pack check → `npm version <bump>` → push → `npm publish`  
**publish-only**: `npm ci` → `typecheck` → `build` → pack check → `npm publish` (버전/태그 변경 없음)

git 태그는 있는데 npm publish만 실패했을 때 `publish-only`를 쓰면 됩니다.

필요 secret:
- `NPM_TOKEN` — npm automation/publish 토큰

로컬에서 pi package 로드만 빠르게 보려면:

```bash
npm run build
pi -e .
# 세션에서 /web
```

## 환경변수

- `PORT`: 서버 포트 (기본 3141)
- `HOST`: bind 주소 (기본 `127.0.0.1`). LAN 공개 시에만 `0.0.0.0` 등 사용. extension으로 띄울 때는 `pi --web --lan` / `pi --web --host 0.0.0.0` 권장
- `PI_WEB_CWD`: 에이전트 작업/세션 디렉토리 (기본: `~/.pi/web-chat`, 없으면 자동 생성)

인증은 pi CLI와 동일하게 `~/.pi/agent/auth.json`을 사용합니다. 먼저 `pi`를 한 번 실행해 로그인/API 키 설정이 되어 있어야 합니다.

> **보안**: 앱 자체 인증이 없습니다. 기본은 루프백 전용입니다. 외부/공인망에 그대로 노출하지 마세요. 원격 접근이 필요하면 Tailscale serve / SSH 터널 등을 권장합니다.

## 스택

- **서버**: Node + [pi SDK](https://pi.dev) (`@earendil-works/pi-coding-agent`) + WebSocket (`ws`)
- **프론트**: React 19 + TanStack Router / Query + Base UI + Tailwind CSS v4 + Vite

## 구조

```
bin/pi-web-chat.mjs       CLI 엔트리 (dist/index.js 실행)
extensions/pi-web-chat.ts pi package extension (/web)
scripts/build.mjs         vite 프론트 + esbuild 서버 번들
server/                   서버 소스
shared/protocol.ts        서버/클라 공용 타입
src/                      프론트 소스
dist/index.js             빌드된 서버 (배포물)
dist/public/              빌드된 프론트 (배포물)
```

## 기능

- 실시간 스트리밍 (text / thinking 델타)
- **스트리밍 마크다운 렌더링** (Streamdown + Shiki 구문 강조)
- 툴 실행 표시 (bash, edit, read, ...) + 결과 펼쳐보기
- 세션 목록 / 전환 / 새 세션 (pi CLI 세션과 공유됨)
- **세션별 URL** (`/s/:sessionId`): 탭·기기마다 서로 다른 세션을 동시에 사용, 같은 URL은 실시간 동기화. `/` 로 접속하면 새 세션
- **세션 포크**: 설정 메뉴에서 특정 유저 메시지 지점으로 새 세션 분기
- 모델 전환 + **thinking level 전환**
- **커스텀 모델 관리**: 설정 메뉴에서 `~/.pi/agent/models.json`의 커스텀 프로바이더/모델 추가·수정 (Ollama, LM Studio, vLLM, 프록시 등)
- **이미지 첨부**: 파일 선택 / 클립보드 붙여넣기
- **설정 메뉴**: 테마(시스템/라이트/다크), 언어, 모델 관리, 세션 포크, 확장 목록
- 스트리밍 중 메시지 전송 → steering
- 중단 (abort)
- 모바일: safe-area, dvh 레이아웃, 세션 드로어
