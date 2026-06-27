import { test } from "node:test";
import assert from "node:assert/strict";
import { Glossary } from "./glossary.js";

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
