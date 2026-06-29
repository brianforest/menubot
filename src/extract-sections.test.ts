import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSectionsResult } from "./extract-sections.js";

test("parses a worker result with sections and minted tags", () => {
  const r = parseSectionsResult(
    'ok {"sections":[{"en":"Pasta","zh":"義麵","items":[' +
      '{"en":"Pesto","zh":"青醬","p":"22","tags":["signature"],"xterm":"linguine-al-pesto"}]}],' +
      '"tags":[{"id":"signature","en":"Signature","zh":"招牌","icon":"⭐","group":"highlight"}]} end',
  );
  assert.equal(r.sections[0].en, "Pasta");
  assert.equal(r.sections[0].items[0].xterm, "linguine-al-pesto");
  assert.equal(r.tags?.[0].id, "signature");
});

test("defaults tags to [] and tolerates their absence", () => {
  const r = parseSectionsResult('{"sections":[{"en":"S","zh":"區","items":[]}]}');
  assert.deepEqual(r.tags, []);
  assert.equal(r.sections.length, 1);
});

test("throws when sections key is absent", () => {
  assert.throws(() => parseSectionsResult('{"tags":[]}'), /no sections/i);
});
