# Agent Note: Bound preview bytes to the declared response length

Status: implemented

## Problem

The v0.1.122 merge-time CI rerun fails in the file API regression after a five-byte README preview is consumed and the file grows to seven bytes. Undici receives `edHTTP/1.1 409 Conflict` instead of a valid next response. The preview stream reads appended bytes after the declared Content-Length and pollutes a persistent HTTP connection. A capability check that throws after file headers are set can also leave a file Content-Length on the caller's error response.

## Decision

Pin each authorized preview stream to the inclusive end of the byte range used to declare Content-Length. Empty streams are marked EOF immediately rather than allowing one byte through an end-zero range. Static asset metadata and streams use the same open descriptor and the same length bounds.

The shared sending helper counts streamed bytes. A short read, read error or aborted request destroys the response and connection; it cannot normally end an incomplete Content-Length response and leave that connection reusable. HEAD and empty responses close the stream without reading content. Resource ownership transfers to the stream after construction, and late read errors stay handled during descriptor cleanup.

The optional one-time capability callback runs after descriptor validation and before setting file headers. A failed check leaves the caller free to send a correctly framed JSON error. Existing authentication, cwd/path authorization, size limits, If-Match checks and Range behavior remain unchanged.

## Alternatives considered

- Rerunning CI until it passes would leave an observable production race unresolved.
- Disabling HTTP keep-alive would hide connection reuse symptoms without fixing response framing.
- Reading every preview into memory would expand memory use for files up to the existing preview size limit.

## Verification

The two deterministic growth regressions fail against the original implementation: a five-byte response includes appended contents, and an empty response reads appended contents. The fixed implementation passes all 36 focused file tests. Regressions cover concurrent growth for empty and nonempty files, a real reused HTTP socket from preview GET to a subsequent 409 response, truncation and replacement of the failed connection, static asset growth, empty descriptor closure, HEAD, failed capability headers and abort followed by a late read error. Independent diff review reports no outstanding P1/P2 findings.

Final local execution passes all 394 Node tests, all 25 Chromium browser flows, TypeScript, all 15 Note checks, build and package gates, npm pack dry-run and diff checking. The rebuilt v0.1.122 package remains 7.62 MiB packed and 23.84 MiB unpacked. This regression is added to the pending v0.1.122 delivery before its PR merge and production installation.

## Consequences

Concurrent growth cannot extend a preview response into later HTTP messages. A truncated preview fails visibly and requires retry instead of appearing to finish normally. File contents may still change during a read; this fixes response framing and does not promise an immutable snapshot against arbitrary in-place external writers. The bounded stream retains the existing memory behavior rather than buffering an entire preview.
