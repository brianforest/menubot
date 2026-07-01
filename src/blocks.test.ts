import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentBlocks } from "./blocks.js";
import type { MenuSource } from "./types.js";

test("single image → one image block + text block", () => {
  const blocks = buildContentBlocks([
    { kind: "image", bytes: Buffer.from("hello"), mime: "image/jpeg" },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "image");
  const img = blocks[0] as { source: { media_type: string; data: string } };
  assert.equal(img.source.media_type, "image/jpeg");
  assert.equal(img.source.data, Buffer.from("hello").toString("base64"));
  const text = blocks[1] as { type: string; text: string };
  assert.equal(text.type, "text");
  assert.match(text.text, /this menu/i);
});

test("image media type is taken from the source mime", () => {
  const blocks = buildContentBlocks([
    { kind: "image", bytes: Buffer.from("x"), mime: "image/png" },
  ]);
  const img = blocks[0] as { source: { media_type: string } };
  assert.equal(img.source.media_type, "image/png");
});

test("pdf → document block with application/pdf", () => {
  const blocks = buildContentBlocks([
    { kind: "pdf", bytes: Buffer.from("%PDF-1.7"), mime: "application/pdf" },
  ]);
  assert.equal(blocks[0].type, "document");
  const doc = blocks[0] as { source: { type: string; media_type: string; data: string } };
  assert.equal(doc.source.type, "base64");
  assert.equal(doc.source.media_type, "application/pdf");
  assert.equal(doc.source.data, Buffer.from("%PDF-1.7").toString("base64"));
});

test("multiple sources → all media blocks then one text block saying 'one menu'", () => {
  const blocks = buildContentBlocks([
    { kind: "image", bytes: Buffer.from("a"), mime: "image/jpeg" },
    { kind: "image", bytes: Buffer.from("b"), mime: "image/jpeg" },
    { kind: "pdf", bytes: Buffer.from("c"), mime: "application/pdf" },
  ]);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.map((b) => b.type), ["image", "image", "document", "text"]);
  const text = blocks[3] as { text: string };
  assert.match(text.text, /one menu/i);
});

test("a single pdf is still described as one menu (multi-page)", () => {
  const blocks = buildContentBlocks([
    { kind: "pdf", bytes: Buffer.from("c"), mime: "application/pdf" },
  ]);
  const text = blocks[1] as { text: string };
  assert.match(text.text, /one menu/i);
});

const img: MenuSource = { kind: "image", mime: "image/jpeg", bytes: Buffer.from("x") };
const textOf = (blocks: ReturnType<typeof buildContentBlocks>) => {
  const b = blocks[blocks.length - 1];
  return b.type === "text" ? b.text : "";
};

test("buildContentBlocks without context leaves the instruction unchanged", () => {
  const t = textOf(buildContentBlocks([img]));
  assert.ok(!t.includes("Restaurant context"));
});

test("buildContentBlocks appends the context line when provided", () => {
  const t = textOf(buildContentBlocks([img], "The Terrace, Langkawi"));
  assert.ok(t.includes("Restaurant context"));
  assert.ok(t.includes("The Terrace, Langkawi"));
});

test("buildContentBlocks ignores an empty/whitespace context", () => {
  const t = textOf(buildContentBlocks([img], "   "));
  assert.ok(!t.includes("Restaurant context"));
});
