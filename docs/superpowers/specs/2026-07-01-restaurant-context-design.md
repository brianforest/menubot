# Restaurant Context + Complexity Time-Warning — Design Spec

> Phase B "input↔benefit fairness" slice. Author: Claude (dir. Brian). 2026-07-01.

## Goal

Make the optional info we ask users for actually improve results, and set honest
expectations about wait time. Two problems this fixes:

1. **The hint is currently dead.** The restaurant name / location / map link a user
   sends (`hint`) is only consumed by web enrichment (`tagPopular`, `addImages`),
   which is default-OFF (`WEB_ENRICH`). In the default pipeline the hint never
   reaches `extractMenu` — yet the collect message promises "辨識會更準". False promise.
2. **No wait-time signal.** A structurally-complex menu is (with adaptive extract)
   routed to the slower single call for price fidelity; the user isn't told it will
   take longer.

## Scope

- **In:** feed a restaurant/region **context** into extraction from (a) typed text and
  (b) a Google Maps link resolved cheaply via HTTP redirect; a **time-warning** message
  when adaptive routes a complex menu to single; rewrite the collect prompt to ask for a
  map link (primary) or at least a name (fallback).
- **Out (deferred):** map **screenshot** as a context image (needs a menu-page-vs-context
  image classifier — separate slice). **Computer Use / browser automation** on the Mac
  Mini (over-engineered: an HTTP redirect gives name+address deterministically for near
  zero cost — see Feasibility). GPS/EXIF coordinates (Telegram strips EXIF; unreliable).

## Feasibility (established)

Resolving the short link `https://maps.app.goo.gl/xpeE1jFBPpZmgf2p7` with a plain
redirect-following HTTP request (no browser, no LLM) yields:
`https://maps.google.com/maps?q=The+Terrace+at+The+Danna,+Kampung+Kok,+07000+Langkawi,+Kedah,+&ftid=…`
→ decoded `q` = "The Terrace at The Danna, Kampung Kok, 07000 Langkawi, Kedah" — name +
full address + region, deterministically, in a fraction of a second. This is the entire
value Computer Use would fetch, at a tiny fraction of the cost/fragility.

## Architecture

Three independent components, threaded through the existing extract entry points.

### Component 1 — Map link resolution (`src/maps-link.ts`, new)

- `resolveMapContext(text: string, deps?): Promise<string | null>`
  - Finds the first URL in `text` whose host is on a **Google Maps allow-list**
    (`maps.app.goo.gl`, `goo.gl`, `google.com`/`www.google.com` with a `/maps` path,
    `maps.google.com`, `g.co`). Anything else → `null`. **Security: never fetch an
    arbitrary user-supplied URL** (SSRF guard) — only these hosts.
  - Follows redirects (injected `fetch`; default the global) with a `HEAD`-style request
    (we need only the final URL, not the body) to the effective URL, reads the `q=` query
    param, URL-decodes it (`+`→space, `%XX`), returns the trimmed string.
  - **Best-effort, never blocks the pipeline** (mandate #6): a per-call timeout via
    `AbortSignal.timeout` (e.g. 8 s), `maxRetries` none; any throw/non-2xx/missing `q` → `null`.
  - Pure/deterministic given injected `fetch` — unit-tested with a fake.

### Component 2 — Context assembly (`src/context.ts`, new)

- `buildContext(hint: string | undefined, deps?): Promise<string | null>`
  - No hint → `null`.
  - Resolves any map link in the hint (Component 1). Combines the non-URL text and the
    resolved place string into one context line. Link result preferred/merged (richer +
    deterministic). All-empty → `null`.

### Component 3 — Feed context into extraction

- `buildContentBlocks(sources, context?)` (modify `src/blocks.ts`): when `context` is a
  non-empty string, append one line to the instruction text block:
  `\n\nRestaurant context (may help disambiguate dish names, cuisine, region, and currency): <context>`
  No change when `context` is absent (byte-identical instruction).
- Thread `context?: string` through the three leaf extractors so every mode benefits:
  - `extractMenuSingle(sources, context?)`
  - `outlineMenu(sources, context?)`
  - `extractSections(sources, tags, titles, context?)`
  - and the intermediaries that call them: `extractFromOutline(outline, sources, deps?, context?)`,
    `extractMenuParallel(sources, deps?, context?)`, `extractMenuAdaptive(sources, deps?, opts?)`,
    `dispatchExtract(sources, mode, deps?, opts?)`, `extractMenu(sources, opts?)`.

### Component 4 — Adaptive routing callback + time-warning

- `extractMenu(sources, opts?)` where `opts = { context?: string; onRoute?: (route: "single" | "parallel", complex: boolean | undefined) => void }`.
- `extractMenuAdaptive` calls `opts.onRoute?.(route, outline.complex)` at the decision
  point (once, before the long call). `single`/`parallel` modes make no routing decision,
  so `onRoute` only fires in adaptive mode.
- `bot.ts` passes an `onRoute` that, when `route === "single"` **and** `complex === true`
  (a complexity-triggered single), sends a Telegram message:
  「此菜單版面較複雜（密集價格表），為確保價格正確改用完整辨識，約需 3–4 分鐘，請稍候。」
  (single ≈ 253 s.) It does not fire for `parallel` or for a non-complex single.

### Component 5 — Collect prompt rewrite (`bot.ts` `COLLECT_MSG`)

- Explicitly ask for a Google Maps link first, restaurant name as the fallback; drop the
  now-accurate-again "更準" claim into a concrete ask. Full-width punctuation in the 中文.

## Data flow

Files + hint arrive → `bot.ts`:
1. `const context = await buildContext(hint)` (resolves link; best-effort, may be `null`).
2. `extractMenu(sources, { context, onRoute })` → mode dispatch → each mode calls
   `buildContentBlocks(sources, context)`; adaptive fires `onRoute` at its decision.
3. On a complexity-triggered single, `onRoute` sends the wait-time message before the call.
4. Enrich / regional-normalize / render unchanged.

## Error handling

- Link resolve failure/timeout → `null` context → extraction proceeds exactly as today.
- `buildContext` never throws into `processBatch` (wrap/catch → `null`); a context failure
  must never block or fail a menu.
- `onRoute` is best-effort UI; a send failure is caught and ignored (never blocks extract).

## Testing

- `maps-link.test.ts`: fake `fetch` returning a redirected `q=`-bearing URL → parses
  name+address; no-URL text → `null`; fetch throws / non-2xx / missing `q` → `null`;
  URL-decoding (`+` and `%XX`).
- `context.test.ts`: text-only, link-only, text+link merged, neither → `null`.
- `blocks.test.ts` (or extend): `buildContentBlocks` appends the context line when present,
  identical output when absent.
- `extract.test.ts` (extend): `context` reaches `buildContentBlocks` on the single path
  (spy/fake); `onRoute("single", true)` fires on complex, `onRoute("parallel", false)` on
  simple, and is not required by non-adaptive modes.
- No live-LLM tests.

## Rollout

- Context feed and the collect-message rewrite are always-on (no billing risk: link
  resolve is one cheap HTTP GET, best-effort). The time-warning only fires in
  `EXTRACT_MODE=adaptive`, which is still gated behind Brian's acceptance flip.

## Verification

`npm run typecheck` + `npm test` green; prod acceptance: send a menu with a map link →
confirm the resolved restaurant/region appears to help (e.g. correct currency/region
wording), and (in adaptive) a complex menu shows the wait-time message.
