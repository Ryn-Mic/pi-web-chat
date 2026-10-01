# Agent Note: Fold completed assistant execution into one process disclosure

Status: implemented

## Problem

The transcript renders each assistant message separately. Thinking and tool cards remain scattered above the final answer, making completed coding tasks unnecessarily long on mobile. The user wants a Codex-style process group that stays expanded during execution and folds when the final answer arrives.

## Decision

`src/lib/conversation-turns.ts` groups the loaded transcript by user-prompt boundaries using stable message identities. `MessageList.tsx` renders the assistant's intermediate commentary, thinking and paired tool calls in one native details disclosure. Final replies, user prompts and custom notices remain outside it. Active turns default to expanded; settled turns with a meaningful trailing reply default to collapsed. Failed, unresolved-tool and no-final turns stay expanded. Plain replies have no empty process entry.

A settled turn's final-message identity anchors the disclosure, including when a page starts mid-turn and its prompt is later prepended. Manual state survives snapshot refresh and reconnect while that turn stays mounted. A per-session ChatPage remount resets it on tab switches. Live text/thinking or active tools keep the last group active even if the lifecycle snapshot lags behind them. A controlled native summary handles pointer and keyboard activation without asynchronous toggle events undoing the automatic fold.

The current shared protocol has no final-answer phase. Arbitrary text deltas do not trigger folding: the turn must be settled and its last assistant message must contain meaningful text after its final tool call. Thinking in the same final message joins the process while its answer remains outside. Completion-line extraction and the existing footer retain duration, completion time and answer-only copy behavior. Assistant content order, tool/result pairing, file previews, history anchors and scroll following remain intact without changing transcript persistence or protocol. Custom notices remain visible before or after the final reply, outside the collected process.

## Alternatives considered

- Collapse as soon as any text appears: rejected because agents emit commentary before and between tools; this hides work that is still running.
- Add provider-specific final-answer phases to the shared protocol: deferred because pi does not expose a uniform reliable marker and this UI feature does not require a protocol migration.
- Collapse each thinking/tool card independently: rejected because it leaves a long list of headers instead of one compact process entry.
- Virtualize or reparse full JSONL turns: rejected because the existing paged UI messages suffice and tool/result pairing must remain untouched.

## Verification

- `tests/conversation-turns.test.ts` covers running/settled grouping, mixed final-message blocks, tool-result pairing, duration metadata, partial history, stable keys, anchor indices, notices, unresolved/failed tools and no-final tasks.
- `tests/e2e/turn-process.spec.ts` exercises the built UI with deterministic pi/Codex WebSocket frames: completion-driven folding, keyboard reopening, early live tools, snapshot refresh, reconnect, partial-turn pagination, session isolation, long transcripts, errors and mobile-width screenshots.
- The existing mobile-history regression opens the aggregate disclosure before opening its nested thinking block and verifies both survive a history prepend.
- Final verification passes: `npm test` (415 tests), `npm run test:e2e` (33 tests), `npm run typecheck`, `npm run notes:check`, `npm run pack:check` (including build gates), `npm pack --dry-run` and `git diff --check`. The package contains 244 files and is 7.62 MiB packed by the size gate.
- Chromium automation covers mobile-width and desktop viewports; running light-mode and folded dark/reduced-motion screenshots are visually checked. Physical iOS/PWA and real upstream agent inference are not tested.

## Consequences

- Completed tasks occupy one compact process row above their answer; users can inspect all retained work without losing the final reply or notices.
- Without an explicit final-answer phase, automatic folding happens at the confirmed turn boundary rather than on the first final text token. Interim commentary cannot prematurely hide a running task.
- Error-bearing or unresolved-tool turns remain expanded even when they also contain a reply; this conservatively favors debugging visibility over compactness.
- The UI works on the already loaded page in linear time. It does not fetch the full JSONL transcript or change paging, authentication, runtime ownership or production port 3141.
- Collapsing is visual only: retained Markdown/tool components stay mounted, preserving inner disclosure state during ordinary refresh rather than introducing virtualization or discarding content.
