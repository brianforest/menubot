import { test } from "node:test";
import assert from "node:assert/strict";
import { addImages, type ImageDeps } from "./images.js";
import type { Menu } from "./types.js";

function menuWith(items: { en: string; tags: string[] }[]): Menu {
  return {
    sections: [
      { en: "S", zh: "區", items: items.map((x) => ({ en: x.en, zh: x.en, tags: x.tags })) },
    ],
  };
}

function fakeDeps(over: Partial<ImageDeps> = {}): ImageDeps & { commits: { slug: string; fileName: string }[] } {
  const commits: { slug: string; fileName: string }[] = [];
  return {
    findImage: async () => ["u1"],
    download: async () => ({ bytes: Buffer.from("x".repeat(10)), ext: "jpg" }),
    verify: async () => true,
    commit: async (slug, fileName) => { commits.push({ slug, fileName }); },
    commits,
    ...over,
  };
}

test("addImages targets only signature/popular items, capped at 5", async () => {
  const menu = menuWith([
    { en: "A", tags: ["signature"] }, { en: "B", tags: [] }, { en: "C", tags: ["popular"] },
    { en: "D", tags: ["signature"] }, { en: "E", tags: ["popular"] }, { en: "F", tags: ["signature"] },
    { en: "G", tags: ["popular"] },
  ]);
  const seen: string[] = [];
  const deps = fakeDeps({ findImage: async (_r, en) => { seen.push(en); return ["u"]; } });
  await addImages(menu, "Rest", "slug-1", deps);
  assert.deepEqual(seen, ["A", "C", "D", "E", "F"]); // B skipped (untagged), capped at 5 (G excluded)
});

test("addImages sets img = img/dish-<flatIndex>.<ext> after a successful commit", async () => {
  const menu = menuWith([{ en: "A", tags: [] }, { en: "B", tags: ["signature"] }]);
  const deps = fakeDeps();
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[1].img, "img/dish-1.jpg");
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
  assert.deepEqual(deps.commits, [{ slug: "s", fileName: "dish-1.jpg" }]);
});

test("addImages skips a URL whose download returns null, then succeeds", async () => {
  const menu = menuWith([{ en: "A", tags: ["popular"] }]);
  let dl = 0;
  const deps = fakeDeps({
    findImage: async () => ["u1", "u2"],
    download: async () => (++dl === 1 ? null : { bytes: Buffer.from("x".repeat(10)), ext: "webp" }),
  });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img, "img/dish-0.webp");
  assert.equal(dl, 2);
});

test("addImages skips a URL that fails verification, then succeeds", async () => {
  const menu = menuWith([{ en: "A", tags: ["popular"] }]);
  let v = 0;
  const deps = fakeDeps({
    findImage: async () => ["u1", "u2", "u3"],
    verify: async () => ++v >= 2, // first false, then true
  });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img, "img/dish-0.jpg");
  assert.equal(v, 2);
});

test("addImages leaves img unset when commit throws, and still processes other items", async () => {
  const menu = menuWith([{ en: "A", tags: ["signature"] }, { en: "B", tags: ["popular"] }]);
  const deps = fakeDeps({
    commit: async (_slug, fileName) => { if (fileName === "dish-0.jpg") throw new Error("gh fail"); },
  });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
  assert.equal(menu.sections[0].items[1].img, "img/dish-1.jpg");
});

test("addImages does nothing when there is no restaurant identity", async () => {
  const menu = menuWith([{ en: "A", tags: ["signature"] }]);
  let called = false;
  const deps = fakeDeps({ findImage: async () => { called = true; return ["u"]; } });
  await addImages(menu, undefined, "s", deps);
  assert.equal(called, false);
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
});

test("addImages leaves an item without img when no URL works", async () => {
  const menu = menuWith([{ en: "A", tags: ["signature"] }]);
  const deps = fakeDeps({ findImage: async () => [] });
  await addImages(menu, "Rest", "s", deps);
  assert.equal(menu.sections[0].items[0].img ?? undefined, undefined);
});
