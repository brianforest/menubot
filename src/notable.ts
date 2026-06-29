import type { Menu, TagDef } from "./types.js";

/** Reserved well-known tag for items that carry a 💡 explanation (distinctive /
 *  worth-knowing dishes). Populated by tagNotable; renders the 💡 filter chip. */
export const NOTABLE_TAG: TagDef = {
  id: "notable",
  en: "Notable",
  zh: "特色",
  icon: "💡",
  group: "highlight",
};

/** Remove any `notable` tag from the menu vocabulary and from every item. */
function stripNotable(menu: Menu): void {
  menu.tags = (menu.tags ?? []).filter((t) => t.id !== "notable");
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      if (it.tags?.length) it.tags = it.tags.filter((t) => t !== "notable");
    }
  }
}

/**
 * Tag every item that has an explanation with `notable` so the 💡 "特色" filter
 * chip renders. Owns the tag end-to-end: strips any stray `notable` first. Pure;
 * mutates and returns the same menu.
 */
export function tagNotable(menu: Menu): Menu {
  stripNotable(menu);
  let any = false;
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const ex = it.explain;
      if (ex && ((ex.en && ex.en.trim()) || (ex.zh && ex.zh.trim()))) {
        it.tags = it.tags ?? [];
        if (!it.tags.includes("notable")) it.tags.push("notable");
        any = true;
      }
    }
  }
  if (any) menu.tags = [NOTABLE_TAG, ...(menu.tags ?? [])];
  return menu;
}
