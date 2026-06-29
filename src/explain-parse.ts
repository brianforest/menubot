import type { GlossaryEntry } from "./types.js";

/** Coerce raw parsed objects into GlossaryEntry[], dropping entries with no term. */
function normalize(arr: unknown[]): GlossaryEntry[] {
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

/** Extract every top-level balanced `{…}` object from a string and JSON.parse each,
 *  skipping any incomplete/invalid trailing object. String-aware so braces inside
 *  string values don't confuse the depth count. This is the salvage path for a
 *  response truncated by max_tokens (the array never closes). */
function salvageObjects(s: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let startIdx = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          try {
            out.push(JSON.parse(s.slice(startIdx, i + 1)));
          } catch {
            /* skip a malformed object */
          }
          startIdx = -1;
        }
      }
    }
  }
  return out;
}

/** Pull the JSON array of entries out of the model's text and normalise it into
 *  GlossaryEntry[]. Pure (no config, no network) so it is unit-testable.
 *
 *  Resilient to truncation: a term-rich menu can overflow the explain step's
 *  max_tokens, cutting the array off mid-object with no closing `]`. Rather than
 *  drop every explanation (the old behaviour — one bad parse lost the whole menu's
 *  💡), we salvage the complete `{…}` objects that did arrive. Only a response with
 *  no array at all (`[` absent) is treated as a hard failure. */
export function parseExplainResponse(text: string): GlossaryEntry[] {
  const start = text.indexOf("[");
  if (start === -1) {
    throw new Error("Model did not return a JSON array:\n" + text.slice(0, 300));
  }
  const end = text.lastIndexOf("]");
  if (end > start) {
    try {
      return normalize(JSON.parse(text.slice(start, end + 1)) as unknown[]);
    } catch {
      /* malformed/truncated despite a `]` — fall through to salvage */
    }
  }
  return normalize(salvageObjects(text.slice(start + 1)));
}
