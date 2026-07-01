import Anthropic from "@anthropic-ai/sdk";
import type { MenuSource } from "./types.js";

/** Describe the batch to the model, scaling wording to the number of sources. */
function promptText(sources: MenuSource[]): string {
  const imgs = sources.filter((s) => s.kind === "image").length;
  const pdfs = sources.filter((s) => s.kind === "pdf").length;
  // A single PDF is itself multi-page, so anything but exactly one image is "one menu".
  if (sources.length === 1 && imgs === 1) {
    return "Digitise this menu as one JSON object.";
  }
  const parts: string[] = [];
  if (imgs) parts.push(`${imgs} photo(s)`);
  if (pdfs) parts.push(`${pdfs} PDF(s)`);
  return `These ${parts.join(" and ")} are pages of one menu. Digitise the whole thing as one JSON object.`;
}

/**
 * Turn ingestion sources into Anthropic content blocks: every image/PDF block
 * first, then a single instruction text block.
 */
export function buildContentBlocks(
  sources: MenuSource[],
  context?: string,
): Anthropic.ContentBlockParam[] {
  const media: Anthropic.ContentBlockParam[] = sources.map((s) =>
    s.kind === "pdf"
      ? {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: s.bytes.toString("base64"),
          },
        }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: s.mime as Anthropic.Base64ImageSource["media_type"],
            data: s.bytes.toString("base64"),
          },
        },
  );
  const instruction =
    context && context.trim()
      ? `${promptText(sources)}\n\nRestaurant context (may help disambiguate dish names, cuisine, region, and currency): ${context.trim()}`
      : promptText(sources);
  return [...media, { type: "text", text: instruction }];
}
