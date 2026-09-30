import assert from "node:assert/strict";
import test from "node:test";
import { assertAppPrecacheBudget, frontendBuildGraph, MAX_APP_PRECACHE_BYTES, selectAppPrecache, type FrontendChunk } from "../scripts/frontend-build-graph.ts";

function chunk(file: string, values: Partial<FrontendChunk> = {}): FrontendChunk {
  return { file, facadeModuleId: null, moduleIds: [], imports: [], dynamicImports: [], ...values };
}

test("PWA keeps chat static chunks even when their names or shared modules resemble viewer assets", () => {
  const chunks = [
    chunk("assets/chat.js", { facadeModuleId: "/project/index.html", imports: ["assets/file-viewer-shared.js"], dynamicImports: ["assets/full.js"], assets: ["assets/chat.css"] }),
    chunk("assets/file-viewer-shared.js", { moduleIds: ["/project/node_modules/@file-viewer/core/dist/source/precheck.js"] }),
    chunk("assets/full.js", { moduleIds: ["/project/node_modules/@file-viewer/react-full/dist/index.js"], imports: ["assets/file-viewer-shared.js", "assets/vendor.js"], dynamicImports: ["assets/renderer.js"] }),
    chunk("assets/vendor.js"),
    chunk("assets/renderer.js", { imports: ["assets/worker-loader.js"], assets: ["assets/viewer.worker.js", "assets/chat.css"] }),
    chunk("assets/worker-loader.js"),
  ];
  assert.deepEqual([...frontendBuildGraph(chunks).chatStatic], ["assets/chat.js", "assets/file-viewer-shared.js"]);
  const urls = ["index.html", ...chunks.map((item) => item.file), "file-viewer/worker.js", "assets/viewer.worker.js", "assets/chat.css"];
  assert.deepEqual(selectAppPrecache(urls.map((url) => ({ url })), chunks).map((item) => item.url), ["index.html", "assets/chat.js", "assets/file-viewer-shared.js", "assets/chat.css"]);
});

test("PWA budgets only selected assets after excluding oversized lazy viewer files", () => {
  const chunks = [
    chunk("assets/chat.js", { facadeModuleId: "/project/index.html", dynamicImports: ["assets/full.js"] }),
    chunk("assets/full.js", { moduleIds: ["/project/node_modules/@file-viewer/react-full/dist/index.js"] }),
  ];
  const manifest = selectAppPrecache([{ url: "assets/chat.js", size: 1_000_000 }, { url: "assets/full.js", size: 10_000_000 }], chunks);
  assert.equal(assertAppPrecacheBudget(manifest), 1_000_000);
  assert.throws(() => assertAppPrecacheBudget([{ url: "app.js", size: MAX_APP_PRECACHE_BYTES + 1 }]), /app precache size/);
});

test("build rejects heavy renderers statically reachable from chat", () => {
  const chunks = [
    chunk("assets/chat.js", { facadeModuleId: "/project/index.html", imports: ["assets/shared.js"] }),
    chunk("assets/shared.js", { moduleIds: ["/project/node_modules/@file-viewer/renderer-pdf/dist/index.js"] }),
  ];
  assert.throws(() => frontendBuildGraph(chunks), /heavy File Viewer modules leaked/);
});
