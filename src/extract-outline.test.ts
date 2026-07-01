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

test("parses outline JSON with global fields and section titles", () => {
  const out = parseOutline(
    'x {"restaurant":{"en":"T","zh":"露台"},"currency":"SGD","kind":"food",' +
      '"tags":[{"id":"signature","en":"Signature","zh":"招牌","icon":"⭐","group":"highlight"}],' +
      '"sections":[{"en":"Starters","zh":"前菜"},{"en":"Pasta","zh":"義麵"}]} y',
  );
  assert.equal(out.restaurant?.en, "T");
  assert.equal(out.currency, "SGD");
  assert.equal(out.tags?.[0].id, "signature");
  assert.deepEqual(out.sections.map((s) => s.en), ["Starters", "Pasta"]);
});

test("throws when sections are missing or empty", () => {
  assert.throws(() => parseOutline('{"sections":[]}'), /no sections/i);
});
