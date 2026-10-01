# Agent Note: Protect internal credentials and async ownership across the second review

Status: implemented

## Problem

The v0.1.137 review reproduces nine failures: default workspace file APIs expose internal credentials; a null Codex RPC frame escapes parsing; stale authentication responses overwrite newer state; transient HTTP errors sign users out; a disposed Codex session retains a late native subscription; and the prompt navigator confuses global ordinals, retains stale indexes, loops after index failure, and retries the wrong failed operation.

## Decision

File listing, search, preview and editing share a credential-aware path policy. Authentication state remains in its existing directory; the default new-chat cwd is its workspace child. Private state outside that child is forbidden even under a previously authorized parent root. Credential inode checks also reject hardlink aliases and revalidate opened descriptors. Historical user files and session cwd values are never migrated or deleted.

Authenticated frontend requests carry a monotonic authentication generation. Sign-out invalidates local ownership before its network request completes. Late 200/401 or login/logout responses cannot replace newer authentication. Only 401 invalidates credentials; temporary errors preserve recovery state. Preview, editing, model and query transports use the same guard.

Codex validates RPC objects before dispatch while accepting nullable optional response fields. Session connection, observer and history paths check disposal after awaits; one disposed session never stops the shared transport used by others.

Prompt indexes are scoped to session, history replacement and newest persisted user identity. Global ordinals project onto loaded suffixes, optimistic inputs are excluded, and unknown-index jumps are disabled. Index failure stops automatic retry; a failed jump retains its ordinal so manual retry repeats the history operation. Prompt navigation explicitly suspends bottom following across prepend/layout events until new user input or a new turn restores it.

## Alternatives considered

- Mode 0600 or gitignore is rejected as HTTP credential protection because the server itself can read the files.
- Migrating existing session files is rejected because their cwd and content remain user-owned historical state.
- Stopping the shared Codex client when one session closes is rejected because it interrupts independent sessions.
- Process-wide exception swallowing or blind request retry is rejected because it hides ownership errors.
- Estimated global counts and session-id-only index caching are rejected because pagination and new persisted inputs invalidate both assumptions.
- Increasing browser waits is rejected as a prepend-scroll repair; explicit following intent prevents the actual viewport race.

## Verification

- 431 Node tests pass, including private file reads/writes and capability denial with 2FA enabled, directory/search protection, symlink/hardlink aliases, auth generation and 5xx handling, malformed RPC frames, and late connection/observer/history responses.
- 41 Chromium tests pass. The five new prompt-navigation cases also pass five repetitions each, for 25 cases.
- Types, Notes, isolated build, pack:check, npm pack dry-run and diff validation pass. Package and lockfile roots plus release notes agree on v0.1.138.
- Build/browser/package validation uses an isolated source copy and existing dependencies; production port 3141 is not restarted or overwritten.

## Consequences

Old sessions keep their cwd but cannot expose authentication state through file APIs. Users may manually move their historical work files into the new workspace without moving authentication files. Credential protection is a file API boundary, not a sandbox for an explicitly authorized coding agent's host tools.

Indexes refresh at persisted-user or history-replacement boundaries rather than per streaming token. Browser acceptance does not replace physical mobile-device or real shared Codex daemon fault validation. The nine changes remain one review-boundary patch delivery; merging, publishing and local deployment are separate authorized operations.
