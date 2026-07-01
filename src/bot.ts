import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config } from "./config.js";
import { buildContext } from "./context.js";
import { extractMenu } from "./extract.js";
import { renderMenu, slugify } from "./render.js";
import { publishMenu, publishImage, waitUntilLive } from "./publish.js";
import { saveOriginals, readOriginals, listSlugs, parseSlug } from "./archive.js";
import { addImages } from "./images.js";
import { findImage, downloadImage, verifyImage } from "./web-image.js";
import { Glossary } from "./glossary.js";
import { enrichMenu } from "./enrich.js";
import { normalizeMenu } from "./regional.js";
import { explainTerms, EXPLAIN_VERSION } from "./explain.js";
import { BatchStore, type PendingItem } from "./batch.js";
import type { MenuSource } from "./types.js";
import { tagPopular } from "./popular.js";
import { findPopular } from "./web-popular.js";
import { tagNotable } from "./notable.js";
import { Timer } from "./timing.js";

/** Count items carrying an explanation slug — the explain workload driver. */
function countXterms(menu: { sections: { items?: { xterm?: string }[] }[] }): number {
  let n = 0;
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) if ((it.xterm ?? "").trim()) n++;
  }
  return n;
}

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
let glossary: Glossary | null = null;
try {
  glossary = new Glossary(config.glossary.dbPath);
} catch (e) {
  console.error("Glossary init failed (running without explanations):", e);
}
const DONE_DATA = "menu_done";
const IDLE_EXPIRY_MS = 30 * 60 * 1000;
// Telegram Bot API caps file download at 20 MB/file; keep the aggregate here too.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const doneKeyboard = new InlineKeyboard().text("✅ 完成並產生菜單 / Done", DONE_DATA);

const COLLECT_MSG =
  "📸 收到。整本菜單可多張照片／PDF 一次傳給我，全部傳完後請按【✅ 完成並產生菜單】。\n" +
  "（強烈建議）貼上這家餐廳的 Google 地圖連結，我會據此判斷菜系、地區與幣別，辨識最準；\n" +
  "若不方便，至少用一則文字告訴我店名。\n" +
  "Send all pages (photos and/or a PDF). Best results: paste the restaurant's Google Maps " +
  "link (or at least type its name). Tap ✅ Done when finished.";
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
  const taken = store.take(chatId);
  if (!taken || taken.items.length === 0) {
    await ctx.reply(
      "還沒收到任何菜單照片或 PDF，請先傳給我。\n" +
        "No menu received yet — send photos or a PDF first.",
    );
    return;
  }
  void processBatch(ctx, taken.items, taken.hint);
});

