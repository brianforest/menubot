import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutline } from "./extract-outline.js";

test("parseOutline surfaces complex=true", () => {
  const o = parseOutline('{"sections":[{"en":"A","zh":"甲"}],"complex":true}');
  assert.equal(o.complex, true);
});

test("parseOutline surfaces complex=false", () => {
  const o = parseOutline('{"sections":[{"en":"A","zh":"甲"}],"complex":false}');
  assert.equal(o.complex, false);
});

test("parseOutline leaves complex undefined when absent", () => {
  const o = parseOutline('{"sections":[{"en":"A","zh":"甲"}]}');
  assert.equal(o.complex, undefined);
});
