import { test } from "node:test";
import assert from "node:assert/strict";

// config.ts reads env at import time and process.exit(1)s on missing required
// vars, so set required vars before importing it.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ANTHROPIC_API_KEY ??= "a";
process.env.GITHUB_TOKEN ??= "g";
process.env.GITHUB_OWNER ??= "o";
process.env.GITHUB_REPO ??= "r";

test("region.enabled defaults to true when REGION_NORMALIZE is unset", async () => {
  const { config } = await import("./config.js");
  // default: REGION_NORMALIZE unset → enabled
  assert.equal(config.region.enabled, true);
});

import { parseExtractMode } from "./config.js";

test("parseExtractMode maps known modes and defaults unknown to single", () => {
  assert.equal(parseExtractMode("parallel"), "parallel");
  assert.equal(parseExtractMode("adaptive"), "adaptive");
  assert.equal(parseExtractMode("ADAPTIVE"), "adaptive");
  assert.equal(parseExtractMode("single"), "single");
  assert.equal(parseExtractMode("garbage"), "single");
  assert.equal(parseExtractMode(""), "single");
});
