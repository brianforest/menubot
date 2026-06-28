# P5 — Original-File Archive + Hidden `/vault` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive each menu's original uploaded files on the VPS keyed by slug, retrieve them via a hidden `/vault` command back into Telegram, and reveal the published link only after it's confirmed live (no 404).

**Architecture:** A pure filesystem module `src/archive.ts` (base dir injected) saves/reads/lists originals and parses a slug from a URL. `src/publish.ts` gains `waitUntilLive(url)` (HEAD poll). `src/bot.ts` saves originals on publish, polls until live before showing the link, and adds the hidden `/vault` command; `src/config.ts` adds the archive dir.

**Tech Stack:** TypeScript ESM, grammy (`InputFile`), Node `fs`, `node:test` via `tsx`.

## Global Constraints

- ESM: import specifiers use the `.js` extension.
- `src/archive.ts` is a PURE module — no `config` import; the base directory is a parameter (unit-tested against a temp dir). `publish.ts` `waitUntilLive` and the `bot.ts` wiring are NOT unit-tested (network / grammy) — verified by `npm run typecheck` + VPS acceptance.
- Tests use `node:test` + `node:assert/strict`, run by `npm test`. No new dependencies.
- Archive layout: `<baseDir>/<slug>/page-<i>.<ext>`; ext from MIME (jpeg→`jpg`, png→`png`, webp→`webp`, pdf→`pdf`, else `jpg`). Default base dir `data/originals` (git-ignored).
- `/vault` is registered as a command (so `/`-routing works) but is **NOT** added to `setMyCommands` (stays hidden); it must be registered **before** the `message:text` handler so the text handler can't swallow it. Privacy relies on the existing allow-list middleware.
- Originals are sent back as **documents** (`InputFile`), not compressed photos.
- Archiving + the live-poll must never throw out of `processBatch` in a way that blocks publishing; archiving runs regardless of `WEB_ENRICH`.
- `waitUntilLive`: HEAD poll, per-probe 5 s timeout, retry every 3 s, cap 90 s; returns whether it went live.
- Branch: `feat/original-archive` (already created; spec committed there).

---

### Task 1: Archive module (`archive.ts`)

**Files:**
- Create: `src/archive.ts`
- Test: `src/archive.test.ts`

**Interfaces:**
- Consumes: Node `fs`/`path`.
- Produces:
  - `interface ArchivedFile { name: string; bytes: Buffer }`
  - `extOf(mime: string): string`
  - `saveOriginals(baseDir: string, slug: string, sources: { bytes: Buffer; mime: string }[]): void`
  - `readOriginals(baseDir: string, slug: string): ArchivedFile[]`
  - `listSlugs(baseDir: string, limit: number): string[]`
  - `parseSlug(arg: string): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/archive.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveOriginals, readOriginals, listSlugs, parseSlug, extOf } from "./archive.js";

const tmp = () => mkdtempSync(join(tmpdir(), "menubot-archive-"));

test("parseSlug extracts the slug from a published URL (with trailing slash and anchor)", () => {
  assert.equal(
    parseSlug("https://brianforest.github.io/menus/m/topee-restaurant-cutn9/"),
    "topee-restaurant-cutn9",
  );
  assert.equal(
    parseSlug("https://brianforest.github.io/menus/m/topee-restaurant-cutn9/#sec-0"),
    "topee-restaurant-cutn9",
  );
});

test("parseSlug accepts a bare slug and rejects junk", () => {
  assert.equal(parseSlug("  surrey-hills-y9bee "), "surrey-hills-y9bee");
  assert.equal(parseSlug("not a slug!"), null);
  assert.equal(parseSlug(""), null);
});

test("extOf maps MIME to a file extension", () => {
  assert.equal(extOf("image/jpeg"), "jpg");
  assert.equal(extOf("image/png"), "png");
  assert.equal(extOf("image/webp"), "webp");
  assert.equal(extOf("application/pdf"), "pdf");
  assert.equal(extOf("image/heic"), "jpg"); // fallback
});

test("saveOriginals + readOriginals round-trips files with correct names and bytes", () => {
  const base = tmp();
  saveOriginals(base, "rest-abc12", [
    { bytes: Buffer.from("AAA"), mime: "image/jpeg" },
    { bytes: Buffer.from("%PDF-"), mime: "application/pdf" },
  ]);
  const files = readOriginals(base, "rest-abc12");
  assert.deepEqual(files.map((f) => f.name), ["page-0.jpg", "page-1.pdf"]);
  assert.equal(files[0].bytes.toString(), "AAA");
  assert.equal(files[1].bytes.toString(), "%PDF-");
});

test("readOriginals on an absent slug returns []", () => {
  assert.deepEqual(readOriginals(tmp(), "nope-12345"), []);
});

test("saveOriginals with no sources writes nothing", () => {
  const base = tmp();
  saveOriginals(base, "empty-00000", []);
  assert.deepEqual(readOriginals(base, "empty-00000"), []);
});

test("listSlugs returns saved slugs capped at limit", () => {
  const base = tmp();
  for (const s of ["a-1", "b-2", "c-3"]) {
    saveOriginals(base, s, [{ bytes: Buffer.from("x"), mime: "image/jpeg" }]);
  }
  const slugs = listSlugs(base, 2);
  assert.equal(slugs.length, 2);
  assert.ok(slugs.every((s) => ["a-1", "b-2", "c-3"].includes(s)));
});

test("listSlugs on an absent base dir returns []", () => {
  assert.deepEqual(listSlugs(join(tmp(), "missing"), 10), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./archive.js`.

