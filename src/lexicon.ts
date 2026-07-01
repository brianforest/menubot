import type { Menu, MenuItem } from "./types.js";

/** One locale's mapping for one English term. `variants` are known zh spellings
 *  to rewrite to `canonical`. */
export interface LexiconEntry {
  enTerm: string; // lowercase
  canonical: string;
  variants: string[];
}

/** Called when an item's en matched a term but its zh used no known variant —
 *  a curation candidate. */
export type OnMiss = (enTerm: string, zh: string) => void;

/**
 * Canonicalize transliterated dish terms in one item's zh fields to the
 * locale-best translation. Pure (except the optional onMiss callback).
 *
 * For each entry: the `item.en` (lowercased) must CONTAIN `enTerm` (the gate);
 * only then are known `variants` replaced with `canonical` inside every zh field
 * of the item, variants applied LONGEST-FIRST so a short variant cannot consume a
 * substring of a longer one. The en-gate — not word boundaries (Chinese has none)
 * — is what makes short/ambiguous variants safe. If the gate opened but no variant
 * matched and the item's zh name does not already contain `canonical`, onMiss is
 * called with a curation candidate.
 */
export function normalizeItemLexicon(item: MenuItem, entries: LexiconEntry[], onMiss?: OnMiss): void {
  if (!item.en) return;
  const en = item.en.toLowerCase();
  for (const e of entries) {
    if (!en.includes(e.enTerm)) continue; // gate closed
    const variants = [...e.variants].sort((a, b) => b.length - a.length);
    let hit = false;
    const rewrite = (s: string): string => {
      let out = s;
      for (const v of variants) {
        if (v && out.includes(v)) {
          out = out.split(v).join(e.canonical);
          hit = true;
        }
      }
      return out;
    };
    item.zh = rewrite(item.zh);
    if (item.dzh !== undefined) item.dzh = rewrite(item.dzh);
    if (item.explain) item.explain.zh = rewrite(item.explain.zh);
    for (const og of item.options ?? []) {
      og.zh = rewrite(og.zh);
      for (const c of og.choices ?? []) c.zh = rewrite(c.zh);
    }
    if (!hit && onMiss && !item.zh.includes(e.canonical)) onMiss(e.enTerm, item.zh);
  }
}

/** Apply normalizeItemLexicon to every item of the menu (mutates in place and
 *  returns it). Only item-level fields are touched — B2 is keyed on item.en. */
export function normalizeMenuLexicon(menu: Menu, entries: LexiconEntry[], onMiss?: OnMiss): Menu {
  if (entries.length === 0) return menu;
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) normalizeItemLexicon(it, entries, onMiss);
  }
  return menu;
}
