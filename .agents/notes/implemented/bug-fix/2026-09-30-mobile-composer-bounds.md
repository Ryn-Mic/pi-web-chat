# Agent Note: Mobile composer bounds and starter alignment

Status: implemented

## Problem

The initial Chromium reproduction showed an eight-pixel body overflow and mobile starter titles inheriting left alignment. Version 0.1.122 removed that overflow, but the user's subsequent physical iPhone screenshot still shows a large blank page when the keyboard opens. The fixed body, visual-viewport height writes, keyboard padding heuristic and translucent status-bar setting continue to interfere with native layout ownership. The exact native pan or status-bar mechanism cannot be established from the screenshot alone.

## Decision

The body uses ordinary document flow and the app uses its existing percentage-height flex layout. The viewport-lock module, its initialization and temporary settings diagnostics are removed. The app does not write visual-viewport heights, apply keyboard classes, measure safe areas or invent standalone insets. The composer keeps ordinary eight-pixel spacing and automatic text-content sizing; iOS owns keyboard resizing and focus panning.

The viewport meta uses only width=device-width and initial-scale=1, with the default Apple status-bar style. The main header's manual top padding and the file overlay's custom visual-viewport height are removed. The [existing status-bar decision](../architecture/2026-09-30-ios-standalone-top-clearance.md) records these native defaults rather than claiming that omission of viewport-fit alone proves a fix.

Mobile starter titles occupy the center column of a grid with equal seventeen-pixel side columns. The icon sits in the left column, so the text itself is centered rather than being shifted by the icon. Mobile descriptions are also centered; desktop cards keep their left alignment and existing Morphicons.

## Alternatives considered

- Keeping the visual-viewport height controller passed simulated Chromium geometry checks but failed to establish physical iPhone acceptance. Native panning and app height changes still have competing owners.
- Moving the page upward, adding another top inset or estimating keyboard height would repeat the compensations the user explicitly asks to remove.
- Reverting whole historical files would restore earlier fixed-body and negative-bottom behavior and discard unrelated starter alignment or editor work.
- Keeping black-translucent requires explicit layout under the status bar and device-specific inset handling. The default status bar and native document viewport have simpler ownership.

## Evidence and validation

- All three focused Chromium layout flows pass. Focus, blur and simulated visual-viewport resize, pan and zoom events leave app geometry, inline styles and ordinary composer padding unchanged. Actual document viewport resizing, rotation and short mobile layouts remain usable; starter titles stay centered on mobile and left-aligned on desktop.
- The built app is tested at 390 by 844, 390 by 405, 844 by 390, 1280 by 720 and 375 by 567. The starter action fills and focuses the composer, with no page errors or post-login console errors. Browser plugin is unavailable; the existing Playwright workflow is used without dependency installation.
- All 25 browser flows and all 394 Node tests pass, as do TypeScript checking, build and package gates. The package is 7.62 MiB compressed and 23.84 MiB unpacked, with 244 files; lazy viewer/editor and PWA boundaries remain enforced by the build.
- Protected port 3141 remains healthy on installed 0.1.122; this source delivery does not install, merge or restart 0.1.123. The test fixture uses isolated port 41969.

## Consequences

- The page has a single native owner for keyboard resizing and focus panning; application guesses about top, bottom and keyboard height are removed instead of being retuned.
- Ordinary visual spacing and content-based textarea sizing remain, so input behavior and desktop layout do not depend on keyboard heuristics.
- Chromium simulations do not reproduce an actual iOS keyboard or standalone status bar. Physical iPhone Safari/PWA and Android acceptance remains outstanding. The default status bar can change system chrome appearance, and native safe-area behavior may differ across OS releases; this change avoids introducing new app offsets to mask those differences.
