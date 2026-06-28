# P4b — Dish Images (#5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For up to 5 signature/popular menu items, find a real dish photo on the web, download and vision-verify it, commit it to the published menu repo, and render it as a thumbnail — best-effort, never blocking publish.

**Architecture:** A pure orchestrator `src/images.ts` (injected `ImageDeps`) selects target items and runs find→download→verify→commit per item. Real deps live in `src/web-image.ts` (Anthropic `web_search`/`web_fetch` to find a URL; Node `fetch` to download; a vision call to verify) and `src/publish.ts` (`publishImage` commits bytes via the GitHub Contents API). `bot.ts` runs it after popularity tagging and before rendering; the template renders an `<img>` for items that got one.

**Tech Stack:** TypeScript ESM, `@anthropic-ai/sdk`, grammy, `node:test` via `tsx`, GitHub Contents API.

## Global Constraints

- Model is always `config.anthropic.model` (`claude-sonnet-4-6`); never hard-code a model id.
- ESM: import specifiers use the `.js` extension.
- `src/images.ts` is a PURE module — it must NOT import `config.ts` or the SDK; all I/O is injected via `ImageDeps`. `src/web-image.ts` may import `config` + SDK and is NOT unit-tested. `src/publish.ts`'s `publishImage` is NOT unit-tested.
- Tests use `node:test` + `node:assert/strict`, run by `npm test`. No new dependencies (no `sharp` or other native image lib). `templates/menu.html` gets a small render addition.
- Targets: items whose `tags` include `"signature"` or `"popular"`, in menu order, capped at **5**.
- Image filename is `dish-<flatIndex>.<ext>`; `MenuItem.img` is the relative path `img/<fileName>`. Set `img` ONLY after a successful `commit`.
- Web tools: `web_search_20260209` (`max_uses: 4`) + `web_fetch_20260209` (`max_uses: 3`); handle `stop_reason === "pause_turn"` by re-sending (cap 6).
- Download accepts only `content-type: image/*`, size `≥ 3000` and `≤ 2*1024*1024` bytes; returns `null` on any failure. Verify is **fail-closed** (returns `false` on any error/uncertainty).
- Everything degrades gracefully: a per-item failure leaves that item without an image; the menu always publishes.
- Branch: `feat/dish-images` (already created; spec committed there).

---

### Task 1: Image orchestrator + `MenuItem.img` (`images.ts`)

**Files:**
- Modify: `src/types.ts` (add `img?` to `MenuItem`)
- Create: `src/images.ts`
- Test: `src/images.test.ts`

**Interfaces:**
- Consumes: `Menu`, `MenuItem` from `./types.js`; `resolveIdentity` from `./popular.js`.
- Produces:
  - `MenuItem.img?: string`.
  - `interface ImageDeps { findImage; download; verify; commit }` (exact shapes below).
  - `addImages(menu: Menu, hint: string | undefined, slug: string, deps: ImageDeps, maxItems?: number): Promise<Menu>`.

- [ ] **Step 1: Add the type field**

In `src/types.ts`, inside `MenuItem`, after the `options?` field add:

```ts
  /** Relative path to a committed dish photo, e.g. "img/dish-3.jpg"; absent if none. */
  img?: string;
```

- [ ] **Step 2: Write the failing tests**

