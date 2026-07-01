import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItemLexicon, normalizeMenuLexicon, type LexiconEntry } from "./lexicon.js";
import type { Menu, MenuItem } from "./types.js";

const ENTRIES: LexiconEntry[] = [
  { enTerm: "waffle", canonical: "格子鬆餅", variants: ["鬆餅華夫", "鬆餅格子餅", "鬆格餅", "窩夫", "華夫餅", "華夫"] },
  { enTerm: "flat white", canonical: "馥芮白", variants: ["平白咖啡", "馥列白"] },
];

const item = (over: Partial<MenuItem>): MenuItem => ({ en: "", zh: "", ...over });

test("en gate open: a variant in the zh name is rewritten to canonical", () => {
  const it = item({ en: "Waffle", zh: "鬆餅華夫" });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "格子鬆餅");
});

test("en gate closed: a variant-looking zh is left untouched", () => {
  const it = item({ en: "Chef Special", zh: "華夫風味" }); // en has no waffle term
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "華夫風味");
});

test("embedded term in a compound name is rewritten", () => {
  const it = item({ en: "Belgian Waffle with Berries", zh: "比利時鬆餅華夫佐莓果" });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "比利時格子鬆餅佐莓果");
});

test("longest variant wins", () => {
  const it = item({ en: "Waffle", zh: "鬆餅格子餅" });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "格子鬆餅");
});

test("miss is logged when en matches but zh is an unknown spelling", () => {
  const misses: [string, string][] = [];
  const it = item({ en: "Waffle", zh: "格仔餅" }); // 格仔餅 not a known variant
  normalizeItemLexicon(it, ENTRIES, (e, z) => misses.push([e, z]));
  assert.deepEqual(misses, [["waffle", "格仔餅"]]);
  assert.equal(it.zh, "格仔餅"); // unchanged
});

test("already-canonical: no change and no miss", () => {
  const misses: unknown[] = [];
  const it = item({ en: "Waffle", zh: "格子鬆餅" });
  normalizeItemLexicon(it, ENTRIES, (e, z) => misses.push([e, z]));
  assert.equal(it.zh, "格子鬆餅");
  assert.equal(misses.length, 0);
});

test("rewrites dzh, explain.zh, and option/choice zh of a matched item", () => {
  const it = item({
    en: "Waffle", zh: "窩夫",
    dzh: "酥脆窩夫",
    explain: { en: "waffle note", zh: "窩夫是一種鬆餅" },
    options: [{ en: "Size", zh: "窩夫尺寸", kind: "one", choices: [{ en: "Large", zh: "大窩夫", p: "" }] }],
  });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "格子鬆餅");
  assert.equal(it.dzh, "酥脆格子鬆餅");
  assert.equal(it.explain!.zh, "格子鬆餅是一種鬆餅");
  assert.equal(it.options![0].zh, "格子鬆餅尺寸");
  assert.equal(it.options![0].choices[0].zh, "大格子鬆餅");
});

test("normalizeMenuLexicon walks all items; empty entries is a no-op", () => {
  const menu: Menu = {
    sections: [{ en: "M", zh: "主餐", items: [item({ en: "Flat White", zh: "馥列白" })] }],
  };
  normalizeMenuLexicon(menu, []); // no-op
  assert.equal(menu.sections[0].items[0].zh, "馥列白");
  normalizeMenuLexicon(menu, ENTRIES);
  assert.equal(menu.sections[0].items[0].zh, "馥芮白");
});
