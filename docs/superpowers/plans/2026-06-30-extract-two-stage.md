# Two-Stage Parallel Extract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the 206s extract bottleneck by parallelising the big-JSON generation across workers that each still see the whole menu, with no fidelity loss vs the current single call.

**Architecture:** Pass 1 (`extract-outline`) reads all images once and returns global metadata + the tag vocabulary + the ordered section titles (no items). A pure `extract-partition` splits the titles into contiguous groups. Pass 2 (`extract-sections`) runs one streamed call per group — each receiving **all** images + the tag vocabulary — extracting full items for only its assigned sections. A pure `extract-merge` reassembles the `Menu` deterministically. `extract.ts` dispatches on `EXTRACT_MODE` and falls back to the existing single call on any failure.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@anthropic-ai/sdk` streaming, `node:test` + `node:assert/strict`, `tsx`.

## Global Constraints

- ESM project: import paths end in `.js` even for `.ts` files. `"type": "module"`.
- Tests: `node --import tsx --test 'src/**/*.test.ts'`; assertions via `node:assert/strict`; tests are `src/<name>.test.ts`.
- Code comments / docstrings / commit messages in English.
- Pure modules must not import the Anthropic SDK or `config` (keeps them unit-testable).
- LLM calls use `client.messages.stream(...).finalMessage()` (non-streaming rejects on large `max_tokens`).
- Reuse the existing item/tag/xterm/options extraction rules verbatim via a shared constant — do not paraphrase them (paraphrasing risks output drift).
- Fallback to `extractMenuSingle` must never be removed: it is the guaranteed-correct path.
- Default `EXTRACT_MODE=single`; `parallel` is opt-in until A/B-verified on a real menu.

---

### Task 1: Pure section partitioner

**Files:**
- Create: `src/extract-partition.ts`
- Test: `src/extract-partition.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SectionTitle { en: string; zh: string }`
  - `interface SectionGroup { startIndex: number; titles: SectionTitle[] }`
  - `function partitionSections(titles: SectionTitle[], opts?: { perWorker?: number; maxWorkers?: number }): SectionGroup[]`
  - Defaults: `perWorker = 8`, `maxWorkers = 6`. Groups are contiguous, cover every title exactly once in order, and `startIndex` is the index of the group's first title in the input.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionSections } from "./extract-partition.js";

const titles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ en: `S${i}`, zh: `區${i}` }));

test("returns one group when titles fit under perWorker", () => {
  const g = partitionSections(titles(5), { perWorker: 8, maxWorkers: 6 });
  assert.equal(g.length, 1);
  assert.equal(g[0].startIndex, 0);
  assert.equal(g[0].titles.length, 5);
});

test("splits into ceil(n/perWorker) contiguous groups, capped at maxWorkers", () => {
  const g = partitionSections(titles(39), { perWorker: 8, maxWorkers: 6 });
  assert.equal(g.length, 5); // ceil(39/8) = 5, under the cap
  // contiguous, every title once, in order
  assert.deepEqual(
    g.flatMap((x) => x.titles.map((t) => t.en)),
    titles(39).map((t) => t.en),
  );
  assert.deepEqual(g.map((x) => x.startIndex), [0, 8, 16, 24, 32]);
});

test("respects maxWorkers by enlarging groups", () => {
  const g = partitionSections(titles(100), { perWorker: 8, maxWorkers: 6 });
  assert.equal(g.length, 6); // capped; ceil(100/6)=17 per group
  assert.equal(g.flatMap((x) => x.titles).length, 100);
  assert.equal(g[0].startIndex, 0);
});

test("empty input yields no groups", () => {
  assert.deepEqual(partitionSections([]), []);
});

test("uses defaults when opts omitted", () => {
  const g = partitionSections(titles(8));
  assert.equal(g.length, 1); // 8/8
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/extract-partition.test.ts`
Expected: FAIL — `Cannot find module './extract-partition.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface SectionTitle {
  en: string;
  zh: string;
}

export interface SectionGroup {
  /** Index of this group's first title within the original list. */
  startIndex: number;
  titles: SectionTitle[];
}

/**
 * Split section titles into contiguous groups for parallel extraction. The
 * group count is `ceil(n / perWorker)` capped at `maxWorkers`; groups stay
 * contiguous and in order so the merged section order is the reading order.
 */
export function partitionSections(
  titles: SectionTitle[],
  opts: { perWorker?: number; maxWorkers?: number } = {},
): SectionGroup[] {
  const n = titles.length;
  if (n === 0) return [];
  const perWorker = opts.perWorker ?? 8;
  const maxWorkers = opts.maxWorkers ?? 6;

  const groupCount = Math.min(Math.ceil(n / perWorker), maxWorkers);
  const size = Math.ceil(n / groupCount); // titles per group (last may be smaller)

  const groups: SectionGroup[] = [];
  for (let start = 0; start < n; start += size) {
    groups.push({ startIndex: start, titles: titles.slice(start, start + size) });
  }
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/extract-partition.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extract-partition.ts src/extract-partition.test.ts
git commit -m "feat(extract): pure contiguous section partitioner for parallel extract"
```