Create `src/images.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { addImages, type ImageDeps } from "./images.js";
import type { Menu } from "./types.js";

function menuWith(items: { en: string; tags: string[] }[]): Menu {
  return {
    sections: [
      { en: "S", zh: "區", items: items.map((x) => ({ en: x.en, zh: x.en, tags: x.tags })) },
    ],
  };
}

function fakeDeps(over: Partial<ImageDeps> = {}): ImageDeps & { commits: { slug: string; fileName: string }[] } {
  const commits: { slug: string; fileName: string }[] = [];
  return {
    findImage: async () => ["u1"],
    download: async () => ({ bytes: Buffer.from("x".repeat(10)), ext: "jpg" }),
    verify: async () => true,
    commit: async (slug, fileName) => { commits.push({ slug, fileName }); },
    commits,
    ...over,
  };
}

test("addImages targets only signature/popular items, capped at 5", async () => {
  const menu = menuWith([
    { en: "A", tags: ["signature"] }, { en: "B", tags: [] }, { en: "C", tags: ["popular"] },
    { en: "D", tags: ["signature"] }, { en: "E", tags: ["popular"] }, { en: "F", tags: ["signature"] },
    { en: "G", tags: ["popular"] },
  ]);
  const seen: string[] = [];
  const deps = fakeDeps({ findImage: async (_r, en) => { seen.push(en); return ["u"]; } });
  await addImages(menu, "Rest", "slug-1", deps);
  assert.deepEqual(seen, ["A", "C", "D", "E", "F"]); // B skipped (untagged), capped at 5 (G excluded)
});

test("addImages sets img = img/dish-<flatIndex>.<ext> after a successful commit", async () => {
  const menu = menuWith([{ en: "A", tags: [] }, { en: "B", tags: ["signature"] }]);
  const deps = fakeDeps();
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[1].img, "img/dish-1.jpg");
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
  assert.deepEqual(deps.commits, [{ slug: "s", fileName: "dish-1.jpg" }]);
});

test("addImages skips a URL whose download returns null, then succeeds", async () => {
  const menu = menuWith([{ en: "A", tags: ["popular"] }]);
  let dl = 0;
  const deps = fakeDeps({
    findImage: async () => ["u1", "u2"],
    download: async () => (++dl === 1 ? null : { bytes: Buffer.from("x".repeat(10)), ext: "webp" }),
  });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img, "img/dish-0.webp");
  assert.equal(dl, 2);
});

test("addImages skips a URL that fails verification, then succeeds", async () => {
  const menu = menuWith([{ en: "A", tags: ["popular"] }]);
  let v = 0;
  const deps = fakeDeps({
    findImage: async () => ["u1", "u2", "u3"],
    verify: async () => ++v >= 2, // first false, then true
  });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img, "img/dish-0.jpg");
  assert.equal(v, 2);
});

test("addImages leaves img unset when commit throws, and still processes other items", async () => {
  const menu = menuWith([{ en: "A", tags: ["signature"] }, { en: "B", tags: ["popular"] }]);
  const deps = fakeDeps({
    commit: async (_slug, fileName) => { if (fileName === "dish-0.jpg") throw new Error("gh fail"); },
  });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
  assert.equal(menu.sections[0].items[1].img, "img/dish-1.jpg");
});

test("addImages does nothing when there is no restaurant identity", async () => {
  const menu = menuWith([{ en: "A", tags: ["signature"] }]);
  let called = false;
  const deps = fakeDeps({ findImage: async () => { called = true; return ["u"]; } });
  await addImages(menu, undefined, "s", deps);
  assert.equal(called, false);
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
});

test("addImages leaves an item without img when no URL works", async () => {
  const menu = menuWith([{ en: "A", tags: ["signature"] }]);
  const deps = fakeDeps({ findImage: async () => [] });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./images.js`.

- [ ] **Step 4: Implement the orchestrator**

Create `src/images.ts`:

