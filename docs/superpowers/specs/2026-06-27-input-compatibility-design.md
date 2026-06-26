# P1 — Input Compatibility: Unlimited Images + PDF

**Date:** 2026-06-27
**Status:** Approved (design)
**Scope:** MenuBot ingestion layer. Requirements #9 (unlimited image count) and
#10 (PDF input). No change to extraction logic, data model, or rendering — those
belong to later phases (see Roadmap appendix).

## Problem

1. **#9 — Menus split into multiple links.** A menu sent as many photos
   currently produces several published pages with separate URLs instead of one.
   Telegram caps a media-group (album) at 10 items, so >10 photos arrive as two
   or more groups. The bot flushes a chat's photo buffer after `FLUSH_MS = 2500`
   of quiet; when the network gap between album groups exceeds that, the first
   group is processed before the rest arrive, yielding multiple menus for one
   physical menu.

2. **#10 — PDF menus are not accepted.** Many menus (e.g. in-room dining) are
   PDFs (vector text or scanned images). The bot only handles `message:photo`.

## Goals

- One physical menu → exactly one published page, regardless of photo count.
- Accept PDF menus natively.
- User, not a timer, decides when the batch is complete — robust to flaky uploads.

## Non-goals (deferred to later phases)

- Generalising extraction beyond food menus (#1), filters (#2), recommendations
  (#3/#4), dish images (#5), option groups (#6), explanations (#7/#8), VPS
  archive (#11). This phase only changes *how input arrives*, not what is done
  with it.

## Design

### A. Completion-driven batching (#9)

Replace the fixed 2.5 s quiet-flush with a **user-driven collecting session**.

- On the first media item (photo or PDF document) into an idle chat, open a
  collecting batch for that chat and reply **once** with a message plus an inline
  keyboard button **`✅ 完成並產生菜單`**. Copy (bilingual):
  > 📸 收到。整本菜單可多張照片／PDF 一次傳給我;**全部傳完後請按【✅ 完成並產生菜單】**。
  > Send all pages (photos and/or a PDF); tap **✅ Done** when finished.
- Each subsequent media item appends to the same batch. Do **not** re-send the
  prompt; optionally edit the message to show a running count
  (`已收到 N 張／頁`).
- **The button is the only normal trigger.** On `callback_query` for that
  button, process the whole accumulated batch as one menu and publish one URL.
- **No short auto-start countdown.** A timer cannot distinguish "user finished"
  from "upload stalled on a flaky connection", so auto-processing on a short
  quiet window risks publishing half a menu. Removed entirely.
- **Safety net only:** if a batch sees no activity for `IDLE_EXPIRY_MS`
  (30 minutes), send one reminder — `似乎停了一陣子,傳完請按【✅ 完成並產生菜單】` —
  and expire the batch (free memory). Never auto-process.
- After processing (or expiry), the chat returns to idle; the next media starts a
  fresh batch.

**State machine** (extracted as a pure module for unit testing, no Telegram/IO):

- State per chat: `{ items: MenuSource[], promptMessageId, lastActivityAt }`.
- Transitions: `addItem`, `complete` (→ returns the batch to process + clears),
  `expire` (→ clears). The bot layer wires Telegram updates and timers to these.

### B. PDF path (#10)

- Add a `message:document` handler.
- Accept `mime_type === "application/pdf"` (and a `.pdf` filename fallback).
  Non-PDF documents → friendly rejection (中英) listing accepted types.
- Download the file via the existing Telegram file API and add it to the batch as
  a PDF `MenuSource`.
- Guard rails before extraction:
  - Reject any single PDF `> 32 MB` (Claude request limit) → ask to split/compress.
  - Reject `> 100` pages (200K-context model limit) → ask to split.
  - Page count: read from the PDF header cheaply if practical; otherwise rely on
    the API error and surface it as the same friendly message.
- A batch may mix photos and PDF(s); Claude accepts image and document blocks in
  one message.

### C. `extract.ts` interface generalisation

- Change `extractMenu(images: Buffer[])` →
  `extractMenu(sources: MenuSource[]): Promise<Menu>` where
  `MenuSource = { kind: "image" | "pdf"; bytes: Buffer; mime: string }`.
- Build content blocks from sources:
  - `image` → existing base64 image block (media type from `mime`, not hard-coded
    `image/jpeg`).
  - `pdf` → `{ type: "document", source: { type: "base64",
    media_type: "application/pdf", data } }`, placed before the text block.
- SYSTEM prompt wording: "photos" → "photos and/or a PDF" (and the per-request
  text block adapts to the mix). **No other extraction change.**
- Keep streaming + `max_tokens: 32000` + the `max_tokens` truncation guard.

### D. Edge cases & errors (all bilingual 中英)

- Empty batch on `complete` (button pressed with nothing buffered) → gentle note.
- Telegram download failure → existing retry/clearer-photo message, per item.
- Oversized / too-many-pages PDF → reject before the API call where cheaply
  detectable; otherwise map the API error.
- Unknown document type → reject, list accepted inputs.
- Image media type: pass through Telegram's type; default `image/jpeg`.

## Testing (TDD)

- **Pure batch state machine:** add/complete/expire, multi-group accumulation,
  expiry resets, empty-complete. No network.
- **`extractMenu` block assembly:** given mixed sources, asserts the content block
  array shape (image vs document, media types, ordering) — without hitting the
  API (inject/spy the client or test the block-builder function directly).
- **PDF guard rails:** size/page thresholds produce the rejection path.

## Rollout

Per the incremental-milestone rule: implement on `feat/input-compat`, typecheck +
tests green locally, merge to `main`, deploy to VPS
(`git pull && npm install && npm run build && sudo systemctl restart menubot`),
verify end-to-end (a multi-album photo menu → one link; a PDF menu → one link),
mark ✅ in memory, then start the next phase.

---

## Appendix — full roadmap & decided architecture (for continuity)

Brian approved these decisions on 2026-06-27; later phases inherit them.

**Phase order (input compatibility first, per Brian):**

1. **P1 — Input compatibility** (#9, #10) — *this spec*.
2. **P2 — Generalisation + filters + recommendations + explanations + glossary**
   (#1, #2, #3 house-recommendation, #7, #8).
3. **P3 — Option groups + dish images** (#6, #5).
4. **P4 — Web enrichment** (#4 web-popularity → #3 second emoji, #5 official /
   Google-review images).
5. **P5 — VPS hidden-door archive** (#11).

**Locked architectural decisions:**

- **Dish images (#5):** web-sourced only (official site / Google reviews),
  best-effort, for key items (signature / popular). Do **not** crop from uploaded
  menu photos.
- **Storage:** hybrid — dish images committed to the `menus` repo under
  `docs/m/<slug>/img/` (public, Pages CDN); original uploads archived on the VPS,
  reachable via an obscure hidden URL (private).
- **Glossary (#8):** SQLite on the VPS (e.g. `~/menubot/data/glossary.db`),
  structured for future columns (aliases, categories); cache cuisine explanations
  to cut tokens and latency.
- **Web search (#4):** Claude native `web_search` server tool (works on
  `claude-sonnet-4-6`); one search per menu about the restaurant → tag matched
  dishes as web-popular. No external search API.
- **Model:** keep `claude-sonnet-4-6`.
- **PDF (#10):** Claude native `document` blocks — no poppler / image conversion.

**Data-model additions reserved for later phases** (not in P1):
`Menu.kind` (food / spa / service…), `MenuItem.rec_house`, `MenuItem.rec_web`,
`MenuItem.options` (configurable add-on groups), `MenuItem.explain` (glossary
reference), `MenuItem.img` (dish image URL).
