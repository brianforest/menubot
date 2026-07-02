# Single-Extract max_tokens Raise (+ Sonnet 5 eval) — Design Spec

> Fixes large-menu truncation on the correctness-preserving single-extract path,
> without reintroducing the parallel price-misalignment bug. Author: Claude
> (dir. Brian). 2026-07-02.

## Problem

A large **complex** menu (in-room dining PDF: 53 sections / 204 items) fails
extraction with `menu太大、辨識結果被截斷 (model output hit max_tokens)`. Root
cause confirmed from the VPS stack trace: `EXTRACT_MODE=adaptive` routed the menu
to `extractMenuSingle` (because the outline flagged `complex`), and single's
`max_tokens: 32000` cannot hold 204 items with today's richer per-item schema
(tags / xterm / options / etc. accreted since 2026-06-27, when the same menu last
succeeded).

**Why single, not parallel, for complex menus.** The Terrace menu regressed under
the parallel path — per-section workers misaligned an offset/floating price column
and inflated item counts (phantom items). Brian reverted to single, whose
whole-menu context resolves price alignment holistically. Project rule: **a wrong
rewrite that misleads a diner is worse than an honest failure.** Therefore a
complex/uncertain menu must stay on single for correctness; the fix is to give
single enough output budget, not to switch it to parallel.

## Decisions (settled)

- **A (this change): raise `extractMenuSingle` `max_tokens` 32000 → 64000.** Both
  the current model (`claude-sonnet-4-6`) and `claude-sonnet-5` support up to
  **128K** output tokens (verified via the claude-api skill's model table,
  cached 2026-06-24), so 32000 was far below the ceiling. 64000 holds ~330 items
  (2× the current worst case of 204). `SINGLE_OPTS.timeout` is 600s; a 64K stream
  is ~110s (the truncated run produced ~32K tokens in ~56s ≈ 570 tok/s), well
  within budget. Streaming is already used, so no HTTP-timeout issue.
- **Routing unchanged.** `complex !== false` → single (now with headroom);
  `complex === false` → parallel (fast, safe for simple layouts). The
  "simple menus go parallel to save time" principle stands.
- **Outline (4000) and parallel workers (32000 each) unchanged** — outline is
  tiny; each parallel worker handles only its section slice.
- **Menus larger than 64000 tokens → keep the existing honest truncation error**
  ("請分批傳較少的頁數"). Never fall back to parallel to force completion.

## Explicitly rejected (Terrace lesson)

- Forcing large menus to parallel regardless of `complex`.
- A reactive "single hit max_tokens → retry parallel" fallback.
- A section-count threshold to route large menus to parallel.

All three would send a complex menu through per-section workers and reintroduce
price misalignment / phantom items — worse than an honest truncation. The data
confirms the hazard: Brian's real menus include several at 39–40 sections that
currently succeed on single; a threshold would divert them to parallel.

## Change

`src/extract.ts` `extractMenuSingle`:
- `max_tokens: 32000` → `max_tokens: 64000`.
- Update the stale comment (references "8k tokens truncated") to state the
  current reasoning: single carries the whole menu for correct price alignment;
  64000 gives headroom for large complex menus; the model ceiling is 128K; menus
  beyond 64000 surface the honest truncation error.

No new deps, no config, no routing change.

## Testing

The change is a single constant. A unit test asserting the constant would be a
tautology (a reviewer would flag "asserts nothing"), and `extractMenuSingle`
holds the Anthropic client at module scope (not injected), so asserting the
outbound `max_tokens` would require mocking the SDK — disproportionate. Gate on:
`npm run typecheck && npm test` (full regression, no behavior change to existing
paths) + `npm run build`. **Real verification is production**: re-run the
in-room dining PDF through the bot → it extracts to completion (no
`max_tokens` error, a `[timing]` line with the full section/item counts).

## Deployment

`ssh mybani-prod → git pull && npm install && npm run build && sudo systemctl
restart menubot`. No env change.

## B — Sonnet 5 evaluation (separate track, non-blocking)

Verified deltas (claude-api skill table, cached 2026-06-24): `claude-sonnet-5`
is 1M context / 128K output, priced $3/$15 per MTok with an intro $2/$10 through
2026-08-31 (currently cheaper than 4.6), positioned near-Opus on coding/agentic.
Caveat: a new tokenizer (~30% more tokens for the same text) and breaking changes
(adaptive thinking on by default, sampling params rejected) mean a migration
needs care.

**Open question:** could Sonnet 5 be smart enough that the parallel path is also
fully correct? Honest assessment: uncertain — the misalignment is partly a
context-splitting problem, not purely intelligence, so a smarter model may
improve but not guarantee correctness. Do not bet correctness on it.

**Spike (per rule #8, worst-case inputs — not happy path):** run the Terrace
(39-section) and in-room dining (53-section) menus through `claude-sonnet-5` in
both single and parallel modes; measure phantom items / price misalignment vs
the current `claude-sonnet-4-6` baseline. Deliverable: a comparison → Brian
decides whether to upgrade the model and whether parallel becomes safe on 5.0.
Requires the two worst-case menu files. Does not block A.

## Out of scope

- Migrating the production model to Sonnet 5 (gated on the B spike result).
- Any change to the adaptive complexity gate.
