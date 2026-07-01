/** One curated English-term → locale-best translation mapping.
 *  `variants` are the known zh spellings the extractor emits for this term that
 *  should be rewritten to `canonical`. `enTerm` MUST be lowercase (matched as a
 *  lowercased substring of item.en). Only add rows whose canonical is the best,
 *  most common translation in that locale. */
export interface LexiconRow {
  enTerm: string;
  locale: string; // "zh-TW" | "zh-HK" | "zh-CN" | "zh-SG" | "zh-MY"
  canonical: string;
  variants: string[];
  note: string;
}

/** Conservative zh-TW starter set. Grow by appending rows (driven by the
 *  [lexicon-miss] log). Loaded via INSERT OR IGNORE, so editing a row in the
 *  db is never clobbered by this seed. The item.en gate makes short/collision-prone
 *  variants (e.g. 華夫) safe: only an actual waffle item is ever touched. */
export const LEXICON_SEED: LexiconRow[] = [
  {
    enTerm: "waffle",
    locale: "zh-TW",
    canonical: "格子鬆餅",
    variants: ["鬆餅華夫", "鬆餅格子餅", "鬆格餅", "窩夫", "華夫餅", "華夫"],
    note: "waffle; en-gate makes short variants safe",
  },
  {
    enTerm: "flat white",
    locale: "zh-TW",
    canonical: "馥芮白",
    variants: ["平白咖啡", "馥列白"],
    note: "flat white coffee",
  },
];
