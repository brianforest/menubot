# Culinary Guide Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two SYSTEM-prompt edits so 💡 fires generously on foreign-cuisine terms and each explanation is a concise bilingual mini-guide with romanized pronunciation.

**Architecture:** Prompt-only. Broaden the `xterm` trigger in `extract.ts`; rewrite the explanation instructions in `explain.ts`. The JSON schema, pipeline, glossary, enrich, parse, and template are all unchanged.

**Tech Stack:** TypeScript ESM; prompts are template-literal strings.

## Global Constraints

- Prompt-only — NO code-logic, schema, type, pipeline, glossary, parse, or template changes.
- One `xterm` slug per item (the dish's canonical name); the model writes the slug only in extract, never the explanation.
- Explanation stays popover-sized (2–4 sentences). Romanized pronunciation (English-readable respelling, NOT IPA) for key foreign words, in BOTH `explain_en` and `explain_zh`.
- Translation rationale ONLY on a genuine etymology/story — never to justify ordinary regional wording (no 芝士-vs-起司 explanations).
- `explain.ts` already has `max_tokens: 16000` + the salvage parser (`9a43fe3`) — relied on, not changed.
- Verification: `npm run typecheck` + `npm test` green (no logic changed) + VPS live acceptance. No new unit tests (prompt engineering).
- Branch: `feat/culinary-phase-a` (already created; spec committed there).

---

### Task 1: Broaden trigger + mini-guide prompts (`extract.ts`, `explain.ts`)

**Files:**
- Modify: `src/extract.ts` (the `Explanations (xterm)` block in the `SYSTEM` literal)
- Modify: `src/explain.ts` (the `SYSTEM` literal)

**Interfaces:** none change — same JSON schema in/out.

- [ ] **Step 1: Broaden the `xterm` trigger in `src/extract.ts`**

In the `SYSTEM` template literal, replace this block:

```
Explanations (xterm) — IMPORTANT:
- Set "xterm" to a lowercase-hyphen slug of an item's canonical name ONLY when a
  typical international diner likely wouldn't recognise it: regional/cultural
  specialties (e.g. "laksa", "char-kway-teow"), specialty coffee/tea (e.g.
  "flat-white", "yuanyang"), or uncommon ingredients/techniques (e.g. "confit",
  "sous-vide"). Use the canonical concept's slug, not the exact printed name
  (e.g. an "Iced Flat White" → "flat-white").
- Do NOT set xterm for common, globally-known items (fried rice, caesar salad,
  latte, coke). When in doubt, leave it "".
- Do NOT write the explanation here — only the slug.
```

with:

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

- [ ] **Step 2: Rewrite the explanation SYSTEM in `src/explain.ts`**

Replace the entire `const SYSTEM = \`...\`;` literal:

```ts
const SYSTEM = `You explain unfamiliar culinary terms for travellers, concisely and
factually, in BOTH English and Traditional Chinese (繁體中文).

You receive a JSON array of items: { "term": <slug>, "sample_en": <a menu name>,
"sample_zh": <its 中文 name> }. For EACH item return one object with this shape, and
return ONLY a JSON array (no markdown, no commentary):
{
  "term": string,        // echo the input slug exactly
  "display_en": string,  // the canonical English name, e.g. "Flat White"
  "display_zh": string,  // the canonical 繁體中文 name
  "explain_en": string,  // 2-4 sentences: what it is and what makes it distinctive
  "explain_zh": string,  // the same, in natural 繁體中文
  "category": string     // one of: "coffee" | "tea" | "dish" | "ingredient" | "technique" | "drink" | "other"
}

Be accurate and concise; do not invent specifics you are unsure of. Traditional
Chinese only for the _zh fields. Valid JSON, no trailing commas.`;
```

with:

```ts
const SYSTEM = `You write a concise bilingual mini culinary-culture note for each
unfamiliar dish or term, for a curious diner exploring foreign / fine-dining menus.
Tone: a condensed, factual "eat the world, learn the world" guide — interesting,
never padded.

You receive a JSON array of items: { "term": <slug>, "sample_en": <a menu name>,
"sample_zh": <its 中文 name> }. For EACH item return one object with this shape, and
return ONLY a JSON array (no markdown, no commentary):
{
  "term": string,        // echo the input slug exactly
  "display_en": string,  // the canonical English name, e.g. "Linguine al Pesto"
  "display_zh": string,  // the canonical 繁體中文 name
  "explain_en": string,  // see content rules below
  "explain_zh": string,  // the same content, in natural 繁體中文
  "category": string     // "coffee" | "tea" | "dish" | "ingredient" | "technique" | "drink" | "other"
}

Content for explain_en / explain_zh (2-4 sentences, concise — shown in a small popover):
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
essay). Traditional Chinese only for the _zh fields. Valid JSON, no trailing commas.`;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (only string literals changed).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — 70 tests, unchanged (no logic touched; `explain-parse.test.ts` still guards the parse path).

- [ ] **Step 5: Build + commit**

Run: `npm run build`
Expected: PASS.

```bash
git add src/extract.ts src/explain.ts
git commit -m "feat(explain): broaden 💡 trigger + bilingual mini-guide with romanized pronunciation"
```

---

## Self-Review (author)

**Spec coverage:**
- Broaden `xterm` trigger for foreign cuisines → Step 1. ✓
- Mini-guide explanation: notable terms + romanized pronunciation (both fields) + interesting origin + conditional etymology (no 芝士/起司 justification) → Step 2. ✓
- One slug per item, slug-only in extract → preserved in Step 1 wording. ✓
- Schema/pipeline/glossary/parse/template unchanged → only the two literals edited. ✓
- Relies on existing 16000 max_tokens + salvage parser → unchanged. ✓
- Verification typecheck + test green + live acceptance; no new unit tests → Steps 3–5. ✓

**Placeholder scan:** none — exact before/after prompt text + exact commands.

**Type consistency:** No types or signatures change; the JSON schema in both prompts keeps the same six fields (`term`, `display_en`, `display_zh`, `explain_en`, `explain_zh`, `category`).