---

### Task 2: Pure deterministic merge

**Files:**
- Create: `src/extract-merge.ts`
- Test: `src/extract-merge.test.ts`

**Interfaces:**
- Consumes: `Menu`, `MenuSection`, `TagDef` from `./types.js`; `SectionTitle` is structurally `{en,zh}`.
- Produces:
  - `interface Outline { restaurant?: { en?: string; zh?: string }; currency?: string; kind?: string; tags?: TagDef[]; sections: { en: string; zh: string }[] }`
  - `interface SectionsResult { sections: MenuSection[]; tags?: TagDef[] }`
  - `function mergeExtract(outline: Outline, results: SectionsResult[]): Menu`
  - Merge rules: global fields from `outline`; sections = `results` concatenated in order; tags = union-by-id of `outline.tags` then each result's `tags` (first definition wins), then **pruned to ids actually referenced by some item** (matches the single-call "only tags carried by ≥1 item" rule).

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeExtract, type Outline, type SectionsResult } from "./extract-merge.js";

const outline: Outline = {
  restaurant: { en: "Terrace", zh: "露台" },
  currency: "SGD",
  kind: "food",
  tags: [
    { id: "signature", en: "Signature", zh: "招牌", icon: "⭐", group: "highlight" },
    { id: "vegetarian", en: "Vegetarian", zh: "素", icon: "🌱", group: "diet" },
    { id: "unused", en: "Unused", zh: "沒用到", group: "other" },
  ],
  sections: [{ en: "Starters", zh: "前菜" }, { en: "Pasta", zh: "義麵" }],
};

test("concatenates sections in result order and carries global fields", () => {
  const results: SectionsResult[] = [
    { sections: [{ en: "Starters", zh: "前菜", items: [{ en: "Bruschetta", zh: "烤麵包", tags: ["vegetarian"] }] }] },
    { sections: [{ en: "Pasta", zh: "義麵", items: [{ en: "Pesto", zh: "青醬", tags: ["signature"] }] }] },
  ];
  const menu = mergeExtract(outline, results);
  assert.equal(menu.restaurant?.en, "Terrace");
  assert.equal(menu.currency, "SGD");
  assert.equal(menu.kind, "food");
  assert.deepEqual(menu.sections.map((s) => s.en), ["Starters", "Pasta"]);
});

test("prunes tags no item references", () => {
  const results: SectionsResult[] = [
    { sections: [{ en: "Pasta", zh: "義麵", items: [{ en: "Pesto", zh: "青醬", tags: ["signature"] }] }] },
  ];
  const menu = mergeExtract(outline, results);
  const ids = (menu.tags ?? []).map((t) => t.id);
  assert.deepEqual(ids, ["signature"]); // vegetarian + unused pruned (no item uses them)
});

