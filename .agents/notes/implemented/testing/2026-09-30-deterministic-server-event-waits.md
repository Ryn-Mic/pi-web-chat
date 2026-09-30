# Agent Note: Deterministic waits and self-reporting failures in the Node suite

Status: implemented

## Problem

CI runs the whole Node suite on every push and PR, and the Release workflow runs it again before packaging, so a flaky test blocks deliveries. Three different failures hit recent runs:

- `a busy Codex thread keeps the socket open and binds once the writer conflict clears` (`tests/codex-server.test.ts`) failed on main with `expected ["settings","new","resume","copy","diff","status"], actual []`. The assertion read the command catalog with `events.find(...)` immediately after the observer snapshot arrived. Both frames travel on the same socket, so on a slower runner the catalog had simply not been processed yet: the find returned `undefined`, the fallback turned it into an empty list, and the failure looked like a wrong catalog instead of a missing frame.
- `file APIs require a session token, authorize known cwd, and reject unsafe paths` (`tests/server-files-api.test.ts`) failed twice with `401 !== 200` at its `login()` helper. The helper asserted the status, and the spawned server's stdout and stderr were piped and immediately resumed, so neither the response body nor the server's own log survived to explain the rejection.
- `new manager can query and stop a verified pre-instance daemon` and `readiness does not accept another live server's health response` (`tests/daemon-manager.test.ts`) failed on a v0.1.121 run with `build missing (dist/index.js)`. Those tests resolved the server entry next to the workspace rather than inside their own fixture, so they depended on a workspace build the test step does not perform. That one is already fixed by `6cb4312 test: isolate daemon preflight from workspace build artifacts`.

## Decision

An event that the test expects but cannot observe synchronously is awaited, and a failure carries the server's own account of itself.

The Codex observer test now waits for `command_catalog` through the shared `waitForEventUpTo` helper with a ten-second budget, so a frame that never arrives fails as `expected WebSocket event was not received` and a frame that arrives late still satisfies the assertion.

The file API test captures the spawned server's stdout and stderr into a bounded buffer (last 20 KB) and reports `exitCode`/`killed` plus the last 1.5 KB of that output when the server does not become healthy and when login is rejected. The rejection message also carries the response body, which distinguishes a wrong token from an invalid 2FA code.

No retries were added, no timeout was raised, and no assertion was weakened. The only behavioral change in the tests is how a failure is reported.

## Alternatives considered

- Retrying flaky tests. It hides the cause, makes a genuine regression look intermittent, and would have turned the Codex failure into an occasional green run with an empty catalog.
- Raising timeouts or adding sleeps. The Codex failure was not a timeout; the test never waited at all. A sleep would encode the race as timing.
- Reordering the assertions so the catalog is read after later round-trips. The read would become deterministic by accident, and the assertion would stop meaning "the catalog arrives with the observer snapshot".
- Asserting the catalog only on the socket's last frame. Same masking problem, and it would drop the check that the observer bind publishes the Codex command set.
- Allocating test ports from per-file blocks and guarding the mapping with a test. A 360-sample probe with three concurrent processes found no case of the same ephemeral port being handed to two processes within two seconds, so the collision this would prevent is not the observed cause, and the two daemon-manager failures already had a different explanation.
- Sending `connection: close` on every request in the file API test to stop a stale keep-alive socket from leaking bytes into the next response. It would isolate the transport, but it also masks a potential server-side framing defect, and it churns 45 call sites for one unexplained failure.
- Leaving the suite as is and re-running failed jobs by hand. That is what happened for the v0.1.122 and v0.1.124 deliveries, and it does not scale to a release that must be reproducible from a tag.

## Evidence and validation

- Failed CI runs inspected: `36728358794` (main, Codex catalog), `36679244660` (v0.1.122, file API test), `36669084351` (v0.1.121, daemon manager), plus `36724934853` (v0.1.124 PR, file API login) which passed only after a manual re-run.
- The Codex assertion diff and the file API parser error are quoted from those job logs; the daemon manager failure was traced to `6cb4312` in `git log`.
- `tests/codex-server.test.ts` and `tests/server-files-api.test.ts` pass in isolation after the change, and the full suite passes 399/399 twice in a row.
- `npm run typecheck`, `npm run build`, `npm run notes:check`, `npm run pack:check` and `git diff --check` pass.

## Consequences

- A server event that never arrives is reported as a timeout naming the missing frame, and a server that dies or rejects its token reports its own exit status and log instead of a bare status code.
- The unexplained `401` from `login()` is still unexplained; the next occurrence carries the response body and the server's output, which is what was missing from the two that already happened.
- The suite keeps its assertion strength: no retries, no widened tolerances, and no masked races.
- Test-only change: the shipped application behaves exactly as v0.1.125 does, and the version bump exists to keep the package, the lockfile and the release notes in step with the tag that triggers packaging.
