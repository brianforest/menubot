# B2 Localization Lexicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, zero-API pass that canonicalizes transliterated dish terms in a menu's `zh` fields to the locale-best translation (Taiwan / zh-TW), keyed on the English source term.

**Architecture:** A code-defined seed loads idempotently into a new `lexicon` table (keyed by `(en_term, locale)`) in the existing glossary SQLite db. A pure `normalizeItemLexicon` gates on `item.en` and replaces known zh variants (longest-first) with the canonical; a miss-logger surfaces en-matched items whose zh hit no known variant. The pass is wired into `bot.ts` after the B1 regional pass and before render, gated by a default-on `LEXICON_NORMALIZE` flag with `TARGET_LOCALE` (default `zh-TW`).

**Tech Stack:** Node.js 20+ (`node:sqlite`, `node:test`), TypeScript ESM, tsx test runner.

## Global Constraints

- TypeScript ESM — local imports use the `.js` extension (e.g. `from "./lexicon.js"`).
- Tests: `node:test` + `node:assert/strict`, files named `src/*.test.ts`, run with `npm test`.
- Code comments / commit messages in English (per repo convention).
- Traditional-Chinese canonical target = **Taiwan (zh-TW)** wording for v1.
- No new runtime dependencies.
- Curation errs toward **omission**: a missed variant is cosmetic; a wrong rewrite misleads a diner. The `item.en` gate is the primary safety mechanism.
- New env vars are `optional()` with safe defaults, so `.env` needs no change for the suite to import config.

---

### Task 1: `lexicon` table + seed + accessors

**Files:**
- Create: `src/lexicon-seed.ts`
- Modify: `src/glossary.ts` (add table DDL in constructor ~line 35-40; import seed; call `seedLexicon()` ~line 43; add methods)
- Test: `src/glossary.test.ts` (append tests)

**Interfaces:**
- Produces:
  - `interface LexiconRow { enTerm: string; locale: string; canonical: string; variants: string[]; note: string }` and `export const LEXICON_SEED: LexiconRow[]` (in `lexicon-seed.ts`)
  - `Glossary.seedLexicon(): void`
  - `Glossary.putLexicon(enTerm: string, locale: string, canonical: string, variants: string[], note?: string): void`
  - `Glossary.getLexicon(locale: string): { enTerm: string; canonical: string; variants: string[] }[]` — the return shape is declared inline (NOT imported from `lexicon.ts`), so Task 1 is self-contained and typechecks alone. It is structurally identical to Task 2's `LexiconEntry`, so the result is assignable to `LexiconEntry[]` at the call site (bot.ts) with no import.

- [ ] **Step 1: Write the seed module**

Create `src/lexicon-seed.ts`:

```typescript
/** One curated English-term → locale-best translation mapping.
 *  `variants` are the known zh spellings the extractor emits for this term that
 *  should be rewritten to `canonical`. `enTerm` MUST be lowercase (matched as a
 *  lowercased substring of item.en). Only add rows whose canonical is the best,
 *  most common translation in that locale. */
export interface LexiconRow {
  enTerm: string;
  locale: string; // "zh-TW" | "zh-HK" | "zh-CN" | "zh-SG" | "zh-MY"
  canonical: string;
  variants: string[];
  note: string;
}

/** Conservative zh-TW starter set. Grow by appending rows (driven by the
 *  [lexicon-miss] log). Loaded via INSERT OR IGNORE, so editing a row in the db
 *  is never clobbered by this seed. The item.en gate makes short/collision-prone
 *  variants (e.g. 華夫) safe: only an actual waffle item is ever touched. */
export const LEXICON_SEED: LexiconRow[] = [
  {
    enTerm: "waffle",
    locale: "zh-TW",
    canonical: "格子鬆餅",
    variants: ["鬆餅華夫", "鬆餅格子餅", "鬆格餅", "窩夫", "華夫餅", "華夫"],
    note: "waffle; en-gate makes short variants safe",
  },
  {
    enTerm: "flat white",
    locale: "zh-TW",
    canonical: "馥芮白",
    variants: ["平白咖啡", "馥列白"],
    note: "flat white coffee",
  },
];
```

