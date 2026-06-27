# P4a — Web Popularity Tags (🔥) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once per menu, use Claude's native `web_search` to find a restaurant's famous/popular dishes and flag the matching items with the reserved `popular` 🔥 tag, with an optional user-supplied hint (name / location / Google Maps link) to sharpen the search.

**Architecture:** A new pure orchestrator `src/popular.ts` owns the `popular` tag end-to-end (strip stray → resolve restaurant identity → call an injected `FindPopular` → defensively apply). The real `FindPopular` lives in `src/web-popular.ts` (Anthropic `web_search`, handles `pause_turn`). `bot.ts` collects an optional text hint into `BatchStore` and runs `tagPopular` between glossary enrichment and rendering, gracefully. `render.ts` stops stripping `popular` so the P2a 🔥 chip/icon UI renders.

**Tech Stack:** TypeScript ESM, `@anthropic-ai/sdk`, grammy, `node:test` via `tsx`.

## Global Constraints

- Model is always `config.anthropic.model` (`claude-sonnet-4-6`); never hard-code a model id.
- ESM: import specifiers use the `.js` extension (e.g. `./popular.js`).
- Pure/unit-tested modules (`popular.ts`) must NOT import `config.ts` or the SDK (config calls `process.exit`); inject dependencies. `web-popular.ts` may import `config` and is NOT unit-tested.
- Tests use `node:test` + `node:assert/strict`, run by `npm test`.
- No new dependencies. No changes to `src/types.ts`. `templates/menu.html` unchanged.
- Web search uses tool type `web_search_20260209`, `max_uses: 5`; handle `stop_reason === "pause_turn"` by re-sending (cap 6 continuations).
- Popularity must degrade gracefully: any failure publishes the menu unchanged (no 🔥).
- The reserved tag is exactly `{ id: "popular", en: "Popular", zh: "人氣", icon: "🔥", group: "highlight" }`.
- Over-flag guard: keep at most `max(6, floor(40% of item count))` popular items; if more (or zero) are returned, flag none.
- Branch: `feat/popularity-tags` (already created; spec committed there).

---

### Task 1: BatchStore — optional per-chat hint

**Files:**
- Modify: `src/batch.ts`
- Test: `src/batch.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `BatchStore.setHint(chatId: number, hint: string, now: number): boolean` — store a trimmed non-empty hint on an existing batch (updates activity), returns whether stored.
  - `BatchStore.take(chatId: number): { items: PendingItem[]; hint?: string } | undefined` (return shape changed from `PendingItem[] | undefined`).

- [ ] **Step 1: Write the failing tests**

Append to `src/batch.test.ts`:

```ts
test("setHint stores a trimmed hint on an active batch and take returns it", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000);
  assert.equal(store.setHint(1, "  Din Tai Fung 信義店  ", 1100), true);
  const taken = store.take(1);
  assert.equal(taken?.hint, "Din Tai Fung 信義店");
  assert.deepEqual(taken?.items.map((i) => i.fileId), ["a"]);
});

test("setHint on a chat with no active batch returns false", () => {
  const store = new BatchStore();
  assert.equal(store.setHint(7, "rest", 1000), false);
});

test("setHint ignores an empty/whitespace hint", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000);
  assert.equal(store.setHint(1, "   ", 1100), false);
  assert.equal(store.take(1)?.hint, undefined);
});
```

Also update the existing `take` test to the new shape:

```ts
test("take returns the items and clears the batch", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000);
  store.add(1, item("b"), 1000);
  const taken = store.take(1);
  assert.deepEqual(taken?.items.map((i) => i.fileId), ["a", "b"]);
  assert.equal(store.take(1), undefined); // cleared
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setHint` is not a function / `taken?.items` undefined.

- [ ] **Step 3: Implement the change**

In `src/batch.ts`, add `hint` to the `Batch` interface, add `setHint`, and change `take`:

```ts
interface Batch {
  items: PendingItem[];
  hint?: string;
  lastActivityAt: number;
}
```

```ts
  /** Store an optional restaurant/location hint on an existing batch.
   *  Returns true if a non-empty hint was stored (a batch must already exist). */
  setHint(chatId: number, hint: string, now: number): boolean {
    const batch = this.batches.get(chatId);
    if (!batch) return false;
    const h = hint.trim();
    if (!h) return false;
    batch.hint = h;
    batch.lastActivityAt = now;
    return true;
  }

  /** Remove and return a chat's buffered items + hint (on "Done"); undefined if none. */
  take(chatId: number): { items: PendingItem[]; hint?: string } | undefined {
    const batch = this.batches.get(chatId);
    if (!batch) return undefined;
    this.batches.delete(chatId);
    return { items: batch.items, hint: batch.hint };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all batch tests, including the updated `take`).

