import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeExtract, type Outline, type SectionsResult } from "./extract-merge.js";

const outline: Outline = {
  restaurant: { en: "Terrace", zh: "露台" },
  currency: "SGD",
  kind: "food",
  tags: [
    { id: "signature", en: "Signature", zh: "招牌", icon: "⭐", group: "highlight" },
    { id: "vegetarian", en: "Vegetarian", zh: "素", icon: "🌱", group: "diet" },
    { id: "unused", en: "Unused", zh: "沒用到", group: "other" },
  ],
  sections: [{ en: "Starters", zh: "前菜" }, { en: "Pasta", zh: "義麵" }],
};

test("concatenates sections in result order and carries global fields", () => {
  const results: SectionsResult[] = [
    { sections: [{ en: "Starters", zh: "前菜", items: [{ en: "Bruschetta", zh: "烤麵包", tags: ["vegetarian"] }] }] },
    { sections: [{ en: "Pasta", zh: "義麵", items: [{ en: "Pesto", zh: "青醬", tags: ["signature"] }] }] },
  ];
  const menu = mergeExtract(outline, results);
  assert.equal(menu.restaurant?.en, "Terrace");
  assert.equal(menu.currency, "SGD");
  assert.equal(menu.kind, "food");
  assert.deepEqual(menu.sections.map((s) => s.en), ["Starters", "Pasta"]);
});

test("prunes tags no item references", () => {
  const results: SectionsResult[] = [
    { sections: [{ en: "Pasta", zh: "義麵", items: [{ en: "Pesto", zh: "青醬", tags: ["signature"] }] }] },
  ];
  const menu = mergeExtract(outline, results);
  const ids = (menu.tags ?? []).map((t) => t.id);
  assert.deepEqual(ids, ["signature"]); // vegetarian + unused pruned (no item uses them)
});

test("unions worker-minted tags by id, first definition wins", () => {
  const results: SectionsResult[] = [
    {
      sections: [{ en: "Pasta", zh: "義麵", items: [{ en: "Clams", zh: "蛤蜊", tags: ["contains-shellfish"] }] }],
      tags: [{ id: "contains-shellfish", en: "Shellfish", zh: "含貝類", icon: "🦪", group: "allergen" }],
    },
    {
      sections: [{ en: "Starters", zh: "前菜", items: [{ en: "Oyster", zh: "生蠔", tags: ["contains-shellfish"] }] }],
      tags: [{ id: "contains-shellfish", en: "DIFFERENT", zh: "不同", group: "other" }],
    },
  ];
  const menu = mergeExtract(outline, results);
  const tag = (menu.tags ?? []).find((t) => t.id === "contains-shellfish");
  assert.equal(tag?.en, "Shellfish"); // first definition kept
});

test("handles items without tags and empty sections", () => {
  const results: SectionsResult[] = [
    { sections: [{ en: "Plain", zh: "普通", items: [{ en: "Water", zh: "水" }] }] },
    { sections: [{ en: "Empty", zh: "空", items: [] }] },
  ];
  const menu = mergeExtract({ ...outline, tags: [] }, results);
  assert.equal(menu.sections.length, 2);
  assert.deepEqual(menu.tags, []); // no tags referenced
});
