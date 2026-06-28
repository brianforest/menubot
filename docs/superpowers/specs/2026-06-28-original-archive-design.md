# P5 — Original-File Archive + Hidden `/vault` Retrieval (#11)

**Date:** 2026-06-28
**Status:** Approved (design)
**Scope:** MenuBot. Requirement #11 — privately archive each menu's original uploaded
files (photos / PDF) on the VPS, and let the owner pull them back into Telegram later
to compare the source against the published result. Single-user, private; no web
server, DNS, or certificate.

## Purpose (clarified with Brian)

The point is **later verification**: open a saved published menu URL, then retrieve its
original images/PDF to check the digitised result against the source. Only Brian uses
it. So retrieval is a hidden Telegram command keyed by the menu's slug — the originals
come back as Telegram attachments. No public/hidden web address is needed; the saved
**published URL itself is the lookup key**.

## Goals

- On every publish, save the original source files to the VPS under a slug-keyed folder
  (same slug as the published page → one-to-one source↔result mapping).
- A hidden `/vault` command returns a menu's originals to the owner in Telegram, looked
  up by either the full published URL or the bare slug; with no argument it lists recent
  archived slugs.
- The published link is only shown **after it is confirmed live**, so tapping it never
  hits a GitHub-Pages 404 (the archive save happens first, in the same window).
- Private by: the command is **not** advertised (kept out of `setMyCommands`) and the
  existing allow-list middleware already restricts the bot to Brian. Archive files are
  git-ignored (never published).

## Non-goals

- No web serving of originals (no Caddy route, no Tailscale endpoint, no DNS/cert).
- No retroactive archive — only menus published after this ships have originals.
- No auth beyond the existing allow-list (single trusted user; obscurity + allow-list
  suffice).
- No deletion/retention management UI (originals accumulate under `data/`; prune by hand
  if ever needed).

## Design

### A. Archive module (`src/archive.ts` — pure filesystem, DI base dir)

No `config` import; the base directory is a parameter, so it's unit-testable against a
temp dir.

```ts
export interface ArchivedFile { name: string; bytes: Buffer; }

/** Map a source MIME to a file extension for the archived page. */
// jpeg→"jpg", png→"png", webp→"webp", pdf→"pdf", else "bin"

/** Save a menu's original sources under <baseDir>/<slug>/ as page-<i>.<ext>.
 *  Creates the folder; overwrites on a repeat slug. No-op for empty sources. */
export function saveOriginals(
  baseDir: string,
  slug: string,
  sources: { bytes: Buffer; mime: string }[],
): void;

/** Read a slug's archived files, sorted by name; [] if the folder is absent. */
export function readOriginals(baseDir: string, slug: string): ArchivedFile[];

/** List archived slugs, newest first (by folder mtime), capped at `limit`. */
export function listSlugs(baseDir: string, limit: number): string[];

/** Extract a slug from a /vault argument: a published URL (…/m/<slug>/…) or a
 *  bare slug. Returns null if it doesn't look like either. */
export function parseSlug(arg: string): string | null;
```

`parseSlug` rules: match `/m/<slug>/` (slug = `[a-z0-9-]+`, case-insensitive) anywhere in
the argument (handles a full URL with trailing slash or `#anchor`); else, if the trimmed
argument is itself slug-shaped (`^[a-z0-9-]+$`), return it; else `null`.

### A2. Wait-until-live helper (`src/publish.ts`)

Add a poll so the link is only revealed once GitHub Pages serves it (network code,
not unit-tested — same as `publishMenu`/`publishImage`):

```ts
/** Poll a URL with HEAD until it responds <400 or the timeout elapses.
 *  Returns true if it went live. Each probe has its own short timeout; failures
 *  (404, network) are treated as "not live yet" and retried. */
export async function waitUntilLive(
  url: string,
  timeoutMs = 90_000,
  intervalMs = 3_000,
): Promise<boolean>;
```

Loop until `Date.now()` exceeds the deadline: `fetch(url, { method: "HEAD", signal:
AbortSignal.timeout(5_000) })` inside try/catch; return `true` on `res.ok`; otherwise
sleep `intervalMs` and retry. Return `false` on timeout.

### B. Config (`src/config.ts`)

Add an archive directory (default keeps it under the git-ignored `data/`):

