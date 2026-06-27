import { Bot, type Context } from "grammy";
import { config } from "./config.js";
import { extractMenu } from "./extract.js";
import { renderMenu, slugify } from "./render.js";
import { publishMenu } from "./publish.js";
import type { MenuSource } from "./types.js";

export const bot = new Bot(config.telegram.token);

// ── Access control ──────────────────────────────────────────
const allowed = new Set(config.telegram.allowedUserIds);
bot.use(async (ctx, next) => {
  if (allowed.size > 0) {
    const id = ctx.from?.id;
    if (!id || !allowed.has(id)) {
      await ctx.reply("Sorry, this bot is private. 此機器人為私人使用。");
      return;
    }
  }
  await next();
});

// ── Photo batching ──────────────────────────────────────────
// A menu is often several photos sent together as an album (one media group),
// or a few separate photos sent in quick succession. We buffer incoming photos
// per chat and flush after a short quiet period, then process them as one menu.
const FLUSH_MS = 2500;

interface Batch {
  fileIds: string[];
  timer: ReturnType<typeof setTimeout>;
  notified: boolean;
}
const batches = new Map<number, Batch>();

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  // Largest available size is the last entry.
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;

  let batch = batches.get(chatId);
  if (!batch) {
    batch = { fileIds: [], timer: setTimeout(() => {}, 0), notified: false };
    batches.set(chatId, batch);
  }
  batch.fileIds.push(photo.file_id);

  if (!batch.notified) {
    batch.notified = true;
    await ctx.reply("📸 收到，正在讀取菜單… Reading your menu…");
  }

  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    batches.delete(chatId);
    void processBatch(ctx, batch!.fileIds);
  }, FLUSH_MS);
});

async function processBatch(ctx: Context, fileIds: string[]): Promise<void> {
  try {
    const sources = await Promise.all(fileIds.map((id) => downloadPhoto(id)));

    await ctx.reply(
      `🧠 正在辨識與翻譯 ${sources.length} 張相片… Digitising ${sources.length} photo(s)…`,
    );
    const menu = await extractMenu(sources);

    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);
    const html = renderMenu(menu);

    await ctx.reply("🌐 正在發佈網頁… Publishing…");
    const { url } = await publishMenu(slug, html);

    const items = menu.sections.reduce((n, s) => n + (s.items?.length || 0), 0);
    await ctx.reply(
      `✅ 完成！${menu.sections.length} 個分類、${items} 道餐點。\n` +
        `Done! Tap to view & share:\n${url}\n\n` +
        `（GitHub Pages 首次發佈可能需 1–2 分鐘生效）`,
      { link_preview_options: { is_disabled: false } },
    );
  } catch (err) {
    console.error("processBatch failed:", err);
    await ctx.reply(
      "⚠️ 處理失敗 Something went wrong:\n" +
        (err instanceof Error ? err.message : String(err)) +
        "\n請重試或換一張更清晰的相片。Please retry with a clearer photo.",
    );
  }
}

/** Download a Telegram photo by file_id and return its bytes. */
async function downloadPhoto(fileId: string): Promise<MenuSource> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path.");
  const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download photo: ${res.status}`);
  return {
    kind: "image",
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: "image/jpeg",
  };
}

// ── Commands ────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "👋 歡迎使用 MenuBot！\n\n" +
      "把餐廳菜單拍照（可一次多張／整本）傳給我，我會自動：\n" +
      "1️⃣ 讀取每道餐點\n2️⃣ 翻成英中對照\n3️⃣ 產生手機版菜單網頁，回傳分享連結。\n\n" +
      "Send me photos of a menu and I'll turn it into a shareable bilingual web page.",
  ),
);
bot.command("help", (ctx) =>
  ctx.reply("直接把菜單照片傳給我即可。Just send menu photos — one or many at once."),
);

bot.catch((err) => console.error("Bot error:", err.error));
