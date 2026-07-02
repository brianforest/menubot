# Two-Level Category Navigation — Design Spec

> Group a menu's flat sections into a two-level, tier-ordered navigation (broad
> category → consolidated sub-category), classified by Sonnet 5, with a sticky
> L1 chip bar + a two-level accordion. Author: Claude (dir. Brian). 2026-07-02.

## Goal

A large menu today is a flat list of 40–53 sections that all read the same
weight, and drink/food/dessert ordering is whatever the menu printed. Give the
diner a fast two-level way to navigate: a sticky row of broad **L1 categories**
(餐點 / 點心 / 飲料 / 酒類 …) and, under each, **L2 consolidated sub-categories**
with item counts (威士忌 51 / 葡萄酒 18 / 早餐 12 …). Sonnet 5 does the
classification — the reason this slice waited for the model upgrade.

## Display model — 3 content tiers, 2 nav levels (confirmed)

- **L1 category** (nav chip): 酒類, 飲料, 點心, 餐點… — LLM-assigned, tier-ordered.
- **L2 consolidated sub-category** (accordion node + item count): 威士忌 51,
  葡萄酒 18, 早餐 12 — the LLM **merges same-type over-split sections** (the 7
  "Whiskey Collections – X" sections) into ONE L2.
- **L3 original section** (preserved as an in-content sub-heading only, NOT in the
  nav): Whiskey Collections – Scotch / – Bourbon …

Navigation is two levels (L1 chip → L2 accordion node). Tapping an L2 node scrolls
to that content block; inside it the original sections show as L3 sub-headings, so
Scotch/Bourbon detail is preserved. A section that needs no consolidation (早餐)
is its own L2 with no L3.

## Interaction (confirmed via mockup)

- **Sticky L1 chip bar** at the top, horizontally scrollable. Tapping an L1 chip
  jumps to that category and **expands its accordion (L2 nodes); all other L1
  categories collapse** (one L1 open at a time).
- **Two-level accordion** page body: each L1 is a collapsible block whose children
  are L2 nodes; each L2 node shows its **item count**.
- Tapping an **L2 node** collapses the index and **scrolls directly to that L2's
  content**.
- The existing dietary/highlight **filter chips (💡 / 素 / 辣) coexist** (kept as
  today, alongside/below the L1 bar).
- **Single-L2 category**: if an L1 has exactly one L2, render it flat (no forced
  second level).

## Decisions (settled)

- **Classification happens inside extraction** (Sonnet 5, zero extra API call),
  on **both extract paths**. Complex menus route to the SINGLE call, which never
  runs the outline — so the fields must be produced by BOTH prompts:
  - **Single path**: the single `SYSTEM` prompt emits `l1`/`tier`/`l2` per section
    (single produces the whole menu directly).
  - **Parallel path**: `OUTLINE_SYSTEM` emits them on the section spine, and
    `mergeExtract` carries them onto the merged sections.
  Putting classification in only the outline would silently skip every complex
  (single-path) menu — exactly the large menus this feature targets.
- **L1 order is a fixed rule, not LLM-judged.** Each L1 carries a `tier`; sections
  sort by tier rank, then original menu order. Tier order:
  **savory < dessert < drink < alcohol < other** — realizes Brian's rule
  (甜點 before 飲料 before 酒類).
- **L2 consolidation is LLM-judged** (which same-type sections merge into one L2).
- **Prices show the menu's actual currency** as a prefix (SGD → S$, MYR → RM, … —
  see mapping) to distinguish an amount from an L2 count badge.
- **Graceful degradation**: the classification fields are optional; a menu missing
  them (old cache, or the model omitted them) renders as today's flat list. No
  feature flag.

## Data model

`MenuSection` (src/types.ts) gains three optional fields:

```typescript
export interface MenuSection {
  en: string;
  zh: string;
  // …existing fields…
  /** Broad L1 category for two-level nav, e.g. { en: "Alcohol", zh: "酒類" }. */
  l1?: { en: string; zh: string };
  /** Ordering tier for L1: "savory" | "dessert" | "drink" | "alcohol" | "other". */
  tier?: string;
  /** L2 consolidated sub-category, e.g. { en: "Whiskey", zh: "威士忌" }. Sections
   *  sharing an (l1, l2) merge into one L2 nav node; their own en/zh stays the
   *  L3 sub-heading. */
  l2?: { en: string; zh: string };
}
```

The section's own `en`/`zh` is unchanged (it is the L3 sub-heading).

## Classification (prompts — both paths)

Each section object gains `l1`, `tier`, `l2`, described identically in the single
`SYSTEM` prompt (`src/extract.ts`) and `OUTLINE_SYSTEM` (`src/extract-outline.ts`):
- `l1`: the broad dining category in Taiwan-Chinese wording (e.g. 酒類, 飲料, 點心,
  餐點, 早餐); group naturally for THIS menu.
