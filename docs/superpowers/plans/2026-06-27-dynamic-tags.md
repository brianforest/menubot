# Dynamic-Tag Filters Implementation Plan (P2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalise extraction beyond food menus and replace the fixed 6-icon legend with a dynamic, per-menu tag vocabulary rendered as a multi-select AND filter bar, with house favourites surfaced as a ⭐ signature tag.

**Architecture:** Tags become an open system. `extract.ts` emits a `tags` vocabulary (`TagDef[]`) plus `kind`, and each item lists the tag ids it carries. `render.ts` embeds the vocabulary; the self-contained `templates/menu.html` builds filter chips from the tags actually used and applies AND filtering client-side. Signature (⭐) and popular (🔥, data in P4) are just well-known tags.

**Tech Stack:** Node.js (ESM, TypeScript), `@anthropic-ai/sdk` (Claude vision), self-contained HTML/CSS/vanilla-JS template. Tests via `node:test` under `tsx`.

## Global Constraints

- Comments/commit messages English; user-facing copy bilingual 繁中+English.
- ESM: intra-project imports use the `.js` extension.
- Keep `claude-sonnet-4-6`, streaming, `max_tokens: 32000`, the truncation guard.
- The project must `npm run typecheck` and `npm test` clean at every commit.
- No migration of already-published pages (each is self-contained; only new extractions use the new schema/template).
- Well-known tag ids + icons are fixed: `vegetarian`🌱 `spicy`🌶️ `pork`🐷 `chicken`🐔 `seafood`🐟 `beef`🐮 `vegan`🌱 `gluten-free`🌾 `contains-nuts`🥜 `dairy`🥛 `signature`⭐ `popular`🔥. The model must NOT emit `popular` (P4 owns it).
- Filtering is multi-select **AND** (an item shows iff its tags ⊇ the active set).

---

### Task 1: Data model — open tag system (`src/types.ts`)

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `TagDef = { id: string; en: string; zh: string; icon?: string; group?: string }`; `MenuItem.tags?: string[]`; `Menu.kind?: string`; `Menu.tags?: TagDef[]`. Consumed by `render.ts`, `extract.ts` (return type), template.

- [ ] **Step 1: Replace the `DietTag` type + `MenuItem.t` and extend `Menu`**

Replace the entire contents of `src/types.ts` with:

```ts
/** A classification label this menu uses (dietary, allergen, highlight, …). */
export interface TagDef {
  /** Stable lowercase-slug id, e.g. "vegetarian", "gluten-free", "signature". */
  id: string;
  /** English label. */
  en: string;
  /** Traditional-Chinese label. */
  zh: string;
  /** Emoji shown on chips/items; omitted when no fitting emoji applies. */
  icon?: string;
  /** Coarse grouping: "diet" | "allergen" | "protein" | "highlight" | "other". */
  group?: string;
}

export interface MenuItem {
  /** English name (as printed). */
  en: string;
  /** Traditional-Chinese name. */
  zh: string;
  /** Price exactly as printed, e.g. "18", "8 / 9", "108". Optional. */
  p?: string;
  /** Ids of the TagDefs this item carries. */
  tags?: string[];
  /** English description, if the menu has one. */
  den?: string;
  /** Traditional-Chinese description. */
  dzh?: string;
}

export interface MenuSection {
  en: string;
  zh: string;
  /** Stable id used for in-page anchor links (auto-filled if missing). */
  id?: string;
  /** Optional footnote shown under the section heading. */
  note?: string;
  items: MenuItem[];
}

export interface Menu {
  restaurant?: { en?: string; zh?: string };
  /** Currency label, e.g. "SGD". */
  currency?: string;
  /** Best-effort menu type: "food" | "spa" | "service" | "other". Informational. */
  kind?: string;
  /** The tag vocabulary used by this menu — only tags carried by ≥1 item. */
  tags?: TagDef[];
  sections: MenuSection[];
}
```

- [ ] **Step 2: Verify nothing references the removed `t` / `DietTag`**

