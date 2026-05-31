import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Menu } from "./types.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = `You are a menu digitisation assistant. You are given one or more
photos of a single restaurant's menu (possibly several pages/sides). Read every
section and every item, then return a STRICT JSON object describing the whole
menu in English with a Traditional-Chinese (繁體中文) translation.

Output schema (return ONLY this JSON, no markdown, no commentary):
{
  "restaurant": { "en": string, "zh": string },   // best guess; "" if unknown
  "currency": string,                                // e.g. "SGD"; "" if unknown
  "sections": [
    {
      "en": string,                                  // section title in English
      "zh": string,                                  // section title in 繁體中文
      "note": string,                                // optional footnote, else ""
      "items": [
        {
          "en": string,                              // item name as printed
          "zh": string,                              // 繁體中文 name (natural culinary wording)
          "p": string,                               // price exactly as printed, e.g. "18", "8 / 9"; "" if none
          "t": string[],                             // any of: "spicy","veg","pork","chicken","seafood","beef"
          "den": string,                             // English description if present, else ""
          "dzh": string                              // 繁體中文 translation of the description, else ""
        }
      ]
    }
  ]
}

Rules:
- Capture EVERY item and section; do not summarise or skip.
- Keep prices as strings exactly as printed (no currency symbol unless printed).
- Map the menu's legend icons (spicy / vegetarian / pork / chicken / seafood /
  beef) to the "t" array. If an item has no icon, use [].
- Traditional Chinese only (繁體中文), using natural Hong Kong / Taiwan culinary
  terms. Translate descriptions faithfully but concisely.
- Preserve the original section order as it reads on the menu.
- If a field is unknown, use "" (or [] for "t"); never invent prices.
- Return valid JSON parseable by JSON.parse. No trailing commas.`;

/** Build an Anthropic image content block from raw bytes. */
function imageBlock(bytes: Buffer): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: bytes.toString("base64"),
    },
  };
}

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
 * @param images JPEG buffers, one per menu photo/page.
 */
export async function extractMenu(images: Buffer[]): Promise<Menu> {
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...images.map(imageBlock),
          {
            type: "text",
            text:
              images.length > 1
                ? `These ${images.length} photos are pages of one menu. Digitise the whole thing as one JSON object.`
                : "Digitise this menu as one JSON object.",
          },
        ],
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const menu = parseJson(text);
  if (!menu.sections?.length) {
    throw new Error("No menu sections were detected in the photos.");
  }
  return menu;
}
