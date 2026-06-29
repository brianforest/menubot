# Pipeline Timing Instrumentation — Design

> 2026-06-30. Goal: measure where the ~7-minute per-menu latency actually goes,
> before optimising. Pre-requisite for the latency-improvement work tracked in
> `memory/feedback_latency.md`. Strategy A (measure-first) chosen by Brian.

## Problem

A single foreign menu takes ~7 minutes end-to-end. `feedback_latency.md` lists
three suspects — `extractMenu` (one big vision call), `enrichMenu/explainTerms`
(one big explain call), `waitUntilLive` (polls up to 90s) — but we have **no
measurements**. Optimising blind risks cutting the wrong stage. Measure first,
then cut the proven bottleneck (one hypothesis at a time).

## Scope

Add per-stage timing to `processBatch`. No change to recognition / translation /
explanation logic. The Terrace re-test (Phase A verification) doubles as the
measurement run.

## Design

### 1. `src/timing.ts` — pure, testable

```ts
class Timer {
  constructor(now?: () => number)            // injectable clock for tests
  time<T>(label: string, fn: () => Promise<T>): Promise<T>  // wrap+record an await
  add(label: string, ms: number): void       // record a pre-measured span
  format(): string                            // "extract 210.3s · enrich 95.1s · …"
  total(): number                             // sum of recorded spans (ms)
  get spans(): ReadonlyArray<{ label: string; ms: number }>
}
```

`time()` records the span in a `finally`, so a throwing stage is still timed
before the error propagates.

### 2. `processBatch` (bot.ts)

Wrap the five heavy awaits with `timer.time(label, …)`:
`download` · `extract` · `enrich` · `publish` · `waitLive`.
The instant stages (tagNotable / render / archive) are left unwrapped.

### 3. Output — two paths

- **Always**: one structured `console.log("[timing] …")` line including counts
  (`files / sections / items / xterms`) so the numbers are interpretable in
  `journalctl`.
- **`DEBUG_TIMING=on` only**: also send a compact `⏱️ …` Telegram message so a
  live test shows the breakdown without SSH. New config flag, **default off** —
  production UX unchanged.

### 4. Config

`config.debug.timing = optional("DEBUG_TIMING", "off") === "on"`.

### 5. Tests — `src/timing.test.ts`

Inject a fake clock; assert span order, `format()`, and `total()`.

## Risk

Very low. Wrapping only; no behavioural change to existing stages; debug output
default-off; zero new dependencies.

## Rollout

1. Merge + deploy to VPS.
2. Set `DEBUG_TIMING=on` in VPS `.env`, restart.
3. Brian runs the Terrace menu once → read the ⏱️ breakdown (also verifies
   Phase A 💡 guide) → pick the real bottleneck for the next change.