- [ ] **Step 5: Commit**

```bash
git add src/batch.ts src/batch.test.ts
git commit -m "feat(batch): optional per-chat hint (setHint); take returns {items, hint}"
```

---

### Task 2: Restaurant-identity helpers (`popular.ts`)

**Files:**
- Create: `src/popular.ts`
- Test: `src/popular.test.ts`

**Interfaces:**
- Consumes: `Menu`, `TagDef` from `./types.js`.
- Produces:
  - `POPULAR_TAG: TagDef` = `{ id: "popular", en: "Popular", zh: "人氣", icon: "🔥", group: "highlight" }`.
  - `type FindPopular = (restaurant: string, location: string, items: { i: number; en: string; zh: string }[]) => Promise<number[]>`.
  - `googlePlaceName(text?: string): string | null` — parse the place name out of a Google Maps `/maps/place/<name>/` URL; `null` if none.
  - `resolveIdentity(menu: Menu, hint?: string): { restaurant: string; location: string }`.

- [ ] **Step 1: Write the failing tests**

Create `src/popular.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { googlePlaceName, resolveIdentity } from "./popular.js";
import type { Menu } from "./types.js";

test("googlePlaceName extracts and decodes the place name", () => {
  assert.equal(
    googlePlaceName("see https://www.google.com/maps/place/Din+Tai+Fung+Xinyi/@25.0,121.5,17z"),
    "Din Tai Fung Xinyi",
  );
});

test("googlePlaceName returns null when there is no place URL", () => {
  assert.equal(googlePlaceName("just some text"), null);
  assert.equal(googlePlaceName(""), null);
  assert.equal(googlePlaceName("https://maps.app.goo.gl/abc123"), null); // short link has no name
});

test("resolveIdentity prefers a Google place name; free text becomes location", () => {
  const menu: Menu = { restaurant: { en: "Whatever" }, sections: [] };
  const r = resolveIdentity(menu, "near me https://www.google.com/maps/place/Tian+Tian+Chicken+Rice/@1.2,103.8");
  assert.equal(r.restaurant, "Tian Tian Chicken Rice");
  assert.equal(r.location, "near me");
});

test("resolveIdentity falls back to the menu restaurant; hint text becomes location", () => {
  const menu: Menu = { restaurant: { en: "Din Tai Fung", zh: "鼎泰豐" }, sections: [] };
  assert.deepEqual(resolveIdentity(menu, "信義店 台北"), { restaurant: "Din Tai Fung", location: "信義店 台北" });
});

test("resolveIdentity uses free-text hint as the restaurant when the menu has no name", () => {
  const menu: Menu = { sections: [] };
  assert.deepEqual(resolveIdentity(menu, "鼎泰豐 信義店"), { restaurant: "鼎泰豐 信義店", location: "" });
});

test("resolveIdentity yields an empty restaurant when nothing is known", () => {
  const menu: Menu = { sections: [] };
  assert.deepEqual(resolveIdentity(menu, ""), { restaurant: "", location: "" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./popular.js` / exports undefined.

- [ ] **Step 3: Implement the helpers**

Create `src/popular.ts`:

