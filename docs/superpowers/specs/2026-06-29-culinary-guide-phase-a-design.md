# Culinary Guide — Phase A (broader 💡 + mini-guide explanations)

**Date:** 2026-06-29
**Status:** Approved (design)
**Scope:** MenuBot extract + explain SYSTEM prompts only. Turn the 💡 explanation
from "occasional whole-dish specialty note" into a **condensed bilingual culinary-
culture mini-guide** for foreign / fine-dining menus: flag far more dishes, and for
each, briefly cover the notable terms in its name with romanized pronunciation. One 💡
per dish; no data-model / pipeline / template change.

## Background

Brian's feedback (2026-06-29): a foreign fine-dining menu (Italian; The Terrace) is
exactly where every term begs explanation — Tartare, Mozzarella, Bolognese, Fettuccine,
Ragout, Linguine, Pesto, Aglio Olio, "Andaman" — yet most got no 💡. The just-shipped
truncation-salvage fix (`9a43fe3`) restored dropped explanations; this phase broadens
*what* gets explained and *how rich* each explanation is. Vision + phasing in
`memory/project_culinary_guide_vision.md` (Phase B = a term-level lexicon DB with
pronunciation and cross-region translation normalization — out of scope here).

## Goals

- On foreign / exotic menus, flag (set `xterm` on) any item whose name carries a
  culinary term, technique, ingredient, or place/origin name a typical diner may not know.
- Make each 💡 a concise mini-guide: explain the dish's notable terms, add a **romanized**
  pronunciation for key foreign words, note origin/culture when interesting.
- Mention translation rationale **only** when there's a genuine etymology — never to
  justify ordinary regional wording (the 芝士/起司 trap belongs to Phase B normalization).

## Non-goals

- No per-term popovers, no multiple `xterm` per item — still one slug (the dish's
  canonical name) per item, one 💡 per dish.
- No data model, pipeline, glossary, enrich, or template changes — output **schema** is
  unchanged; only the prose inside `explain_en`/`explain_zh` (and trigger breadth) change.
- No pronunciation database, no IPA, no cross-region translation normalization (Phase B).

## Design

Two SYSTEM-prompt edits. No code logic changes.

### A. Extract — broaden the `xterm` trigger (`src/extract.ts` SYSTEM)

Replace the `Explanations (xterm)` block with guidance that flags generously on foreign
cuisines while still skipping plainly-ordinary items. The slug stays the dish's canonical
name; still one per item; the model still writes NO explanation here (slug only).

New block:

```
Explanations (xterm) — IMPORTANT:
- Set "xterm" to a lowercase-hyphen slug of an item's canonical name whenever the item
  carries a culinary term, technique, ingredient, or place / origin name that a curious
  diner may not know. Be GENEROUS on foreign / exotic cuisines (Italian, French, Spanish
  and other Latin-rooted, Turkish, Arabic, Japanese, etc.): flag the dish if ANY notable
  word in its name is worth knowing. Examples:
    "salmon-tartare", "buffalo-mozzarella", "spaghetti-bolognese",
    "fettuccine-lamb-ragout", "linguine-al-pesto", "andaman-prawn-aglio-olio",
    "laksa", "char-kway-teow", "flat-white", "confit", "sous-vide".
  Use the dish's canonical slug (not the exact printed casing); ONE slug per item.
- Still do NOT set xterm for plainly globally-known items whose name has no foreign or
  unfamiliar term (fried rice, caesar salad, latte, coke, french fries). When the whole
  name is ordinary, leave it "".
- Do NOT write the explanation here — only the slug.
```

### B. Explain — concise mini culinary-culture note (`src/explain.ts` SYSTEM)

Rewrite the SYSTEM so `explain_en`/`explain_zh` become a tight mini-guide. The JSON
**schema is unchanged** (same six fields) — only the instructions for the two explain
fields change. New SYSTEM:

