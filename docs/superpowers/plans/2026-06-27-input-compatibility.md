# Input Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MenuBot accept a whole menu as any number of photos and/or a PDF, producing exactly one published page per menu, with the user pressing a Done button to trigger processing.

**Architecture:** Replace the timer-flushed photo buffer with a user-driven collecting session keyed by chat id (a pure `BatchStore`), triggered to process by an inline "Done" button (no short auto-start; a 30-minute idle safety net only expires abandoned batches). Generalise the extraction input from `Buffer[]` to a `MenuSource[]` (image or PDF) and build Anthropic content blocks (image / native PDF `document`) in a pure, testable `blocks.ts`.

**Tech Stack:** Node.js (ESM, TypeScript), grammY (Telegram), `@anthropic-ai/sdk` (Claude vision + native PDF document blocks). Tests via Node's built-in `node:test` runner under `tsx`.

## Global Constraints

- Code comments / docstrings / commit messages in **English**; user-facing bot copy **bilingual 繁中 + English**.
- ESM throughout: intra-project imports use the `.js` extension (e.g. `import { x } from "./blocks.js"`).
- Keep `claude-sonnet-4-6`, streaming, `max_tokens: 32000`, and the existing `max_tokens` truncation guard in `extract.ts`.
- PDFs go in as Claude native `document` base64 blocks — no poppler, no image conversion, no new runtime dependency.
- The **Done button is the only normal trigger**. No short countdown auto-start. Safety net = 30-minute idle expiry that only frees memory + notifies; it must never auto-process.
- Telegram Bot API caps file *download* at 20 MB/file; the aggregate request guard `MAX_TOTAL_BYTES = 20 * 1024 * 1024` is consistent with that.
- Pure modules (`blocks.ts`, `batch.ts`) must not import `config.ts` (it calls `process.exit(1)` on missing env at import time, which would kill the test runner).

---

### Task 1: Test runner + `MenuSource` type

**Files:**
- Modify: `package.json` (add `test` script)
- Modify: `src/types.ts` (add `MenuSource`)

**Interfaces:**
- Produces: `MenuSource = { kind: "image" | "pdf"; bytes: Buffer; mime: string }` (consumed by `blocks.ts`, `extract.ts`, `bot.ts`).

- [ ] **Step 1: Add the test script to `package.json`**

In the `"scripts"` block, add a `test` entry (place it after `"typecheck"`):

```json
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "node --import tsx --test 'src/**/*.test.ts'"
```

- [ ] **Step 2: Add `MenuSource` to `src/types.ts`**

Append to the end of `src/types.ts`:

```ts
/** One ingestion source for the extractor: a photo or a PDF. */
export interface MenuSource {
  /** "image" (e.g. a JPEG photo) or "pdf". */
  kind: "image" | "pdf";
  /** Raw file bytes. */
  bytes: Buffer;
  /** MIME type, e.g. "image/jpeg" or "application/pdf". */
  mime: string;
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors (exit 0).

- [ ] **Step 4: Commit**

```bash
git add package.json src/types.ts
git commit -m "chore: add node:test runner script and MenuSource type"
```

---

### Task 2: `blocks.ts` — Anthropic content-block builder

**Files:**
- Create: `src/blocks.ts`
- Test: `src/blocks.test.ts`

**Interfaces:**
- Consumes: `MenuSource` (Task 1).
- Produces: `buildContentBlocks(sources: MenuSource[]): Anthropic.ContentBlockParam[]` — media blocks (image / document) followed by one text block. Consumed by `extract.ts` (Task 4… i.e. Task 3 here is extract). Used by `extract.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/blocks.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentBlocks } from "./blocks.js";

