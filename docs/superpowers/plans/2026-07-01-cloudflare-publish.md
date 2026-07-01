# Cloudflare Worker + R2 Instant Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. When writing/editing the Worker, also consult the `workers-best-practices` and `wrangler` skills.

**Goal:** Serve each menu from a Cloudflare Worker backed by R2 so the revealed link is live immediately — deleting `waitUntilLive` and the GitHub-Pages build-latency 404s.

**Architecture:** A new `worker/` sub-project: a Worker whose `fetch` reads `m/<slug>/index.html` from R2 on GET and (with a bearer secret) writes it on PUT. The bot's `publish.ts` PUTs the HTML to the Worker and returns the workers.dev URL; `waitUntilLive` is removed. GitHub publishing is dropped.

**Tech Stack:** Cloudflare Workers + R2, wrangler; Node.js 20+, TypeScript ESM, `node:test` + `node:assert/strict`, tsx.

## Global Constraints

- TypeScript ESM — local imports use the `.js` extension.
- Tests: `node:test` + `node:assert/strict`. Bot tests are `src/*.test.ts` (run by `npm test`); the Worker test is `worker/src/*.test.ts`, run explicitly with `node --import tsx --test worker/src/index.test.ts`.
- Code comments / commit messages in English. Chinese user-facing strings use full-width punctuation.
- No new **runtime** dependencies in the bot (`src/`); the Worker uses only web-standard APIs + a structural R2 interface (no `@cloudflare/workers-types` needed).
- `config.ts` loads `.env` via dotenv at import and `process.exit(1)`s on a missing `required()` var. Adding required `PUBLISH_*` vars means they MUST also be added to the local `.env` (dev placeholders) or the whole suite fails to import config.
- Security: the Worker's PUT is gated by `Authorization: Bearer <PUBLISH_SECRET>`; slugs/filenames are charset-validated (no key injection). Reads are public.

---

### Task 1: The Worker (`worker/`)

**Files:**
- Create: `worker/src/index.ts`
- Create: `worker/wrangler.jsonc`
- Create: `worker/src/index.test.ts`

**Interfaces:**
- Produces: `export async function handleRequest(request: Request, env: Env): Promise<Response>` and a `default { fetch }` export; `export interface Env { BUCKET: R2Like; PUBLISH_SECRET: string }`.

- [ ] **Step 1: Write the failing test**

Create `worker/src/index.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, type Env } from "./index.js";

function fakeEnv(secret = "s"): Env & { _map: Map<string, Uint8Array> } {
  const m = new Map<string, Uint8Array>();
  return {
    _map: m,
    PUBLISH_SECRET: secret,
    BUCKET: {
      get: async (k: string) =>
        m.has(k) ? { arrayBuffer: async () => m.get(k)!.buffer as ArrayBuffer } : null,
      put: async (k: string, v: ArrayBuffer) => {
        m.set(k, new Uint8Array(v));
      },
    },
  } as unknown as Env & { _map: Map<string, Uint8Array> };
}

const put = (path: string, body: string, secret?: string) =>
  new Request(`https://w.dev${path}`, {
    method: "PUT",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    body,
  });
const get = (path: string) => new Request(`https://w.dev${path}`, { method: "GET" });

test("PUT with the right secret stores, and GET returns it as html", async () => {
  const env = fakeEnv("s");
  const w = await handleRequest(put("/m/foo/index.html", "<h1>hi</h1>", "s"), env);
  assert.equal(w.status, 200);
  const r = await handleRequest(get("/m/foo/"), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await r.text(), "<h1>hi</h1>");
});

test("GET a missing menu returns 404", async () => {
  const r = await handleRequest(get("/m/nope/"), fakeEnv());
  assert.equal(r.status, 404);
});

test("PUT without / with a wrong secret is 401 and does not store", async () => {
  const env = fakeEnv("s");
  assert.equal((await handleRequest(put("/m/foo/index.html", "x"), env)).status, 401);
  assert.equal((await handleRequest(put("/m/foo/index.html", "x", "bad"), env)).status, 401);
  assert.equal(env._map.size, 0);
});

