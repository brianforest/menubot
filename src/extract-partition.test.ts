import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionSections } from "./extract-partition.js";

const titles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ en: `S${i}`, zh: `區${i}` }));

test("returns one group when titles fit under perWorker", () => {
  const g = partitionSections(titles(5), { perWorker: 8, maxWorkers: 6 });
  assert.equal(g.length, 1);
  assert.equal(g[0].startIndex, 0);
  assert.equal(g[0].titles.length, 5);
});

test("splits into ceil(n/perWorker) contiguous groups, capped at maxWorkers", () => {
  const g = partitionSections(titles(39), { perWorker: 8, maxWorkers: 6 });
  assert.equal(g.length, 5); // ceil(39/8) = 5, under the cap
  // contiguous, every title once, in order
  assert.deepEqual(
    g.flatMap((x) => x.titles.map((t) => t.en)),
    titles(39).map((t) => t.en),
  );
  assert.deepEqual(g.map((x) => x.startIndex), [0, 8, 16, 24, 32]);
});

test("respects maxWorkers by enlarging groups", () => {
  const g = partitionSections(titles(100), { perWorker: 8, maxWorkers: 6 });
  assert.equal(g.length, 6); // capped; ceil(100/6)=17 per group
  assert.equal(g.flatMap((x) => x.titles).length, 100);
  assert.equal(g[0].startIndex, 0);
});

test("empty input yields no groups", () => {
  assert.deepEqual(partitionSections([]), []);
});

test("uses defaults when opts omitted", () => {
  const g = partitionSections(titles(8));
  assert.equal(g.length, 1); // 8/8
});
