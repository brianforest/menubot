# Adaptive Extract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each menu automatically — structurally-complex menus (offset price columns, nested spirits tables) take the proven single call; simple menus take the ~2× parallel path — behind a new `EXTRACT_MODE=adaptive`.

**Architecture:** Pass-1 `outlineMenu` gains a `complex` boolean. A new `extractMenuAdaptive` runs the outline once and branches: `complex !== false` → `extractMenuSingle` (fail-safe); otherwise the existing partition→workers→merge, reusing the already-fetched outline (no second outline call). `dispatchExtract` gains an `"adaptive"` mode. `single`/`parallel` remain manual overrides.

**Tech Stack:** Node.js 20+, TypeScript ESM, `node:test` + `node:assert/strict`, tsx runner, `@anthropic-ai/sdk`.

## Global Constraints

- TypeScript ESM — local imports use the `.js` extension (e.g. `from "./extract-merge.js"`).
- Tests: `node:test` + `node:assert/strict`, files named `src/*.test.ts`, run with `npm test`.
- Code comments / commit messages in English (per repo convention).
- No new runtime dependencies.
- Fidelity over speed: any ambiguity in the `complex` flag resolves to `single`.
- `config.ts` reads env once at import (singleton) and `process.exit(1)`s on missing
  required vars — do NOT unit-test it by re-importing with different env; test the pure
  `parseExtractMode` helper instead.
- Streaming LLM calls are already wrapped by `finalMessageWithDeadline` — do not change that.

---

### Task 1: Outline emits a `complex` boolean

**Files:**
- Modify: `src/extract-outline.ts` (the `OUTLINE_SYSTEM` template literal)
- Modify: `src/extract-merge.ts` (the `Outline` interface)
- Test: `src/extract-outline.test.ts` (create)

**Interfaces:**
- Produces: `Outline.complex?: boolean` (in `extract-merge.ts`), surfaced by the existing
  `parseOutline(text): Outline` (no logic change — `firstJsonObject` already returns the
  whole object).

- [ ] **Step 1: Add `complex` to the `Outline` interface**

In `src/extract-merge.ts`, add the field to `Outline`:

```typescript
export interface Outline {
  restaurant?: { en?: string; zh?: string };
  currency?: string;
  kind?: string;
  tags?: TagDef[];
  /** Ordered section titles only — no items. */
  sections: { en: string; zh: string }[];
  /** True if any layout makes item↔price alignment visually ambiguous (detached/
   *  offset price column, glass/bottle grid, nested spirits tables). Gates the
   *  adaptive dispatcher toward the safe single call. Missing/undefined = treat as
   *  complex (fail safe). */
  complex?: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/extract-outline.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutline } from "./extract-outline.js";

test("parseOutline surfaces complex=true", () => {
  const o = parseOutline('{"sections":[{"en":"A","zh":"甲"}],"complex":true}');
  assert.equal(o.complex, true);
});

test("parseOutline surfaces complex=false", () => {
  const o = parseOutline('{"sections":[{"en":"A","zh":"甲"}],"complex":false}');
  assert.equal(o.complex, false);
});

test("parseOutline leaves complex undefined when absent", () => {
  const o = parseOutline('{"sections":[{"en":"A","zh":"甲"}]}');
  assert.equal(o.complex, undefined);
});
```

- [ ] **Step 3: Run the test to verify it passes already (interface-only change)**

Run: `node --import tsx --test src/extract-outline.test.ts`
Expected: PASS — `parseOutline` returns the parsed object verbatim, so `complex`
already flows through once the interface allows it. (If it fails to compile, the
interface edit in Step 1 was missed.)

- [ ] **Step 4: Add the `complex` instruction to `OUTLINE_SYSTEM`**

In `src/extract-outline.ts`, the `OUTLINE_SYSTEM` template currently ends with the
`Valid JSON, no trailing commas.` line. Add `complex` to the returned-JSON shape and a
rule block. Change the JSON shape line for `sections` to be followed by `complex`:

Find:
```typescript
  "sections": [ { "en": string, "zh": string } ]     // EVERY section title, in reading order; titles only
}
```
Replace with:
```typescript
  "sections": [ { "en": string, "zh": string } ],    // EVERY section title, in reading order; titles only
  "complex": boolean                                  // see the complexity rule below
}
```

Then, immediately before the final `  Valid JSON, no trailing commas.\`;` line, insert this rule (keep it inside the template literal):
```
- Set "complex": true if ANY part of the menu uses a layout where item-to-price
  alignment is visually ambiguous — a price column detached or vertically offset from
  its item rows, a multi-column price grid (e.g. glass/bottle), or nested category
  tables (spirits lists such as COGNAC/ARMAGNAC/GIN sub-blocks under a floating price
  column). Set "complex": false ONLY if every section is a simple linear list where
  each item's price (if any) sits directly beside or below its own name. When in
  doubt, prefer true.
```

