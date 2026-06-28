import { config } from "./config.js";

const API = "https://api.github.com";

interface PutResult {
  /** Public URL the menu page is served at via GitHub Pages. */
  url: string;
  /** Path inside the repo. */
  path: string;
  /** The commit that GitHub created. */
  commitUrl: string;
}

async function gh(path: string, init: RequestInit): Promise<Response> {
  return fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/**
 * Commit an HTML page to the configured repo so GitHub Pages serves it.
 * @param slug  url-safe folder name for this menu
 * @param html  full HTML document
 */
export async function publishMenu(slug: string, html: string): Promise<PutResult> {
  const { owner, repo, branch, pagesDir, baseUrl } = config.github;
  const path = `${pagesDir}/m/${slug}/index.html`;

  const res = await gh(
    `/repos/${owner}/${repo}/contents/${encodeURI(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: `menu: publish ${slug}`,
        content: Buffer.from(html, "utf8").toString("base64"),
        branch,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub publish failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { commit: { html_url: string } };
  return {
    url: `${baseUrl}/m/${slug}/`,
    path,
    commitUrl: data.commit.html_url,
  };
}

/**
 * Commit a binary image into a menu's img/ folder so GitHub Pages serves it.
 * Paths are always new (slug carries a timestamp), so this creates — no SHA needed.
 */
export async function publishImage(
  slug: string,
  fileName: string,
  bytes: Buffer,
): Promise<void> {
  const { owner, repo, branch, pagesDir } = config.github;
  const path = `${pagesDir}/m/${slug}/img/${fileName}`;
  const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `menu: image ${slug}/${fileName}`,
      content: bytes.toString("base64"),
      branch,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub image publish failed (${res.status}): ${body}`);
  }
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
