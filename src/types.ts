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
