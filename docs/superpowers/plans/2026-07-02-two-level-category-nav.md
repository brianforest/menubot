# Two-Level Category Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group a menu's flat sections into a two-level, tier-ordered navigation (broad L1 category → consolidated L2 sub-category with item counts), classified by the model in-extract, rendered as a sticky L1 chip bar + a two-level accordion with currency-prefixed prices.

**Architecture:** Slice A adds optional `l1`/`tier`/`l2` classification fields to `MenuSection`, emitted by both extract prompts (single `SYSTEM` and `OUTLINE_SYSTEM`) and carried through `mergeExtract` on the parallel path. Slice B does the grouping/sort/count and currency mapping as **pure, testable server-side functions**, injects the resulting nav tree into the menu template, and rewrites the template's render/interaction to draw the chip bar + accordion. The feature degrades gracefully to today's flat list when the fields are absent.

**Tech Stack:** Node.js 20+ (`node:test`), TypeScript ESM, tsx; a self-contained HTML template (`templates/menu.html`) with embedded JSON + vanilla client JS.

## Global Constraints

- TypeScript ESM — local imports use the `.js` extension.
- Tests: `node:test` + `node:assert/strict`, files named `src/*.test.ts`, run with `npm test`.
- Code comments / commit messages in English.
- Traditional-Chinese uses Taiwan wording.
- No new runtime dependencies.
- Classification fields are OPTIONAL and additive — a menu without them must render as today's flat list (graceful degradation, no feature flag).
- L1 tier order is FIXED: `savory < dessert < drink < alcohol < other`. Sections sort by tier rank, then original menu order. L2 consolidation is LLM-judged.
- Prices display with the menu's currency as a prefix (distinguish an amount from an L2 count).
- The existing dietary filter chips, language toggle, and 💡 explanation popover must keep working.

---

### Task 1: `MenuSection` classification fields + single-path `SYSTEM` prompt

**Files:**
- Modify: `src/types.ts` (add fields to `MenuSection`)
- Modify: `src/extract-rules.ts` (`INTRO_SCHEMA` section schema — the single-call prompt)
- Test: `src/extract-rules.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `MenuSection.l1?: { en: string; zh: string }`, `MenuSection.tier?: string`, `MenuSection.l2?: { en: string; zh: string }`.

- [ ] **Step 1: Add the optional fields to `MenuSection`**

In `src/types.ts`, inside `interface MenuSection` (after the `note?` / before `items`), add:

```typescript
  /** Broad L1 category for two-level nav, e.g. { en: "Alcohol", zh: "酒類" }. */
  l1?: { en: string; zh: string };
  /** L1 ordering tier: "savory" | "dessert" | "drink" | "alcohol" | "other". */
  tier?: string;
  /** L2 consolidated sub-category, e.g. { en: "Whiskey", zh: "威士忌" }. Sections
   *  sharing an (l1, l2) merge into one L2 nav node; the section's own en/zh stays
   *  the L3 sub-heading. */
  l2?: { en: string; zh: string };
```

- [ ] **Step 2: Write the failing test (single-prompt schema mentions the fields)**

Create/append `src/extract-rules.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTRO_SCHEMA } from "./extract-rules.js";

