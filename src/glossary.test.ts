import { test } from "node:test";
import assert from "node:assert/strict";
import { Glossary } from "./glossary.js";
import { REGIONAL_SEED } from "./regional-seed.js";

const entry = (term: string, ex = "x") => ({
  term, display_en: term, display_zh: term,
  explain_en: ex, explain_zh: ex, category: "dish",
});

test("put then getMany returns the stored entry, keyed by requested term", () => {
  const g = new Glossary(":memory:");
  g.put(entry("flat-white", "a small espresso drink"), "2026-06-27");
  const got = g.getMany(["flat-white", "unknown"]);
  assert.equal(got.size, 1);
  assert.equal(got.get("flat-white")?.explain_en, "a small espresso drink");
  assert.equal(got.get("unknown"), undefined);
  g.close();
});

test("getMany on empty input returns an empty map", () => {
  const g = new Glossary(":memory:");
  assert.equal(g.getMany([]).size, 0);
  g.close();
});

test("put upserts (second put overwrites)", () => {
  const g = new Glossary(":memory:");
  g.put(entry("laksa", "old"), "2026-06-27");
  g.put(entry("laksa", "new"), "2026-06-27");
  assert.equal(g.getMany(["laksa"]).get("laksa")?.explain_en, "new");
  g.close();
});

test("alias routes alias->canonical on lookup", () => {
  const g = new Glossary(":memory:");
  g.put(entry("flat-white", "the canonical one"), "2026-06-27");
  g.putAlias("flatwhite", "flat-white");
  const got = g.getMany(["flatwhite"]);
  assert.equal(got.get("flatwhite")?.explain_en, "the canonical one");
  g.close();
});

test("getRegionalMap returns the seeded variant→canonical pairs", () => {
  const g = new Glossary(":memory:");
  const map = g.getRegionalMap();
  assert.equal(map.get("芝士"), "起司");
  assert.equal(map.get("三文魚"), "鮭魚");
  assert.equal(map.size, REGIONAL_SEED.length);
  g.close();
});

test("seed load is idempotent and does not clobber an edited row", () => {
  const g = new Glossary(":memory:");
  // simulate a hand-edited row, then re-run the seed by constructing again on
  // the same db is not possible with :memory:, so assert INSERT OR IGNORE keeps
  // an existing row: insert a conflicting variant, then reload seed.
  g.putRegional("芝士", "乳酪"); // override
  g.seedRegional(); // re-run seed; INSERT OR IGNORE must NOT overwrite
  assert.equal(g.getRegionalMap().get("芝士"), "乳酪");
  g.close();
});
