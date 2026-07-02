import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Menu, MenuSource } from "./types.js";
import { buildContentBlocks } from "./blocks.js";
import { INTRO_SCHEMA, ITEM_RULES } from "./extract-rules.js";
import { outlineMenu } from "./extract-outline.js";
import { extractSections } from "./extract-sections.js";
import { partitionSections } from "./extract-partition.js";
import { mergeExtract, type Outline } from "./extract-merge.js";
import { finalMessageWithDeadline } from "./stream-deadline.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = INTRO_SCHEMA + ITEM_RULES; // byte-identical to the original literal

// The single call digitises the whole menu at once and can legitimately run
// minutes; a generous ceiling bounds a truly-hung request without failing big
// menus. No retries (a long vision call must not be billed/run twice).
const SINGLE_OPTS = { timeout: 600_000, maxRetries: 0 } as const;

/** Pull the first balanced JSON object out of a string. */
function parseJson(text: string): Menu {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Model did not return JSON:\n" + text.slice(0, 500));
  }
  return JSON.parse(text.slice(start, end + 1)) as Menu;
}

/**
 * Read menu photos and return a structured, bilingual Menu (single-call path).
 * @param sources Menu sources (images and/or PDFs).
 */
export async function extractMenuSingle(sources: MenuSource[], context?: string): Promise<Menu> {
  // Single carries the WHOLE menu in one pass so price alignment is resolved
  // holistically — the correctness path for complex/uncertain layouts (parallel
  // per-section workers misalign offset price columns and inflate item counts).
  // So give it room: a large complex menu (e.g. 53 sections / 204 items) exceeds
  // 32000 and truncates mid-JSON; 64000 holds ~330 items. The model ceiling is
  // 128K; menus beyond 64000 surface the honest truncation error below. A
  // generous max_tokens makes the SDK reject a non-streaming request, so we
  // stream and collect the final message (SINGLE_OPTS.timeout 600s covers it).
  const resp = await finalMessageWithDeadline(
    client.messages.stream(
      {
        model: config.anthropic.model,
        max_tokens: 64000,
        system: SYSTEM,
        messages: [{ role: "user", content: buildContentBlocks(sources, context) }],
      },
      SINGLE_OPTS,
    ),
    SINGLE_OPTS.timeout,
    "extract",
  );

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // If the model hit the token ceiling the JSON is incomplete — report it
  // clearly instead of surfacing a cryptic JSON.parse position error.
  if (resp.stop_reason === "max_tokens") {
    throw new Error(
      "菜單太大、辨識結果被截斷。請分批傳較少的頁數，或調高 max_tokens。" +
        " (model output hit max_tokens; JSON incomplete)",
    );
  }

  let menu: Menu;
  try {
    menu = parseJson(text);
  } catch (err) {
    // Persist the raw model output so the failure can be inspected.
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync("/tmp/menubot-last-extract.txt", text);
    } catch {}
    throw err;
  }
  if (!menu.sections?.length) {
    throw new Error("No menu sections were detected in the photos.");
  }
  return menu;
}

/** Injected deps for the outline→menu half (enables unit-testing without the real LLM). */
export interface FromOutlineDeps {
  extractSections: typeof extractSections;
}

/**
 * Partition a pre-computed outline into contiguous groups, run one parallel worker
 * per group (each sees all sources), and deterministically merge. Throws if the
 * outline is empty or the merged section count differs from the outline spine — a
 * short-count menu is worse than a fallback, so the caller re-runs the single call.
 */
export async function extractFromOutline(
  outline: Outline,
  sources: MenuSource[],
  deps: FromOutlineDeps = { extractSections },
  context?: string,
): Promise<Menu> {
  if (!outline.sections?.length) throw new Error("Outline produced no sections.");
  const groups = partitionSections(outline.sections);
  const results = await Promise.all(
    groups.map((g) => deps.extractSections(sources, outline.tags ?? [], g.titles, context)),
  );
  const menu = mergeExtract(outline, results);
  if (menu.sections.length !== outline.sections.length) {
    throw new Error(
      `Parallel extract incomplete: ${menu.sections.length}/${outline.sections.length} sections.`,
    );
  }
  return menu;
}

