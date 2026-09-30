# Agent Note: Mobile composer bounds and starter alignment

Status: implemented

## Problem

The iOS standalone body extends eight pixels below its viewport while standalone composer padding bypasses the measured bottom safe area. A smaller visual viewport can also leave controls below the visible keyboard boundary. New-session starter title rows inherit left alignment on mobile.

## Decision

The body has no negative bottom inset and uses the current visual viewport height. A visual-viewport resize is coalesced into one animation frame; an unchanged height causes no style write, and pinch zoom does not resize the app. Native panning remains browser-owned: no scroll listener, offsetTop compensation or translate is introduced. Root stays in normal flow, and the [existing decision to omit viewport-fit=cover](../architecture/2026-09-30-ios-standalone-top-clearance.md) remains in force.

The composer applies its capped bottom safe area once while the keyboard is closed. A focused text editor with a substantial visual-height reduction uses ordinary eight-pixel spacing instead; keyboard close and rotation recover the visible height and safe-area padding.

Mobile starter titles occupy the center column of a grid with equal seventeen-pixel side columns. The icon sits in the left column, so the text itself is centered rather than being shifted by the icon. Mobile descriptions are also centered; desktop cards keep their left alignment and existing Morphicons.

## Evidence and validation

- The pre-change Chromium reproduction with iPhone UA, standalone mode and a 390 by 844 viewport reports body, root and composer bottoms at 852 pixels. It also reports a 34-pixel safe-bottom variable but only eight pixels of actual composer padding.
- All three `tests/e2e/mobile-layout.spec.ts` Chromium flows pass: standalone control boundaries and all four starter title centers; a simulated 405-pixel keyboard viewport, native pan without style compensation, keyboard close and rotation; and desktop-to-short-mobile resize. The corrected 390 by 844 layout ends at 844 pixels and keeps the composer fully visible.
- Final integration verification passes all 25 Chromium browser flows, all 387 Node tests, TypeScript checking and the build/package gates. Browser plugin is unavailable; the existing Playwright workflow is used without dependency installation.

## Alternatives considered

- Moving the entire chat upward by a constant breaks other device heights and keyboard states.
- Restoring viewport-fit=cover reopens the separate status-bar material issue.
- Adding a second fixed toolbar duplicates layout ownership and overlay behavior.

## Consequences

- The fixed body no longer extends eight pixels below its visible boundary. The composer retains the measured or standalone fallback home-indicator inset instead of bypassing it.
- Height writes occur only on actual visible-height changes; safe-area measurement remains independent of keyboard resize events.
- A keyboard-height reduction threshold distinguishes software keyboards from ordinary browser-toolbar movement. It controls padding only; composer bounds always follow the visible height.
- Chromium can simulate viewport geometry but cannot prove iOS standalone system-bar or keyboard behavior on physical devices. Real iPhone Safari/PWA and Android keyboard acceptance remain unverified.
