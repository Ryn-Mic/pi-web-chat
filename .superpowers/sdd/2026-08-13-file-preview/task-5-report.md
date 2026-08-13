# 任务 5 报告：集成 File Viewer 自托管运行时

## 变更摘要

- `vite.config.ts`：删除 `modulePreload: false`；Workbox `globIgnores` 精确改为 `["file-viewer/**", "assets/file-viewer-*.js"]`；保留 `build.manifest: true` 与 `fileViewerRenderers({ copyAssets: true, inject: false })`。
- `scripts/build.mjs`：`assertFileViewerLazy` 保留 HTML static graph forbidden 检查，删除对 lazy dynamic graph 必须发现 viewer full/preset 的要求，同时移除未使用的 `collectDynamicGraph`；static 无 viewer 时打印 `✓ File Viewer absent from static entry graph`。
- `THIRD_PARTY_NOTICES.md`：删除 `React full package` 行，仅保留官方主 repo。
- `docs/superpowers/plans/2026-08-13-file-preview.md`：任务 5 步骤 4/6 明确 static graph clean 即可，任务 5 无 consumer 不要求 dynamic chunk；任务 7 文件列表加入 `scripts/build.mjs`，步骤 5 明确接入组件后必须要求 viewer full/preset 存在于 dynamic graph、不在 static graph，并解析 sw.js/precache manifest 确认 viewer 运行时资产树与 dynamic chunk 均未 precache。
- 确认 `src/lib/file-viewer-options.ts`、`src/components/FileViewerSurface.tsx`、`tests/file-viewer-options.test.ts` 已正确，未改动。

## RED → GREEN

原始 RED：先写测试时 `createFileViewerOptions` / `FileViewerSurface` 模块不存在，运行 `node --import tsx --test tests/file-viewer-options.test.ts` 报模块解析失败。

当前 GREEN：

```text
✔ desktop options keep comfortable default and disable exfiltration operations
✔ mobile options use compact density and map supported locales
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

## 构建结果

```text
[file-viewer:vite-plugin] Copied 40/40 renderer assets to .../dist/public/file-viewer
✓ File Viewer asset: PDF worker → file-viewer/vendor/pdf/pdf.worker.mjs
✓ File Viewer asset: Office worker → file-viewer/vendor/docx/docx.worker.js
✓ File Viewer asset: CAD WASM → file-viewer/wasm/cad/0.8.0/dwfv-render.wasm
✓ File Viewer asset: generic WASM → file-viewer/vendor/libarchive/libarchive.wasm
✓ File Viewer absent from static entry graph
✓ build complete → dist/index.js + dist/public/
```

- File Viewer 解析版本：`2.2.8`
- 复制资产：`40/40`
- 四类代表资产：PDF worker、Office worker、CAD WASM、generic WASM
- Static graph clean：聊天入口未静态包含 `react-full`/`preset-all`

## 为什么 dynamic chunk 门禁移到任务 7

任务 5 仅交付 `FileViewerSurface` 与 `file-viewer-options`，没有任何真实组件（如 `FilePreviewPane`）实际调用该 surface。此时即便 lazy chunk 已存在，也无法从用户可触发的加载路径验证其正确性；提前强制要求 dynamic graph 中发现 full/preset 会引入与任务 5 实际范围不符的检查。任务 7 接入桌面多标签工作区后，`FilePreviewPane` 成为 consumer，届时才必须验证：viewer full/preset 仅存在于 dynamic graph、不在 static graph，并且 sw.js precache 未包含 viewer 运行时资产树与对应 dynamic chunk。
