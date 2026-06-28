import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export interface ArchivedFile {
  name: string;
  bytes: Buffer;
}

/** Map a source MIME to an archive file extension. */
export function extOf(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("pdf")) return "pdf";
  return "jpg";
}

/** Save a menu's original sources under <baseDir>/<slug>/ as page-<i>.<ext>. */
export function saveOriginals(
  baseDir: string,
  slug: string,
  sources: { bytes: Buffer; mime: string }[],
): void {
  if (!sources.length) return;
  const dir = join(baseDir, slug);
  mkdirSync(dir, { recursive: true });
  sources.forEach((s, i) => {
    writeFileSync(join(dir, `page-${i}.${extOf(s.mime)}`), s.bytes);
  });
}

/** Read a slug's archived files, sorted by name; [] if the folder is absent. */
export function readOriginals(baseDir: string, slug: string): ArchivedFile[] {
  const dir = join(baseDir, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, bytes: readFileSync(join(dir, name)) }));
}

/** List archived slugs, newest first (by folder mtime), capped at `limit`. */
export function listSlugs(baseDir: string, limit: number): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, t: statSync(join(baseDir, e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.name);
}

/** Extract a slug from a /vault argument: a published URL (…/m/<slug>/…) or a
 *  bare slug. Returns null if it doesn't look like either. */
export function parseSlug(arg: string): string | null {
  const t = arg.trim();
  const m = t.match(/\/m\/([a-z0-9-]+)/i);
  if (m) return m[1];
  if (/^[a-z0-9-]+$/i.test(t)) return t;
  return null;
}
