/** Resolve a Google Maps link to a "name, address" string, for use as extraction
 *  context. Best-effort and SSRF-guarded: only allow-listed Maps hosts are fetched,
 *  the request is HEAD-only (final URL, not body), time-bounded, and any failure
 *  yields null so the caller proceeds without context. */

export interface MapLinkDeps {
  fetch: typeof fetch;
}

// Hosts we will fetch. `google.com`/`www.google.com` additionally require a /maps path.
const MAPS_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "maps.google.com",
  "g.co",
  "google.com",
  "www.google.com",
]);

/** First allow-listed Google Maps URL in `text`, or null. SSRF guard: anything not
 *  on the host allow-list is ignored. */
export function findMapUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s]+/g);
  if (!urls) return null;
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      if (!MAPS_HOSTS.has(host)) continue;
      // google.com is only a maps host on a /maps path (avoid /search etc.).
      if ((host === "google.com" || host === "www.google.com") && !parsed.pathname.startsWith("/maps")) {
        continue;
      }
      return u;
    } catch {
      // not a valid URL — skip
    }
  }
  return null;
}

/** Follow the link's redirects and return the decoded `q=` place string, or null. */
export async function resolveMapContext(
  text: string,
  deps: MapLinkDeps = { fetch },
): Promise<string | null> {
  const url = findMapUrl(text);
  if (!url) return null;
  try {
    const res = await deps.fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const finalUrl = res.url || url;
    // URLSearchParams decodes both %XX and '+' → space.
    const q = new URL(finalUrl).searchParams.get("q");
    if (!q) return null;
    const place = q.replace(/[\s,]+$/, "").trim(); // drop trailing ", "
    return place || null;
  } catch {
    return null; // timeout / network / parse — best-effort
  }
}
