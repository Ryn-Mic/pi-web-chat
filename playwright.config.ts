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
      NODE_ENV: "test",
      PI_WEB_TEST_STATE_DIR: `${root}/home/.pi/web-chat`,
      PI_CODING_AGENT_DIR: `${root}/home/.pi/agent`,
      PI_CODING_AGENT_SESSION_DIR: `${root}/home/.pi/agent/sessions`,
      PI_WEB_CODEX_BIN: `${root}/fake-codex.mjs`,
      PI_WEB_CODEX_TRANSPORT: "standalone",
      PI_WEB_CWD: `${root}/project`,
      PI_WEB_TOKEN: "e2e-token",
      PI_WEB_2FA: "off",
      HOST: "127.0.0.1",
      PORT: String(port),
    },
  },
});
