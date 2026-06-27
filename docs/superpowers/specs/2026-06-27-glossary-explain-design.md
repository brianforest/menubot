# P2b — Cuisine Explanations (Popover) + SQLite Glossary Cache

**Date:** 2026-06-27
**Status:** Approved (design)
**Scope:** MenuBot. Requirements #7 (explain not-widely-known items via a tap-to-open
popover) and #8 (a persistent SQLite glossary that caches explanations to cut tokens
and lookup time). Combined, **glossary-first** (the glossary is consulted before any
explanation is generated, so known terms cost zero tokens from day one).

## Problem

- **#7** — Travellers meet dishes/drinks they don't recognise (Flat White, Laksa,
  Confit). Each such item should carry a short bilingual explanation, surfaced by a
  💡 button that opens a popover (tap elsewhere dismisses).
- **#8** — Re-explaining the same term on every menu wastes tokens and time. A
  persistent glossary should cache explanations so a term is explained by the LLM
  at most once, ever.

## Goals

- The extractor flags items a typical international diner likely wouldn't recognise
  (medium aggressiveness — see Criteria) with a canonical term key.
- A glossary-first enrichment step fills explanations: cache hits cost 0 tokens;
  only cache-miss terms are sent to the LLM (once), then stored.
- The page shows a 💡 button on explained items; tapping opens a bilingual popover;
  tapping elsewhere closes it.

## Non-goals (deferred)

- #5 dish images, #6 option groups → P3. #4 web popularity → P4. #11 archive → P5.
- No automatic alias population (the `alias` table is created and consulted, but
  populating it is future/manual).
- No glossary admin UI; entries are written by the enrichment step.

## Criteria — when an item "needs explanation" (medium)

Flag when a typical international diner likely wouldn't know what it is:
regional/cultural specialties (Laksa, Char Kway Teow, Nyonya …), specialty
coffee/tea (Flat White, 鴛鴦/Yuanyang), uncommon ingredients or techniques (Confit,
Sous Vide). **Do not** flag common, globally-known items (fried rice, Caesar salad,
latte, Coke). The bar: "would a traveller need a one-line note to know what this is?"

## Architecture (data flow)

```
photos/PDF ─► extractMenu ─►  Menu (items may have xterm: canonical slug)
                              │
                       enrichMenu(menu, glossary, explainFn)
                              │  collect distinct xterms
                              ├─ glossary.getMany(terms)  ── hits ─┐
                              │                                    │
                              └─ misses ─► explainTerms(misses) ─► glossary.put(...)
                              │                                    │
                              ▼  attach item.explain {en,zh} from (hits ∪ new)
                          enriched Menu ─► renderMenu ─► publishMenu ─► link
```

`enrichMenu` is resilient: on any glossary/LLM failure it logs and returns the menu
unchanged (publishing must never be blocked by enrichment).

## Design

### A. Data model (`src/types.ts`)

```ts
export interface MenuItem {
  en: string;
  zh: string;
  p?: string;
  tags?: string[];
  den?: string;
  dzh?: string;
  /** Extraction output: canonical lowercase-hyphen slug when this item needs a
   *  cuisine explanation (e.g. "flat-white"); absent/"" otherwise. */
  xterm?: string;
  /** Filled by enrichMenu from the glossary/explain step. */
  explain?: { en: string; zh: string };
}

/** A cached glossary entry. */
export interface GlossaryEntry {
  term: string;          // canonical slug (primary key)
  display_en: string;    // "Flat White"
  display_zh: string;    // "馥芮白"
  explain_en: string;
  explain_zh: string;
  category: string;      // "coffee" | "dish" | "ingredient" | "technique" | …
}
```

(`Menu`, `MenuSection`, `TagDef`, `MenuSource` unchanged.)

### B. Glossary store (`src/glossary.ts`, `node:sqlite`)

- Verified: `node:sqlite` works on the VPS (Node 24.15) and locally (25.6) with no
  flag and no native dependency (one harmless `ExperimentalWarning` on stderr).
