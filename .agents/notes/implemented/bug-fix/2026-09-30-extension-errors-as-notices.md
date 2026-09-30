# Agent Note: Extension hook failures are notices, not prompt failures

Status: implemented

## Problem

Sending a message from the web UI showed `Extension error: Cannot convert undefined or null to object`. The message came from `bindWebExtensions({ onError })`, and the wording matched a `delete` on an undefined object rather than anything the server does directly. The failing hook belonged to a user extension loaded from the agent directory: `~/.pi/agent/extensions/goal-mode.ts` ran `delete event.systemPromptOptions.sections.goal_mode`, and `sections` only exists in pi SDK 0.99 and later. The web daemon bundles `@earendil-works/pi-coding-agent` 0.80.10, whose `BuildSystemPromptOptions` has no `sections` field and whose `buildSystemPrompt` never reads one.

Two harness defects turned that non-fatal extension bug into a user-visible send failure:

- The SDK catches extension hook errors, skips the hook and continues the run, but the server forwarded them through the `error` channel. The client treats an `error` frame that arrives while a prompt is pending as a failed prompt, so the composer was released with a red failure banner even though the message had been accepted.
- The forwarded text carried only `error.error`. The extension path, hook name and stack from the SDK's `ExtensionError` were dropped, so the banner could not be traced back to a file.

## Decision

Extension hook failures are reported as notices.

`ServerEvent` gains `{ type: "notice"; message: string }`, a transient frame in the same class as `command_result`: no `seq`, never replayed, never terminal for a queued command. The client maps it to `lastNotice` — the existing dismissible neutral banner — and never to `lastError` or `markPromptFailed`.

`server/extension-errors.ts` owns the reporting vocabulary. `describeExtensionError` renders `Extension error [<name> · <hook>]: <message> (<path>)`, where the name comes from the extension entry file (`…/pi-cua-driver/index.ts` → `pi-cua-driver`, package-style `…/pi-claude-code-ui/extensions/index.ts` → `pi-claude-code-ui`) and the path is shortened against `$HOME`. `createExtensionErrorReporter` keeps per-session bookkeeping: the first occurrence of an exact `(path, hook, message)` logs the full stack, and every fiftieth repeat logs a compact counter line, so a hook that throws on every streaming delta cannot flood the daemon log. Only the first occurrence is shown to the browser.

Hooks also fire while a session is being created, before the browser socket is attached. `SessionEntry.pendingNotices` buffers those messages (capped at 20) and the bind path flushes them to the first client that attaches, so a `session_start` failure is visible instead of being silently dropped by a broadcast to zero clients.

The failing extension itself is user configuration outside this repository; its `sections` access is guarded there. This delivery does not change the bundled SDK version.

## Alternatives considered

- Keep the `error` channel and prepend the extension name. The banner would still be red and would still mark the prompt as failed, which is the actual user-visible defect.
- Add a severity field to the existing `error` event. Callers that currently mean "this run failed" would have to be audited to avoid a silent behavior change for every consumer; a separate transient event is smaller and keeps `error` meaning failure.
- Read the SDK's recorded extension errors (`resourceLoader.getExtensions().errors`) on demand instead of subscribing to `onError`. Those entries cover load failures, but hook failures are delivered only through the listener and carry the stack.
- Fix only the goal-mode extension and leave the reporting as is. It removes this instance of the symptom but leaves the next extension failure equally opaque and equally mislabeled as a send failure.
- Bump the bundled SDK to 0.99.1 in the same delivery. It separates cleanly from the reporting fix and needs its own verification; the probe and the follow-up proposal are recorded in [Align the bundled pi SDK with the installed pi CLI](../../proposed/architecture/2026-09-30-align-bundled-sdk-with-pi-cli.md).

## Evidence and validation

- Reproduced before the change against the bundled 0.80.10 SDK with the user's extension set loaded: `before_agent_start` reported `Cannot convert undefined or null to object` at `goal-mode.ts:232`, and the same script reported nothing after the extension guard.
- `tests/extension-errors.test.ts` covers name derivation, message formatting with and without a home prefix, first-occurrence logging with stack, and repeat collapse.
- `tests/chat-client.test.ts` asserts that a `notice` sets `lastNotice` while a prompt is pending and leaves `lastError`, `promptStatus` and the optimistic message untouched.
- `tests/extension-notice.test.ts` spawns the real server with an isolated `HOME`, `PI_CODING_AGENT_DIR` and a deliberately throwing `session_start` hook: exactly one notice arrives naming `boom · session_start` and the file, no `error` frame mentions it, and the daemon log carries the message with its stack.
- All 399 Node tests pass (394 before this change), as do `npm run typecheck` and `npm run build`.
- Browser acceptance for the banner itself is not covered here; the assertion stops at the WebSocket frame and the rendered banner is the existing `lastNotice` surface.

## Consequences

- A failing extension hook no longer releases the composer with a failure banner, and the banner names the extension, the hook and the file to open.
- Repeats are collapsed instead of producing one log entry and one UI update per streaming delta.
- `notice` is a new protocol member: producers, the client consumer and tests move together, and any future consumer of `ServerEvent` must tolerate a frame without `seq`.
- Buffered notices are delivered to the first client that attaches and then dropped; a second browser opening the same session later does not receive them.
- The bundled SDK remains 0.80.10 while the installed pi CLI is 0.99.1. Extensions written against newer SDK features keep loading, but the features that no longer exist on the old options object now fail silently where they used to throw — visible only through such a notice.
