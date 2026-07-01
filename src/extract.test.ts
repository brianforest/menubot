import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromOutline, extractMenuAdaptive, dispatchExtract } from "./extract.js";
import type { Outline, SectionsResult } from "./extract-merge.js";
import type { MenuSource } from "./types.js";
import type { Menu } from "./types.js";

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

const SINGLE: Menu = { sections: [{ en: "SINGLE", zh: "單", items: [] }] };

test("adaptive: complex outline → single, workers never run", async () => {
  let workers = 0;
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => outline(["A", "B"], true),
    extractSections: async () => {
      workers++;
      return sectionsResult(["A"]);
    },
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
  assert.equal(workers, 0);
});

test("adaptive: simple outline → parallel path, outline fetched exactly once", async () => {
  let outlineCalls = 0;
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => {
      outlineCalls++;
      return outline(["A", "B"], false);
    },
    extractSections: async (_s, _tags, titles) => sectionsResult(titles.map((t) => t.en)),
    single: async () => SINGLE,
  });
  assert.deepEqual(menu.sections.map((s) => s.en), ["A", "B"]);
  assert.equal(outlineCalls, 1);
});

test("adaptive: complex flag absent → single (fail safe)", async () => {
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => outline(["A"]), // complex undefined
    extractSections: async () => sectionsResult(["A"]),
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
});

test("adaptive: outline throws → single fallback", async () => {
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => {
      throw new Error("outline boom");
    },
    extractSections: async () => sectionsResult(["A"]),
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
});

test("adaptive: simple but parallel completeness fails → single fallback", async () => {
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => outline(["A", "B"], false),
    extractSections: async () => sectionsResult(["A"]), // 1 of 2 → mismatch → throw
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
});

test("dispatchExtract routes adaptive mode to deps.adaptive", async () => {
  let called = false;
  const menu = await dispatchExtract(SRC, "adaptive", {
    parallel: async () => {
      throw new Error("parallel should not run in adaptive mode");
    },
    single: async () => {
      throw new Error("single should not run directly in adaptive mode");
    },
    adaptive: async () => {
      called = true;
      return SINGLE;
    },
  });
  assert.equal(called, true);
  assert.equal(menu.sections[0].en, "SINGLE");
});
