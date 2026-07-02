import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMenu } from "./render.js";

test("renderMenu embeds the tag vocabulary and item tags, replaces the placeholder", () => {
  const html = renderMenu({
    restaurant: { en: "X", zh: "X" },
    tags: [{ id: "vegetarian", en: "Vegetarian", zh: "素", icon: "🌱" }],
    sections: [
      { en: "S", zh: "區", items: [{ en: "A", zh: "甲", tags: ["vegetarian"] }] },
    ],
  });
  assert.ok(html.includes('"id":"vegetarian"'), "tag vocabulary embedded");
  assert.ok(html.includes('"tags":["vegetarian"]'), "item tags embedded");
  assert.ok(!html.includes("{{TAGS_JSON}}"), "placeholder replaced");
});

test("renderMenu defaults tags to [] when the menu has none", () => {
  const html = renderMenu({ sections: [{ en: "S", zh: "區", items: [] }] });
  assert.ok(html.includes("const TAGS = [];"), "empty tags default embedded");
  assert.ok(!html.includes("{{TAGS_JSON}}"));
});

test("renderMenu now keeps the 'popular' tag so 🔥 renders (P4a)", () => {
  const html = renderMenu({
    tags: [
      { id: "popular", en: "Popular", zh: "人氣", icon: "🔥", group: "highlight" },
      { id: "vegetarian", en: "Vegetarian", zh: "素", icon: "🌱" },
    ],
    sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲", tags: ["popular"] }] }],
  });
  assert.ok(html.includes('"id":"popular"'), "popular tag kept in vocabulary");
  assert.ok(html.includes('"tags":["popular"]'), "item popular tag embedded");
});

test("renderMenu embeds an item's explanation when present", () => {
  const html = renderMenu({
    sections: [{ en: "S", zh: "區", items: [
      { en: "Flat White", zh: "馥芮白", explain: { en: "Espresso with steamed milk.", zh: "濃縮咖啡加蒸奶。" } },
    ] }],
  });
  assert.ok(html.includes("Espresso with steamed milk."), "explanation EN embedded");
  assert.ok(html.includes("濃縮咖啡加蒸奶。"), "explanation ZH embedded");
});

test("renderMenu embeds an item's option groups and choices", () => {
  const html = renderMenu({
    sections: [{ en: "S", zh: "區", items: [
      { en: "Noodle Soup", zh: "湯麵", options: [
        { en: "Broth", zh: "湯底可選", kind: "one", choices: [
          { en: "Clear broth", zh: "清湯" },
          { en: "Nyonya Curry Broth", zh: "娘惹咖哩湯" },
        ] },
      ] },
    ] }],
  });
  assert.ok(html.includes("湯底可選"), "group label embedded");
  assert.ok(html.includes("Nyonya Curry Broth"), "choice embedded");
});

test("renderMenu embeds a dish image path and the template renders it", () => {
  const html = renderMenu({
    sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲", img: "img/dish-0.jpg" }] }],
  });
  assert.ok(html.includes('"img":"img/dish-0.jpg"'), "img path serialized into MENU_JSON");
  assert.ok(html.includes('class="dish"'), "template emits the dish <img> element");
});

test("renderMenu surfaces the notable tag and the template excludes it from item icons", () => {
  const html = renderMenu({
    tags: [{ id: "notable", en: "Notable", zh: "特色", icon: "💡", group: "highlight" }],
    sections: [{ en: "S", zh: "區", items: [
      { en: "A", zh: "甲", tags: ["notable"], explain: { en: "x", zh: "y" } },
    ] }],
  });
  assert.ok(html.includes('"id":"notable"'), "notable tag is in the chip vocabulary");
  assert.ok(html.includes('"tags":["notable"]'), "item keeps notable in data for filtering");
  assert.ok(html.includes('t !== "notable"'), "template excludes notable from the item icon row");
});

test("renderMenu injects the NAV tree and the currency prefix", () => {
  const html = renderMenu({
    currency: "MYR",
    sections: [
      { en: "Scotch", zh: "蘇", l1: { en: "Alcohol", zh: "酒類" }, tier: "alcohol", l2: { en: "Whiskey", zh: "威士忌" },
        items: [{ en: "Chivas", zh: "起瓦士", p: "37" }] },
    ],
  } as any);
  assert.match(html, /const NAV = \[/);      // nav tree injected
  assert.match(html, /"威士忌"/);              // the L2 label is present in NAV
  assert.match(html, /const CUR = "RM"/);     // MYR -> RM prefix injected
});
