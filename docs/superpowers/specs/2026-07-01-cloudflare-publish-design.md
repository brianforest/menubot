# Cloudflare Worker + R2 Instant Publishing — Design Spec

> Fixes the GitHub-Pages build-latency 404s. Author: Claude (dir. Brian). 2026-07-01.

## Goal

Publish each menu so its link is **live the instant it is revealed** — no build
wait, no transient 404, no "may take 1–2 minutes" caveat. Replace GitHub-Pages
serving (whole-site rebuild, 25–90 s+ propagation) with a Cloudflare Worker
reading from R2 (strong read-after-write consistency).

## Decisions (settled)

- **Cloudflare Worker + R2**, deployed to a free `workers.dev` subdomain.
- **R2 only** — drop the GitHub publish path entirely.
- **No migration**: existing `github.io/menus/m/<slug>/` links keep working
  (GitHub Pages still serves the old repo); new menus use the workers.dev URL.
- `/vault` and the originals archive are unaffected (they read the VPS filesystem,
  never GitHub).

## Architecture

```
bot (VPS)  --HTTPS PUT /m/<slug>/index.html  (Authorization: Bearer SECRET)-->  Worker --put--> R2
diner      --HTTPS GET /m/<slug>/ ---------------------------------------------> Worker --get--> R2 --> HTML
```

R2 is strongly consistent, so a successful PUT means the subsequent GET returns
200 immediately — `waitUntilLive` is deleted.

### Component 1 — R2 bucket

- One bucket (e.g. `menubot-menus`). Object keys:
  - `m/<slug>/index.html` — the menu page (text/html).
  - `m/<slug>/img/<file>` — dish images (WEB_ENRICH only; default off).

### Component 2 — Worker (`worker/` — new sub-project with its own `wrangler.jsonc`)

A single `fetch` handler, structured as a pure `handleRequest(request, env)` so
it is unit-testable with a fake R2 binding. Bindings: `BUCKET` (R2),
`PUBLISH_SECRET` (secret).

Routes:
- `GET /m/<slug>/` and `GET /m/<slug>` → read `m/<slug>/index.html` from R2 →
  200 `text/html`, or a clean 404 page if absent.
- `GET /m/<slug>/img/<file>` → read from R2 → 200 with content-type inferred from
  the extension, or 404.
- `PUT /m/<slug>/index.html` and `PUT /m/<slug>/img/<file>` → **require**
  `Authorization: Bearer <PUBLISH_SECRET>`; on mismatch → 401. On success, write
  the body to R2 and return 200. Reject any `<slug>`/`<file>` not matching a safe
  charset (`[a-z0-9-]+` for slug, `[a-z0-9._-]+` for file) → 400 (path-traversal /
  key-injection guard).
- Any other path → 404.

**Security:** the write secret is the only gate on publishing. Compare it against
`env.PUBLISH_SECRET`; never log it. Reads are public (menus are shareable links).

### Component 3 — bot `publish.ts` (rewrite)

- Remove the GitHub Contents-API code and `waitUntilLive`.
- `publishMenu(slug, html, deps?)`: PUT `${config.publish.baseUrl}/m/${slug}/index.html`
  with header `Authorization: Bearer ${config.publish.secret}`, body = html,
  `Content-Type: text/html`. Throw on non-2xx. Return `{ url: ${baseUrl}/m/${slug}/ }`.
- `publishImage(slug, fileName, bytes, deps?)`: PUT `.../img/${fileName}` similarly
  (binary body). Throw on non-2xx.
- Inject `fetch` via an optional deps param so both are unit-testable.

### Component 4 — bot.ts

- Drop the `waitUntilLive` import + call + the `live` variable.
- Replace the "🌐 發佈中，確認連結生效… Publishing…" reply with a plain
  "🌐 發佈中… Publishing…" (or fold into the done message).
- The done message reveals the link with no caveat (it is guaranteed live).
  Remove the "（GitHub Pages 首次發佈可能需 1–2 分鐘生效）" branch entirely.
- `timer.time("waitLive", …)` is removed from the timing line.

### Component 5 — config

- Add `config.publish = { baseUrl: required("PUBLISH_BASE_URL"), secret: required("PUBLISH_SECRET") }`.
- Remove the now-unused GitHub **publish** config (`GITHUB_TOKEN`, `GITHUB_OWNER`,
  `GITHUB_REPO`, `GITHUB_BRANCH`, `PAGES_DIR`, the github.io `baseUrl`). Verify no
  other module references them (publish is the only user); if any remain, keep just
  those. This means the bot no longer requires GitHub env vars.

## Data flow

Files + hint → extract → enrich → normalize → render HTML →
`publishMenu(slug, html)` PUTs to the Worker → Worker writes R2 → 200 →
bot reveals `${baseUrl}/m/${slug}/` (live now). No polling.

## Error handling

- PUT non-2xx (auth, network, R2) → `publishMenu` throws → existing `processBatch`
  catch replies "處理失敗" (unchanged behavior).
- Worker: bad secret → 401; bad slug/file → 400; R2 miss on GET → 404 page.
- No `waitUntilLive` → no false "not live" state.

## Testing

- `worker/` : unit-test `handleRequest(request, env)` with a fake env
  (`{ BUCKET: <Map-backed get/put>, PUBLISH_SECRET: "s" }`) using `node:test`
  (Request/Response are Node ≥18 globals): GET-hit → 200 + body; GET-miss → 404;
  PUT with valid secret → stored (and a following GET returns it); PUT with
  missing/wrong secret → 401; PUT with a traversal slug (`../x`) → 400; content-type
  correct for html vs image.
- `src/publish.test.ts` (create): inject a fake `fetch`; assert `publishMenu` PUTs
  to `${baseUrl}/m/<slug>/index.html` with the `Authorization: Bearer <secret>`
  header and html body, returns `${baseUrl}/m/<slug>/`; throws on a non-2xx fake
  response. Same shape for `publishImage`.
- No live-network tests.

## Infra / deploy (partly interactive — needs Brian's Cloudflare login)

1. `wrangler login` (browser; Brian runs it — suggest via `! wrangler login`).
2. `wrangler r2 bucket create menubot-menus`.
3. `worker/wrangler.jsonc`: name, `main`, `compatibility_date`, `r2_buckets`
   binding `BUCKET` → `menubot-menus`.
4. `cd worker && wrangler deploy` → note the `*.workers.dev` URL.
5. `wrangler secret put PUBLISH_SECRET` (same value goes to the bot).
6. VPS bot `.env`: `PUBLISH_BASE_URL=https://<name>.<account>.workers.dev`,
   `PUBLISH_SECRET=<same>`; drop the GitHub publish vars; `git pull && build && restart`.

## Rollout

- Ship behind nothing — the publish path swaps wholesale. Old github.io links keep
  working; new menus serve from workers.dev. Verify: publish a menu → the revealed
  link is 200 immediately (no caveat), and the timing line no longer has `waitLive`.

## Out of scope

- Migrating old github.io menus to R2. Custom domain (workers.dev for now).
- Serving images pipeline changes (WEB_ENRICH still off by default; the Worker
  handles image G/PUT so it works if enabled).
