import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveOriginals, readOriginals, listSlugs, parseSlug, extOf } from "./archive.js";

const tmp = () => mkdtempSync(join(tmpdir(), "menubot-archive-"));

test("parseSlug extracts the slug from a published URL (with trailing slash and anchor)", () => {
  assert.equal(
    parseSlug("https://brianforest.github.io/menus/m/topee-restaurant-cutn9/"),
    "topee-restaurant-cutn9",
  );
  assert.equal(
    parseSlug("https://brianforest.github.io/menus/m/topee-restaurant-cutn9/#sec-0"),
    "topee-restaurant-cutn9",
  );
});

test("parseSlug accepts a bare slug and rejects junk", () => {
  assert.equal(parseSlug("  surrey-hills-y9bee "), "surrey-hills-y9bee");
  assert.equal(parseSlug("not a slug!"), null);
  assert.equal(parseSlug(""), null);
});

test("extOf maps MIME to a file extension", () => {
  assert.equal(extOf("image/jpeg"), "jpg");
  assert.equal(extOf("image/png"), "png");
  assert.equal(extOf("image/webp"), "webp");
  assert.equal(extOf("application/pdf"), "pdf");
  assert.equal(extOf("image/heic"), "jpg"); // fallback
});

test("saveOriginals + readOriginals round-trips files with correct names and bytes", () => {
  const base = tmp();
  saveOriginals(base, "rest-abc12", [
    { bytes: Buffer.from("AAA"), mime: "image/jpeg" },
    { bytes: Buffer.from("%PDF-"), mime: "application/pdf" },
  ]);
  const files = readOriginals(base, "rest-abc12");
  assert.deepEqual(files.map((f) => f.name), ["page-0.jpg", "page-1.pdf"]);
  assert.equal(files[0].bytes.toString(), "AAA");
  assert.equal(files[1].bytes.toString(), "%PDF-");
});

test("readOriginals on an absent slug returns []", () => {
  assert.deepEqual(readOriginals(tmp(), "nope-12345"), []);
});

test("saveOriginals with no sources writes nothing", () => {
  const base = tmp();
  saveOriginals(base, "empty-00000", []);
  assert.deepEqual(readOriginals(base, "empty-00000"), []);
});

test("listSlugs returns saved slugs capped at limit", () => {
  const base = tmp();
  for (const s of ["a-1", "b-2", "c-3"]) {
    saveOriginals(base, s, [{ bytes: Buffer.from("x"), mime: "image/jpeg" }]);
  }
  const slugs = listSlugs(base, 2);
  assert.equal(slugs.length, 2);
  assert.ok(slugs.every((s) => ["a-1", "b-2", "c-3"].includes(s)));
});

test("listSlugs on an absent base dir returns []", () => {
  assert.deepEqual(listSlugs(join(tmp(), "missing"), 10), []);
});
