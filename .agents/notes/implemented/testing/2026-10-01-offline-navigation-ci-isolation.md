# Agent Note: Isolate failed navigation in the offline cache regression

Status: implemented

## Problem

PR #22 passes locally but fails its Linux Chromium regression when the rejected offline API navigation commits chrome-error://chromewebdata after the test starts navigating the same page to the app shell. The failure is an ownership race between two browser navigations, not evidence that the API became cached. Meanwhile main advances to v0.1.136, making the original v0.1.133 version metadata conflict with the already-merged UI deliveries.

## Decision

The authenticated API navigation and cache-absence assertions stay intact. The test disposes the page used for the intentionally failed offline API navigation, then opens a new page in the same browser context to verify offline app-shell loading. The six reviewed repairs are integrated with main in v0.1.137; the v0.1.134–v0.1.136 code and release notes remain intact, and v0.1.133 remains the earlier local preview rather than a downgrade of main. A replacement PR supersedes #22; remote CI success is required before merge and tag publication.

## Alternatives considered

- Sleeping or retrying the app-shell navigation on the failed page is rejected because it obscures browser ownership and makes the regression timing-dependent.
- Replacing browser navigation with a request client is rejected because a request client bypasses the service worker and cannot prove the cache boundary.
- Removing the offline negative assertion is rejected because it weakens the reviewed security regression.
- Merging the old package version over main is rejected because it discards coherent version history and can regress the already-merged UI changes.
- Pushing main or tagging an unmerged PR is rejected by the repository delivery and release policy.

## Verification

- The offline API regression still rejects offline access and finds no API data in Cache Storage. A separate page loads the precached shell.
- Both PWA tests pass five repetitions each, for 10 passing cases. The integrated full suites pass 420 Node tests and 36 Chromium tests.
- Typecheck, notes, build, package-size verification, npm pack dry-run, and diff checks pass. Package, lockfile roots, and release notes agree on 0.1.137.
- The prior UI release-note arrays are byte-equivalent after parsing, and the merge preserves their source changes instead of replacing main with the earlier preview.

## Consequences

The replacement release includes UI changes already merged into main after the local v0.1.133 preview. The extra page shares the service worker and caches but does not share the failed-navigation lifecycle. Local green tests do not substitute for remote CI; production runtime and authentication are not restarted by release preparation. Real mobile-device and shared Codex fault acceptance remain outside this Chromium regression scope.