- `class Glossary` with a constructor taking a db path (so tests pass `:memory:`):
  - On construction: ensure the parent directory exists, open `DatabaseSync`, and
    `CREATE TABLE IF NOT EXISTS` the two tables.
  - `getMany(terms: string[]): Map<string, GlossaryEntry>` — resolve each term
    through `alias` (alias→canonical) then look up `glossary`; return found entries.
  - `put(entry: GlossaryEntry): void` — upsert (`INSERT … ON CONFLICT(term) DO
    UPDATE`).
  - `close(): void`.
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS glossary (
    term TEXT PRIMARY KEY,
    display_en TEXT NOT NULL DEFAULT '',
    display_zh TEXT NOT NULL DEFAULT '',
    explain_en TEXT NOT NULL DEFAULT '',
    explain_zh TEXT NOT NULL DEFAULT '',
    category   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS alias (
    alias TEXT PRIMARY KEY,
    term  TEXT NOT NULL
  );
  ```
- DB path from config (`GLOSSARY_DB`, default `data/glossary.db` relative to the
  process cwd — i.e. `~/menubot/data/glossary.db` on the VPS). `data/` is git-ignored.

### C. Explanation generator (`src/explain.ts`)

- `explainTerms(reqs: { term: string; sample_en: string; sample_zh: string }[]):
  Promise<GlossaryEntry[]>` — ONE streamed Claude call (`claude-sonnet-4-6`,
  streaming, modest `max_tokens`) that returns, for each requested term, a
  `GlossaryEntry` (display_en/zh, explain_en/zh, category). `created_at` is stamped
  by the caller/`put`.
- Prompt: concise, factual bilingual explanations (2–4 sentences each language;
  what it is, what makes it distinctive — the Flat White example level of detail),
  Traditional-Chinese for `*_zh`. Strict JSON array out; parse defensively.
- Only ever called with cache-miss terms; returns `[]` for an empty input without
  calling the API.

### D. Enrichment orchestrator (`src/enrich.ts`)

- `enrichMenu(menu, glossary, explainFn): Promise<Menu>`:
  1. Collect the set of distinct non-empty `xterm`s across all items.
  2. `hits = glossary.getMany(terms)`; `misses = terms not in hits`.
  3. If misses: `created = await explainFn(missReqs)` (sample names from the first
     item carrying each term); `glossary.put(...)` each, with `created_at` stamped.
  4. Build `term → {en,zh}` from hits ∪ created; attach `item.explain` to every item
     whose `xterm` resolved. Items whose term failed to resolve are left without
     `explain`.
  5. Return the (same-shape) enriched `Menu`.
- `explainFn` and `glossary` are injected (dependency injection) so `enrich.ts` is
  unit-testable without the network or a real DB.
- Wrapped by the caller in try/catch; enrichment failure ⇒ publish the menu without
  explanations.

### E. Extraction (`src/extract.ts`)

- Add `"xterm": string` to the per-item schema, with the medium-aggressiveness
  rubric (above) embedded in the prompt: emit a lowercase-hyphen slug of the item's
  canonical name when it needs explaining, else `""`. Keep everything else (tags,
  prices, bilingual, streaming, max_tokens 32000) unchanged.

### F. Bot wiring (`src/bot.ts`)

- In `processBatch`, between `extractMenu` and `renderMenu`, call
  `enrichMenu(menu, glossary, explainTerms)` inside its own try/catch (log + proceed
  with the un-enriched menu on failure). Construct one module-level `Glossary`
  instance (opened once, reused).

### G. Config (`src/config.ts`)

- Add `glossary: { dbPath: optional("GLOSSARY_DB", "data/glossary.db") }`.

### H. Rendering (`src/render.ts` + `templates/menu.html`)

- `render.ts`: no schema change needed — items already serialize `explain` when
  present (it rides inside `sections`).
- Template: for an item with `explain`, render a 💡 button after the name. A single
  shared popover element (appended once) shows the explanation; clicking the 💡
  opens it positioned near the button; a `document` click outside closes it; the
  popover content respects the language toggle (show en/zh per `body.lang-*`, both
  in 雙語). Escape all explanation text.

## Testing

- **`glossary.ts` (unit):** with a `:memory:` db — `put` then `getMany` returns the
  entry; unknown terms absent; upsert overwrites; alias row routes alias→term.
- **`enrich.ts` (unit):** inject an in-memory `Glossary` and a stub `explainFn`
  (counts calls). Assert: a cached term attaches `explain` WITHOUT calling the stub;
  a miss calls the stub exactly once, stores, and attaches; empty/`xterm`-less menu
  calls the stub zero times; a second enrich of the same term is a pure cache hit.
- **`explain.ts`:** returns `[]` for empty input without an API call (unit); the LLM
  path is verified manually.
- **Template popover:** manual browser acceptance.

## Rollout

Implement on `feat/glossary-explain`; typecheck + tests green; merge to `main`;
deploy to VPS (`git pull && npm install && npm run build && sudo systemctl restart
menubot`). The VPS creates `~/menubot/data/glossary.db` on first run. Acceptance:
1. A menu with Flat White / a regional dish → 💡 appears; tapping opens a bilingual
   popover; tapping elsewhere closes it.
2. Re-publishing a menu with the same term is a cache hit (check the glossary row
   exists; no second explanation call — observable via logs).
3. A menu of only common items → no 💡 buttons.
Mark ✅ in memory; P2 (all of #1/#2/#3-signature/#7/#8) then complete.

---

## Appendix — roadmap position

This is **P2b**, completing roadmap phase P2. Remaining: P3 (option groups #6 +
dish images #5), P4 (web popularity → 🔥 `popular` tag + official/Google images),
P5 (VPS hidden-door archive #11). Locked decisions carry forward (web-sourced
images, hybrid storage, keep `claude-sonnet-4-6`, native PDF).
