# Regional Normalization Pass — Design (Phase B, slice 1)

> 2026-07-01. First slice of the Phase B culinary lexicon. Goal: a deterministic,
> zero-API normalization pass that rewrites regional Chinese culinary variants
> (e.g. Cantonese/Mainland forms) to canonical **Taiwan (台灣)** wording across
> all user-facing `zh` fields of an extracted menu. Solves the root of the
> "偏港式" drift cheaply and reliably. Defers the harder transliteration-
> arbitrariness alignment (塔塔/他他/達達) and pronunciation/culture data to a
> later Phase B slice.

## Context & honest scope

- The lexicon does **not** speed up `extract` (vision reads new images, uncacheable).
  Its value is **consistency** — same source wording → same Taiwan form, every time.
- "偏港式" is fundamentally **word-level deterministic substitution** (芝士→起司,
  三文魚→鮭魚, 意大利粉→義大利麵). That part is cheap, safe, testable — this slice.
- The arbitrariness of *transliterations* of unfamiliar foreign terms, and the full
  lexicon data model (pronunciation, culture, multi-region canonical), are out of
  scope here. They are later Phase B slices.

## § 1 Data model

A new table in the existing glossary SQLite db (`data/glossary.db`), kept separate
from the LLM-generated `glossary` explanation cache because it is **curated canon**,
not generated content:

```sql
CREATE TABLE IF NOT EXISTS regional_variant (
  variant   TEXT PRIMARY KEY,          -- the non-Taiwan form, e.g. "芝士"
  canonical TEXT NOT NULL,             -- the Taiwan form, e.g. "起司"
  region    TEXT NOT NULL DEFAULT '',  -- provenance of the variant: "hk" | "cn" | "sg"; metadata only
  note      TEXT NOT NULL DEFAULT ''   -- curation note (why included / disambiguation)
);
```

**Seeding.** The canonical definitions live in code — `src/regional-seed.ts` exports
a typed array of `{ variant, canonical, region, note }`. On `Glossary` construction
(alongside the existing `CREATE TABLE IF NOT EXISTS`), the seed is loaded with
`INSERT OR IGNORE` (idempotent, never clobbers a hand-edited row). This keeps the
canon **reviewable in PRs** while the live lookup store is SQLite, and allows ad-hoc
rows to be added on the VPS later without a code change.

- The normalization pass only needs `variant → canonical`.
- `region` / `note` are metadata for curation provenance and a future
  `TARGET_REGION` axis. This slice does **not** build multi-region logic — canonical
  is Taiwan, full stop.

## § 2 Normalization mechanism & safety

- New module `src/regional.ts`, pure function:
  `normalizeRegional(text: string, map: Map<string, string>): string`.
- **Matching:** substring replacement keyed on the variant, **longest-match-first**
  (sort variants by descending length so a short variant cannot consume a substring
  of a longer one). Chinese has no word boundaries, so safety comes from the lexicon
  containing **only unambiguous, distinctive variants** — not from boundary logic.
- **Safety constraints (binding):**
  - Include only variants that are **unambiguous** in a Taiwan-targeted context.
    Short or semantically-ambiguous forms are **explicitly excluded** and recorded:
    - `土豆` — Taiwan: peanut; Mainland: potato. NEVER auto-rewrite to 馬鈴薯.
    - `意粉` — risk of partial/odd matching; exclude.
    - (the exclusion list lives in `regional-seed.ts` as commented-out entries with reasons)
  - Tests must include **false-positive guards**: e.g. `芝麻` (sesame) must NOT be
    touched by `芝士→起司`; `沙田` (a place name) must NOT be touched by `沙律→沙拉`.
- Deterministic, zero API, fully unit-testable — unlike parallel-extract there is no
  vision-misread risk; the only failure mode is a bad lexicon row, caught by tests.

## § 3 Application point & field coverage

- A new pipeline step `normalizeMenu(menu, map)` runs **after `extract` and
  `enrich` (💡), before `render`**, walking the assembled menu and normalizing every
  user-facing `zh` field:
  - `sec.zh` (section titles)
  - `it.zh` (item names), `it.dzh` (item descriptions)
  - option groups: `label.zh`, and each `choices[].zh`
  - tags: `zh`
  - `it.explain.zh` (the explanation already injected from the glossary)
- **Beneficial side effect:** because the already-injected `it.explain.zh` is also
  normalized on output, **stale cached "芝士" entries are rewritten to "起司" at
  render time** — this freely resolves the regional portion of the "已快取 💡 仍回
  舊港式字" caveat from the 2026-07-01 handoff, with no glossary cache-versioning
  needed. (Arbitrariness / full re-wording of cached explanations still requires the
  separate B4 cache-version mechanism, which is out of scope here.)
- `en` fields and prices are never touched.

## § 4 Seed content, rollout, testing

**Initial seed (conservative, ~15–25 pairs)**, built on the verified Taiwan-retarget
list. Confirmed inclusions (Cantonese → Taiwan):

- 芝士→起司, 三文魚→鮭魚, 忌廉→鮮奶油, 沙律→沙拉, 雲呢拿→香草, 薯仔→馬鈴薯,
  意大利粉→義大利麵, 車厘子→櫻桃, 士多啤梨→草莓, 青口→淡菜, 銀鱈魚→圓鱈, 布冧→李子
- Mainland (unambiguous only): 西紅柿→番茄
- Each row carries `region` + `note` (reason for inclusion) for auditable curation.
- **Explicitly excluded** (recorded in seed with reasons): 土豆 (台=花生 ambiguity),
  意粉 (collision risk), and any other short/ambiguous form. Curation errs toward
  omission — a missed variant is a cosmetic gap; a wrong rewrite misleads a diner.

**Rollout.** Deterministic, zero-API, unit-tested → ships **default-on**, with a
`REGION_NORMALIZE=off` escape hatch in `config.ts` as a safety valve. (Unlike
parallel-extract, which is opt-in because of vision-misread risk, this pass has no
such risk.)

**Testing** (`regional.test.ts` + coverage of `normalizeMenu`):

- `normalizeRegional`: single substitution, multiple variants in one string,
  longest-match-first ordering, empty-map passthrough (returns input unchanged).
- false-positive guards: 芝麻 / 沙田 / 土豆 unchanged.
- `normalizeMenu`: walks every covered field (incl. `it.explain.zh`), leaves `en`
  and prices untouched, handles missing/optional fields safely.
- `Glossary` seed: `INSERT OR IGNORE` is idempotent and does not overwrite an edited row.

## Out of scope (later Phase B slices)

- Transliteration de-arbitrariness (same foreign term → same Chinese transliteration):
  needs source-term alignment, harder; defer.
- Pronunciation / culture / category fields on lexicon entries (full B1 data model).
- Multi-region `TARGET_REGION` selection (only the data axis is reserved, not built).
- Glossary explanation cache-versioning (B4) for non-regional re-wording.

## Wiring summary

| File | Change |
|---|---|
| `src/regional-seed.ts` | new — typed seed array of variant→canonical (+region, note) |
| `src/glossary.ts` | add `regional_variant` table + idempotent seed load + a `getRegionalMap()` accessor |
| `src/regional.ts` | new — pure `normalizeRegional` + `normalizeMenu` |
| `src/bot.ts` (pipeline) | insert `normalizeMenu` step after enrich, before render, gated by `config.region.enabled` |
| `src/config.ts` | add `region.enabled` from `REGION_NORMALIZE` (default on) |
| `src/regional.test.ts` | new — substitution, ordering, false-positive, field-walk tests |
