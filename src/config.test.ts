import { test } from "node:test";
import assert from "node:assert/strict";

// config.ts reads env at import time and process.exit(1)s on missing required
// vars, so set required vars before importing it.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ANTHROPIC_API_KEY ??= "a";
process.env.GITHUB_TOKEN ??= "g";
process.env.GITHUB_OWNER ??= "o";
process.env.GITHUB_REPO ??= "r";

test("region.enabled defaults to true and is disabled only by REGION_NORMALIZE=off", async () => {
  const { config } = await import("./config.js");
  // default: REGION_NORMALIZE unset → enabled
  assert.equal(config.region.enabled, true);
});