test("single image → one image block + text block", () => {
  const blocks = buildContentBlocks([
    { kind: "image", bytes: Buffer.from("hello"), mime: "image/jpeg" },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "image");
  const img = blocks[0] as { source: { media_type: string; data: string } };
  assert.equal(img.source.media_type, "image/jpeg");
  assert.equal(img.source.data, Buffer.from("hello").toString("base64"));
  const text = blocks[1] as { type: string; text: string };
  assert.equal(text.type, "text");
  assert.match(text.text, /this menu/i);
});

test("image media type is taken from the source mime", () => {
  const blocks = buildContentBlocks([
    { kind: "image", bytes: Buffer.from("x"), mime: "image/png" },
  ]);
  const img = blocks[0] as { source: { media_type: string } };
  assert.equal(img.source.media_type, "image/png");
});

test("pdf → document block with application/pdf", () => {
  const blocks = buildContentBlocks([
    { kind: "pdf", bytes: Buffer.from("%PDF-1.7"), mime: "application/pdf" },
  ]);
  assert.equal(blocks[0].type, "document");
  const doc = blocks[0] as { source: { type: string; media_type: string; data: string } };
  assert.equal(doc.source.type, "base64");
  assert.equal(doc.source.media_type, "application/pdf");
  assert.equal(doc.source.data, Buffer.from("%PDF-1.7").toString("base64"));
});

test("multiple sources → all media blocks then one text block saying 'one menu'", () => {
  const blocks = buildContentBlocks([
    { kind: "image", bytes: Buffer.from("a"), mime: "image/jpeg" },
    { kind: "image", bytes: Buffer.from("b"), mime: "image/jpeg" },
    { kind: "pdf", bytes: Buffer.from("c"), mime: "application/pdf" },
  ]);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.map((b) => b.type), ["image", "image", "document", "text"]);
  const text = blocks[3] as { text: string };
  assert.match(text.text, /one menu/i);
});

