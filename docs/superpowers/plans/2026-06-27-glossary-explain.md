# Cuisine Explanations + Glossary Cache Implementation Plan (P2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain not-widely-known menu items via a 💡 popover, backed by a persistent SQLite glossary so a term is explained by the LLM at most once.

**Architecture:** Extraction flags items with a canonical `xterm` slug. A glossary-first `enrichMenu` step looks each term up in a `node:sqlite` glossary; cache hits cost 0 tokens, cache misses go to one `explainTerms` LLM call and are stored. Enriched items carry `explain {en,zh}`, which the self-contained page shows in a tap-to-open popover. Enrichment is wrapped so a failure never blocks publishing.

**Tech Stack:** Node.js (ESM, TypeScript), `@anthropic-ai/sdk`, `node:sqlite` (built-in; verified on VPS Node 24.15 with no flag and no native dependency), self-contained HTML/CSS/JS template. Tests via `node:test` under `tsx`.

## Global Constraints

- Comments/commit messages English; user-facing copy bilingual 繁中+English.
- ESM: intra-project imports use the `.js` extension.
- Keep `claude-sonnet-4-6`, streaming, and the existing extraction `max_tokens: 32000`.
- The project must `npm run typecheck` and `npm test` clean at every commit.
- **Pure / DI-testable modules must not import `config.ts`** (it `process.exit`s on missing env at import, which kills the test runner): `glossary.ts`, `explain-parse.ts`, `enrich.ts`, and `types.ts` must be config-free. `explain.ts` (which constructs the Anthropic client) imports config and is NOT unit-tested (its pure parser lives in `explain-parse.ts`).
- Glossary db path comes from config `GLOSSARY_DB`, default `data/glossary.db`; `data/` is git-ignored.
- `enrichMenu` is resilient: the caller wraps it so any failure logs and proceeds with the un-enriched menu.

---

### Task 1: Data model + config + gitignore

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `MenuItem.xterm?: string`; `MenuItem.explain?: { en: string; zh: string }`; `GlossaryEntry`; `ExplainRequest`; `config.glossary.dbPath`.

- [ ] **Step 1: Extend `MenuItem` and add `GlossaryEntry` + `ExplainRequest` in `src/types.ts`**

In `src/types.ts`, change the `MenuItem` interface by adding two fields (keep the existing fields), and append the two new interfaces at the end of the file.

Add inside `MenuItem` (after `dzh?: string;`):

```ts
  /** Extraction output: canonical lowercase-hyphen slug when this item needs a
   *  cuisine explanation (e.g. "flat-white"); absent/"" otherwise. */
  xterm?: string;
  /** Filled by enrichMenu from the glossary/explain step. */
  explain?: { en: string; zh: string };
```

Append at the end of the file:

```ts
/** A cached glossary entry (one explained culinary term). */
export interface GlossaryEntry {
  term: string;        // canonical slug (primary key)
  display_en: string;  // "Flat White"
  display_zh: string;  // "馥芮白"
  explain_en: string;
  explain_zh: string;
  category: string;    // "coffee" | "dish" | "ingredient" | "technique" | …
}

/** One term to be explained, with a sample item name for context. */
export interface ExplainRequest {
  term: string;
  sample_en: string;
  sample_zh: string;
}
```

- [ ] **Step 2: Add the glossary path to `src/config.ts`**

In `src/config.ts`, add a `glossary` block to the exported `config` object (after the `github` block):

