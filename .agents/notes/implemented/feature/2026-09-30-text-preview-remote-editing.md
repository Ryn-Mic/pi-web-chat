# Agent Note: Content-based text preview and scoped remote editing

Status: implemented

## Problem

File Viewer rejects valid UTF-8 files such as Dockerfile, Makefile, .gitignore, .mts and .lock solely by extension. Mobile failures lose the specific error category. The user also needs to edit project text files remotely.

## Decision

The preview checks bounded UTF-8 text by content and uses the existing escaped text renderer when a file's extension is unsupported or its textual document format is incomplete. PDF, Office and other binary formats retain their existing document previews. SVG remains denied on the regular preview route; its source is available through the text API without executing markup. Mobile errors retain their specific category and offer retry.

Authenticated GET/PUT `/api/files/text` is scoped to known project cwd and existing UTF-8 files up to 2 MiB. The shared protocol defines the text snapshot and save request. Mandatory SHA-256 content revisions reject stale saves with 409. Saves reject escaping paths, ignored paths, unsafe links, non-text bytes and oversized content, serialize by file path, and use a same-directory temporary file followed by atomic rename. The service rechecks identity, content revision, permissions and ownership before replacement and preserves mode, uid and gid. It does not claim preservation of ACLs or extended attributes.

The user explicitly authorizes installing the exact `monaco-editor@0.57.0` devDependency. Desktop editing dynamically imports the ESM editor API, selected basic syntax grammars and a local editor worker. It does not load TypeScript or JSON language-service workers. Model URIs include the chat workspace, cwd and path; editors, listeners and models are disposed when their owner unmounts. A visible loading state avoids switching controls while the user is typing, and failed editor initialization falls back to the native text control. Monaco chunks, CSS and worker are excluded from the chat initial graph and PWA precache.

Phones use the native text control because [Monaco's official FAQ](https://github.com/microsoft/monaco-editor#faq) states mobile browsers are unsupported. The mobile editing surface follows the visual viewport when the keyboard opens. Read-only preview iframes keep their existing capabilities and never import authentication code or receive the session bearer credential; editing runs in the trusted parent page.

Unsaved drafts stay in memory, scoped by the opaque authenticated namespace, chat workspace, cwd and path. File and chat tab close actions ask before discarding. Switching files retains the draft; binding a draft chat to a published session remaps its file drafts. A store-level beforeunload warning protects hidden drafts, and cancelled mobile Back restores exactly one overlay history entry. Logout and authentication failure clear drafts and remove this warning without another discard prompt. Conflicts retain the draft and require an explicit reload before saving. Text saves retain the original UTF-8 BOM and consistent LF, CRLF or CR line endings.

## Alternatives considered

- Expanding only the extension whitelist would continue to reject other valid source and configuration files.
- Replacing the complete viewer with Monaco would remove binary document previews and rely on an unsupported mobile editor.
- Unconditional saves could overwrite changes made by the Agent or another client.
- Passing write credentials into the preview iframe would break its isolation boundary.

## Verification

Focused Node tests pass for UTF-8 detection, binary/size rejection, unknown text fallback, path and authentication boundaries, concurrent revision conflicts, permissions and file identity rechecks, draft isolation and remapping, BOM and line endings, logout cleanup, and cancelled mobile Back.

All four `tests/e2e/file-editing.spec.ts` Chromium flows pass using an isolated project and the real file API: an actual Monaco editor opens an extensionless Dockerfile, edits and saves it; hidden drafts survive cancelled page exit and tab close; an external write triggers 409 while retaining the draft; and mobile editing uses the parent-page native control with cancelled Back and successful save/close. Existing preview and Git browser flows also pass, including active HTML/SVG isolation.

Final integration verification passes all 387 Node tests, all 25 Chromium browser flows, TypeScript checking and all 14 Note checks. Build gates confirm that the 1.32 MiB initial chat graph excludes Monaco and that PWA precache excludes editor/viewer lazy assets. Package checks and npm dry-run pass at 7.62 MiB packed and 23.84 MiB unpacked; an installable v0.1.122 tarball is generated without installing or restarting production.

## Consequences

Previously rejected source and configuration files can be previewed and edited without removing rich document previews. Conditional saves prevent overwriting a newer revision already visible to the service and preserve drafts on conflicts. Atomic rename keeps readers from observing a partially written file, but the final check and rename cannot form a filesystem transaction against unrelated external writers or guarantee durability across power loss.

The desktop editor adds a separately downloaded payload; phones keep a lightweight input and never download Monaco. Drafts are intentionally transient and are lost after an explicitly accepted page exit; the editor does not persist project contents in browser storage. Mixed newline conventions may normalize when edited. Real mobile keyboard and device behavior still require device acceptance.
