import { test } from "node:test";
import assert from "node:assert/strict";
import { firstJsonObject, escapeControlCharsInJson } from "./extract-json.js";

test("extracts a balanced object, ignoring surrounding prose", () => {
  assert.deepEqual(firstJsonObject('noise {"a":1} tail'), { a: 1 });
});

test("throws when there is no object", () => {
  assert.throws(() => firstJsonObject("no json here"), /did not return JSON/i);
});

test("escapeControlCharsInJson repairs raw control chars inside string values", () => {
  const bad = '{"a":"line1\nline2","b":"tab\there"}'; // raw \n and \t inside strings
  assert.throws(() => JSON.parse(bad)); // genuinely invalid as-is
  const parsed = JSON.parse(escapeControlCharsInJson(bad)) as { a: string; b: string };
  assert.equal(parsed.a, "line1\nline2");
  assert.equal(parsed.b, "tab\there");
});

test("escapeControlCharsInJson leaves formatting whitespace between tokens intact", () => {
  const ok = '{\n  "a": 1,\n  "b": "x"\n}';
  assert.deepEqual(JSON.parse(escapeControlCharsInJson(ok)), { a: 1, b: "x" });
});

test("escapeControlCharsInJson does not corrupt already-escaped sequences", () => {
  const s = '{"a":"a\\nb","b":"quote \\" here"}';
  assert.deepEqual(JSON.parse(escapeControlCharsInJson(s)), { a: "a\nb", b: 'quote " here' });
});

test("firstJsonObject parses a model blob with a stray newline inside a string", () => {
  const blob = 'Here:\n{"sections":[{"en":"S","zh":"段","note":"a\nb"}]}\nThanks';
  const obj = firstJsonObject(blob) as { sections: { note: string }[] };
  assert.equal(obj.sections[0].note, "a\nb");
});
