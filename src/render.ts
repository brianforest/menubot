import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Menu } from "./types.js";
import { displayCurrency, currencyPrefix } from "./currency.js";
import { groupByCategory } from "./category-nav.js";

const templatePath = fileURLToPath(
  new URL("../templates/menu.html", import.meta.url),
);
const TEMPLATE = readFileSync(templatePath, "utf8");

/** Slugify a string for use in URLs / file paths. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stamp = Date.now().toString(36).slice(-5);
  return `${base || "menu"}-${stamp}`;
}

/** Render a Menu into a self-contained HTML page. */
export function renderMenu(menu: Menu): string {
  // Ensure every section has a stable anchor id.
  const sections = menu.sections.map((s, i) => ({
    ...s,
    id: s.id || `sec-${i}`,
  }));

  const titleEn = menu.restaurant?.en?.trim() || "Menu";
  const titleZh = menu.restaurant?.zh?.trim() || "菜單";
  const currency = menu.currency?.trim();
  const subtitle = [
    "英中對照 · Bilingual",
    currency ? `價格以 ${displayCurrency(currency)} 計` : "",
  ]
    .filter(Boolean)
    .join("  |  ");

  const nav = groupByCategory(sections);
  const curPrefix = currencyPrefix(menu.currency);

  return TEMPLATE.replace(/\{\{TITLE_EN\}\}/g, escapeHtml(titleEn))
    .replace(/\{\{TITLE_ZH\}\}/g, escapeHtml(titleZh))
    .replace(/\{\{SUBTITLE\}\}/g, escapeHtml(subtitle))
    .replace("{{MENU_JSON}}", JSON.stringify(sections))
    .replace("{{TAGS_JSON}}", JSON.stringify(menu.tags ?? []))
    .replace("{{NAV_JSON}}", JSON.stringify(nav))
    .replace("{{CURRENCY_PREFIX}}", JSON.stringify(curPrefix));
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}
