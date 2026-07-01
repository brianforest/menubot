# Restaurant Context + Complexity Time-Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed a restaurant/region context (from typed text and a Google Maps link resolved via HTTP redirect) into menu extraction, and warn the user when a complex menu is routed to the slower single call.

**Architecture:** New `maps-link.ts` resolves a Maps short link to name+address via a redirect-following HEAD request (host allow-list, SSRF-guarded, best-effort). New `context.ts` combines typed text + resolved link into one context string. `buildContentBlocks` appends it to the vision instruction. `context` threads through every extract entry point; an `onRoute` callback in `extractMenuAdaptive` lets `bot.ts` send a wait-time message on a complexity-triggered single.

**Tech Stack:** Node.js 20+ (global `fetch`, `AbortSignal.timeout`, `URL`), TypeScript ESM, `node:test` + `node:assert/strict`, tsx runner, `@anthropic-ai/sdk`, grammy.

## Global Constraints

- TypeScript ESM — local imports use the `.js` extension.
- Tests: `node:test` + `node:assert/strict`, files named `src/*.test.ts`, run with `npm test`.
- Code comments / commit messages in English. Chinese USER-FACING strings use full-width punctuation（，。：！？「」（）—— …）.
- No new runtime dependencies (use global `fetch`/`URL`/`AbortSignal`).
- Best-effort, never block the pipeline (mandate #6): link resolution and context building must never throw into `processBatch` or delay it beyond an 8 s per-call timeout; any failure → `null` context, extraction proceeds unchanged.
- Security: only fetch URLs whose host is on the Google-Maps allow-list (SSRF guard) — never an arbitrary user URL.
- Fidelity: context is additive; when absent, extraction behaves byte-identically to today.

---

### Task 1: Map link resolution (`src/maps-link.ts`)

**Files:**
- Create: `src/maps-link.ts`
- Test: `src/maps-link.test.ts`

**Interfaces:**
- Produces:
  - `export interface MapLinkDeps { fetch: typeof fetch }`
  - `export function findMapUrl(text: string): string | null`
  - `export async function resolveMapContext(text: string, deps?: MapLinkDeps): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

Create `src/maps-link.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMapUrl, resolveMapContext } from "./maps-link.js";

const fakeFetch = (finalUrl: string): typeof fetch =>
  (async () => ({ url: finalUrl }) as Response) as unknown as typeof fetch;

test("findMapUrl accepts allow-listed hosts and rejects others", () => {
  assert.equal(findMapUrl("go here https://maps.app.goo.gl/abc please"), "https://maps.app.goo.gl/abc");
  assert.equal(findMapUrl("https://www.google.com/maps/place/X"), "https://www.google.com/maps/place/X");
  assert.equal(findMapUrl("https://evil.example.com/x"), null);
  assert.equal(findMapUrl("https://www.google.com/search?q=x"), null); // google.com but not /maps
  assert.equal(findMapUrl("no url here"), null);
});

test("resolveMapContext returns the decoded q= place from the redirected URL", async () => {
  const deps = { fetch: fakeFetch("https://maps.google.com/maps?q=The+Terrace+at+The+Danna%2C+Langkawi&ftid=x") };
  assert.equal(await resolveMapContext("see https://maps.app.goo.gl/abc", deps), "The Terrace at The Danna, Langkawi");
});

test("resolveMapContext returns null when there is no map url", async () => {
  assert.equal(await resolveMapContext("just the name", { fetch: fakeFetch("x") }), null);
});

test("resolveMapContext returns null when the final url has no q= param", async () => {
  const deps = { fetch: fakeFetch("https://maps.google.com/maps?ll=1,2") };
  assert.equal(await resolveMapContext("https://maps.app.goo.gl/abc", deps), null);
});

