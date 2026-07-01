# Adaptive Extract (complexity-gated single/parallel) — Design Spec

> Phase B latency slice. Author: Claude (dir. Brian). 2026-07-01.

## Goal

Cut the dominant latency (extract ~206s, output-bound) on the menus where it is
safe to, **without ever risking price fidelity**. Route each menu automatically:
structurally-simple menus take the ~2× faster parallel path; structurally-complex
menus (detached/offset price columns, nested spirits tables) take the proven-correct
single-call path. Replaces the manual `EXTRACT_MODE` switch with an automatic gate.

## Background / why this is safe now

Parallel extract (two-stage: outline → per-group workers → merge) was built and
shelved to opt-in (`EXTRACT_MODE`, default `single`) because on **tricky layouts** —
a floating `RM (GLASS)` price column offset from item rows, nested COGNAC/ARMAGNAC
sub-blocks — a focused worker misaligns prices (Gordon's dropped a price, others
shifted, a phantom item appeared). On simple linear-list sections parallel matched
single exactly. So the failure is confined to a detectable layout class.

## Spike result (feasibility gate — PASSED)

A Pass-1 outline call augmented with a `complex` boolean was run on two
ground-truth menus, 3 rounds each:

| Menu | Ground truth (by eye) | Detector verdict (3/3) |
|---|---|---|
| Terrace (floating spirits price column, nested sub-blocks) | complex | **true ×3** |
| Planters (single-page linear list, no price column) | complex=false | **false ×3** |

Detection was reliable, deterministic across runs, and the model's stated reasons
named the exact trigger. Because the gate is **binary at the whole-menu level**,
a complex menu never enters the parallel path — so we do **not** need to prove
"routing tricky sections fixes misalignment"; complex menus use the known-good
single call. This sidesteps the non-determinism that shelved parallel.

## Architecture

Whole-menu binary gate, folded into the existing two-stage machinery. No new
API call beyond the outline that the parallel path already makes.

```
extractMenu(sources, mode)
  mode = "adaptive":
    outline = outlineMenu(sources)          // Pass 1, now also returns `complex`
    if outline.complex === true → single(sources)   // safe path, outline discarded
    else → parallel-from-outline(outline, sources)  // reuse outline, run workers
    (any outline failure → single, as today)
  mode = "single" | "parallel": unchanged (manual override retained)
```

### Components / interfaces

- **`extract-outline.ts`** — `OUTLINE_SYSTEM` gains one instruction to emit a
  top-level `complex: boolean` (+ `complex_reason: string`, advisory/logging only).
  `Outline` interface (`extract-merge.ts`) gains `complex?: boolean`.
  `parseOutline` reads it; missing/non-boolean → treat as `true` (fail safe →
  single). "When in doubt, prefer true" is in the prompt.

- **`extract.ts`** — refactor so the parallel path can consume a *pre-computed*
  outline (today `extractMenuParallel` calls `outlineMenu` itself). Add:
  - `extractMenuAdaptive(sources, deps)`: calls `outlineMenu` once, branches on
    `complex`. Complex → `single(sources)`. Simple → the existing partition →
    workers → merge, using the already-fetched outline (no second outline call).
  - `dispatchExtract` gains `mode: "adaptive"` → `extractMenuAdaptive`.
  - `config.extract.mode` accepts `"adaptive"`.
  - Completeness guard (merged section count === outline spine) stays; on
    mismatch, adaptive falls back to single (same as parallel today).

- **`config.ts`** — `EXTRACT_MODE` validation allows `single | parallel | adaptive`.

### Data flow

1. `outlineMenu` → `{restaurant, currency, tags, sections[], complex}`.
2. `complex` → dispatch decision.
3a. Complex → `extractMenuSingle(sources)` (outline is thrown away — a one-outline
    tax on complex menus, cheap: ≤4k output).
3b. Simple → `partitionSections` → parallel `extractSections` workers → `mergeExtract`.

### Error handling / fallback (unchanged safety posture)

- Outline throws / hung / empty → single (today's behavior).
- `complex` missing or not a boolean → single (fail safe).
- Parallel completeness guard trips → single.
- Streaming calls already have the hard deadline (`finalMessageWithDeadline`).

### Cost / latency

- Simple menu: outline + parallel workers = the parallel path (~2× on extract).
- Complex menu: outline (cheap) + single = single + one small outline tax.
- No extra billed call on the hot path beyond what parallel already did; outline
  is the same call, just one more field.

## Rollout

- New value `EXTRACT_MODE=adaptive`. **Production stays `single` until Brian
  accepts.** After merge + deploy, flip prod to `adaptive` and verify on a
  known-simple and a known-complex menu.
- `single` and `parallel` remain as manual overrides / escape hatches.

## Testing

- `extract.test.ts`: inject fakes for `outline`/`single`/`parallel`.
  - complex outline → single called, parallel not called.
  - simple outline → parallel path called with the pre-fetched outline (outline
    fetched exactly once — no double outline call).
  - outline throws → single (existing).
  - `complex` absent → treated as complex → single (fail safe).
  - parallel completeness mismatch under adaptive → single fallback.
- `extract-outline` parse: `complex` surfaced; missing → undefined (dispatcher
  coerces to safe).
- No live-LLM unit tests (prompt behavior validated by the spike + acceptance).

## Out of scope (later slices)

- Per-section mixed execution (route only the tricky *sections* to a holistic
  read). Deferred — binary gate is the low-risk first cut.
- Model selection (Sonnet 5 etc.) — separate decision; note Sonnet 5's new
  tokenizer (~30% more output tokens) would worsen the extract bottleneck, so it
  is not bundled here.

## Verification

`npm run typecheck` + `npm test` green; prod acceptance on one simple + one
complex menu (item/section/xterm counts + prices correct; simple menu faster).
