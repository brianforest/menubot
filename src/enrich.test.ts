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

test("a re-slugged explanation is still cached & attached under the requested term", async () => {
  const g = new FakeGlossary();
  const out = await enrichMenu(
    menuWith("char-kway-teow"),
    g,
    async () => [entry("char_kway_teow", "a stir-fried noodle dish")], // model echoes a different slug
    "t",
  );
  assert.equal(out.sections[0].items[0].explain?.en, "a stir-fried noodle dish");
  assert.ok(g.store.has("char-kway-teow"), "stored under the REQUESTED slug for future cache hits");
});

// B4: version-aware cache — a stale-version entry must be re-explained.
class VersionedFakeGlossary implements GlossaryLike {
  rows = new Map<string, { e: GlossaryEntry; v: string }>();
  getMany(terms: string[], version = "") {
    const m = new Map<string, GlossaryEntry>();
    for (const t of terms) { const r = this.rows.get(t); if (r && r.v === version) m.set(t, r.e); }
    return m;
  }
  put(e: GlossaryEntry, _createdAt: string, version = "") { this.rows.set(e.term, { e, v: version }); }
}

test("a cached entry under a stale version is re-explained and re-stored under the new version", async () => {
  const g = new VersionedFakeGlossary();
  g.rows.set("laksa", { e: entry("laksa", "OLD explanation"), v: "v-old" });
  let calls = 0;
  const out = await enrichMenu(
    menuWith("laksa"), g,
    async () => { calls++; return [entry("laksa", "NEW explanation")]; },
    "t", "v-new",
  );
  assert.equal(calls, 1, "stale version forced a re-explain");
  assert.equal(out.sections[0].items[0].explain?.en, "NEW explanation");
  assert.equal(g.rows.get("laksa")?.v, "v-new", "re-stored under the new version");
});

test("a cached entry under the current version is a pure hit (no re-explain)", async () => {
  const g = new VersionedFakeGlossary();
  g.rows.set("laksa", { e: entry("laksa", "fresh"), v: "v-cur" });
  let calls = 0;
  const out = await enrichMenu(
    menuWith("laksa"), g, async () => { calls++; return []; }, "t", "v-cur",
  );
  assert.equal(calls, 0, "current version is a cache hit");
  assert.equal(out.sections[0].items[0].explain?.en, "fresh");
});