test("a single pdf is still described as one menu (multi-page)", () => {
  const blocks = buildContentBlocks([
    { kind: "pdf", bytes: Buffer.from("c"), mime: "application/pdf" },
  ]);
  const text = blocks[1] as { text: string };
  assert.match(text.text, /one menu/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './blocks.js'` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/blocks.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { MenuSource } from "./types.js";

/** Describe the batch to the model, scaling wording to the number of sources. */
function promptText(sources: MenuSource[]): string {
  const imgs = sources.filter((s) => s.kind === "image").length;
  const pdfs = sources.filter((s) => s.kind === "pdf").length;
  // A single PDF is itself multi-page, so anything but exactly one image is "one menu".
  if (sources.length === 1 && imgs === 1) {
    return "Digitise this menu as one JSON object.";
  }
  const parts: string[] = [];
  if (imgs) parts.push(`${imgs} photo(s)`);
  if (pdfs) parts.push(`${pdfs} PDF(s)`);
  return `These ${parts.join(" and ")} are pages of one menu. Digitise the whole thing as one JSON object.`;
}

/**
 * Turn ingestion sources into Anthropic content blocks: every image/PDF block
 * first, then a single instruction text block.
 */
export function buildContentBlocks(
  sources: MenuSource[],
): Anthropic.ContentBlockParam[] {
  const media: Anthropic.ContentBlockParam[] = sources.map((s) =>
    s.kind === "pdf"
      ? {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: s.bytes.toString("base64"),
          },
        }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: s.mime as Anthropic.Base64ImageSource["media_type"],
            data: s.bytes.toString("base64"),
          },
        },
  );
  return [...media, { type: "text", text: promptText(sources) }];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all 5 `blocks` tests).

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/blocks.ts src/blocks.test.ts
git commit -m "feat(blocks): build image/PDF content blocks from MenuSource"
```

---

### Task 3: `extract.ts` — accept `MenuSource[]`

**Files:**
- Modify: `src/extract.ts`

**Interfaces:**
- Consumes: `MenuSource` (Task 1), `buildContentBlocks` (Task 2).
- Produces: `extractMenu(sources: MenuSource[]): Promise<Menu>` (consumed by `bot.ts`, Task 5).

> No unit test here: `extract.ts` constructs the Anthropic client at import time and `extractMenu` makes a network call. The block-assembly logic it relies on is already tested in Task 2. This task is verified by `npm run typecheck`.

- [ ] **Step 1: Update imports**

In `src/extract.ts`, replace the top import of `Menu` and add the new ones. Change:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Menu } from "./types.js";
```

to:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Menu, MenuSource } from "./types.js";
import { buildContentBlocks } from "./blocks.js";
```

- [ ] **Step 2: Update the SYSTEM prompt's first sentence**

In the `SYSTEM` template literal, change:

```
photos of a single restaurant's menu (possibly several pages/sides). Read every
```

to:

```
photos and/or a PDF of a single restaurant's menu (possibly several pages/sides).
Read every
```

- [ ] **Step 3: Delete the now-unused `imageBlock` helper**

Remove this function entirely from `src/extract.ts`:

```ts
/** Build an Anthropic image content block from raw bytes. */
function imageBlock(bytes: Buffer): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: bytes.toString("base64"),
    },
  };
}
```

- [ ] **Step 4: Change `extractMenu`'s signature and message content**

Replace the function signature and the `.stream({...})` call. Change:

```ts
export async function extractMenu(images: Buffer[]): Promise<Menu> {
  // A full multi-page menu can be large; 8k tokens truncated the JSON
  // mid-array. With a generous max_tokens the SDK rejects a non-streaming
  // request ("Streaming is required for operations that may take longer than
  // 10 minutes"), so we stream and collect the final message.
  const resp = await client.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: 32000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            ...images.map(imageBlock),
            {
              type: "text",
              text:
                images.length > 1
                  ? `These ${images.length} photos are pages of one menu. Digitise the whole thing as one JSON object.`
                  : "Digitise this menu as one JSON object.",
            },
          ],
        },
      ],
    })
    .finalMessage();
```

to:

```ts
export async function extractMenu(sources: MenuSource[]): Promise<Menu> {
  // A full multi-page menu can be large; 8k tokens truncated the JSON
  // mid-array. With a generous max_tokens the SDK rejects a non-streaming
  // request ("Streaming is required for operations that may take longer than
  // 10 minutes"), so we stream and collect the final message.
  const resp = await client.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: 32000,
      system: SYSTEM,
      messages: [{ role: "user", content: buildContentBlocks(sources) }],
    })
    .finalMessage();
```

Leave the rest of the function (text join, `max_tokens` guard, `parseJson`, sections check) unchanged.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `Anthropic.ImageBlockParam` is reported unused elsewhere, ensure the helper was fully removed.)

- [ ] **Step 6: Verify existing tests still pass**

Run: `npm test`
Expected: PASS (Task 2 tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/extract.ts
git commit -m "feat(extract): accept MenuSource[] (images + native PDF)"
```

---

### Task 4: `batch.ts` — collecting-session state machine

**Files:**
- Create: `src/batch.ts`
- Test: `src/batch.test.ts`

**Interfaces:**
- Produces:
  - `PendingItem = { fileId: string; kind: "image" | "pdf"; mime: string }`
  - `class BatchStore` with:
    - `add(chatId: number, item: PendingItem, now: number): { isNew: boolean; count: number }`
    - `take(chatId: number): PendingItem[] | undefined`
    - `expireStale(now: number, ttlMs: number): number[]`
  - Consumed by `bot.ts` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `src/batch.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchStore, type PendingItem } from "./batch.js";

const item = (id: string): PendingItem => ({ fileId: id, kind: "image", mime: "image/jpeg" });

test("first add to a chat is new; subsequent adds are not, count grows", () => {
  const store = new BatchStore();
  assert.deepEqual(store.add(1, item("a"), 1000), { isNew: true, count: 1 });
  assert.deepEqual(store.add(1, item("b"), 1100), { isNew: false, count: 2 });
  assert.deepEqual(store.add(1, item("c"), 1200), { isNew: false, count: 3 });
});

test("different chats have independent batches", () => {
  const store = new BatchStore();
  assert.equal(store.add(1, item("a"), 1000).isNew, true);
  assert.equal(store.add(2, item("a"), 1000).isNew, true);
  assert.equal(store.add(1, item("b"), 1000).count, 2);
  assert.equal(store.add(2, item("b"), 1000).count, 2);
});

test("take returns the items and clears the batch", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000);
  store.add(1, item("b"), 1000);
  const taken = store.take(1);
  assert.deepEqual(taken?.map((i) => i.fileId), ["a", "b"]);
  assert.equal(store.take(1), undefined); // cleared
});