```
You write a concise bilingual mini culinary-culture note for each unfamiliar dish or
term, for a curious diner exploring foreign / fine-dining menus. Tone: a condensed,
factual "eat the world, learn the world" guide — interesting, never padded.

You receive a JSON array of items: { "term": <slug>, "sample_en": <a menu name>,
"sample_zh": <its 中文 name> }. For EACH item return one object, and return ONLY a JSON
array (no markdown, no commentary):
{
  "term": string,        // echo the input slug exactly
  "display_en": string,  // the canonical English name, e.g. "Linguine al Pesto"
  "display_zh": string,  // the canonical 繁體中文 name
  "explain_en": string,  // see content rules below
  "explain_zh": string,  // the same content, in natural 繁體中文
  "category": string     // "coffee" | "tea" | "dish" | "ingredient" | "technique" | "drink" | "other"
}

Content for explain_en / explain_zh (2–4 sentences, concise — shown in a small popover):
- Briefly explain the NOTABLE terms in the name — each interesting word a curious diner
  would wonder about (for "Linguine al Pesto": what Linguine is, what Pesto is; for
  "Andaman Prawn Aglio Olio": that Andaman is a place, and what Aglio e Olio is).
- For the key foreign word(s), add a ROMANIZED phonetic pronunciation in parentheses —
  an English-readable respelling, e.g. "Bruschetta (broo-SKET-ta)", "Gnocchi (NYOH-kee)".
  NOT IPA. Put the pronunciation in BOTH language fields.
- Mention the origin / culture in one clause when it is genuinely interesting.
- Explain WHY it is translated a certain way ONLY when there is a real etymology or story
  worth telling. Do NOT justify ordinary translations — regional wording varies (e.g.
  芝士 vs 起司 for cheese) and explaining it is noise; just skip it.

Be accurate; never invent specifics you are unsure of. Keep it tight (a popover, not an
essay). Traditional Chinese only for the _zh fields. Valid JSON, no trailing commas.
```

(`explain.ts` already uses `max_tokens: 16000` and the salvage parser from `9a43fe3`,
which this phase relies on — richer + more entries = longer responses.)

### C. Everything else — unchanged

`explain-parse.ts`, `enrich.ts`, `glossary.ts`, `render.ts`, `templates/menu.html`,
`types.ts`, the 💡 popover, and the `notable` (💡 特色) filter all consume the same schema
and need no change. The glossary cache now stores dish-level mini-guides keyed by the dish
slug — reused when the same dish recurs; cross-menu term reuse is Phase B.

## Cost / risk

- More items flagged + richer explanations ⇒ more output tokens on foreign menus.
  Mitigated by: the glossary cache (a repeated dish costs 0), and this only fires on menus
  with foreign/unfamiliar terms. The 16000 cap + salvage parser keep a big batch from being
  lost. Acceptable; watch token spend on first live tests.
- Over-flagging risk (flagging ordinary items): the prompt keeps the "skip plainly-ordinary"
  rule. Tune on acceptance if it over- or under-fires.

## Testing

This phase is prompt engineering — no new logic, so no new unit tests. The existing
`explain-parse.test.ts` (incl. the truncation-salvage tests) still guards the parse path.

Verification:
- `npm run typecheck` + `npm test` stay green (no code logic changed).
- VPS acceptance (Brian, live): re-publish the Terrace Italian menu →
  1. Most foreign-term dishes now show 💡.
  2. Each 💡 is a concise mini-guide covering the dish's notable terms, with a romanized
     pronunciation for the key foreign word(s).
  3. Plain items (if any) show no 💡; no 芝士-vs-起司 style translation justifications.
  4. The "💡 特色" filter chip appears and filters to the explained dishes.
  5. `journalctl -u menubot` shows no explain-parse failure.

## Rollout

Two SYSTEM-prompt edits in `src/extract.ts` and `src/explain.ts`; `npm run typecheck` +
`npm test` green; build; merge to `main`; deploy to VPS; Brian live acceptance on a foreign
menu. Mark ✅ in memory. Phase B (lexicon DB: term-level entries, pronunciation source,
芝士/起司 cross-region normalization, learning features) is a separate later design.
