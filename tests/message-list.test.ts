import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyStateHero } from "../src/components/MessageList.tsx";

test("empty-session hero reflects the selected agent", () => {
  const codexMarkup = renderToStaticMarkup(
    createElement(EmptyStateHero, { agent: "codex", cwd: "/tmp/project" }),
  );
  assert.match(codexMarkup, /aria-label="Codex"/);
  assert.match(codexMarkup, />⌘<\/text>/);
  assert.doesNotMatch(codexMarkup, />π<\/text>/);

  const piMarkup = renderToStaticMarkup(
    createElement(EmptyStateHero, { agent: "pi", cwd: "/tmp/project" }),
  );
  assert.match(piMarkup, /aria-label="pi"/);
  assert.match(piMarkup, />π<\/text>/);
});