Run: `npm run typecheck`
Expected: no errors. (No TS code reads `MenuItem.t`; the template reads it from JS, handled in Task 4.)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): open tag system (TagDef + item tags), Menu.kind/tags"
```

---

### Task 2: Extraction — generalise + emit dynamic tags (`src/extract.ts`)

**Files:**
- Modify: `src/extract.ts` (the `SYSTEM` prompt only)

**Interfaces:**
- Consumes: `Menu`/`TagDef` shape (Task 1). Produces: same `extractMenu(sources)` signature; the returned JSON now carries `kind` + `tags` + per-item `tags`.

> Prompt-only change; no unit test. Gate: `npm run typecheck` + `npm test` stay green.

- [ ] **Step 1: Replace the `SYSTEM` constant**

Replace the whole `const SYSTEM = \`...\`;` block in `src/extract.ts` with:

```ts
const SYSTEM = `You are a menu digitisation assistant. You are given one or more
photos and/or a PDF of a single menu or list — restaurant food, spa treatments,
services, etc. Read every section and every item, then return a STRICT JSON object
describing the whole thing in English with a Traditional-Chinese (繁體中文)
translation.

Output schema (return ONLY this JSON, no markdown, no commentary):
{
  "restaurant": { "en": string, "zh": string },   // best guess; "" if unknown
  "currency": string,                                // e.g. "SGD"; "" if unknown
  "kind": string,                                    // "food" | "spa" | "service" | "other"; "" if unsure
  "tags": [                                          // the classification labels THIS menu uses
    { "id": string, "en": string, "zh": string, "icon": string, "group": string }
  ],
  "sections": [
    {
      "en": string,                                  // section title in English
      "zh": string,                                  // section title in 繁體中文
      "note": string,                                // optional footnote, else ""
      "items": [
        {
          "en": string,                              // item name as printed
          "zh": string,                              // 繁體中文 name (natural culinary wording)
          "p": string,                               // price exactly as printed; "" if none
          "tags": string[],                          // ids of the tags above this item carries; [] if none
          "den": string,                             // English description if present, else ""
          "dzh": string                              // 繁體中文 translation of the description, else ""
        }
      ]
    }
  ]
}

Tags — IMPORTANT:
- A menu uses its own vocabulary of labels. Capture EVERY distinct classification
  label the menu actually uses (dietary marks, allergen warnings, "Highlight",
  "Chef's", "招牌", etc.) as an entry in "tags", then reference them per item by id.
- Use these well-known ids and icons when the concept matches (do not invent new
  ids for these):
    vegetarian 🌱 | vegan 🌱 | spicy 🌶️ | pork 🐷 | chicken 🐔 | seafood 🐟 |
    beef 🐮 | gluten-free 🌾 | contains-nuts 🥜 | dairy 🥛 | signature ⭐
- Map any "Highlight / Chef's recommendation / 招牌 / Recommended / 推薦" marker to
  the "signature" tag (icon ⭐, group "highlight").
- For a menu-specific label not in the list above, mint a stable lowercase-slug
  "id" (e.g. "contains-shellfish"), give bilingual "en"/"zh", set a fitting emoji
  "icon" (or "" if none fits), and a "group" of "diet" | "allergen" | "protein"
  | "highlight" | "other".
- Only include a tag in "tags" if at least one item carries it.
- NEVER emit a "popular" tag — that is reserved and populated elsewhere.

Other rules:
- Capture EVERY item and section; do not summarise or skip.
- Keep prices as strings exactly as printed (no currency symbol unless printed).
- Traditional Chinese only (繁體中文), using natural Hong Kong / Taiwan culinary
  terms. Translate descriptions faithfully but concisely.
- Preserve the original section order as it reads on the menu.
- If a field is unknown, use "" (or [] for "tags"); never invent prices.
- Return valid JSON parseable by JSON.parse. No trailing commas.

