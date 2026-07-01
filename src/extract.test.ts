import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromOutline } from "./extract.js";
import type { Outline, SectionsResult } from "./extract-merge.js";
import type { MenuSource } from "./types.js";

const SRC: MenuSource[] = [];
const outline = (titles: string[], complex?: boolean): Outline => ({
  sections: titles.map((t) => ({ en: t, zh: t })),
  tags: [],
  complex,
});
const sectionsResult = (titles: string[]): SectionsResult => ({
  sections: titles.map((t) => ({ en: t, zh: t, items: [{ en: t, zh: t }] })),
});

test("extractFromOutline builds a menu from the pre-computed outline", async () => {
  const menu = await extractFromOutline(outline(["A", "B"]), SRC, {
    extractSections: async (_s, _tags, titles) => sectionsResult(titles.map((t) => t.en)),
  });
  assert.deepEqual(menu.sections.map((s) => s.en), ["A", "B"]);
});

test("extractFromOutline throws when the merged section count != outline spine", async () => {
  await assert.rejects(
    () =>
      extractFromOutline(outline(["A", "B"]), SRC, {
        extractSections: async () => sectionsResult(["A"]), // only 1 of 2
      }),
    /incomplete/i,
  );
});