test("single-call schema documents l1/tier/l2 classification per section", () => {
  assert.match(INTRO_SCHEMA, /"l1"/);
  assert.match(INTRO_SCHEMA, /"tier"/);
  assert.match(INTRO_SCHEMA, /"l2"/);
  // the fixed tier vocabulary is spelled out for the model
  assert.match(INTRO_SCHEMA, /savory/);
  assert.match(INTRO_SCHEMA, /alcohol/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="single-call schema documents"`
Expected: FAIL — INTRO_SCHEMA has no `l1`/`tier`/`l2`.

- [ ] **Step 4: Add the fields + rules to `INTRO_SCHEMA`**

In `src/extract-rules.ts`, inside the `sections` array object schema (after the `"zh": string,` section-title line, before `"note"`), add:

```
      "l1":   { "en": string, "zh": string },       // broad menu category for this section, e.g. {"en":"Alcohol","zh":"酒類"} — group naturally for THIS menu, Taiwan wording
      "tier": string,                                // one of: "savory" | "dessert" | "drink" | "alcohol" | "other" — used to order categories
      "l2":   { "en": string, "zh": string },        // consolidated sub-category; MERGE same-type over-split sections into ONE l2 (all "Whiskey Collections – X" sections → {"en":"Whiskey","zh":"威士忌"}); a standalone section is its own l2
```

Then, at the END of `INTRO_SCHEMA` (before the closing `` ` ``), append a short rule block:

```
Category classification (l1/tier/l2) — for EVERY section:
- l1: the broad menu area (e.g. 早餐/餐點/點心/飲料/酒類 for food; or the natural
  areas of a spa/service menu). Use consistent l1 names across sections.
- tier: pick the single best of savory | dessert | drink | alcohol | other. Non-food
  menus: use "other".
- l2: the consolidated sub-category. When a menu prints many same-type sub-sections
  (e.g. Whiskey → Scotch/Bourbon/Irish/Japanese…), give them ALL the same l2
  ({"en":"Whiskey","zh":"威士忌"}) so they group into one node; keep each printed
  sub-section as its own section en/zh. A section with no finer type is its own l2.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="single-call schema documents"`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: clean; all pass (existing extract tests still pass — the fields are additive).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/extract-rules.ts src/extract-rules.test.ts
git commit -m "feat(nav): MenuSection l1/tier/l2 fields + single-prompt classification schema"
```

---

### Task 2: `OUTLINE_SYSTEM` classification + `mergeExtract` carry-through

**Files:**
- Modify: `src/extract-outline.ts` (`OUTLINE_SYSTEM` sections schema; `Outline` type carries the fields via `MenuSection`-like shape — see below)
- Modify: `src/extract-merge.ts` (`mergeExtract` copies `l1`/`tier`/`l2` from the outline spine onto merged sections)
- Test: `src/extract-merge.test.ts` (append)

**Interfaces:**
- Consumes: `MenuSection.l1/tier/l2` (Task 1).
- Produces: parallel-path merged sections carry `l1`/`tier`/`l2` copied from the outline.

- [ ] **Step 1: Extend the `Outline` section type**

In `src/extract-merge.ts`, the `Outline` interface has `sections: { en: string; zh: string }[]`. Change it to carry the classification:

```typescript
  sections: { en: string; zh: string; l1?: { en: string; zh: string }; tier?: string; l2?: { en: string; zh: string } }[];
```

- [ ] **Step 2: Write the failing merge test**

Append to `src/extract-merge.test.ts`:

```typescript
test("mergeExtract copies l1/tier/l2 from the outline spine onto merged sections", () => {
  const outline = {
    restaurant: { en: "R", zh: "餐" }, currency: "SGD", kind: "food", tags: [],
    sections: [
      { en: "Scotch", zh: "蘇格蘭", l1: { en: "Alcohol", zh: "酒類" }, tier: "alcohol", l2: { en: "Whiskey", zh: "威士忌" } },
      { en: "Bourbon", zh: "波本", l1: { en: "Alcohol", zh: "酒類" }, tier: "alcohol", l2: { en: "Whiskey", zh: "威士忌" } },
    ],
  };
  const results = [
    { sections: [{ en: "Scotch", zh: "蘇格蘭", items: [{ en: "Chivas", zh: "起瓦士", p: "37" }] }], tags: [] },
    { sections: [{ en: "Bourbon", zh: "波本", items: [{ en: "Jim Beam", zh: "金賓", p: "33" }] }], tags: [] },
  ];
  const menu = mergeExtract(outline as any, results as any);
  assert.equal(menu.sections.length, 2);
  assert.deepEqual(menu.sections[0].l1, { en: "Alcohol", zh: "酒類" });
  assert.equal(menu.sections[0].tier, "alcohol");
  assert.deepEqual(menu.sections[1].l2, { en: "Whiskey", zh: "威士忌" });
});
```

(If `extract-merge.test.ts` lacks the imports, add at the top: `import { test } from "node:test"; import assert from "node:assert/strict"; import { mergeExtract } from "./extract-merge.js";`)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="copies l1/tier/l2 from the outline"`
Expected: FAIL — merged sections have no `l1`/`tier`/`l2`.

- [ ] **Step 4: Copy the fields in `mergeExtract`**

In `src/extract-merge.ts`, after the `sections` array is built (the `const sections = dedupeWithinSections(...)` result) and BEFORE the object is returned, add a carry-through loop. The parallel path guarantees `sections.length === outline.sections.length` in the same reading order (the completeness guard enforces this), so copy by index:

```typescript
  // Carry the outline's per-section classification onto the merged sections
  // (workers return items only). Index alignment holds: sections concatenate in
  // outline group/reading order, and the count matches the outline spine.
  sections.forEach((s, i) => {
    const o = outline.sections[i];
    if (o) { s.l1 = o.l1; s.tier = o.tier; s.l2 = o.l2; }
  });
```

- [ ] **Step 5: Add the fields to `OUTLINE_SYSTEM`**

In `src/extract-outline.ts`, change the sections schema line (currently `"sections": [ { "en": string, "zh": string } ],`) to:

```
  "sections": [ { "en": string, "zh": string,
    "l1": { "en": string, "zh": string },        // broad menu category, e.g. {"en":"Alcohol","zh":"酒類"}
    "tier": string,                                // "savory" | "dessert" | "drink" | "alcohol" | "other"
    "l2": { "en": string, "zh": string } } ],      // consolidated sub-category; merge same-type sub-sections (all Whiskey → {"en":"Whiskey","zh":"威士忌"})
```

And append to the OUTLINE_SYSTEM `Rules:` block a matching line:

```
- For each section also set l1 (broad category, Taiwan wording), tier (one of
  savory|dessert|drink|alcohol|other), and l2 (consolidated sub-category — give
  same-type sub-sections like Whiskey Collections – Scotch/Bourbon the SAME l2
  {"en":"Whiskey","zh":"威士忌"} so they group into one node).
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="copies l1/tier/l2 from the outline"`
Expected: PASS.

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: clean; all pass.

- [ ] **Step 8: Commit**

```bash
git add src/extract-outline.ts src/extract-merge.ts src/extract-merge.test.ts
git commit -m "feat(nav): OUTLINE_SYSTEM classification + mergeExtract carry-through (parallel path)"
```

---

### Task 3: `currencyPrefix` — money marker for prices

**Files:**
- Modify: `src/currency.ts` (add `currencyPrefix`)
- Test: `src/currency.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `export function currencyPrefix(code: string | undefined): string` — a short prefix shown before a price, e.g. `"RM"`, `"S$"`, `"$"`; `""` when no currency.

- [ ] **Step 1: Write the failing test**

Create/append `src/currency.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { currencyPrefix } from "./currency.js";

test("currencyPrefix maps common codes to a short money marker", () => {
  assert.equal(currencyPrefix("MYR"), "RM");
  assert.equal(currencyPrefix("RM"), "RM");
  assert.equal(currencyPrefix("SGD"), "S$");
  assert.equal(currencyPrefix("USD"), "$");
  assert.equal(currencyPrefix("EUR"), "€");
  assert.equal(currencyPrefix("TWD"), "NT$");
});

test("currencyPrefix falls back to the trimmed code and handles empty", () => {
  assert.equal(currencyPrefix("XYZ"), "XYZ");
  assert.equal(currencyPrefix(""), "");
  assert.equal(currencyPrefix(undefined), "");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="currencyPrefix"`
Expected: FAIL — `currencyPrefix` is not exported.

- [ ] **Step 3: Implement `currencyPrefix` in `src/currency.ts`**

Append to `src/currency.ts`:

```typescript
/** Short money marker shown before a price (distinct from a bare count). Common
 *  codes/symbols map to a compact prefix; unknown codes pass through; empty → "". */
const CURRENCY_PREFIX: Record<string, string> = {
  RM: "RM", MYR: "RM",
  SGD: "S$",
  THB: "฿",
  IDR: "Rp",
  PHP: "₱",
  VND: "₫",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥", CNY: "¥", RMB: "¥",
  TWD: "NT$", NTD: "NT$",
  HKD: "HK$",
  KRW: "₩",
  AUD: "A$",
};

export function currencyPrefix(code: string | undefined): string {
  const key = (code ?? "").trim().toUpperCase();
  if (!key) return "";
  return CURRENCY_PREFIX[key] ?? key;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="currencyPrefix"`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: clean; all pass.

- [ ] **Step 6: Commit**

```bash
git add src/currency.ts src/currency.test.ts
git commit -m "feat(nav): currencyPrefix — short money marker for item prices"
```

---

### Task 4: `groupByCategory` — the tier-ordered L1→L2→sections tree

**Files:**
- Create: `src/category-nav.ts`
- Test: `src/category-nav.test.ts`

**Interfaces:**
- Consumes: `MenuSection` (with optional `l1`/`tier`/`l2`), from `./types.js`. Each section is assumed to already carry a stable `id` (render.ts assigns `sec-<i>` before calling this).
- Produces:
  - `interface NavL2 { l2: { en: string; zh: string }; count: number; anchor: string }`
  - `interface NavL1 { l1: { en: string; zh: string }; tier: string; anchor: string; l2s: NavL2[] }`
  - `export function groupByCategory(sections: MenuSection[]): NavL1[]`

- [ ] **Step 1: Write the failing tests**

Create `src/category-nav.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByCategory } from "./category-nav.js";
import type { MenuSection } from "./types.js";

const sec = (over: Partial<MenuSection>): MenuSection => ({ en: "", zh: "", id: "x", items: [], ...over });

const AL = { en: "Alcohol", zh: "酒類" };
const WHK = { en: "Whiskey", zh: "威士忌" };

test("orders L1 by fixed tier (savory<dessert<drink<alcohol<other), groups L2, counts items", () => {
  const sections: MenuSection[] = [
    sec({ en: "Scotch", zh: "蘇", id: "s0", l1: AL, tier: "alcohol", l2: WHK, items: [{ en: "a", zh: "" }, { en: "b", zh: "" }] }),
    sec({ en: "Bourbon", zh: "波", id: "s1", l1: AL, tier: "alcohol", l2: WHK, items: [{ en: "c", zh: "" }] }),
    sec({ en: "Cake", zh: "蛋糕", id: "s2", l1: { en: "Desserts", zh: "點心" }, tier: "dessert", l2: { en: "Cake", zh: "蛋糕" }, items: [{ en: "d", zh: "" }] }),
    sec({ en: "Pasta", zh: "麵", id: "s3", l1: { en: "Mains", zh: "餐點" }, tier: "savory", l2: { en: "Pasta", zh: "麵" }, items: [{ en: "e", zh: "" }] }),
  ];
  const nav = groupByCategory(sections);
  // tier order: savory(餐點) < dessert(點心) < alcohol(酒類)
  assert.deepEqual(nav.map((n) => n.l1.zh), ["餐點", "點心", "酒類"]);
  const al = nav.find((n) => n.l1.zh === "酒類")!;
  // the 2 whiskey sections consolidate into ONE l2 node, count = 2+1 = 3
  assert.equal(al.l2s.length, 1);
  assert.deepEqual(al.l2s[0].l2, WHK);
  assert.equal(al.l2s[0].count, 3);
  // anchors point at the first section of the group
  assert.equal(al.l2s[0].anchor, "s0");
  assert.equal(al.anchor, "s0");
});

test("sections without classification fall into an 'Other' L1 (last), each its own L2", () => {
  const sections: MenuSection[] = [
    sec({ en: "Mystery", zh: "神秘", id: "m0", items: [{ en: "x", zh: "" }] }),
    sec({ en: "Wine", zh: "酒", id: "w0", l1: AL, tier: "alcohol", l2: { en: "Wine", zh: "葡萄酒" }, items: [{ en: "y", zh: "" }] }),
  ];
  const nav = groupByCategory(sections);
  assert.equal(nav[nav.length - 1].tier, "other");
  assert.equal(nav[nav.length - 1].l2s[0].anchor, "m0");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="orders L1 by fixed tier|fall into an 'Other'"`
Expected: FAIL — `./category-nav.js` / `groupByCategory` undefined.

- [ ] **Step 3: Implement `src/category-nav.ts`**

```typescript
import type { MenuSection } from "./types.js";

export interface NavL2 {
  l2: { en: string; zh: string };
  count: number;
  anchor: string; // id of the first section in this L2 group
}
export interface NavL1 {
  l1: { en: string; zh: string };
  tier: string;
  anchor: string; // id of the first section in this L1 group
  l2s: NavL2[];
}

const TIER_RANK: Record<string, number> = {
  savory: 0, dessert: 1, drink: 2, alcohol: 3, other: 4,
};
const rankOf = (tier: string | undefined): number =>
  TIER_RANK[(tier ?? "other").toLowerCase()] ?? TIER_RANK.other;

const OTHER_L1 = { en: "Other", zh: "其他" };

/**
 * Build the tier-ordered L1 → L2 → (sections) nav tree.
 * - L1 groups are ordered by fixed tier rank, then first appearance.
 * - Within an L1, sections sharing an l2 (by zh, falling back to en) consolidate
 *   into ONE L2 node; count is the total items across the merged sections.
 * - Sections missing l1 fall into an "Other" L1 (tier "other"), each its own L2.
 * Preserves original section order for stable, menu-faithful sequencing.
 */
export function groupByCategory(sections: MenuSection[]): NavL1[] {
  const l1s: NavL1[] = [];
  const l1Index = new Map<string, NavL1>();

  for (const sec of sections) {
    const l1 = sec.l1 ?? OTHER_L1;
    const tier = sec.l1 ? (sec.tier ?? "other") : "other";
    const l1Key = l1.zh || l1.en;
    let n1 = l1Index.get(l1Key);
    if (!n1) {
      n1 = { l1, tier, anchor: sec.id ?? "", l2s: [] };
      l1Index.set(l1Key, n1);
      l1s.push(n1);
    }
    const l2 = sec.l2 ?? { en: sec.en, zh: sec.zh };
    const l2Key = l2.zh || l2.en;
    let n2 = n1.l2s.find((x) => (x.l2.zh || x.l2.en) === l2Key);
    if (!n2) {
      n2 = { l2, count: 0, anchor: sec.id ?? "" };
      n1.l2s.push(n2);
    }
    n2.count += (sec.items ?? []).length;
  }

  // Stable sort by tier rank; equal ranks keep insertion (first-appearance) order.
  return l1s
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rankOf(a.n.tier) - rankOf(b.n.tier) || a.i - b.i)
    .map((x) => x.n);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="orders L1 by fixed tier|fall into an 'Other'"`
Expected: PASS (both).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: clean; all pass.

- [ ] **Step 6: Commit**

```bash
git add src/category-nav.ts src/category-nav.test.ts
git commit -m "feat(nav): groupByCategory — tier-ordered L1/L2 tree with counts"
```

---

### Task 5: Inject nav tree + currency into `render.ts`

**Files:**
- Modify: `src/render.ts`
- Modify: `templates/menu.html` (add two placeholders; template render is Task 6)
- Test: `src/render.test.ts` (append)

**Interfaces:**
- Consumes: `groupByCategory` (Task 4), `currencyPrefix` (Task 3).
- Produces: the rendered HTML embeds `const NAV = <NavL1[]>;` and `const CUR = "<prefix>";` for the template to consume (in addition to the existing `MENU`/`TAGS`).

- [ ] **Step 1: Write the failing test**

Append to `src/render.test.ts` (reuse its existing imports; it already imports `renderMenu` and builds a `Menu`):

```typescript
test("renderMenu injects the NAV tree and the currency prefix", () => {
  const html = renderMenu({
    currency: "MYR",
    sections: [
      { en: "Scotch", zh: "蘇", l1: { en: "Alcohol", zh: "酒類" }, tier: "alcohol", l2: { en: "Whiskey", zh: "威士忌" },
        items: [{ en: "Chivas", zh: "起瓦士", p: "37" }] },
    ],
  } as any);
  assert.match(html, /const NAV = \[/);      // nav tree injected
  assert.match(html, /"威士忌"/);              // the L2 label is present in NAV
  assert.match(html, /const CUR = "RM"/);     // MYR -> RM prefix injected
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="injects the NAV tree"`
Expected: FAIL — no `NAV`/`CUR` in output.

- [ ] **Step 3: Add the placeholders to the template**

In `templates/menu.html`, find the line `const TAGS = {{TAGS_JSON}};` and add two lines immediately after it:

```javascript
const NAV = {{NAV_JSON}};
const CUR = "{{CURRENCY_PREFIX}}";
```

- [ ] **Step 4: Wire `render.ts` to compute and inject them**

In `src/render.ts`:
1. Add imports near the top:

```typescript
import { groupByCategory } from "./category-nav.js";
import { currencyPrefix } from "./currency.js";
```

2. In `renderMenu`, after the `sections` array (with ids) is built and before the `return TEMPLATE.replace(...)` chain, compute:

```typescript
  const nav = groupByCategory(sections);
  const curPrefix = currencyPrefix(menu.currency);
```

3. Extend the replace chain (add two `.replace(...)` calls before the final one):

```typescript
    .replace("{{NAV_JSON}}", JSON.stringify(nav))
    .replace("{{CURRENCY_PREFIX}}", escapeHtml(curPrefix))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="injects the NAV tree"`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: clean; all pass; build OK.

- [ ] **Step 7: Commit**

```bash
git add src/render.ts templates/menu.html src/render.test.ts
git commit -m "feat(nav): inject NAV tree + currency prefix into the menu template"
```

---

### Task 6: Template — sticky L1 chips + two-level accordion + currency-prefixed prices

**Files:**
- Modify: `templates/menu.html` (CSS + the render/interaction client JS)
- Test: `src/render.test.ts` (append string-level assertions)

**Interfaces:**
- Consumes: `NAV` (Task 5, `NavL1[]`), `CUR` (Task 5, currency prefix string), `MENU` (sections with `id`, `l1`, `l2`), all already embedded.

**Context:** The template currently builds a flat `#nav` (`<a>` per section) and renders each section flat under `#menu`, with bare prices (`it.p`). This task replaces the flat `#nav` build with the sticky L1 chip bar, groups the `#menu` render into a two-level accordion using `NAV` + `MENU`, and prefixes prices with `CUR`. The dietary filter, language toggle, and 💡 popover stay intact.

- [ ] **Step 1: Write the failing test (structure + currency-prefixed price)**

Append to `src/render.test.ts`:

```typescript
test("template renders L1 category chips, an accordion, and currency-prefixed prices", () => {
  const html = renderMenu({
    currency: "MYR",
    sections: [
      { en: "Scotch", zh: "蘇", l1: { en: "Alcohol", zh: "酒類" }, tier: "alcohol", l2: { en: "Whiskey", zh: "威士忌" },
        items: [{ en: "Chivas", zh: "起瓦士", p: "37" }] },
    ],
  } as any);
  assert.match(html, /class="l1chip"/);   // sticky L1 category chip element
  assert.match(html, /class="acc/);        // accordion container class
  // price prefixed by CUR at render time — the client concatenates CUR + it.p;
  // assert the mechanism is present (CUR used in the price template)
  assert.match(html, /CUR\s*\+\s*esc\(it\.p\)|\$\{CUR\}\$\{esc\(it\.p\)\}/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="template renders L1 category chips"`
Expected: FAIL — no `l1chip`/`acc`/CUR-price in the template.

- [ ] **Step 3: Add CSS for the chip bar + accordion**

In `templates/menu.html`, inside the `<style>` block, after the existing `.nav` rules, add:

```css
  .l1bar { display: flex; gap: 8px; overflow-x: auto; padding: 8px 14px 4px; scrollbar-width: none; -ms-overflow-style: none; }
  .l1bar::-webkit-scrollbar { display: none; }
  .l1chip { flex: 0 0 auto; font: inherit; font-size: 15px; font-weight: 600; border: 1px solid var(--accent);
    background: #fff; color: var(--accent); border-radius: 999px; padding: 5px 13px; cursor: pointer; white-space: nowrap; }
  .l1chip.active { background: var(--accent); color: #fff; }
  .acc-l1 { margin: 0 0 6px; }
  .acc-l1 > .acc-l1-head { font-weight: 700; color: var(--accent); font-size: clamp(18px,5vw,22px);
    padding: 10px 0 6px; border-bottom: 2px solid var(--ink); cursor: pointer; display: flex; justify-content: space-between; }
  .acc-l1-head .car { transition: transform .15s; }
  .acc-l1.collapsed .acc-l1-body { display: none; }
  .acc-l1.collapsed .car { transform: rotate(-90deg); }
  .acc-l2 { display: flex; justify-content: space-between; align-items: center; padding: 9px 4px; border-bottom: 1px solid var(--accent-soft); cursor: pointer; }
  .acc-l2 .l2name { font-weight: 600; }
  .acc-l2 .l2cnt { color: var(--accent); background: var(--accent-soft); border-radius: 10px; padding: 1px 9px; font-size: 13px; }
  body.lang-zh .acc-l2 .n-en, body.lang-zh .l1chip .c-en { display: none; }
  body.lang-en .acc-l2 .n-zh, body.lang-en .l1chip .c-zh { display: none; }
```

- [ ] **Step 4a: Swap the sticky nav element + variable**

In `templates/menu.html`, replace `<nav class="nav" id="nav" aria-label="sections"></nav>` with:

```html
  <div class="l1bar" id="l1bar" role="group" aria-label="categories"></div>
```

Replace `const navEl = document.getElementById("nav");` with:

```javascript
const l1barEl = document.getElementById("l1bar");
```

- [ ] **Step 4b: Refactor the existing section render into a `sectionHtml(sec)` — PRESERVE its markup verbatim, changing ONLY the price**

The current `MENU.forEach((sec, i) => { ... });` block builds each item's HTML inline and appends a `<section>` per menu section (and also builds the old flat nav). **Do not rewrite the item markup from memory — move the existing code, unchanged, into a function.** Concretely:

1. Cut the existing per-section body that produces the `<section id="…">…</section>` string (everything the current loop passes to `menuEl.insertAdjacentHTML("beforeend", …)`), and wrap it in `function sectionHtml(sec) { … return \`<section …>…</section>\`; }`, keeping every existing class name, item field, options/explain/desc/image markup exactly as-is.
2. Inside that moved code, make the ONLY content change: prefix the currency on prices. Change the item price interpolation from `<div class="price">${esc(it.p)}</div>` to `<div class="price">${CUR}${esc(it.p)}</div>`, and any option price `+${esc(c.p)}` to `+${CUR}${esc(c.p)}` (match the exact strings in the file).
3. Delete the old flat-nav line (`navEl.insertAdjacentHTML("beforeend", \`<a href="#${esc(id)}" …>\`)`) — the L1 chips replace it.
4. Delete the old `menuEl.insertAdjacentHTML(...)` call and the surrounding `MENU.forEach(...)` wrapper — the accordion driver below now owns appending to `#menu`. Keep the `id` assignment behavior: give each section a stable id (the existing loop used `sec-${i}`); ensure `sectionHtml` receives sections that already carry `.id` (render.ts sets `sec.id` server-side, so `sec.id` is present).

- [ ] **Step 4c: Add the accordion driver + L1 chips (new code, after `sectionHtml`)**

```javascript
// Accordion: for each L1 (NAV order) a collapsible block; inside, each L2 is a
// tappable row (with count) followed by its L3 sections. Single-L2 L1s skip the
// L2 row. First L1 expanded, the rest collapsed. Sections are matched to their
// (l1,l2) group by the same keys groupByCategory used (zh, falling back to en).
const l1KeyOf = (s) => (s.l1 && (s.l1.zh || s.l1.en)) || "其他";
const l2KeyOf = (s) => (s.l2 && (s.l2.zh || s.l2.en)) || (s.zh || s.en);

NAV.forEach((n1, idx) => {
  const single = n1.l2s.length === 1;
  const bodies = n1.l2s.map((n2) => {
    const secs = MENU.filter((s) => l1KeyOf(s) === (n1.l1.zh || n1.l1.en) && l2KeyOf(s) === (n2.l2.zh || n2.l2.en));
    const l2row = single ? "" :
      `<div class="acc-l2" data-anchor="${esc(n2.anchor)}">
        <span class="l2name"><span class="n-en">${esc(n2.l2.en)}</span><span class="n-zh">${esc(n2.l2.zh)}</span></span>
        <span class="l2cnt">${n2.count}</span></div>`;
    return l2row + secs.map(sectionHtml).join("");
  }).join("");
  menuEl.insertAdjacentHTML("beforeend",
    `<div class="acc-l1 ${idx === 0 ? "" : "collapsed"}" id="l1-${idx}">
      <div class="acc-l1-head"><span><span class="c-en">${esc(n1.l1.en)}</span><span class="c-zh">${esc(n1.l1.zh)}</span></span><span class="car">▼</span></div>
      <div class="acc-l1-body">${bodies}</div>
    </div>`);
});

NAV.forEach((n1, idx) => {
  l1barEl.insertAdjacentHTML("beforeend",
    `<button class="l1chip${idx === 0 ? " active" : ""}" data-l1i="${idx}"><span class="c-en">${esc(n1.l1.en)}</span><span class="c-zh">${esc(n1.l1.zh)}</span></button>`);
});
```

- [ ] **Step 5: Wire the interactions (chip → expand+scroll; L2 → collapse+scroll; header → toggle)**

In `templates/menu.html`, after the render blocks (and after the filter-bar setup that still references `#menu section` — that keeps working), add:

```javascript
function expandOnly(idx) {
  document.querySelectorAll(".acc-l1").forEach((el, i) => el.classList.toggle("collapsed", i !== idx));
  l1barEl.querySelectorAll(".l1chip").forEach((c, i) => c.classList.toggle("active", i === idx));
}
// L1 chip: expand that category (collapse others) and scroll to it.
l1barEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".l1chip"); if (!chip) return;
  const idx = Number(chip.dataset.l1i);
  expandOnly(idx);
  document.getElementById("l1-" + idx).scrollIntoView({ behavior: "smooth", block: "start" });
});
// Accordion: tap an L1 header to toggle it; tap an L2 row to scroll to its content.
menuEl.addEventListener("click", (e) => {
  const l2 = e.target.closest(".acc-l2");
  if (l2) { const t = document.getElementById(l2.dataset.anchor); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const head = e.target.closest(".acc-l1-head");
  if (head) head.parentElement.classList.toggle("collapsed");
});
```

- [ ] **Step 6: Update the dietary filter's per-section reveal to also reveal ancestors**

The existing `applyFilter()` sets `sec.style.display` per `#menu section` and toggles the old nav link. The old nav link line (`const link = navEl.querySelector(...); if (link) link.style.display = ...`) references the removed `navEl` — delete those two lines inside `applyFilter()`. The accordion sections are still `#menu section` elements, so item/section hiding keeps working unchanged; no ancestor toggling is required (collapsed L1s simply contain hidden sections). Remove the dead nav-link lines:

```javascript
    // DELETE these two lines from applyFilter():
    // const link = navEl.querySelector(`a[data-sec="${CSS.escape(sec.id)}"]`);
    // if (link) link.style.display = visible ? "" : "none";
```

- [ ] **Step 7: Run tests to verify they pass; build**

Run: `npm test -- --test-name-pattern="template renders L1 category chips"`
Expected: PASS.
Run: `npm run typecheck && npm test && npm run build`
Expected: clean; all pass; build OK.

- [ ] **Step 8: Commit**

```bash
git add templates/menu.html src/render.test.ts
git commit -m "feat(nav): sticky L1 chips + two-level accordion + currency-prefixed prices"
```

---

## Verification (after all tasks)

- [ ] `npm run typecheck && npm test && npm run build` — all green.
- [ ] Manual browser check (open a rendered menu HTML): sticky L1 chips scroll horizontally; tapping a chip expands that category and collapses others and scrolls to it; tapping an L2 row (with count) scrolls to its content; L3 sub-sections (Scotch/Bourbon) appear under the consolidated L2; prices show the currency prefix (e.g. `RM37`); the dietary filter, 雙語/中文/EN toggle, and 💡 popover still work; a menu missing l1/tier/l2 falls into an "其他/Other" category and still renders.
- [ ] Production acceptance: Brian re-runs the in-room dining menu and eyeballs the two-level nav on a phone.

## Deployment note (not a code task)

After merge to `main`: `ssh mybani-prod` → `cd ~/menubot && git pull && npm install && npm run build && sudo systemctl restart menubot`. No env change. Only newly-extracted menus carry classification; previously-published menus keep their old flat HTML (already static on R2) — re-send to regenerate.
