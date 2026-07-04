/** Normalize an extracted currency code/symbol to a clear bilingual display for
 *  the menu subtitle. The model emits the currency inconsistently (e.g. "RM" vs
 *  "MYR" for the Malaysian Ringgit); we canonicalize to the ISO 4217 code plus a
 *  中文 name so tourists unfamiliar with local symbols understand it. Unknown
 *  codes pass through unchanged (no data loss). */
const CURRENCY_DISPLAY: Record<string, string> = {
  RM: "MYR (馬幣)",
  MYR: "MYR (馬幣)",
  SGD: "SGD (新幣)",
  THB: "THB (泰銖)",
  IDR: "IDR (印尼盾)",
  PHP: "PHP (菲律賓披索)",
  VND: "VND (越南盾)",
  USD: "USD (美元)",
  EUR: "EUR (歐元)",
  GBP: "GBP (英鎊)",
  JPY: "JPY (日圓)",
  KRW: "KRW (韓元)",
  TWD: "TWD (台幣)",
  NTD: "TWD (台幣)",
  HKD: "HKD (港幣)",
  CNY: "CNY (人民幣)",
  RMB: "CNY (人民幣)",
  AUD: "AUD (澳幣)",
};

/** Map a currency code/symbol to its "ISO (中文名)" display; unknown → trimmed input. */
export function displayCurrency(code: string): string {
  const key = code.trim().toUpperCase();
  return CURRENCY_DISPLAY[key] ?? code.trim();
}

/** Short money marker shown before a price (distinct from a bare count). Common
 *  codes/symbols map to a compact prefix; unknown codes pass through; empty → "". */
const CURRENCY_PREFIX: Record<string, string> = {
  RM: "RM", MYR: "RM",
  SGD: "S$",
  THB: "฿",
  IDR: "Rp",
  PHP: "₱",
  VND: "₫",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥", CNY: "¥", RMB: "¥",
  TWD: "NT$", NTD: "NT$",
  HKD: "HK$",
  KRW: "₩",
  AUD: "A$",
};

export function currencyPrefix(code: string | undefined): string {
  const key = (code ?? "").trim().toUpperCase();
  if (!key) return "";
  return CURRENCY_PREFIX[key] ?? key;
}
