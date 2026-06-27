# P2a — Generalisation + Dynamic-Tag Filters + Signature Recommendation

**Date:** 2026-06-27
**Status:** Approved (design)
**Scope:** MenuBot extraction + rendering. Requirements #1 (generalise beyond food
menus), #2 (filterable categories), #3 (signature ⭐ recommendation; the popular 🔥
tag's UI lands here but its data is populated in P4). #7 explanations and #8 glossary
are deferred to P2b.

## Problem

1. **#1 — Food-only.** The extractor assumes a restaurant food menu. It should
   handle any menu-like list (restaurant, spa, services).
2. **#2 — No filtering, and the tag set is hard-coded.** The page shows a static
   legend of exactly six dietary icons (spicy/veg/pork/chicken/seafood/beef). Real
   menus use their own vocabularies — e.g. an Italian menu marks "Highlight",
   "Gluten Free", "Contains Nuts", "Vegetarian". Filters must be **dynamic**: built
   from whatever classification labels a given menu actually uses, and tapping them
   should narrow the visible items. A non-food menu (spa) simply has no dietary
   tags, so dietary filters naturally disappear — this subsumes "disable the
   dietary classification for non-menus".
3. **#3 — No recommendation badges.** Menus often mark house favourites
   ("Highlight", "Chef's", "招牌"). These should surface as a filterable ⭐ tag.
   A 🔥 "popular online" tag is part of the same UI but is only populated later (P4).

## Goals

- Extract works for any menu type; emits a best-effort `kind`.
- Each menu carries a **dynamic tag vocabulary**; filters are generated from the
  tags actually present, not a fixed list.
- Filtering is multi-select **AND** (an item shows only if it has every active tag).
- House favourites surface as a well-known ⭐ `signature` tag; a 🔥 `popular` tag
  is reserved (no data until P4).

## Non-goals (deferred)

- #7 cuisine explanations / popover, #8 SQLite glossary → P2b.
- #5 dish images, #6 option groups → P3. #4 web popularity (populates 🔥) → P4.
- No migration of already-published pages: each page is self-contained HTML with
  its own embedded template, so old pages keep working unchanged. Only new
  extractions use the new schema + template.

## Design

### A. Unified data model — everything is a dynamic tag (`src/types.ts`)

Replace the fixed `DietTag` enum and `MenuItem.t` with an open tag system.

```ts
/** A classification label this menu uses (dietary, allergen, highlight, …). */
export interface TagDef {
  /** Stable lowercase-slug id, e.g. "vegetarian", "gluten-free", "signature". */
  id: string;
  en: string;                 // "Gluten Free"
  zh: string;                 // "無麩質"
  /** Emoji shown on chips/items; omitted when no fitting emoji applies. */
  icon?: string;
  /** Coarse grouping for ordering/uses: "diet" | "allergen" | "protein"
   *  | "highlight" | "other". Optional. */
  group?: string;
}

export interface MenuItem {
  en: string;
  zh: string;
  p?: string;                 // price as printed
  den?: string;               // English description
  dzh?: string;               // 繁中 description
  /** Ids of TagDefs this item carries (replaces the old `t`). */
  tags?: string[];
}

export interface MenuSection {
  en: string;
  zh: string;
  id?: string;
  note?: string;
  items: MenuItem[];
}

export interface Menu {
  restaurant?: { en?: string; zh?: string };
  currency?: string;
  /** Best-effort menu type: "food" | "spa" | "service" | "other". Informational. */
  kind?: string;
  /** The tag vocabulary used by this menu — only tags carried by ≥1 item. */
  tags?: TagDef[];
  sections: MenuSection[];
}
```

Recommendation badges are **not** special fields — they are two well-known tags:
- `signature` — en "Signature", zh "招牌", icon "⭐", group "highlight".
- `popular` — en "Popular online", zh "網路人氣", icon "🔥", group "highlight"
  (reserved; no item carries it until P4).

Well-known dietary tags keep their existing emojis: `vegetarian`🌱, `spicy`🌶️,
`pork`🐷, `chicken`🐔, `seafood`🐟, `beef`🐮.

### B. Extraction (`src/extract.ts` — SYSTEM prompt + JSON schema)

Generalise the prompt and change the JSON schema to the model above.

- **Generalise:** "one restaurant's menu" → "one menu or list (restaurant food,
  spa treatments, services, etc.)". Emit `kind` (food/spa/service/other; "" if
  unsure).
- **Tag vocabulary:** instruct the model to emit a `tags` array — every distinct
  classification label the menu uses. Map common ones to the **well-known ids +
  emojis** (table embedded in the prompt: vegetarian🌱 spicy🌶️ pork🐷 chicken🐔
  seafood🐟 beef🐮 vegan🌱 gluten-free🌾 contains-nuts🥜 dairy🥛 signature⭐).
  For menu-specific labels not in the table, mint a stable lowercase-slug `id`,
  give bilingual `en`/`zh`, and pick a fitting emoji `icon` (or omit `icon` if none
  fits — the chip then shows text only). Only include tags that ≥1 item carries.