```ts
import type { Menu, TagDef } from "./types.js";

/** The reserved well-known tag this stage populates (P2a built the UI for it). */
export const POPULAR_TAG: TagDef = {
  id: "popular",
  en: "Popular",
  zh: "人氣",
  icon: "🔥",
  group: "highlight",
};

/** Injected web-popularity finder: returns the `i` indices of popular items. */
export type FindPopular = (
  restaurant: string,
  location: string,
  items: { i: number; en: string; zh: string }[],
) => Promise<number[]>;

/** Parse the place name from a Google Maps `/maps/place/<name>/` URL, or null. */
export function googlePlaceName(text = ""): string | null {
  const m = text.match(/\/maps\/place\/([^/]+)/);
  if (!m) return null;
  try {
    const name = decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a restaurant identity for searching. Precedence for the name:
 * Google place name (from a hint URL) → menu.restaurant → free-text hint.
 * When the name came from the menu or a Google URL, the remaining free text
 * (hint with any URL removed) is treated as location context.
 */
export function resolveIdentity(
  menu: Menu,
  hint = "",
): { restaurant: string; location: string } {
  const gname = googlePlaceName(hint);
  const menuName = (menu.restaurant?.en || menu.restaurant?.zh || "").trim();
  const freeText = hint.replace(/https?:\/\/\S+/g, "").trim();
  const restaurant = (gname || menuName || freeText).trim();
  const location =
    restaurant && (restaurant === gname || restaurant === menuName) ? freeText : "";
  return { restaurant, location };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (the six identity tests).

- [ ] **Step 5: Commit**

```bash
git add src/popular.ts src/popular.test.ts
git commit -m "feat(popular): POPULAR_TAG + googlePlaceName/resolveIdentity helpers"
```

---

### Task 3: `tagPopular` orchestrator (`popular.ts`)

**Files:**
- Modify: `src/popular.ts`
- Test: `src/popular.test.ts`

**Interfaces:**
- Consumes: `POPULAR_TAG`, `FindPopular`, `resolveIdentity` (Task 2); `Menu` from `./types.js`.
- Produces: `tagPopular(menu: Menu, findPopular: FindPopular, hint?: string): Promise<Menu>` — strips stray `popular`, resolves identity, calls `findPopular`, applies results defensively, returns the (mutated) same menu.

- [ ] **Step 1: Write the failing tests**

Append to `src/popular.test.ts`:

```ts
import { tagPopular } from "./popular.js";

function menuOf(names: string[], restaurant = "Din Tai Fung"): Menu {
  return {
    restaurant: { en: restaurant },
    sections: [
      { en: "S", zh: "區", items: names.map((n) => ({ en: n, zh: n })) },
    ],
  };
}
const idxFinder = (idx: number[]) => async () => idx;

test("tagPopular flags returned items and adds the POPULAR_TAG once", async () => {
  const menu = menuOf(["A", "B", "C"]);
  await tagPopular(menu, idxFinder([0, 2]));
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
  assert.equal(menu.sections[0].items[1].tags ?? undefined, undefined);
  assert.deepEqual(menu.sections[0].items[2].tags, ["popular"]);
  assert.equal(menu.tags?.filter((t) => t.id === "popular").length, 1);
  assert.equal(menu.tags?.[0].icon, "🔥");
});

test("tagPopular strips a stray pre-existing popular tag before applying", async () => {
  const menu = menuOf(["A", "B"]);
  menu.tags = [{ id: "popular", en: "x", zh: "x", icon: "🔥" }];
  menu.sections[0].items[1].tags = ["popular"]; // stray on B
  await tagPopular(menu, idxFinder([0])); // only A is really popular
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
  assert.equal(menu.sections[0].items[1].tags?.includes("popular"), false);
  assert.equal(menu.tags?.filter((t) => t.id === "popular").length, 1);
});

