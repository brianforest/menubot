import "dotenv/config";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
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
} as const;
