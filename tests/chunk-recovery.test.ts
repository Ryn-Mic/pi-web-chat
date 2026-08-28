import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverStaleChunk } from "../src/lib/chunk-recovery.ts";

test("stale chunk recovery clears caches and reloads only once per client version", async () => {
  const values = new Map<string, string>();
  const deleted: string[] = [];
  let reloads = 0;
  let now = 1_000;
  const options = {
    version: "0.1.90",
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
    caches: {
      keys: async () => ["old-precache", "old-html"],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
    },
    reload: () => {
      reloads += 1;
    },
    now: () => now,
  };

  assert.equal(await recoverStaleChunk(options), true);
  assert.deepEqual(deleted, ["old-precache", "old-html"]);
  assert.equal(reloads, 1);
  assert.equal(await recoverStaleChunk(options), false);
  assert.equal(reloads, 1);

  now += 60_000;
  assert.equal(await recoverStaleChunk(options), true, "a later deployment can recover again");
  assert.equal(reloads, 2);
});

test("stale chunk recovery refuses to reload when it cannot persist a loop guard", async () => {
  let reloads = 0;
  assert.equal(
    await recoverStaleChunk({
      version: "0.1.90",
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("storage unavailable");
        },
      },
      reload: () => {
        reloads += 1;
      },
    }),
    false,
  );
  assert.equal(reloads, 0);
});
