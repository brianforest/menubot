import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { GlossaryEntry, ExplainRequest } from "./types.js";
import { parseExplainResponse } from "./explain-parse.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = `You explain unfamiliar culinary terms for travellers, concisely and
factually, in BOTH English and Traditional Chinese (繁體中文).

You receive a JSON array of items: { "term": <slug>, "sample_en": <a menu name>,
"sample_zh": <its 中文 name> }. For EACH item return one object with this shape, and
return ONLY a JSON array (no markdown, no commentary):
{
  "term": string,        // echo the input slug exactly
  "display_en": string,  // the canonical English name, e.g. "Flat White"
  "display_zh": string,  // the canonical 繁體中文 name
  "explain_en": string,  // 2-4 sentences: what it is and what makes it distinctive
  "explain_zh": string,  // the same, in natural 繁體中文
  "category": string     // one of: "coffee" | "tea" | "dish" | "ingredient" | "technique" | "drink" | "other"
}

Be accurate and concise; do not invent specifics you are unsure of. Traditional
Chinese only for the _zh fields. Valid JSON, no trailing commas.`;

/** Explain cache-miss terms in one streamed call. Returns [] for empty input
 *  WITHOUT calling the API. */
export async function explainTerms(
  reqs: ExplainRequest[],
): Promise<GlossaryEntry[]> {
  if (!reqs.length) return [];
  const resp = await client.messages
    .stream({
      model: config.anthropic.model,
      // Term-rich menus (e.g. a foreign fine-dining menu) produce many entries;
      // 4000 truncated the JSON array mid-object, losing the whole menu's 💡.
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(reqs) }],
    })
    .finalMessage();
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseExplainResponse(text);
}
