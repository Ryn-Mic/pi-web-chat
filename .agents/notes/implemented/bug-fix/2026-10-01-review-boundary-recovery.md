# Agent Note: Review-driven transport, authentication, cache, and persistence boundaries

Status: implemented

## Problem

The v0.1.132 review reproduces six failures not covered by the existing green suite: malformed request targets escape URL parsing and stop the HTTP process; a rejected Codex observer poll becomes an unhandled rejection; signing out retains chat clients and prevents a fresh connection after signing back in; the PWA navigation rule caches authenticated API responses despite no-store; saving models.json replaces private permissions with the process umask; and a missing explicit Pi session silently creates a replacement session.

## Decision

The existing architecture stays in place, with each failure contained at its ownership boundary. HTTP and upgrade routes share a fail-closed URL parser. Scheduled observer polling catches failures locally and retains subsequent retries instead of fabricating turn completion. Authentication expiry, sign-out, and credential-namespace replacement clear chat clients, snapshots, composer drafts, previews, and protected query caches; workspace generations also reject late callbacks from an earlier login.

PWA navigation caching accepts only same-origin, query-free app routes. A small Workbox activation script removes the legacy pi-web-html cache without deleting app precache or unrelated same-origin caches. Model configuration uses an exclusive random temporary file with mode 0600 and atomic rename. An unavailable explicit Pi session fails before runtime creation, sends the shared terminal WebSocket close code 4404, keeps its requested URL, and shows an error without scheduling another reconnect.

The six repairs form one patch delivery because they share a reproducible review baseline. Login rate limiting, large-project file indexing, and broad module decomposition are not included.

## Alternatives considered

- Global uncaughtException or unhandledRejection swallowing is rejected because it hides failed operations and cannot restore coherent runtime state.
- Reconnecting retained chat clients with a new token is rejected because snapshots, drafts, in-flight history, and pending actions still cross authentication boundaries.
- Clearing every browser cache on sign-out or upgrade is rejected because offline app assets and unrelated same-origin caches do not contain the failed navigation responses.
- Rewriting the worker with InjectManifest is rejected because Workbox navigation predicates and an activation cleanup script preserve current build and lazy-loading gates.
- Umask-dependent models.json replacement is rejected because API-key privacy must not depend on parent-directory traversal permissions or launch environment.
- Retrying a missing Pi session indefinitely or creating a replacement is rejected because explicit session identity is not a draft-creation request.

## Verification

- Focused regression tests pass, including malformed HTTP and upgrade targets, a terminal missing-session bind with no replacement runtime, observer failure followed by scheduled recovery, model-file privacy, and authentication-namespace cleanup.
- The full Node suite passes 420 tests; typecheck and note validation pass.
- The Chromium browser suite passes 36 tests, including real sign-out/sign-in reconnection, a missing-session link that stays terminal, legacy navigation-cache migration, authenticated API navigation that is unavailable offline, and preserved offline app shell loading.
- Build, npm run pack:check, npm pack --dry-run, and git diff --check pass. The package contains 245 files, approximately 7.62 MiB packed and 23.89 MiB unpacked.
- Production port 3141 uses the checkout's dist directory. Build, browser, and package verification therefore run in an isolated source copy with the existing node_modules linked in; production distribution files are not overwritten and the managed daemon is not restarted.

## Consequences

Transient request and observer failures no longer end unrelated sessions. Signing out deliberately discards authenticated in-memory drafts but does not interrupt server-side Agent tasks. Invalid explicit Pi links now require a valid session selection instead of silently becoming new chats. The existing source checkout's dist remains at the production version until an explicitly authorized deployment builds or installs the repaired version.

Navigation-cache cleanup applies when the repaired worker activates; clients that keep an old worker indefinitely retain its old behavior. This verification uses Node 24 and Chromium, not physical iOS/Android devices or real shared Codex daemon fault injection.