```ts
import type { Menu, MenuItem } from "./types.js";
import { resolveIdentity } from "./popular.js";

/** Injected I/O for image enrichment (so the orchestrator stays pure + testable). */
export interface ImageDeps {
  /** Candidate direct image URLs for this dish (best first); [] if none. */
  findImage: (restaurant: string, en: string, zh: string) => Promise<string[]>;
  /** Download + validate a URL → bytes + extension; null on any failure/oversize/non-image. */
  download: (url: string) => Promise<{ bytes: Buffer; ext: string } | null>;
  /** Vision gate: is this a clean real photo of the dish (not logo/banner/collage/wrong)? */
  verify: (bytes: Buffer, ext: string, en: string, zh: string) => Promise<boolean>;
  /** Commit bytes to the menu repo under this slug's img/ folder; throws on failure. */
  commit: (slug: string, fileName: string, bytes: Buffer) => Promise<void>;
}

const DEFAULT_MAX = 5;

/**
 * Best-effort: attach a verified web photo to up to `maxItems` signature/popular
 * items. Resilient — a per-item failure leaves that item without an image; `img`
 * is set only after a successful commit. Mutates and returns the same menu.
 */
export async function addImages(
  menu: Menu,
  hint: string | undefined,
  slug: string,
  deps: ImageDeps,
  maxItems = DEFAULT_MAX,
): Promise<Menu> {
  const { restaurant } = resolveIdentity(menu, hint);
  if (!restaurant) return menu;

  // Flat targets in menu order: items tagged signature or popular, capped.
  const targets: { it: MenuItem; i: number }[] = [];
  let i = 0;
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const tags = it.tags ?? [];
      if ((tags.includes("signature") || tags.includes("popular")) && targets.length < maxItems) {
        targets.push({ it, i });
      }
      i++;
    }
  }

  for (const { it, i: idx } of targets) {
    try {
      const urls = await deps.findImage(restaurant, it.en, it.zh);
      for (const url of urls) {
        const d = await deps.download(url);
        if (!d) continue;
        if (!(await deps.verify(d.bytes, d.ext, it.en, it.zh))) continue;
        const fileName = `dish-${idx}.${d.ext}`;
        await deps.commit(slug, fileName, d.bytes);
        it.img = `img/${fileName}`;
        break;
      }
    } catch (e) {
      console.error(`dish image failed for "${it.en}":`, e);
    }
  }
  return menu;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (the 7 image tests + all existing).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/images.ts src/images.test.ts
git commit -m "feat(images): MenuItem.img + addImages orchestrator (DI, capped, resilient)"
```

---

### Task 2: Web image dependencies (`web-image.ts`)

**Files:**
- Create: `src/web-image.ts`

**Interfaces:**
- Consumes: `config` from `./config.js`; `ImageDeps` from `./images.js`; `@anthropic-ai/sdk`.
- Produces: `findImage: ImageDeps["findImage"]`, `downloadImage: ImageDeps["download"]`, `verifyImage: ImageDeps["verify"]`.

No unit test (real API/network). Verification is `npm run typecheck` + code review.

- [ ] **Step 1: Implement the deps**

Create `src/web-image.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { ImageDeps } from "./images.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Sonnet 4.6 web tools (dynamic filtering). SDK types may predate the literals; runtime accepts them.
const tools = [
  { type: "web_search_20260209", name: "web_search", max_uses: 4 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
] as any;

const FIND_SYSTEM = `You help find a representative photograph of a specific dish at a
specific restaurant. Use web_search and web_fetch to locate a DIRECT image URL (ending
in .jpg/.jpeg/.png/.webp, or an og:image meta URL) that actually shows THIS dish at THIS
restaurant — prefer the official website or a reputable source; avoid stock photos, logos,
and unrelated images.
Return ONLY JSON: {"image_urls": [up to 3 direct image URLs, best first]}.
If you can't find a suitable image, return {"image_urls": []}.`;

