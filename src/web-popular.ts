import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { FindPopular } from "./popular.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = `You are a menu-enrichment assistant. Use web_search to find which
dishes a specific restaurant is most famous for / most recommended (its signature
and popular items). Then, from the provided numbered menu item list, decide which
items are clearly among that restaurant's popular/signature dishes.

Return ONLY JSON: {"popular": [the integer "i" values of the popular items]}.
Be conservative — include an item only with real evidence of being signature or
popular. If you cannot confidently identify the restaurant, return {"popular": []}.`;

// web_search server-tool variant for Sonnet 4.6 (dynamic filtering). The SDK
// types may predate this literal; the runtime accepts it — hence the `as any`.
const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] as any;

// Cost/time guard: short per-request timeout + no retries so a long web_search
// loop on an obscure restaurant can't burn credits or hang (a timeout → []).
const OPTS = { timeout: 45_000, maxRetries: 0 } as const;

/** Find a restaurant's popular items via web search. Returns [] on any failure. */
export const findPopular: FindPopular = async (restaurant, location, items) => {
  const where = location ? ` (${location})` : "";
  const list = items.map((it) => `${it.i}. ${it.en} / ${it.zh}`).join("\n");
  const user = `Restaurant: ${restaurant}${where}\nMenu items:\n${list}`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
  try {
    let resp = await client.messages.create(
      { model: config.anthropic.model, max_tokens: 2000, system: SYSTEM, tools, messages },
      OPTS,
    );
    // web_search runs a server-side loop; pause_turn means "resume" — re-send.
    let cont = 0;
    while (resp.stop_reason === "pause_turn" && cont < 6) {
      messages.push({ role: "assistant", content: resp.content });
      resp = await client.messages.create(
        { model: config.anthropic.model, max_tokens: 2000, system: SYSTEM, tools, messages },
        OPTS,
      );
      cont++;
    }
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return [];
    const obj = JSON.parse(text.slice(s, e + 1));
    const arr = (obj as { popular?: unknown }).popular;
    return Array.isArray(arr) ? arr.filter((n): n is number => Number.isInteger(n)) : [];
  } catch (err) {
    console.error("findPopular failed:", err);
    return [];
  }
};