- [ ] **Step 5: Verify typecheck + tests still green**

Run: `npm run typecheck && node --import tsx --test src/extract-outline.test.ts`
Expected: typecheck clean; 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/extract-outline.ts src/extract-merge.ts src/extract-outline.test.ts
git commit -m "feat(extract): outline emits a complex layout flag"
```

---

### Task 2: `parseExtractMode` helper + `adaptive` config value

**Files:**
- Modify: `src/config.ts` (extract mode block, ~line 62-68)
- Test: `src/config.test.ts` (append)

**Interfaces:**
- Produces: `export function parseExtractMode(raw: string): "single" | "parallel" | "adaptive"`
  and `config.extract.mode` typed as that union.

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```typescript
import { parseExtractMode } from "./config.js";

test("parseExtractMode maps known modes and defaults unknown to single", () => {
  assert.equal(parseExtractMode("parallel"), "parallel");
  assert.equal(parseExtractMode("adaptive"), "adaptive");
  assert.equal(parseExtractMode("ADAPTIVE"), "adaptive");
  assert.equal(parseExtractMode("single"), "single");
  assert.equal(parseExtractMode("garbage"), "single");
  assert.equal(parseExtractMode(""), "single");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/config.test.ts`
Expected: FAIL — `parseExtractMode` is not exported.

- [ ] **Step 3: Implement the helper and use it**

In `src/config.ts`, replace the extract mode block:

Find:
```typescript
  extract: {
    // "parallel" runs the two-stage extractor (Pass-1 outline → parallel section
    // workers → merge), falling back to the single call on any failure. Default
    // "single" until A/B-verified on a real menu. Set EXTRACT_MODE=parallel.
    mode: optional("EXTRACT_MODE", "single").toLowerCase() === "parallel"
      ? "parallel"
      : "single",
```
Replace with:
```typescript
  extract: {
    // "single" (default) reads the whole menu in one call. "parallel" runs the
    // two-stage extractor (outline → parallel workers → merge). "adaptive" runs the
    // outline first and picks single for structurally-complex menus, parallel for
    // simple ones. Set EXTRACT_MODE=parallel|adaptive to override.
    mode: parseExtractMode(optional("EXTRACT_MODE", "single")),
```

Add the exported helper near the top of `src/config.ts`, after the imports (before the
`config` object is built):
```typescript
/** Parse EXTRACT_MODE; anything unrecognised falls back to the safe "single". */
export function parseExtractMode(raw: string): "single" | "parallel" | "adaptive" {
  const m = raw.toLowerCase();
  return m === "parallel" || m === "adaptive" ? m : "single";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/config.test.ts`
Expected: PASS (both config tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): EXTRACT_MODE accepts adaptive via parseExtractMode"
```

---

### Task 3: Extract `extractFromOutline` from `extractMenuParallel`

**Files:**
- Modify: `src/extract.ts` (`extractMenuParallel`, ~line 94-114)
- Test: `src/extract.test.ts` (create)

**Interfaces:**
- Produces:
  - `export interface FromOutlineDeps { extractSections: typeof extractSections }`
  - `export async function extractFromOutline(outline: Outline, sources: MenuSource[], deps?: FromOutlineDeps): Promise<Menu>`
    — the partition → workers → merge → completeness-guard body, taking a pre-computed
    outline. Throws on empty outline or a section-count mismatch (unchanged behavior).
- Consumes: `Outline` (from `./extract-merge.js`), `partitionSections`, `mergeExtract`.

- [ ] **Step 1: Write the failing test**

Create `src/extract.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromOutline } from "./extract.js";
import type { Outline, SectionsResult } from "./extract-merge.js";
import type { MenuSource } from "./types.js";

const SRC: MenuSource[] = [];
const outline = (titles: string[], complex?: boolean): Outline => ({
  sections: titles.map((t) => ({ en: t, zh: t })),
  tags: [],
  complex,
});
const sectionsResult = (titles: string[]): SectionsResult => ({
  sections: titles.map((t) => ({ en: t, zh: t, items: [{ en: t, zh: t }] })),
});

test("extractFromOutline builds a menu from the pre-computed outline", async () => {
  const menu = await extractFromOutline(outline(["A", "B"]), SRC, {
    extractSections: async (_s, _tags, titles) => sectionsResult(titles.map((t) => t.en)),
  });
  assert.deepEqual(menu.sections.map((s) => s.en), ["A", "B"]);
});

test("extractFromOutline throws when the merged section count != outline spine", async () => {
  await assert.rejects(
    () =>
      extractFromOutline(outline(["A", "B"]), SRC, {
        extractSections: async () => sectionsResult(["A"]), // only 1 of 2
      }),
    /incomplete/i,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/extract.test.ts`
Expected: FAIL — `extractFromOutline` is not exported.

- [ ] **Step 3: Refactor `extractMenuParallel` to delegate to `extractFromOutline`**

In `src/extract.ts`, replace the whole `extractMenuParallel` function (currently it
computes the outline then partitions/merges) with the split below. Keep the `ParallelDeps`
interface as-is.

```typescript
/** Injected deps for the outline→menu half (enables unit-testing without the real LLM). */
export interface FromOutlineDeps {
  extractSections: typeof extractSections;
}

/**
 * Partition a pre-computed outline into contiguous groups, run one parallel worker
 * per group (each sees all sources), and deterministically merge. Throws if the
 * outline is empty or the merged section count differs from the outline spine — a
 * short-count menu is worse than a fallback, so the caller re-runs the single call.
 */
export async function extractFromOutline(
  outline: Outline,
  sources: MenuSource[],
  deps: FromOutlineDeps = { extractSections },
): Promise<Menu> {
  if (!outline.sections?.length) throw new Error("Outline produced no sections.");
  const groups = partitionSections(outline.sections);
  const results = await Promise.all(
    groups.map((g) => deps.extractSections(sources, outline.tags ?? [], g.titles)),
  );
  const menu = mergeExtract(outline, results);
  if (menu.sections.length !== outline.sections.length) {
    throw new Error(
      `Parallel extract incomplete: ${menu.sections.length}/${outline.sections.length} sections.`,
    );
  }
  return menu;
}

/**
 * Two-stage extract: outline → extractFromOutline. Kept for EXTRACT_MODE=parallel.
 */
export async function extractMenuParallel(
  sources: MenuSource[],
  deps: ParallelDeps = { outline: outlineMenu, extractSections },
): Promise<Menu> {
  const outline = await deps.outline(sources);
  return extractFromOutline(outline, sources, { extractSections: deps.extractSections });
}
```

Add `Outline` to the imports from `./extract-merge.js` at the top of `src/extract.ts`
(the file already imports `mergeExtract` from there):
```typescript
import { mergeExtract, type Outline } from "./extract-merge.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/extract.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the whole suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/extract.ts src/extract.test.ts
git commit -m "refactor(extract): split extractFromOutline out of extractMenuParallel"
```

---

### Task 4: `extractMenuAdaptive` + adaptive dispatch

**Files:**
- Modify: `src/extract.ts` (`DispatchDeps`, `dispatchExtract`, `extractMenu`; add `extractMenuAdaptive`)
- Test: `src/extract.test.ts` (append)

**Interfaces:**
- Consumes: `extractFromOutline`, `extractMenuSingle`, `outlineMenu`, `extractSections`.
- Produces:
  - `export interface AdaptiveDeps { outline: typeof outlineMenu; extractSections: typeof extractSections; single: typeof extractMenuSingle }`
  - `export async function extractMenuAdaptive(sources: MenuSource[], deps?: AdaptiveDeps): Promise<Menu>`
  - `dispatchExtract(sources, mode, deps)` accepts `mode: "single" | "parallel" | "adaptive"`
    with `DispatchDeps` gaining `adaptive: typeof extractMenuAdaptive`.

- [ ] **Step 1: Write the failing tests**

Append to `src/extract.test.ts`:

```typescript
import { extractMenuAdaptive } from "./extract.js";
import type { Menu } from "./types.js";

const SINGLE: Menu = { sections: [{ en: "SINGLE", zh: "單", items: [] }] };

test("adaptive: complex outline → single, workers never run", async () => {
  let workers = 0;
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => outline(["A", "B"], true),
    extractSections: async () => {
      workers++;
      return sectionsResult(["A"]);
    },
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
  assert.equal(workers, 0);
});

test("adaptive: simple outline → parallel path, outline fetched exactly once", async () => {
  let outlineCalls = 0;
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => {
      outlineCalls++;
      return outline(["A", "B"], false);
    },
    extractSections: async (_s, _tags, titles) => sectionsResult(titles.map((t) => t.en)),
    single: async () => SINGLE,
  });
  assert.deepEqual(menu.sections.map((s) => s.en), ["A", "B"]);
  assert.equal(outlineCalls, 1);
});

test("adaptive: complex flag absent → single (fail safe)", async () => {
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => outline(["A"]), // complex undefined
    extractSections: async () => sectionsResult(["A"]),
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
});

test("adaptive: outline throws → single fallback", async () => {
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => {
      throw new Error("outline boom");
    },
    extractSections: async () => sectionsResult(["A"]),
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
});

test("adaptive: simple but parallel completeness fails → single fallback", async () => {
  const menu = await extractMenuAdaptive(SRC, {
    outline: async () => outline(["A", "B"], false),
    extractSections: async () => sectionsResult(["A"]), // 1 of 2 → mismatch → throw
    single: async () => SINGLE,
  });
  assert.equal(menu.sections[0].en, "SINGLE");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/extract.test.ts`
Expected: FAIL — `extractMenuAdaptive` is not exported.

- [ ] **Step 3: Implement `extractMenuAdaptive` and wire dispatch**

In `src/extract.ts`, add after `extractMenuParallel`:

```typescript
/** Injected deps for the adaptive dispatcher (enables unit-testing without the LLM). */
export interface AdaptiveDeps {
  outline: typeof outlineMenu;
  extractSections: typeof extractSections;
  single: typeof extractMenuSingle;
}

/**
 * Run the outline once, then pick a path: a structurally-complex menu (offset price
 * columns, nested spirits tables) takes the proven single call; a simple menu takes the
 * parallel path, reusing the already-fetched outline (no second outline call). Any
 * outline failure, a missing/ambiguous `complex` flag, or a parallel completeness miss
 * all fall back to single.
 */
export async function extractMenuAdaptive(
  sources: MenuSource[],
  deps: AdaptiveDeps = { outline: outlineMenu, extractSections, single: extractMenuSingle },
): Promise<Menu> {
  let outline: Outline;
  try {
    outline = await deps.outline(sources);
  } catch (e) {
    console.error("Adaptive: outline failed; single fallback:", e);
    return deps.single(sources);
  }
  // Only a definite `complex === false` takes the parallel path; complex or
  // missing/ambiguous falls back to the safe single call.
  if (outline.complex !== false) return deps.single(sources);
  try {
    return await extractFromOutline(outline, sources, { extractSections: deps.extractSections });
  } catch (e) {
    console.error("Adaptive: parallel path failed; single fallback:", e);
    return deps.single(sources);
  }
}
```

Then extend the dispatcher. Replace the `DispatchDeps` interface and `dispatchExtract`:

Find:
```typescript
export interface DispatchDeps {
  parallel: typeof extractMenuParallel;
  single: typeof extractMenuSingle;
}
```
Replace with:
```typescript
export interface DispatchDeps {
  parallel: typeof extractMenuParallel;
  single: typeof extractMenuSingle;
  adaptive: typeof extractMenuAdaptive;
}
```

Find:
```typescript
export async function dispatchExtract(
  sources: MenuSource[],
  mode: "single" | "parallel",
  deps: DispatchDeps = { parallel: extractMenuParallel, single: extractMenuSingle },
): Promise<Menu> {
  if (mode === "parallel") {
    try {
      return await deps.parallel(sources);
    } catch (e) {
      console.error("Parallel extract failed; falling back to single call:", e);
    }
  }
  return deps.single(sources);
}
```
Replace with:
```typescript
export async function dispatchExtract(
  sources: MenuSource[],
  mode: "single" | "parallel" | "adaptive",
  deps: DispatchDeps = {
    parallel: extractMenuParallel,
    single: extractMenuSingle,
    adaptive: extractMenuAdaptive,
  },
): Promise<Menu> {
  if (mode === "adaptive") return deps.adaptive(sources); // handles its own fallback
  if (mode === "parallel") {
    try {
      return await deps.parallel(sources);
    } catch (e) {
      console.error("Parallel extract failed; falling back to single call:", e);
    }
  }
  return deps.single(sources);
}
```

`extractMenu` needs no change — it already forwards `config.extract.mode`, whose type now
includes `"adaptive"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/extract.test.ts`
Expected: PASS (all 7 tests in the file).

- [ ] **Step 5: Verify the whole suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/extract.ts src/extract.test.ts
git commit -m "feat(extract): adaptive dispatch (complex→single, simple→parallel)"
```

---

## Rollout (after merge)

- Deploy with production `EXTRACT_MODE` unchanged (`single`).
- To activate: set `EXTRACT_MODE=adaptive` in the VPS `.env`, restart, and verify on
  one known-simple menu (should run parallel / faster) and one known-complex menu
  (Terrace — should run single, prices correct). `DEBUG_TIMING=on` shows the breakdown.
- `single` / `parallel` remain as manual overrides.