/** Find candidate dish image URLs. Returns [] on any failure. */
export const findImage: ImageDeps["findImage"] = async (restaurant, en, zh) => {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Restaurant: ${restaurant}\nDish: ${en} / ${zh}` },
  ];
  try {
    let resp = await client.messages.create({
      model: config.anthropic.model, max_tokens: 1024, system: FIND_SYSTEM, tools, messages,
    });
    let cont = 0;
    while (resp.stop_reason === "pause_turn" && cont < 6) {
      messages.push({ role: "assistant", content: resp.content });
      resp = await client.messages.create({
        model: config.anthropic.model, max_tokens: 1024, system: FIND_SYSTEM, tools, messages,
      });
      cont++;
    }
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return [];
    const arr = (JSON.parse(text.slice(s, e + 1)) as { image_urls?: unknown }).image_urls;
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === "string").slice(0, 3) : [];
  } catch (err) {
    console.error("findImage failed:", err);
    return [];
  }
};

const MAX_BYTES = 2 * 1024 * 1024;
const MIN_BYTES = 3000;

/** Download + validate an image URL. Returns null on any failure/oversize/non-image. */
export const downloadImage: ImageDeps["download"] = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (MenuBot image fetch)" },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES || bytes.length < MIN_BYTES) return null;
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    return { bytes, ext };
  } catch (err) {
    console.error("downloadImage failed:", err);
    return null;
  }
};

const VERIFY_SYSTEM = `You are verifying whether an image is usable as a menu dish photo.
You are given an image and the dish name. Decide whether the image is a clean, real
photograph of THAT dish — the food itself, well-framed — and NOT any of: a logo or
wordmark, a branded banner or promotional graphic with large text, a menu/screenshot/
document, a collage or grid of multiple images, or a clearly different dish.
Return ONLY JSON: {"ok": true} if it is a good, on-topic dish photo, else {"ok": false}.
When unsure, return {"ok": false}.`;

const MEDIA: Record<string, "image/jpeg" | "image/png" | "image/webp"> = {
  jpg: "image/jpeg", png: "image/png", webp: "image/webp",
};

/** Vision gate. Fail-closed: returns false on any error. */
export const verifyImage: ImageDeps["verify"] = async (bytes, ext, en, zh) => {
  try {
    const media_type = MEDIA[ext] ?? "image/jpeg";
    const resp = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 200,
      system: VERIFY_SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type, data: bytes.toString("base64") } },
          { type: "text", text: `Dish: ${en} / ${zh}` },
        ],
      }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return false;
    return (JSON.parse(text.slice(s, e + 1)) as { ok?: unknown }).ok === true;
  } catch (err) {
    console.error("verifyImage failed:", err);
    return false;
  }
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web-image.ts
git commit -m "feat(web-image): find/download/verify dish image deps (web tools + vision gate)"
```

---

### Task 3: Commit an image (`publish.ts`)

**Files:**
- Modify: `src/publish.ts`

**Interfaces:**
- Consumes: existing `gh()` helper + `config`.
- Produces: `publishImage(slug: string, fileName: string, bytes: Buffer): Promise<void>` (throws on non-OK).

No unit test (network). Verification is `npm run typecheck` + code review.

- [ ] **Step 1: Add `publishImage`**

In `src/publish.ts`, after `publishMenu`, add:

```ts
/**
 * Commit a binary image into a menu's img/ folder so GitHub Pages serves it.
 * Paths are always new (slug carries a timestamp), so this creates — no SHA needed.
 */
export async function publishImage(
  slug: string,
  fileName: string,
  bytes: Buffer,
): Promise<void> {
  const { owner, repo, branch, pagesDir } = config.github;
  const path = `${pagesDir}/m/${slug}/img/${fileName}`;
  const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `menu: image ${slug}/${fileName}`,
      content: bytes.toString("base64"),
      branch,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub image publish failed (${res.status}): ${body}`);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/publish.ts