```ts
  github: {
    token: required("GITHUB_TOKEN"),
    owner,
    repo,
    branch: optional("GITHUB_BRANCH", "main"),
    pagesDir: optional("PAGES_DIR", "docs"),
    baseUrl:
      optional("PAGES_BASE_URL") ||
      `https://${owner}.github.io/${repo}`,
  },
  glossary: {
    dbPath: optional("GLOSSARY_DB", "data/glossary.db"),
  },
} as const;
```

- [ ] **Step 3: Ignore the `data/` directory**

In `.gitignore`, add a `data` line after `dist`:

```
node_modules
dist
data
.env
*.log
.DS_Store
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; tests still 14/14 (no behaviour changed).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts .gitignore
git commit -m "feat(types): item xterm/explain, GlossaryEntry, ExplainRequest; glossary config"
```

---

### Task 2: Glossary store (`src/glossary.ts`)

**Files:**
- Create: `src/glossary.ts`
- Test: `src/glossary.test.ts`

**Interfaces:**
- Consumes: `GlossaryEntry` (Task 1).
- Produces: `class Glossary` with `getMany(terms: string[]): Map<string, GlossaryEntry>`, `put(entry: GlossaryEntry, createdAt: string): void`, `putAlias(alias: string, term: string): void`, `close(): void`.

- [ ] **Step 1: Write the failing test**

Create `src/glossary.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Glossary } from "./glossary.js";

const entry = (term: string, ex = "x") => ({
  term, display_en: term, display_zh: term,
  explain_en: ex, explain_zh: ex, category: "dish",
});

test("put then getMany returns the stored entry, keyed by requested term", () => {
  const g = new Glossary(":memory:");
  g.put(entry("flat-white", "a small espresso drink"), "2026-06-27");
  const got = g.getMany(["flat-white", "unknown"]);
  assert.equal(got.size, 1);
  assert.equal(got.get("flat-white")?.explain_en, "a small espresso drink");
  assert.equal(got.get("unknown"), undefined);
  g.close();
});

test("getMany on empty input returns an empty map", () => {
  const g = new Glossary(":memory:");
  assert.equal(g.getMany([]).size, 0);
  g.close();
});

test("put upserts (second put overwrites)", () => {
  const g = new Glossary(":memory:");
  g.put(entry("laksa", "old"), "2026-06-27");
  g.put(entry("laksa", "new"), "2026-06-27");
  assert.equal(g.getMany(["laksa"]).get("laksa")?.explain_en, "new");
  g.close();
});

