# Notable (💡) Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag every item that has a 💡 explanation with a reserved `notable` tag so the existing filter bar shows a "💡 特色 / Notable" chip that filters to those items.

**Architecture:** A pure `src/notable.ts` (`tagNotable`) mirrors `popular.ts`: strip stray `notable`, then tag items whose `explain` is set, adding `NOTABLE_TAG` once. `bot.ts` calls it after `enrichMenu`. The template excludes `notable` from the per-item displayed icons (the 💡 popover button already marks the item) while keeping it in `data-tags` so the chip filters.

**Tech Stack:** TypeScript ESM, `node:test` via `tsx`.

## Global Constraints

- ESM: import specifiers use the `.js` extension.
- `src/notable.ts` is pure (no `config`/SDK/I-O), unit-tested. No new dependencies. No `src/types.ts` changes.
- Reserved tag is exactly `{ id: "notable", en: "Notable", zh: "特色", icon: "💡", group: "highlight" }`.
- The notable stage owns the tag: strip any stray `notable` before applying.
- Tag only items whose `explain` has a non-empty `en` or `zh`.
- Template: `notable` stays in `data-tags` (filtering) but is excluded from the per-item displayed icon string (no duplicate 💡). `render.ts` unchanged.
- Branch: `feat/notable-filter` (already created; spec committed there).

---

### Task 1: Notable tagging (`notable.ts`)

**Files:**
- Create: `src/notable.ts`
- Test: `src/notable.test.ts`

**Interfaces:**
- Consumes: `Menu`, `TagDef` from `./types.js`.
- Produces: `NOTABLE_TAG: TagDef` and `tagNotable(menu: Menu): Menu`.

- [ ] **Step 1: Write the failing tests**

Create `src/notable.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tagNotable, NOTABLE_TAG } from "./notable.js";
import type { Menu } from "./types.js";

function menuOf(
  items: { en: string; explain?: { en: string; zh: string }; tags?: string[] }[],
): Menu {
  return {
    sections: [
      { en: "S", zh: "區", items: items.map((x) => ({ en: x.en, zh: x.en, explain: x.explain, tags: x.tags })) },
    ],
  };
}

test("tagNotable tags items with an explanation and adds NOTABLE_TAG once", () => {
  const menu = menuOf([
    { en: "A", explain: { en: "x", zh: "x" } },
    { en: "B" },
    { en: "C", explain: { en: "y", zh: "y" } },
  ]);
  tagNotable(menu);
  assert.deepEqual(menu.sections[0].items[0].tags, ["notable"]);
  assert.equal(menu.sections[0].items[1].tags ?? undefined, undefined);
  assert.deepEqual(menu.sections[0].items[2].tags, ["notable"]);
  assert.equal(menu.tags?.filter((t) => t.id === "notable").length, 1);
  assert.equal(menu.tags?.[0].icon, "💡");
  assert.equal(menu.tags?.[0].zh, "特色");
  assert.equal(NOTABLE_TAG.id, "notable");
});

test("tagNotable does nothing when no item has an explanation", () => {
  const menu = menuOf([{ en: "A" }, { en: "B" }]);
  tagNotable(menu);
  assert.equal(menu.tags?.some((t) => t.id === "notable") ?? false, false);
  assert.equal(menu.sections[0].items[0].tags ?? undefined, undefined);
});

test("tagNotable strips a stray pre-existing notable before applying", () => {
  const menu = menuOf([{ en: "A", explain: { en: "x", zh: "x" } }, { en: "B", tags: ["notable"] }]);
  menu.tags = [{ id: "notable", en: "x", zh: "x", icon: "💡" }];
  tagNotable(menu);
  assert.deepEqual(menu.sections[0].items[0].tags, ["notable"]); // A genuinely has explain
  assert.equal(menu.sections[0].items[1].tags?.includes("notable"), false); // B stray removed
  assert.equal(menu.tags?.filter((t) => t.id === "notable").length, 1);
});

test("tagNotable does not duplicate notable and preserves other tags", () => {
  const menu = menuOf([{ en: "A", explain: { en: "x", zh: "x" }, tags: ["vegetarian"] }]);
  tagNotable(menu);
  assert.deepEqual(menu.sections[0].items[0].tags, ["vegetarian", "notable"]);
});

test("tagNotable ignores an empty explanation object", () => {
  const menu = menuOf([{ en: "A", explain: { en: "", zh: "" } }]);
  tagNotable(menu);
  assert.equal(menu.tags?.some((t) => t.id === "notable") ?? false, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./notable.js`.

- [ ] **Step 3: Implement the module**

Create `src/notable.ts`:

