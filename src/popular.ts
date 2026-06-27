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
