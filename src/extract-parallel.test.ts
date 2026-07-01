import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMenuParallel, dispatchExtract } from "./extract.js";
import type { Outline, SectionsResult } from "./extract-merge.js";
import type { MenuSource, TagDef } from "./types.js";
import type { SectionTitle } from "./extract-partition.js";

const sources: MenuSource[] = []; // fakes ignore the bytes

const outline: Outline = {
  restaurant: { en: "T", zh: "露台" },
  currency: "SGD",
  kind: "food",
  tags: [{ id: "signature", en: "Signature", zh: "招牌", icon: "⭐", group: "highlight" }],
  sections: Array.from({ length: 10 }, (_, i) => ({ en: `S${i}`, zh: `區${i}` })),
};

test("runs one worker per partition group and merges in order", async () => {
  const seen: SectionTitle[][] = [];
  const menu = await extractMenuParallel(sources, {
    outline: async () => outline,
    extractSections: async (_s: MenuSource[], _t: TagDef[], titles: SectionTitle[]): Promise<SectionsResult> => {
      seen.push(titles);
      return { sections: titles.map((t) => ({ en: t.en, zh: t.zh, items: [{ en: `${t.en}-item`, zh: "項", tags: ["signature"] }] })) };
    },
  });
  // 10 sections / perWorker 8 -> 2 groups -> 2 worker calls
  assert.equal(seen.length, 2);
  assert.deepEqual(menu.sections.map((s) => s.en), outline.sections.map((s) => s.en));
  assert.equal(menu.restaurant?.en, "T");
  assert.equal(menu.tags?.[0].id, "signature"); // referenced by every item
});

test("rejects when a worker fails (so the dispatcher can fall back)", async () => {
  await assert.rejects(
    extractMenuParallel(sources, {
      outline: async () => outline,
      extractSections: async () => {
        throw new Error("worker boom");
      },
    }),
    /worker boom/,
  );
});

test("rejects when the outline is empty", async () => {
  await assert.rejects(
    extractMenuParallel(sources, {
      outline: async () => ({ sections: [] }) as Outline,
      extractSections: async () => ({ sections: [] }),
    }),
    /no sections|empty/i,
  );
});

// ── Fix 1: completeness guard ────────────────────────────────────────────────

test("rejects when merged section count < outline section count (completeness guard)", async () => {
  // Worker returns empty sections even though it was assigned titles.
  // mergeExtract → 0 sections; outline has 10 → guard must throw.
  await assert.rejects(
    extractMenuParallel(sources, {
      outline: async () => outline,
      extractSections: async (_s: MenuSource[], _t: TagDef[], _titles: SectionTitle[]): Promise<SectionsResult> => {
        return { sections: [] }; // worker returns nothing
      },
    }),
    /incomplete.*0\/10|0\/10.*incomplete/i,
  );
});

// ── Fix 3: dispatchExtract fallback ─────────────────────────────────────────

import type { DispatchDeps } from "./extract.js";
import type { Menu } from "./types.js";

const fakeMenu: Menu = {
  restaurant: { en: "Fallback", zh: "備用" },
  currency: "USD",
  kind: "food",
  tags: [],
  sections: [{ en: "S0", zh: "區0", items: [] }],
};

test("dispatchExtract falls back to single when parallel throws", async () => {
  let singleCalled = false;
  const deps: DispatchDeps = {
    parallel: async () => { throw new Error("parallel boom"); },
    single: async () => { singleCalled = true; return fakeMenu; },
    adaptive: async () => fakeMenu,
  };
  const result = await dispatchExtract(sources, "parallel", deps);
  assert.equal(singleCalled, true);
  assert.equal(result.restaurant?.en, "Fallback");
});

test("dispatchExtract with mode=single never calls parallel", async () => {
  let parallelCalled = false;
  const deps: DispatchDeps = {
    parallel: async () => { parallelCalled = true; return fakeMenu; },
    single: async () => fakeMenu,
    adaptive: async () => fakeMenu,
  };
  await dispatchExtract(sources, "single", deps);
  assert.equal(parallelCalled, false);
});
