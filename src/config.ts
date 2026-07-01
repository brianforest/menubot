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

/** Parse EXTRACT_MODE; anything unrecognised falls back to the safe "single". */
export function parseExtractMode(raw: string): "single" | "parallel" | "adaptive" {
  const m = raw.toLowerCase();
  return m === "parallel" || m === "adaptive" ? m : "single";
}

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
  publish: {
    baseUrl: required("PUBLISH_BASE_URL").replace(/\/+$/, ""), // no trailing slash → clean /m/<slug>/ URLs
    secret: required("PUBLISH_SECRET"),
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
  extract: {
    // "single" (default) reads the whole menu in one call. "parallel" runs the
    // two-stage extractor (outline → parallel workers → merge). "adaptive" runs the
    // outline first and picks single for structurally-complex menus, parallel for
    // simple ones. Set EXTRACT_MODE=parallel|adaptive to override.
    mode: parseExtractMode(optional("EXTRACT_MODE", "single")),
  },
  region: {
    // Deterministic regional→Taiwan wording normalization of zh fields. Zero
    // API, unit-tested; ON by default. Set REGION_NORMALIZE=off to disable.
    enabled: optional("REGION_NORMALIZE", "on").toLowerCase() !== "off",
  },
  lexicon: {
    // Deterministic English-term → locale-best translation canonicalization of
    // zh fields (B2). Zero API, unit-tested; ON by default. Set
    // LEXICON_NORMALIZE=off to disable. TARGET_LOCALE selects which locale's
    // curated translations to apply (only zh-TW is seeded today).
    enabled: optional("LEXICON_NORMALIZE", "on").toLowerCase() !== "off",
    targetLocale: optional("TARGET_LOCALE", "zh-TW"),
  },
  debug: {
    // When on, append a per-stage timing summary (⏱️) to the Telegram reply so a
    // live test shows where the latency goes without SSHing for logs. Default off
    // — production UX stays clean. The structured console line logs regardless.
    timing: optional("DEBUG_TIMING", "off").toLowerCase() === "on",
  },
} as const;
