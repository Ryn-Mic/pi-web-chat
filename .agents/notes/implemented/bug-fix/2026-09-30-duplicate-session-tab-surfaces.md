# Agent Note: One message surface per session tab switch

Status: implemented

## Problem

On mobile, using the app with several sessions open showed a jumbled screen: the tab strip said one session, the message area still showed the previous one, and each session was only partly scrollable — the scrollable slice changed size between visits.

The tab strip renders one chip per open session, and the chat column renders the active session's message list plus its composer. Both carried `key={activeTabKey}` while being children of the same fragment, so React saw two siblings with the same key. React 19 resolves such a list by matching keys, and a repeated key makes nodes be inserted without their predecessor being removed: on a tab switch the new message list was appended while the previous one stayed mounted.

The consequences match the report exactly. Two `.message-list` surfaces became siblings in the same `flex-col` column, so each `flex-1` surface received only part of the column height (311 px of 844 px in the reproduction, 207 px with a third surface present), which is why only a fraction of a session was visible and scrollable and why that fraction differed between visits. The stale surface also kept rendering the previous session's messages, so the screen mixed two sessions.

Production builds do not warn about duplicate keys — the React warning is development-only — so the defect was silent in the shipped app and only visible as broken layout.

## Decision

The per-tab content is one remount boundary. `ChatPage` renders its active-tab children inside a single `<Fragment key={activeTabKey}>` and the individual `key={activeTabKey}` props on `MessageList` and `Composer` are removed, so the fragment's children are unkeyed siblings under one keyed element.

The remount semantics are unchanged: switching tabs still unmounts the whole per-session subtree and mounts a fresh one, so the message list starts at the bottom and the composer re-derives its state from the per-tab drafts, and `MessageList`'s `containerRef` reuse guard (`loadOlder` ignores a late page whose container is no longer connected) keeps working as documented.

## Alternatives considered

- Giving each child a distinct key (`messages:${activeTabKey}`, `composer:${activeTabKey}`). It removes the collision with a two-line change, but keeps two independent remount boundaries and leaves the same mistake available to the next keyed sibling added to that fragment.
- Dropping the key entirely and resetting `MessageList` state from an effect when the session key changes. The key is load-bearing: the component's scroll bookkeeping (`stickToBottom`, `pendingBottomSnap`, `previousScrollHeight`) and its documented container-reuse guard assume a fresh mount, so the effect would have to reproduce a mount precisely and would drift.
- Rendering one surface per open tab and hiding the inactive ones, which would also preserve each session's scroll position instead of resetting it. That is a larger change to how the active session is projected and is not required to fix the defect; the current design keeps one surface and remounts it.
- Upgrading React. The trigger is an application-side duplicate key, not a React defect; the same pattern is reproduced in a minimal React 19.2.7 app with the warning React emits.

## Evidence and validation

- A minimal React 19.2.7 reproduction (fragment with a keyed child plus a second sibling sharing the same key) emits "Encountered two children with the same key" and duplicates the child node on the next update; with unique keys it does not.
- The app reproduced the defect before the change in a Chromium session at 390 by 844 and at 1280 by 800: opening two sessions and clicking a tab left `.message-list` count at 2 (three after a second switch), with heights 311/311 and then 207/207/207.
- After the change the same flow reports one `.message-list` per step, full column height (621 px), the message area matching the selected tab, the composer visible, and the scroll settled at the bottom in every step; the only console noise is the login screen's expected 401.
- `tests/e2e/session-tabs.spec.ts` opens two sessions, walks the tabs (including the draft tab) and asserts one message surface, a selected tab, a visible composer and a surface taller than half the viewport. It fails on the pre-change build at the surface count and passes after the change.
- All 399 Node tests pass, as do all 26 Playwright flows (25 before this change), `npm run typecheck`, `npm run build`, `npm run notes:check` and `git diff --check`.

## Consequences

- One session surface exists at a time again, so the active session owns the full message area and the whole conversation is reachable by scrolling.
- Tab switches keep their old cost and effect: the per-session subtree remounts, which resets scroll to the newest message and rebuilds the composer from the per-tab draft store.
- Adding another element to the per-tab content no longer requires a key, and cannot reintroduce the duplicate-key collision.
- Background sessions still keep streaming independently; the web UI continues to render only the active tab's surface, which is visible as a scroll reset when switching back.
- The delivery stacks on the unmerged v0.1.123 and v0.1.124 branches; until those merge, this branch carries their commits as well.
