# P4b — Dish Images (#5)

**Date:** 2026-06-28
**Status:** Approved (design)
**Scope:** MenuBot enrichment + rendering. Requirement #5 — for a menu's key items
(signature ⭐ / popular 🔥), best-effort fetch a real photo of the dish from the web,
verify it with a vision check, commit it to the published menu repo, and render it as
a thumbnail. Builds on P4a (which supplies the 🔥 tag and the optional user hint).

## Background — spike findings that shape this

The 2026-06-27 feasibility spike (Din Tai Fung, real `web_search`/`web_fetch`) established:
- `web_fetch` returns **text documents, not image bytes**, and only fetches URLs already
  in the conversation. So the model **finds** an image URL; **our Node code downloads**
  the bytes.
- Download mechanics work (a valid 1.8 MB PNG came back from the official CDN), **but the
  `og:image` was a branded banner** ("鼎泰豐 DIN TAI FUNG" over a steamer), not a clean
  dish photo — and the model rated it "high" confidence. **A vision verification gate is
  mandatory** to reject banners/logos/wrong dishes; yield is inherently low → best-effort.

So #5 is its own phase (P4b), separate from #4 (P4a, shipped).

## Goals

- For up to **5** items tagged `signature` or `popular`, obtain a real dish photo:
  model finds a candidate image URL → our code downloads the bytes (image type, ≤ 2 MB)
  → a vision check confirms it's a clean photo of that dish → commit it to the menu repo
  → render it as a thumbnail under the item.
- Degrade gracefully at every step: any failure for an item simply means no image for
  that item; the menu always publishes.

## Non-goals (deferred / out of scope)

- Images for non-key items, or any item beyond the cap of 5.
- Image resizing/recompression (no `sharp` or other native dep) — commit as-is, with a
  size cap. Real optimization is a later concern.
- Raw-GPS precision, caption-as-hint capture (P4a follow-ups), #11 (P5).
- No direct scraping of Google/Yelp; the model's `web_search`/`web_fetch` is the channel.

## Design

### A. Data model (`src/types.ts`)

Add one field to `MenuItem`:

```ts
  /** Relative path to a committed dish photo, e.g. "img/dish-3.jpg"; absent if none. */
  img?: string;
```

(No other type changes.)

### B. Image enrichment orchestrator (`src/images.ts` — pure, DI, config-free)

Mirrors `popular.ts`/`enrich.ts`: no Anthropic import, fully unit-testable with injected
dependencies.

```ts
export interface ImageDeps {
  /** Candidate direct image URLs for this dish (best first); [] if none. */
  findImage: (restaurant: string, en: string, zh: string) => Promise<string[]>;
  /** Download + validate a URL → bytes + file extension; null on any failure/oversize/non-image. */
  download: (url: string) => Promise<{ bytes: Buffer; ext: string } | null>;
  /** Vision gate: is this a clean real photo of the dish (not logo/banner/collage/wrong)?
   *  `ext` ("jpg"|"png"|"webp") lets the implementation set the image media type. */
  verify: (bytes: Buffer, ext: string, en: string, zh: string) => Promise<boolean>;
  /** Commit bytes to the menu repo under this slug's img/ folder. Throws on failure. */
  commit: (slug: string, fileName: string, bytes: Buffer) => Promise<void>;
}

export async function addImages(
  menu: Menu,
  hint: string | undefined,
  slug: string,
  deps: ImageDeps,
  maxItems?: number, // default 5
): Promise<Menu>;
```

