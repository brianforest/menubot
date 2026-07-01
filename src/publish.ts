import { config } from "./config.js";

interface PublishDeps {
  fetch: typeof fetch;
}

async function putObject(
  relPath: string,
  body: NonNullable<RequestInit["body"]>,
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

/**
 * Poll a URL with HEAD until it responds <400 or the timeout elapses, so a
 * freshly-published GitHub Pages link is only revealed once it's live (no 404).
 * Each probe has its own 5s timeout; 404 / network errors are treated as
 * "not live yet" and retried. Returns true if it went live.
 */
export async function waitUntilLive(
  url: string,
  timeoutMs = 90_000,
  intervalMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // not live yet — fall through to retry
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
