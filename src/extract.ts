import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Menu, MenuSource } from "./types.js";
import { buildContentBlocks } from "./blocks.js";
import { INTRO_SCHEMA, ITEM_RULES } from "./extract-rules.js";
import { outlineMenu } from "./extract-outline.js";
import { extractSections } from "./extract-sections.js";
import { partitionSections } from "./extract-partition.js";
import { mergeExtract } from "./extract-merge.js";

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
export async function extractMenuSingle(sources: MenuSource[]): Promise<Menu> {
  // A full multi-page menu can be large; 8k tokens truncated the JSON
  // mid-array. With a generous max_tokens the SDK rejects a non-streaming
  // request ("Streaming is required for operations that may take longer than
  // 10 minutes"), so we stream and collect the final message.
  const resp = await client.messages
    .stream(
      {
        model: config.anthropic.model,
        max_tokens: 32000,
        system: SYSTEM,
        messages: [{ role: "user", content: buildContentBlocks(sources) }],
      },
      SINGLE_OPTS,
    )
    .finalMessage();

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

export interface ParallelDeps {
  outline: typeof outlineMenu;
  extractSections: typeof extractSections;
}

/**
 * Two-stage extract: Pass-1 outline → contiguous partition → one parallel
 * worker per group (each sees all sources) → deterministic merge. Throws if the
 * outline is empty, any worker fails, or the merged menu has fewer sections than
 * the outline spine (completeness guard — erring toward fallback costs latency,
 * never fidelity).
 */
export async function extractMenuParallel(
  sources: MenuSource[],
  deps: ParallelDeps = { outline: outlineMenu, extractSections },
): Promise<Menu> {
  const outline = await deps.outline(sources);
  if (!outline.sections?.length) throw new Error("Outline produced no sections.");
  const groups = partitionSections(outline.sections);
  const results = await Promise.all(
    groups.map((g) => deps.extractSections(sources, outline.tags ?? [], g.titles)),
  );
  const menu = mergeExtract(outline, results);
  // Fix 1: completeness guard — merged section count must match the Pass-1 spine.
  // A short-count menu (e.g. a worker returned [] sections) is worse than a
  // fallback, so throw here to trigger the dispatcher's single-call safety net.
  if (menu.sections.length !== outline.sections.length) {
    throw new Error(
      `Parallel extract incomplete: ${menu.sections.length}/${outline.sections.length} sections.`,
    );
  }
  return menu;
}

/** Injected dependencies for dispatchExtract (enables unit-testing without the real LLM). */
export interface DispatchDeps {
  parallel: typeof extractMenuParallel;
  single: typeof extractMenuSingle;
}

/**
 * Core dispatch logic: try parallel path; fall back to single on any error.
 * Exported so tests can inject fakes for both paths without touching config.
 */
export async function dispatchExtract(
  sources: MenuSource[],
  mode: "single" | "parallel",
  deps: DispatchDeps = { parallel: extractMenuParallel, single: extractMenuSingle },
): Promise<Menu> {
  if (mode === "parallel") {
    try {
      return await deps.parallel(sources);
    } catch (e) {
      console.error("Parallel extract failed; falling back to single call:", e);
    }
  }
  return deps.single(sources);
}

/** Read menu photos and return a structured, bilingual Menu. Dispatches on
 *  EXTRACT_MODE; parallel mode falls back to the single call on any failure. */
export function extractMenu(sources: MenuSource[]): Promise<Menu> {
  return dispatchExtract(sources, config.extract.mode);
}