test("take on an unknown chat returns undefined", () => {
  const store = new BatchStore();
  assert.equal(store.take(99), undefined);
});

test("expireStale returns and removes only batches idle >= ttl", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000); // last activity 1000
  store.add(2, item("a"), 5000); // last activity 5000
  const ttl = 2000;
  // now = 4000: chat 1 idle 3000 (>= ttl) expires; chat 2 idle -1000 stays
  assert.deepEqual(store.expireStale(4000, ttl), [1]);
  assert.equal(store.take(1), undefined); // removed
  assert.notEqual(store.take(2), undefined); // still there
});

test("activity resets the idle clock", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000);
  store.add(1, item("b"), 3000); // resets lastActivityAt to 3000
  const ttl = 2000;
  assert.deepEqual(store.expireStale(4000, ttl), []); // idle 1000 < ttl
  assert.deepEqual(store.expireStale(5000, ttl), [1]); // idle 2000 >= ttl
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './batch.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/batch.ts`:

```ts
/** A buffered, not-yet-downloaded menu file (photo or PDF) awaiting "Done". */
export interface PendingItem {
  fileId: string;
  kind: "image" | "pdf";
  mime: string;
}

interface Batch {
  items: PendingItem[];
  lastActivityAt: number;
}

/**
 * Per-chat collecting sessions. Pure (no Telegram, no clock): callers pass the
 * current timestamp so the logic is deterministic and unit-testable. The bot
 * layer wires Telegram updates and the safety-net timer to these methods.
 */
export class BatchStore {
  private batches = new Map<number, Batch>();

  /** Buffer an item; isNew=true means this opened a fresh batch (send the prompt). */
  add(chatId: number, item: PendingItem, now: number): { isNew: boolean; count: number } {
    let batch = this.batches.get(chatId);
    const isNew = batch === undefined;
    if (!batch) {
      batch = { items: [], lastActivityAt: now };
      this.batches.set(chatId, batch);
    }
    batch.items.push(item);
    batch.lastActivityAt = now;
    return { isNew, count: batch.items.length };
  }

  /** Remove and return a chat's buffered items (on "Done"); undefined if none. */
  take(chatId: number): PendingItem[] | undefined {
    const batch = this.batches.get(chatId);
    if (!batch) return undefined;
    this.batches.delete(chatId);
    return batch.items;
  }

  /** Remove batches idle for >= ttlMs; return their chat ids (for notifying). */
  expireStale(now: number, ttlMs: number): number[] {
    const expired: number[] = [];
    for (const [chatId, batch] of this.batches) {
      if (now - batch.lastActivityAt >= ttlMs) expired.push(chatId);
    }
    for (const chatId of expired) this.batches.delete(chatId);
    return expired;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all `batch` tests + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/batch.ts src/batch.test.ts
git commit -m "feat(batch): per-chat collecting-session state machine"
```

---

### Task 5: `bot.ts` — collecting UX, PDF/photo handlers, Done button, safety net

**Files:**
- Modify: `src/bot.ts`

**Interfaces:**
- Consumes: `BatchStore`, `PendingItem` (Task 4); `MenuSource` (Task 1); `extractMenu` (Task 3); existing `renderMenu`, `slugify`, `publishMenu`.

> Verified by `npm run typecheck` + `npm test` (pure modules) and the end-to-end VPS check in Rollout. The Telegram wiring itself has no unit test (consistent with the existing project).

- [ ] **Step 1: Replace the imports block**

At the top of `src/bot.ts`, change:

```ts
import { Bot, type Context } from "grammy";
import { config } from "./config.js";
import { extractMenu } from "./extract.js";
import { renderMenu, slugify } from "./render.js";
import { publishMenu } from "./publish.js";
```

to:

