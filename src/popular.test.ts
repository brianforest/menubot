import { test } from "node:test";
import assert from "node:assert/strict";
import { googlePlaceName, resolveIdentity } from "./popular.js";
import type { Menu } from "./types.js";

test("googlePlaceName extracts and decodes the place name", () => {
  assert.equal(
    googlePlaceName("see https://www.google.com/maps/place/Din+Tai+Fung+Xinyi/@25.0,121.5,17z"),
    "Din Tai Fung Xinyi",
  );
});

test("googlePlaceName returns null when there is no place URL", () => {
  assert.equal(googlePlaceName("just some text"), null);
  assert.equal(googlePlaceName(""), null);
  assert.equal(googlePlaceName("https://maps.app.goo.gl/abc123"), null); // short link has no name
});

test("resolveIdentity prefers a Google place name; free text becomes location", () => {
  const menu: Menu = { restaurant: { en: "Whatever" }, sections: [] };
  const r = resolveIdentity(menu, "near me https://www.google.com/maps/place/Tian+Tian+Chicken+Rice/@1.2,103.8");
  assert.equal(r.restaurant, "Tian Tian Chicken Rice");
  assert.equal(r.location, "near me");
});

test("resolveIdentity falls back to the menu restaurant; hint text becomes location", () => {
  const menu: Menu = { restaurant: { en: "Din Tai Fung", zh: "鼎泰豐" }, sections: [] };
  assert.deepEqual(resolveIdentity(menu, "信義店 台北"), { restaurant: "Din Tai Fung", location: "信義店 台北" });
});

test("resolveIdentity uses free-text hint as the restaurant when the menu has no name", () => {
  const menu: Menu = { sections: [] };
  assert.deepEqual(resolveIdentity(menu, "鼎泰豐 信義店"), { restaurant: "鼎泰豐 信義店", location: "" });
});

test("resolveIdentity yields an empty restaurant when nothing is known", () => {
  const menu: Menu = { sections: [] };
  assert.deepEqual(resolveIdentity(menu, ""), { restaurant: "", location: "" });
});

import { tagPopular } from "./popular.js";

function menuOf(names: string[], restaurant = "Din Tai Fung"): Menu {
  return {
    restaurant: { en: restaurant },
    sections: [
      { en: "S", zh: "區", items: names.map((n) => ({ en: n, zh: n })) },
    ],
  };
}
const idxFinder = (idx: number[]) => async () => idx;

test("tagPopular flags returned items and adds the POPULAR_TAG once", async () => {
  const menu = menuOf(["A", "B", "C"]);
  await tagPopular(menu, idxFinder([0, 2]));
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
  assert.equal(menu.sections[0].items[1].tags ?? undefined, undefined);
  assert.deepEqual(menu.sections[0].items[2].tags, ["popular"]);
  assert.equal(menu.tags?.filter((t) => t.id === "popular").length, 1);
  assert.equal(menu.tags?.[0].icon, "🔥");
});

test("tagPopular strips a stray pre-existing popular tag before applying", async () => {
  const menu = menuOf(["A", "B"]);
  menu.tags = [{ id: "popular", en: "x", zh: "x", icon: "🔥" }];
  menu.sections[0].items[1].tags = ["popular"]; // stray on B
  await tagPopular(menu, idxFinder([0])); // only A is really popular
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
  assert.equal(menu.sections[0].items[1].tags?.includes("popular"), false);
  assert.equal(menu.tags?.filter((t) => t.id === "popular").length, 1);
});

test("tagPopular does not call the finder when there is no restaurant or hint", async () => {
  const menu: Menu = { sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲" }] }] };
  let called = false;
  await tagPopular(menu, async () => { called = true; return [0]; });
  assert.equal(called, false);
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
});

test("tagPopular uses a hint to identify the restaurant when the menu has no name", async () => {
  const menu: Menu = { sections: [{ en: "S", zh: "區", items: [{ en: "A", zh: "甲" }] }] };
  let seen = "";
  await tagPopular(menu, async (r) => { seen = r; return [0]; }, "鼎泰豐");
  assert.equal(seen, "鼎泰豐");
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
});

test("tagPopular ignores out-of-range, negative and duplicate indices", async () => {
  const menu = menuOf(["A", "B"]);
  await tagPopular(menu, idxFinder([0, 0, -1, 5]));
  assert.deepEqual(menu.sections[0].items[0].tags, ["popular"]);
  assert.equal(menu.sections[0].items[1].tags ?? undefined, undefined);
});

test("tagPopular adds no tag when the finder returns nothing", async () => {
  const menu = menuOf(["A", "B"]);
  await tagPopular(menu, idxFinder([]));
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
  assert.equal(menu.sections[0].items[0].tags ?? undefined, undefined);
});

test("tagPopular flags none when the finder over-flags (guard)", async () => {
  const menu = menuOf(["A", "B", "C", "D", "E", "F", "G", "H"]); // cap = max(6, 3) = 6
  await tagPopular(menu, idxFinder([0, 1, 2, 3, 4, 5, 6])); // 7 > 6 → none
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
});

test("tagPopular publishes unchanged when the finder throws", async () => {
  const menu = menuOf(["A"]);
  await tagPopular(menu, async () => { throw new Error("boom"); });
  assert.equal(menu.tags?.some((t) => t.id === "popular") ?? false, false);
  assert.equal(menu.sections[0].items[0].tags ?? undefined, undefined);
});
