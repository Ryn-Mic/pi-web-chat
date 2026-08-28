import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isProjectCollapsed,
  toggleProjectCollapsed,
} from "../src/lib/sidebar.ts";

test("sidebar project collapse and expansion toggles correctly", () => {
  const project = "test-project-" + Date.now();
  assert.equal(isProjectCollapsed(project), true, "project should start collapsed by default");
  toggleProjectCollapsed(project);
  assert.equal(isProjectCollapsed(project), false, "project should be expanded after toggle");
  toggleProjectCollapsed(project);
  assert.equal(isProjectCollapsed(project), true, "project should be collapsed again after second toggle");
});