```ts
import type { Menu, TagDef } from "./types.js";

/** Reserved well-known tag for items that carry a 💡 explanation (distinctive /
 *  worth-knowing dishes). Populated by tagNotable; renders the 💡 filter chip. */
export const NOTABLE_TAG: TagDef = {
  id: "notable",
  en: "Notable",
  zh: "特色",
  icon: "💡",
  group: "highlight",
};

/** Remove any `notable` tag from the menu vocabulary and from every item. */
function stripNotable(menu: Menu): void {
  menu.tags = (menu.tags ?? []).filter((t) => t.id !== "notable");
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      if (it.tags?.length) it.tags = it.tags.filter((t) => t !== "notable");
    }
  }
}

/**
 * Tag every item that has an explanation with `notable` so the 💡 "特色" filter
 * chip renders. Owns the tag end-to-end: strips any stray `notable` first. Pure;
 * mutates and returns the same menu.
 */
export function tagNotable(menu: Menu): Menu {
  stripNotable(menu);
  let any = false;
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const ex = it.explain;
      if (ex && ((ex.en && ex.en.trim()) || (ex.zh && ex.zh.trim()))) {
        it.tags = it.tags ?? [];
        if (!it.tags.includes("notable")) it.tags.push("notable");
        any = true;
      }
    }
  }
  if (any) menu.tags = [NOTABLE_TAG, ...(menu.tags ?? [])];
  return menu;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (the 5 notable tests + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/notable.ts src/notable.test.ts
git commit -m "feat(notable): tagNotable — tag 💡-explained items with the notable tag"
```

---

### Task 2: Wire bot + render the chip (`bot.ts`, template, `render.test.ts`)

**Files:**
- Modify: `src/bot.ts`
- Modify: `templates/menu.html`
- Test: `src/render.test.ts`

**Interfaces:**
- Consumes: `tagNotable` from `./notable.js` (Task 1); `MenuItem.tags`, `explain`.
- Produces: `notable` items rendered with the filter chip and no duplicate item 💡.

- [ ] **Step 1: Write the failing render test**

Append to `src/render.test.ts`:

```ts
test("renderMenu surfaces the notable tag and the template excludes it from item icons", () => {
  const html = renderMenu({
    tags: [{ id: "notable", en: "Notable", zh: "特色", icon: "💡", group: "highlight" }],
    sections: [{ en: "S", zh: "區", items: [
      { en: "A", zh: "甲", tags: ["notable"], explain: { en: "x", zh: "y" } },
    ] }],
  });
  assert.ok(html.includes('"id":"notable"'), "notable tag is in the chip vocabulary");
  assert.ok(html.includes('"tags":["notable"]'), "item keeps notable in data for filtering");
  assert.ok(html.includes('t !== "notable"'), "template excludes notable from the item icon row");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `t !== "notable"` not present in the template yet.

- [ ] **Step 3: Exclude `notable` from the item icon row (`templates/menu.html`)**

In `templates/menu.html`, find the item-icons line inside the item `.map(...)`:

```js
    const icons = ids.map(t => (TAG_BY_ID[t] && TAG_BY_ID[t].icon) || "").filter(Boolean).join(" ");
```

Replace it with (exclude `notable`, since the item already shows the 💡 popover button):

```js
    const icons = ids.filter(t => t !== "notable").map(t => (TAG_BY_ID[t] && TAG_BY_ID[t].icon) || "").filter(Boolean).join(" ");
```

(`data-tags="${esc(ids.join(" "))}"` is left unchanged — `notable` stays there so the chip filters.)

- [ ] **Step 4: Wire `tagNotable` into the bot (`src/bot.ts`)**

Add the import alongside the other enrichment imports near the top of `src/bot.ts`:

```ts
import { tagNotable } from "./notable.js";
```

In `processBatch`, immediately after the `enrichMenu` block (the `if (glossary) { … }` block that ends just before the `const name = …` / web-enrichment section), add:

```ts
    tagNotable(menu);
```

It's pure and cannot throw, so no try/catch; it runs regardless of `WEB_ENRICH`.

- [ ] **Step 5: Typecheck + run the full suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS (new render test + all existing).

- [ ] **Step 6: Commit**

```bash
git add src/bot.ts templates/menu.html src/render.test.ts
git commit -m "feat(notable): run tagNotable in the pipeline; render 💡 特色 chip"
```

---

## Self-Review (author)

**Spec coverage:**
- `notable` tag for items with `explain` → Task 1 (`tagNotable`). ✓
- Reserved NOTABLE_TAG shape (💡 / 特色 / highlight) → Task 1 + tests. ✓
- Strip stray / dedup / empty-explain guard → Task 1 + tests. ✓
- Bot wiring after enrich, runs regardless of WEB_ENRICH → Task 2 step 4. ✓
- Filter chip renders, item shows no duplicate 💡 (exclude from icons, keep in data-tags) → Task 2 step 3 + render test. ✓
- `render.ts` unchanged, no new deps/types → constraints honored. ✓

**Placeholder scan:** none — complete code + exact commands throughout.

**Type consistency:** `tagNotable(menu: Menu): Menu` and `NOTABLE_TAG: TagDef` defined in Task 1, consumed in Task 2. The render test's tag shape matches `NOTABLE_TAG`. The template edit keeps `ids`/`data-tags` semantics intact.
