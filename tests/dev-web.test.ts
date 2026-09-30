import assert from "node:assert/strict";
import test from "node:test";
import { main, devBackendPort } from "../scripts/dev-web.mjs";

test("dev web waits for the configured backend before starting Vite", async () => {
  const previous = process.env.PI_WEB_DEV_PORT;
  const events: unknown[] = [];
  try {
    await main({ PI_WEB_DEV_PORT: "3242" }, {
      waitOn: async (options: unknown) => { events.push(options); },
      createServer: async () => {
        assert.equal(process.env.PI_WEB_DEV_PORT, "3242");
        events.push("create");
        return { listen: async () => { events.push("listen"); }, printUrls: () => { events.push("urls"); } };
      },
    });
    assert.deepEqual(events, [{ resources: ["tcp:127.0.0.1:3242"], timeout: 30_000 }, "create", "listen", "urls"]);
    assert.equal(devBackendPort({}), "3141");
    assert.throws(() => devBackendPort({ PI_WEB_DEV_PORT: "65536" }), /1 and 65535/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DEV_PORT;
    else process.env.PI_WEB_DEV_PORT = previous;
  }
});
