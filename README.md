# 🍽️ MenuBot

A Telegram bot that turns **photos of a restaurant menu** into a **mobile-first,
bilingual (English / 繁體中文) web page** published on **GitHub Pages** — and
replies with a shareable link, perfect for sending to family & friends.

```
 photo(s) / PDF → Telegram → [tap Done] → Claude (read + translate) → HTML → GitHub Pages → link
```

## How it works

1. You send a whole menu as any number of photos and/or a PDF, then tap the
   **✅ Done** button so the bot knows the upload is complete.
2. Photos/PDF are read by a Claude vision model, which extracts every section &
   item, translates them to Traditional Chinese (names, descriptions, prices),
   and tags each item with the menu's own classification labels (dietary,
   allergen, "Highlight"/signature, …). Works for non-food menus too (e.g. spa).
   Items a traveller might not recognise (e.g. Flat White, Laksa) get a short
   bilingual explanation behind a 💡, cached in a local glossary so each term is
   explained at most once.
3. The structured menu is rendered into a self-contained HTML page (language
   toggle 雙語/中文/EN, category jump-nav, a dynamic tag filter bar with
   multi-select AND filtering, share preview cards).
4. The page is committed to this repo under `docs/m/<slug>/index.html` and
   served by GitHub Pages. The bot replies with the public URL.

## Stack

- Node.js 20+, TypeScript (ESM)
- [`grammy`](https://grammy.dev) — Telegram bot framework
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) — Claude vision + translation
- GitHub Contents API — publishing to Pages (no extra deps)

## Project layout

```
src/
  index.ts     entry — starts the bot
  bot.ts       Telegram handlers + photo batching
  extract.ts   Claude vision → structured bilingual menu JSON
  render.ts    menu JSON → HTML (fills templates/menu.html)
  publish.ts   commit HTML to the repo via GitHub API
  config.ts    env config + validation
  types.ts     Menu types
templates/
  menu.html    the mobile menu page template
docs/
  index.html   landing page served at the Pages root
```

## Setup

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) → `/newbot`
   → copy the token.
2. **GitHub token**: create a *fine-grained PAT* with **Contents: Read and
   write** on this repo.
3. **Enable Pages**: repo **Settings → Pages → Deploy from a branch →
   `main` / `/docs`**.
4. Configure env:

   ```bash
   cp .env.example .env
   # fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN,
   # GITHUB_OWNER, GITHUB_REPO
   ```

5. Install & run:

   ```bash
   npm install        # or pnpm install
   npm run dev        # local (long-polling)
   # production:
   npm run build && npm start
   ```

6. In Telegram, open your bot, send `/start`, then send menu photos.

## Configuration

| Env | Required | Default | Notes |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | from @BotFather |
| `ANTHROPIC_API_KEY` | ✅ | — | Claude API key |
| `ANTHROPIC_MODEL` | | `claude-sonnet-4-6` | vision-capable model |
| `GITHUB_TOKEN` | ✅ | — | PAT, Contents: write |
| `GITHUB_OWNER` | ✅ | — | repo owner |
| `GITHUB_REPO` | ✅ | — | repo to publish into |
| `GITHUB_BRANCH` | | `main` | branch to commit to |
| `PAGES_DIR` | | `docs` | Pages source folder |
| `PAGES_BASE_URL` | | `https://<owner>.github.io/<repo>` | public base URL |
| `ALLOWED_USER_IDS` | | (everyone) | comma-separated Telegram user ids |

## Notes

- First publish to a fresh GitHub Pages site can take 1–2 minutes to go live.
- Each menu gets a unique URL (`/m/<name>-<id>/`), so re-uploading never
  overwrites an old one.
- The Chinese translation is for reference; the restaurant's original wording
  prevails.
