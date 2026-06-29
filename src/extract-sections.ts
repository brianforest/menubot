import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { MenuSource, TagDef } from "./types.js";
import type { SectionTitle } from "./extract-partition.js";
import type { SectionsResult } from "./extract-merge.js";
import { buildContentBlocks } from "./blocks.js";
import { firstJsonObject } from "./extract-json.js";
import { ITEM_RULES } from "./extract-rules.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

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
  const resp = await client.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: 32000,
      system: workerSystem(tags, titles),
      messages: [{ role: "user", content: buildContentBlocks(sources) }],
    })
    .finalMessage();
  if (resp.stop_reason === "max_tokens") {
    throw new Error("Section worker output hit max_tokens; JSON incomplete.");
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseSectionsResult(text);
}
