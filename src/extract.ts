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
    .stream({
      model: config.anthropic.model,
      max_tokens: 32000,
      system: SYSTEM,
      messages: [{ role: "user", content: buildContentBlocks(sources) }],
    })
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
 * outline is empty or any worker fails, so the dispatcher can fall back.
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
  return mergeExtract(outline, results);
}

/** Read menu photos and return a structured, bilingual Menu. Dispatches on
 *  EXTRACT_MODE; parallel mode falls back to the single call on any failure. */
export async function extractMenu(sources: MenuSource[]): Promise<Menu> {
  if (config.extract.mode === "parallel") {
    try {
      return await extractMenuParallel(sources);
    } catch (e) {
      console.error("Parallel extract failed; falling back to single call:", e);
    }
  }
  return extractMenuSingle(sources);
}
