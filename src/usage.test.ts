import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resetUsage,
  recordUsage,
  usageTokens,
  usageCostUSD,
  usageSummary,
} from "./usage.js";

test("accumulates tokens across calls and resets", () => {
  resetUsage();
  recordUsage({ input_tokens: 1000, output_tokens: 500 });
  recordUsage({ input_tokens: 200, output_tokens: 50 });
  assert.equal(usageTokens(), 1750);
  resetUsage();
  assert.equal(usageTokens(), 0);
});

test("null/undefined usage is ignored", () => {
  resetUsage();
  recordUsage(undefined);
  recordUsage(null);
  recordUsage({});
  assert.equal(usageTokens(), 0);
});

test("cost uses per-model pricing (sonnet-5 intro cheaper than 4-6)", () => {
  resetUsage();
  recordUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  // sonnet-4-6: 1M*3 + 1M*15 = $18
  assert.equal(usageCostUSD("claude-sonnet-4-6").toFixed(2), "18.00");
  // sonnet-5 intro: 1M*2 + 1M*10 = $12
  assert.equal(usageCostUSD("claude-sonnet-5").toFixed(2), "12.00");
});

test("cache reads/writes are priced against input rate", () => {
  resetUsage();
  recordUsage({ cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 });
  // sonnet-4-6 input $3: read 0.1x=0.3 + write 1.25x=3.75 => $4.05
  assert.equal(usageCostUSD("claude-sonnet-4-6").toFixed(2), "4.05");
});

test("summary is comma-grouped tokens + dollar cost", () => {
  resetUsage();
  recordUsage({ input_tokens: 1_200_000, output_tokens: 34_000 });
  assert.equal(usageSummary("claude-sonnet-5"), "1,234,000 tokens\n$2.74");
});
