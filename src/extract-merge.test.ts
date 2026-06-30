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

test("removes exact-duplicate items repeated within the same section", () => {
  const results: SectionsResult[] = [
    {
      sections: [
        {
          en: "Scotch",
          zh: "蘇格蘭",
          items: [
            { en: "Glenfiddich 12", zh: "格蘭菲迪 12", p: "18" },
            { en: " glenfiddich 12 ", zh: "格蘭菲迪 12", p: "18" }, // same item (case/space)
            { en: "Glenfiddich 18", zh: "格蘭菲迪 18", p: "28" }, // distinct
          ],
        },
      ],
    },
  ];
  const menu = mergeExtract({ ...outline, tags: [] }, results);
  assert.deepEqual(
    menu.sections[0].items.map((i) => i.en),
    ["Glenfiddich 12", "Glenfiddich 18"], // first kept, dup dropped, distinct kept
  );
});

test("keeps same-named items that differ in price (not a duplicate)", () => {
  const results: SectionsResult[] = [
    {
      sections: [
        {
          en: "Wine",
          zh: "酒",
          items: [
            { en: "House Red", zh: "招牌紅酒", p: "12" }, // by glass
            { en: "House Red", zh: "招牌紅酒", p: "55" }, // by bottle
          ],
        },
      ],
    },
  ];
  const menu = mergeExtract({ ...outline, tags: [] }, results);
  assert.equal(menu.sections[0].items.length, 2); // different prices → both kept
});

test("does not dedupe the same item name across different sections", () => {
  const results: SectionsResult[] = [
    { sections: [{ en: "Cocktails", zh: "調酒", items: [{ en: "Negroni", zh: "尼格羅尼", p: "20" }] }] },
    { sections: [{ en: "Happy Hour", zh: "歡樂時光", items: [{ en: "Negroni", zh: "尼格羅尼", p: "14" }] }] },
  ];
  const menu = mergeExtract({ ...outline, tags: [] }, results);
  assert.equal(menu.sections[0].items.length, 1);
  assert.equal(menu.sections[1].items.length, 1); // cross-section repeat preserved
});
