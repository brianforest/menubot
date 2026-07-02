/** A classification label this menu uses (dietary, allergen, highlight, …). */
export interface TagDef {
  /** Stable lowercase-slug id, e.g. "vegetarian", "gluten-free", "signature". */
  id: string;
  /** English label. */
  en: string;
  /** Traditional-Chinese label. */
  zh: string;
  /** Emoji shown on chips/items; omitted when no fitting emoji applies. */
  icon?: string;
  /** Coarse grouping: "diet" | "allergen" | "protein" | "highlight" | "other". */
  group?: string;
}

export interface MenuItem {
  /** English name (as printed). */
  en: string;
  /** Traditional-Chinese name. */
  zh: string;
  /** Price exactly as printed, e.g. "18", "8 / 9", "108". Optional. */
  p?: string;
  /** Ids of the TagDefs this item carries. */
  tags?: string[];
  /** English description, if the menu has one. */
  den?: string;
  /** Traditional-Chinese description. */
  dzh?: string;
  /** Extraction output: canonical lowercase-hyphen slug when this item needs a
   *  cuisine explanation (e.g. "flat-white"); absent/"" otherwise. */
  xterm?: string;
  /** Filled by enrichMenu from the glossary/explain step. */
  explain?: { en: string; zh: string };
  /** Configurable option groups (broths, noodles, toppings, sizes, add-ons). */
  options?: OptionGroup[];
  /** Relative path to a committed dish photo, e.g. "img/dish-3.jpg"; absent if none. */
  img?: string;
}

export interface MenuSection {
  en: string;
  zh: string;
  /** Stable id used for in-page anchor links (auto-filled if missing). */
  id?: string;
  /** Optional footnote shown under the section heading. */
  note?: string;
  /** Broad L1 category for two-level nav, e.g. { en: "Alcohol", zh: "酒類" }. */
  l1?: { en: string; zh: string };
  /** L1 ordering tier: "savory" | "dessert" | "drink" | "alcohol" | "other". */
  tier?: string;
  /** L2 consolidated sub-category, e.g. { en: "Whiskey", zh: "威士忌" }. Sections
   *  sharing an (l1, l2) merge into one L2 nav node; the section's own en/zh stays
   *  the L3 sub-heading. */
  l2?: { en: string; zh: string };
  items: MenuItem[];
}

export interface Menu {
  restaurant?: { en?: string; zh?: string };
  /** Currency label, e.g. "SGD". */
  currency?: string;
  /** Best-effort menu type: "food" | "spa" | "service" | "other". Informational. */
  kind?: string;
  /** The tag vocabulary used by this menu — only tags carried by ≥1 item. */
  tags?: TagDef[];
  sections: MenuSection[];
}

/** One ingestion source for the extractor: a photo or a PDF. */
export interface MenuSource {
  /** "image" (e.g. a JPEG photo) or "pdf". */
  kind: "image" | "pdf";
  /** Raw file bytes. */
  bytes: Buffer;
  /** MIME type, e.g. "image/jpeg" or "application/pdf". */
  mime: string;
}

/** A cached glossary entry (one explained culinary term). */
export interface GlossaryEntry {
  term: string;        // canonical slug (primary key)
  display_en: string;  // "Flat White"
  display_zh: string;  // "馥芮白"
  explain_en: string;
  explain_zh: string;
  category: string;    // "coffee" | "dish" | "ingredient" | "technique" | …
}

/** One term to be explained, with a sample item name for context. */
export interface ExplainRequest {
  term: string;
  sample_en: string;
  sample_zh: string;
}

/** One selectable choice within an option group. */
export interface OptionChoice {
  en: string;
  zh: string;
  /** Extra price for this choice if it is a paid add-on, as printed; else absent. */
  p?: string;
}

/** A group of related choices for a configurable item. */
export interface OptionGroup {
  en: string;   // group label in English, e.g. "Broth"
  zh: string;   // group label in 繁體中文, e.g. "湯底可選"
  /** "one" = pick exactly one; "list" = included components; "any" = optional extras. */
  kind?: "one" | "list" | "any";
  choices: OptionChoice[];
}
