# Notable (💡) Filter

**Date:** 2026-06-29
**Status:** Approved (design)
**Scope:** MenuBot rendering/enrichment. Items that carry a 💡 explanation are
regional/unusual specialties — make "has 💡 / 特色" a filter chip so diners can
narrow the menu to the distinctive items, the same way ⭐ signature and 🔥 popular
already filter.

## Background

Brian's live feedback (2026-06-29): the 💡 explanations (P2b glossary) are clear and
useful, and the items that get a 💡 are often the distinctive ones — so they're worth
surfacing as their own filter, alongside ⭐ signature and 🔥 popular.

Today: `enrichMenu` attaches `item.explain` to items whose `xterm` matched the
glossary/explain step; the template renders a 💡 popover button for those items. The
dynamic filter bar (P2a) is built from `menu.tags` and filters items by their
`tags[]`. There is no way to filter to the 💡 items.

## Goals

- After enrichment, give every item that has an `explain` a reserved `notable` tag so
  the existing filter bar shows a "💡 特色 / Notable" chip that filters to those items.
- Avoid a duplicate 💡 on the item itself (it already shows the 💡 popover button).

## Non-goals

- No change to how explanations are produced (glossary/explain unchanged).
- Not tied to ⭐ signature or 🔥 popular — `notable` is its own axis (unusual / needs
  explanation), independent of "recommended" or "popular".
- No new dependencies, no new types.

## Design

### A. Notable tagging (`src/notable.ts` — pure, no I/O)

Mirrors `popular.ts`. The popularity stage's pattern (own the tag end-to-end, strip
strays first) carries over.

```ts
import type { Menu, TagDef } from "./types.js";

export const NOTABLE_TAG: TagDef = {
  id: "notable", en: "Notable", zh: "特色", icon: "💡", group: "highlight",
};

/** Tag every item that has an explanation with `notable` so the 💡 filter chip
 *  renders. Strips any stray `notable` first (this stage owns the tag). Pure;
 *  mutates and returns the same menu. */
export function tagNotable(menu: Menu): Menu;
```

Algorithm:
1. Strip any existing `notable` from every item's `tags` and from `menu.tags`
   (defensive — the extractor is not told to emit it, but this stage is the sole
   legitimate source).
2. For each item across all sections: if `item.explain` exists (has a non-empty `en`
   or `zh`), add `"notable"` to `item.tags` (create the array if absent; dedup).
3. If ≥1 item was tagged, prepend `NOTABLE_TAG` to `menu.tags` (once).
4. Return the menu.

(`TagDef` imported from `./types.js`; no type changes.)

### B. Bot wiring (`src/bot.ts`)

Call `tagNotable(menu)` immediately after the `enrichMenu` block and before the web
enrichment / render. It's pure and cannot throw, so no try/catch:

```ts
    tagNotable(menu);
```

Runs regardless of `WEB_ENRICH` (it's local, free).

### C. Rendering (`templates/menu.html` — one line)

`render.ts`: no change. The `notable` TagDef rides in `menu.tags`; the template already
builds the filter bar from used tags and filters items by `data-tags`. Two facts make
this work with a single edit:

- The filter **chip** and **filtering** key off the tag vocabulary + `data-tags`, which
  already include `notable` — so the "💡 特色" chip appears and filters with no change.
- The per-item **icon** row would otherwise render a second 💡 next to the existing 💡
  popover button. So the one change: exclude `notable` from the item's displayed icon
  list (keep it in `data-tags` for filtering).

Current line:

```js
    const icons = ids.map(t => (TAG_BY_ID[t] && TAG_BY_ID[t].icon) || "").filter(Boolean).join(" ");
```

Becomes:

```js
    const icons = ids.filter(t => t !== "notable").map(t => (TAG_BY_ID[t] && TAG_BY_ID[t].icon) || "").filter(Boolean).join(" ");
```

`data-tags="${esc(ids.join(" "))}"` is unchanged (still includes `notable`), so the chip
filters correctly.

### D. Edge cases

- No items have `explain` → no `notable` tags, no chip (filter bar unchanged).
- Item already tagged `notable` (shouldn't happen post-strip) → deduped.
- A stray `notable` from the model → stripped in step 1.
- An item with an empty `explain` object → not tagged (guard on non-empty en/zh).

## Testing

- **`src/notable.test.ts` (node:test):**
  - items with `explain` get `notable`; the `NOTABLE_TAG` is added exactly once with
    icon 💡 / zh 特色.
  - items without `explain` are not tagged.
  - a pre-existing stray `notable` (item tag + TagDef) is stripped before applying.
  - dedup: an item isn't tagged `notable` twice.
  - empty menu / no explains → no `notable` tag anywhere.
- **`src/render.test.ts`:** a menu with a `notable` item serializes `notable` into
  `data-tags`/`TAGS_JSON`, and the template line excludes `notable` from the item icon
  string (assert the rendered item-builder filters it). A focused assertion that the
  `notable` tag is in `TAGS_JSON` (chip vocabulary) is enough for the data path.
- `npm test` stays green (existing 62 + new).

## Rollout

Implement on `feat/notable-filter`; subagent-driven (per-task TDD + two-stage review +
opus final review); typecheck + tests + build green; merge to `main`; deploy to VPS
(`git pull && npm install && npm run build && sudo systemctl restart menubot`).

Acceptance (Brian, live): re-publish a menu with some 💡 items → a "💡 特色 / Notable"
chip appears in the filter bar, tapping it narrows to the explained items, zh/en toggle
intact, and items show no duplicate 💡 (only the existing popover button). A menu with
no 💡 items shows no such chip.

---

## Appendix — position

A small post-roadmap enhancement (the 11-item expansion completed at P5). Reuses the
P2a dynamic-tag machinery and the P4a `popular` precedent (reserved highlight tag,
strip-then-apply). No new deps/types; one-line template change.
