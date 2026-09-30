import assert from "node:assert/strict";
import { test } from "node:test";
import { projectLabel } from "../src/components/ProjectBadge.tsx";
import { MORPH_ICON_PATHS } from "../src/lib/morph-icons.ts";
import { setFilesDrawerOpen, setSessionsDrawerOpen } from "../src/lib/drawer.ts";
import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";
import { ja } from "../src/i18n/ja.ts";
import { ko } from "../src/i18n/ko.ts";

test("projectLabel extracts project folder basename correctly", () => {
  assert.equal(projectLabel("/Users/ryn/Documents/tmp/pi-web-chat"), "pi-web-chat");
  assert.equal(projectLabel("~/projects/awesome-ai"), "awesome-ai");
  assert.equal(projectLabel("/workspace"), "workspace");
  assert.equal(projectLabel("~"), "~");
  assert.equal(projectLabel(undefined), null);
  assert.equal(projectLabel(""), null);
});

test("newSessionDefault translation exists across all supported locales", () => {
  assert.ok(en.newSessionDefault && en.newSessionDefault.length > 0);
  assert.ok(zh.newSessionDefault && zh.newSessionDefault.length > 0);
  assert.ok(ja.newSessionDefault && ja.newSessionDefault.length > 0);
  assert.ok(ko.newSessionDefault && ko.newSessionDefault.length > 0);
  assert.ok(en.newSessionInProject && en.newSessionInProject.length > 0);
  assert.ok(zh.newSessionInProject && zh.newSessionInProject.length > 0);
  assert.ok(ja.newSessionInProject && ja.newSessionInProject.length > 0);
  assert.ok(ko.newSessionInProject && ko.newSessionInProject.length > 0);
});

test("drawer state transitions toggle open states safely", () => {
  setSessionsDrawerOpen(true);
  setFilesDrawerOpen(true);
  setSessionsDrawerOpen(false);
  setFilesDrawerOpen(false);
});

test("scroll down icon path exists in MORPH_ICON_PATHS", () => {
  assert.ok(MORPH_ICON_PATHS.arrowDown && MORPH_ICON_PATHS.arrowDown.length > 0);
  assert.ok(MORPH_ICON_PATHS.fileText && MORPH_ICON_PATHS.fileText.length > 0);
});
