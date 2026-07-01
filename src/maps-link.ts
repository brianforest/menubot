/** Resolve a Google Maps link to a "name, address" string, for use as extraction
 *  context. Best-effort and SSRF-guarded: only allow-listed Maps hosts are fetched,
 *  every redirect hop is re-validated against the allow-list BEFORE it is fetched
 *  (so an open-redirect shortener can never be used to make us emit a request to an
 *  internal/metadata host), the request is HEAD-only, time-bounded, and any failure
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

/** True iff `u` parses and its host is on the Maps allow-list (with the /maps-path
 *  restriction for bare google.com). Any parse error → false. */
export function isAllowedMapHost(u: string): boolean {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (!MAPS_HOSTS.has(host)) return false;
    // google.com is only a maps host on a /maps path (avoid /search etc.).
    if ((host === "google.com" || host === "www.google.com") && !parsed.pathname.startsWith("/maps")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** First allow-listed Google Maps URL in `text`, or null. SSRF guard: anything not
 *  on the host allow-list is ignored. Trailing prose punctuation (e.g. a closing
 *  "。" or ")" that a sentence appends right after the URL) is stripped. */
export function findMapUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s]+/g);
  if (!urls) return null;
  for (const raw of urls) {
    const u = raw.replace(/[.,;:!?)）】」。，、]+$/, "");
    if (isAllowedMapHost(u)) return u;
  }
  return null;
}

const MAX_REDIRECT_HOPS = 5;

/** Follow the link's redirects manually — validating every hop against the host
 *  allow-list BEFORE fetching it — and return the decoded `q=` place string, or
 *  null. This is what prevents a blind SSRF via an open-redirect shortener
 *  (goo.gl / maps.app.goo.gl / g.co are open redirectors): we never fetch a URL
 *  whose host isn't allow-listed, no matter what an earlier hop pointed at. */
export async function resolveMapContext(
  text: string,
  deps: MapLinkDeps = { fetch },
): Promise<string | null> {
  let url = findMapUrl(text);
  if (!url) return null;
  try {
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      if (!isAllowedMapHost(url)) return null;
      const res = await deps.fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      const location = res.headers.get("location");
      if (!location) break;
      url = new URL(location, url).href;
    }
    if (!isAllowedMapHost(url)) return null;
    // URLSearchParams decodes both %XX and '+' → space.
    const q = new URL(url).searchParams.get("q");
    if (!q) return null;
    const place = q.replace(/[\s,]+$/, "").trim(); // drop trailing ", "
    return place || null;
  } catch {
    return null; // timeout / network / parse — best-effort
  }
}
