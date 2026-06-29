import { test } from "node:test";
import assert from "node:assert/strict";
import { Timer } from "./timing.js";

/** A fake clock that advances by a fixed step on every read. */
function fakeClock(steps: number[]): () => number {
  let i = 0;
  return () => steps[Math.min(i++, steps.length - 1)];
}

test("time() records a span's duration from the injected clock", async () => {
  // reads: start=100, end=350 → 250ms
  const t = new Timer(fakeClock([100, 350]));
  const out = await t.time("extract", async () => "menu");
  assert.equal(out, "menu"); // passes the awaited value through
  assert.deepEqual([...t.spans], [{ label: "extract", ms: 250 }]);
});

test("spans are recorded in call order", async () => {
  const t = new Timer(fakeClock([0, 10, 10, 40, 40, 41]));
  await t.time("download", async () => {});
  await t.time("extract", async () => {});
  await t.time("publish", async () => {});
  assert.deepEqual(
    [...t.spans].map((s) => s.label),
    ["download", "extract", "publish"],
  );
  assert.deepEqual([...t.spans].map((s) => s.ms), [10, 30, 1]);
});

test("time() records the span even when the wrapped fn throws", async () => {
  const t = new Timer(fakeClock([100, 500]));
  await assert.rejects(
    t.time("extract", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual([...t.spans], [{ label: "extract", ms: 400 }]);
});

test("total() sums all recorded spans", async () => {
  const t = new Timer(fakeClock([0, 200, 200, 500]));
  await t.time("a", async () => {});
  await t.time("b", async () => {});
  assert.equal(t.total(), 500);
});

test("add() records a pre-measured span", () => {
  const t = new Timer(fakeClock([0]));
  t.add("waitLive", 18000);
  assert.deepEqual([...t.spans], [{ label: "waitLive", ms: 18000 }]);
});

test("format() renders labels with seconds to one decimal", async () => {
  const t = new Timer(fakeClock([0, 210300, 210300, 305400]));
  await t.time("extract", async () => {});
  await t.time("enrich", async () => {});
  assert.equal(t.format(), "extract 210.3s · enrich 95.1s");
});
