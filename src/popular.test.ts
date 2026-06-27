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
