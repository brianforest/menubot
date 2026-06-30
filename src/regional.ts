import type { Menu } from "./types.js";

/**
 * Rewrite regional Chinese culinary variants to canonical Taiwan wording.
 * Pure: deterministic, no I/O. Substring replacement keyed on the variant, with
 * variants applied LONGEST-FIRST so a short variant cannot consume a substring of
 * a longer one (e.g. 意大利粉 is handled before 意大利). Safety against false
 * positives comes from the lexicon containing only unambiguous variants, not from
 * word boundaries (Chinese has none).
 */
export function normalizeRegional(text: string, map: Map<string, string>): string {
  if (!text || map.size === 0) return text;
  const variants = [...map.keys()].sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of variants) {
    if (out.includes(v)) out = out.split(v).join(map.get(v)!);
  }
  return out;
}

/** Apply normalizeRegional to every user-facing zh field of the menu (mutates in
 *  place and returns it). en fields and prices are never touched. */
export function normalizeMenu(menu: Menu, map: Map<string, string>): Menu {
  if (map.size === 0) return menu;
  const n = (s: string | undefined): string | undefined =>
    s === undefined ? s : normalizeRegional(s, map);

  for (const t of menu.tags ?? []) t.zh = normalizeRegional(t.zh, map);

  for (const sec of menu.sections) {
    sec.zh = normalizeRegional(sec.zh, map);
    for (const it of sec.items ?? []) {
      it.zh = normalizeRegional(it.zh, map);
      it.dzh = n(it.dzh);
      if (it.explain) it.explain.zh = normalizeRegional(it.explain.zh, map);
      for (const og of it.options ?? []) {
        og.zh = normalizeRegional(og.zh, map);
        for (const c of og.choices ?? []) c.zh = normalizeRegional(c.zh, map);
      }
    }
  }
  return menu;
}