- [ ] **Step 3: Implement the module**

Create `src/archive.ts`:

```ts
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export interface ArchivedFile {
  name: string;
  bytes: Buffer;
}

/** Map a source MIME to an archive file extension. */
export function extOf(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("pdf")) return "pdf";
  return "jpg";
}

/** Save a menu's original sources under <baseDir>/<slug>/ as page-<i>.<ext>. */
export function saveOriginals(
  baseDir: string,
  slug: string,
  sources: { bytes: Buffer; mime: string }[],
): void {
  if (!sources.length) return;
  const dir = join(baseDir, slug);
  mkdirSync(dir, { recursive: true });
  sources.forEach((s, i) => {
    writeFileSync(join(dir, `page-${i}.${extOf(s.mime)}`), s.bytes);
  });
}

/** Read a slug's archived files, sorted by name; [] if the folder is absent. */
export function readOriginals(baseDir: string, slug: string): ArchivedFile[] {
  const dir = join(baseDir, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, bytes: readFileSync(join(dir, name)) }));
}

/** List archived slugs, newest first (by folder mtime), capped at `limit`. */
export function listSlugs(baseDir: string, limit: number): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, t: statSync(join(baseDir, e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.name);
}

/** Extract a slug from a /vault argument: a published URL (…/m/<slug>/…) or a
 *  bare slug. Returns null if it doesn't look like either. */
export function parseSlug(arg: string): string | null {
  const t = arg.trim();
  const m = t.match(/\/m\/([a-z0-9-]+)/i);
  if (m) return m[1];
  if (/^[a-z0-9-]+$/i.test(t)) return t;
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (the 8 archive tests + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts src/archive.test.ts
git commit -m "feat(archive): save/read/list originals + parseSlug (pure, DI base dir)"
```

---

### Task 2: Wait-until-live poll (`publish.ts`)

**Files:**
- Modify: `src/publish.ts`

**Interfaces:**
- Produces: `waitUntilLive(url: string, timeoutMs?: number, intervalMs?: number): Promise<boolean>`.

No unit test (network/timing). Verification is `npm run typecheck` + code review.

- [ ] **Step 1: Add `waitUntilLive`**

In `src/publish.ts`, after `publishImage`, add:

```ts
/**
 * Poll a URL with HEAD until it responds <400 or the timeout elapses, so a
 * freshly-published GitHub Pages link is only revealed once it's live (no 404).
 * Each probe has its own 5s timeout; 404 / network errors are treated as
 * "not live yet" and retried. Returns true if it went live.
 */
export async function waitUntilLive(
  url: string,
  timeoutMs = 90_000,
  intervalMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // not live yet — fall through to retry
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/publish.ts
git commit -m "feat(publish): waitUntilLive HEAD-polls a published URL until live"
```

---

### Task 3: Wire archive + live-poll + `/vault` (`config.ts`, `bot.ts`)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/bot.ts`

**Interfaces:**
- Consumes: `saveOriginals`, `readOriginals`, `listSlugs`, `parseSlug` (Task 1); `waitUntilLive` (Task 2); grammy `InputFile`.
- Produces: archive-on-publish, live-confirmed link, hidden `/vault` command, `config.archive.dir`.

Integration wiring; verification is `npm run typecheck` + full `npm test`.

- [ ] **Step 1: Add the archive dir to config**

In `src/config.ts`, inside the `config` object after the `glossary` block, add:

```ts
  archive: {
    dir: optional("ARCHIVE_DIR", "data/originals"),
  },
```

- [ ] **Step 2: Update imports in `bot.ts`**

Change the grammy import to include `InputFile`, the publish import to include `waitUntilLive`, and add the archive import:

