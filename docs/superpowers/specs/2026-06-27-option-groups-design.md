# P3 — Configurable Option Groups (layered presentation)

**Date:** 2026-06-27
**Status:** Approved (design)
**Scope:** MenuBot extraction + rendering. Requirement #6 — items with selectable
components (broths, noodles, toppings, sizes, add-ons) are captured as structured
option groups and shown with clear visual hierarchy. Dish images (#5) are moved to
P4 (they share web infrastructure with #4).

## Problem

Some items are configurable. The noodle-soup example has three groups:
- **湯底可選 (Broth)** — choose one: 清湯 / 娘惹咖哩湯 (Nyonya Curry Broth)
- **配料 (Toppings)** — included: 嫩雞肉, 新鮮蔬菜
- **麵條可選 (Noodles)** — choose one: 米粉 (Vermicelli) / 河粉 (Flat Rice Noodles) / 蛋麵 (Egg Noodles)

Today the extractor flattens this into a description string; the structure (which
groups, which choices, choose-one vs included vs paid add-on, per-choice prices) is
lost, and the page can't present it with hierarchy.

## Goals

- Capture an item's configurable components as **structured option groups**, each
  with a bilingual label, a kind (choose-one / included-list / optional-extras),
  and choices (each bilingual, with an optional price for paid add-ons).
- Render the groups under the item with clear visual hierarchy (bold group label +
  grouped choices), bilingual and language-toggle aware.

## Non-goals (deferred)

- #5 dish images → P4 (with #4 web popularity; shared web_search/web_fetch + repo
  image hosting). #4 → P4, #11 → P5.
- No interactive ordering/cart — this is presentation only.
- No migration of already-published pages (self-contained; only new extractions use
  the new schema/template).

## Design

### A. Data model (`src/types.ts`)

```ts
/** One selectable choice within an option group. */
export interface OptionChoice {
  en: string;
  zh: string;
  /** Extra price for this choice if it is a paid add-on, as printed; else absent. */
  p?: string;
}

/** A group of related choices for a configurable item. */
export interface OptionGroup {
  en: string;   // group label in English, e.g. "Broth"
  zh: string;   // group label in 繁體中文, e.g. "湯底可選"
  /** "one" = pick exactly one; "list" = included components; "any" = optional extras. */
  kind?: "one" | "list" | "any";
  choices: OptionChoice[];
}
```

Add to `MenuItem`:

```ts
  /** Configurable option groups (broths, noodles, toppings, sizes, add-ons). */
  options?: OptionGroup[];
```

(`Menu`, `MenuSection`, `TagDef`, `GlossaryEntry`, `ExplainRequest`, `MenuSource`
unchanged.)

### B. Extraction (`src/extract.ts` — SYSTEM prompt)

- Add `"options"` to the per-item schema.
- Instruct: when an item lets the diner configure it (choose a broth/noodle/size,
  add toppings, included components listed as sub-bullets), capture each as an
  option group with a bilingual label, a `kind`, and bilingual `choices`:
  - `kind: "one"` when the menu says "choose / 可選 / 任選一" (pick exactly one).
  - `kind: "list"` for included components simply listed (no choice).
  - `kind: "any"` for optional paid add-ons ("add … / 加 …"); put the add-on price
    in the choice's `p`.
- Keep the item's `den`/`dzh` for genuine prose description; do NOT duplicate the
  option structure into the description.
- Embed the noodle-soup example in the prompt so the shape is unambiguous.
- Everything else (tags, xterm, prices, bilingual, streaming, max_tokens) unchanged.

### C. Rendering (`src/render.ts` + `templates/menu.html`)

- `render.ts`: no change — `options` rides inside the serialized `sections`.
- Template: for an item with `options`, render an option block under the
  description. Each group:
  - a **group label** row (bold) showing zh/en (language-toggle aware) plus a small
    hint for the kind (e.g. 選一 / Choose one) when `kind === "one"` or `any`;
  - the **choices** as an indented list; each choice shows zh/en and, when present,
    its add-on price (e.g. `+2`).
  - Give the option block a subtle visual treatment (indent + left accent / tint)
    so it reads as a distinct, layered sub-section — "更有層次醒目".
- Escape all option text. Preserve the language toggle (zh/en spans hidden per
  `body.lang-*`).

### D. Edge cases

- Item with no `options` → renders exactly as before.
- A group with an empty/absent `kind` → render as a plain labeled list (no hint).
- A choice with no `p` → no price shown.
- An empty `choices` array → skip that group.

## Testing

- **`render.ts` (unit, append to `render.test.ts`):** `renderMenu` for an item with
  an option group embeds the group label and a choice into the page (assert the
  serialized labels/choices appear). Guards the data path.
- **Template option rendering + hierarchy:** manual browser acceptance.

## Rollout

Implement on `feat/option-groups`; typecheck + tests green; merge to `main`; deploy
to VPS (`git pull && npm install && npm run build && sudo systemctl restart
menubot`). Acceptance:
1. Re-publish the noodle-soup menu → the item shows 湯底可選 / 配料 / 麵條可選 as
   distinct, layered groups with their choices (and 選一 hints where appropriate).
2. A simple item with no options → unchanged layout.
Mark ✅ in memory, then P4.

---

## Appendix — roadmap position

This is **P3** (now just #6). Remaining: **P4** web enrichment — #4 web popularity
(populates the 🔥 `popular` tag) **and #5 dish images** (official-site / Google
images committed to the `menus` repo under `docs/m/<slug>/img/`), sharing the
`web_search`/`web_fetch` infrastructure. Then **P5** VPS hidden-door archive (#11).
Locked decisions carry forward (web-sourced images best-effort for key items, hybrid
storage, keep `claude-sonnet-4-6`, native PDF).
