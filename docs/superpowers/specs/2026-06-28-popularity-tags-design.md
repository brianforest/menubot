# P4a — Web Popularity Tags (🔥 popular)

**Date:** 2026-06-28
**Status:** Approved (design)
**Scope:** MenuBot enrichment + rendering. Requirement #4 — once per menu, use
Claude's native `web_search` to find the restaurant's famous/recommended dishes and
flag the matching menu items with the reserved `popular` 🔥 tag (P2a already reserved
the tag and built the filter-chip/icon UI; this phase supplies the data and lets it
render). An optional user-supplied hint (restaurant name / location / Google Maps
link) sharpens the search and fixes the "no restaurant name" gap.

## Background — why P4a is split out of P4

A feasibility spike (2026-06-27, Din Tai Fung target, real `web_search`/`web_fetch`)
established:
- **#4 popularity is reliable and low-risk.** One `web_search` call ("\<restaurant>
  signature/popular dishes") → Claude matches the menu item list → conservatively
  flags signatures with sound reasoning. ~24k in / ~1k out tokens + 4 web searches
  (~$0.05/menu).
- **#5 dish images are mechanically possible but low-yield** — `web_fetch` returns
  text documents (not image bytes), and official-site `og:image` URLs are often
  branded banners/logos rather than clean dish photos, so #5 needs a vision
  verification gate and is best-effort. → **deferred to P4b.**
- **EXIF GPS** is awkward (Telegram strips EXIF on compressed photos; `web_search`
  `user_location` takes city/region, not raw lat/long). The lighter substitute —
  an optional typed hint — is folded into P4a; raw-GPS precision is deferred.

P4a ships #4 alone as one clean increment; P4b (#5 images) and raw GPS follow
separately. See `memory/project_p4_network_enrichment.md`.

## Problem

P2a generalized tags and reserved `popular` (icon 🔥, group "highlight") as a
well-known tag, building the filter bar + per-item icon from the menu's tag
vocabulary — but deliberately left it unpopulated:
- `src/extract.ts` SYSTEM forbids the model from emitting `popular`.
- `src/render.ts` strips any `popular` TagDef from `TAGS_JSON` (defensive).

So today no item ever shows 🔥. P4a makes the popularity stage the sole legitimate
producer of the `popular` tag.

## Goals

- Once per menu, identify the restaurant's popular/signature dishes via `web_search`
  and flag the matching items with the `popular` tag, so the existing 🔥 chip +
  per-item icon render.
- Let the user optionally provide a restaurant name / location / Google Maps link
  during upload to sharpen the search and cover menus whose name isn't on the photo.
- Degrade gracefully: any failure (no restaurant identity, search error, bad output)
  publishes the menu unchanged, without 🔥.

## Non-goals (deferred)

- **#5 dish images → P4b** (vision-gated, best-effort, separate phase).
- **Raw EXIF GPS precision** → later (needs image-as-document + reverse-geocode).
- No direct scraping of Google Maps/Yelp (JS-rendered + anti-bot; `web_search` over
  the open web is the channel). No Mac-Mini proxy.
- No migration of already-published pages.

## Design

### A. Data model (`src/types.ts`)

No new types. P4a reuses the P2a `TagDef`/`MenuItem.tags` vocabulary. The reserved
tag is materialized as:

```ts
{ id: "popular", en: "Popular", zh: "人氣", icon: "🔥", group: "highlight" }
```

The restaurant hint is threaded as a function argument only — it is **not** stored on
`Menu`/`MenuItem`. No type changes.

### B. Popularity orchestrator (`src/popular.ts` — pure, DI, config-free)

Mirrors `enrich.ts`: no Anthropic import, fully unit-testable with an injected
`findPopular`.

```ts
export type FindPopular = (
  restaurant: string,
  location: string,           // "" when unknown
  items: { i: number; en: string; zh: string }[],
) => Promise<number[]>;       // indices (into `items`) judged popular

export async function tagPopular(
  menu: Menu,
  findPopular: FindPopular,
  hint?: string,              // optional user text: name / location / Google link
): Promise<Menu>;
```

Algorithm (in order; step 1 always runs even if later steps are skipped/throw):
1. **Strip stray `popular`** from every item's `tags` and from `menu.tags`
   (popularity stage owns the tag end-to-end; this relocates P2a's render-side
   defense to the right place).
2. **Resolve restaurant identity** (a `restaurant` string + a free-text `location`
   string, `""` when unknown) from `hint` then `menu.restaurant`:
   - If `hint` contains a Google Maps URL, parse the **place name** from the URL path
     (e.g. `/maps/place/Din+Tai+Fung+Xinyi/…`, "+"→space, URL-decoded) — no fetch.
     Use it as `restaurant`; any area words in the name double as `location`.
   - Non-URL hint text → `restaurant`/`location` (whatever the user typed).
   - Fall back to `menu.restaurant.en || menu.restaurant.zh` for `restaurant`.
   - **Raw lat/lng from a Google URL is not used in P4a** — structured
     `user_location` / reverse-geocoding is the deferred GPS work; P4a passes
     `location` only as query text (step C).
   - If no usable `restaurant` → return menu (already stripped); no LLM call.
3. **Build candidate list**: flatten items to `{ i, en, zh }` with a stable flat
   index. If empty → return menu.
