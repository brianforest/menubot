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
    return new Response(body, {
      headers: {
        "content-type": contentType(key),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
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