test("alias routes alias->canonical on lookup", () => {
  const g = new Glossary(":memory:");
  g.put(entry("flat-white", "the canonical one"), "2026-06-27");
  g.putAlias("flatwhite", "flat-white");
  const got = g.getMany(["flatwhite"]);
  assert.equal(got.get("flatwhite")?.explain_en, "the canonical one");
  g.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './glossary.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/glossary.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GlossaryEntry } from "./types.js";

const SELECT_COLS =
  "term, display_en, display_zh, explain_en, explain_zh, category";

/**
 * Persistent cache of explained culinary terms, backed by node:sqlite.
 * Config-free: the db path is passed in, so tests use ":memory:".
 */
export class Glossary {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
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
    `);
  }

  /** Look up many terms (resolving aliases); returns found entries keyed by the
   *  REQUESTED term so callers can map item.xterm -> entry directly. */
  getMany(terms: string[]): Map<string, GlossaryEntry> {
    const out = new Map<string, GlossaryEntry>();
    if (!terms.length) return out;
    const aliasStmt = this.db.prepare("SELECT term FROM alias WHERE alias = ?");
    const getStmt = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM glossary WHERE term = ?`,
    );
    for (const t of terms) {
      const a = aliasStmt.get(t) as { term: string } | undefined;
      const row = getStmt.get(a ? a.term : t) as GlossaryEntry | undefined;
      if (row) out.set(t, row);
    }
    return out;
  }

  /** Insert or update a glossary entry. */
  put(entry: GlossaryEntry, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO glossary
           (term, display_en, display_zh, explain_en, explain_zh, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(term) DO UPDATE SET
           display_en = excluded.display_en,
           display_zh = excluded.display_zh,
           explain_en = excluded.explain_en,
           explain_zh = excluded.explain_zh,
           category   = excluded.category`,
      )
      .run(
        entry.term, entry.display_en, entry.display_zh,
        entry.explain_en, entry.explain_zh, entry.category, createdAt,
      );
  }

  /** Map an alias to a canonical term (for manual curation; future use). */
  putAlias(alias: string, term: string): void {
    this.db
      .prepare(
        `INSERT INTO alias (alias, term) VALUES (?, ?)
         ON CONFLICT(alias) DO UPDATE SET term = excluded.term`,
      )
      .run(alias, term);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (4 glossary tests + the 14 prior). A single `ExperimentalWarning: SQLite …` line on stderr is expected and harmless.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/glossary.ts src/glossary.test.ts
git commit -m "feat(glossary): node:sqlite-backed explanation cache"
```

---

### Task 3: Explanation parser + generator (`src/explain-parse.ts`, `src/explain.ts`)

**Files:**
- Create: `src/explain-parse.ts`
- Test: `src/explain-parse.test.ts`
- Create: `src/explain.ts`

**Interfaces:**
- Consumes: `GlossaryEntry`, `ExplainRequest` (Task 1).
- Produces: `parseExplainResponse(text: string): GlossaryEntry[]` (pure); `explainTerms(reqs: ExplainRequest[]): Promise<GlossaryEntry[]>` (LLM).

- [ ] **Step 1: Write the failing test for the pure parser**

Create `src/explain-parse.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExplainResponse } from "./explain-parse.js";

test("parses a JSON array of entries, tolerating surrounding prose", () => {
  const text = `Here you go:
  [
    {"term":"flat-white","display_en":"Flat White","display_zh":"馥芮白",
     "explain_en":"An espresso drink with steamed milk.","explain_zh":"濃縮咖啡加蒸奶。","category":"coffee"}
  ] done`;
  const out = parseExplainResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "flat-white");
  assert.equal(out[0].display_zh, "馥芮白");
  assert.equal(out[0].category, "coffee");
});

test("drops entries with no term and defaults missing fields to empty strings", () => {
  const text = `[{"term":"laksa"}, {"display_en":"no term"}]`;
  const out = parseExplainResponse(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "laksa");
  assert.equal(out[0].explain_en, "");
});

test("throws when there is no JSON array", () => {
  assert.throws(() => parseExplainResponse("no array here"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './explain-parse.js'`.

- [ ] **Step 3: Write the pure parser**

Create `src/explain-parse.ts`:

```ts
import type { GlossaryEntry } from "./types.js";

/** Pull the first balanced JSON array out of the model's text and normalise it
 *  into GlossaryEntry[]. Pure (no config, no network) so it is unit-testable. */
export function parseExplainResponse(text: string): GlossaryEntry[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new Error("Model did not return a JSON array:\n" + text.slice(0, 300));
  }
  const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
  return arr
    .map((raw) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      return {
        term: String(e.term ?? ""),
        display_en: String(e.display_en ?? ""),
        display_zh: String(e.display_zh ?? ""),
        explain_en: String(e.explain_en ?? ""),
        explain_zh: String(e.explain_zh ?? ""),
        category: String(e.category ?? ""),
      };
    })
    .filter((e) => e.term);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (3 parser tests + prior).

- [ ] **Step 5: Write the LLM generator**

Create `src/explain.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { GlossaryEntry, ExplainRequest } from "./types.js";
import { parseExplainResponse } from "./explain-parse.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

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

/** Explain cache-miss terms in one streamed call. Returns [] for empty input
 *  WITHOUT calling the API. */
export async function explainTerms(
  reqs: ExplainRequest[],
): Promise<GlossaryEntry[]> {
  if (!reqs.length) return [];
  const resp = await client.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(reqs) }],
    })
    .finalMessage();
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseExplainResponse(text);
}
```

- [ ] **Step 6: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; parser tests pass. (`explain.ts` is not imported by any test — it constructs the Anthropic client at import, which needs env.)

- [ ] **Step 7: Commit**

```bash
git add src/explain-parse.ts src/explain-parse.test.ts src/explain.ts
git commit -m "feat(explain): bilingual term explainer (pure parser + LLM call)"
```

---

### Task 4: Enrichment orchestrator (`src/enrich.ts`)

**Files:**
- Create: `src/enrich.ts`
- Test: `src/enrich.test.ts`

**Interfaces:**
- Consumes: `Menu`, `GlossaryEntry`, `ExplainRequest` (Task 1).
- Produces: `interface GlossaryLike`; `type ExplainFn`; `enrichMenu(menu, glossary, explainFn, now): Promise<Menu>`.

- [ ] **Step 1: Write the failing test**

Create `src/enrich.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichMenu, type GlossaryLike } from "./enrich.js";
import type { GlossaryEntry, Menu } from "./types.js";

