// apiKey masking round-trip: masked reads, key-preserving writes, stale-mask rejection.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  maskApiKey,
  readCustomModels,
  resolveIncomingApiKey,
  writeCustomModels,
} from "../server/models-config.ts";

const dir = "/tmp/pi-mask-test";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = dir;

const file = join(dir, "models.json");
const providers = [
  { key: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-completions", apiKey: "sk-real-key-abcdefghijklmnop", models: [{ id: "gpt-4o" }] },
  { key: "envprovider", baseUrl: "https://x.example/v1", api: "openai-completions", apiKey: "$MY_ENV_KEY", models: [{ id: "m1" }] },
  { key: "short", baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "abc", models: [{ id: "m2" }] },
];
// models.json stores providers as an object keyed by provider key
const providerMap = Object.fromEntries(providers.map((p) => [p.key, p]));
const writeFixture = () => writeFileSync(file, JSON.stringify({ providers: providerMap }, null, 2), "utf8");

test("maskApiKey: first4 + ellipsis + last4, env refs and short keys untouched", () => {
  assert.equal(maskApiKey("sk-real-key-abcdefghijklmnop"), "sk-r…mnop");
  assert.equal(maskApiKey("$MY_ENV_KEY"), "$MY_ENV_KEY");
  assert.equal(maskApiKey("abc"), "••••••••");
  assert.equal(maskApiKey(undefined), undefined);
});

test("readCustomModels returns masked apiKeys", () => {
  writeFixture();
  const read = readCustomModels();
  assert.equal(read.providers[0].apiKey, "sk-r…mnop");
  assert.equal(read.providers[1].apiKey, "$MY_ENV_KEY");
  assert.equal(read.providers[2].apiKey, "••••••••");
});

test("writeCustomModels preserves the real key when the masked value is unchanged", () => {
  writeFixture();
  const [resolved] = writeCustomModels([{ ...providers[0], apiKey: "sk-r…mnop" }]);
  assert.equal(resolved.apiKey, "sk-real-key-abcdefghijklmnop");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.providers.openai.apiKey, "sk-real-key-abcdefghijklmnop");
});

test("writeCustomModels replaces with a new key and deletes on empty", () => {
  writeFixture();
  const [replaced] = writeCustomModels([{ ...providers[0], apiKey: "sk-brand-new-1234567890" }]);
  assert.equal(replaced.apiKey, "sk-brand-new-1234567890");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).providers.openai.apiKey, "sk-brand-new-1234567890");

  const [deleted] = writeCustomModels([{ ...providers[0], apiKey: "" }]);
  assert.equal(deleted.apiKey, undefined);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).providers.openai.apiKey, undefined);
});

test("writeCustomModels rejects a stale mask (e.g. provider renamed) without writing", () => {
  writeFixture();
  assert.throws(
    () => writeCustomModels([{ ...providers[0], key: "renamed", apiKey: "sk-r…mnop" }]),
    /does not match the stored key/,
  );
  assert.equal(JSON.parse(readFileSync(file, "utf8")).providers.renamed, undefined);
});

test("resolveIncomingApiKey restores masked values, passes through new values, rejects stale masks", () => {
  writeFixture();
  assert.equal(resolveIncomingApiKey("openai", "sk-r…mnop"), "sk-real-key-abcdefghijklmnop");
  assert.equal(resolveIncomingApiKey("envprovider", "$MY_ENV_KEY"), "$MY_ENV_KEY");
  assert.equal(resolveIncomingApiKey("openai", "sk-typed-new"), "sk-typed-new");
  assert.equal(resolveIncomingApiKey("nope", "sk-fresh"), "sk-fresh");
  assert.throws(() => resolveIncomingApiKey("nope", "sk-r…mnop"), /does not match the stored key/);
  assert.equal(resolveIncomingApiKey("openai", undefined), undefined);
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