git commit -m "feat(publish): publishImage commits dish photos to the menu repo"
```

---

### Task 4: Render the thumbnail (`render.test.ts` + template)

**Files:**
- Modify: `templates/menu.html`
- Test: `src/render.test.ts`

**Interfaces:**
- Consumes: `MenuItem.img` (Task 1).
- Produces: an `<img class="dish">` rendered for items with `img`.

- [ ] **Step 1: Write the failing test**

Append to `src/render.test.ts`:

```ts
test("renderMenu embeds a dish image path and the template renders it", () => {
  const html = renderMenu({
    sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲", img: "img/dish-0.jpg" }] }],
  });
  assert.ok(html.includes('"img":"img/dish-0.jpg"'), "img path serialized into MENU_JSON");
  assert.ok(html.includes('class="dish"'), "template emits the dish <img> element");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `class="dish"` not present (template has no dish image yet).

- [ ] **Step 3: Add the dish image to the template**

In `templates/menu.html`, in the item-building `.map((... ) => { ... })` (around the
`const meta = …` line), add a `pic` variable after `const meta = …;`:

```js
    const pic = it.img ? `<img class="dish" src="${esc(it.img)}" loading="lazy" alt="">` : "";
```

Then in the item's returned template literal, insert `${pic}` right after the `.row`
closing `</div>` (before `${den}`):

```js
    return `<div class="item" data-tags="${esc(ids.join(" "))}">
      <div class="row">
        <div>
          <div class="name">${esc(it.en)}</div>
          <div class="name-zh">${esc(it.zh)}</div>
          ${meta}
        </div>${price}
      </div>${pic}${den}${dzh}${opts}
    </div>`;
```

And in the `<style>` block, after the `.item .tags { … }` rule, add:

```css
  .dish { display: block; width: 100%; max-height: 200px; object-fit: cover; border-radius: 10px; margin-top: 8px; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (new dish image test + all existing render tests).

- [ ] **Step 5: Commit**

```bash
git add templates/menu.html src/render.test.ts
git commit -m "feat(template): render a dish thumbnail for items with an image"
```

---

### Task 5: Wire the bot (`bot.ts`)

**Files:**
- Modify: `src/bot.ts`

**Interfaces:**
- Consumes: `addImages` from `./images.js`; `findImage`, `downloadImage`, `verifyImage` from `./web-image.js`; `publishImage` from `./publish.js`; the existing `hint` already threaded into `processBatch` (P4a).
- Produces: image enrichment runs after `tagPopular`, before render/publish, sharing one `slug`.

Integration wiring; verification is `npm run typecheck` + full `npm test`.

- [ ] **Step 1: Update imports**

In `src/bot.ts`, change the publish import and add the image imports:

```ts
import { publishMenu, publishImage } from "./publish.js";
import { addImages } from "./images.js";
import { findImage, downloadImage, verifyImage } from "./web-image.js";
```

(The existing `import { publishMenu } from "./publish.js";` becomes the combined line above.)

- [ ] **Step 2: Run images between tagging and rendering**

In `processBatch`, the current tail computes `name`/`slug`/`html` then publishes:

```ts
    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);
    const html = renderMenu(menu);

    await ctx.reply("🌐 正在發佈網頁… Publishing…");
    const { url } = await publishMenu(slug, html);
```

Replace that block with (slug computed before images; image stage added):

```ts
    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);

    await ctx.reply("🖼️ 正在找菜品圖… Finding dish photos…");
    try {
      await addImages(menu, hint, slug, {
        findImage,
        download: downloadImage,
        verify: verifyImage,
        commit: publishImage,
      });
    } catch (e) {
      console.error("dish images failed (publishing without photos):", e);
    }

    const html = renderMenu(menu);
    await ctx.reply("🌐 正在發佈網頁… Publishing…");
    const { url } = await publishMenu(slug, html);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (all existing + Task 1/4 additions).

- [ ] **Step 5: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): fetch & attach dish images before publishing"
```

---

## Self-Review (author)

**Spec coverage:**
- `MenuItem.img` → Task 1. ✓
- Orchestrator: target selection (signature/popular, cap 5), find→download→verify→commit, set img only after commit, graceful → Task 1 + tests. ✓
- `findImage`/`downloadImage` (image/* + size bounds)/`verifyImage` (fail-closed, ext→media_type), pause_turn, model from config → Task 2. ✓
- `publishImage` → Task 3. ✓
- Template `<img class="dish">` after meta/row, CSS → Task 4. ✓
- Bot wiring: slug before images, addImages after tagPopular, reply, graceful → Task 5. ✓
- No new deps, pure images.ts, ESM `.js` → constraints honored. ✓

**Placeholder scan:** none — every code step contains complete code and exact commands.

**Type consistency:** `ImageDeps` shape (Task 1) is reused via `ImageDeps["findImage"|"download"|"verify"]` in Task 2 and passed as `{ findImage, download: downloadImage, verify: verifyImage, commit: publishImage }` in Task 5 — names align. `verify(bytes, ext, en, zh)` consistent across Task 1 orchestrator call, Task 1 tests, and Task 2 impl. `download` returns `{ bytes, ext }` consistently. `publishImage(slug, fileName, bytes)` matches the `commit` member type. `addImages(menu, hint, slug, deps, maxItems?)` consistent in Tasks 1 and 5.
