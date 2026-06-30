import { test } from "node:test";
import assert from "node:assert/strict";
import { explainVersion } from "./explain-version.js";

test("explainVersion is deterministic for the same system + model", () => {
  assert.equal(explainVersion("SYS", "model-1"), explainVersion("SYS", "model-1"));
});

test("explainVersion changes when the system prompt changes", () => {
  assert.notEqual(explainVersion("SYS", "model-1"), explainVersion("SYS-edited", "model-1"));
});

test("explainVersion changes when the model changes", () => {
  assert.notEqual(explainVersion("SYS", "model-1"), explainVersion("SYS", "model-2"));
});

test("explainVersion is a short stable hex string", () => {
  const v = explainVersion("SYS", "model-1");
  assert.match(v, /^[0-9a-f]{8,16}$/);
});
