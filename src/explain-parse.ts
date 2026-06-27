import type { GlossaryEntry } from "./types.js";

/** Pull the first balanced JSON array out of the model's text and normalise it
 *  into GlossaryEntry[]. Pure (no config, no network) so it is unit-testable. */
export function parseExplainResponse(text: string): GlossaryEntry[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) {
    throw new Error("Model did not return a JSON array:\n" + text.slice(0, 300));
  }
  const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
  return arr
    .map((raw) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      return {
        term: String(e.term ?? ""),
        display_en: String(e.display_en ?? ""),
        display_zh: String(e.display_zh ?? ""),
        explain_en: String(e.explain_en ?? ""),
        explain_zh: String(e.explain_zh ?? ""),
        category: String(e.category ?? ""),
      };
    })
    .filter((e) => e.term);
}
