# Agent Note: Align the bundled pi SDK with the installed pi CLI

Status: proposed

## Problem

The daemon pins `@earendil-works/pi-coding-agent` 0.80.10, while the pi CLI installed on the same machine is 0.99.1 and the extensions in the agent directory are written against that newer SDK. The gap is not theoretical: `goal-mode.ts` writes `event.systemPromptOptions.sections`, a field that exists only from 0.99, so under the daemon's older SDK the hook throws on every message send and its system-prompt section never reaches the model. Extensions are shared configuration, so a user who tunes an extension against the CLI gets silent no-ops or confusing failures in the web UI.

An earlier delivery fixed the reporting of that failure and left the version drift in place ([Extension hook failures are notices, not prompt failures](../../implemented/bug-fix/2026-09-30-extension-errors-as-notices.md)).

## Proposal

Raise the pinned dependency to the version the installed CLI runs (0.99.1 at the time of writing) and verify that the harness, not just the type surface, still behaves. The probe below ran in a scratch copy (`git archive` + `npm ci`) with only that dependency changed, so nothing here is a promise about the browser surface.

Probe results on top of 0.99.1:

- `npm run typecheck` reports zero errors; 0.99.1's public exports are a strict superset of 0.80.10's, so nothing the server imports disappeared.
- All 394 Node tests pass unchanged.
- `npm run build` succeeds.
- A headless runtime prompt (real provider, `agent-router/deepseek-v4-flash`) against the user's full extension set replies correctly. The only remaining extension errors come from a TUI-only extension (`pi-claude-code-ui` theme initialization) and occur identically on both SDK versions.
- `CURRENT_SESSION_VERSION` is 3 in both versions, so existing JSONL sessions are not a format migration.

## Alternatives considered

- Stay on 0.80.10 and require extensions to be version-defensive. That pushes a harness compatibility problem onto every extension author and cannot restore features that no longer exist on the older options object.
- Freeze the daemon's extension set to its own directory instead of the shared agent directory. It isolates the version gap but also removes the extensions the user expects the web UI to run, including the goal-mode tool surface.
- Upgrade one minor version at a time. Nineteen releases of intermediate verification cost more than a single bumped-version verification, and the type surface is compatible in one step.
- Wait for the CLI and the daemon to converge by accident on a future release. Nothing schedules that, and each intervening extension gets the same silent treatment.

## Acceptance criteria

- `npm run typecheck`, `npm test`, `npm run build`, `npm run pack:check` and `git diff --check` pass with the raised dependency, and the package version, lockfile and release notes move together.
- A real browser session sends a message, streams a reply, runs at least one tool and reopens history on the new SDK.
- Under the raised SDK the goal-mode section reaches the system prompt (no extension notice for `goal-mode`) and MCP tools are registered exactly once, since 0.99.1 bundles MCP support that an installed extension also bridges.
- A session written by the 0.99.1 CLI opens in the web UI and a session written by the daemon opens in the CLI.
- The daemon restart procedure on protected port 3141 is verified after the change (`pi-web-chat 3141 restart`, health on `127.0.0.1:3141`, `lsof` listener check).

## Risks

- Nineteen minor versions of drift can change behavior in ways the Node suite does not cover; the browser and cross-surface session checks above are the mitigation and are mandatory, not optional.
- 0.99.1 declares `@earendil-works/pi-ai`, `pi-tui`, `typebox`, `chord`, `pi-codemode` and `pi-mcp` as direct dependencies at `^0.99.1`, whereas 0.80.10 pulled a smaller set; the installed tree and the peer declarations in `package.json` need to be reconciled rather than assumed.
- MCP servers may be connected twice once the SDK owns MCP natively and an extension still bridges them, inflating every request's tool list.
- Extension UI surfaces (`ExtensionUIContext`) grew between the versions, so web stubs that satisfy the old interface may silently stop matching new expectations.
- Rollback means reverting the version and rebuilding; sessions written in between stay readable because the format version is unchanged.
