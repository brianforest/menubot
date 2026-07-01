# B2 — 在地最佳譯 Localization Lexicon — Design Spec

> A curated `english-term → locale-best translation` single source of truth,
> applied deterministically (zero-API) to canonicalize transliterated dish terms.
> Author: Claude (dir. Brian). 2026-07-02.

## Goal

Make each user-facing dish term render in the **best, most common translation for
the user's locale (Taiwan / zh-TW today)** — the same English term always maps to
the same best zh, deterministically. Fixes translation *inconsistency*: the
extractor emits varying zh for the same concept (e.g. Waffles →「鬆餅華夫」one run,
「鬆餅格子餅」another). B2 pins these to a curated canonical (Waffles → 格子鬆餅).

This is a distinct roadmap slice from B1 (regional-normalize, already shipped):
- **B1** = zh-variant → Taiwan-wording substring replacement (Cantonese/Mainland
  ingredient words: 芝士→起司). Runs today.
- **B2** = keyed on the **English source term**, canonicalizes the transliterated
  zh dish term to the locale-best form. This spec.

## Decisions (settled)

- **Match key = English source term**, curation-led, **zero-LLM**. Extract is
  untouched; the translation authority lives entirely in a curated lexicon.
- **Rewrite mechanism = en-gate + zh-variant replacement.** `item.en` containing
  an entry's term opens the gate; then known zh variants are replaced with the
  canonical inside that item's zh fields. The en-gate is what makes even short/
  collision-prone variants (華夫) safe to include — only an actual waffle item is
  touched.
- **Locale-ready schema, ship zh-TW only.** The lexicon is keyed by
  `(en_term, locale)`; `config.lexicon.targetLocale` (default `zh-TW`) selects the
  active locale. Only zh-TW rows are seeded now; other locales are reserved
  columns to fill later. This keeps the door open for global reach without
  over-building a locale-selection/output layer (a future slice).
- **B1 and B2 coexist, not merged.** B1 is live and stable; merging is deferred
  risk. B2 runs immediately after B1 in the pipeline. Future convergence into one
  "normalize to target locale" model is noted, not built (YAGNI).
- **Lexicon growth via seed + candidate logger.** A code-defined seed is the
  base; a deterministic miss-logger surfaces en-matched items whose zh hit no
  known variant, turning invisible gaps into a curation queue.

## Global Constraints

- TypeScript ESM — local imports use the `.js` extension.
- Tests: `node:test` + `node:assert/strict`, `src/*.test.ts`, run with `npm test`.
- Code comments / commit messages in English (repo convention).
- No new runtime dependencies (`node:sqlite`).
- Curation errs toward **omission**: a missed variant is cosmetic; a wrong rewrite
  misleads a diner. The en-gate is the primary safety mechanism.
- `config.ts` reads env at import and `process.exit(1)`s on missing `required()`
  vars; B2's new vars are `optional()` with safe defaults, so no `.env` change is
  required to keep the suite importing.

## Architecture

A new `lexicon` table in the existing glossary SQLite db, loaded idempotently from
a code seed. A pure application module gates on `item.en` and rewrites the matched
item's zh fields. The pass is wired into `bot.ts` after B1 (regional) and before
render, gated by a default-on `LEXICON_NORMALIZE` flag.

### Component 1 — Lexicon store (`lexicon` table + seed + accessor)

Table (added to the `Glossary` constructor DDL, after `regional_variant`):

```sql
CREATE TABLE IF NOT EXISTS lexicon (
  en_term   TEXT NOT NULL,   -- lowercased, e.g. "waffle"
  locale    TEXT NOT NULL,   -- "zh-TW" | "zh-HK" | "zh-CN" | "zh-SG" | "zh-MY"
  canonical TEXT NOT NULL,   -- locale-best translation, e.g. "格子鬆餅"
  variants  TEXT NOT NULL DEFAULT '',  -- newline-separated known zh spellings
  note      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (en_term, locale)
);
```

- `src/lexicon-seed.ts`: `interface LexiconRow { enTerm; locale; canonical; variants: string[]; note }`
  and `export const LEXICON_SEED: LexiconRow[]` (zh-TW rows only for v1).
- `Glossary.seedLexicon()`: `INSERT OR IGNORE` each seed row (variants joined by
  `\n`). Idempotent; never clobbers a hand-edited row.
- `Glossary.putLexicon(enTerm, locale, canonical, variants[], note?)`: upsert
  (curation / tests).
