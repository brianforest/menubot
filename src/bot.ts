import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "./config.js";
import { extractMenu } from "./extract.js";
import { renderMenu, slugify } from "./render.js";
import { publishMenu } from "./publish.js";
import { Glossary } from "./glossary.js";
import { enrichMenu } from "./enrich.js";
import { explainTerms } from "./explain.js";
import { BatchStore, type PendingItem } from "./batch.js";
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

// ── Collecting session ───────────────────────────────────────
// A menu may be many photos (Telegram splits albums at 10) and/or a PDF. We
// buffer everything per chat and process only when the user taps Done — a timer
// can't tell "finished" from "upload stalled", so there is no auto-start. A
// 30-minute idle safety net only frees memory and notifies; it never processes.
const store = new BatchStore();
const glossary = new Glossary(config.glossary.dbPath);
const DONE_DATA = "menu_done";
const IDLE_EXPIRY_MS = 30 * 60 * 1000;
// Telegram Bot API caps file download at 20 MB/file; keep the aggregate here too.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const doneKeyboard = new InlineKeyboard().text("✅ 完成並產生菜單 / Done", DONE_DATA);

const COLLECT_MSG =
  "📸 收到。整本菜單可多張照片／PDF 一次傳給我，全部傳完後請按【✅ 完成並產生菜單】。\n" +
  "Send all the pages (photos and/or a PDF); tap ✅ Done when you've finished.";
const EXPIRY_MSG =
  "📭 這批等待過久已自動清空，請重新傳整本菜單。\n" +
  "This session expired after a long pause — please resend the menu.";

async function onNewMedia(ctx: Context, item: PendingItem): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const { isNew } = store.add(chatId, item, Date.now());
  if (isNew) await ctx.reply(COLLECT_MSG, { reply_markup: doneKeyboard });
}

bot.on("message:photo", async (ctx) => {
  // Largest available size is the last entry.
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  await onNewMedia(ctx, { fileId: photo.file_id, kind: "image", mime: "image/jpeg" });
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const isPdf =
    doc.mime_type === "application/pdf" ||
    (doc.file_name?.toLowerCase().endsWith(".pdf") ?? false);
  if (!isPdf) {
    await ctx.reply(
      "⚠️ 目前只接受菜單照片或 PDF 檔。\nOnly menu photos or a PDF file are accepted.",
    );
    return;
  }
  await onNewMedia(ctx, { fileId: doc.file_id, kind: "pdf", mime: "application/pdf" });
});

bot.callbackQuery(DONE_DATA, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const items = store.take(chatId);
  if (!items || items.length === 0) {
    await ctx.reply(
      "還沒收到任何菜單照片或 PDF，請先傳給我。\n" +
        "No menu received yet — send photos or a PDF first.",
    );
    return;
  }
  void processBatch(ctx, items);
});

async function processBatch(ctx: Context, items: PendingItem[]): Promise<void> {
  try {
    const results = await Promise.allSettled(
      items.map(async (it) => ({
        kind: it.kind,
        mime: it.mime,
        bytes: await downloadFile(it.fileId),
      })),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      // Don't publish a partial menu — that's exactly the incomplete-menu
      // outcome this feature exists to prevent. Abort and ask for a resend.
      console.error(
        "processBatch download failures:",
        failed.map((r) => (r as PromiseRejectedResult).reason),
      );
      await ctx.reply(
        `⚠️ 有 ${failed.length} 個檔案下載失敗（可能檔案過大或網路問題），為避免產生不完整的菜單，請重新傳整本菜單。\n` +
          `${failed.length} file(s) couldn't be downloaded (too large, or a network issue). ` +
          `To avoid an incomplete menu, please resend the whole menu.`,
      );
      return;
    }

    const sources: MenuSource[] = results.map(
      (r) => (r as PromiseFulfilledResult<MenuSource>).value,
    );

    const total = sources.reduce((n, s) => n + s.bytes.length, 0);
    if (total > MAX_TOTAL_BYTES) {
      await ctx.reply(
        "⚠️ 檔案總量過大，請分批傳較少頁數，或壓縮 PDF。\n" +
          "Files are too large in total — send fewer pages or compress the PDF.",
      );
      return;
    }

    await ctx.reply(
      `🧠 正在辨識與翻譯 ${sources.length} 個檔案… Digitising ${sources.length} file(s)…`,
    );
    const menu = await extractMenu(sources);

    try {
      await enrichMenu(menu, glossary, explainTerms, new Date().toISOString());
    } catch (e) {
      console.error("enrichMenu failed (publishing without explanations):", e);
    }

    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);
    const html = renderMenu(menu);

    await ctx.reply("🌐 正在發佈網頁… Publishing…");
    const { url } = await publishMenu(slug, html);

    const count = menu.sections.reduce((n, s) => n + (s.items?.length || 0), 0);
    await ctx.reply(
      `✅ 完成！${menu.sections.length} 個分類、${count} 道餐點。\n` +
        `Done! Tap to view & share:\n${url}\n\n` +
        `（GitHub Pages 首次發佈可能需 1–2 分鐘生效）`,
      { link_preview_options: { is_disabled: false } },
    );
  } catch (err) {
    console.error("processBatch failed:", err);
    await ctx.reply(
      "⚠️ 處理失敗 Something went wrong:\n" +
        (err instanceof Error ? err.message : String(err)) +
        "\n請重試或換更清晰的檔案。Please retry with clearer files.",
    );
  }
}

/** Download any Telegram file by file_id and return its bytes. */
async function downloadFile(fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path.");
  const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Idle safety net: free abandoned batches and notify; never auto-process.
setInterval(() => {
  const expired = store.expireStale(Date.now(), IDLE_EXPIRY_MS);
  for (const chatId of expired) {
    void bot.api.sendMessage(chatId, EXPIRY_MSG).catch(() => {});
  }
}, 60_000);

// ── Commands ────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "👋 歡迎使用 MenuBot！\n\n" +
      "把餐廳菜單拍照（可一次多張／整本）或直接傳 PDF 給我，全部傳完後按【✅ 完成並產生菜單】，我會自動：\n" +
      "1️⃣ 讀取每道餐點\n2️⃣ 翻成英中對照\n3️⃣ 產生手機版菜單網頁，回傳分享連結。\n\n" +
      "Send menu photos (many at once) or a PDF, then tap ✅ Done — I'll turn it into a shareable bilingual web page.",
  ),
);
bot.command("help", (ctx) =>
  ctx.reply(
    "傳菜單照片（可多張）或 PDF，傳完按【✅ 完成並產生菜單】即可。\n" +
      "Send menu photos (one or many) or a PDF, then tap ✅ Done.",
  ),
);

bot.catch((err) => console.error("Bot error:", err.error));
