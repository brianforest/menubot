import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByCategory } from "./category-nav.js";
import type { MenuSection } from "./types.js";

const sec = (over: Partial<MenuSection>): MenuSection => ({ en: "", zh: "", id: "x", items: [], ...over });

const AL = { en: "Alcohol", zh: "酒類" };
const WHK = { en: "Whiskey", zh: "威士忌" };

test("orders L1 by fixed tier (savory<dessert<drink<alcohol<other), groups L2, counts items", () => {
  const sections: MenuSection[] = [
    sec({ en: "Scotch", zh: "蘇", id: "s0", l1: AL, tier: "alcohol", l2: WHK, items: [{ en: "a", zh: "" }, { en: "b", zh: "" }] }),
    sec({ en: "Bourbon", zh: "波", id: "s1", l1: AL, tier: "alcohol", l2: WHK, items: [{ en: "c", zh: "" }] }),
    sec({ en: "Cake", zh: "蛋糕", id: "s2", l1: { en: "Desserts", zh: "點心" }, tier: "dessert", l2: { en: "Cake", zh: "蛋糕" }, items: [{ en: "d", zh: "" }] }),
    sec({ en: "Pasta", zh: "麵", id: "s3", l1: { en: "Mains", zh: "餐點" }, tier: "savory", l2: { en: "Pasta", zh: "麵" }, items: [{ en: "e", zh: "" }] }),
  ];
  const nav = groupByCategory(sections);
  // tier order: savory(餐點) < dessert(點心) < alcohol(酒類)
  assert.deepEqual(nav.map((n) => n.l1.zh), ["餐點", "點心", "酒類"]);
  const al = nav.find((n) => n.l1.zh === "酒類")!;
  // the 2 whiskey sections consolidate into ONE l2 node, count = 2+1 = 3
  assert.equal(al.l2s.length, 1);
  assert.deepEqual(al.l2s[0].l2, WHK);
  assert.equal(al.l2s[0].count, 3);
  // anchors point at the first section of the group
  assert.equal(al.l2s[0].anchor, "s0");
  assert.equal(al.anchor, "s0");
});

test("sections without classification fall into an 'Other' L1 (last), each its own L2", () => {
  const sections: MenuSection[] = [
    sec({ en: "Mystery", zh: "神秘", id: "m0", items: [{ en: "x", zh: "" }] }),
    sec({ en: "Wine", zh: "酒", id: "w0", l1: AL, tier: "alcohol", l2: { en: "Wine", zh: "葡萄酒" }, items: [{ en: "y", zh: "" }] }),
  ];
  const nav = groupByCategory(sections);
  assert.equal(nav[nav.length - 1].tier, "other");
  assert.equal(nav[nav.length - 1].l2s[0].anchor, "m0");
});

test("empty-but-present l1/l2 objects are treated as absent (fall into 其他), not a blank node", () => {
  const sections: MenuSection[] = [
    sec({ en: "Ghost", zh: "幽靈", id: "g0", l1: { en: "", zh: "" }, tier: "savory", l2: { en: "", zh: "" }, items: [{ en: "x", zh: "" }] }),
  ];
  const nav = groupByCategory(sections);
  assert.equal(nav.length, 1);
  assert.deepEqual(nav[0].l1, { en: "Other", zh: "其他" });
  assert.equal(nav[0].tier, "other");
  assert.equal(nav[0].l2s[0].anchor, "g0");
});
