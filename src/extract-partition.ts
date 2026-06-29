export interface SectionTitle {
  en: string;
  zh: string;
}

export interface SectionGroup {
  /** Index of this group's first title within the original list. */
  startIndex: number;
  titles: SectionTitle[];
}

/**
 * Split section titles into contiguous groups for parallel extraction. The
 * group count is `ceil(n / perWorker)` capped at `maxWorkers`; groups stay
 * contiguous and in order so the merged section order is the reading order.
 */
export function partitionSections(
  titles: SectionTitle[],
  opts: { perWorker?: number; maxWorkers?: number } = {},
): SectionGroup[] {
  const n = titles.length;
  if (n === 0) return [];
  const perWorker = opts.perWorker ?? 8;
  const maxWorkers = opts.maxWorkers ?? 6;

  const groupCount = Math.min(Math.ceil(n / perWorker), maxWorkers);
  const size = Math.ceil(n / groupCount); // titles per group (last may be smaller)

  const groups: SectionGroup[] = [];
  for (let start = 0; start < n; start += size) {
    groups.push({ startIndex: start, titles: titles.slice(start, start + size) });
  }
  return groups;
}
