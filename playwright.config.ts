import { defineConfig } from "@playwright/test";

const port = 41969;
const root = "/tmp/pi-web-chat-file-preview-e2e";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/fixtures/create-preview-project.mjs && node dist/index.js",
    url: `http://127.0.0.1:${port}/api/auth/status`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: `${root}/home`,
      PI_WEB_CWD: `${root}/project`,
      PI_WEB_TOKEN: "e2e-token",
      PI_WEB_2FA: "off",
      HOST: "127.0.0.1",
      PORT: String(port),
    },
  },
});
