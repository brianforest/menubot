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

test("salvages complete entries when the array is truncated (no closing bracket)", () => {
  // A term-rich menu can overflow the explain max_tokens, truncating the array
  // mid-object with no closing ']'. We must keep the complete entries, not drop all.
  const text = `[
    {"term":"parmigiana-di-melanzane","display_en":"Parmigiana","display_zh":"帕馬森焗茄子","explain_en":"Baked layered aubergine.","explain_zh":"焗茄子千層。","category":"dish"},
    {"term":"bruschetta","display_en":"Bruschetta","display_zh":"布魯斯凱塔","explain_en":"Grilled bread with toppings.","explain_zh":"烤麵包配料。","category":"dish"},
    {"term":"salade-nicoise","display_en":"Salade Nic`;
  const out = parseExplainResponse(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].term, "parmigiana-di-melanzane");
  assert.equal(out[1].term, "bruschetta");
  assert.equal(out[1].explain_zh, "烤麵包配料。");
});

test("salvages complete entries when a trailing object is partial", () => {
  const text = `[{"term":"laksa","display_en":"Laksa","display_zh":"叻沙","explain_en":"Spicy noodle soup.","explain_zh":"辣味麵湯。","category":"dish"},{"term":"oops`;
  const out = parseExplainResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "laksa");
});