4. **Call** `findPopular(restaurant, location, items)`.
5. **Apply** results defensively:
   - Drop out-of-range / negative / duplicate indices.
   - **Over-flag guard**: if the kept count is `> max(6, 40% of items)`, treat as
     unreliable and flag none.
   - For each kept item: add `"popular"` to its `tags` (dedup).
   - If ≥1 item flagged, prepend the `popular` TagDef to `menu.tags` (once).
6. Return the (mutated) menu.

### C. Web popularity finder (`src/web-popular.ts` — real `findPopular`)

Thin LLM layer (imports `config` + SDK, like `explain.ts`); not unit-tested.
- One `client.messages.create` with `tools: [{ type: "web_search_20260209", name:
  "web_search", max_uses: 5 }]`, `model: config.anthropic.model` (`claude-sonnet-4-6`),
  modest `max_tokens` (~2000).
- Fold `restaurant` + `location` (when non-empty) into the search intent as **query
  text** (e.g. "\<restaurant> \<location> signature / most popular dishes"). P4a does
  **not** use the structured `user_location` param — that rides with the deferred GPS
  work.
- **Handle `stop_reason: "pause_turn"`** — re-send the accumulated messages to resume
  the server-side tool loop (cap ~6 continuations).
- SYSTEM: search the restaurant's signature/most-recommended dishes, then from the
  provided numbered item list return ONLY JSON `{ "popular": [indices] }`,
  conservatively (only items with real evidence). Parse the first JSON object; on any
  parse/shape failure return `[]`.

### D. Bot wiring (`src/bot.ts`)

- **Collecting session** (`BatchStore` + `bot.ts`): accept an optional text hint.
  - `BatchStore` gains a per-chat `hint?: string` (set/overwrite on text; returned by
    `take`). Keep the existing items/expiry behavior.
  - `bot.on("message:text")`: if a batch is active for the chat, store the text as the
    hint and acknowledge briefly; otherwise ignore (commands still handled by their
    own handlers). Guard against treating slash-commands as hints.
  - `COLLECT_MSG` adds one line: optionally send a restaurant name / location / Google
    Maps link to improve accuracy.
- **`processBatch`**: after `enrichMenu`, before render:
  ```ts
  try { await tagPopular(menu, findPopular, hint); }
  catch (e) { console.error("popularity tagging failed (publishing without 🔥):", e); }
  ```
  (Same graceful pattern as glossary enrichment.)

### E. Rendering (`src/render.ts`)

- Remove the `.filter((t) => t.id !== "popular")` on `TAGS_JSON` → serialize
  `menu.tags ?? []` directly. The legitimately-added `popular` TagDef now renders its
  chip + per-item 🔥 via the existing template (which already maps `tags[].id` →
  `TAG_BY_ID[id].icon` and builds chips from used tags). **Template unchanged.**

### F. Edge cases

- No restaurant name and no hint → strip only; publish without 🔥; no LLM call/cost.
- Search returns `[]` or unparseable → no TagDef added, no item tags.
- Stray `popular` from an extract bug → stripped in step 1 regardless of outcome.
- Hint that's only a Google link with no parseable name → fall back to
  `menu.restaurant`; if also empty, skip.
- Over-flagging (model returns most items) → guard flags none.
- Item already carrying `popular` (shouldn't happen post-strip) → deduped.

## Testing

- **`src/popular.test.ts` (node:test, injected fake `findPopular`):**
  - flags the returned indices; adds the `popular` TagDef exactly once; pushes
    `"popular"` into those items' `tags` (no duplicates).
  - strips a pre-existing stray `popular` (item tag + TagDef) before applying.
  - no restaurant name and no hint → `findPopular` not called; menu has no `popular`.
  - hint provides the name when `menu.restaurant` is empty → call happens.
  - Google Maps URL hint → restaurant name parsed from the URL is passed to
    `findPopular`.
  - out-of-range / negative / duplicate indices ignored.
  - empty result → no TagDef, no item tags.
  - over-flag guard → returning >max(6, 40%) flags none.
- **`src/render.test.ts`:** add a case — a menu carrying a `popular` TagDef + an item
  tagged `popular` serializes the `popular` tag into `TAGS_JSON` (regression guard for
  the removed filter).
- **`web-popular.ts`:** not unit-tested (real API); covered by VPS acceptance.
- `npm test` stays green (existing 28 + new).

## Rollout

Implement on `feat/popularity-tags`; subagent-driven (per-task TDD + two-stage review
+ opus full-branch final review); typecheck + tests green; merge to `main`; deploy to
VPS (`git pull && npm install && npm run build && sudo systemctl restart menubot`).

Acceptance (Brian, live):
1. Upload a well-known restaurant's menu (optionally send its name / Google Maps link)
   → signature/popular items show 🔥, a 🔥 Popular filter chip appears and filters,
   zh/en toggle intact.
2. A menu with no recognizable restaurant and no hint → publishes normally, no 🔥, no
   errors in `journalctl -u menubot`.
Mark ✅ in memory, then P4b (#5 dish images).

---

## Appendix — roadmap position

**P4a** (#4 web popularity). Remaining: **P4b** dish images (#5 — `web_search` to find
a candidate image URL, our Node `fetch()` downloads bytes, **vision gate** rejects
banners/wrong dishes, commit to `menus` repo `docs/m/<slug>/img/`; best-effort, key
items only); **raw-GPS precision** (image-as-document + reverse-geocode); **P5** VPS
hidden-door archive (#11). Locked decisions carry forward (web-sourced images
best-effort, hybrid storage, keep `claude-sonnet-4-6`, native PDF, native web tools —
no direct scraping).
