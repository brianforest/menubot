import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExplainResponse } from "./explain-parse.js";

test("parses a JSON array of entries, tolerating surrounding prose", () => {
  const text = `Here you go:
  [
    {"term":"flat-white","display_en":"Flat White","display_zh":"馥芮白",
     "explain_en":"An espresso drink with steamed milk.","explain_zh":"濃縮咖啡加蒸奶。","category":"coffee"}
  ] done`;
  const out = parseExplainResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "flat-white");
  assert.equal(out[0].display_zh, "馥芮白");
  assert.equal(out[0].category, "coffee");
});

test("drops entries with no term and defaults missing fields to empty strings", () => {
  const text = `[{"term":"laksa"}, {"display_en":"no term"}]`;
  const out = parseExplainResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "laksa");
  assert.equal(out[0].explain_en, "");
});

test("throws when there is no JSON array", () => {
  assert.throws(() => parseExplainResponse("no array here"));
});