async function processBatch(
  ctx: Context,
  items: PendingItem[],
  hint?: string,
): Promise<void> {
  const timer = new Timer();
  try {
    const results = await timer.time("download", () =>
      Promise.allSettled(
        items.map(async (it) => ({
          kind: it.kind,
          mime: it.mime,
          bytes: await downloadFile(it.fileId),
        })),
      ),
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
      `🧠 正在辨識與翻譯 ${sources.length} 個檔案，通常需 3–5 分鐘，請稍候…\n` +
        `Digitising ${sources.length} file(s) — usually 3–5 min…`,
    );
    // Restaurant/region context from the hint (typed text + resolved map link) —
    // best-effort, never blocks extraction.
    const context = await buildContext(hint).catch(() => null);
    const menu = await timer.time("extract", () =>
      extractMenu(sources, {
        context: context ?? undefined,
        onRoute: (route, complex) => {
          if (route === "single" && complex === true) {
            void ctx
              .reply(
                "🕐 此菜單版面較複雜（密集價格表），為確保價格正確改用完整辨識，約需 3–4 分鐘，請稍候。\n" +
                  "This menu has a complex layout — using full recognition for price accuracy (~3–4 min).",
              )
              .catch(() => {});
          }
        },
      }),
    );

    // Mid-flight progress: real per-menu counts so the long enrich wait shows life.
    // Best-effort — never blocks the pipeline.
    const xtermCount = countXterms(menu);
    const dishCount = menu.sections.reduce((n, s) => n + (s.items?.length || 0), 0);
    const progressTail =
      glossary && xtermCount > 0 ? "正在補充解釋…" : "整理與發佈中…";
    void ctx
      .reply(
        `✅ 製作完成：${menu.sections.length} 個分類、${dishCount} 道餐點、${xtermCount} 個特色詞，${progressTail}\n` +
          `Menu built: ${menu.sections.length} sections, ${dishCount} items, ${xtermCount} highlights…`,
      )
      .catch(() => {});

    if (glossary) {
      await timer.time("enrich", async () => {
        try {
          await enrichMenu(menu, glossary!, explainTerms, new Date().toISOString(), EXPLAIN_VERSION);
        } catch (e) {
          console.error("enrichMenu failed (publishing without explanations):", e);
        }
      });
    }

    tagNotable(menu);

    // Web enrichment (popularity 🔥 + dish images) is opt-in: it only pays off
    // for well-known restaurants and yields ~nothing on obscure venues. OFF
    // unless WEB_ENRICH=on.
    const name = menu.restaurant?.en || menu.restaurant?.zh || "menu";
    const slug = slugify(name);

    if (config.web.enabled) {
      try {
        await tagPopular(menu, findPopular, hint);
      } catch (e) {
        console.error("popularity tagging failed (publishing without 🔥):", e);
      }

      await ctx.reply("🖼️ 正在找菜品圖… Finding dish photos…");
      try {
        await addImages(
          menu,
          hint,
          slug,
          { findImage, download: downloadImage, verify: verifyImage, commit: publishImage },
          2,
          Date.now() + 90_000, // overall budget: image finding is slow + best-effort
        );
      } catch (e) {
        console.error("dish images failed (publishing without photos):", e);
      }
    }

    // Deterministic regional→Taiwan wording normalization (zero API). Runs after
    // enrich so glossary-injected explanations are normalized too; before render.
    if (config.region.enabled && glossary) {
      normalizeMenu(menu, glossary.getRegionalMap());
    }

    const html = renderMenu(menu);

    // Archive the originals (filesystem, instant) — best-effort, never blocks publish.
    try {
      saveOriginals(config.archive.dir, slug, sources);
    } catch (e) {
      console.error("archive save failed:", e);
    }

    await ctx.reply("🌐 發佈中，確認連結生效… Publishing…");
    const { url } = await timer.time("publish", () => publishMenu(slug, html));
    // Block until the page is actually live so the link we reveal never 404s.
    // (The non-blocking variant saved ~20s but let early taps hit a transient
    // 404 until GitHub Pages built — not worth it for a shareable link.)
    const live = await timer.time("waitLive", () => waitUntilLive(url));

    const count = menu.sections.reduce((n, s) => n + (s.items?.length || 0), 0);
    await ctx.reply(
      `✅ 完成！${menu.sections.length} 個分類、${count} 道餐點。\n` +
        `Done! Tap to view & share:\n${url}` +
        (live ? "" : "\n\n（GitHub Pages 首次發佈可能需 1–2 分鐘生效）"),
      { link_preview_options: { is_disabled: false } },
    );

    const stats =
      `files=${sources.length} sections=${menu.sections.length} ` +
      `items=${count} xterms=${countXterms(menu)}`;
    console.log(
      `[timing] ${timer.format()} | total ${(timer.total() / 1000).toFixed(1)}s | ${stats}`,
    );
    if (config.debug.timing) {
      await ctx.reply(
        `⏱️ ${timer.format()}\ntotal ${(timer.total() / 1000).toFixed(0)}s · ${stats}`,
      );
    }
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

// Hidden archive retrieval (not in setMyCommands). Returns a menu's original
// uploads by published URL or slug. Private via the allow-list middleware.
// Registered before message:text so the text handler can't swallow "/vault …".
bot.command("vault", async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    const slugs = listSlugs(config.archive.dir, 10);
    await ctx.reply(
      slugs.length
        ? "🗄️ 最近封存：\n" +
            slugs.map((s) => `• ${s}`).join("\n") +
            "\n\n用 /vault <slug> 或貼發佈網址調閱原始檔。"
        : "目前沒有封存的菜單。",
    );
    return;
  }
  const slug = parseSlug(arg);
  if (!slug) {
    await ctx.reply("認不出 slug。請貼發佈網址（…/m/<slug>/）或直接給 slug。");
    return;
  }
  const files = readOriginals(config.archive.dir, slug);
  if (!files.length) {
    await ctx.reply(`找不到「${slug}」的原始檔（可能是此功能上線前發佈的）。`);
    return;
  }
  await ctx.reply(`📂 ${slug} 的原始檔（${files.length} 個）`);
  for (const f of files) {
    await ctx.replyWithDocument(new InputFile(f.bytes, f.name));
  }
});

// Optional restaurant/location hint typed during a collecting session.
// Registered after the command handlers so /start and /help reach theirs first.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text?.trim();
  const chatId = ctx.chat?.id;
  if (!text || text.startsWith("/") || chatId == null) return;
  if (store.setHint(chatId, text, Date.now())) {
    await ctx.reply(
      "📝 已記下，會用來提升辨識準確度。\nNoted — I'll use this to improve results.",
    );
  }
});

bot.catch((err) => console.error("Bot error:", err.error));
