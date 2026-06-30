import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRegional, normalizeMenu } from "./regional.js";
import type { Menu } from "./types.js";

const MAP = new Map<string, string>([
  ["芝士", "起司"],
  ["三文魚", "鮭魚"],
  ["沙律", "沙拉"],
  ["意大利粉", "義大利麵"],
  ["意大利", "義大利"], // shorter; longest-match must apply 意大利粉 first
]);

test("single variant is replaced", () => {
  assert.equal(normalizeRegional("芝士蛋糕", MAP), "起司蛋糕");
});

test("multiple variants in one string are all replaced", () => {
  assert.equal(normalizeRegional("三文魚配沙律", MAP), "鮭魚配沙拉");
});

test("longest match wins (意大利粉 not 意大利+粉)", () => {
  assert.equal(normalizeRegional("意大利粉", MAP), "義大利麵");
});

test("empty map returns the input unchanged", () => {
  assert.equal(normalizeRegional("芝士", new Map()), "芝士");
});

test("false positives: 芝麻 and 沙田 are untouched", () => {
  // 芝麻 (sesame) must not be hit by 芝士→起司; 沙田 (place) not by 沙律→沙拉
  assert.equal(normalizeRegional("芝麻醬", MAP), "芝麻醬");
  assert.equal(normalizeRegional("沙田風味", MAP), "沙田風味");
});

test("normalizeMenu walks zh fields incl. explain.zh, leaves en/prices alone", () => {
  const menu: Menu = {
    tags: [{ id: "x", en: "Cheese", zh: "芝士" }],
    sections: [
      {
        en: "Mains", zh: "沙律主菜",
        items: [
          {
            en: "Salmon", zh: "三文魚", p: "芝士", den: "fresh 芝士", dzh: "新鮮芝士",
            explain: { en: "salmon note", zh: "三文魚很好" },
            options: [
              { en: "Sauce", zh: "醬料", kind: "one",
                choices: [{ en: "Pesto", zh: "芝士醬", p: "" }] },
            ],
          },
        ],
      },
    ],
  };
  normalizeMenu(menu, MAP);
  assert.equal(menu.tags![0].zh, "起司");
  assert.equal(menu.tags![0].en, "Cheese"); // en untouched
  assert.equal(menu.sections[0].zh, "沙拉主菜");
  const it = menu.sections[0].items[0];
  assert.equal(it.zh, "鮭魚");
  assert.equal(it.en, "Salmon"); // en untouched
  assert.equal(it.p, "芝士"); // price string untouched
  assert.equal(it.dzh, "新鮮起司");
  assert.equal(it.explain!.zh, "鮭魚很好");
  assert.equal(it.explain!.en, "salmon note"); // en explain untouched
  assert.equal(it.options![0].zh, "醬料");
  assert.equal(it.options![0].choices[0].zh, "起司醬");
});