- `tier`: one of `savory | dessert | drink | alcohol | other`.
- `l2`: the consolidated sub-category. **Merge same-type over-split sections** —
  the seven "Whiskey Collections – X" sections all get `l2 = {en:"Whiskey",
  zh:"威士忌"}`; a lone section is its own l2.
- Keep the printed section title as the section's `en`/`zh` (the L3 sub-heading).

For the parallel path, `mergeExtract` (`src/extract-merge.ts`) must copy the
outline section's `l1`/`tier`/`l2` onto each merged output section (workers return
items only). The completeness guard (merged section count === outline spine) is
unaffected.

## Rendering

The client-side menu template (embedded `MENU` JSON + template JS, produced via
`src/render.ts`) is extended:
1. A pure grouping step builds the tier-ordered tree: `L1 (tier-sorted) → L2
   (item-count) → sections (L3)`, flattening single-L2 L1s.
2. Renders the sticky L1 chip bar + the two-level accordion (L2 counts), with the
   confirmed tap behaviors (chip → expand+jump / collapse others; L2 → collapse +
   scroll to content).
3. Item prices render with a currency prefix from `menu.currency` via a small map
   (`MYR→RM, SGD→S$, USD→$, EUR→€, GBP→£, JPY→¥, CNY→¥, TWD→NT$, THB→฿`; unknown →
   the raw code), so a price reads as money vs. an L2 count.

The pure grouping/sort logic lives in a testable module; the interactive
accordion/scroll is client JS.

## Testing

- **Classification**: parsing tests assert sections carry `l1`/`tier`/`l2` on both
  paths — the single parser and the outline parser (using fake model JSON). A
  merge test asserts `mergeExtract` copies the outline's `l1`/`tier`/`l2` onto
  merged sections. Tier values are accepted as-is (unknown → treated as "other" at
  render).
- **Grouping (pure)**: a `groupByCategory(sections)` function produces the
  tier-ordered L1→L2 tree with correct item counts, single-L2 flattening, and
  graceful handling of sections missing classification (fall to an "其他"/flat
  bucket). Unit-tested.
- **Currency prefix (pure)**: `currencyPrefix(code)` maps the common codes and
  falls back to the raw code. Unit-tested.
- **Render**: the template output contains the L1 chip bar and accordion structure
  (string-level assertions, as existing render tests do). The interactive
  accordion/scroll is client JS (not unit-tested; verified in the browser).

## Decomposition (two slices)

1. **Slice A — Classification**: `MenuSection` fields + `SYSTEM` and
   `OUTLINE_SYSTEM` prompt additions + `mergeExtract` carry-through + tests. Ships
   dormant (fields populated on both paths, not yet rendered).
2. **Slice B — Navigation render**: `groupByCategory` + `currencyPrefix` + template
   (chip bar, accordion, L2 counts, currency-prefixed prices) + tests.

Each slice is independently mergeable; B degrades gracefully if A's fields are
absent.

## Revision (2026-07-02, after phone verification)

Three changes after Brian saw the first build:

1. **L2 is a popup picker, not an inline accordion.** Tapping an L1 chip opens an
   independent popup (💡-popover style) listing ONLY that L1's L2 items (with
   counts); tapping an L2 closes the popup and scrolls to that section. No inline
   accordion, no collapse, no other L1's L2 shown inline. A single-L2 L1 chip
   scrolls directly (no popup). The `#menu` content is a flat, scrollable list of
   sections in tier/L1 order with L1 category dividers + L3 section headings (no
   inline L2 rows).
2. **Split beverages into two L1s.** Non-alcoholic drinks (water, juice, soft
   drinks, coffee, tea, mocktails) → their own L1 (飲料, tier `drink`); alcohol
   (beer, wine, spirits, whisky, cocktails) → a separate L1 (酒類, tier `alcohol`).
   Order: … dessert → 飲料(drink) → 酒類(alcohol). Prompt-level change; the fixed
   tier order already sequences drink before alcohol.
3. **Jump lands on the section heading, not the first item.** The sticky controls
   bar obscured the target; add `scroll-margin-top` (= sticky bar height) on
   sections and L1 dividers so a jump stops at the heading (e.g. "For Our Jr. VIPs
   兒童貴賓餐", not "Ben 10").

Supersedes the "sticky L1 chips + two-level accordion" interaction and the
single-broad-beverage-category behavior described above.

## Out of scope

- Three-level navigation (L3 stays content-only).
- Merging section *data* (sections stay intact; consolidation is display/nav only).
- Reordering that breaks a section's internal item order.
- A user setting to toggle the nav style.