```ts
import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "./config.js";
import { extractMenu } from "./extract.js";
import { renderMenu, slugify } from "./render.js";
import { publishMenu } from "./publish.js";
import { BatchStore, type PendingItem } from "./batch.js";
import type { MenuSource } from "./types.js";
```

- [ ] **Step 2: Replace the whole "Photo batching" section**

Delete everything from the `// ── Photo batching ──` comment down to and including the end of the `downloadPhoto` function (the original `FLUSH_MS`, `Batch` interface, `batches` map, `bot.on("message:photo", ...)`, `processBatch`, and `downloadPhoto`). Replace that entire span with:

```ts
// ── Collecting session ───────────────────────────────────────
// A menu may be many photos (Telegram splits albums at 10) and/or a PDF. We
// buffer everything per chat and process only when the user taps Done — a timer
// can't tell "finished" from "upload stalled", so there is no auto-start. A
// 30-minute idle safety net only frees memory and notifies; it never processes.
const store = new BatchStore();
const DONE_DATA = "menu_done";
const IDLE_EXPIRY_MS = 30 * 60 * 1000;
// Telegram Bot API caps file download at 20 MB/file; keep the aggregate here too.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const doneKeyboard = new InlineKeyboard().text("✅ 完成並產生菜單 / Done", DONE_DATA);

const COLLECT_MSG =
  "📸 收到。整本菜單可多張照片／PDF 一次傳給我，全部傳完後請按【✅ 完成並產生菜單】。\n" +
  "Send all the pages (photos and/or a PDF); tap ✅ Done when you've finished.";
const EXPIRY_MSG =
  "📭 這批等待過久已自動清空，請重新傳整本菜單。\n" +
  "This session expired after a long pause — please resend the menu.";

async function onNewMedia(ctx: Context, item: PendingItem): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const { isNew } = store.add(chatId, item, Date.now());
  if (isNew) await ctx.reply(COLLECT_MSG, { reply_markup: doneKeyboard });
}

bot.on("message:photo", async (ctx) => {
  // Largest available size is the last entry.
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  await onNewMedia(ctx, { fileId: photo.file_id, kind: "image", mime: "image/jpeg" });
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const isPdf =
    doc.mime_type === "application/pdf" ||
    (doc.file_name?.toLowerCase().endsWith(".pdf") ?? false);
  if (!isPdf) {
    await ctx.reply(
      "⚠️ 目前只接受菜單照片或 PDF 檔。\nOnly menu photos or a PDF file are accepted.",
    );
    return;
  }
  await onNewMedia(ctx, { fileId: doc.file_id, kind: "pdf", mime: "application/pdf" });
});

bot.callbackQuery(DONE_DATA, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const items = store.take(chatId);
  if (!items || items.length === 0) {
    await ctx.reply(
      "還沒收到任何菜單照片或 PDF，請先傳給我。\n" +
        "No menu received yet — send photos or a PDF first.",
    );
    return;
  }
  await processBatch(ctx, items);
});

async function processBatch(ctx: Context, items: PendingItem[]): Promise<void> {
  try {
    const sources: MenuSource[] = await Promise.all(
      items.map(async (it) => ({
        kind: it.kind,
        mime: it.mime,
        bytes: await downloadFile(it.fileId),
      })),
    );

    const total = sources.reduce((n, s) => n + s.bytes.length, 0);
    if (total > MAX_TOTAL_BYTES) {
      await ctx.reply(
        "⚠️ 檔案總量過大，請分批傳較少頁數，或壓縮 PDF。\n" +
          "Files are too large in total — send fewer pages or compress the PDF.",
      );
      return;
    }

    await ctx.reply(
      `🧠 正在辨識與翻譯 ${sources.length} 個檔案… Digitising ${sources.length} file(s)…`,
    );
    const menu = await extractMenu(sources);

    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);
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
  } catch (err) {
    console.error("processBatch failed:", err);
    await ctx.reply(
      "⚠️ 處理失敗 Something went wrong:\n" +
        (err instanceof Error ? err.message : String(err)) +
        "\n請重試或換更清晰的檔案。Please retry with clearer files.",
    );
  }
}

/** Download any Telegram file by file_id and return its bytes. */
async function downloadFile(fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path.");
  const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Idle safety net: free abandoned batches and notify; never auto-process.
setInterval(() => {
  const expired = store.expireStale(Date.now(), IDLE_EXPIRY_MS);
  for (const chatId of expired) {
    void bot.api.sendMessage(chatId, EXPIRY_MSG).catch(() => {});
  }
}, 60_000);
```

