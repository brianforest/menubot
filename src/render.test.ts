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
