import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "./context.js";

const deps = (mapResult: string | null) => ({ resolveMap: async () => mapResult });

test("buildContext returns null for empty/undefined hint", async () => {
  assert.equal(await buildContext(undefined, deps(null)), null);
  assert.equal(await buildContext("   ", deps(null)), null);
});

test("buildContext uses typed text when there is no link", async () => {
  assert.equal(await buildContext("Joe's Diner, NYC", deps(null)), "Joe's Diner, NYC");
});

test("buildContext uses the resolved link and drops the raw URL from the text", async () => {
  const out = await buildContext(
    "https://maps.app.goo.gl/abc",
    deps("The Terrace at The Danna, Langkawi"),
  );
  assert.equal(out, "The Terrace at The Danna, Langkawi");
});

test("buildContext merges resolved link with extra typed text", async () => {
  const out = await buildContext(
    "fancy italian https://maps.app.goo.gl/abc",
    deps("The Terrace at The Danna, Langkawi"),
  );
  assert.equal(out, "The Terrace at The Danna, Langkawi — fancy italian");
});
