import { readFileSync } from "node:fs";
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
    fileViewerRenderers({ copyAssets: true, inject: false }),
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
    },
  },
});