export interface ParallelDeps {
  outline: typeof outlineMenu;
  extractSections: typeof extractSections;
}

/**
 * Two-stage extract: outline → extractFromOutline. Kept for EXTRACT_MODE=parallel.
 */
export async function extractMenuParallel(
  sources: MenuSource[],
  deps: ParallelDeps = { outline: outlineMenu, extractSections },
  context?: string,
): Promise<Menu> {
  const outline = await deps.outline(sources, context);
  return extractFromOutline(outline, sources, { extractSections: deps.extractSections }, context);
}

/** Injected deps for the adaptive dispatcher (enables unit-testing without the LLM). */
export interface AdaptiveDeps {
  outline: typeof outlineMenu;
  extractSections: typeof extractSections;
  single: typeof extractMenuSingle;
}

/** Cross-cutting extract options: restaurant context for the prompt, and an
 *  adaptive-routing callback so the caller can message the user. */
export interface ExtractOpts {
  context?: string;
  onRoute?: (route: "single" | "parallel", complex: boolean | undefined) => void;
}

/**
 * Run the outline once, then pick a path: a structurally-complex menu (offset price
 * columns, nested spirits tables) takes the proven single call; a simple menu takes the
 * parallel path, reusing the already-fetched outline (no second outline call). Any
 * outline failure, a missing/ambiguous `complex` flag, or a parallel completeness miss
 * all fall back to single.
 */
export async function extractMenuAdaptive(
  sources: MenuSource[],
  deps: AdaptiveDeps = { outline: outlineMenu, extractSections, single: extractMenuSingle },
  opts: ExtractOpts = {},
): Promise<Menu> {
  let outline: Outline;
  try {
    outline = await deps.outline(sources, opts.context);
  } catch (e) {
    console.error("Adaptive: outline failed; single fallback:", e);
    return deps.single(sources, opts.context);
  }
  // Only a definite `complex === false` takes the parallel path; complex or
  // missing/ambiguous falls back to the safe single call.
  if (outline.complex !== false) {
    console.log(`[extract] adaptive → single (complex=${outline.complex})`);
    opts.onRoute?.("single", outline.complex);
    return deps.single(sources, opts.context);
  }
  console.log("[extract] adaptive → parallel (complex=false)");
  opts.onRoute?.("parallel", false);
  try {
    return await extractFromOutline(
      outline,
      sources,
      { extractSections: deps.extractSections },
      opts.context,
    );
  } catch (e) {
    console.error("Adaptive: parallel path failed; single fallback:", e);
    return deps.single(sources, opts.context);
  }
}

/** Injected dependencies for dispatchExtract (enables unit-testing without the real LLM). */
export interface DispatchDeps {
  parallel: typeof extractMenuParallel;
  single: typeof extractMenuSingle;
  adaptive: typeof extractMenuAdaptive;
}

/**
 * Core dispatch logic: try parallel path; fall back to single on any error.
 * Exported so tests can inject fakes for both paths without touching config.
 */
export async function dispatchExtract(
  sources: MenuSource[],
  mode: "single" | "parallel" | "adaptive",
  deps: DispatchDeps = {
    parallel: extractMenuParallel,
    single: extractMenuSingle,
    adaptive: extractMenuAdaptive,
  },
  opts: ExtractOpts = {},
): Promise<Menu> {
  if (mode === "adaptive") return deps.adaptive(sources, undefined, opts);
  if (mode === "parallel") {
    try {
      return await deps.parallel(sources, undefined, opts.context);
    } catch (e) {
      console.error("Parallel extract failed; falling back to single call:", e);
    }
  }
  return deps.single(sources, opts.context);
}

/** Read menu photos and return a structured, bilingual Menu. Dispatches on
 *  EXTRACT_MODE; parallel mode falls back to the single call on any failure. */
export function extractMenu(sources: MenuSource[], opts?: ExtractOpts): Promise<Menu> {
  return dispatchExtract(sources, config.extract.mode, undefined, opts);
}
