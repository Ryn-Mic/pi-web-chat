#!/usr/bin/env node
/**
 * Production build for pi-web-chat package:
 *   dist/public/**  — Vite frontend
 *   dist/index.js   — bundled Node server
 *   dist/cli.js     — bundled standalone daemon CLI
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const publicDist = join(dist, "public");
const require = createRequire(import.meta.url);
const FILE_VIEWER_PACKAGES = [
  "@file-viewer/core",
  "@file-viewer/react-full",
  "@file-viewer/vite-plugin",
  "file-viewer-copy-assets",
];
const FILE_VIEWER_PACKAGED_PPT_FALLBACK_ID = "\0pi-web-chat:packaged-ppt-fallback";

function failBuild(message) {
  console.error(`build failed: ${message}`);
  process.exit(1);
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  };
  visit(dir);
  return results;
}

function toRelativePath(rootDir, filePath) {
  return relative(rootDir, filePath).split(sep).join("/");
}

function assertFileViewerPackageVersions() {
  const projectManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const runtimeVersion = projectManifest.dependencies?.["file-viewer-copy-assets"];
  if (typeof runtimeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(runtimeVersion)) {
    failBuild("file-viewer-copy-assets must be an exact direct runtime dependency");
  }
  for (const name of FILE_VIEWER_PACKAGES.filter((name) => name !== "file-viewer-copy-assets")) {
    if (projectManifest.dependencies?.[name] !== undefined) {
      failBuild(`${name} must not be a runtime dependency`);
    }
    if (projectManifest.devDependencies?.[name] !== runtimeVersion) {
      failBuild(`${name} must be an exact ${runtimeVersion} devDependency`);
    }
  }
  const declared = {
    ...projectManifest.dependencies,
    ...projectManifest.devDependencies,
  };
  const installedVersions = new Set();

  for (const name of FILE_VIEWER_PACKAGES) {
    const expected = declared[name];
    if (typeof expected !== "string" || !/^\d+\.\d+\.\d+$/.test(expected)) {
      failBuild(`${name} must use an exact version in package.json`);
    }
    const installedManifest = JSON.parse(
      readFileSync(require.resolve(`${name}/package.json`), "utf8"),
    );
    if (installedManifest.version !== expected) {
      failBuild(`${name} resolved to ${installedManifest.version}; expected ${expected}`);
    }
    installedVersions.add(installedManifest.version);
  }

  if (installedVersions.size !== 1) {
    failBuild(
      `File Viewer packages must share one version; found ${[...installedVersions].join(", ")}`,
    );
  }
  console.log(`✓ File Viewer package versions aligned at ${[...installedVersions][0]}`);
}

function assertFileViewerAssets() {
  const packageJson = require.resolve("file-viewer-copy-assets/package.json");
  const assetRoot = join(dirname(packageJson), "viewer");
  if (!existsSync(assetRoot) || !statSync(assetRoot).isDirectory()) {
    failBuild("file-viewer-copy-assets/viewer missing");
  }

  const files = listFilesRecursive(assetRoot).map((file) => toRelativePath(assetRoot, file));
  const requiredAssets = [
    {
      label: "PDF worker",
      match: (file) => /^vendor\/pdf\/pdf\.worker\.mjs$/.test(file),
    },
    {
      label: "Office worker",
      match: (file) => /^vendor\/(docx|pptx|xlsx)\/.*worker\.(js|mjs)$/.test(file),
    },
    {
      label: "CAD WASM",
      match: (file) => /^wasm\/cad\/.*\.wasm$/.test(file),
    },
    {
      label: "generic WASM",
      match: (file) => /^(vendor|wasm)\/(?!cad\/).*\.wasm$/.test(file),
    },
  ];

  for (const asset of requiredAssets) {
    const found = files.find(asset.match);
    if (!found) failBuild(`File Viewer representative asset missing: ${asset.label}`);
    console.log(`✓ File Viewer asset: ${asset.label} → ${found}`);
  }
  return assetRoot;
}

function assertFileViewerAssetsNotCopied() {
  const copiedAssetRoot = join(publicDist, "file-viewer");
  if (existsSync(copiedAssetRoot)) {
    failBuild("dist/public/file-viewer must not duplicate dependency assets");
  }
  console.log("✓ File Viewer dependency assets are not copied into dist");
}

function assertFileViewerRuntimeAssetsNotBundled(manifest) {
  const duplicateManifestEntries = Object.keys(manifest).filter((key) =>
    key.startsWith("node_modules/@file-viewer/ppt/"),
  );
  const duplicateFiles = listFilesRecursive(join(publicDist, "assets"))
    .map((file) => toRelativePath(publicDist, file))
    .filter((file) => /\/ppt-(?:font-cjk|native)-/.test(file));
  const barePptFallbackFiles = listFilesRecursive(join(publicDist, "assets"))
    .filter((file) => file.endsWith(".js"))
    .filter((file) => /["']@file-viewer\/ppt["']/.test(readFileSync(file, "utf8")))
    .map((file) => toRelativePath(publicDist, file));
  const duplicates = [
    ...duplicateManifestEntries,
    ...duplicateFiles,
    ...barePptFallbackFiles,
  ];
  if (duplicates.length > 0) {
    failBuild(`File Viewer runtime assets were bundled twice: ${duplicates.join(", ")}`);
  }
  console.log("✓ File Viewer binary-PPT runtime is served only from its dependency payload");
}

function loadManifest() {
  const manifestPath = join(publicDist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    failBuild("dist/public/.vite/manifest.json missing");
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function staticChunkLabel(key, manifestEntry) {
  return [key, manifestEntry?.file, manifestEntry?.src]
    .filter(Boolean)
    .join("\n");
}

function findHtmlEntrypoints(manifest) {
  return Object.entries(manifest).filter(([key, entry]) =>
    Boolean(entry?.isEntry && (key.endsWith(".html") || entry.src?.endsWith(".html"))),
  );
}

function collectManifestGraph(manifest, starts, edge, target = new Set()) {
  for (const startKey of starts) {
    if (target.has(startKey)) continue;
    const entry = manifest[startKey];
    if (!entry) failBuild(`manifest import ${startKey} missing`);
    target.add(startKey);
    collectManifestGraph(manifest, entry[edge] ?? [], edge, target);
  }
  return target;
}

function assertFileViewerLazy(manifest) {
  const entries = findHtmlEntrypoints(manifest);
  if (entries.length === 0) failBuild("no HTML entrypoint found in Vite manifest");

  const appEntries = entries.filter(([key, entry]) =>
    key === "index.html" || entry.src === "index.html",
  );
  if (appEntries.length !== 1) failBuild("expected exactly one chat index.html manifest entry");

  const [appKey] = appEntries[0];
  const staticGraph = collectManifestGraph(manifest, [appKey], "imports");
  const forbiddenPattern = /@file-viewer\/(react-full|preset-all)|file-viewer-(react-full|preset-all)/;
  const forbiddenStatic = [...staticGraph].filter((key) =>
    forbiddenPattern.test(staticChunkLabel(key, manifest[key])),
  );
  if (forbiddenStatic.length > 0) {
    failBuild(
      `File Viewer full package leaked into static entry graph: ${forbiddenStatic.join(", ")}`,
    );
  }

  const fullEntries = Object.entries(manifest).filter(([key, entry]) =>
    key.includes("node_modules/@file-viewer/react-full/") ||
    entry.src?.includes("node_modules/@file-viewer/react-full/"),
  );
  if (fullEntries.length !== 1) {
    failBuild(`expected one lazy @file-viewer/react-full entry, found ${fullEntries.length}`);
  }

  const [fullKey, fullEntry] = fullEntries[0];
  if (!/^assets\/file-viewer-react-full-[\w-]+\.js$/.test(fullEntry.file)) {
    failBuild(`lazy File Viewer chunk has unstable name: ${fullEntry.file}`);
  }

  // Vite may hoist FileViewerSurface into a static chunk shared by the chat
  // and iframe entries. Collect dynamic imports from that whole static closure,
  // rather than assuming the HTML entry owns the dynamic edge directly.
  const dynamicRoots = [...staticGraph].flatMap((key) => manifest[key]?.dynamicImports ?? []);
  const dynamicGraph = collectManifestGraph(manifest, dynamicRoots, "imports");
  if (!dynamicGraph.has(fullKey)) {
    failBuild("File Viewer full package is not reachable through the chat dynamic-import graph");
  }

  const viewerGraph = collectManifestGraph(manifest, [fullKey], "imports");
  const viewerDynamicGraph = collectManifestGraph(manifest, [fullKey], "dynamicImports");
  const allViewerChunks = new Set([...viewerGraph, ...viewerDynamicGraph]);
  const inventoryPath = join(publicDist, ".vite", "file-viewer-inventory.json");
  if (!existsSync(inventoryPath)) failBuild("File Viewer module inventory missing");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const hasPresetAll = inventory.chunks.some((chunk) =>
    chunk.moduleIds.some((id) => id.includes("/node_modules/@file-viewer/preset-all/")),
  );
  if (!hasPresetAll) failBuild("lazy File Viewer graph is missing the full preset");

  // A full renderer may import shared app/core chunks. Those chunks are not
  // viewer-only and can legitimately remain in the app precache; only chunks
  // absent from the chat static graph are subject to the no-precache rule.
  const exclusiveViewerChunks = [...allViewerChunks]
    .filter((key) => !staticGraph.has(key))
    .map((key) => manifest[key]?.file)
    .filter((file) => typeof file === "string" && file !== fullEntry.file);

  return {
    fullChunk: fullEntry.file,
    viewerChunks: exclusiveViewerChunks,
  };
}

function assertFrameEntryIsolated(manifest) {
  const frameEntries = findHtmlEntrypoints(manifest).filter(([key, entry]) =>
    key.endsWith("file-preview.html") || entry.src?.endsWith("file-preview.html"),
  );
  if (frameEntries.length !== 1 || !existsSync(join(publicDist, "file-preview.html"))) {
    failBuild("file-preview.html build entry missing");
  }
  const [frameKey] = frameEntries[0];
  const frameStatic = collectManifestGraph(manifest, [frameKey], "imports");
  const inventory = JSON.parse(
    readFileSync(join(publicDist, ".vite", "file-viewer-inventory.json"), "utf8"),
  );
  const moduleIds = inventory.chunks
    .filter((chunk) => [...frameStatic].some((key) => manifest[key]?.file === chunk.file))
    .flatMap((chunk) => chunk.moduleIds);
  const forbidden = moduleIds.filter((id) =>
    /src\/(main|lib\/auth|lib\/chat|components\/(AuthGate|ChatPage|Composer))|@tanstack\/react-router/.test(id),
  );
  if (forbidden.length > 0) {
    failBuild(`file preview entry imports chat/auth/router code: ${forbidden.join(", ")}`);
  }
  console.log("✓ file preview entry isolated from chat/auth/router");
}

function assertFileViewerNotPrecached({ fullChunk, viewerChunks }) {
  const swPath = join(publicDist, "sw.js");
  if (!existsSync(swPath)) failBuild("dist/public/sw.js missing");
  const serviceWorker = readFileSync(swPath, "utf8");

  if (serviceWorker.includes("file-viewer/")) {
    failBuild("File Viewer runtime assets leaked into the service-worker precache");
  }
  const emittedViewerChunks = listFilesRecursive(join(publicDist, "assets"))
    .map((file) => toRelativePath(publicDist, file))
    .filter((file) => /^assets\/file-viewer-.*\.js$/.test(file));
  const inventory = JSON.parse(
    readFileSync(join(publicDist, ".vite", "file-viewer-inventory.json"), "utf8"),
  );
  // Inventory ownership catches a viewer chunk even if its output naming
  // regresses and Workbox's file-viewer-* ignore would otherwise miss it.
  const inventoryViewerChunks = inventory.chunks
    .filter((chunk) => {
      const includesHeadless = chunk.moduleIds.some((id) =>
        id.includes("/node_modules/@file-viewer/core/dist/headless"),
      );
      return !includesHeadless && chunk.moduleIds.some(
        (id) =>
          id === FILE_VIEWER_PACKAGED_PPT_FALLBACK_ID ||
          id.includes("/node_modules/@file-viewer/"),
      );
    })
    .map((chunk) => chunk.file);
  const precachedViewerChunks = [...new Set([
    fullChunk,
    ...viewerChunks,
    ...emittedViewerChunks,
    ...inventoryViewerChunks,
  ])]
    .filter((file) => serviceWorker.includes(file));
  if (precachedViewerChunks.length > 0) {
    failBuild(
      `File Viewer lazy chunks leaked into the service-worker precache: ${precachedViewerChunks.join(", ")}`,
    );
  }

  console.log("✓ File Viewer-owned chunks are lazy and excluded from service-worker precache");
}

function assertThirdPartyNotices(assetRoot) {
  const rootLicenseDir = join(root, "third-party-licenses");
  const requiredRootFiles = [
    "Apache-2.0.txt",
    "AGPL-3.0-only.txt",
    "cad-viewer-NOTICE.txt",
    "dwf-viewer-NOTICE.txt",
    "OFL-1.1.txt",
    "LGPL-2.1.txt",
    "file-viewer-ppt-LICENSE.txt",
    "file-viewer-ppt-NOTICE.txt",
    "GPL-3.0-only.txt",
    "morphicons-MIT.txt",
    "LaoA-GrokBot-MIT.txt",
  ];

  for (const name of requiredRootFiles) {
    const filePath = join(rootLicenseDir, name);
    if (!existsSync(filePath)) failBuild(`missing root license file: third-party-licenses/${name}`);
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0) {
      failBuild(`empty or invalid root license file: third-party-licenses/${name}`);
    }
    console.log(`✓ root license file: third-party-licenses/${name}`);
  }

  const requiredAssetNotices = [
    "vendor/ppt/LICENSE",
    "vendor/ppt/NOTICE",
    "wasm/model/LICENSE.occt-import-js.txt",
    "vendor/pdf/cmaps/LICENSE",
    "vendor/drawio/LICENSE",
  ];

  for (const rel of requiredAssetNotices) {
    const filePath = join(assetRoot, rel);
    if (!existsSync(filePath)) {
      failBuild(`missing dependency asset notice: file-viewer-copy-assets/viewer/${rel}`);
    }
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0) {
      failBuild(`empty or invalid dependency asset notice: file-viewer-copy-assets/viewer/${rel}`);
    }
    console.log(`✓ dependency asset notice: file-viewer-copy-assets/viewer/${rel}`);
  }
}

function removeBuildOnlyArtifacts() {
  const inventoryPath = join(publicDist, ".vite", "file-viewer-inventory.json");
  rmSync(inventoryPath, { force: true });
  console.log("✓ removed build-only File Viewer module inventory");
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

assertFileViewerPackageVersions();

console.log("▸ building frontend (vite)…");
execSync("npx vite build", { cwd: root, stdio: "inherit" });

assertFileViewerAssetsNotCopied();
const fileViewerAssetRoot = assertFileViewerAssets();
const manifest = loadManifest();
assertFileViewerRuntimeAssetsNotBundled(manifest);
const viewerBuild = assertFileViewerLazy(manifest);
assertFrameEntryIsolated(manifest);
assertFileViewerNotPrecached(viewerBuild);
assertThirdPartyNotices(fileViewerAssetRoot);
removeBuildOnlyArtifacts();

console.log("▸ bundling server (esbuild)…");
await esbuild.build({
  absWorkingDir: root,
  entryPoints: [join(root, "server/index.ts")],
  outfile: join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Keep runtime packages external so pi's / npm's copies resolve normally.
  packages: "external",
  legalComments: "none",
  logLevel: "info",
});

console.log("▸ bundling standalone CLI (esbuild)…");
await esbuild.build({
  absWorkingDir: root,
  entryPoints: [join(root, "cli/entry.ts")],
  outfile: join(dist, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  legalComments: "none",
  logLevel: "info",
});

// Helpful marker for package consumers / debugging installs
writeFileSync(
  join(dist, "package-meta.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      entry: "index.js",
      cli: "cli.js",
      publicDir: "public",
    },
    null,
    2,
  ) + "\n",
);

if (!existsSync(join(publicDist, "index.html"))) {
  failBuild("dist/public/index.html missing");
}
if (!existsSync(join(dist, "index.js"))) {
  failBuild("dist/index.js missing");
}
if (!existsSync(join(dist, "cli.js"))) {
  failBuild("dist/cli.js missing");
}

console.log("✓ build complete → dist/index.js + dist/cli.js + dist/public/");
