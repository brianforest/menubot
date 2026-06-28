import type { Menu, MenuItem } from "./types.js";
import { resolveIdentity } from "./popular.js";

/** Injected I/O for image enrichment (so the orchestrator stays pure + testable). */
export interface ImageDeps {
  /** Candidate direct image URLs for this dish (best first); [] if none. */
  findImage: (restaurant: string, en: string, zh: string) => Promise<string[]>;
  /** Download + validate a URL → bytes + extension; null on any failure/oversize/non-image. */
  download: (url: string) => Promise<{ bytes: Buffer; ext: string } | null>;
  /** Vision gate: is this a clean real photo of the dish (not logo/banner/collage/wrong)? */
  verify: (bytes: Buffer, ext: string, en: string, zh: string) => Promise<boolean>;
  /** Commit bytes to the menu repo under this slug's img/ folder; throws on failure. */
  commit: (slug: string, fileName: string, bytes: Buffer) => Promise<void>;
}

const DEFAULT_MAX = 5;

/**
 * Best-effort: attach a verified web photo to up to `maxItems` signature/popular
 * items. Resilient — a per-item failure leaves that item without an image; `img`
 * is set only after a successful commit. `deadline` (epoch ms) caps total
 * wall-clock: once passed, no further items are started (image finding is slow
 * and this is best-effort, so the publish must not be held hostage). Mutates and
 * returns the same menu.
 */
export async function addImages(
  menu: Menu,
  hint: string | undefined,
  slug: string,
  deps: ImageDeps,
  maxItems = DEFAULT_MAX,
  deadline?: number,
): Promise<Menu> {
  const { restaurant } = resolveIdentity(menu, hint);
  if (!restaurant) return menu;

  // Flat targets in menu order: items tagged signature or popular, capped.
  const targets: { it: MenuItem; i: number }[] = [];
  let i = 0;
  for (const sec of menu.sections) {
    for (const it of sec.items ?? []) {
      const tags = it.tags ?? [];
      if ((tags.includes("signature") || tags.includes("popular")) && targets.length < maxItems) {
        targets.push({ it, i });
      }
      i++;
    }
  }

  for (const { it, i: idx } of targets) {
    if (deadline !== undefined && Date.now() > deadline) break;
    try {
      const urls = await deps.findImage(restaurant, it.en, it.zh);
      for (const url of urls) {
        const d = await deps.download(url);
        if (!d) continue;
        if (!(await deps.verify(d.bytes, d.ext, it.en, it.zh))) continue;
        const fileName = `dish-${idx}.${d.ext}`;
        await deps.commit(slug, fileName, d.bytes);
        it.img = `img/${fileName}`;
        break;
      }
    } catch (e) {
      console.error(`dish image failed for "${it.en}":`, e);
    }
  }
  return menu;
}
