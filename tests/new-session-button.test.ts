import assert from "node:assert/strict";
import { test } from "node:test";
import { projectLabel } from "../src/components/ProjectBadge.tsx";
import { MORPH_ICON_PATHS } from "../src/lib/morph-icons.ts";
import { setFilesDrawerOpen, setModalOverlayOpen, setSessionsDrawerOpen } from "../src/lib/drawer.ts";
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
  setModalOverlayOpen(true);
  setSessionsDrawerOpen(false);
  setFilesDrawerOpen(false);
  setModalOverlayOpen(false);
});

test("question navigator translations exist across all supported locales", () => {
  assert.ok(en.previousQuestion && en.previousQuestion.length > 0);
  assert.ok(zh.previousQuestion && zh.previousQuestion.length > 0);
  assert.ok(ja.previousQuestion && ja.previousQuestion.length > 0);
  assert.ok(ko.previousQuestion && ko.previousQuestion.length > 0);
  assert.ok(en.nextQuestion && en.nextQuestion.length > 0);
  assert.ok(zh.nextQuestion && zh.nextQuestion.length > 0);
  assert.ok(ja.nextQuestion && ja.nextQuestion.length > 0);
  assert.ok(ko.nextQuestion && ko.nextQuestion.length > 0);
  assert.ok(en.questionsList && en.questionsList.length > 0);
  assert.ok(zh.questionsList && zh.questionsList.length > 0);
  assert.ok(ja.questionsList && ja.questionsList.length > 0);
  assert.ok(ko.questionsList && ko.questionsList.length > 0);
});
