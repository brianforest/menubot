import { resolveMapContext } from "./maps-link.js";

export interface ContextDeps {
  resolveMap: typeof resolveMapContext;
}

/** Build a restaurant/region context line from the user's hint: the resolved map
 *  place (preferred — deterministic name+address) plus any extra typed text, with
 *  the raw URL stripped. Returns null when there is nothing usable. */
export async function buildContext(
  hint: string | undefined,
  deps: ContextDeps = { resolveMap: resolveMapContext },
): Promise<string | null> {
  if (!hint || !hint.trim()) return null;
  const place = await deps.resolveMap(hint);
  const typed = hint.replace(/https?:\/\/[^\s]+/g, "").trim(); // drop URLs from the text
  const parts = [place, typed].filter((s): s is string => !!s && s.length > 0);
  if (!parts.length) return null;
  return [...new Set(parts)].join(" — ");
}
