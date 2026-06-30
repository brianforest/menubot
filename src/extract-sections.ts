import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { MenuSource, TagDef } from "./types.js";
import type { SectionTitle } from "./extract-partition.js";
import type { SectionsResult } from "./extract-merge.js";
import { buildContentBlocks } from "./blocks.js";
import { firstJsonObject } from "./extract-json.js";
import { ITEM_RULES } from "./extract-rules.js";
import { finalMessageWithDeadline } from "./stream-deadline.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Cost/latency guard: each worker handles a fraction of the menu (max 8 sections).
// 180 s is a generous ceiling; if a worker hangs past this, the call throws and
// the whole Promise.all rejects → dispatcher falls back to the single-call path.
// No retries — a timed-out call × retries would multiply wall-clock unpredictably.
const OPTS = { timeout: 180_000, maxRetries: 0 } as const;

const ITEM_SHAPE = `Each item: {
  "en": string, "zh": string, "p": string, "tags": string[], "xterm": string,
  "options": [ { "en": string, "zh": string, "kind": string,
    "choices": [ { "en": string, "zh": string, "p": string } ] } ],
  "den": string, "dzh": string
}`;

function workerSystem(tags: TagDef[], titles: SectionTitle[]): string {
  return `You are a menu digitisation assistant. You are given ALL pages of one menu
(photos and/or a PDF). Extract FULL items for ONLY the sections listed below — ignore
every other section. Return ONLY a JSON object (no markdown, no commentary):
{ "sections": [ { "en": string, "zh": string, "note": string, "items": [ <item> ] } ],
  "tags": [ { "id": string, "en": string, "zh": string, "icon": string, "group": string } ] }
${ITEM_SHAPE}

SECTIONS TO EXTRACT (use these exact titles, keep this order):
${titles.map((t, i) => `${i + 1}. ${t.en} / ${t.zh}`).join("\n")}

TAG VOCABULARY (reference these ids on items; only add a NEW tag to "tags" if a label
is genuinely absent here, following the id rules below):
${JSON.stringify(tags)}

ACCURATE COUNTING — IMPORTANT (you see only a slice of the menu, so be precise):
- Put each item under EXACTLY ONE section. NEVER list the same item under more than one
  of your assigned sections — e.g. a whisky belongs only in its specific sub-section
  ("Scotch"), never ALSO under a broader group heading.
- A heading that is only a group label for sub-sections carries NO items of its own;
  the items live under the specific sub-sections.
- Comma-separated variants printed together on a SINGLE line (e.g. "Martini Dry, Martini
  Bianco, Martini Rosso") are ONE item — keep them as one entry; do NOT split them.

${ITEM_RULES}`;
}

/** Validate and extract a worker result from the model's text. */
export function parseSectionsResult(text: string): SectionsResult {
  const obj = firstJsonObject(text) as SectionsResult;
  if (!Array.isArray(obj.sections)) {
    throw new Error("Worker returned no sections.");
  }
  return { sections: obj.sections, tags: obj.tags ?? [] };
}

/** Pass 2: extract full items for the assigned sections, seeing all sources. */
export async function extractSections(
  sources: MenuSource[],
  tags: TagDef[],
  titles: SectionTitle[],
): Promise<SectionsResult> {
  const resp = await finalMessageWithDeadline(
    client.messages.stream(
      {
        model: config.anthropic.model,
        max_tokens: 32000,
        system: workerSystem(tags, titles),
        messages: [{ role: "user", content: buildContentBlocks(sources) }],
      },
      OPTS,
    ),
    OPTS.timeout,
    "extract-sections",
  );
  if (resp.stop_reason === "max_tokens") {
    throw new Error("Section worker output hit max_tokens; JSON incomplete.");
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseSectionsResult(text);
}
