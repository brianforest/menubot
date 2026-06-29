# Two-Stage Parallel Extract — Design

> 2026-06-30. Cut the extract bottleneck (206s, 81% of a 253s run; output-bound,
> ~15k-token JSON for 155 items) **without losing any fidelity** vs the current
> single full-context call. Brian's hard constraint: the result must match a
> single-call "sees the whole book" extraction.

## Why two-stage (not blind batching)

Blind page-batching gives each worker only a few pages, so a section spanning a
page boundary is invisible to the worker that owns the rest — unrecoverable by
any code-side merge. Two-stage keeps **every worker's input = the whole menu**,
and parallelises only the expensive part (generating the big JSON). Same
information per item as the single call → no quality loss; output is split across
workers → wall-clock drops.

## Pipeline

### Pass 1 — outline (`extract-outline.ts`)
One streamed call, all images. Returns global metadata + the section spine only
(no items):
```
{ restaurant:{en,zh}, currency, kind,
  tags:[ {id,en,zh,icon,group} ],          // full classification vocabulary
  sections:[ {en, zh} ] }                    // ordered, titles only
```
Small output (~hundreds of tokens) → fast (~5–10s).

### Partition (`extract-partition.ts`, pure)
Split the ordered section list into G contiguous groups, each labelled with its
section index range. `G = clamp(ceil(nSections / SECTIONS_PER_WORKER), 1, MAX_WORKERS)`
(initial: `SECTIONS_PER_WORKER = 8`, `MAX_WORKERS = 6`). Contiguous so output
order is trivially preserved.

### Pass 2 — section workers (`extract-sections.ts`)
G parallel streamed calls. Each worker receives **all images** + the Pass-1 tag
vocabulary + the exact titles of its assigned sections, and is told: "extract
full items for ONLY these sections; reference the given tag ids, mint a new one
(same rules) only if a label is genuinely absent." Reuses the full item/tag/
xterm/options rules from the current extract SYSTEM prompt (factored into a
shared constant so Pass 1 and Pass 2 don't drift).

### Merge (`extract-merge.ts`, pure)
Deterministic — no title-matching heuristics:
- `restaurant / currency / kind`: from Pass 1.
- `tags`: union by `id`, starting from Pass-1 vocab, appending any worker-minted
  ids not already present (first definition wins).
- `sections`: concatenate worker outputs in partition order (groups are
  contiguous and ordered, so this reproduces the Pass-1 reading order).

## Dispatch, fallback, rollout

- `extractMenu(sources)` dispatches on `config.extract.mode` (`EXTRACT_MODE`,
  default `single`). The current single-call body is kept as `extractMenuSingle`
  — it is both a mode and the **fallback**.
- **Fallback to single** on: Pass-1 failure, or any Pass-2 worker failing after
  one retry, or an empty outline. Guarantees we never publish a degraded menu;
  worst case is current latency.
- Rollout (incremental-ship): ship behind the flag default `single` → set
  `EXTRACT_MODE=parallel` on VPS → Brian runs Terrace → **A/B verify** against
  the known-good single-call output (counts from the `[timing]` line:
  sections/items/xterms; spot-check content) → flip default to `parallel` once
  proven. Fallback path stays.

## Cost / latency trade-off (honest)

- Input tokens multiply (~16k images × G workers + Pass 1) → modestly more $.
  Brian's concern here is latency, not this cost; image tokens are cheap.
- Adds Pass-1 (~10s) but parallelises the ~206s output.
- Estimate: 206s → Pass1 ~10s + Pass2 (parallel) ~50–70s ≈ **70–90s** (2.5–3×),
  fidelity preserved.

## Modules & isolation

| File | Responsibility | Tested by |
|---|---|---|
| `extract-partition.ts` | pure: sections → contiguous groups | unit (TDD) |
| `extract-merge.ts` | pure: Pass1 + worker outputs → Menu | unit (TDD) |
| `extract-outline.ts` | Pass-1 LLM call + parse | parse unit; manual A/B |
| `extract-sections.ts` | Pass-2 worker LLM call + parse | parse unit; manual A/B |
| `extract.ts` | shared prompt constant + dispatcher + fallback | dispatcher unit (fake fns) |

Pure pieces (partition, merge) carry the correctness load and are fully unit
tested. LLM wrappers stay thin (like the existing `explain.ts`).

## Out of scope (separate, optional, zero-risk add-ons)
- Omit-empty-fields output compaction (shrinks even single-call ~10%).
- `waitUntilLive` non-blocking (saves ~24s).
Tracked in `feedback_latency.md`; not part of this spec.

## Risks
- **Unbalanced partition**: Pass 1 doesn't know item counts, so one section with
  most items keeps one worker busy. Acceptable for typical menus (~4 items/
  section); revisit with item-count hints if a real menu is badly skewed.
- **Worker drift on tag ids**: mitigated by passing the Pass-1 vocab and union-
  by-id merge; well-known + slug ids are largely deterministic anyway.