test("resolveMapContext returns null when fetch throws", async () => {
  const deps = { fetch: (async () => { throw new Error("net"); }) as unknown as typeof fetch };
  assert.equal(await resolveMapContext("https://maps.app.goo.gl/abc", deps), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/maps-link.test.ts`
Expected: FAIL — module `./maps-link.js` not found.

- [ ] **Step 3: Implement `src/maps-link.ts`**

```typescript
/** Resolve a Google Maps link to a "name, address" string, for use as extraction
 *  context. Best-effort and SSRF-guarded: only allow-listed Maps hosts are fetched,
 *  the request is HEAD-only (final URL, not body), time-bounded, and any failure
 *  yields null so the caller proceeds without context. */

export interface MapLinkDeps {
  fetch: typeof fetch;
}

// Hosts we will fetch. `google.com`/`www.google.com` additionally require a /maps path.
const MAPS_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "maps.google.com",
  "g.co",
  "google.com",
  "www.google.com",
]);

/** First allow-listed Google Maps URL in `text`, or null. SSRF guard: anything not
 *  on the host allow-list is ignored. */
export function findMapUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s]+/g);
  if (!urls) return null;
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      if (!MAPS_HOSTS.has(host)) continue;
      // google.com is only a maps host on a /maps path (avoid /search etc.).
      if ((host === "google.com" || host === "www.google.com") && !parsed.pathname.startsWith("/maps")) {
        continue;
      }
      return u;
    } catch {
      // not a valid URL — skip
    }
  }
  return null;
}