Algorithm:
1. Resolve the restaurant via `resolveIdentity(menu, hint)` (imported from `./popular.js`).
   If no restaurant → return menu (no work; can't search meaningfully).
2. Collect **target items**: flatten items in menu order, keep those whose `tags` include
   `"signature"` or `"popular"`; stop at `maxItems` (default 5). Remember each target's
   flat index `i` (used for the filename).
3. For each target item, in a per-item `try/catch` (failure → skip, leave `img` unset):
   - `urls = await deps.findImage(restaurant, it.en, it.zh)`.
   - For each url in order until one succeeds:
     - `d = await deps.download(url)`; if `null`, continue.
     - if `!(await deps.verify(d.bytes, d.ext, it.en, it.zh))`, continue.
     - `fileName = \`dish-${i}.${d.ext}\``; `await deps.commit(slug, fileName, d.bytes)`.
     - `it.img = \`img/${fileName}\``; break (one image per item).
4. Return the (mutated) menu.

`it.img` is set **only after a successful commit**, so a menu never references an image
that isn't in the repo.

### C. Web image dependencies (`src/web-image.ts` — real deps; imports config + SDK)

Not unit-tested (real API/network). Three exports wired into `ImageDeps`:

- **`findImage(restaurant, en, zh)`** — one `client.messages.create` with
  `web_search_20260209` (`max_uses: 4`) + `web_fetch_20260209` (`max_uses: 3`),
  `model: config.anthropic.model`, modest `max_tokens`. SYSTEM: find a direct image URL
  (`.jpg/.jpeg/.png/.webp` or an `og:image`) that actually shows THIS dish at THIS
  restaurant — prefer the official site or a reputable source; avoid stock/unrelated
  images. Return ONLY JSON `{ "image_urls": [up to 3, best first] }`. Handle
  `stop_reason === "pause_turn"` (re-send, cap 6). Parse first JSON object; `[]` on any failure.
- **`downloadImage(url)`** — `fetch` with redirect follow and a browser UA; reject unless
  `res.ok` and `content-type` starts with `image/`; read bytes; reject if
  `> 2 * 1024 * 1024` bytes or `< 3000` bytes (banner/error pages); derive `ext` from the
  content-type (`png`/`webp`/`jpg`). Return `{ bytes, ext }` or `null` (catches all errors).
- **`verifyImage(bytes, ext, en, zh)`** — one vision `client.messages.create`: an `image`
  content block (base64, `media_type` mapped from `ext`: jpg→`image/jpeg`, png→`image/png`,
  webp→`image/webp`) + a prompt asking
  whether this is a clean, real photograph of the dish "<en> / <zh>" — the food itself —
  and NOT a logo, branded banner, text/menu screenshot, collage/grid, or a different dish.
  Return ONLY JSON `{ "ok": true|false }`. Parse; return `false` on any failure (fail closed).

### D. Publish image (`src/publish.ts`)

Add:

```ts
export async function publishImage(slug: string, fileName: string, bytes: Buffer): Promise<void>;
```

PUTs `{ message, content: bytes.toString("base64"), branch }` to
`/repos/{owner}/{repo}/contents/{pagesDir}/m/{slug}/img/{fileName}` via the existing `gh()`
helper. Throws on non-OK (so the orchestrator's per-item catch skips that item). Paths are
always new (slug carries a timestamp) → create, no SHA needed.

### E. Bot wiring (`src/bot.ts`)

In `processBatch`, after the `tagPopular` block:
- Compute the `slug` **before** image enrichment (move the existing `slugify(name)` up so
  images and the page share one slug).
- Reply once: `🖼️ 正在找菜品圖… Finding dish photos…`.
- ```ts
  try {
    await addImages(menu, hint, slug, {
      findImage, download: downloadImage, verify: verifyImage, commit: publishImage,
    });
  } catch (e) {
    console.error("dish images failed (publishing without photos):", e);
  }
  ```
- Then `renderMenu(menu)` (items may now carry `img`) and `publishMenu(slug, html)` as today.

Images are committed to `…/m/<slug>/img/…` before the page's `index.html`, so they exist
when the page loads.

### F. Rendering (`src/render.ts` + `templates/menu.html`)

- `render.ts`: no change — `img` rides inside the serialized `sections`.
- Template: when an item has `img`, render a thumbnail in the item card:
  `<img class="dish" src="<escaped img>" loading="lazy" alt="">`. CSS: `.dish { width: 100%;
  max-height: 200px; object-fit: cover; border-radius: 10px; margin-top: 8px; }`. Placed
  **after the `meta` div** (so name/price/tags/💡 read first, then the photo), still inside
  the item card. Escape the `src`.

### G. Edge cases

- No restaurant identity (no hint, no menu name) → no images; deps untouched.
- Item has no candidate URL / all downloads fail / all fail verification → no `img`, continue.
- `commit` throws (GitHub error) → caught per item, `img` left unset (never references a
  missing file).
- Fewer than 5 targets → process all of them; zero targets → no work.
- An item already has `img` (shouldn't, fresh extract) → it's a target only via tags; we
  overwrite at most once on success.

## Testing

- **`src/images.test.ts` (node:test, injected fake `ImageDeps`):**
  - selects only `signature`/`popular` items; caps at 5 (6 targets → 5 processed).
  - non-target items never get `img`.
  - first verified+committed URL wins: sets `it.img = "img/dish-<i>.<ext>"` with the flat index.
  - tries URLs in order: skips a URL whose `download` returns null, and one whose `verify`
    is false, moving to the next.
  - `commit` throws → that item's `img` stays unset; other items still processed.
  - no restaurant (no hint, no menu name) → `findImage` not called; no `img` anywhere.
  - `commit` receives the right `(slug, fileName, bytes)`.
- **`src/render.test.ts`:** an item with `img` serializes into the page and the template
  emits an `<img` for it (assert the `img` path appears in the rendered HTML).
- **`web-image.ts` / `publishImage`:** not unit-tested (real API/network); covered by VPS
  acceptance + typecheck.
- `npm test` stays green (existing 45 + new).

## Rollout

Implement on `feat/dish-images`; subagent-driven (per-task TDD + two-stage review + opus
full-branch final review); typecheck + tests + build green; merge to `main`; deploy to VPS
(`git pull && npm install && npm run build && sudo systemctl restart menubot`).

Acceptance (Brian, live):
1. Upload a well-known restaurant's menu (optionally with a name/location/Google hint) →
   one or more signature/popular items show a real dish thumbnail; images load on mobile;
   no banner/logo/wrong-dish images slipped through the vision gate.
2. A menu where photos can't be found → publishes normally, no images, no errors in
   `journalctl -u menubot`.
Mark ✅ in memory. P4 (#4 + #5) then complete; remaining roadmap: raw-GPS precision &
caption-hint (P4 follow-ups), P5 hidden-door archive (#11).

---

## Appendix — roadmap position

**P4b** (#5 dish images) completes P4's web enrichment (P4a #4 popularity shipped
2026-06-28). Locked decisions carried forward: web-sourced images, best-effort, key items
only, vision-gated; commit to `menus` repo `docs/m/<slug>/img/`; no native deps; keep
`claude-sonnet-4-6`; native web tools (no scraping). Follow-ups: raw-GPS precision
(image-as-document + reverse-geocode), caption-as-hint, a finder-argument-forwarding test.
Then **P5** VPS hidden-door archive (#11).
