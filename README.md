# pi-web-chat

Web UI for the [pi](https://pi.dev) coding agent (OpenWebUI-style, mobile-friendly).

[한국어](./README.ko.md) · [中文](./README.zh.md)

## Install & run

Intended flow:

```bash
# 1) Install pi (skip if already installed)
npm i -g @earendil-works/pi-coding-agent

# 2) Install pi-web-chat
pi install npm:pi-web-chat
# pi install /path/to/pi-web-chat          # local path
# pi install git:github.com/preinpost/pi-web-chat@v0.1.1

# 3) Start the web UI daemon only (no TUI; returns to the shell immediately)
pi --web
# → pi-web-chat started — http://localhost:3141

pi --web status
pi --web stop
pi --web restart             # stop + start (keeps prior port/host)
pi --web 3200                # custom port
pi --web --lan               # bind 0.0.0.0 (LAN)
pi --web --host 0.0.0.0      # same, explicit bind address
pi --web 3200 --host 0.0.0.0
pi --web --token my-secret   # set the access token (default: auto-generated)
pi --web rftoken             # rotate the access token (applies immediately)
```

`pi --web` starts **only the web server daemon** and exits. It does not open the pi TUI.
If the server is already running, it prints the URL again.

> **Auth (token + 2FA):** the server enforces access control on every API/WebSocket call.
> On first start it auto-generates an access token (`~/.pi/web-chat/token`, persists across
> restarts; rotate anytime with `pi --web rftoken`) and a local TOTP secret
> (`~/.pi/web-chat/2fa.secret`, 2FA on by default; disable with `PI_WEB_2FA=off`).
> Log in from the web page with token + a **current** 2FA code from your authenticator app
> (enroll by scanning the QR under "First-time 2FA setup" on the login page).

### Other ways to run

```bash
# Standalone CLI (no pi session)
pi-web-chat
# HOST=0.0.0.0 pi-web-chat   # LAN bind via env

# Inside a pi session
/web                    # start (default port 3141, bind 127.0.0.1)
/web 3200               # custom port
/web --lan              # bind 0.0.0.0
/web --host 0.0.0.0     # explicit bind address
/web status
/web stop
/web restart
```

State files: `~/.pi/web-chat/pi-web-chat.pid`, `pi-web-chat.port`, `pi-web-chat.host`, `pi-web-chat.log`

> `pi install` installs production dependencies only. The frontend ships as built assets under `dist/public`, so end users do not need Vite/React installed.

## Development

```bash
npm install

# Dev (server:3141 + vite:5173, proxies /api and /ws)
npm run dev
# → http://localhost:5173

# Production build + run
npm run build
npm start
# → http://localhost:3141
```

### Package checks

```bash
npm run pack:check   # build + npm pack --dry-run
npm pack             # creates pi-web-chat-*.tgz
pi install ./pi-web-chat-0.1.1.tgz
# or install from the directory
pi install .
```

Quick local extension load:

```bash
npm run build
pi -e .
# then /web in the session
```

### GitHub Actions release

In the repo: **Actions → Release → Run workflow**

| input | description |
|---|---|
| `mode` | `release` (bump + tag + publish) or `publish-only` (current `package.json` version → npm, no git bump) |
| `bump` | `patch` / `minor` / `major` (`release` mode only) |
| `publish_npm` | publish to npm after tagging (`release` mode; always on for `publish-only`) |
| `dry_run` | skip git push + `npm publish --dry-run` |

**release** flow: `npm ci` → `typecheck` → `build` → pack check → `npm version <bump>` → push commit/tag → `npm publish`  
**publish-only** flow: `npm ci` → `typecheck` → `build` → pack check → `npm publish` (no version bump / no git push)

Use `publish-only` when the git tag already exists but npm publish failed.

Required secret:

- `NPM_TOKEN` — npm automation token (publish steps)

## Environment

- `PORT` — server port (default `3141`)
- `HOST` — bind address (default `127.0.0.1`). Use `0.0.0.0` only on trusted networks. Prefer `pi --web --lan` / `pi --web --host 0.0.0.0` when starting via the extension
- `PI_WEB_TOKEN` — access token (default: auto-generated into `~/.pi/web-chat/token`)
- `PI_WEB_2FA` — set to `off` to disable the TOTP second factor (default: on)
- `PI_WEB_CWD` — agent working/session directory (default `~/.pi/web-chat`, created if missing)

LLM API auth uses the same `~/.pi/agent/auth.json` as the pi CLI. Configure pi (login / API keys) first.

> **Security:** the app enforces token + 2FA auth, but HTTPS is your responsibility.
> For remote access, run behind a reverse proxy (Caddy/nginx) or a tunnel (Tailscale Serve)
> that terminates TLS — never send the token over plain HTTP on a public network.

## Stack

- **Server:** Node + [pi SDK](https://pi.dev) (`@earendil-works/pi-coding-agent`) + WebSocket (`ws`)
- **Frontend:** React 19 + TanStack Router / Query + Base UI + Tailwind CSS v4 + Vite

## Layout

```
bin/pi-web-chat.mjs       CLI entry (runs dist/index.js)
extensions/pi-web-chat.ts pi package extension (/web, --web)
scripts/build.mjs         vite frontend + esbuild server bundle
server/                   server source
shared/protocol.ts        shared server/client types
src/                      frontend source
dist/index.js             built server (published)
dist/public/              built frontend (published)
```

## Features

- Live streaming (text / thinking deltas)
- **Streaming Markdown rendering** (Streamdown + Shiki syntax highlighting)
- Tool-call display (bash, edit, read, …) with expandable results
- Session list / switch / new session (can share pi CLI sessions)
- **Per-session URLs** (`/s/:sessionId`): each browser tab/device drives its own session; opening the same URL syncs live. `/` starts a fresh session
- **Session fork** from a user message via the settings menu
- Model switching + **thinking level**
- **Custom model management**: add/edit custom providers and models in `~/.pi/agent/models.json` from the settings menu (Ollama, LM Studio, vLLM, proxies)
- **Image attachments** (file picker / clipboard paste)
- **Settings menu:** theme (system/light/dark), language, model management, session fork, extensions
- Send while streaming → steering
- Abort
- Mobile: safe-area, `dvh` layout, session drawer