/** Follow the link's redirects and return the decoded `q=` place string, or null. */
export async function resolveMapContext(
  text: string,
  deps: MapLinkDeps = { fetch },
): Promise<string | null> {
  const url = findMapUrl(text);
  if (!url) return null;
  try {
    const res = await deps.fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const finalUrl = res.url || url;
    // URLSearchParams decodes both %XX and '+' → space.
    const q = new URL(finalUrl).searchParams.get("q");
    if (!q) return null;
    const place = q.replace(/[\s,]+$/, "").trim(); // drop trailing ", "
    return place || null;
  } catch {
    return null; // timeout / network / parse — best-effort
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/maps-link.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/maps-link.ts src/maps-link.test.ts
git commit -m "feat(context): resolve Google Maps links to name+address (SSRF-guarded)"
```

---

### Task 2: Context assembly (`src/context.ts`)

**Files:**
- Create: `src/context.ts`
- Test: `src/context.test.ts`

**Interfaces:**
- Consumes: `resolveMapContext` (from `./maps-link.js`).
- Produces:
  - `export interface ContextDeps { resolveMap: typeof resolveMapContext }`
  - `export async function buildContext(hint: string | undefined, deps?: ContextDeps): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

Create `src/context.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "./context.js";

const deps = (mapResult: string | null) => ({ resolveMap: async () => mapResult });

test("buildContext returns null for empty/undefined hint", async () => {
  assert.equal(await buildContext(undefined, deps(null)), null);
  assert.equal(await buildContext("   ", deps(null)), null);
});

test("buildContext uses typed text when there is no link", async () => {
  assert.equal(await buildContext("Joe's Diner, NYC", deps(null)), "Joe's Diner, NYC");
});

test("buildContext uses the resolved link and drops the raw URL from the text", async () => {
  const out = await buildContext(
    "https://maps.app.goo.gl/abc",
    deps("The Terrace at The Danna, Langkawi"),
  );
  assert.equal(out, "The Terrace at The Danna, Langkawi");
});

test("buildContext merges resolved link with extra typed text", async () => {
  const out = await buildContext(
    "fancy italian https://maps.app.goo.gl/abc",
    deps("The Terrace at The Danna, Langkawi"),
  );
  assert.equal(out, "The Terrace at The Danna, Langkawi — fancy italian");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/context.test.ts`
Expected: FAIL — module `./context.js` not found.

- [ ] **Step 3: Implement `src/context.ts`**

```typescript
import { resolveMapContext } from "./maps-link.js";

export interface ContextDeps {
  resolveMap: typeof resolveMapContext;
}

/** Build a restaurant/region context line from the user's hint: the resolved map
 *  place (preferred — deterministic name+address) plus any extra typed text, with
 *  the raw URL stripped. Returns null when there is nothing usable. */
export async function buildContext(
  hint: string | undefined,
  deps: ContextDeps = { resolveMap: resolveMapContext },
): Promise<string | null> {
  if (!hint || !hint.trim()) return null;
  const place = await deps.resolveMap(hint);
  const typed = hint.replace(/https?:\/\/[^\s]+/g, "").trim(); // drop URLs from the text
  const parts = [place, typed].filter((s): s is string => !!s && s.length > 0);
  if (!parts.length) return null;
  return [...new Set(parts)].join(" — ");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/context.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/context.test.ts
git commit -m "feat(context): buildContext merges typed text + resolved map link"
```

---

### Task 3: `buildContentBlocks` accepts context

**Files:**
- Modify: `src/blocks.ts` (`buildContentBlocks`)
- Test: `src/blocks.test.ts` (create)

**Interfaces:**
- Produces: `buildContentBlocks(sources: MenuSource[], context?: string): Anthropic.ContentBlockParam[]`
  — appends a context line to the instruction text block when `context` is a non-empty
  string; byte-identical output when absent.

- [ ] **Step 1: Write the failing tests**

Create `src/blocks.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentBlocks } from "./blocks.js";
import type { MenuSource } from "./types.js";

const img: MenuSource = { kind: "image", mime: "image/jpeg", bytes: Buffer.from("x") };
const textOf = (blocks: ReturnType<typeof buildContentBlocks>) => {
  const b = blocks[blocks.length - 1];
  return b.type === "text" ? b.text : "";
};

test("buildContentBlocks without context leaves the instruction unchanged", () => {
  const t = textOf(buildContentBlocks([img]));
  assert.ok(!t.includes("Restaurant context"));
});

test("buildContentBlocks appends the context line when provided", () => {
  const t = textOf(buildContentBlocks([img], "The Terrace, Langkawi"));
  assert.ok(t.includes("Restaurant context"));
  assert.ok(t.includes("The Terrace, Langkawi"));
});

test("buildContentBlocks ignores an empty/whitespace context", () => {
  const t = textOf(buildContentBlocks([img], "   "));
  assert.ok(!t.includes("Restaurant context"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/blocks.test.ts`
Expected: FAIL — `buildContentBlocks` rejects a second argument / no context handling.

- [ ] **Step 3: Implement the change in `src/blocks.ts`**

Replace the `buildContentBlocks` function's signature and final return. Change the
signature line:
```typescript
export function buildContentBlocks(
  sources: MenuSource[],
  context?: string,
): Anthropic.ContentBlockParam[] {
```
and change the final `return`:
```typescript
  const instruction =
    context && context.trim()
      ? `${promptText(sources)}\n\nRestaurant context (may help disambiguate dish names, cuisine, region, and currency): ${context.trim()}`
      : promptText(sources);
  return [...media, { type: "text", text: instruction }];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/blocks.test.ts && npm run typecheck`
Expected: 3 tests pass; typecheck clean (existing callers pass no 2nd arg — still valid).

- [ ] **Step 5: Commit**

```bash
git add src/blocks.ts src/blocks.test.ts
git commit -m "feat(context): buildContentBlocks appends optional restaurant context"
```

---

### Task 4: Thread `context` + `onRoute` through the extract entry points

**Files:**
- Modify: `src/extract-outline.ts` (`outlineMenu`)
- Modify: `src/extract-sections.ts` (`extractSections`)
- Modify: `src/extract.ts` (`extractMenuSingle`, `extractFromOutline`, `extractMenuParallel`, `extractMenuAdaptive`, `dispatchExtract`, `extractMenu`; add `ExtractOpts`)
- Test: `src/extract.test.ts` (append)

**Interfaces:**
- Produces:
  - `outlineMenu(sources, context?: string)`
  - `extractSections(sources, tags, titles, context?: string)`
  - `extractMenuSingle(sources, context?: string)`
  - `extractFromOutline(outline, sources, deps?, context?: string)`
  - `extractMenuParallel(sources, deps?, context?: string)`
  - `export interface ExtractOpts { context?: string; onRoute?: (route: "single" | "parallel", complex: boolean | undefined) => void }`
  - `extractMenuAdaptive(sources, deps?, opts?: ExtractOpts)`
  - `dispatchExtract(sources, mode, deps?, opts?: ExtractOpts)`
  - `extractMenu(sources, opts?: ExtractOpts)`

- [ ] **Step 1: Add `context` to the three leaf extractors (no test yet — covered by Step 5 passthrough test)**

In `src/extract-outline.ts`, `outlineMenu`:
```typescript
export async function outlineMenu(sources: MenuSource[], context?: string): Promise<Outline> {
```
and change its `buildContentBlocks(sources)` call to `buildContentBlocks(sources, context)`.

In `src/extract-sections.ts`, `extractSections`:
```typescript
export async function extractSections(
  sources: MenuSource[],
  tags: TagDef[],
  titles: SectionTitle[],
  context?: string,
): Promise<SectionsResult> {
```
and change its `buildContentBlocks(sources)` call to `buildContentBlocks(sources, context)`.

In `src/extract.ts`, `extractMenuSingle`:
```typescript
export async function extractMenuSingle(sources: MenuSource[], context?: string): Promise<Menu> {
```
and change its `buildContentBlocks(sources)` call to `buildContentBlocks(sources, context)`.

- [ ] **Step 2: Thread `context` through `extractFromOutline` and `extractMenuParallel`**

In `src/extract.ts`, `extractFromOutline` — add `context?` and pass it to the workers:
```typescript
export async function extractFromOutline(
  outline: Outline,
  sources: MenuSource[],
  deps: FromOutlineDeps = { extractSections },
  context?: string,
): Promise<Menu> {
```
Change the worker call inside it:
```typescript
    groups.map((g) => deps.extractSections(sources, outline.tags ?? [], g.titles, context)),
```

`extractMenuParallel` — add `context?` and thread to outline + fromOutline:
```typescript
export async function extractMenuParallel(
  sources: MenuSource[],
  deps: ParallelDeps = { outline: outlineMenu, extractSections },
  context?: string,
): Promise<Menu> {
  const outline = await deps.outline(sources, context);
  return extractFromOutline(outline, sources, { extractSections: deps.extractSections }, context);
}
```

- [ ] **Step 3: Add `ExtractOpts`, thread through adaptive + dispatch + extractMenu**

In `src/extract.ts`, add the opts interface (near `DispatchDeps`):
```typescript
/** Cross-cutting extract options: restaurant context for the prompt, and an
 *  adaptive-routing callback so the caller can message the user. */
export interface ExtractOpts {
  context?: string;
  onRoute?: (route: "single" | "parallel", complex: boolean | undefined) => void;
}
```

Rewrite `extractMenuAdaptive` to take `opts` and fire `onRoute`:
```typescript
export async function extractMenuAdaptive(
  sources: MenuSource[],
  deps: AdaptiveDeps = { outline: outlineMenu, extractSections, single: extractMenuSingle },
  opts: ExtractOpts = {},
): Promise<Menu> {
  let outline: Outline;
  try {
    outline = await deps.outline(sources, opts.context);
  } catch (e) {
    console.error("Adaptive: outline failed; single fallback:", e);
    return deps.single(sources, opts.context);
  }
  if (outline.complex !== false) {
    console.log(`[extract] adaptive → single (complex=${outline.complex})`);
    opts.onRoute?.("single", outline.complex);
    return deps.single(sources, opts.context);
  }
  console.log("[extract] adaptive → parallel (complex=false)");
  opts.onRoute?.("parallel", false);
  try {
    return await extractFromOutline(
      outline,
      sources,
      { extractSections: deps.extractSections },
      opts.context,
    );
  } catch (e) {
    console.error("Adaptive: parallel path failed; single fallback:", e);
    return deps.single(sources, opts.context);
  }
}
```

Rewrite `dispatchExtract` to take `opts` and thread it:
```typescript
export async function dispatchExtract(
  sources: MenuSource[],
  mode: "single" | "parallel" | "adaptive",
  deps: DispatchDeps = {
    parallel: extractMenuParallel,
    single: extractMenuSingle,
    adaptive: extractMenuAdaptive,
  },
  opts: ExtractOpts = {},
): Promise<Menu> {
  if (mode === "adaptive") return deps.adaptive(sources, undefined, opts);
  if (mode === "parallel") {
    try {
      return await deps.parallel(sources, undefined, opts.context);
    } catch (e) {
      console.error("Parallel extract failed; falling back to single call:", e);
    }
  }
  return deps.single(sources, opts.context);
}
```

Rewrite `extractMenu`:
```typescript
export function extractMenu(sources: MenuSource[], opts?: ExtractOpts): Promise<Menu> {
  return dispatchExtract(sources, config.extract.mode, undefined, opts);
}
```

- [ ] **Step 4: Run the existing suite to confirm no regression**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all existing tests pass (defaults keep every call site valid — `deps.adaptive(sources, undefined, opts)` supplies deps default inside adaptive).

- [ ] **Step 5: Write passthrough + onRoute tests, verify, and confirm they pass**

Append to `src/extract.test.ts` (helpers `outline`, `sectionsResult`, `SRC`, `SINGLE`
and the `extractMenuAdaptive` import already exist there — reuse them, add no new import):

```typescript
test("adaptive threads context to the outline and the single path", async () => {
  const seen: (string | undefined)[] = [];
  await extractMenuAdaptive(
    SRC,
    {
      outline: async (_s, ctx) => { seen.push(ctx); return outline(["A"], true); },
      extractSections: async () => sectionsResult(["A"]),
      single: async (_s, ctx) => { seen.push(ctx); return SINGLE; },
    },
    { context: "CTX" },
  );
  assert.deepEqual(seen, ["CTX", "CTX"]); // outline got CTX, then single got CTX
});

test("adaptive fires onRoute single+true on a complex menu", async () => {
  const calls: [string, boolean | undefined][] = [];
  await extractMenuAdaptive(
    SRC,
    { outline: async () => outline(["A"], true), extractSections: async () => sectionsResult(["A"]), single: async () => SINGLE },
    { onRoute: (r, c) => calls.push([r, c]) },
  );
  assert.deepEqual(calls, [["single", true]]);
});

test("adaptive fires onRoute parallel+false on a simple menu", async () => {
  const calls: [string, boolean | undefined][] = [];
  await extractMenuAdaptive(
    SRC,
    {
      outline: async () => outline(["A", "B"], false),
      extractSections: async (_s, _t, titles) => sectionsResult(titles.map((t) => t.en)),
      single: async () => SINGLE,
    },
    { onRoute: (r, c) => calls.push([r, c]) },
  );
  assert.deepEqual(calls, [["parallel", false]]);
});
```

Run: `node --import tsx --test src/extract.test.ts && npm run typecheck && npm test`
Expected: new tests pass; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/extract.ts src/extract-outline.ts src/extract-sections.ts src/extract.test.ts
git commit -m "feat(context): thread context + onRoute through extract entry points"
```

---

### Task 5: Wire `bot.ts` — build context, warn on complex-single, rewrite prompt

**Files:**
- Modify: `src/bot.ts` (`processBatch` extract call, `COLLECT_MSG`, imports)

**Interfaces:**
- Consumes: `buildContext` (from `./context.js`), `extractMenu(sources, opts)` with `ExtractOpts`.

- [ ] **Step 1: Import `buildContext`**

Near the other imports in `src/bot.ts`, add:
```typescript
import { buildContext } from "./context.js";
```

- [ ] **Step 2: Build context and pass opts to `extractMenu`**

In `processBatch`, replace the extract line (currently
`const menu = await timer.time("extract", () => extractMenu(sources));`) with:
```typescript
    // Restaurant/region context from the hint (typed text + resolved map link) —
    // best-effort, never blocks extraction.
    const context = await buildContext(hint).catch(() => null);
    const menu = await timer.time("extract", () =>
      extractMenu(sources, {
        context: context ?? undefined,
        onRoute: (route, complex) => {
          if (route === "single" && complex === true) {
            void ctx
              .reply(
                "🕐 此菜單版面較複雜（密集價格表），為確保價格正確改用完整辨識，約需 3–4 分鐘，請稍候。\n" +
                  "This menu has a complex layout — using full recognition for price accuracy (~3–4 min).",
              )
              .catch(() => {});
          }
        },
      }),
    );
```

- [ ] **Step 3: Rewrite `COLLECT_MSG` to ask for a map link / name**

Replace the `COLLECT_MSG` constant with (full-width punctuation in the 中文):
```typescript
const COLLECT_MSG =
  "📸 收到。整本菜單可多張照片／PDF 一次傳給我，全部傳完後請按【✅ 完成並產生菜單】。\n" +
  "（強烈建議）貼上這家餐廳的 Google 地圖連結，我會據此判斷菜系、地區與幣別，辨識最準；\n" +
  "若不方便，至少用一則文字告訴我店名。\n" +
  "Send all pages (photos and/or a PDF). Best results: paste the restaurant's Google Maps " +
  "link (or at least type its name). Tap ✅ Done when finished.";
```

- [ ] **Step 4: Verify typecheck + build + full suite**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass; build succeeds. (`bot.ts` has no unit tests — verified by typecheck/build, consistent with the codebase.)

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts
git commit -m "feat(context): bot builds restaurant context, warns on complex-single, asks for map link"
```

---

## Rollout (after merge)

- Context feed + prompt rewrite are always-on (best-effort link resolve, one cheap HEAD).
- The time-warning only fires in `EXTRACT_MODE=adaptive` (still gated behind Brian's flip).
- Deploy with production `EXTRACT_MODE` unchanged; acceptance: send a menu with a Maps
  link → confirm region/currency wording benefits; in adaptive, a complex menu shows the
  wait-time message.
