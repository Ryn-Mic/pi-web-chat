import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const DEV_SERVER_PORT = process.env.PI_WEB_DEV_PORT ?? "3141";
const PACKAGED_PPT_FALLBACK_ID = "\0pi-web-chat:packaged-ppt-fallback";

const fileViewerPackagedPptFallbackPlugin: Plugin = {
  name: "file-viewer-packaged-ppt-fallback",
  enforce: "pre",
  resolveId(id, importer) {
    if (id !== "@file-viewer/ppt" || !importer) return;
    const normalizedImporter = importer.replaceAll("\\", "/");
    if (
      normalizedImporter.includes("/@file-viewer/renderer-presentation/") ||
      normalizedImporter.includes("/@file-viewer+renderer-presentation@") ||
      normalizedImporter.includes("/packages/renderers/presentation/")
    ) {
      return PACKAGED_PPT_FALLBACK_ID;
    }
  },
  load(id) {
    if (id !== PACKAGED_PPT_FALLBACK_ID) return;
    return `
export async function createPptViewer() {
  throw new Error("Packaged PPT runtime URL was not initialized.")
}
`;
  },
};

const removeLegacyFileViewerAssetsPlugin: Plugin = {
  name: "remove-legacy-file-viewer-assets",
  enforce: "pre",
  configResolved(config) {
    if (!config.publicDir) return;
    const legacyAssetDir = resolve(config.publicDir, "file-viewer");
    if (!existsSync(legacyAssetDir)) return;
    const legacyManifest = resolve(legacyAssetDir, "flyfish-viewer-assets.json");
    if (!existsSync(legacyManifest)) {
      throw new Error(
        `refusing to remove unrecognized public/file-viewer directory: ${legacyAssetDir}`,
      );
    }
    rmSync(legacyAssetDir, { recursive: true, force: true });
    console.log(`removed legacy copied File Viewer assets: ${legacyAssetDir}`);
  },
};

const fileViewerInventoryPlugin: Plugin = {
  name: "file-viewer-build-inventory",
  apply: "build",
  generateBundle(_options, bundle) {
    const chunks = Object.values(bundle)
      .filter((item) => item.type === "chunk")
      .map((chunk) => ({
        file: chunk.fileName,
        facadeModuleId: chunk.facadeModuleId ?? null,
        moduleIds: Object.keys(chunk.modules),
      }));
    this.emitFile({
      type: "asset",
      fileName: ".vite/file-viewer-inventory.json",
      source: JSON.stringify({ chunks }),
    });
  },
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: {
        chat: resolve(import.meta.dirname, "index.html"),
        filePreview: resolve(import.meta.dirname, "file-preview.html"),
      },
      output: {
        // Preserve Rollup's natural lazy graph. Only change emitted names so
        // Workbox can exclude every full-viewer chunk without naming a shared
        // headless precheck chunk as viewer runtime.
        chunkFileNames(chunk) {
          const moduleIds = chunk.moduleIds;
          const includesHeadless = moduleIds.some((id) =>
            id.includes("/node_modules/@file-viewer/core/dist/headless"),
          );
          const includesViewerRuntime = moduleIds.some(
            (id) =>
              id === PACKAGED_PPT_FALLBACK_ID ||
              id.includes("/node_modules/@file-viewer/") ||
              id.includes("/node_modules/rtf.js/"),
          );
          if (includesViewerRuntime && !includesHeadless) {
            if (chunk.facadeModuleId?.includes("/node_modules/@file-viewer/react-full/")) {
              return "assets/file-viewer-react-full-[hash].js";
            }
            if (chunk.facadeModuleId?.includes("/node_modules/@file-viewer/preset-all/")) {
              return "assets/file-viewer-preset-all-[hash].js";
            }
            return "assets/file-viewer-[name]-[hash].js";
          }
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  plugins: [
    removeLegacyFileViewerAssetsPlugin,
    // Binary PPT normally loads the version-matched ESM runtime from
    // /file-viewer/vendor/ppt/. A scoped fallback stub prevents Rollup from
    // embedding a second 16 MiB font/WASM payload while failing deterministically
    // if a future caller forgets to configure the packaged runtime URL.
    fileViewerPackagedPptFallbackPlugin,
    fileViewerRenderers({ copyAssets: false, inject: false }),
    fileViewerInventoryPlugin,
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon-64.png", "apple-touch-icon.png"],
      manifest: {
        name: "pi web chat",
        short_name: "pi chat",
        description: "pi coding agent web client",
        theme_color: "#faf9f5",
        background_color: "#faf9f5",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // API/WS are not cached (only build assets are precached)
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        globPatterns: ["**/*.{js,css,html,woff2,svg,png,webmanifest}"],
        globIgnores: [
          "file-viewer/**",
          "assets/file-viewer-*.js",
        ],
        // App shell: prefer network so iOS PWAs pick up new deploys
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "pi-web-html",
              networkTimeoutSeconds: 3,
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true, // reachable from mobile devices on the same network
    proxy: {
      // Change the dev server port with PI_WEB_DEV_PORT (default 3141)
      "/api": `http://localhost:${DEV_SERVER_PORT}`,
      "/ws": { target: `ws://localhost:${DEV_SERVER_PORT}`, ws: true },
      "/file-viewer": `http://localhost:${DEV_SERVER_PORT}`,
    },
  },
});
