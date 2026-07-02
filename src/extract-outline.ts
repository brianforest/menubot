import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { MenuSource } from "./types.js";
import type { Outline } from "./extract-merge.js";
import { buildContentBlocks } from "./blocks.js";
import { firstJsonObject } from "./extract-json.js";
import { finalMessageWithDeadline } from "./stream-deadline.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Cost/latency guard: outline is small/fast (< 4k output), so 60 s is generous.
// No retries — a hung outline call throws immediately into the dispatcher fallback.
const OPTS = { timeout: 60_000, maxRetries: 0 } as const;

export const OUTLINE_SYSTEM = `You are a menu digitisation assistant. You are given
one or more photos and/or a PDF of a single menu. Read the WHOLE thing, then return a
STRICT JSON object describing only the menu's GLOBAL metadata and its SECTION SPINE —
NOT the individual items. Return ONLY this JSON (no markdown, no commentary):
{
  "restaurant": { "en": string, "zh": string },   // full official name; if a restaurant context is given in the prompt, use its full official name (do NOT shorten to a logo/sign title printed on the menu, e.g. use "Planter's at The Danna Langkawi" not just "Planter's"); else best guess; "" if unknown
  "currency": string,                                // e.g. "SGD"; "" if unknown
  "kind": string,                                    // "food" | "spa" | "service" | "other"; "" if unsure
  "tags": [                                          // every distinct classification label the menu uses
    { "id": string, "en": string, "zh": string, "icon": string, "group": string }
  ],
  "sections": [ { "en": string, "zh": string } ],    // EVERY section title, in reading order; titles only
  "complex": boolean                                  // see the complexity rule below
}
Rules:
- List EVERY section/heading in the exact order it reads across all pages. Titles only —
  do NOT include items. A section continued on a later page is ONE section (list it once).
- Keep each printed heading EXACTLY as printed, including any "Group – Subtype" prefix:
  "Whiskey Collections – Scotch" and "Whiskey Collections – Bourbon" are TWO separate
  sections, each listed with its full heading. Do NOT invent a separate parent section
  from a shared prefix (no bare "Whiskey Collections" section on its own), and do NOT
  split one printed heading into a parent + a child.
- Capture the full tag vocabulary the menu uses (dietary marks, allergen warnings,
  "Highlight"/"Chef's"/"招牌"/"Recommended"). Use these well-known ids + icons when the
  concept matches: vegetarian 🌱 | vegan 🌱 | spicy 🌶️ | pork 🐷 | chicken 🐔 |
  seafood 🐟 | beef 🐮 | gluten-free 🌾 | contains-nuts 🥜 | dairy 🥛 | signature ⭐.
  Map any "Highlight/Chef's/招牌/Recommended/推薦" marker to "signature" (icon ⭐,
  group "highlight"). For a menu-specific label, mint a stable lowercase-slug id with a
  group of "diet"|"allergen"|"protein"|"highlight"|"other". NEVER emit a "popular" tag.
- Traditional Chinese (繁體中文) for all _zh fields, using natural TAIWAN (台灣)
  wording (e.g. 沙拉 not 沙律, 起司 not 芝士) — not Hong Kong / Cantonese terms.
- Set "complex": true if ANY part of the menu uses a layout where item-to-price
  alignment is visually ambiguous — a price column detached or vertically offset from
  its item rows, a multi-column price grid (e.g. glass/bottle), or nested category
  tables (spirits lists such as COGNAC/ARMAGNAC/GIN sub-blocks under a floating price
  column). Set "complex": false ONLY if every section is a simple linear list where
  each item's price (if any) sits directly beside or below its own name. When in
  doubt, prefer true.
  Valid JSON, no trailing commas.`;

/** Validate and extract an Outline from the model's text. */
export function parseOutline(text: string): Outline {
  const obj = firstJsonObject(text) as Outline;
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    throw new Error("Outline has no sections.");
  }
  return obj;
}

/** Pass 1: read all sources and return global metadata + the section spine. */
export async function outlineMenu(sources: MenuSource[], context?: string): Promise<Outline> {
  const resp = await finalMessageWithDeadline(
    client.messages.stream(
      {
        model: config.anthropic.model,
        // [sonnet5-eval] test-only headroom for the +30% tokenizer.
        max_tokens: 6000,
        // [sonnet5-eval] disable Sonnet 5's default adaptive thinking.
        thinking: { type: "disabled" },
        system: OUTLINE_SYSTEM,
        messages: [{ role: "user", content: buildContentBlocks(sources, context) }],
      },
      OPTS,
    ),
    OPTS.timeout,
    "extract-outline",
  );
  if (resp.stop_reason === "max_tokens") {
    throw new Error("Outline output hit max_tokens; section list incomplete.");
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseOutline(text);
}
