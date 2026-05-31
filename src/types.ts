/** Dietary / category icons that appear in the menu legend. */
export type DietTag =
  | "spicy"
  | "veg"
  | "pork"
  | "chicken"
  | "seafood"
  | "beef";

export interface MenuItem {
  /** English name (as printed). */
  en: string;
  /** Traditional-Chinese name. */
  zh: string;
  /** Price exactly as printed, e.g. "18", "8 / 9", "108". Optional. */
  p?: string;
  /** Dietary / category icons. */
  t?: DietTag[];
  /** English description, if the menu has one. */
  den?: string;
  /** Traditional-Chinese description. */
  dzh?: string;
}

export interface MenuSection {
  en: string;
  zh: string;
  /** Stable id used for in-page anchor links (auto-filled if missing). */
  id?: string;
  /** Optional footnote shown under the section heading. */
  note?: string;
  items: MenuItem[];
}

export interface Menu {
  restaurant?: { en?: string; zh?: string };
  /** Currency label, e.g. "SGD". */
  currency?: string;
  sections: MenuSection[];
}