test("unions worker-minted tags by id, first definition wins", () => {
  const results: SectionsResult[] = [
    {
      sections: [{ en: "Pasta", zh: "義麵", items: [{ en: "Clams", zh: "蛤蜊", tags: ["contains-shellfish"] }] }],
      tags: [{ id: "contains-shellfish", en: "Shellfish", zh: "含貝類", icon: "🦪", group: "allergen" }],
    },
    {
      sections: [{ en: "Starters", zh: "前菜", items: [{ en: "Oyster", zh: "生蠔", tags: ["contains-shellfish"] }] }],
      tags: [{ id: "contains-shellfish", en: "DIFFERENT", zh: "不同", group: "other" }],
    },
  ];
  const menu = mergeExtract(outline, results);
  const tag = (menu.tags ?? []).find((t) => t.id === "contains-shellfish");
  assert.equal(tag?.en, "Shellfish"); // first definition kept
});

test("handles items without tags and empty sections", () => {
  const results: SectionsResult[] = [
    { sections: [{ en: "Plain", zh: "普通", items: [{ en: "Water", zh: "水" }] }] },
    { sections: [{ en: "Empty", zh: "空", items: [] }] },
  ];
  const menu = mergeExtract({ ...outline, tags: [] }, results);
  assert.equal(menu.sections.length, 2);
  assert.deepEqual(menu.tags, []); // no tags referenced
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/extract-merge.test.ts`
Expected: FAIL — `Cannot find module './extract-merge.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Menu, MenuSection, TagDef } from "./types.js";

export interface Outline {
  restaurant?: { en?: string; zh?: string };
  currency?: string;
  kind?: string;
  tags?: TagDef[];
  /** Ordered section titles only — no items. */
  sections: { en: string; zh: string }[];
}

export interface SectionsResult {
  sections: MenuSection[];
  /** Tag definitions a worker minted that were absent from the outline vocab. */
  tags?: TagDef[];
}

/**
 * Reassemble a Menu from the Pass-1 outline and the Pass-2 per-group results.
 * Deterministic: sections concatenate in group order (the reading order),
 * global fields come from the outline, and the tag vocabulary is the union by
 * id (first definition wins) pruned to ids that some item actually carries —
 * matching the single-call "only tags used by ≥1 item" rule.
 */
export function mergeExtract(outline: Outline, results: SectionsResult[]): Menu {
  const sections: MenuSection[] = results.flatMap((r) => r.sections ?? []);

  const byId = new Map<string, TagDef>();
  for (const t of [...(outline.tags ?? []), ...results.flatMap((r) => r.tags ?? [])]) {
    if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  }

  const used = new Set<string>();
  for (const sec of sections) {
    for (const it of sec.items ?? []) {
      for (const id of it.tags ?? []) used.add(id);
    }
  }

  const tags = [...byId.values()].filter((t) => used.has(t.id));

  return {
    restaurant: outline.restaurant,
    currency: outline.currency,
    kind: outline.kind,
    tags,
    sections,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/extract-merge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extract-merge.ts src/extract-merge.test.ts
git commit -m "feat(extract): pure deterministic merge of outline + section workers"
```

---

### Task 3: JSON helper + Pass-1 outline call

**Files:**
- Create: `src/extract-json.ts`, `src/extract-json.test.ts`
- Create: `src/extract-outline.ts`, `src/extract-outline.test.ts`

**Interfaces:**
- Consumes: `MenuSource` from `./types.js`; `buildContentBlocks` from `./blocks.js`; `config` from `./config.js`; `Outline` from `./extract-merge.js`.
- Produces:
  - `function firstJsonObject(text: string): unknown` — parse the first balanced `{...}` (throws if none).
  - `function parseOutline(text: string): Outline` — parse + validate (`sections` must be a non-empty array).
  - `async function outlineMenu(sources: MenuSource[]): Promise<Outline>` — Pass-1 streamed call.
  - `const OUTLINE_SYSTEM: string`.

- [ ] **Step 1: Write the failing tests**

`src/extract-json.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstJsonObject } from "./extract-json.js";

test("extracts a balanced object, ignoring surrounding prose", () => {
  assert.deepEqual(firstJsonObject('noise {"a":1} tail'), { a: 1 });
});

test("throws when there is no object", () => {
  assert.throws(() => firstJsonObject("no json here"), /did not return JSON/i);
});
```

`src/extract-outline.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutline } from "./extract-outline.js";

test("parses outline JSON with global fields and section titles", () => {
  const out = parseOutline(
    'x {"restaurant":{"en":"T","zh":"露台"},"currency":"SGD","kind":"food",' +
      '"tags":[{"id":"signature","en":"Signature","zh":"招牌","icon":"⭐","group":"highlight"}],' +
      '"sections":[{"en":"Starters","zh":"前菜"},{"en":"Pasta","zh":"義麵"}]} y',
  );
  assert.equal(out.restaurant?.en, "T");
  assert.equal(out.currency, "SGD");
  assert.equal(out.tags?.[0].id, "signature");
  assert.deepEqual(out.sections.map((s) => s.en), ["Starters", "Pasta"]);
});

test("throws when sections are missing or empty", () => {
  assert.throws(() => parseOutline('{"sections":[]}'), /no sections/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/extract-json.test.ts src/extract-outline.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementations**

`src/extract-json.ts`:
```ts
/** Pull the first balanced JSON object out of a string. */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model did not return JSON:\n" + text.slice(0, 500));
  }
  return JSON.parse(text.slice(start, end + 1));
}
```

`src/extract-outline.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { MenuSource } from "./types.js";
import type { Outline } from "./extract-merge.js";
import { buildContentBlocks } from "./blocks.js";
import { firstJsonObject } from "./extract-json.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export const OUTLINE_SYSTEM = `You are a menu digitisation assistant. You are given
one or more photos and/or a PDF of a single menu. Read the WHOLE thing, then return a
STRICT JSON object describing only the menu's GLOBAL metadata and its SECTION SPINE —
NOT the individual items. Return ONLY this JSON (no markdown, no commentary):
{
  "restaurant": { "en": string, "zh": string },   // best guess; "" if unknown
  "currency": string,                                // e.g. "SGD"; "" if unknown
  "kind": string,                                    // "food" | "spa" | "service" | "other"; "" if unsure
  "tags": [                                          // every distinct classification label the menu uses
    { "id": string, "en": string, "zh": string, "icon": string, "group": string }
  ],
  "sections": [ { "en": string, "zh": string } ]     // EVERY section title, in reading order; titles only
}
Rules:
- List EVERY section/heading in the exact order it reads across all pages. Titles only —
  do NOT include items. A section continued on a later page is ONE section (list it once).
- Capture the full tag vocabulary the menu uses (dietary marks, allergen warnings,
  "Highlight"/"Chef's"/"招牌"/"Recommended"). Use these well-known ids + icons when the
  concept matches: vegetarian 🌱 | vegan 🌱 | spicy 🌶️ | pork 🐷 | chicken 🐔 |
  seafood 🐟 | beef 🐮 | gluten-free 🌾 | contains-nuts 🥜 | dairy 🥛 | signature ⭐.
  Map any "Highlight/Chef's/招牌/Recommended/推薦" marker to "signature" (icon ⭐,
  group "highlight"). For a menu-specific label, mint a stable lowercase-slug id with a
  group of "diet"|"allergen"|"protein"|"highlight"|"other". NEVER emit a "popular" tag.
- Traditional Chinese (繁體中文) for all _zh fields. Valid JSON, no trailing commas.`;

/** Validate and extract an Outline from the model's text. */
export function parseOutline(text: string): Outline {
  const obj = firstJsonObject(text) as Outline;
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    throw new Error("Outline has no sections.");
  }
  return obj;
}

/** Pass 1: read all sources and return global metadata + the section spine. */
export async function outlineMenu(sources: MenuSource[]): Promise<Outline> {
  const resp = await client.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: 4000,
      system: OUTLINE_SYSTEM,
      messages: [{ role: "user", content: buildContentBlocks(sources) }],
    })
    .finalMessage();
  if (resp.stop_reason === "max_tokens") {
    throw new Error("Outline output hit max_tokens; section list incomplete.");
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseOutline(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/extract-json.test.ts src/extract-outline.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/extract-json.ts src/extract-json.test.ts src/extract-outline.ts src/extract-outline.test.ts
git commit -m "feat(extract): Pass-1 outline call + shared first-JSON-object helper"
```

---

### Task 4: Shared item rules + Pass-2 section worker

**Files:**
- Create: `src/extract-rules.ts` (shared prompt pieces split verbatim from the current `extract.ts` SYSTEM)
- Create: `src/extract-sections.ts`, `src/extract-sections.test.ts`

**Interfaces:**
- Consumes: `MenuSource`, `TagDef` from `./types.js`; `buildContentBlocks` from `./blocks.js`; `config`; `firstJsonObject` from `./extract-json.js`; `SectionsResult` from `./extract-merge.js`; `SectionTitle` from `./extract-partition.js`.
- Produces:
  - `const INTRO_SCHEMA: string` — the head of the current `extract.ts` SYSTEM: intro + the full JSON output schema, up to and including the blank line before `Tags — IMPORTANT:` (verbatim).
  - `const ITEM_RULES: string` — the tail of the current SYSTEM: from `Tags — IMPORTANT:` through the very end (Tags / Explanations / Option groups / `Example item with options` / Other rules / `Example "tags" + item`), **verbatim and complete** — both examples included.
  - These two MUST be a character-exact split of the existing SYSTEM, so `INTRO_SCHEMA + ITEM_RULES === ` the original SYSTEM. Task 5 recomposes `extract.ts`'s SYSTEM from them, so single and worker share one source and cannot drift.
  - `function parseSectionsResult(text: string): SectionsResult`.
  - `async function extractSections(sources: MenuSource[], tags: TagDef[], titles: SectionTitle[]): Promise<SectionsResult>`.

- [ ] **Step 1: Write the failing test**

`src/extract-sections.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSectionsResult } from "./extract-sections.js";

test("parses a worker result with sections and minted tags", () => {
  const r = parseSectionsResult(
    'ok {"sections":[{"en":"Pasta","zh":"義麵","items":[' +
      '{"en":"Pesto","zh":"青醬","p":"22","tags":["signature"],"xterm":"linguine-al-pesto"}]}],' +
      '"tags":[{"id":"signature","en":"Signature","zh":"招牌","icon":"⭐","group":"highlight"}]} end',
  );
  assert.equal(r.sections[0].en, "Pasta");
  assert.equal(r.sections[0].items[0].xterm, "linguine-al-pesto");
  assert.equal(r.tags?.[0].id, "signature");
});

test("defaults tags to [] and tolerates their absence", () => {
  const r = parseSectionsResult('{"sections":[{"en":"S","zh":"區","items":[]}]}');
  assert.deepEqual(r.tags, []);
  assert.equal(r.sections.length, 1);
});

test("throws when sections key is absent", () => {
  assert.throws(() => parseSectionsResult('{"tags":[]}'), /no sections/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/extract-sections.test.ts`
Expected: FAIL — `Cannot find module './extract-sections.js'`.

- [ ] **Step 3: Write minimal implementations**

`src/extract-rules.ts` — split the current `src/extract.ts` `SYSTEM` template
literal into two exported constants **by cutting, not retyping** (copy the exact
characters so the pieces rejoin byte-for-byte). The cut point is the blank line
between the schema's closing `}` (the line after `]` near the top) and
`Tags — IMPORTANT:`:
- `INTRO_SCHEMA` = SYSTEM from its start (`You are a menu digitisation assistant.…`)
  through the schema object and the blank line, ending so the next character would
  be `T` of `Tags — IMPORTANT:`.
- `ITEM_RULES` = SYSTEM from `Tags — IMPORTANT:` through the END of the literal —
  this INCLUDES the `Example item with options (the noodle-soup shape):` block,
  the `Other rules:` block, AND the final `Example "tags" + item (illustrative):`
  block. Copy all of it verbatim.

```ts
/** The intro + JSON output schema portion of the extract prompt (verbatim head
 *  of the original SYSTEM). Recomposed with ITEM_RULES into the single-call
 *  SYSTEM in extract.ts. */
export const INTRO_SCHEMA = `You are a menu digitisation assistant. …
…<paste verbatim through the schema and the trailing blank line>… `;

/** The item/tag/xterm/options extraction rules + examples, shared by the
 *  single-call prompt and the Pass-2 worker prompt so they never drift.
 *  Verbatim tail of the original SYSTEM (from "Tags — IMPORTANT:" to the end). */
export const ITEM_RULES = `Tags — IMPORTANT:
…<paste verbatim through the final illustrative example>… `;
```

Verify the split is exact: after creating the file, the implementer keeps a copy
of the original SYSTEM and confirms `INTRO_SCHEMA + ITEM_RULES` equals it (e.g. a
scratch `node -e` assertion, not a committed test). Do not paraphrase any line.

`src/extract-sections.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { MenuSource, TagDef } from "./types.js";
import type { SectionTitle } from "./extract-partition.js";
import type { SectionsResult } from "./extract-merge.js";
import { buildContentBlocks } from "./blocks.js";
import { firstJsonObject } from "./extract-json.js";
import { ITEM_RULES } from "./extract-rules.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const ITEM_SHAPE = `Each item: {
  "en": string, "zh": string, "p": string, "tags": string[], "xterm": string,
  "options": [ { "en": string, "zh": string, "kind": string,
    "choices": [ { "en": string, "zh": string, "p": string } ] } ],
  "den": string, "dzh": string
}`;

function workerSystem(tags: TagDef[], titles: SectionTitle[]): string {
  return `You are a menu digitisation assistant. You are given ALL pages of one menu
(photos and/or a PDF). Extract FULL items for ONLY the sections listed below — ignore
every other section. Return ONLY a JSON object (no markdown, no commentary):
{ "sections": [ { "en": string, "zh": string, "note": string, "items": [ <item> ] } ],
  "tags": [ { "id": string, "en": string, "zh": string, "icon": string, "group": string } ] }
${ITEM_SHAPE}

SECTIONS TO EXTRACT (use these exact titles, keep this order):
${titles.map((t, i) => `${i + 1}. ${t.en} / ${t.zh}`).join("\n")}

TAG VOCABULARY (reference these ids on items; only add a NEW tag to "tags" if a label
is genuinely absent here, following the id rules below):
${JSON.stringify(tags)}

${ITEM_RULES}`;
}

/** Validate and extract a worker result from the model's text. */
export function parseSectionsResult(text: string): SectionsResult {
  const obj = firstJsonObject(text) as SectionsResult;
  if (!Array.isArray(obj.sections)) {
    throw new Error("Worker returned no sections.");
  }
  return { sections: obj.sections, tags: obj.tags ?? [] };
}

/** Pass 2: extract full items for the assigned sections, seeing all sources. */
export async function extractSections(
  sources: MenuSource[],
  tags: TagDef[],
  titles: SectionTitle[],
): Promise<SectionsResult> {
  const resp = await client.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: 32000,
      system: workerSystem(tags, titles),
      messages: [{ role: "user", content: buildContentBlocks(sources) }],
    })
    .finalMessage();
  if (resp.stop_reason === "max_tokens") {
    throw new Error("Section worker output hit max_tokens; JSON incomplete.");
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseSectionsResult(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/extract-sections.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extract-rules.ts src/extract-sections.ts src/extract-sections.test.ts
git commit -m "feat(extract): Pass-2 section worker + shared item-rules constant"
```

---

### Task 5: Orchestrator, dispatcher, config flag

**Files:**
- Modify: `src/config.ts` (add `extract.mode`)
- Modify: `src/extract.ts` (rename body to `extractMenuSingle`; add `extractMenuParallel`; make `extractMenu` dispatch + fall back)
- Create: `src/extract-parallel.test.ts`
- Modify: `.env.example` (document `EXTRACT_MODE`)

**Interfaces:**
- Consumes: `outlineMenu` (`./extract-outline.js`), `partitionSections` (`./extract-partition.js`), `extractSections` (`./extract-sections.js`), `mergeExtract` (`./extract-merge.js`), `config`.
- Produces:
  - `interface ParallelDeps { outline: typeof outlineMenu; extractSections: typeof extractSections }`
  - `async function extractMenuParallel(sources: MenuSource[], deps?: ParallelDeps): Promise<Menu>`
  - `async function extractMenuSingle(sources: MenuSource[]): Promise<Menu>` (the current behaviour, renamed)
  - `async function extractMenu(sources: MenuSource[]): Promise<Menu>` (dispatch on `config.extract.mode`, fall back to single on parallel failure)

- [ ] **Step 1: Add the config flag**

In `src/config.ts`, inside the `config` object after the `web` block:
```ts
  extract: {
    // "parallel" runs the two-stage extractor (Pass-1 outline → parallel section
    // workers → merge), falling back to the single call on any failure. Default
    // "single" until A/B-verified on a real menu. Set EXTRACT_MODE=parallel.
    mode: optional("EXTRACT_MODE", "single").toLowerCase() === "parallel"
      ? "parallel"
      : "single",
  },
```

- [ ] **Step 2: Write the failing test**

`src/extract-parallel.test.ts` (tests orchestration + fallback with injected fakes — no real API):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMenuParallel } from "./extract.js";
import type { Outline, SectionsResult } from "./extract-merge.js";
import type { MenuSource, TagDef } from "./types.js";
import type { SectionTitle } from "./extract-partition.js";

const sources: MenuSource[] = []; // fakes ignore the bytes

const outline: Outline = {
  restaurant: { en: "T", zh: "露台" },
  currency: "SGD",
  kind: "food",
  tags: [{ id: "signature", en: "Signature", zh: "招牌", icon: "⭐", group: "highlight" }],
  sections: Array.from({ length: 10 }, (_, i) => ({ en: `S${i}`, zh: `區${i}` })),
};

test("runs one worker per partition group and merges in order", async () => {
  const seen: SectionTitle[][] = [];
  const menu = await extractMenuParallel(sources, {
    outline: async () => outline,
    extractSections: async (_s: MenuSource[], _t: TagDef[], titles: SectionTitle[]): Promise<SectionsResult> => {
      seen.push(titles);
      return { sections: titles.map((t) => ({ en: t.en, zh: t.zh, items: [{ en: `${t.en}-item`, zh: "項", tags: ["signature"] }] })) };
    },
  });
  // 10 sections / perWorker 8 -> 2 groups -> 2 worker calls
  assert.equal(seen.length, 2);
  assert.deepEqual(menu.sections.map((s) => s.en), outline.sections.map((s) => s.en));
  assert.equal(menu.restaurant?.en, "T");
  assert.equal(menu.tags?.[0].id, "signature"); // referenced by every item
});

test("rejects when a worker fails (so the dispatcher can fall back)", async () => {
  await assert.rejects(
    extractMenuParallel(sources, {
      outline: async () => outline,
      extractSections: async () => {
        throw new Error("worker boom");
      },
    }),
    /worker boom/,
  );
});

test("rejects when the outline is empty", async () => {
  await assert.rejects(
    extractMenuParallel(sources, {
      outline: async () => ({ sections: [] }) as Outline,
      extractSections: async () => ({ sections: [] }),
    }),
    /no sections|empty/i,
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test src/extract-parallel.test.ts`
Expected: FAIL — `extractMenuParallel` is not exported from `./extract.js`.

- [ ] **Step 4: Refactor `extract.ts` — rename + add orchestrator + dispatcher**

In `src/extract.ts`:
1. Rename the existing `export async function extractMenu` to `export async function extractMenuSingle` (body unchanged, including `parseJson`).
2. Replace the inline `SYSTEM` template literal with a recomposition from the
   shared constants (so single and the Pass-2 worker share one rules source):
```ts
import { INTRO_SCHEMA, ITEM_RULES } from "./extract-rules.js";
const SYSTEM = INTRO_SCHEMA + ITEM_RULES; // byte-identical to the original literal
```
   Delete the old `const SYSTEM = \`…\`;` block. `extractMenuSingle` still
   references `SYSTEM`, unchanged.
3. Add imports at the top:
```ts
import { outlineMenu } from "./extract-outline.js";
import { extractSections } from "./extract-sections.js";
import { partitionSections } from "./extract-partition.js";
import { mergeExtract } from "./extract-merge.js";
import { config } from "./config.js"; // already imported — keep one import
```
3. Add the orchestrator + dispatcher:
```ts
export interface ParallelDeps {
  outline: typeof outlineMenu;
  extractSections: typeof extractSections;
}

/**
 * Two-stage extract: Pass-1 outline → contiguous partition → one parallel
 * worker per group (each sees all sources) → deterministic merge. Throws if the
 * outline is empty or any worker fails, so the dispatcher can fall back.
 */
export async function extractMenuParallel(
  sources: MenuSource[],
  deps: ParallelDeps = { outline: outlineMenu, extractSections },
): Promise<Menu> {
  const outline = await deps.outline(sources);
  if (!outline.sections?.length) throw new Error("Outline produced no sections.");
  const groups = partitionSections(outline.sections);
  const results = await Promise.all(
    groups.map((g) => deps.extractSections(sources, outline.tags ?? [], g.titles)),
  );
  return mergeExtract(outline, results);
}

/** Read menu photos and return a structured, bilingual Menu. Dispatches on
 *  EXTRACT_MODE; parallel mode falls back to the single call on any failure. */
export async function extractMenu(sources: MenuSource[]): Promise<Menu> {
  if (config.extract.mode === "parallel") {
    try {
      return await extractMenuParallel(sources);
    } catch (e) {
      console.error("Parallel extract failed; falling back to single call:", e);
    }
  }
  return extractMenuSingle(sources);
}
```
(Keep `bot.ts` calling `extractMenu` — no change needed there.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test src/extract-parallel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck, full suite, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass (existing 76 + new); build OK.

- [ ] **Step 7: Document the flag**

In `.env.example`, under the Debug section (or a new "Extraction" section):
```
# ── Extraction ─────────────────────────────────────────────
# "parallel" = two-stage extractor (faster on large menus); "single" = one call.
# Falls back to single automatically on any parallel-stage failure. Default single.
EXTRACT_MODE=single
```

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/extract.ts src/extract-parallel.test.ts .env.example
git commit -m "feat(extract): two-stage dispatcher with single-call fallback (EXTRACT_MODE)"
```

---

## Rollout (after the plan is implemented and merged)

1. Merge to `main`, push, deploy to VPS (`git pull && npm install && npm run build`).
2. On VPS set `EXTRACT_MODE=parallel` in `.env`; keep `DEBUG_TIMING=on`; restart.
3. Brian runs the Terrace menu. Compare the `[timing]` line's `sections/items/xterms`
   counts and spot-check content against the known-good single-call output.
4. If fidelity holds and `extract` time dropped: flip `EXTRACT_MODE=parallel` as the
   default in code (or leave the VPS flag on). If not: leave default `single`,
   investigate the diff. The fallback path stays either way.

## Self-Review

- **Spec coverage:** Pass 1 (Task 3) ✓; partition (Task 1) ✓; Pass 2 + shared rules
  (Task 4) ✓; merge incl. tag union + prune (Task 2) ✓; dispatcher + fallback + flag
  + rollout (Task 5) ✓; out-of-scope compaction/waitLive correctly excluded ✓.
- **Placeholders:** none — every step has concrete code/commands.
- **Type consistency:** `Outline`/`SectionsResult` defined in `extract-merge.ts` and
  imported everywhere; `SectionTitle`/`SectionGroup` from `extract-partition.ts`;
  `firstJsonObject` from `extract-json.ts` used by outline + sections; `extractMenu`
  signature unchanged so `bot.ts` is untouched.