Example "tags" + item (illustrative):
  "tags": [
    { "id": "vegetarian", "en": "Vegetarian", "zh": "適合素食", "icon": "🌱", "group": "diet" },
    { "id": "gluten-free", "en": "Gluten Free", "zh": "無麩質", "icon": "🌾", "group": "diet" },
    { "id": "contains-nuts", "en": "Contains Nuts", "zh": "含堅果", "icon": "🥜", "group": "allergen" },
    { "id": "signature", "en": "Signature", "zh": "招牌", "icon": "⭐", "group": "highlight" }
  ],
  ... an item: { "en": "Pesto Pasta", "zh": "青醬義大利麵", "p": "22", "tags": ["vegetarian","contains-nuts","signature"], "den": "", "dzh": "" }`;
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; tests still 11/11 (no test touches the prompt string).

- [ ] **Step 3: Commit**

```bash
git add src/extract.ts
git commit -m "feat(extract): generalise to any menu + emit dynamic tag vocabulary"
```

---

### Task 3: Render — embed the tag vocabulary (`src/render.ts` + template hook)

**Files:**
- Modify: `src/render.ts`
- Modify: `templates/menu.html` (add the `{{TAGS_JSON}}` data hook only)
- Test: `src/render.test.ts`

**Interfaces:**
- Consumes: `Menu.tags` (Task 1). Produces: HTML with `TAGS` available to the page script (consumed by Task 4).

- [ ] **Step 1: Write the failing test**

Create `src/render.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMenu } from "./render.js";

test("renderMenu embeds the tag vocabulary and item tags, replaces the placeholder", () => {
  const html = renderMenu({
    restaurant: { en: "X", zh: "X" },
    tags: [{ id: "vegetarian", en: "Vegetarian", zh: "素", icon: "🌱" }],
    sections: [
      { en: "S", zh: "區", items: [{ en: "A", zh: "甲", tags: ["vegetarian"] }] },
    ],
  });
  assert.ok(html.includes('"id":"vegetarian"'), "tag vocabulary embedded");
  assert.ok(html.includes('"tags":["vegetarian"]'), "item tags embedded");
  assert.ok(!html.includes("{{TAGS_JSON}}"), "placeholder replaced");
});

