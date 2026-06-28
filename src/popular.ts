import type { Menu, TagDef } from "./types.js";

/** The reserved well-known tag this stage populates (P2a built the UI for it). */
export const POPULAR_TAG: TagDef = {
  id: "popular",
  en: "Popular",
  zh: "人氣",
  icon: "🔥",
  group: "highlight",
};

/** Injected web-popularity finder: returns the `i` indices of popular items. */
export type FindPopular = (
  restaurant: string,
  location: string,
  items: { i: number; en: string; zh: string }[],
) => Promise<number[]>;

/** Parse the place name from a Google Maps `/maps/place/<name>/` URL, or null. */
export function googlePlaceName(text = ""): string | null {
  const m = text.match(/\/maps\/place\/([^/]+)/);
  if (!m) return null;
  try {
    const name = decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a restaurant identity for searching. Precedence for the name:
 * Google place name (from a hint URL) → menu.restaurant → free-text hint.
 * When the name came from the menu or a Google URL, the remaining free text
 * (hint with any URL removed) is treated as location context.
 */
export function resolveIdentity(
  menu: Menu,
  hint = "",
): { restaurant: string; location: string } {
  const gname = googlePlaceName(hint);
  const menuName = (menu.restaurant?.en || menu.restaurant?.zh || "").trim();
  const freeText = hint.replace(/https?:\/\/\S+/g, "").trim();
  const restaurant = (gname || menuName || freeText).trim();
  const location =
    restaurant && (restaurant === gname || restaurant === menuName) ? freeText : "";
  return { restaurant, location };
}

/** Remove any `popular` tag from the menu vocabulary and from every item. */
function stripPopular(menu: Menu): void {
  menu.tags = (menu.tags ?? []).filter((t) => t.id !== "popular");
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      if (it.tags?.length) it.tags = it.tags.filter((t) => t !== "popular");
    }
  }
}

/**
 * Flag the restaurant's popular/signature items with the `popular` tag.
 * Owns the tag end-to-end: strips any stray `popular` first (so a model slip
 * can't leak it), then applies only verified results. Resilient — on no
 * identity, empty/over-flagged result, or a thrown finder, the menu is left
 * with no `popular` tag. Mutates and returns the same menu object.
 */
export async function tagPopular(
  menu: Menu,
  findPopular: FindPopular,
  hint?: string,
): Promise<Menu> {
  stripPopular(menu);

  const { restaurant, location } = resolveIdentity(menu, hint);
  if (!restaurant) return menu;

  const refs = [];
  for (const sec of menu.sections) for (const it of sec.items ?? []) refs.push(it);
  if (!refs.length) return menu;
  const items = refs.map((it, i) => ({ i, en: it.en, zh: it.zh }));

  let idx: number[];
  try {
    idx = await findPopular(restaurant, location, items);
  } catch {
    return menu;
  }

  const seen = new Set<number>();
  const kept: number[] = [];
  for (const n of idx ?? []) {
    if (Number.isInteger(n) && n >= 0 && n < refs.length && !seen.has(n)) {
      seen.add(n);
      kept.push(n);
    }
  }

  const cap = Math.max(6, Math.floor(items.length * 0.4));
  if (kept.length === 0 || kept.length > cap) return menu;

  for (const n of kept) {
    const it = refs[n];
    it.tags = it.tags ?? [];
    if (!it.tags.includes("popular")) it.tags.push("popular");
  }
  menu.tags = [POPULAR_TAG, ...(menu.tags ?? [])];
  return menu;
}