- [ ] **Step 2: Write the failing tests**

Append to `src/glossary.test.ts`:

```typescript
import { LEXICON_SEED } from "./lexicon-seed.js";

test("getLexicon returns zh-TW seed entries with variants split into arrays", () => {
  const g = new Glossary(":memory:");
  const entries = g.getLexicon("zh-TW");
  const waffle = entries.find((e) => e.enTerm === "waffle");
  assert.ok(waffle, "waffle entry present");
  assert.equal(waffle!.canonical, "格子鬆餅");
  assert.ok(waffle!.variants.includes("窩夫"));
  const zhtw = LEXICON_SEED.filter((r) => r.locale === "zh-TW");
  assert.equal(entries.length, zhtw.length);
  g.close();
});

test("getLexicon of an unseeded locale returns []", () => {
  const g = new Glossary(":memory:");
  assert.deepEqual(g.getLexicon("zh-HK"), []);
  g.close();
});

test("lexicon seed is idempotent and does not clobber an edited row", () => {
  const g = new Glossary(":memory:");
  g.putLexicon("waffle", "zh-TW", "鬆餅", ["窩夫"]); // hand-edit the canonical
  g.seedLexicon(); // re-run seed; INSERT OR IGNORE must NOT overwrite
  const waffle = g.getLexicon("zh-TW").find((e) => e.enTerm === "waffle");
  assert.equal(waffle!.canonical, "鬆餅");
  g.close();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="getLexicon|lexicon seed"`
Expected: FAIL — `getLexicon`/`putLexicon`/`seedLexicon` are not functions (and `./lexicon.js` type import may not resolve yet; if the whole file fails to compile, that is an acceptable "fail" for this step — proceed to Step 4).

- [ ] **Step 4: Implement table, seed, and accessors in `glossary.ts`**

Add the import at the top of `glossary.ts` (after the existing `REGIONAL_SEED` import):

```typescript
import { LEXICON_SEED } from "./lexicon-seed.js";
```

In the constructor's `this.db.exec(...)` DDL block, add a fourth table after `regional_variant`:

```sql
      CREATE TABLE IF NOT EXISTS lexicon (
        en_term   TEXT NOT NULL,
        locale    TEXT NOT NULL,
        canonical TEXT NOT NULL,
        variants  TEXT NOT NULL DEFAULT '',
        note      TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (en_term, locale)
      );
```

After the existing `this.seedRegional();` line in the constructor, add:

```typescript
    this.seedLexicon();
```

Add these methods to the `Glossary` class (e.g. after `getRegionalMap`):

```typescript
  /** Idempotently load the code-defined lexicon seed. Variants are stored
   *  newline-joined. INSERT OR IGNORE means a hand-edited row is never
   *  overwritten. */
  seedLexicon(): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO lexicon (en_term, locale, canonical, variants, note)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of LEXICON_SEED) {
      stmt.run(r.enTerm.toLowerCase(), r.locale, r.canonical, r.variants.join("\n"), r.note);
    }
  }

  /** Upsert a single lexicon mapping (curation / tests). */
  putLexicon(enTerm: string, locale: string, canonical: string, variants: string[], note = ""): void {
    this.db
      .prepare(
        `INSERT INTO lexicon (en_term, locale, canonical, variants, note)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(en_term, locale) DO UPDATE SET
           canonical = excluded.canonical,
           variants  = excluded.variants,
           note      = excluded.note`,
      )
      .run(enTerm.toLowerCase(), locale, canonical, variants.join("\n"), note);
  }

  /** Lexicon entries for one locale, variants split back into arrays. The return
   *  type is declared inline (structurally identical to lexicon.ts's
   *  LexiconEntry) so this module has no dependency on the application module. */
  getLexicon(locale: string): { enTerm: string; canonical: string; variants: string[] }[] {
    const rows = this.db
      .prepare("SELECT en_term, canonical, variants FROM lexicon WHERE locale = ?")
      .all(locale) as { en_term: string; canonical: string; variants: string }[];
    return rows.map((r) => ({
      enTerm: r.en_term,
      canonical: r.canonical,
      variants: r.variants.split("\n").filter(Boolean),
    }));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="getLexicon|lexicon seed"`
