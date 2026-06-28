import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { ImageDeps } from "./images.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Sonnet 4.6 web tools (dynamic filtering). SDK types may predate the literals; runtime accepts them.
const tools = [
  { type: "web_search_20260209", name: "web_search", max_uses: 2 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 1 },
] as any;

// Hard wall-clock bounds so a slow web-tool loop on an obscure restaurant can't
// hang the publish: short per-request timeout, no retries (a timeout × retries
// would multiply the wall-clock). A timed-out call throws → we return [] / false.
const FIND_OPTS = { timeout: 45_000, maxRetries: 0 } as const;
const VERIFY_OPTS = { timeout: 30_000, maxRetries: 0 } as const;

const FIND_SYSTEM = `You help find a representative photograph of a specific dish at a
specific restaurant. Use web_search and web_fetch to locate a DIRECT image URL (ending
in .jpg/.jpeg/.png/.webp, or an og:image meta URL) that actually shows THIS dish at THIS
restaurant — prefer the official website or a reputable source; avoid stock photos, logos,
and unrelated images.
Return ONLY JSON: {"image_urls": [up to 3 direct image URLs, best first]}.
If you can't find a suitable image, return {"image_urls": []}.`;

/** Find candidate dish image URLs. Returns [] on any failure. */
export const findImage: ImageDeps["findImage"] = async (restaurant, en, zh) => {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Restaurant: ${restaurant}\nDish: ${en} / ${zh}` },
  ];
  try {
    let resp = await client.messages.create(
      { model: config.anthropic.model, max_tokens: 1024, system: FIND_SYSTEM, tools, messages },
      FIND_OPTS,
    );
    let cont = 0;
    while (resp.stop_reason === "pause_turn" && cont < 6) {
      messages.push({ role: "assistant", content: resp.content });
      resp = await client.messages.create(
        { model: config.anthropic.model, max_tokens: 1024, system: FIND_SYSTEM, tools, messages },
        FIND_OPTS,
      );
      cont++;
    }
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return [];
    const arr = (JSON.parse(text.slice(s, e + 1)) as { image_urls?: unknown }).image_urls;
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === "string").slice(0, 3) : [];
  } catch (err) {
    console.error("findImage failed:", err);
    return [];
  }
};

const MAX_BYTES = 2 * 1024 * 1024;
const MIN_BYTES = 3000;

/** Download + validate an image URL. Returns null on any failure/oversize/non-image. */
export const downloadImage: ImageDeps["download"] = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (MenuBot image fetch)" },
      signal: AbortSignal.timeout(15_000), // a hanging image host must not block the publish
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES || bytes.length < MIN_BYTES) return null;
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    return { bytes, ext };
  } catch (err) {
    console.error("downloadImage failed:", err);
    return null;
  }
};

const VERIFY_SYSTEM = `You are verifying whether an image is usable as a menu dish photo.
You are given an image and the dish name. Decide whether the image is a clean, real
photograph of THAT dish — the food itself, well-framed — and NOT any of: a logo or
wordmark, a branded banner or promotional graphic with large text, a menu/screenshot/
document, a collage or grid of multiple images, or a clearly different dish.
Return ONLY JSON: {"ok": true} if it is a good, on-topic dish photo, else {"ok": false}.
When unsure, return {"ok": false}.`;

const MEDIA: Record<string, "image/jpeg" | "image/png" | "image/webp"> = {
  jpg: "image/jpeg", png: "image/png", webp: "image/webp",
};

/** Vision gate. Fail-closed: returns false on any error. */
export const verifyImage: ImageDeps["verify"] = async (bytes, ext, en, zh) => {
  try {
    const media_type = MEDIA[ext] ?? "image/jpeg";
    const resp = await client.messages.create(
      {
        model: config.anthropic.model,
        max_tokens: 200,
        system: VERIFY_SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type, data: bytes.toString("base64") } },
            { type: "text", text: `Dish: ${en} / ${zh}` },
          ],
        }],
      },
      VERIFY_OPTS,
    );
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return false;
    return (JSON.parse(text.slice(s, e + 1)) as { ok?: unknown }).ok === true;
  } catch (err) {
    console.error("verifyImage failed:", err);
    return false;
  }
};
