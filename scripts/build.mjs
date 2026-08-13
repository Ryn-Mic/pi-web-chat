#!/usr/bin/env node
/**
 * Production build for pi-web-chat package:
 *   dist/public/**  — Vite frontend
 *   dist/index.js   — bundled Node server
 */
import { execSync } from "node:child_process";
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

function toPublicPath(filePath) {
  return relative(publicDist, filePath).split(sep).join("/");
}

function assertFileViewerAssets() {
  const assetRoot = join(publicDist, "file-viewer");
  if (!existsSync(assetRoot) || !statSync(assetRoot).isDirectory()) {
    failBuild("dist/public/file-viewer missing");
  }

  const files = listFilesRecursive(assetRoot).map(toPublicPath);
  const requiredAssets = [
    {
      label: "PDF worker",
      match: (file) => /^file-viewer\/vendor\/pdf\/pdf\.worker\.mjs$/.test(file),
    },
    {
      label: "Office worker",
      match: (file) => /^file-viewer\/vendor\/(docx|pptx|xlsx)\/.*worker\.(js|mjs)$/.test(file),
    },
    {
      label: "CAD WASM",
      match: (file) => /^file-viewer\/wasm\/cad\/.*\.wasm$/.test(file),
    },
    {
      label: "generic WASM",
      match: (file) => /^file-viewer\/(vendor|wasm)\/(?!cad\/).*\.wasm$/.test(file),
    },
  ];

  for (const asset of requiredAssets) {
    const found = files.find(asset.match);
    if (!found) failBuild(`File Viewer representative asset missing: ${asset.label}`);
    console.log(`✓ File Viewer asset: ${asset.label} → ${found}`);
  }
}

function loadManifest() {
  const manifestPath = join(publicDist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    failBuild("dist/public/.vite/manifest.json missing");
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function chunkLabel(manifestEntry) {
  return [
    manifestEntry?.file,
    manifestEntry?.src,
    ...(manifestEntry?.imports ?? []),
    ...(manifestEntry?.dynamicImports ?? []),
    ...(manifestEntry?.css ?? []),
    ...(manifestEntry?.assets ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function findHtmlEntrypoints(manifest) {
  return Object.entries(manifest).filter(([key, entry]) =>
    Boolean(entry?.isEntry && (key.endsWith(".html") || entry.src?.endsWith(".html"))),
  );
}

function assertFileViewerLazy(manifest) {
  const entries = findHtmlEntrypoints(manifest);
  if (entries.length === 0) failBuild("no HTML entrypoint found in Vite manifest");

  const collectStaticGraph = (startKey, target = new Set()) => {
    if (target.has(startKey)) return target;
    const entry = manifest[startKey];
    if (!entry) failBuild(`manifest import ${startKey} missing`);
    target.add(startKey);
    for (const imported of entry.imports ?? []) collectStaticGraph(imported, target);
    return target;
  };

  const staticGraph = new Set();
  for (const [key] of entries) collectStaticGraph(key, staticGraph);

  const forbiddenPattern = /@file-viewer\/(react-full|preset-all)|react-full|preset-all/;
  const forbiddenStatic = [...staticGraph].filter((key) =>
    forbiddenPattern.test(`${key}\n${chunkLabel(manifest[key])}`),
  );
  if (forbiddenStatic.length > 0) {
    failBuild(
      `File Viewer full package leaked into static entry graph: ${forbiddenStatic.join(", ")}`,
    );
  }

  console.log("✓ File Viewer absent from static entry graph");
}

function assertThirdPartyNotices() {
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

  const assetRoot = join(publicDist, "file-viewer");
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
      failBuild(`missing embedded asset notice: dist/public/file-viewer/${rel}`);
    }
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0) {
      failBuild(`empty or invalid embedded asset notice: dist/public/file-viewer/${rel}`);
    }
    console.log(`✓ embedded asset notice: dist/public/file-viewer/${rel}`);
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log("▸ building frontend (vite)…");
execSync("npx vite build", { cwd: root, stdio: "inherit" });

assertFileViewerAssets();
assertFileViewerLazy(loadManifest());
assertThirdPartyNotices();

console.log("▸ bundling server (esbuild)…");
await esbuild.build({
  absWorkingDir: root,
  entryPoints: [join(root, "server/index.ts")],
  outfile: join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Keep runtime packages external so pi's / npm's copies resolve normally.
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

console.log("✓ build complete → dist/index.js + dist/public/");
