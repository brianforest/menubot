import { test } from "node:test";
import assert from "node:assert/strict";
import { Glossary } from "./glossary.js";
import { REGIONAL_SEED } from "./regional-seed.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEXICON_SEED } from "./lexicon-seed.js";

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

test("getMany returns a cached entry only when the version matches", () => {
  const g = new Glossary(":memory:");
  g.put(entry("pesto", "basil sauce"), "2026-07-01", "v1");
  assert.equal(g.getMany(["pesto"], "v1").get("pesto")?.explain_en, "basil sauce");
  assert.equal(g.getMany(["pesto"], "v2").has("pesto"), false); // stale version → cache miss
  g.close();
});

test("re-putting a term under a new version overwrites and becomes the live row", () => {
  const g = new Glossary(":memory:");
  g.put(entry("pesto", "old"), "t1", "v1");
  g.put(entry("pesto", "new"), "t2", "v2");
  assert.equal(g.getMany(["pesto"], "v2").get("pesto")?.explain_en, "new");
  assert.equal(g.getMany(["pesto"], "v1").has("pesto"), false); // v1 row is gone (single row per term)
  g.close();
});

test("legacy rows (no version) are stale under any real version", () => {
  const g = new Glossary(":memory:");
  g.put(entry("aioli", "garlic mayo"), "2026-07-01"); // pre-B4 write: version defaults to ""
  assert.equal(g.getMany(["aioli"], "abc123").has("aioli"), false); // miss → will be re-explained
  assert.equal(g.getMany(["aioli"], "").get("aioli")?.explain_en, "garlic mayo"); // legacy-vs-legacy still hits
  g.close();
});

test("migrates a pre-B4 glossary table (no version column) without data loss", () => {
  const dir = mkdtempSync(join(tmpdir(), "menubot-migrate-"));
  const path = join(dir, "migrate-test-" + process.pid + ".db");
  // Build an OLD-schema glossary table (no version column) + a legacy row.
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE glossary (
    term TEXT PRIMARY KEY, display_en TEXT, display_zh TEXT,
    explain_en TEXT, explain_zh TEXT, category TEXT, created_at TEXT
  );`);
  raw.prepare("INSERT INTO glossary (term, explain_en) VALUES (?, ?)").run("ragout", "a slow-cooked stew");
  raw.close();

  // Opening via Glossary must ALTER-add the version column and preserve the row.
  const g = new Glossary(path);
  assert.equal(g.getMany(["ragout"], "").get("ragout")?.explain_en, "a slow-cooked stew"); // legacy row intact under ''
  assert.equal(g.getMany(["ragout"], "v-new").has("ragout"), false); // stale under a real version
  g.close();
  rmSync(dir, { recursive: true, force: true });
});

test("getLexicon returns zh-TW seed entries with variants split into arrays", () => {
  const g = new Glossary(":memory:");
  const entries = g.getLexicon("zh-TW");
  const waffle = entries.find((e) => e.enTerm === "waffle");
  assert.ok(waffle, "waffle entry present");
  assert.equal(waffle!.canonical, "格子鬆餅");
  assert.ok(waffle!.variants.includes("窩夫"));
  const zhtw = LEXICON_SEED.filter((r) => r.locale === "zh-TW");
  assert.equal(entries.length, zhtw.length);
  g.close();
});

test("getLexicon of an unseeded locale returns []", () => {
  const g = new Glossary(":memory:");
  assert.deepEqual(g.getLexicon("zh-HK"), []);
  g.close();
});

test("lexicon seed is idempotent and does not clobber an edited row", () => {
  const g = new Glossary(":memory:");
  g.putLexicon("waffle", "zh-TW", "鬆餅", ["窩夫"]); // hand-edit the canonical
  g.seedLexicon(); // re-run seed; INSERT OR IGNORE must NOT overwrite
  const waffle = g.getLexicon("zh-TW").find((e) => e.enTerm === "waffle");
  assert.equal(waffle!.canonical, "鬆餅");
  g.close();
});
