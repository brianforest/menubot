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
