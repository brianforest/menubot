import { test } from "node:test";
import assert from "node:assert/strict";
import { firstJsonObject } from "./extract-json.js";

test("extracts a balanced object, ignoring surrounding prose", () => {
  assert.deepEqual(firstJsonObject('noise {"a":1} tail'), { a: 1 });
});

test("throws when there is no object", () => {
  assert.throws(() => firstJsonObject("no json here"), /did not return JSON/i);
});
