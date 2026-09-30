# Agent Note: Progressive session catalog and bounded local cache

Status: implemented

## Problem

The session drawer waits for every Pi JSONL summary and the cold Codex catalog before showing any session. Returning only 300 rows does not bound the work done before the response, and a reload loses all sidebar summaries.

## Decision

The legacy `/api/sessions` array remains compatible. Requests with `limit`, `cursor` or `q` use `UISessionsPage`, returning available summaries immediately while Pi and Codex discovery runs independently in the background. The drawer requests 40 rows at a time, polls the first page every 700 ms while discovery is active, and supports scroll or explicit load-more controls. Search queries filter the complete known catalog on the server and progressively include newly discovered matches.

Pi JSONL scans run with at most 16 files in a batch and publish each completed file as a small delta. A large transcript does not delay smaller siblings. Scheduling uses known activity and timestamped filenames instead of statting every file before emitting the first row. The existing append-aware summary cache and full-list consumers remain authoritative for session and path lookup. Codex publishes each native thread page separately and refreshes beyond the previous 300-row sidebar cutoff.

`SessionCatalog` merges deltas into per-source maps without rebuilding the accumulated catalog on every file. A source's final result authoritatively reconciles additions, renames and removals. Warm summaries remain visible during refresh; source failures retain available rows, stop the scan indicator and expose retry feedback. Automatic source retries wait 15 seconds after failure; an explicit retry may bypass that delay.

## Pagination and cache boundaries

- Cursors bind to copied immutable catalog snapshots, so concurrent creation, rename or deletion cannot shift later pages. Snapshots expire after two minutes and retain at most 24 snapshots; older snapshots are also evicted when retaining another would exceed 200,000 summary rows. A single exceptionally larger catalog can exceed that row budget. Expired cursors return 409; retry discards the previous cursor chain and obtains a new first page.
- A browser caches only the first 40 summaries for 24 hours, including bounded titles and first-message previews. Cached rows do not claim a current streaming state. Transcripts and credentials are never part of this cache.
- Cache and query namespaces use a random identifier per login. Replacing the login token clears old summaries and rotates the namespace. Authorization failure and logout clear persistent summaries and session queries. A response that finishes after logout cannot persist data for the old authenticated scope.
- Storage corruption, quota limits and unavailable local storage degrade to network loading. Cached metadata remains visible while the network refresh is pending, with explicit refresh feedback.

## Alternatives considered

- Increasing the existing cache TTL leaves the first cold request blocked on all sources.
- Client-only slicing reduces DOM work but leaves server parsing and response latency unchanged.
- Publishing cumulative arrays after every batch rebuilds source maps repeatedly and creates quadratic work on large catalogs. Small deltas keep ingestion proportional to new rows.
- Sorting all paths by fresh file stats before summarizing them delays the first useful row on large or remote directories. Filename scheduling gives useful initial rows; parsed activity timestamps establish the final order.
- Offset cursors over a mutable live list silently skip or duplicate rows after concurrent mutations. Immutable snapshots make continuation explicit and recoverable.
- Persisting transcripts would expand storage and privacy scope without helping the sidebar.

## Verification

Focused catalog, cache, Pi summary, auth and native Codex tests pass (48 cases). Regressions cover unresolved cold sources, independent deltas, a large sibling transcript, immutable pagination across mutations, search beyond the first page, cursor expiry, failure backoff, bounded cache expiry, identity replacement and authorization cleanup.

All five `tests/e2e/sessions-list.spec.ts` Chromium flows pass for progressive discovery and pagination, full-catalog search, cached rendering during a pending reload, logout with a late response, recovery from an expired page cursor, partial source failures and empty search feedback. A failed or incomplete catalog does not claim that no saved sessions exist; a completed empty search explicitly reports no matching sessions.

Final integration verification passes all 394 Node tests, all 25 Chromium browser flows, TypeScript checking, all 15 Note checks and the build/package gates. Browser catalog flows use controlled responses and do not measure cold-scan latency against a user's real session archive.

## Consequences

The sidebar becomes usable before either backend has completed its full catalog and reloads can display recent summaries immediately. Background ingestion avoids cumulative-copy costs and transcript-specific stalls, while stable cursors preserve predictable paging.

A partially discovered catalog cannot establish the final global ordering until source completion. Rows may move as newer activity is discovered, and cached summaries may temporarily include a removed session during revalidation. The UI communicates active discovery and reconciles to the authoritative result when it finishes. Native catalog refresh and Pi discovery still perform background work proportional to the total number of sessions; pagination bounds response and rendering work rather than pretending that discovery is free.