Expected: PASS (all three new tests). Task 1 is self-contained — `getLexicon`'s return type is inline, so nothing here depends on Task 2's `src/lexicon.ts`.

- [ ] **Step 6: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lexicon-seed.ts src/glossary.ts src/glossary.test.ts
git commit -m "feat(lexicon): lexicon table + seed + getLexicon accessor"
```

---

### Task 2: `normalizeItemLexicon` + `normalizeMenuLexicon`

**Files:**
- Create: `src/lexicon.ts`
- Test: `src/lexicon.test.ts`

**Interfaces:**
- Consumes: `LexiconEntry[]` from `Glossary.getLexicon()` (Task 1); `Menu`, `MenuItem` from `./types.js`.
- Produces:
  - `export interface LexiconEntry { enTerm: string; canonical: string; variants: string[] }`
  - `export type OnMiss = (enTerm: string, zh: string) => void`
  - `export function normalizeItemLexicon(item: MenuItem, entries: LexiconEntry[], onMiss?: OnMiss): void` (mutates the item in place)
  - `export function normalizeMenuLexicon(menu: Menu, entries: LexiconEntry[], onMiss?: OnMiss): Menu` (mutates in place + returns)

- [ ] **Step 1: Write the failing tests**

Create `src/lexicon.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeItemLexicon, normalizeMenuLexicon, type LexiconEntry } from "./lexicon.js";
import type { Menu, MenuItem } from "./types.js";

const ENTRIES: LexiconEntry[] = [
  { enTerm: "waffle", canonical: "格子鬆餅", variants: ["鬆餅華夫", "鬆餅格子餅", "鬆格餅", "窩夫", "華夫餅", "華夫"] },
  { enTerm: "flat white", canonical: "馥芮白", variants: ["平白咖啡", "馥列白"] },
];

const item = (over: Partial<MenuItem>): MenuItem => ({ en: "", zh: "", ...over });

test("en gate open: a variant in the zh name is rewritten to canonical", () => {
  const it = item({ en: "Waffle", zh: "鬆餅華夫" });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "格子鬆餅");
});

test("en gate closed: a variant-looking zh is left untouched", () => {
  const it = item({ en: "Chef Special", zh: "華夫風味" }); // en has no waffle term
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "華夫風味");
});

test("embedded term in a compound name is rewritten", () => {
  const it = item({ en: "Belgian Waffle with Berries", zh: "比利時鬆餅華夫佐莓果" });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "比利時格子鬆餅佐莓果");
});

test("longest variant wins", () => {
  const it = item({ en: "Waffle", zh: "鬆餅格子餅" });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "格子鬆餅");
});

test("miss is logged when en matches but zh is an unknown spelling", () => {
  const misses: [string, string][] = [];
  const it = item({ en: "Waffle", zh: "格仔餅" }); // 格仔餅 not a known variant
  normalizeItemLexicon(it, ENTRIES, (e, z) => misses.push([e, z]));
  assert.deepEqual(misses, [["waffle", "格仔餅"]]);
  assert.equal(it.zh, "格仔餅"); // unchanged
});

test("already-canonical: no change and no miss", () => {
  const misses: unknown[] = [];
  const it = item({ en: "Waffle", zh: "格子鬆餅" });
  normalizeItemLexicon(it, ENTRIES, (e, z) => misses.push([e, z]));
  assert.equal(it.zh, "格子鬆餅");
  assert.equal(misses.length, 0);
});