test("tagPopular does not call the finder when there is no restaurant or hint", async () => {
  const menu: Menu = { sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲" }] }] };
  let called = false;
  await tagPopular(menu, async () => { called = true; return [0]; });
  assert.equal(called, false);
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
});

test("tagPopular uses a hint to identify the restaurant when the menu has no name", async () => {
  const menu: Menu = { sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲" }] }] };
  let seen = "";
  await tagPopular(menu, async (r) => { seen = r; return [0]; }, "鼎泰豐");
  assert.equal(seen, "鼎泰豐");
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
});

test("tagPopular ignores out-of-range, negative and duplicate indices", async () => {
  const menu = menuOf(["A", "B"]);
  await tagPopular(menu, idxFinder([0, 0, -1, 5]));
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
  assert.equal(menu.sections[0].items[1].tags ?? undefined, undefined);
});

test("tagPopular adds no tag when the finder returns nothing", async () => {
  const menu = menuOf(["A", "B"]);
  await tagPopular(menu, idxFinder([]));
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
  assert.equal(menu.sections[0].items[0].tags ?? undefined, undefined);
});

test("tagPopular flags none when the finder over-flags (guard)", async () => {
  const menu = menuOf(["A", "B", "C", "D", "E", "F", "G", "H"]); // cap = max(6, 3) = 6
  await tagPopular(menu, idxFinder([0, 1, 2, 3, 4, 5, 6])); // 7 > 6 → none
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
});

test("tagPopular publishes unchanged when the finder throws", async () => {
  const menu = menuOf(["A"]);
  await tagPopular(menu, async () => { throw new Error("boom"); });
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
  assert.equal(menu.sections[0].items[0].tags ?? undefined, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `tagPopular` is not exported.

- [ ] **Step 3: Implement `tagPopular`**

Append to `src/popular.ts`:

```ts
/** Remove any `popular` tag from the menu vocabulary and from every item. */
function stripPopular(menu: Menu): void {
  menu.tags = (menu.tags ?? []).filter((t) => t.id !== "popular");
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      if (it.tags?.length) it.tags = it.tags.filter((t) => t !== "popular");
    }
  }
}

/**
 * Flag the restaurant's popular/signature items with the `popular` tag.
 * Owns the tag end-to-end: strips any stray `popular` first (so a model slip
 * can't leak it), then applies only verified results. Resilient — on no
 * identity, empty/over-flagged result, or a thrown finder, the menu is left
 * with no `popular` tag. Mutates and returns the same menu object.
 */
export async function tagPopular(
  menu: Menu,
  findPopular: FindPopular,
  hint?: string,
): Promise<Menu> {
  stripPopular(menu);

  const { restaurant, location } = resolveIdentity(menu, hint);
  if (!restaurant) return menu;

  const refs = [];
  for (const sec of menu.sections) for (const it of sec.items ?? []) refs.push(it);
  if (!refs.length) return menu;
  const items = refs.map((it, i) => ({ i, en: it.en, zh: it.zh }));

  let idx: number[];
  try {
    idx = await findPopular(restaurant, location, items);
  } catch {
    return menu;
  }

  const seen = new Set<number>();
  const kept: number[] = [];
  for (const n of idx ?? []) {
    if (Number.isInteger(n) && n >= 0 && n < refs.length && !seen.has(n)) {
      seen.add(n);
      kept.push(n);
    }
  }

  const cap = Math.max(6, Math.floor(items.length * 0.4));
  if (kept.length === 0 || kept.length > cap) return menu;

  for (const n of kept) {
    const it = refs[n];
    it.tags = it.tags ?? [];
    if (!it.tags.includes("popular")) it.tags.push("popular");
  }
  menu.tags = [POPULAR_TAG, ...(menu.tags ?? [])];
  return menu;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all `popular.test.ts` cases).

- [ ] **Step 5: Commit**

```bash
git add src/popular.ts src/popular.test.ts
git commit -m "feat(popular): tagPopular orchestrator (strip/resolve/apply, guarded, resilient)"
```

---

### Task 4: Render the `popular` tag (`render.ts`)

**Files:**
- Modify: `src/render.ts:44-47`
- Test: `src/render.test.ts`

**Interfaces:**
- Consumes: `Menu` (with a possible `popular` TagDef from Task 3).
- Produces: `renderMenu` now serializes `popular` into `TAGS_JSON` (no longer stripped); template (unchanged) renders the chip + per-item 🔥.

- [ ] **Step 1: Replace the failing test**

In `src/render.test.ts`, replace the test named
`"renderMenu drops a stray 'popular' tag (reserved for a later phase)"` with:

```ts
test("renderMenu now keeps the 'popular' tag so 🔥 renders (P4a)", () => {
  const html = renderMenu({
    tags: [
      { id: "popular", en: "Popular", zh: "人氣", icon: "🔥", group: "highlight" },
      { id: "vegetarian", en: "Vegetarian", zh: "素", icon: "🌱" },
    ],
    sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲", tags: ["popular"] }] }],
  });
  assert.ok(html.includes('"id":"popular"'), "popular tag kept in vocabulary");
  assert.ok(html.includes('"tags":["popular"]'), "item popular tag embedded");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `"id":"popular"` is absent (still filtered out).

- [ ] **Step 3: Remove the filter**

In `src/render.ts`, change the `{{TAGS_JSON}}` replacement:

```ts
    .replace("{{TAGS_JSON}}", JSON.stringify(menu.tags ?? []));
```

(Replaces the previous `(menu.tags ?? []).filter((t) => t.id !== "popular")`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (new popular render test + the unchanged vocabulary/explain/option tests).

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/render.test.ts
git commit -m "feat(render): stop stripping the popular tag so 🔥 renders"
```

---

### Task 5: Real web-popularity finder (`web-popular.ts`)

**Files:**
- Create: `src/web-popular.ts`

**Interfaces:**
- Consumes: `config` from `./config.js`; `FindPopular` from `./popular.js`; `@anthropic-ai/sdk`.
- Produces: `findPopular: FindPopular` — runs one `web_search`-driven Claude call (handling `pause_turn`) and returns the parsed `popular` index array (`[]` on any failure).

This task has no unit test (it makes real API calls; `config` calls `process.exit` on missing env). Verification is `npm run typecheck` + code review.

- [ ] **Step 1: Implement the finder**

Create `src/web-popular.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { FindPopular } from "./popular.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = `You are a menu-enrichment assistant. Use web_search to find which
dishes a specific restaurant is most famous for / most recommended (its signature
and popular items). Then, from the provided numbered menu item list, decide which
items are clearly among that restaurant's popular/signature dishes.

Return ONLY JSON: {"popular": [the integer "i" values of the popular items]}.
Be conservative — include an item only with real evidence of being signature or
popular. If you cannot confidently identify the restaurant, return {"popular": []}.`;

// web_search server-tool variant for Sonnet 4.6 (dynamic filtering). The SDK
// types may predate this literal; the runtime accepts it — hence the `as any`.
const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }] as any;

/** Find a restaurant's popular items via web search. Returns [] on any failure. */
export const findPopular: FindPopular = async (restaurant, location, items) => {
  const where = location ? ` (${location})` : "";
  const list = items.map((it) => `${it.i}. ${it.en} / ${it.zh}`).join("\n");
  const user = `Restaurant: ${restaurant}${where}\nMenu items:\n${list}`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
  try {
    let resp = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 2000,
      system: SYSTEM,
      tools,
      messages,
    });
    // web_search runs a server-side loop; pause_turn means "resume" — re-send.
    let cont = 0;
    while (resp.stop_reason === "pause_turn" && cont < 6) {
      messages.push({ role: "assistant", content: resp.content });
      resp = await client.messages.create({
        model: config.anthropic.model,
        max_tokens: 2000,
        system: SYSTEM,
        tools,
        messages,
      });
      cont++;
    }
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return [];
    const obj = JSON.parse(text.slice(s, e + 1));
    const arr = (obj as { popular?: unknown }).popular;
    return Array.isArray(arr) ? arr.filter((n): n is number => Number.isInteger(n)) : [];
  } catch (err) {
    console.error("findPopular failed:", err);
    return [];
  }
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/web-popular.ts
git commit -m "feat(web-popular): web_search-based findPopular with pause_turn handling"
```

---

### Task 6: Wire the bot (`bot.ts`)

**Files:**
- Modify: `src/bot.ts`

**Interfaces:**
- Consumes: `tagPopular` from `./popular.js`; `findPopular` from `./web-popular.js`; `BatchStore.setHint` and the new `take` shape (Task 1).
- Produces: collecting-session text hint; `tagPopular` runs between `enrichMenu` and rendering; menu publishes with 🔥 when applicable, unchanged on failure.

This is integration wiring; verification is `npm run typecheck` + VPS acceptance (no unit test).

- [ ] **Step 1: Add imports**

In `src/bot.ts`, alongside the existing imports add:

```ts
import { tagPopular } from "./popular.js";
import { findPopular } from "./web-popular.js";
```

- [ ] **Step 2: Mention the optional hint in the collect prompt**

Replace the `COLLECT_MSG` constant with:

```ts
const COLLECT_MSG =
  "📸 收到。整本菜單可多張照片／PDF 一次傳給我，全部傳完後請按【✅ 完成並產生菜單】。\n" +
  "（可選）再傳一則文字告訴我店名／地點，或貼 Google 地圖連結，辨識會更準。\n" +
  "Send all the pages (photos and/or a PDF); optionally also send the restaurant " +
  "name / location or a Google Maps link. Tap ✅ Done when finished.";
```

- [ ] **Step 3: Update the Done handler to pass the hint**

In the `bot.callbackQuery(DONE_DATA, …)` handler, replace the take + guard + dispatch:

```ts
  const taken = store.take(chatId);
  if (!taken || taken.items.length === 0) {
    await ctx.reply(
      "還沒收到任何菜單照片或 PDF，請先傳給我。\n" +
        "No menu received yet — send photos or a PDF first.",
    );
    return;
  }
  void processBatch(ctx, taken.items, taken.hint);
```

- [ ] **Step 4: Thread the hint through `processBatch` and run `tagPopular`**

Change the signature:

```ts
async function processBatch(
  ctx: Context,
  items: PendingItem[],
  hint?: string,
): Promise<void> {
```

After the `enrichMenu` block (and before `const name = …`), add:

```ts
    try {
      await tagPopular(menu, findPopular, hint);
    } catch (e) {
      console.error("popularity tagging failed (publishing without 🔥):", e);
    }
```

- [ ] **Step 5: Add the text-hint handler (after the command handlers)**

In `src/bot.ts`, immediately AFTER `bot.command("help", …)` and BEFORE `bot.catch(…)`, add:

```ts
// Optional restaurant/location hint typed during a collecting session.
// Registered after the command handlers so /start and /help reach theirs first.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text?.trim();
  const chatId = ctx.chat?.id;
  if (!text || text.startsWith("/") || chatId == null) return;
  if (store.setHint(chatId, text, Date.now())) {
    await ctx.reply(
      "📝 已記下，會用來提升辨識準確度。\nNoted — I'll use this to improve results.",
    );
  }
});
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS (all existing + new tests).

- [ ] **Step 8: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): collect optional hint; run web popularity tagging before publish"
```

---

## Self-Review (author)

**Spec coverage:**
- #4 popularity via web_search → Tasks 3 (orchestrator) + 5 (finder). ✓
- Optional user hint (name/location/Google link) → Tasks 1 (storage) + 2 (parse/resolve) + 6 (collect). ✓
- Popularity stage owns the tag / strip stray → Task 3 `stripPopular`. ✓
- Defensive apply (range/dup/over-flag guard) → Task 3 + tests. ✓
- Graceful degradation → Task 3 (throw → unchanged) + Task 6 (try/catch) + Task 5 (`[]` on failure). ✓
- render lets 🔥 through, template unchanged → Task 4. ✓
- pause_turn handling, `web_search_20260209`, model from config → Task 5. ✓
- No new types/deps → confirmed (only `src/types.ts` untouched; no package.json change). ✓

**Placeholder scan:** none — every code step has complete code and exact commands.

**Type consistency:** `FindPopular(restaurant, location, items)` defined in Task 2 and used identically in Tasks 3, 5. `tagPopular(menu, findPopular, hint?)` consistent in Tasks 3, 6. `take()` new shape `{ items, hint? }` defined in Task 1, consumed in Task 6. `POPULAR_TAG` shape matches the spec and the render test in Task 4.