class FakeGlossary implements GlossaryLike {
  store = new Map<string, GlossaryEntry>();
  getMany(terms: string[]) {
    const m = new Map<string, GlossaryEntry>();
    for (const t of terms) { const e = this.store.get(t); if (e) m.set(t, e); }
    return m;
  }
  put(e: GlossaryEntry) { this.store.set(e.term, e); }
}

const entry = (term: string, ex: string): GlossaryEntry => ({
  term, display_en: term, display_zh: term,
  explain_en: ex, explain_zh: ex + "(zh)", category: "dish",
});

const menuWith = (xterm?: string): Menu => ({
  sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲", xterm }] }],
});

test("cached term attaches explain WITHOUT calling explainFn", async () => {
  const g = new FakeGlossary();
  g.store.set("laksa", entry("laksa", "a spicy noodle soup"));
  let calls = 0;
  const out = await enrichMenu(menuWith("laksa"), g, async () => { calls++; return []; }, "t");
  assert.equal(calls, 0);
  assert.deepEqual(out.sections[0].items[0].explain, { en: "a spicy noodle soup", zh: "a spicy noodle soup(zh)" });
});

test("cache miss calls explainFn once, stores, and attaches", async () => {
  const g = new FakeGlossary();
  let calls = 0;
  const out = await enrichMenu(menuWith("confit"), g, async (reqs) => {
    calls++;
    assert.equal(reqs[0].term, "confit");
    return [entry("confit", "slow-cooked in fat")];
  }, "t");
  assert.equal(calls, 1);
  assert.equal(out.sections[0].items[0].explain?.en, "slow-cooked in fat");
  assert.ok(g.store.has("confit"), "stored for next time");
});

test("no xterms → explainFn not called, no explain attached", async () => {
  const g = new FakeGlossary();
  let calls = 0;
  const out = await enrichMenu(menuWith(undefined), g, async () => { calls++; return []; }, "t");
  assert.equal(calls, 0);
  assert.equal(out.sections[0].items[0].explain, undefined);
});

