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
 * Reassemble a Menu from the Pass-1 outline and the Pass-2 per-group results.
 * Deterministic: sections concatenate in group order (the reading order),
 * global fields come from the outline, and the tag vocabulary is the union by
 * id (first definition wins) pruned to ids that some item actually carries —
 * matching the single-call "only tags used by ≥1 item" rule.
 */
export function mergeExtract(outline: Outline, results: SectionsResult[]): Menu {
  const sections: MenuSection[] = results.flatMap((r) => r.sections ?? []);

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
