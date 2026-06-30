import { createHash } from "node:crypto";

/**
 * Content version for cached explanations. A glossary entry is only a valid
 * cache hit if it was written under the CURRENT version; bump-free and fully
 * automatic — the version is derived from the inputs that determine an
 * explanation's content, so changing the explain prompt or the model
 * invalidates stale entries on their own (they get lazily re-explained on next
 * encounter). No human in the loop (productization: end users can't "bump").
 *
 * Currently keyed on (explain SYSTEM prompt + model). When the culinary lexicon
 * starts feeding explanations (Phase B2/B3), fold its signature in here so those
 * changes propagate the same way.
 */
export function explainVersion(system: string, model: string): string {
  return createHash("sha256").update(system).update("\0").update(model).digest("hex").slice(0, 12);
}
