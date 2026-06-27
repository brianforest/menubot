# Configurable Option Groups Implementation Plan (P3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture an item's configurable components (broths, noodles, toppings, sizes, add-ons) as structured option groups and render them with clear visual hierarchy.

**Architecture:** Extraction emits `item.options: OptionGroup[]` (label + kind + bilingual choices with optional add-on price). `render.ts` already serialises items, so the self-contained `templates/menu.html` reads `it.options` and renders each group as a layered, tinted sub-block under the item.

**Tech Stack:** Node.js (ESM, TypeScript), `@anthropic-ai/sdk`, self-contained HTML/CSS/JS template. Tests via `node:test` under `tsx`.

## Global Constraints

- Comments/commit messages English; user-facing copy bilingual 繁中+English.
- ESM: intra-project imports use the `.js` extension.
- Keep `claude-sonnet-4-6`, streaming, extraction `max_tokens: 32000`.
- The project must `npm run typecheck` and `npm test` clean at every commit.
- No migration of already-published pages (self-contained; only new extractions use the new schema/template).
- `kind` values are exactly `"one" | "list" | "any"` (choose-one / included-list / optional-extras).

---

### Task 1: Data model — option groups (`src/types.ts`)

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `OptionChoice = { en: string; zh: string; p?: string }`; `OptionGroup = { en: string; zh: string; kind?: "one"|"list"|"any"; choices: OptionChoice[] }`; `MenuItem.options?: OptionGroup[]`.

- [ ] **Step 1: Add the two interfaces and the `MenuItem.options` field**

In `src/types.ts`, add `options?: OptionGroup[];` inside `MenuItem` (after the `explain?` field), and append the two new interfaces at the end of the file:

```ts
/** One selectable choice within an option group. */
export interface OptionChoice {
  en: string;
  zh: string;
  /** Extra price for this choice if it is a paid add-on, as printed; else absent. */
  p?: string;
}

/** A group of related choices for a configurable item. */
export interface OptionGroup {
  en: string;   // group label in English, e.g. "Broth"
  zh: string;   // group label in 繁體中文, e.g. "湯底可選"
  /** "one" = pick exactly one; "list" = included components; "any" = optional extras. */
  kind?: "one" | "list" | "any";
  choices: OptionChoice[];
}
```

The `MenuItem.options` field (place after `explain?: { en: string; zh: string };`):

```ts
  /** Configurable option groups (broths, noodles, toppings, sizes, add-ons). */
  options?: OptionGroup[];
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; tests still 27/27 (no behaviour changed).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): OptionGroup/OptionChoice + MenuItem.options"
```

---

### Task 2: Extraction — emit option groups (`src/extract.ts`)

**Files:**
- Modify: `src/extract.ts` (the `SYSTEM` prompt only)

> Prompt-only change; gate `npm run typecheck` + `npm test` stay green.

- [ ] **Step 1: Add `options` to the per-item schema**

In the `SYSTEM` string in `src/extract.ts`, inside the item object schema, add an `options` line after the `"xterm"` line. Change:

```
          "xterm": string,                           // see "Explanations" below; "" if not needed
          "den": string,                             // English description if present, else ""
```

to:

```
          "xterm": string,                           // see "Explanations" below; "" if not needed
          "options": [                               // see "Option groups" below; omit or [] if none
            { "en": string, "zh": string, "kind": string,
              "choices": [ { "en": string, "zh": string, "p": string } ] }
          ],
          "den": string,                             // English description if present, else ""
```

- [ ] **Step 2: Add the Option groups rubric to the prompt**

In the same `SYSTEM` string, add this block immediately before the `Other rules:` section:

```
Option groups (options) — IMPORTANT:
- When an item lets the diner configure it — choose a broth/noodle/size, add
  toppings, or has included components listed as sub-bullets — capture each as an
  option group: a bilingual label ("en"/"zh"), a "kind", and bilingual "choices".
- "kind" is one of:
    "one"  — pick exactly one (cues: "choose", "可選", "任選一")
    "list" — included components, simply listed (no choice to make)
    "any"  — optional paid add-ons (cues: "add …", "加 …"); put the add-on's extra
             price in that choice's "p", else "".
- Do NOT also duplicate the option structure into "den"/"dzh"; keep those for genuine
  prose description only. Omit "options" (or use []) when the item is not configurable.

Example item with options (the noodle-soup shape):
  {
    "en": "Noodle Soup", "zh": "湯麵", "p": "", "tags": [], "xterm": "",
    "options": [
      { "en": "Broth", "zh": "湯底可選", "kind": "one",
        "choices": [ {"en":"Clear broth","zh":"清湯","p":""},
                     {"en":"Nyonya Curry Broth","zh":"娘惹咖哩湯","p":""} ] },
      { "en": "Toppings", "zh": "配料", "kind": "list",
        "choices": [ {"en":"Tender chicken","zh":"嫩雞肉","p":""},
                     {"en":"Fresh vegetables","zh":"新鮮蔬菜","p":""} ] },
      { "en": "Noodles", "zh": "麵條可選", "kind": "one",
        "choices": [ {"en":"Vermicelli","zh":"米粉","p":""},
                     {"en":"Flat rice noodles","zh":"河粉","p":""},
                     {"en":"Egg noodles","zh":"蛋麵","p":""} ] }
    ],
    "den": "", "dzh": ""
  }
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: clean; tests unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/extract.ts
git commit -m "feat(extract): capture configurable items as structured option groups"
```

---

### Task 3: Template — render layered option groups (`templates/menu.html` + render test)

**Files:**
- Modify: `templates/menu.html`
- Modify: `src/render.test.ts`

**Interfaces:**
- Consumes: `MenuItem.options` (rides inside the embedded `MENU` sections).

> The page JS is not unit-tested; a render test guards the data path. Manual browser acceptance for the visual hierarchy.

- [ ] **Step 1: Add a render test that option groups reach the page**

Append to `src/render.test.ts`:

```ts
test("renderMenu embeds an item's option groups and choices", () => {
  const html = renderMenu({
    sections: [{ en: "S", zh: "區", items: [
      { en: "Noodle Soup", zh: "湯麵", options: [
        { en: "Broth", zh: "湯底可選", kind: "one", choices: [
          { en: "Clear broth", zh: "清湯" },
          { en: "Nyonya Curry Broth", zh: "娘惹咖哩湯" },
        ] },
      ] },
    ] }],
  });
  assert.ok(html.includes("湯底可選"), "group label embedded");
  assert.ok(html.includes("Nyonya Curry Broth"), "choice embedded");
});
```

- [ ] **Step 2: Run it to confirm it passes (render embeds sections verbatim)**

Run: `npm test`
Expected: PASS — `render.ts` serialises `sections` (including `options`) into `{{MENU_JSON}}`.

- [ ] **Step 3: Add option-group CSS**

In `templates/menu.html` `<style>`, after the `.item .desc-zh { ... }` rule, add:

```css
  .opts { margin-top: 8px; }
  .optg { margin-top: 8px; padding: 8px 10px; background: var(--accent-soft);
    border-left: 3px solid var(--accent); border-radius: 8px; }
  .optg:first-child { margin-top: 0; }
  .optg-label { font-weight: 700; font-size: 15px; }
  .opt-hint { font-weight: 500; font-size: 13px; color: var(--muted); margin-left: 6px; }
  .optg-choices { list-style: none; margin: 6px 0 0; padding: 0;
    display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .optg-choices li { font-size: 15px; }
  .opts .ozh { color: var(--accent); }
  .opts .oen, .opts .ozh { margin-right: 3px; }
  .opt-price { color: var(--price); font-variant-numeric: tabular-nums; margin-left: 3px; }
  body.lang-zh .opts .oen { display: none; }
  body.lang-en .opts .ozh { display: none; }
```

- [ ] **Step 4: Build the options markup and render it in the page script**

In the `MENU.forEach` item `.map` callback, after the `const dzh = ...` line, add the options builder:

```js
    const opts = (it.options && it.options.length)
      ? `<div class="opts">` + it.options.map(g => {
          const choices = (g.choices || []).map(c => {
            const cp = c.p ? `<span class="opt-price">+${esc(c.p)}</span>` : "";
            return `<li><span class="oen">${esc(c.en)}</span><span class="ozh">${esc(c.zh)}</span>${cp}</li>`;
          }).join("");
          if (!choices) return "";
          const hint = g.kind === "one" ? `<span class="opt-hint">選一 · Choose one</span>`
                     : g.kind === "any" ? `<span class="opt-hint">可加 · Optional</span>` : "";
          return `<div class="optg">
            <div class="optg-label"><span class="oen">${esc(g.en)}</span><span class="ozh">${esc(g.zh)}</span>${hint}</div>
            <ul class="optg-choices">${choices}</ul>
          </div>`;
        }).join("") + `</div>`
      : "";
```

Then add `${opts}` to the item template literal, immediately after `${dzh}`. The end of the item template currently is:

```js
      </div>${den}${dzh}
    </div>`;
```

Change it to:

```js
      </div>${den}${dzh}${opts}
    </div>`;
```

- [ ] **Step 5: Verify tests + build + smoke-render**

Run: `npm test && npm run typecheck && npm run build`
Expected: tests PASS (incl. the new render test), typecheck + build clean.

Then smoke-render the noodle-soup shape (no file committed):

```bash
node --import tsx -e '
import { renderMenu } from "./src/render.ts";
const html = renderMenu({restaurant:{en:"X",zh:"X"},sections:[{en:"Noodles",zh:"麵",items:[
  {en:"Noodle Soup",zh:"湯麵",options:[
    {en:"Broth",zh:"湯底可選",kind:"one",choices:[{en:"Clear broth",zh:"清湯"},{en:"Nyonya Curry Broth",zh:"娘惹咖哩湯"}]},
    {en:"Toppings",zh:"配料",kind:"list",choices:[{en:"Tender chicken",zh:"嫩雞肉"}]},
    {en:"Extra egg",zh:"加蛋",kind:"any",choices:[{en:"Soft egg",zh:"溏心蛋",p:"2"}]}
  ]}
]}]});
const fs = await import("node:fs"); fs.writeFileSync("/tmp/menubot-opts.html", html);
console.log("has opts:", html.includes("class=\"opts\""), "has 選一:", html.includes("選一"), "has +2:", html.includes("+2"), "no placeholder:", !html.includes("{{"));
'
```

Expected: `has opts: true has 選一: true has +2: true no placeholder: true`.

- [ ] **Step 6: Commit**

```bash
git add templates/menu.html src/render.test.ts
git commit -m "feat(template): layered rendering of configurable option groups"
```

---

### Task 4: Docs touch-up (`README.md`)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Note option groups in "How it works" step 3**

In `README.md`, in the step describing the rendered page (the one listing the language toggle, jump-nav, filter bar), append a mention of option groups. Change that step to also include:

```
   …a dynamic tag filter bar with multi-select AND filtering, layered option
   groups for configurable items (broths, noodles, toppings, add-ons), share
   preview cards).
```

(Integrate the phrase "layered option groups for configurable items (broths, noodles, toppings, add-ons)" into the existing step-3 sentence in a grammatical way; keep the rest.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README notes layered option groups"
```

---

## Self-Review

**1. Spec coverage:**
- #6 structured option groups (label + kind + bilingual choices + optional add-on price) → Tasks 1 (model), 2 (extract). ✓
- Layered visual hierarchy → Task 3 (tinted, left-accent group blocks; group label + choices; 選一/可加 hints; language-toggle aware). ✓
- Render data path guarded → Task 3 render test. ✓
- Edge cases (no options unchanged; empty choices skipped; no price → none; no kind → plain) → Task 3 builder (`if (!choices) return ""`, conditional `cp`/`hint`) + unchanged item path. ✓

**2. Placeholder scan:** No TBD/TODO; full code in every step.

**3. Type consistency:** `OptionGroup`/`OptionChoice`/`MenuItem.options` (Task 1) are used identically in the extract schema (Task 2) and the template builder (Task 3). The template reads `g.en/g.zh/g.kind/g.choices` and `c.en/c.zh/c.p` exactly as defined. `kind` literals `"one"|"list"|"any"` match between the type, the prompt, and the template's `g.kind === "one"|"any"` checks. CSS classes `.opts/.optg/.optg-label/.opt-hint/.optg-choices/.oen/.ozh/.opt-price` are internally consistent between Step 3 (CSS) and Step 4 (markup).