test("rewrites dzh, explain.zh, and option/choice zh of a matched item", () => {
  const it = item({
    en: "Waffle", zh: "窩夫",
    dzh: "酥脆窩夫",
    explain: { en: "waffle note", zh: "窩夫是一種鬆餅" },
    options: [{ en: "Size", zh: "窩夫尺寸", kind: "one", choices: [{ en: "Large", zh: "大窩夫", p: "" }] }],
  });
  normalizeItemLexicon(it, ENTRIES);
  assert.equal(it.zh, "格子鬆餅");
  assert.equal(it.dzh, "酥脆格子鬆餅");
  assert.equal(it.explain!.zh, "格子鬆餅是一種鬆餅");
  assert.equal(it.options![0].zh, "格子鬆餅尺寸");
  assert.equal(it.options![0].choices[0].zh, "大格子鬆餅");
});

test("normalizeMenuLexicon walks all items; empty entries is a no-op", () => {
  const menu: Menu = {
    sections: [{ en: "M", zh: "主餐", items: [item({ en: "Flat White", zh: "馥列白" })] }],
  };
  normalizeMenuLexicon(menu, []); // no-op
  assert.equal(menu.sections[0].items[0].zh, "馥列白");
  normalizeMenuLexicon(menu, ENTRIES);
  assert.equal(menu.sections[0].items[0].zh, "馥芮白");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="en gate|embedded term|longest variant|miss is logged|already-canonical|rewrites dzh|normalizeMenuLexicon"`
Expected: FAIL — `./lexicon.js` functions undefined.

- [ ] **Step 3: Implement `src/lexicon.ts`**

```typescript
import type { Menu, MenuItem } from "./types.js";

/** One locale's mapping for one English term. `variants` are known zh spellings
 *  to rewrite to `canonical`. */
export interface LexiconEntry {
  enTerm: string; // lowercase
  canonical: string;
  variants: string[];
}

/** Called when an item's en matched a term but its zh used no known variant —
 *  a curation candidate. */
export type OnMiss = (enTerm: string, zh: string) => void;

/**
 * Canonicalize transliterated dish terms in one item's zh fields to the
 * locale-best translation. Pure (except the optional onMiss callback).
 *
 * For each entry: the `item.en` (lowercased) must CONTAIN `enTerm` (the gate);
 * only then are known `variants` replaced with `canonical` inside every zh field
 * of the item, variants applied LONGEST-FIRST so a short variant cannot consume a
 * substring of a longer one. The en-gate — not word boundaries (Chinese has none)
 * — is what makes short/ambiguous variants safe. If the gate opened but no variant
 * matched and the item's zh name does not already contain `canonical`, onMiss is
 * called with a curation candidate.
 */
export function normalizeItemLexicon(item: MenuItem, entries: LexiconEntry[], onMiss?: OnMiss): void {
  if (!item.en) return;
  const en = item.en.toLowerCase();
  for (const e of entries) {
    if (!en.includes(e.enTerm)) continue; // gate closed
    const variants = [...e.variants].sort((a, b) => b.length - a.length);
    let hit = false;
    const rewrite = (s: string): string => {
      let out = s;
      for (const v of variants) {
        if (v && out.includes(v)) {
          out = out.split(v).join(e.canonical);
          hit = true;
        }
      }
      return out;
    };
    item.zh = rewrite(item.zh);
    if (item.dzh !== undefined) item.dzh = rewrite(item.dzh);
    if (item.explain) item.explain.zh = rewrite(item.explain.zh);
    for (const og of item.options ?? []) {
      og.zh = rewrite(og.zh);
      for (const c of og.choices ?? []) c.zh = rewrite(c.zh);
    }
    if (!hit && onMiss && !item.zh.includes(e.canonical)) onMiss(e.enTerm, item.zh);
  }
}

/** Apply normalizeItemLexicon to every item of the menu (mutates in place and
 *  returns it). Only item-level fields are touched — B2 is keyed on item.en. */
export function normalizeMenuLexicon(menu: Menu, entries: LexiconEntry[], onMiss?: OnMiss): Menu {
  if (entries.length === 0) return menu;
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) normalizeItemLexicon(it, entries, onMiss);
  }
  return menu;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="en gate|embedded term|longest variant|miss is logged|already-canonical|rewrites dzh|normalizeMenuLexicon"`
Expected: PASS (all eight tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lexicon.ts src/lexicon.test.ts
git commit -m "feat(lexicon): en-gated normalizeItemLexicon + normalizeMenuLexicon"
```

---

### Task 3: Config flag + bot pipeline wiring

**Files:**
- Modify: `src/config.ts` (add `lexicon` block after the `region` block ~line 70)
- Modify: `src/bot.ts` (import ~line 12; insert step after the regional `if` block ~line 243, before `const html = renderMenu(menu);`)
- Test: `src/config.test.ts` (append)

**Interfaces:**
- Consumes: `Glossary.getLexicon()` (Task 1), `normalizeMenuLexicon` (Task 2), `config.lexicon.{enabled,targetLocale}`.
- Produces: `config.lexicon.enabled: boolean` (default `true`), `config.lexicon.targetLocale: string` (default `"zh-TW"`).

- [ ] **Step 1: Write the failing config test**

Append to `src/config.test.ts`:

```typescript
test("lexicon.enabled defaults true and targetLocale defaults zh-TW", async () => {
  const { config } = await import("./config.js");
  assert.equal(config.lexicon.enabled, true);
  assert.equal(config.lexicon.targetLocale, "zh-TW");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="lexicon.enabled defaults"`
Expected: FAIL — `config.lexicon` is undefined.

- [ ] **Step 3: Add the config block**

In `src/config.ts`, add after the `region: { ... },` block (before `debug:`):

```typescript
  lexicon: {
    // Deterministic English-term → locale-best translation canonicalization of
    // zh fields (B2). Zero API, unit-tested; ON by default. Set
    // LEXICON_NORMALIZE=off to disable. TARGET_LOCALE selects which locale's
    // curated translations to apply (only zh-TW is seeded today).
    enabled: optional("LEXICON_NORMALIZE", "on").toLowerCase() !== "off",
    targetLocale: optional("TARGET_LOCALE", "zh-TW"),
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="lexicon.enabled defaults"`
Expected: PASS.

- [ ] **Step 5: Wire the pass into `bot.ts`**

Add to the imports near `import { normalizeMenu } from "./regional.js";` (~line 12):

```typescript
import { normalizeMenuLexicon } from "./lexicon.js";
```

Immediately after the existing regional `if (config.region.enabled && glossary) { ... }` block and before `const html = renderMenu(menu);` (~line 243), insert:

```typescript
    // Deterministic English-term → locale-best translation canonicalization (B2,
    // zero API). Runs after regional so it sees Taiwan-normalized text; before
    // render. The miss-logger surfaces curation candidates. Best-effort: any
    // failure logs and publishes without B2, never blocking the menu.
    if (config.lexicon.enabled && glossary) {
      try {
        normalizeMenuLexicon(menu, glossary.getLexicon(config.lexicon.targetLocale), (enTerm, zh) =>
          console.log(`[lexicon-miss] ${enTerm} ≠ ${zh}`),
        );
      } catch (e) {
        console.error("lexicon normalization failed (publishing without it):", e);
      }
    }
```

- [ ] **Step 6: Typecheck + full suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass; build compiles clean.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config.test.ts src/bot.ts
git commit -m "feat(lexicon): wire normalizeMenuLexicon into pipeline behind LEXICON_NORMALIZE (default on)"
```

---

## Verification (after all tasks)

- [ ] `npm run typecheck && npm test` — all green.
- [ ] `npm run build` — compiles clean.
- [ ] Manual sanity: unit tests prove a `Waffle`/`鬆餅華夫` item renders `格子鬆餅`, including in `dzh`/`explain.zh`/options, and that a non-waffle item containing `華夫` is left untouched (the en-gate). Production verification is a real Telegram upload by Brian.

## Deployment note (not a code task)

After merge to `main`:
`ssh mybani-prod` → `cd ~/menubot && git pull && npm install && npm run build && sudo systemctl restart menubot`. The seed loads automatically on startup (idempotent); no migration step. New env vars are optional with safe defaults, so `.env` needs no change unless overriding `LEXICON_NORMALIZE`/`TARGET_LOCALE`.
