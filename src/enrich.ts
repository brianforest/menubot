import type { Menu, GlossaryEntry, ExplainRequest } from "./types.js";

/** The subset of Glossary that enrichMenu needs (so tests can inject a fake). */
export interface GlossaryLike {
  getMany(terms: string[]): Map<string, GlossaryEntry>;
  put(entry: GlossaryEntry, createdAt: string): void;
}

export type ExplainFn = (reqs: ExplainRequest[]) => Promise<GlossaryEntry[]>;

/**
 * Glossary-first enrichment: attach a bilingual explanation to every item that
 * carries an `xterm`. Cache hits cost nothing; cache misses go to explainFn once
 * and are stored. Returns the same menu object (mutated in place + returned).
 */
export async function enrichMenu(
  menu: Menu,
  glossary: GlossaryLike,
  explainFn: ExplainFn,
  now: string,
): Promise<Menu> {
  // distinct xterms + one sample item name per term (for explain context)
  const sampleByTerm = new Map<string, { en: string; zh: string }>();
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const t = (it.xterm ?? "").trim();
      if (t && !sampleByTerm.has(t)) sampleByTerm.set(t, { en: it.en, zh: it.zh });
    }
  }
  const terms = [...sampleByTerm.keys()];
  if (!terms.length) return menu;

  const byTerm = new Map<string, GlossaryEntry>(glossary.getMany(terms));
  const misses = terms.filter((t) => !byTerm.has(t));
  if (misses.length) {
    const reqs: ExplainRequest[] = misses.map((t) => ({
      term: t,
      sample_en: sampleByTerm.get(t)!.en,
      sample_zh: sampleByTerm.get(t)!.zh,
    }));
    for (const e of await explainFn(reqs)) {
      glossary.put(e, now);
      byTerm.set(e.term, e);
    }
  }

  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const t = (it.xterm ?? "").trim();
      const e = t ? byTerm.get(t) : undefined;
      if (e) it.explain = { en: e.explain_en, zh: e.explain_zh };
    }
  }
  return menu;
}