```ts
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
```
```ts
import { publishMenu, publishImage, waitUntilLive } from "./publish.js";
import { saveOriginals, readOriginals, listSlugs, parseSlug } from "./archive.js";
```

- [ ] **Step 3: Replace the publish tail in `processBatch`**

Replace this block (currently after the `if (config.web.enabled) { … }` close):

```ts
    const html = renderMenu(menu);
    await ctx.reply("🌐 正在發佈網頁… Publishing…");
    const { url } = await publishMenu(slug, html);

    const count = menu.sections.reduce((n, s) => n + (s.items?.length || 0), 0);
    await ctx.reply(
      `✅ 完成！${menu.sections.length} 個分類、${count} 道餐點。\n` +
        `Done! Tap to view & share:\n${url}\n\n` +
        `（GitHub Pages 首次發佈可能需 1–2 分鐘生效）`,
      { link_preview_options: { is_disabled: false } },
    );
```

with:

```ts
    const html = renderMenu(menu);

    // Archive the originals (filesystem, instant) — best-effort, never blocks publish.
    try {
      saveOriginals(config.archive.dir, slug, sources);
    } catch (e) {
      console.error("archive save failed:", e);
    }

    await ctx.reply("🌐 發佈中，確認連結生效… Publishing…");
    const { url } = await publishMenu(slug, html);
    const live = await waitUntilLive(url);

    const count = menu.sections.reduce((n, s) => n + (s.items?.length || 0), 0);
    await ctx.reply(
      `✅ 完成！${menu.sections.length} 個分類、${count} 道餐點。\n` +
        `Done! Tap to view & share:\n${url}` +
        (live ? "" : "\n\n（GitHub Pages 首次發佈可能需 1–2 分鐘生效）"),
      { link_preview_options: { is_disabled: false } },
    );
```

- [ ] **Step 4: Add the hidden `/vault` command**

In `src/bot.ts`, immediately AFTER the `bot.command("help", …)` block and BEFORE the
`// Optional restaurant/location hint …` `bot.on("message:text", …)` handler, add:

```ts
// Hidden archive retrieval (not in setMyCommands). Returns a menu's original
// uploads by published URL or slug. Private via the allow-list middleware.
// Registered before message:text so the text handler can't swallow "/vault …".
bot.command("vault", async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    const slugs = listSlugs(config.archive.dir, 10);
    await ctx.reply(
      slugs.length
        ? "🗄️ 最近封存：\n" +
            slugs.map((s) => `• ${s}`).join("\n") +
            "\n\n用 /vault <slug> 或貼發佈網址調閱原始檔。"
        : "目前沒有封存的菜單。",
    );
    return;
  }
  const slug = parseSlug(arg);
  if (!slug) {
    await ctx.reply("認不出 slug。請貼發佈網址（…/m/<slug>/）或直接給 slug。");
    return;
  }
  const files = readOriginals(config.archive.dir, slug);
  if (!files.length) {
    await ctx.reply(`找不到「${slug}」的原始檔（可能是此功能上線前發佈的）。`);
    return;
  }
  await ctx.reply(`📂 ${slug} 的原始檔（${files.length} 個）`);
  for (const f of files) {
    await ctx.replyWithDocument(new InputFile(f.bytes, f.name));
  }
});
```

(`setMyCommands` in `src/index.ts` is left unchanged — `/vault` stays unlisted.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (existing 54 + Task 1's archive tests).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/bot.ts
git commit -m "feat(bot): archive originals, poll until live, hidden /vault retrieval"
```

---

## Self-Review (author)

**Spec coverage:**
- Save originals keyed by slug → Task 1 (`saveOriginals`) + Task 3 (wired after slug). ✓
- `/vault` by URL or slug, no-arg list, hidden, documents → Task 1 (`parseSlug`/`readOriginals`/`listSlugs`) + Task 3 (command, `InputFile`, not in `setMyCommands`). ✓
- Reveal link only once live → Task 2 (`waitUntilLive`) + Task 3 (poll + conditional note). ✓
- Archive dir config (git-ignored default) → Task 3 step 1. ✓
- Pure `archive.ts`, no new deps, ESM `.js` → constraints honored. ✓
- Privacy via allow-list + unlisted command → Task 3 step 4 note. ✓

**Placeholder scan:** none — every code step has complete code and exact commands.

**Type consistency:** `saveOriginals(baseDir, slug, sources)` takes `{ bytes, mime }[]`; `processBatch`'s `sources: MenuSource[]` satisfies it. `readOriginals`/`listSlugs`/`parseSlug` signatures match between Task 1 and the Task 3 call sites. `waitUntilLive(url)` returns `Promise<boolean>` consumed as `live`. `config.archive.dir` defined in Task 3 step 1, used in steps 3–4.
