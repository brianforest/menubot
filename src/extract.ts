import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Menu, MenuSource } from "./types.js";
import { buildContentBlocks } from "./blocks.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = `You are a menu digitisation assistant. You are given one or more
photos and/or a PDF of a single menu or list — restaurant food, spa treatments,
services, etc. Read every section and every item, then return a STRICT JSON object
describing the whole thing in English with a Traditional-Chinese (繁體中文)
translation.

Output schema (return ONLY this JSON, no markdown, no commentary):
{
  "restaurant": { "en": string, "zh": string },   // best guess; "" if unknown
  "currency": string,                                // e.g. "SGD"; "" if unknown
  "kind": string,                                    // "food" | "spa" | "service" | "other"; "" if unsure
  "tags": [                                          // the classification labels THIS menu uses
    { "id": string, "en": string, "zh": string, "icon": string, "group": string }
  ],
  "sections": [
    {
      "en": string,                                  // section title in English
      "zh": string,                                  // section title in 繁體中文
      "note": string,                                // optional footnote, else ""
      "items": [
        {
          "en": string,                              // item name as printed
          "zh": string,                              // 繁體中文 name (natural culinary wording)
          "p": string,                               // price exactly as printed; "" if none
          "tags": string[],                          // ids of the tags above this item carries; [] if none
          "xterm": string,                           // see "Explanations" below; "" if not needed
          "options": [                               // see "Option groups" below; omit or [] if none
            { "en": string, "zh": string, "kind": string,
              "choices": [ { "en": string, "zh": string, "p": string } ] }
          ],
          "den": string,                             // English description if present, else ""
          "dzh": string                              // 繁體中文 translation of the description, else ""
        }
      ]
    }
  ]
}

Tags — IMPORTANT:
- A menu uses its own vocabulary of labels. Capture EVERY distinct classification
  label the menu actually uses (dietary marks, allergen warnings, "Highlight",
  "Chef's", "招牌", etc.) as an entry in "tags", then reference them per item by id.
- Use these well-known ids and icons when the concept matches (do not invent new
  ids for these):
    vegetarian 🌱 | vegan 🌱 | spicy 🌶️ | pork 🐷 | chicken 🐔 | seafood 🐟 |
    beef 🐮 | gluten-free 🌾 | contains-nuts 🥜 | dairy 🥛 | signature ⭐
- Map any "Highlight / Chef's recommendation / 招牌 / Recommended / 推薦" marker to
  the "signature" tag (icon ⭐, group "highlight").
- For a menu-specific label not in the list above, mint a stable lowercase-slug
  "id" (e.g. "contains-shellfish"), give bilingual "en"/"zh", set a fitting emoji
  "icon" (or "" if none fits), and a "group" of "diet" | "allergen" | "protein"
  | "highlight" | "other".
- Only include a tag in "tags" if at least one item carries it.
- NEVER emit a "popular" tag — that is reserved and populated elsewhere.

Explanations (xterm) — IMPORTANT:
- Set "xterm" to a lowercase-hyphen slug of an item's canonical name ONLY when a
  typical international diner likely wouldn't recognise it: regional/cultural
  specialties (e.g. "laksa", "char-kway-teow"), specialty coffee/tea (e.g.
  "flat-white", "yuanyang"), or uncommon ingredients/techniques (e.g. "confit",
  "sous-vide"). Use the canonical concept's slug, not the exact printed name
  (e.g. an "Iced Flat White" → "flat-white").
- Do NOT set xterm for common, globally-known items (fried rice, caesar salad,
  latte, coke). When in doubt, leave it "".
- Do NOT write the explanation here — only the slug.

Option groups (options) — IMPORTANT:
- When an item lets the diner configure it — choose a broth/noodle/size, add
  toppings, or has included components listed as sub-bullets — capture each as an
  option group: a bilingual label ("en"/"zh"), a "kind", and bilingual "choices".
- "kind" is one of:
    "one"  — pick exactly one (cues: "choose", "可選", "任選一")
    "list" — included components, simply listed (no choice to make)
    "any"  — optional paid add-ons (cues: "add …", "加 …"); put the add-on's extra
             price in that choice's "p", else "".
- Do NOT also duplicate the option structure into "den"/"dzh"; keep those for genuine
  prose description only. Omit "options" (or use []) when the item is not configurable.

Other rules:
- Capture EVERY item and section; do not summarise or skip.
- Keep prices as strings exactly as printed (no currency symbol unless printed).
- Traditional Chinese only (繁體中文), using natural Hong Kong / Taiwan culinary
  terms. Translate descriptions faithfully but concisely.
- Preserve the original section order as it reads on the menu.
- If a field is unknown, use "" (or [] for "tags"); never invent prices.
- Return valid JSON parseable by JSON.parse. No trailing commas.

Example "tags" + item (illustrative):
  "tags": [
    { "id": "vegetarian", "en": "Vegetarian", "zh": "適合素食", "icon": "🌱", "group": "diet" },
    { "id": "gluten-free", "en": "Gluten Free", "zh": "無麩質", "icon": "🌾", "group": "diet" },
    { "id": "contains-nuts", "en": "Contains Nuts", "zh": "含堅果", "icon": "🥜", "group": "allergen" },
    { "id": "signature", "en": "Signature", "zh": "招牌", "icon": "⭐", "group": "highlight" }
  ],
  ... an item: { "en": "Pesto Pasta", "zh": "青醬義大利麵", "p": "22", "tags": ["vegetarian","contains-nuts","signature"], "den": "", "dzh": "" }`;

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
 * Read menu photos and return a structured, bilingual Menu.
 * @param sources Menu sources (images and/or PDFs).
 */
export async function extractMenu(sources: MenuSource[]): Promise<Menu> {
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
