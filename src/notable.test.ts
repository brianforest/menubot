import { test } from "node:test";
import assert from "node:assert/strict";
import { tagNotable, NOTABLE_TAG } from "./notable.js";
import type { Menu } from "./types.js";

function menuOf(
  items: { en: string; explain?: { en: string; zh: string }; tags?: string[] }[],
): Menu {
  return {
    sections: [
      { en: "S", zh: "區", items: items.map((x) => ({ en: x.en, zh: x.en, explain: x.explain, tags: x.tags })) },
    ],
  };
}

test("tagNotable tags items with an explanation and adds NOTABLE_TAG once", () => {
  const menu = menuOf([
    { en: "A", explain: { en: "x", zh: "x" } },
    { en: "B" },
    { en: "C", explain: { en: "y", zh: "y" } },
  ]);
  tagNotable(menu);
  assert.deepEqual(menu.sections[0].items[0].tags, ["notable"]);
  assert.equal(menu.sections[0].items[1].tags ?? undefined, undefined);
  assert.deepEqual(menu.sections[0].items[2].tags, ["notable"]);
  assert.equal(menu.tags?.filter((t) => t.id === "notable").length, 1);
  assert.equal(menu.tags?.[0].icon, "💡");
  assert.equal(menu.tags?.[0].zh, "特色");
  assert.equal(NOTABLE_TAG.id, "notable");
});

test("tagNotable does nothing when no item has an explanation", () => {
  const menu = menuOf([{ en: "A" }, { en: "B" }]);
  tagNotable(menu);
  assert.equal(menu.tags?.some((t) => t.id === "notable") ?? false, false);
  assert.equal(menu.sections[0].items[0].tags ?? undefined, undefined);
});

test("tagNotable strips a stray pre-existing notable before applying", () => {
  const menu = menuOf([{ en: "A", explain: { en: "x", zh: "x" } }, { en: "B", tags: ["notable"] }]);
  menu.tags = [{ id: "notable", en: "x", zh: "x", icon: "💡" }];
  tagNotable(menu);
  assert.deepEqual(menu.sections[0].items[0].tags, ["notable"]); // A genuinely has explain
  assert.equal(menu.sections[0].items[1].tags?.includes("notable"), false); // B stray removed
  assert.equal(menu.tags?.filter((t) => t.id === "notable").length, 1);
});

test("tagNotable does not duplicate notable and preserves other tags", () => {
  const menu = menuOf([{ en: "A", explain: { en: "x", zh: "x" }, tags: ["vegetarian"] }]);
  tagNotable(menu);
  assert.deepEqual(menu.sections[0].items[0].tags, ["vegetarian", "notable"]);
});

test("tagNotable ignores an empty explanation object", () => {
  const menu = menuOf([{ en: "A", explain: { en: "", zh: "" } }]);
  tagNotable(menu);
  assert.equal(menu.tags?.some((t) => t.id === "notable") ?? false, false);
});
