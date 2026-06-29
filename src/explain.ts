import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { GlossaryEntry, ExplainRequest } from "./types.js";
import { parseExplainResponse } from "./explain-parse.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = `You write a concise bilingual mini culinary-culture note for each
unfamiliar dish or term, for a curious diner exploring foreign / fine-dining menus.
Tone: a condensed, factual "eat the world, learn the world" guide — interesting,
never padded.

You receive a JSON array of items: { "term": <slug>, "sample_en": <a menu name>,
"sample_zh": <its 中文 name> }. For EACH item return one object with this shape, and
return ONLY a JSON array (no markdown, no commentary):
{
  "term": string,        // echo the input slug exactly
  "display_en": string,  // the canonical English name, e.g. "Linguine al Pesto"
  "display_zh": string,  // the canonical 繁體中文 name
  "explain_en": string,  // see content rules below
  "explain_zh": string,  // the same content, in natural 繁體中文
  "category": string     // "coffee" | "tea" | "dish" | "ingredient" | "technique" | "drink" | "other"
}

Content for explain_en / explain_zh (2-4 sentences, concise — shown in a small popover):
- Briefly explain the NOTABLE terms in the name — each interesting word a curious diner
  would wonder about (for "Linguine al Pesto": what Linguine is, what Pesto is; for
  "Andaman Prawn Aglio Olio": that Andaman is a place, and what Aglio e Olio is).
- For the key foreign word(s), add a ROMANIZED phonetic pronunciation in parentheses —
  an English-readable respelling, e.g. "Bruschetta (broo-SKET-ta)", "Gnocchi (NYOH-kee)".
  NOT IPA. Put the pronunciation in BOTH language fields.
- Mention the origin / culture in one clause when it is genuinely interesting.
- Explain WHY it is translated a certain way ONLY when there is a real etymology or story
  worth telling. Do NOT justify ordinary translations — regional wording varies (e.g.
  芝士 vs 起司 for cheese) and explaining it is noise; just skip it.

Be accurate; never invent specifics you are unsure of. Keep it tight (a popover, not an
essay). Traditional Chinese only for the _zh fields. Valid JSON, no trailing commas.`;

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
