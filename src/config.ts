import "dotenv/config";

// Trim whitespace and strip any angle brackets that get pasted in around a
// value (e.g. a URL copied as "<https://...>"), which would otherwise break
// links and API paths.
function clean(v: string | undefined): string {
  return (v ?? "").trim().replace(/^<+|>+$/g, "").trim();
}

function required(name: string): string {
  const v = clean(process.env[name]);
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  return clean(process.env[name]) || fallback;
}

const owner = required("GITHUB_OWNER");
const repo = required("GITHUB_REPO");

export const config = {
  telegram: {
    token: required("TELEGRAM_BOT_TOKEN"),
    // Numeric Telegram user ids allowed to use the bot. Empty = everyone.
    allowedUserIds: optional("ALLOWED_USER_IDS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  },
  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },
  github: {
    token: required("GITHUB_TOKEN"),
    owner,
    repo,
    branch: optional("GITHUB_BRANCH", "main"),
    pagesDir: optional("PAGES_DIR", "docs"),
    baseUrl:
      optional("PAGES_BASE_URL") ||
      `https://${owner}.github.io/${repo}`,
  },
  glossary: {
    dbPath: optional("GLOSSARY_DB", "data/glossary.db"),
  },
  archive: {
    dir: optional("ARCHIVE_DIR", "data/originals"),
  },
  web: {
    // Web enrichment (popularity 🔥 + dish images) is OFF by default: it only
    // pays off for well-known restaurants and burns tokens with ~zero yield on
    // obscure venues. Set WEB_ENRICH=on to enable.
    enabled: optional("WEB_ENRICH", "off").toLowerCase() === "on",
  },
  debug: {
    // When on, append a per-stage timing summary (⏱️) to the Telegram reply so a
    // live test shows where the latency goes without SSHing for logs. Default off
    // — production UX stays clean. The structured console line logs regardless.
    timing: optional("DEBUG_TIMING", "off").toLowerCase() === "on",
  },
} as const;
