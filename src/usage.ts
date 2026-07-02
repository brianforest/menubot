/**
 * Token-usage accounting for one menu run. Every LLM call funnels its response
 * `usage` here via recordUsage (called from finalMessageWithDeadline, the single
 * choke point for extract/outline/sections/explain). resetUsage() is called at
 * the start of each menu.
 *
 * NOTE: a module-level accumulator assumes ONE menu is processed at a time. That
 * holds for the debug/eval path; concurrent menus would cross-count.
 */

/** The subset of an Anthropic message `usage` object we read. */
export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface Totals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

let totals: Totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

export function resetUsage(): void {
  totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

export function recordUsage(u: UsageLike | null | undefined): void {
  if (!u) return;
  totals.input += u.input_tokens ?? 0;
  totals.output += u.output_tokens ?? 0;
  totals.cacheCreate += u.cache_creation_input_tokens ?? 0;
  totals.cacheRead += u.cache_read_input_tokens ?? 0;
}

/** All tokens processed this run (input + output + cache). */
export function usageTokens(): number {
  return totals.input + totals.output + totals.cacheCreate + totals.cacheRead;
}

/** Per-1M-token USD prices. Sonnet 5 uses its intro rate (through 2026-08-31;
 *  standard is 3/15 after). Unknown models fall back to Sonnet 4.6 rates. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** Estimated USD cost of this run. Cache writes bill ~1.25x input, reads ~0.1x. */
export function usageCostUSD(model: string): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-4-6"];
  return (
    (totals.input * p.in +
      totals.cacheCreate * p.in * 1.25 +
      totals.cacheRead * p.in * 0.1 +
      totals.output * p.out) /
    1_000_000
  );
}

/** Human-friendly model name for the timing message. Unknown ids show as-is. */
const LABELS: Record<string, string> = {
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-8": "Opus 4.8",
  "claude-haiku-4-5": "Haiku 4.5",
};

export function modelLabel(model: string): string {
  return LABELS[model] ?? model;
}

/** Comma-group an integer without relying on ICU (`1234567` -> `1,234,567`). */
function withCommas(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Two-line suffix for the timing message: "186,432 tokens (Sonnet 5)\n$0.42". */
export function usageSummary(model: string): string {
  return `${withCommas(usageTokens())} tokens (${modelLabel(model)})\n$${usageCostUSD(model).toFixed(2)}`;
}
