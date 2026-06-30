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

/** Terms per explain call. A term-rich foreign menu can flag ~90 terms; one big
 *  call serialises their generation (~170s) and risks truncating the JSON array.
 *  Smaller batches run in parallel (wall-clock ≈ one batch) and each stays well
 *  under the token ceiling. */
const BATCH_SIZE = 20;

/** Cost/latency guard per mandate: bound a hung explain call, never retry a
 *  billed streaming generation. */
const OPTS = { timeout: 120_000, maxRetries: 0 } as const;

/** One streamed explain call for up to BATCH_SIZE terms. */
async function explainBatch(reqs: ExplainRequest[]): Promise<GlossaryEntry[]> {
  if (!reqs.length) return [];
  const resp = await client.messages
    .stream(
      {
        model: config.anthropic.model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(reqs) }],
      },
      OPTS,
    )
    .finalMessage();
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseExplainResponse(text);
}

/**
 * Explain cache-miss terms. Returns [] for empty input WITHOUT calling the API.
 * For more than `batchSize` terms the work is split into parallel batches; a
 * batch that fails is skipped (its terms simply get no 💡) rather than sinking
 * the whole menu's explanations. `batchFn`/`batchSize` are injectable for tests.
 */
export async function explainTerms(
  reqs: ExplainRequest[],
  batchFn: (reqs: ExplainRequest[]) => Promise<GlossaryEntry[]> = explainBatch,
  batchSize: number = BATCH_SIZE,
): Promise<GlossaryEntry[]> {
  if (!reqs.length) return [];
  if (reqs.length <= batchSize) return batchFn(reqs);

  const batches: ExplainRequest[][] = [];
  for (let i = 0; i < reqs.length; i += batchSize) {
    batches.push(reqs.slice(i, i + batchSize));
  }
  const settled = await Promise.allSettled(batches.map((b) => batchFn(b)));

  const out: GlossaryEntry[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.error(`explain batch ${i} failed (skipped):`, r.reason);
  });
  return out;
}
