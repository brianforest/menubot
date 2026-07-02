import { test } from "node:test";
import assert from "node:assert/strict";
import { INTRO_SCHEMA } from "./extract-rules.js";

test("single-call schema documents l1/tier/l2 classification per section", () => {
  assert.match(INTRO_SCHEMA, /"l1"/);
  assert.match(INTRO_SCHEMA, /"tier"/);
  assert.match(INTRO_SCHEMA, /"l2"/);
  // the fixed tier vocabulary is spelled out for the model
  assert.match(INTRO_SCHEMA, /savory/);
  assert.match(INTRO_SCHEMA, /alcohol/);
});