test("a path-traversal slug is rejected and nothing is written", async () => {
  const env = fakeEnv("s");
  const res = await handleRequest(put("/m/..%2f..%2fetc/index.html", "x", "s"), env);
  assert.ok(res.status >= 400);
  assert.equal(env._map.size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test worker/src/index.test.ts`
Expected: FAIL — `./index.js` not found.

- [ ] **Step 3: Implement `worker/src/index.ts`**

```typescript
/** Minimal structural view of the R2 bindings the Worker uses (avoids a
 *  @cloudflare/workers-types dependency; the real R2Bucket satisfies it). */
interface R2Like {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer, opts?: unknown): Promise<unknown>;
}
export interface Env {
  BUCKET: R2Like;
  PUBLISH_SECRET: string;
}

const SLUG_RE = /^[a-z0-9-]+$/;
const FILE_RE = /^[a-z0-9._-]+$/;

function contentType(key: string): string {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function notFound(): Response {
  return new Response(
    "<!doctype html><meta charset=utf-8><title>Not found</title><p>Menu not found.",
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** Map a request path to an R2 key, or null if it isn't a valid menu path.
 *  /m/<slug>/ and /m/<slug> → m/<slug>/index.html ; /m/<slug>/img/<file> → that. */
function keyFor(pathname: string): string | null {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "m" || !parts[1] || !SLUG_RE.test(parts[1])) return null;
  const slug = parts[1];
  if (parts.length === 2) return `m/${slug}/index.html`;
  if (parts.length === 3 && parts[2] === "index.html") return `m/${slug}/index.html`;
  if (parts.length === 4 && parts[2] === "img" && FILE_RE.test(parts[3])) {
    return `m/${slug}/img/${parts[3]}`;
  }
  return null;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const key = keyFor(new URL(request.url).pathname);
  if (!key) return notFound();

  if (request.method === "GET" || request.method === "HEAD") {
    const obj = await env.BUCKET.get(key);
    if (!obj) return notFound();
    const body = request.method === "HEAD" ? null : await obj.arrayBuffer();
    return new Response(body, { headers: { "content-type": contentType(key) } });
  }

  if (request.method === "PUT") {
    if ((request.headers.get("authorization") || "") !== `Bearer ${env.PUBLISH_SECRET}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const bytes = await request.arrayBuffer();
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: contentType(key) } });
    return new Response("ok", { status: 200 });
  }

  return new Response("method not allowed", { status: 405 });
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),
};
```

- [ ] **Step 4: Write `worker/wrangler.jsonc`**

```jsonc
{
  "name": "menubot-menus",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "menubot-menus" }]
}
```

- [ ] **Step 5: Run the test to verify it passes; dry-run the Worker build**

Run: `node --import tsx --test worker/src/index.test.ts`
Expected: PASS (4 tests).
Run: `cd worker && npx wrangler deploy --dry-run 2>&1 | tail -5` (validates the Worker compiles/bundles without deploying or needing login).
Expected: a successful dry-run (no upload). If wrangler isn't installed, `npx wrangler` fetches it; network-restricted environments may skip this — the test is the primary gate.

- [ ] **Step 6: Commit**

```bash
git add worker/
git commit -m "feat(publish): Cloudflare Worker serving menus from R2 (GET public, PUT bearer-gated)"
```

---

### Task 2: Bot publish via the Worker (config + publish.ts), waitUntilLive kept

**Files:**
- Modify: `src/config.ts` (add `publish` block; remove GitHub publish config)
- Modify: `src/publish.ts` (`publishMenu`/`publishImage` PUT to the Worker; keep `waitUntilLive` for now)
- Modify: `.env` (local — add PUBLISH_* dev placeholders)
- Test: `src/publish.test.ts` (create)

**Interfaces:**
- Produces:
  - `config.publish = { baseUrl: string; secret: string }`
  - `publishMenu(slug: string, html: string, deps?: { fetch: typeof fetch }): Promise<{ url: string }>`
  - `publishImage(slug: string, fileName: string, bytes: Buffer, deps?: { fetch: typeof fetch }): Promise<void>`

- [ ] **Step 1: Add PUBLISH_* to the local `.env` (so config still imports in tests)**

Append to `/Users/brianforest/Code/menubot/.env` (dev placeholders — the file is git-ignored):
```
PUBLISH_BASE_URL=https://menubot-menus.example.workers.dev
PUBLISH_SECRET=dev-placeholder-secret
```

- [ ] **Step 2: Write the failing test**

Create `src/publish.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ANTHROPIC_API_KEY ??= "a";
process.env.PUBLISH_BASE_URL ??= "https://w.example.workers.dev";
process.env.PUBLISH_SECRET ??= "sekret";
const { publishMenu } = await import("./publish.js");

test("publishMenu PUTs the html to the worker with the bearer secret and returns the page url", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => "ok" } as Response;
  }) as unknown as typeof fetch;

  const res = await publishMenu("planters-x", "<h1>menu</h1>", { fetch: fakeFetch });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://w.example.workers.dev/m/planters-x/index.html");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(
    (calls[0].init.headers as Record<string, string>).authorization,
    "Bearer sekret",
  );
  assert.equal(calls[0].init.body, "<h1>menu</h1>");
  assert.equal(res.url, "https://w.example.workers.dev/m/planters-x/");
});

test("publishMenu throws on a non-2xx worker response", async () => {
  const fakeFetch = (async () =>
    ({ ok: false, status: 500, text: async () => "boom" }) as Response) as unknown as typeof fetch;
  await assert.rejects(() => publishMenu("x", "<h1>x</h1>", { fetch: fakeFetch }), /500/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test src/publish.test.ts`
Expected: FAIL — `publishMenu` still targets GitHub / signature differs.

- [ ] **Step 4: Add `config.publish` and remove GitHub publish config**

In `src/config.ts`: delete the `const owner = required("GITHUB_OWNER")` / `const repo = required("GITHUB_REPO")` lines and the whole `github: { … }` block. Add:
```typescript
  publish: {
    baseUrl: required("PUBLISH_BASE_URL"), // e.g. https://menubot-menus.<acct>.workers.dev
    secret: required("PUBLISH_SECRET"),
  },
```
(Search the codebase for any remaining `config.github` reference — only `publish.ts` should use it, and it's rewritten in the next step. If `web-image.ts`/`web-popular.ts` reference it, they don't — verify with grep.)

- [ ] **Step 5: Rewrite `publish.ts` `publishMenu`/`publishImage` to PUT to the Worker (keep `waitUntilLive`)**

Replace the GitHub `gh()` helper, `publishMenu`, and `publishImage` with:

```typescript
import { config } from "./config.js";

interface PublishDeps {
  fetch: typeof fetch;
}

async function putObject(
  relPath: string,
  body: BodyInit,
  contentType: string,
  deps: PublishDeps,
): Promise<void> {
  const res = await deps.fetch(`${config.publish.baseUrl}${relPath}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${config.publish.secret}`, "content-type": contentType },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Publish failed (${res.status}): ${detail}`);
  }
}

/** PUT the menu HTML to the Worker (backed by R2) and return its live URL. */
export async function publishMenu(
  slug: string,
  html: string,
  deps: PublishDeps = { fetch },
): Promise<{ url: string }> {
  await putObject(`/m/${slug}/index.html`, html, "text/html; charset=utf-8", deps);
  return { url: `${config.publish.baseUrl}/m/${slug}/` };
}

/** PUT a dish image into a menu's img/ folder (WEB_ENRICH only). */
export async function publishImage(
  slug: string,
  fileName: string,
  bytes: Buffer,
  deps: PublishDeps = { fetch },
): Promise<void> {
  await putObject(`/m/${slug}/img/${fileName}`, bytes, "application/octet-stream", deps);
}
```

Keep the existing `waitUntilLive` function in the file unchanged for now (Task 3 removes it). Remove the old `PutResult` interface / GitHub `API` constant / `gh()` helper.

- [ ] **Step 6: Run tests + typecheck**

Run: `node --import tsx --test src/publish.test.ts && npm run typecheck && npm test`
Expected: publish tests pass; typecheck clean (bot.ts still calls `waitUntilLive` + `publishMenu` returning `{url}` — both still valid); full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/publish.ts src/publish.test.ts
git commit -m "feat(publish): publish menus to the Cloudflare Worker instead of GitHub"
```

---

### Task 3: Remove waitUntilLive + the build-latency caveat

**Files:**
- Modify: `src/publish.ts` (delete `waitUntilLive`)
- Modify: `src/bot.ts` (remove the import, the call, the caveat, the timing stage)

**Interfaces:** none new — a removal.

- [ ] **Step 1: Delete `waitUntilLive` from `src/publish.ts`**

Remove the entire `waitUntilLive` function (and its doc comment) at the end of the file.

- [ ] **Step 2: Update `src/bot.ts`**

- Change the import to drop `waitUntilLive`:
  `import { publishMenu, publishImage } from "./publish.js";`
- Replace the publish/wait block. Find:
```typescript
    await ctx.reply("🌐 發佈中，確認連結生效… Publishing…");
    const { url } = await timer.time("publish", () => publishMenu(slug, html));
    // Block until the page is actually live so the link we reveal never 404s.
    // (The non-blocking variant saved ~20s but let early taps hit a transient
    // 404 until GitHub Pages built — not worth it for a shareable link.)
    const live = await timer.time("waitLive", () => waitUntilLive(url));
```
Replace with:
```typescript
    await ctx.reply("🌐 發佈中… Publishing…");
    const { url } = await timer.time("publish", () => publishMenu(slug, html));
```
- In the done message, remove the `live` caveat. Find:
```typescript
        `Done! Tap to view & share:\n${url}` +
        (live ? "" : "\n\n（GitHub Pages 首次發佈可能需 1–2 分鐘生效）"),
```
Replace with:
```typescript
        `Done! Tap to view & share:\n${url}`,
```

- [ ] **Step 3: Verify typecheck + tests + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean (no `waitUntilLive` / `live` references remain — grep to confirm: `grep -rn "waitUntilLive\|waitLive\|1–2 分鐘" src` returns nothing); full suite green; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/publish.ts src/bot.ts
git commit -m "feat(publish): drop waitUntilLive + build-latency caveat (R2 link is live immediately)"
```

---

## Infra / deploy runbook (interactive — Brian runs the login)

These are NOT code tasks; do them after the code merges, before the bot uses the Worker.

1. **Brian:** `wrangler login` (browser OAuth) — run via `! npx wrangler login` in the session, or on Brian's machine.
2. Create the bucket: `npx wrangler r2 bucket create menubot-menus`.
3. Set the Worker secret: `cd worker && npx wrangler secret put PUBLISH_SECRET` (paste a strong random value; keep it — the bot needs the same one).
4. Deploy: `cd worker && npx wrangler deploy` → note the printed `https://menubot-menus.<account>.workers.dev` URL.
5. Smoke-test: `curl -X PUT -H "Authorization: Bearer <secret>" --data '<h1>hi</h1>' https://menubot-menus.<account>.workers.dev/m/test/index.html` then open `https://…workers.dev/m/test/` → should show `hi` immediately.
6. VPS bot `.env`: set `PUBLISH_BASE_URL=https://menubot-menus.<account>.workers.dev` and `PUBLISH_SECRET=<same secret>`; the GitHub publish vars are now unused (leave or remove). `git pull && npm install && npm run build && sudo systemctl restart menubot`.
7. Verify: send a menu → the revealed link is 200 immediately, the timing line has no `waitLive`, and no "1–2 分鐘" caveat appears.

## Rollout notes

- Old `github.io/menus/m/<slug>/` links keep working (GitHub Pages still serves the old repo). New menus serve from workers.dev.
- Escape hatch: if the Worker misbehaves, revert the branch and redeploy the bot (GitHub publish path restored); old links unaffected.