- `Glossary.getLexicon(locale): LexiconEntry[]` where
  `LexiconEntry = { enTerm: string; canonical: string; variants: string[] }` —
  rows for the given locale, variants split back into an array (empty strings
  dropped). `en_term` is stored and returned lowercased.

### Component 2 — Application (`src/lexicon.ts`)

```
type LexiconEntry = { enTerm: string; canonical: string; variants: string[] };
type OnMiss = (enTerm: string, zh: string) => void;

normalizeItemLexicon(item: MenuItem, entries: LexiconEntry[], onMiss?: OnMiss): void
normalizeMenuLexicon(menu: Menu, entries: LexiconEntry[], onMiss?: OnMiss): Menu
```

`normalizeItemLexicon` for each entry:
1. **Gate:** skip unless `item.en.toLowerCase().includes(entry.enTerm)`.
2. **Replace:** in each zh field of the item (`zh`, `dzh`, `explain.zh`, every
   `options[].zh` and `options[].choices[].zh`), replace any variant with
   `canonical`, variants applied **longest-first** (a short variant cannot consume
   a substring of a longer one).
3. **Miss log:** if the gate opened but no variant matched anywhere in the item's
   zh fields **and** the item's `zh` name does not already contain `canonical`,
   call `onMiss(entry.enTerm, item.zh)`. Already-canonical → no change, no miss
   (idempotent).

Purity: no I/O; `onMiss` is the only side channel and is optional.

### Component 3 — Config + pipeline wiring

- `config.lexicon = { enabled, targetLocale }`:
  - `enabled = optional("LEXICON_NORMALIZE", "on").toLowerCase() !== "off"`
  - `targetLocale = optional("TARGET_LOCALE", "zh-TW")`
- `bot.ts`: after the B1 regional step and before `renderMenu`, if
  `config.lexicon.enabled && glossary`, run
  `normalizeMenuLexicon(menu, glossary.getLexicon(config.lexicon.targetLocale), onMiss)`
  where `onMiss` logs `[lexicon-miss] <enTerm> ≠ <zh>` via `console.log`.
  Best-effort; must never throw into the main flow.

## Data Flow

```
extract → enrich (glossary explains) → [web enrich, opt-in]
        → B1 normalizeMenu (regional zh→TW)
        → B2 normalizeMenuLexicon (en-gated term → locale-best)   ← new
        → renderMenu → publish
```

## v1 Seed (zh-TW — deliberately small)

| en_term    | canonical | variants                                   |
|------------|-----------|--------------------------------------------|
| waffle     | 格子鬆餅  | 鬆餅華夫 / 鬆餅格子餅 / 鬆格餅 / 窩夫 / 華夫餅 / 華夫 |
| flat white | 馥芮白    | 平白咖啡 / 馥列白                            |

Grow by appending rows, driven by `[lexicon-miss]` log observations. Terms already
consistent in practice (tiramisu, cappuccino) are intentionally omitted.

## Error Handling

- Missing/garbled variant: cosmetic miss, logged, never a wrong rewrite.
- B2 pass wrapped so any failure logs and publishes without B2 (like B1/enrich).
- Empty lexicon (unknown locale) → `getLexicon` returns `[]` → pass is a no-op.

## Testing

- **Store:** `getLexicon("zh-TW")` returns seeded entries with split variants;
  seed is idempotent and does not clobber a `putLexicon` edit; `getLexicon` of an
  unseeded locale returns `[]`.
- **Application:** gate-open replaces the variant; **gate-closed leaves zh
  untouched even when a variant-looking string is present** (proves the en-gate);
  longest-match wins; embedded term in a compound name (Belgian Waffle) is
  rewritten; miss is logged when en matches but zh is an unknown spelling;
  already-canonical → no change and no miss; multi-field (dzh / explain / options).
- **Config:** `lexicon.enabled` defaults true; `targetLocale` defaults `zh-TW`;
  `LEXICON_NORMALIZE=off` disables.

## Deployment

Seed loads on startup (idempotent), no migration. After merge:
`ssh mybani-prod → cd ~/menubot && git pull && npm install && npm run build &&
sudo systemctl restart menubot`. New env vars are optional with safe defaults, so
`.env` needs no change unless overriding.

## Out of Scope (future slices)

- Multi-locale **output selection** (per-user / per-menu locale) and rendering.
- Curating zh-HK / zh-CN / zh-SG / zh-MY rows.
- Merging B1 + B2 into a unified locale-normalization model.
- A live Telegram curation command.
