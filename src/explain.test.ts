import { test } from "node:test";
import assert from "node:assert/strict";
import { explainTerms } from "./explain.js";
import type { ExplainRequest, GlossaryEntry } from "./types.js";

const reqs = (n: number): ExplainRequest[] =>
  Array.from({ length: n }, (_, i) => ({
    term: `t${i}`,
    sample_en: `E${i}`,
    sample_zh: `中${i}`,
  }));

const entry = (term: string): GlossaryEntry => ({
  term,
  display_en: term,
  display_zh: term,
  explain_en: "e",
  explain_zh: "中",
  category: "dish",
});

test("returns [] for empty input without calling the batch fn", async () => {
  let called = 0;
  const out = await explainTerms(
    [],
    async (b) => {
      called++;
      return b.map((r) => entry(r.term));
    },
    20,
  );
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test("single batch when reqs fit batchSize", async () => {
  const sizes: number[] = [];
  const out = await explainTerms(
    reqs(20),
    async (b) => {
      sizes.push(b.length);
      return b.map((r) => entry(r.term));
    },
    20,
  );
  assert.deepEqual(sizes, [20]); // exactly one call
  assert.equal(out.length, 20);
});

test("splits into parallel batches and flattens in input order", async () => {
  const sizes: number[] = [];
  const out = await explainTerms(
    reqs(45),
    async (b) => {
      sizes.push(b.length);
      return b.map((r) => entry(r.term));
    },
    20,
  );
  assert.deepEqual(
    [...sizes].sort((a, b) => b - a),
    [20, 20, 5],
  ); // 3 batches
  assert.equal(out.length, 45);
  assert.deepEqual(
    out.map((e) => e.term),
    reqs(45).map((r) => r.term),
  ); // order preserved across batches
});

test("a failing batch is skipped; other batches still return (partial salvage)", async () => {
  const out = await explainTerms(
    reqs(45),
    async (b) => {
      if (b.some((r) => r.term === "t0")) throw new Error("batch boom"); // first batch fails
      return b.map((r) => entry(r.term));
    },
    20,
  );
  assert.equal(out.length, 25); // 45 - failed first batch (20) = 25
  assert.equal(
    out.some((e) => e.term === "t0"),
    false,
  );
  assert.equal(
    out.some((e) => e.term === "t20"),
    true,
  );
});