```ts
  archive: {
    dir: optional("ARCHIVE_DIR", "data/originals"),
  },
```

### C. Bot wiring (`src/bot.ts`)

**Save, publish, then confirm-live** — replace the current tail of `processBatch`
(`renderMenu` → `publishMenu` → immediate "Done" reply) with: archive the originals
(instant, best-effort), publish, then poll until the page is live before revealing the
link.

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
        `Tap to view & share:\n${url}` +
        (live ? "" : "\n\n（GitHub Pages 首次發佈可能需 1–2 分鐘生效）"),
      { link_preview_options: { is_disabled: false } },
    );
```

Archiving runs regardless of `WEB_ENRICH`. `processBatch` is already dispatched with
`void` (P1), so the ≤90 s poll never blocks the bot's long-poller or other chats. When
the page goes live within the cap, the link is shown clean; on timeout it's shown with
the existing 1–2 min note rather than withheld.

**Hidden `/vault` command** (registered with the other commands, but **omitted from
`setMyCommands`** so it isn't surfaced in the UI; the access-control middleware already
limits use to the allow-list):

```ts
import { InputFile } from "grammy";

bot.command("vault", async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    const slugs = listSlugs(config.archive.dir, 10);
    await ctx.reply(
      slugs.length
        ? "🗄️ 最近封存：\n" + slugs.map((s) => `• ${s}`).join("\n") +
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

Sent as **documents** (not compressed photos) so the originals come back at full fidelity
and PDFs work. `/vault` starts with `/` so it's routed as a command — no collision with
the P4a text-hint handler (which ignores `/`-prefixed text).

### D. Edge cases

- Empty `sources` → `saveOriginals` writes nothing.
- Slug from before this feature → `/vault` replies "not found".
- Unparseable `/vault` argument → friendly error.
- Repeat slug (shouldn't happen — slugs carry a timestamp) → overwrites cleanly.
- Many / large pages → sent sequentially; downloads were already capped at 20 MB each.

### E. Privacy / storage

- `data/` is already git-ignored → originals never reach any repo or Pages.
- Privacy model: allow-list middleware (only Brian) + the command not being advertised.
- Originals accumulate under `data/originals/<slug>/` on the VPS; manual pruning if ever
  needed (out of scope).

## Testing

- **`src/archive.test.ts` (node:test, temp dir via `fs.mkdtempSync`):**
  - `parseSlug` extracts the slug from a full published URL (with trailing slash and with
    `#sec-0` anchor), accepts a bare slug, and rejects non-slug junk.
  - `saveOriginals` + `readOriginals` round-trip: saving two sources (a jpeg + a pdf)
    yields `page-0.jpg` and `page-1.pdf` with the original bytes.
  - `readOriginals` on an absent slug returns `[]`.
  - `listSlugs` returns saved slugs newest-first, capped at `limit`.
  - MIME→ext mapping covers jpeg/png/webp/pdf.
- **`bot.ts` (`/vault` command, `InputFile` sending) and `publish.ts` `waitUntilLive`:**
  not unit-tested (grammy/Telegram, network/timing); covered by `npm run typecheck` + VPS
  acceptance.
- `npm test` stays green (existing 54 + new).

## Rollout

Implement on `feat/original-archive`; subagent-driven (per-task TDD + two-stage review +
opus full-branch final review); typecheck + tests + build green; merge to `main`; deploy
to VPS (`git pull && npm install && npm run build && sudo systemctl restart menubot`).

Acceptance (Brian, live):
1. Publish a new menu → the link appears only after it's live and taps without a 404 →
   then `/vault <that published URL>` returns the original photos/PDF as documents in
   Telegram; compare against the page.
2. `/vault` with no argument lists recent slugs; `/vault <bare-slug>` also works; a bogus
   argument and a pre-feature slug each give a friendly message.
Mark ✅ in memory. With #11 done, the original 11-item expansion is complete (P4 web
enrichment shipped but default-off; everything else live).

---

## Appendix — roadmap position

**P5** (#11) closes the expansion roadmap: P1 input compatibility, P2 tags + glossary, P3
option groups, P4 web enrichment (built, default-off), P5 original archive. Zero new
dependencies; no web-serving infrastructure. Deferred odds-and-ends remain optional:
caption-as-hint, raw-GPS precision, a finder-arg-forwarding test, P2b explain-parse
robustness.
