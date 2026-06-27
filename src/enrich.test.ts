import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichMenu, type GlossaryLike } from "./enrich.js";
import type { GlossaryEntry, Menu } from "./types.js";

class FakeGlossary implements GlossaryLike {
  store = new Map<string, GlossaryEntry>();
  getMany(terms: string[]) {
    const m = new Map<string, GlossaryEntry>();
    for (const t of terms) { const e = this.store.get(t); if (e) m.set(t, e); }
    return m;
  }
  put(e: GlossaryEntry) { this.store.set(e.term, e); }
}

const entry = (term: string, ex: string): GlossaryEntry => ({
  term, display_en: term, display_zh: term,
  explain_en: ex, explain_zh: ex + "(zh)", category: "dish",
});

const menuWith = (xterm?: string): Menu => ({
  sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲", xterm }] }],
});

test("cached term attaches explain WITHOUT calling explainFn", async () => {
  const g = new FakeGlossary();
  g.store.set("laksa", entry("laksa", "a spicy noodle soup"));
  let calls = 0;
  const out = await enrichMenu(menuWith("laksa"), g, async () => { calls++; return []; }, "t");
  assert.equal(calls, 0);
  assert.deepEqual(out.sections[0].items[0].explain, { en: "a spicy noodle soup", zh: "a spicy noodle soup(zh)" });
});

test("cache miss calls explainFn once, stores, and attaches", async () => {
  const g = new FakeGlossary();
  let calls = 0;
  const out = await enrichMenu(menuWith("confit"), g, async (reqs) => {
    calls++;
    assert.equal(reqs[0].term, "confit");
    return [entry("confit", "slow-cooked in fat")];
  }, "t");
  assert.equal(calls, 1);
  assert.equal(out.sections[0].items[0].explain?.en, "slow-cooked in fat");
  assert.ok(g.store.has("confit"), "stored for next time");
});

test("no xterms → explainFn not called, no explain attached", async () => {
  const g = new FakeGlossary();
  let calls = 0;
  const out = await enrichMenu(menuWith(undefined), g, async () => { calls++; return []; }, "t");
  assert.equal(calls, 0);
  assert.equal(out.sections[0].items[0].explain, undefined);
});

test("second enrich of the same term is a pure cache hit", async () => {
  const g = new FakeGlossary();
  let calls = 0;
  const explain: any = async () => { calls++; return [entry("confit", "x")]; };
  await enrichMenu(menuWith("confit"), g, explain, "t");
  await enrichMenu(menuWith("confit"), g, explain, "t");
  assert.equal(calls, 1, "explained once, then cached");
});