test("second enrich of the same term is a pure cache hit", async () => {
  const g = new FakeGlossary();
  let calls = 0;
  const explain: any = async () => { calls++; return [entry("confit", "x")]; };
  await enrichMenu(menuWith("confit"), g, explain, "t");
  await enrichMenu(menuWith("confit"), g, explain, "t");
  assert.equal(calls, 1, "explained once, then cached");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './enrich.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/enrich.ts`:

```ts
import type { Menu, GlossaryEntry, ExplainRequest } from "./types.js";

/** The subset of Glossary that enrichMenu needs (so tests can inject a fake). */
export interface GlossaryLike {
  getMany(terms: string[]): Map<string, GlossaryEntry>;
  put(entry: GlossaryEntry, createdAt: string): void;
}

export type ExplainFn = (reqs: ExplainRequest[]) => Promise<GlossaryEntry[]>;

/**
 * Glossary-first enrichment: attach a bilingual explanation to every item that
 * carries an `xterm`. Cache hits cost nothing; cache misses go to explainFn once
 * and are stored. Returns the same menu object (mutated in place + returned).
 */
export async function enrichMenu(
  menu: Menu,
  glossary: GlossaryLike,
  explainFn: ExplainFn,
  now: string,
): Promise<Menu> {
  // distinct xterms + one sample item name per term (for explain context)
  const sampleByTerm = new Map<string, { en: string; zh: string }>();
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const t = (it.xterm ?? "").trim();
      if (t && !sampleByTerm.has(t)) sampleByTerm.set(t, { en: it.en, zh: it.zh });
    }
  }
  const terms = [...sampleByTerm.keys()];
  if (!terms.length) return menu;

  const byTerm = new Map<string, GlossaryEntry>(glossary.getMany(terms));
  const misses = terms.filter((t) => !byTerm.has(t));
  if (misses.length) {
    const reqs: ExplainRequest[] = misses.map((t) => ({
      term: t,
      sample_en: sampleByTerm.get(t)!.en,
      sample_zh: sampleByTerm.get(t)!.zh,
    }));
    for (const e of await explainFn(reqs)) {
      glossary.put(e, now);
      byTerm.set(e.term, e);
    }
  }

  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const t = (it.xterm ?? "").trim();
      const e = t ? byTerm.get(t) : undefined;
      if (e) it.explain = { en: e.explain_en, zh: e.explain_zh };
    }
  }
  return menu;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (4 enrich tests + prior).

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/enrich.ts src/enrich.test.ts
git commit -m "feat(enrich): glossary-first explanation attachment (DI, resilient)"
```

---

### Task 5: Extraction — flag items needing explanation (`src/extract.ts`)

**Files:**
- Modify: `src/extract.ts` (the `SYSTEM` prompt only)

> Prompt-only change; gate `npm run typecheck` + `npm test` stay green.

- [ ] **Step 1: Add `xterm` to the item schema in the prompt**

In the `SYSTEM` string in `src/extract.ts`, inside the item object schema, add an `xterm` line after the `"tags"` line. Change:

```
          "tags": string[],                          // ids of the tags above this item carries; [] if none
          "den": string,                             // English description if present, else ""
```

to:

```
          "tags": string[],                          // ids of the tags above this item carries; [] if none
          "xterm": string,                           // see "Explanations" below; "" if not needed
          "den": string,                             // English description if present, else ""
```

- [ ] **Step 2: Add the Explanations rubric to the prompt**

In the same `SYSTEM` string, add this block immediately before the `Other rules:` section:

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

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: clean; tests unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/extract.ts
git commit -m "feat(extract): flag not-widely-known items with an xterm slug"
```

---

### Task 6: Bot wiring — enrich between extract and render (`src/bot.ts`)

**Files:**
- Modify: `src/bot.ts`

> No unit test (Telegram wiring). Gate: `npm run typecheck` + `npm test` green + `npm run build` clean.

- [ ] **Step 1: Add imports**

In `src/bot.ts`, after the existing import of `publishMenu`, add:

```ts
import { Glossary } from "./glossary.js";
import { enrichMenu } from "./enrich.js";
import { explainTerms } from "./explain.js";
```

- [ ] **Step 2: Construct one module-level Glossary**

In `src/bot.ts`, just after `const store = new BatchStore();`, add:

```ts
const glossary = new Glossary(config.glossary.dbPath);
```

- [ ] **Step 3: Enrich the menu before rendering**

In `processBatch`, find:

```ts
    const menu = await extractMenu(sources);

    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);
    const html = renderMenu(menu);
```

and change it to enrich first (resilient — never block publishing):

```ts
    const menu = await extractMenu(sources);

    try {
      await enrichMenu(menu, glossary, explainTerms, new Date().toISOString());
    } catch (e) {
      console.error("enrichMenu failed (publishing without explanations):", e);
    }

    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);
    const html = renderMenu(menu);
```

(`enrichMenu` mutates `menu` in place, so the existing `renderMenu(menu)` already sees the explanations.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean; tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): glossary-first enrichment between extract and publish"
```

---

### Task 7: Template — 💡 explanation popover (`templates/menu.html` + render test)

**Files:**
- Modify: `templates/menu.html`
- Modify: `src/render.test.ts`

