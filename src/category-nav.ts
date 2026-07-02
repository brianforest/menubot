import type { MenuSection } from "./types.js";

export interface NavL2 {
  l2: { en: string; zh: string };
  count: number;
  anchor: string; // id of the first section in this L2 group
}
export interface NavL1 {
  l1: { en: string; zh: string };
  tier: string;
  anchor: string; // id of the first section in this L1 group
  l2s: NavL2[];
}

const TIER_RANK: Record<string, number> = {
  savory: 0, dessert: 1, drink: 2, alcohol: 3, other: 4,
};
const rankOf = (tier: string | undefined): number =>
  TIER_RANK[(tier ?? "other").toLowerCase()] ?? TIER_RANK.other;

const OTHER_L1 = { en: "Other", zh: "其他" };

/**
 * Build the tier-ordered L1 → L2 → (sections) nav tree.
 * - L1 groups are ordered by fixed tier rank, then first appearance.
 * - Within an L1, sections sharing an l2 (by zh, falling back to en) consolidate
 *   into ONE L2 node; count is the total items across the merged sections.
 * - Sections missing l1 fall into an "Other" L1 (tier "other"), each its own L2.
 * Preserves original section order for stable, menu-faithful sequencing.
 */
export function groupByCategory(sections: MenuSection[]): NavL1[] {
  const l1s: NavL1[] = [];
  const l1Index = new Map<string, NavL1>();

  for (const sec of sections) {
    const l1 = sec.l1 ?? OTHER_L1;
    const tier = sec.l1 ? (sec.tier ?? "other") : "other";
    const l1Key = l1.zh || l1.en;
    let n1 = l1Index.get(l1Key);
    if (!n1) {
      n1 = { l1, tier, anchor: sec.id ?? "", l2s: [] };
      l1Index.set(l1Key, n1);
      l1s.push(n1);
    }
    const l2 = sec.l2 ?? { en: sec.en, zh: sec.zh };
    const l2Key = l2.zh || l2.en;
    let n2 = n1.l2s.find((x) => (x.l2.zh || x.l2.en) === l2Key);
    if (!n2) {
      n2 = { l2, count: 0, anchor: sec.id ?? "" };
      n1.l2s.push(n2);
    }
    n2.count += (sec.items ?? []).length;
  }

  // Stable sort by tier rank; equal ranks keep insertion (first-appearance) order.
  return l1s
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rankOf(a.n.tier) - rankOf(b.n.tier) || a.i - b.i)
    .map((x) => x.n);
}