- [ ] **Step 3: Update the `/start` and `/help` copy to mention PDF + the Done button**

Replace the existing `bot.command("start", ...)` and `bot.command("help", ...)` blocks with:

```ts
bot.command("start", (ctx) =>
  ctx.reply(
    "👋 歡迎使用 MenuBot！\n\n" +
      "把餐廳菜單拍照（可一次多張／整本）或直接傳 PDF 給我，全部傳完後按【✅ 完成並產生菜單】，我會自動：\n" +
      "1️⃣ 讀取每道餐點\n2️⃣ 翻成英中對照\n3️⃣ 產生手機版菜單網頁，回傳分享連結。\n\n" +
      "Send menu photos (many at once) or a PDF, then tap ✅ Done — I'll turn it into a shareable bilingual web page.",
  ),
);
bot.command("help", (ctx) =>
  ctx.reply(
    "傳菜單照片（可多張）或 PDF，傳完按【✅ 完成並產生菜單】即可。\n" +
      "Send menu photos (one or many) or a PDF, then tap ✅ Done.",
  ),
);
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors. (If grammY reports `ctx.chat` possibly undefined, the `chatId == null` guards already handle it.)

- [ ] **Step 5: Verify tests + build**

Run: `npm test && npm run build`
Expected: tests PASS; `tsc` build emits to `dist/` with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): collecting session + Done button + PDF input + idle safety net"
```

---

### Task 6: Docs touch-up

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README flow + how-it-works to mention PDF and the Done button**

In `README.md`, update the pipeline line and step 1. Change the pipeline diagram line:

```
 photo(s) → Telegram → Claude (read + translate) → HTML → GitHub Pages → link
```

to:

```
 photo(s) / PDF → Telegram → [tap Done] → Claude (read + translate) → HTML → GitHub Pages → link
```

And change step 1 under "How it works":

```
1. You send one or more menu photos to the bot (a whole menu, multiple pages).
```

to:

```
1. You send a whole menu as any number of photos and/or a PDF, then tap the
   **✅ Done** button so the bot knows the upload is complete.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README mentions PDF input and the Done button"
```

---

## Self-Review

**1. Spec coverage:**
- #9 unlimited images, one link → Tasks 4 (BatchStore) + 5 (collecting session, Done trigger, no auto-start). ✓
- #10 PDF input → Tasks 1 (`MenuSource`), 2 (document block), 3 (extract), 5 (document handler + guards). ✓
- Design A (completion-driven batching, button-only, 30-min safety net) → Task 5. ✓
- Design B (PDF native document block, size guard) → Tasks 2, 5 (`MAX_TOTAL_BYTES`). Page-limit handled by surfacing the API error in `processBatch`'s catch (per spec "rely on the API error"). ✓
- Design C (`extractMenu(sources)`, media type from mime, prompt wording) → Tasks 2, 3. ✓
- Design D (bilingual errors, pure testable state machine) → Tasks 4, 5. ✓
- Testing (pure batch machine, block assembly) → Tasks 2, 4. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**3. Type consistency:** `MenuSource {kind,bytes,mime}` (Task 1) used identically in Tasks 2/3/5. `PendingItem {fileId,kind,mime}` (Task 4) used in Task 5. `buildContentBlocks(sources)` defined Task 2, called Task 3. `extractMenu(sources)` defined Task 3, called Task 5. `BatchStore.add/take/expireStale` signatures match between Task 4 definition and Task 5 usage. `DONE_DATA` constant shared between handler registration and keyboard. ✓