**Interfaces:**
- Consumes: `MenuItem.explain` (rides inside the embedded `MENU` sections).

> The page JS is not unit-tested; a render test guards the data path. Manual browser acceptance for the popover itself.

- [ ] **Step 1: Add a render test that `explain` reaches the page**

Append to `src/render.test.ts`:

```ts
test("renderMenu embeds an item's explanation when present", () => {
  const html = renderMenu({
    sections: [{ en: "S", zh: "區", items: [
      { en: "Flat White", zh: "馥芮白", explain: { en: "Espresso with steamed milk.", zh: "濃縮咖啡加蒸奶。" } },
    ] }],
  });
  assert.ok(html.includes("Espresso with steamed milk."), "explanation EN embedded");
  assert.ok(html.includes("濃縮咖啡加蒸奶。"), "explanation ZH embedded");
});
```

- [ ] **Step 2: Run it to confirm it passes already (render embeds sections verbatim)**

Run: `npm test`
Expected: PASS — `render.ts` serialises `sections` (including `explain`) into `{{MENU_JSON}}`, so this guards the contract.

- [ ] **Step 3: Add popover CSS**

In `templates/menu.html` `<style>`, after the `.item .tags { ... }` rule, add the meta-row, button, and popover styles:

```css
  .item .meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .item .tags { font-size: 15px; letter-spacing: 1px; }
  .explain { font: inherit; font-size: 15px; line-height: 1; border: 1px solid var(--line);
    background: var(--card); border-radius: 999px; padding: 3px 7px; cursor: pointer; }
  .popover { position: absolute; z-index: 50; max-width: 300px; background: var(--card);
    border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; font-size: 15px;
    line-height: 1.5; box-shadow: 0 8px 24px rgba(0,0,0,.16); }
  .popover[hidden] { display: none; }
  .popover .pen { display: block; }
  .popover .pzh { display: block; color: #4a4a4f; margin-top: 6px; }
  body.lang-zh .popover .pen { display: none; }
  body.lang-en .popover .pzh { display: none; }
```

Also change the existing `.item .tags` rule from Task P2a (`display: block; margin-top: 4px;`) — it is replaced by the two rules above (the `.meta` flex row now owns spacing). If a standalone `.item .tags { display: block; margin-top: 4px; font-size: 15px; letter-spacing: 1px; }` rule still exists, delete it (the new `.item .tags` rule above is its replacement).

- [ ] **Step 4: Add the popover element to the page body**

In `templates/menu.html`, just before `</body>` (after the `<footer>...</footer>` and `<button id="toTop">`), add:

```html
<div id="popover" class="popover" hidden></div>
```

- [ ] **Step 5: Render the 💡 button and wrap tags in a `.meta` row, in the page script**

In the `MENU.forEach` item template, replace the left-column markup. Currently:

```js
        <div>
          <div class="name">${esc(it.en)}</div>
          <div class="name-zh">${esc(it.zh)}</div>
          ${tags}
        </div>${price}
```

with (compute `explain` button, wrap tags + button in `.meta`):

```js
        <div>
          <div class="name">${esc(it.en)}</div>
          <div class="name-zh">${esc(it.zh)}</div>
          <div class="meta">${tags}${explain}</div>
        </div>${price}
```

And, in the same `.map` callback where `const tags = ...` is computed, add right after it:

```js
    const explain = it.explain
      ? `<button class="explain" aria-label="explanation" data-en="${esc(it.explain.en)}" data-zh="${esc(it.explain.zh)}">💡</button>`
      : "";
```

- [ ] **Step 6: Add the popover open/close behaviour in the page script**

In the page `<script>`, just before the language-toggle block (`document.querySelectorAll(".lang-toggle button")...`), add:

```js
// Explanation popover: tap 💡 to open near the button; tap elsewhere to close.
const pop = document.getElementById("popover");
menuEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".explain");
  if (!btn) return;
  e.stopPropagation();
  pop.innerHTML = `<span class="pen"></span><span class="pzh"></span>`;
  pop.querySelector(".pen").textContent = btn.getAttribute("data-en") || "";
  pop.querySelector(".pzh").textContent = btn.getAttribute("data-zh") || "";
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const maxLeft = scrollX + document.documentElement.clientWidth - pop.offsetWidth - 12;
  pop.style.top = (scrollY + r.bottom + 6) + "px";
  pop.style.left = Math.max(scrollX + 12, Math.min(scrollX + r.left, maxLeft)) + "px";
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".explain") && !e.target.closest("#popover")) pop.hidden = true;
});
```

- [ ] **Step 7: Verify tests + build + smoke-render**

Run: `npm test && npm run typecheck && npm run build`
Expected: tests PASS (incl. the new render test), typecheck + build clean.

Then smoke-render a page with an explained item (no file committed):

```bash
node --import tsx -e '
import { renderMenu } from "./src/render.ts";
const html = renderMenu({restaurant:{en:"Cafe",zh:"咖啡館"},sections:[{en:"Coffee",zh:"咖啡",items:[
  {en:"Flat White",zh:"馥芮白",tags:[],explain:{en:"Espresso with steamed milk.",zh:"濃縮咖啡加蒸奶。"}}
]}]});
const fs = await import("node:fs"); fs.writeFileSync("/tmp/menubot-explain.html", html);
console.log("has popover:", html.includes("id=\"popover\""), "has 💡:", html.includes("💡"), "no placeholder:", !html.includes("{{"));
'
```

Expected: `has popover: true has 💡: true no placeholder: true`.

- [ ] **Step 8: Commit**

```bash
git add templates/menu.html src/render.test.ts
git commit -m "feat(template): 💡 tap-to-open bilingual explanation popover"
```

---

### Task 8: Docs touch-up (`README.md`)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Note explanations + glossary in "How it works" step 2**

In `README.md`, in the step that describes extraction/tagging, append a sentence about explanations. Change the end of step 2 to also mention:

```
   …and tags each item with the menu's own classification labels (dietary,
   allergen, "Highlight"/signature, …). Works for non-food menus too (e.g. spa).
   Items a traveller might not recognise (e.g. Flat White, Laksa) get a short
   bilingual explanation behind a 💡, cached in a local glossary so each term is
   explained at most once.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README notes cuisine explanations and the glossary cache"
```

---

## Self-Review

**1. Spec coverage:**
- #7 explanations + 💡 popover (tap to open, tap elsewhere to close), medium criteria → Tasks 5 (xterm + rubric), 7 (popover). ✓
- #8 SQLite glossary, cache-first (0 tokens on hit, explain miss once, store) → Tasks 1 (config/types), 2 (glossary), 3 (explain), 4 (enrich), 6 (wiring). ✓
- Glossary-first data flow + resilient enrichment → Tasks 4 (logic), 6 (try/catch). ✓
- node:sqlite, no native dep, db path from config, data/ ignored → Tasks 1, 2. ✓
- DI for testability (no config in pure modules) → Tasks 2 (path arg), 3 (explain-parse split), 4 (GlossaryLike + ExplainFn). ✓

**2. Placeholder scan:** No TBD/TODO; full code in every step.

**3. Type consistency:** `GlossaryEntry`/`ExplainRequest`/`MenuItem.xterm`/`MenuItem.explain` (Task 1) used identically across glossary (Task 2), explain (Task 3), enrich (Task 4), and the template (Task 7). `Glossary.getMany/put/putAlias` signatures match `GlossaryLike` (Task 4) and the bot's usage (Task 6). `explainTerms` signature (Task 3) matches `ExplainFn` (Task 4) and the bot call (Task 6). `parseExplainResponse` (Task 3) returns `GlossaryEntry[]`. The template's `it.explain.{en,zh}` matches the field shape set in `enrichMenu`. `data-en`/`data-zh`/`.meta`/`.pen`/`.pzh`/`#popover` are internally consistent within Task 7.
