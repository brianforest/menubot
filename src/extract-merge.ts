import type { Menu, MenuSection, TagDef } from "./types.js";

export interface Outline {
  restaurant?: { en?: string; zh?: string };
  currency?: string;
  kind?: string;
  tags?: TagDef[];
  /** Ordered section titles only — no items. */
  sections: { en: string; zh: string }[];
}

export interface SectionsResult {
  sections: MenuSection[];
  /** Tag definitions a worker minted that were absent from the outline vocab. */
  tags?: TagDef[];
}

/**
 * Drop exact-duplicate items repeated WITHIN a section — a focused worker can
 * list the same dish twice (same name, 中文 and price). This is always safe: a
 * real section never prints the identical item twice. Items that share a name
 * but differ in price (by-glass vs by-bottle) are kept, and a repeat across
 * DIFFERENT sections (happy-hour pricing) is left alone.
 */
function dedupeWithinSections(sections: MenuSection[]): MenuSection[] {
  return sections.map((sec) => {
    const seen = new Set<string>();
    const items = (sec.items ?? []).filter((it) => {
      const key = `${(it.en ?? "").trim().toLowerCase()}|${(it.zh ?? "").trim()}|${it.p ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...sec, items };
  });
}

/**
 * Reassemble a Menu from the Pass-1 outline and the Pass-2 per-group results.
 * Deterministic: sections concatenate in group order (the reading order),
 * global fields come from the outline, and the tag vocabulary is the union by
 * id (first definition wins) pruned to ids that some item actually carries —
 * matching the single-call "only tags used by ≥1 item" rule.
 */
export function mergeExtract(outline: Outline, results: SectionsResult[]): Menu {
  const sections: MenuSection[] = dedupeWithinSections(
    results.flatMap((r) => r.sections ?? []),
  );

  const byId = new Map<string, TagDef>();
  for (const t of [...(outline.tags ?? []), ...results.flatMap((r) => r.tags ?? [])]) {
    if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  }

  const used = new Set<string>();
  for (const sec of sections) {
    for (const it of sec.items ?? []) {
      for (const id of it.tags ?? []) used.add(id);
    }
  }

  const tags = [...byId.values()].filter((t) => used.has(t.id));

  return {
    restaurant: outline.restaurant,
    currency: outline.currency,
    kind: outline.kind,
    tags,
    sections,
  };
}
