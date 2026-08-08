# Project Contribution Rules

## Versioning

- Every new requirement, optimization, or bug fix must increment the patch version by one before the work is complete (for example, `0.1.60` to `0.1.61`).
- Keep the version synchronized in both `package.json` and `package-lock.json`.
- Add a concise user-facing description under the matching version key in `release-notes.json`.
- Do not reuse a version number for different changes.

## Verification

- Run `npm run typecheck` after TypeScript changes.
- Run `npm run build` before handing off a build or starting the production Web server.