test("renderMenu defaults tags to [] when the menu has none", () => {
  const html = renderMenu({ sections: [{ en: "S", zh: "區", items: [] }] });
  assert.ok(html.includes("const TAGS = [];"), "empty tags default embedded");
  assert.ok(!html.includes("{{TAGS_JSON}}"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the placeholder `{{TAGS_JSON}}` is not yet replaced, so it remains in the output (`!html.includes("{{TAGS_JSON}}")` fails) / `const TAGS = [];` is absent.

- [ ] **Step 3: Add the `{{TAGS_JSON}}` substitution in `render.ts`**

In `src/render.ts`, change the return statement of `renderMenu`. Currently:

```ts
  return TEMPLATE.replace(/\{\{TITLE_EN\}\}/g, escapeHtml(titleEn))
    .replace(/\{\{TITLE_ZH\}\}/g, escapeHtml(titleZh))
    .replace(/\{\{SUBTITLE\}\}/g, escapeHtml(subtitle))
    .replace("{{MENU_JSON}}", JSON.stringify(sections));
```

to:

```ts
  return TEMPLATE.replace(/\{\{TITLE_EN\}\}/g, escapeHtml(titleEn))
    .replace(/\{\{TITLE_ZH\}\}/g, escapeHtml(titleZh))
    .replace(/\{\{SUBTITLE\}\}/g, escapeHtml(subtitle))
    .replace("{{MENU_JSON}}", JSON.stringify(sections))
    .replace("{{TAGS_JSON}}", JSON.stringify(menu.tags ?? []));
```

- [ ] **Step 4: Add the data hook in the template**

In `templates/menu.html`, find the script line:

```js
const MENU = {{MENU_JSON}};
```

and add a TAGS line right after it:

```js
const MENU = {{MENU_JSON}};
const TAGS = {{TAGS_JSON}};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (render tests + the 11 prior tests).

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/render.ts src/render.test.ts templates/menu.html
git commit -m "feat(render): embed dynamic tag vocabulary into the page"
```

---

### Task 4: Template — dynamic filter bar + AND filtering (`templates/menu.html`)

**Files:**
- Modify: `templates/menu.html`

**Interfaces:**
- Consumes: `MENU` (sections, each item with `tags`) and `TAGS` (vocabulary) embedded by Task 3.

> The page is self-contained; its client JS is not unit-tested (consistent with the project). Gate: `npm run typecheck` + `npm test` stay green (render test still passes), and manual browser acceptance per the spec's Rollout. Verify the rendered HTML is well-formed by building and opening a sample (Step 6).

- [ ] **Step 1: Move the filter bar into the sticky controls; remove the static legend**

In `templates/menu.html`, the `.controls` block currently is:

```html
<div class="controls">
  <div class="lang-toggle" role="group" aria-label="language">
    <button data-lang="both" class="active">雙語</button>
    <button data-lang="zh">中文</button>
    <button data-lang="en">EN</button>
  </div>
  <nav class="nav" id="nav" aria-label="sections"></nav>
</div>
```

Add a filter bar container after the `<nav>`:

```html
<div class="controls">
  <div class="lang-toggle" role="group" aria-label="language">
    <button data-lang="both" class="active">雙語</button>
    <button data-lang="zh">中文</button>
    <button data-lang="en">EN</button>
  </div>
  <nav class="nav" id="nav" aria-label="sections"></nav>
  <div class="filterbar" id="filterbar" role="group" aria-label="filters"></div>
</div>
```

Then delete the static legend block from inside `.wrap`:

```html
  <div class="legend">
    <span>🌶️ Spicy 辣</span>
    <span>🌱 Vegetarian 適合素食</span>
    <span>🐷 Pork 豬肉</span>
    <span>🐔 Chicken 雞肉</span>
    <span>🐟 Seafood 海鮮</span>
    <span>🐮 Beef 牛肉</span>
  </div>
```

(Leave `<main id="menu"></main>` and the rest of `.wrap` intact.)

- [ ] **Step 2: Replace the `.legend` CSS with `.filterbar` / `.chip` CSS**

In the `<style>` block, delete the `.legend` rules:

```css
  .legend { display: flex; flex-wrap: wrap; gap: 8px 18px; justify-content: center;
    padding: 16px 14px; margin: 18px auto 4px; max-width: 720px; background: var(--card);
    border: 1px solid var(--line); border-radius: 14px; font-size: 15px; }
  .legend span { white-space: nowrap; }
```

and add, right after the `.nav a { ... }` rule:

```css
  .filterbar { display: flex; gap: 8px; overflow-x: auto; padding: 6px 14px 8px;
    scrollbar-width: none; -ms-overflow-style: none; }
  .filterbar::-webkit-scrollbar { display: none; }
  .chip { flex: 0 0 auto; font: inherit; font-size: 15px; font-weight: 500;
    border: 1px solid var(--line); background: var(--card); color: var(--ink);
    border-radius: 999px; padding: 6px 12px; min-height: 36px; cursor: pointer;
    white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
  .chip.active { background: var(--ink); color: #fff; border-color: var(--ink); }
  body.lang-zh .chip .cen { display: none; }
  body.lang-en .chip .czh { display: none; }
```

- [ ] **Step 3: Replace the page `<script>` with the dynamic-tag version**

Replace the entire `<script> ... </script>` block at the bottom of `templates/menu.html` with:

```html
<script>
const MENU = {{MENU_JSON}};
const TAGS = {{TAGS_JSON}};
const TAG_BY_ID = Object.fromEntries(TAGS.map(t => [t.id, t]));

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const menuEl = document.getElementById("menu");
const navEl = document.getElementById("nav");
const barEl = document.getElementById("filterbar");

// Render sections + items (items carry data-tags for filtering).
MENU.forEach((sec, i) => {
  const id = sec.id || ("sec-" + i);
  navEl.insertAdjacentHTML("beforeend", `<a href="#${id}" data-sec="${id}">${esc(sec.zh || sec.en)}</a>`);

  const items = (sec.items || []).map(it => {
    const ids = it.tags || [];
    const icons = ids.map(t => (TAG_BY_ID[t] && TAG_BY_ID[t].icon) || "").filter(Boolean).join(" ");
    const tags = icons ? `<span class="tags">${icons}</span>` : "";
    const price = it.p ? `<div class="price">${esc(it.p)}</div>` : "";
    const den = it.den ? `<div class="desc">${esc(it.den)}</div>` : "";
    const dzh = it.dzh ? `<div class="desc-zh">${esc(it.dzh)}</div>` : "";
    return `<div class="item" data-tags="${esc(ids.join(" "))}">
      <div class="row">
        <div>
          <div class="name">${esc(it.en)} ${tags}</div>
          <div class="name-zh">${esc(it.zh)}</div>
        </div>${price}
      </div>${den}${dzh}
    </div>`;
  }).join("");

  const note = sec.note ? `<p class="sec-note">${esc(sec.note)}</p>` : "";
  menuEl.insertAdjacentHTML("beforeend", `<section id="${id}">
    <div class="sec-head"><h2>${esc(sec.en)}</h2><span class="zh">${esc(sec.zh)}</span></div>
    ${note}<div class="grid">${items}</div>
  </section>`);
});

// Build the filter bar from the tags actually used by ≥1 item (in TAGS order).
const used = new Set();
MENU.forEach(s => (s.items || []).forEach(it => (it.tags || []).forEach(id => used.add(id))));
const filterTags = TAGS.filter(t => used.has(t.id));
const active = new Set();

if (filterTags.length) {
  barEl.insertAdjacentHTML("beforeend", `<button class="chip chip-all active" data-id="">全部 All</button>`);
  filterTags.forEach(t => {
    const ic = t.icon ? `<span class="ci">${t.icon}</span>` : "";
    barEl.insertAdjacentHTML("beforeend",
      `<button class="chip" data-id="${esc(t.id)}">${ic}<span class="cen">${esc(t.en)}</span><span class="czh">${esc(t.zh)}</span></button>`);
  });
} else {
  barEl.style.display = "none";
}

// AND filter: an item shows iff its tags include every active id.
function applyFilter() {
  document.querySelectorAll("#menu section").forEach(sec => {
    let visible = 0;
    sec.querySelectorAll(".item").forEach(el => {
      const tags = new Set((el.getAttribute("data-tags") || "").split(" ").filter(Boolean));
      let show = true;
      active.forEach(id => { if (!tags.has(id)) show = false; });
      el.style.display = show ? "" : "none";
      if (show) visible++;
    });
    sec.style.display = visible ? "" : "none";
    const link = navEl.querySelector(`a[data-sec="${sec.id}"]`);
    if (link) link.style.display = visible ? "" : "none";
  });
}

barEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  const id = btn.dataset.id;
  if (id === "") active.clear();
  else if (active.has(id)) active.delete(id);
  else active.add(id);

  barEl.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  if (active.size === 0) {
    barEl.querySelector(".chip-all").classList.add("active");
  } else {
    active.forEach(a => {
      const c = barEl.querySelector(`.chip[data-id="${CSS.escape(a)}"]`);
      if (c) c.classList.add("active");
    });
  }
  applyFilter();
});

// Language toggle (unchanged behaviour).
document.querySelectorAll(".lang-toggle button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".lang-toggle button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.body.className = "lang-" + btn.dataset.lang;
  });
});

// Back to top (unchanged behaviour).
const toTop = document.getElementById("toTop");
addEventListener("scroll", () => toTop.classList.toggle("show", scrollY > 600), { passive: true });
toTop.addEventListener("click", () => scrollTo({ top: 0, behavior: "smooth" }));
</script>
```

- [ ] **Step 4: Verify the render test still passes**

Run: `npm test`
Expected: PASS — the render test asserts `const TAGS = ...` and the embedded JSON, all still present.

- [ ] **Step 5: Verify typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean (the template is not compiled, but `tsc` must still pass).

- [ ] **Step 6: Smoke-render a sample page and confirm it is well-formed**

Run this one-off (no new file committed):

```bash
node --import tsx -e '
import { renderMenu } from "./src/render.ts";
const html = renderMenu({
  restaurant:{en:"Trattoria",zh:"小餐館"}, kind:"food",
  tags:[
    {id:"vegetarian",en:"Vegetarian",zh:"適合素食",icon:"🌱",group:"diet"},
    {id:"gluten-free",en:"Gluten Free",zh:"無麩質",icon:"🌾",group:"diet"},
    {id:"signature",en:"Signature",zh:"招牌",icon:"⭐",group:"highlight"}
  ],
  sections:[{en:"Pasta",zh:"義大利麵",items:[
    {en:"Pesto",zh:"青醬麵",p:"22",tags:["vegetarian","signature"]},
    {en:"Carbonara",zh:"培根蛋麵",p:"24",tags:["gluten-free"]}
  ]}]
});
const fs = await import("node:fs");
fs.writeFileSync("/tmp/menubot-sample.html", html);
console.log("wrote /tmp/menubot-sample.html;",
  "has filterbar:", html.includes(\"id=\\\"filterbar\\\"\"),
  "no leftover placeholder:", !html.includes("{{"));
'
```

Expected: prints `has filterbar: true no leftover placeholder: true`. (Open `/tmp/menubot-sample.html` in a browser if available to eyeball the chips + AND filtering; otherwise this is verified during VPS acceptance.)

- [ ] **Step 7: Commit**

```bash
git add templates/menu.html
git commit -m "feat(template): dynamic tag filter bar with multi-select AND filtering"
```

---

### Task 5: Docs touch-up (`README.md`)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Note generalisation + dynamic filters in step 2/3 of "How it works"**

In `README.md`, change step 2:

```
2. Photos are buffered into one batch and read by a Claude vision model, which
   extracts every section & item and translates them to Traditional Chinese
   (names, descriptions, prices, and dietary icons).
```

to:

```
2. Photos/PDF are read by a Claude vision model, which extracts every section &
   item, translates them to Traditional Chinese (names, descriptions, prices),
   and tags each item with the menu's own classification labels (dietary,
   allergen, "Highlight"/signature, …). Works for non-food menus too (e.g. spa).
```

And change step 3:

```
3. The structured menu is rendered into a self-contained HTML page (language
   toggle 雙語/中文/EN, category jump-nav, share preview cards).
```

to:

```
3. The structured menu is rendered into a self-contained HTML page (language
   toggle 雙語/中文/EN, category jump-nav, a dynamic tag filter bar with
   multi-select AND filtering, share preview cards).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README notes generalisation and dynamic tag filters"
```

---

## Self-Review

**1. Spec coverage:**
- #1 generalise → Task 2 (prompt: any menu/list + `kind`). ✓
- #2 dynamic filterable categories, AND, non-food disables dietary → Tasks 1 (tags model), 2 (emit vocabulary), 4 (filter bar + AND + used-only chips; non-food simply has no dietary tags). ✓
- #3 signature ⭐ (filterable), popular 🔥 reserved → Tasks 2 (map markers → `signature`; never emit `popular`), 4 (chips are tags). ✓
- Data model (TagDef, item tags, Menu.kind/tags) → Task 1. ✓
- Render embeds vocabulary → Task 3 (+ test). ✓
- Template AND filter + empty-section hide + tag icons → Task 4. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full content.

**3. Type consistency:** `TagDef`/`MenuItem.tags`/`Menu.tags` defined in Task 1 are used identically in render (Task 3) and template (Task 4). `{{TAGS_JSON}}` placeholder added in Task 3 (template hook + render replacement) and consumed by Task 4's script. `data-id`/`data-tags`/`data-sec` attributes and the `active` Set, `applyFilter`, `chip`/`chip-all` classes are internally consistent within Task 4. Well-known ids/icons match between the Global Constraints, Task 2's prompt table, and the spec.