- **Items:** each item lists the tag `ids` it carries in `tags` (or `[]`). Map any
  "Highlight / Chef's / 招牌 / Recommended / 推薦" marker to the `signature` tag.
- **Do not** emit the `popular` tag (P4 owns it).
- Keep: Traditional-Chinese culinary wording, prices verbatim, capture every item,
  preserve order, valid JSON, streaming, `max_tokens: 32000`, the truncation guard.

The prompt must give an explicit example of the new shape (a `tags` vocabulary plus
items referencing ids) so the model returns consistent ids.

### C. Rendering (`src/render.ts` + `templates/menu.html`)

**`render.ts`:** in addition to sections, embed the tag vocabulary. Add a
`{{TAGS_JSON}}` placeholder filled with `JSON.stringify(menu.tags ?? [])`. Continue
auto-assigning section ids. (No `kind`-specific rendering for now — `kind` is
informational.)

**`templates/menu.html`:** replace the static `.legend` with a dynamic, interactive
**filter bar**, and add AND-filtering.

- Read embedded `TAGS` (vocabulary) and `MENU` (sections).
- Build the filter bar from the tags **actually present** across items (intersect
  `TAGS` with the union of item `tags`; ignore vocabulary entries no item uses).
  Each tag → a toggle chip showing `icon + zh/en label` (respecting the language
  toggle). Add a leading **「全部 All」** chip that clears all active filters.
- **Multi-select AND:** clicking a chip toggles it active (visual active state).
  An item is visible iff its `tags` is a superset of the set of active tag ids.
  With no active filter, all items show.
- After applying filters: hide any section whose visible item count is 0, and hide
  that section's jump-nav link; show them again when filters change.
- Each item renders its tag icons (id → `TagDef.icon` lookup; tags without an icon
  contribute nothing to the inline icon row but still drive filtering).
- Preserve the existing language toggle (雙語/中文/EN), section jump-nav, back-to-top,
  prices, and bilingual descriptions.

### D. Edge cases

- Item with `tags: []` or omitted → shows when no filter active; hidden as soon as
  any filter is active (it matches no tag). This is correct AND semantics.
- A menu with no tags at all (e.g. a bare spa list) → no filter bar (or only the
  「全部」 chip suppressed); page still renders sections.
- Unknown tag id referenced by an item but missing from `TAGS` → ignored for icon
  display; still usable as a filter key only if it appears in `TAGS` (it won't, so
  it just shows no chip). Render defensively (no crash).
- `icon` may be absent — chip and item show text-only.

## Testing

- **`render.ts` (unit, `node:test`):** `renderMenu` embeds the tags vocabulary and
  the items' `tags` into the HTML (assert the serialized `TAGS_JSON` and a sample
  item's tag ids appear; assert `slugify` still stamps section ids). `render.ts`
  imports only `node:fs` + types (no `config.ts`), so it is safe to import in tests.
- **Extraction:** prompt-only; verified by `npm run typecheck` and manual VPS
  acceptance (an Italian menu with Highlight/Gluten-Free/Contains-Nuts, and a spa
  menu, both digitise with sensible dynamic tags).
- **Template client JS (filter AND-logic, empty-section hiding):** verified
  manually in the browser during acceptance (consistent with the project's
  untested-UI norm). Acceptance script in Rollout.

## Rollout

Implement on `feat/dynamic-tags`; typecheck + tests green; merge to `main`; deploy
to VPS (`git pull && npm install && npm run build && sudo systemctl restart
menubot`); acceptance:
1. A food menu with several tags → filter bar appears; tapping two tags shows only
   items having BOTH; 「全部」 resets; ⭐ signature filters house favourites.
2. An Italian-style menu with Gluten Free / Contains Nuts / Highlight → those appear
   as dynamic chips.
3. A non-food (spa) menu → no dietary chips; sections still render.
Mark ✅ in memory, then start P2b.

---

## Appendix — relationship to the locked roadmap

This is **P2a**, the first slice of roadmap phase P2. Remaining P2 work (P2b):
#7 cuisine explanations with a tap-to-open popover + #8 SQLite glossary cache
(`~/menubot/data/glossary.db`). Later phases unchanged: P3 option groups + dish
images, P4 web enrichment (populates the 🔥 `popular` tag + official/Google images),
P5 VPS hidden-door archive. Locked decisions (web-sourced images, hybrid storage,
SQLite glossary, native PDF, keep `claude-sonnet-4-6`) carry forward.
