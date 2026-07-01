import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GlossaryEntry } from "./types.js";
import { REGIONAL_SEED } from "./regional-seed.js";
import { LEXICON_SEED } from "./lexicon-seed.js";

const SELECT_COLS =
  "term, display_en, display_zh, explain_en, explain_zh, category";

/**
 * Persistent cache of explained culinary terms, backed by node:sqlite.
 * Config-free: the db path is passed in, so tests use ":memory:".
 */
export class Glossary {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS glossary (
        term TEXT PRIMARY KEY,
        display_en TEXT NOT NULL DEFAULT '',
        display_zh TEXT NOT NULL DEFAULT '',
        explain_en TEXT NOT NULL DEFAULT '',
        explain_zh TEXT NOT NULL DEFAULT '',
        category   TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        version    TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS alias (
        alias TEXT PRIMARY KEY,
        term  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS regional_variant (
        variant   TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        region    TEXT NOT NULL DEFAULT '',
        note      TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lexicon (
        en_term   TEXT NOT NULL,
        locale    TEXT NOT NULL,
        canonical TEXT NOT NULL,
        variants  TEXT NOT NULL DEFAULT '',
        note      TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (en_term, locale)
      );
    `);
    this.migrateVersionColumn();
    this.seedRegional();
    this.seedLexicon();
  }

  /** Add the `version` column to a pre-B4 glossary table (CREATE TABLE IF NOT
   *  EXISTS won't alter an existing one). Existing rows default to '' → stale
   *  under any real version → re-explained lazily on next encounter. */
  private migrateVersionColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(glossary)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "version")) {
      this.db.exec("ALTER TABLE glossary ADD COLUMN version TEXT NOT NULL DEFAULT ''");
    }
  }

  /** Look up many terms (resolving aliases); returns found entries keyed by the
   *  REQUESTED term so callers can map item.xterm -> entry directly. */
  getMany(terms: string[], version = ""): Map<string, GlossaryEntry> {
    const out = new Map<string, GlossaryEntry>();
    if (!terms.length) return out;
    const aliasStmt = this.db.prepare("SELECT term FROM alias WHERE alias = ?");
    // Only a row written under the CURRENT version is a valid hit; a stale row
    // is treated as a miss so the caller re-explains and overwrites it.
    const getStmt = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM glossary WHERE term = ? AND version = ?`,
    );
    for (const t of terms) {
      const a = aliasStmt.get(t) as { term: string } | undefined;
      const row = getStmt.get(a ? a.term : t, version) as GlossaryEntry | undefined;
      if (row) out.set(t, row);
    }
    return out;
  }

  /** Insert or update a glossary entry, tagged with the content version that
   *  produced it (so a later version-mismatch lookup re-explains it). */
  put(entry: GlossaryEntry, createdAt: string, version = ""): void {
    this.db
      .prepare(
        `INSERT INTO glossary
           (term, display_en, display_zh, explain_en, explain_zh, category, created_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(term) DO UPDATE SET
           display_en = excluded.display_en,
           display_zh = excluded.display_zh,
           explain_en = excluded.explain_en,
           explain_zh = excluded.explain_zh,
           category   = excluded.category,
           version    = excluded.version`,
      )
      .run(
        entry.term, entry.display_en, entry.display_zh,
        entry.explain_en, entry.explain_zh, entry.category, createdAt, version,
      );
  }

  /** Map an alias to a canonical term (for manual curation; future use). */
  putAlias(alias: string, term: string): void {
    this.db
      .prepare(
        `INSERT INTO alias (alias, term) VALUES (?, ?)
         ON CONFLICT(alias) DO UPDATE SET term = excluded.term`,
      )
      .run(alias, term);
  }

  /** Idempotently load the code-defined regional seed. INSERT OR IGNORE means a
   *  row edited directly in the db is never overwritten. */
  seedRegional(): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO regional_variant (variant, canonical, region, note)
       VALUES (?, ?, ?, ?)`,
    );
    for (const r of REGIONAL_SEED) {
      stmt.run(r.variant, r.canonical, r.region, r.note);
    }
  }

  /** Upsert a single regional mapping (curation / tests). */
  putRegional(variant: string, canonical: string, region = "", note = ""): void {
    this.db
      .prepare(
        `INSERT INTO regional_variant (variant, canonical, region, note)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(variant) DO UPDATE SET
           canonical = excluded.canonical,
           region    = excluded.region,
           note      = excluded.note`,
      )
      .run(variant, canonical, region, note);
  }

  /** All regional mappings as variant → canonical. */
  getRegionalMap(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT variant, canonical FROM regional_variant")
      .all() as { variant: string; canonical: string }[];
    return new Map(rows.map((r) => [r.variant, r.canonical]));
  }

  /** Idempotently load the code-defined lexicon seed. Variants are stored
   *  newline-joined. INSERT OR IGNORE means a hand-edited row is never
   *  overwritten. */
  seedLexicon(): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO lexicon (en_term, locale, canonical, variants, note)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of LEXICON_SEED) {
      stmt.run(r.enTerm.toLowerCase(), r.locale, r.canonical, r.variants.join("\n"), r.note);
    }
  }

  /** Upsert a single lexicon mapping (curation / tests). */
  putLexicon(enTerm: string, locale: string, canonical: string, variants: string[], note = ""): void {
    this.db
      .prepare(
        `INSERT INTO lexicon (en_term, locale, canonical, variants, note)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(en_term, locale) DO UPDATE SET
           canonical = excluded.canonical,
           variants  = excluded.variants,
           note      = excluded.note`,
      )
      .run(enTerm.toLowerCase(), locale, canonical, variants.join("\n"), note);
  }

  /** Lexicon entries for one locale, variants split back into arrays. The return
   *  type is declared inline (structurally identical to lexicon.ts's
   *  LexiconEntry) so this module has no dependency on the application module. */
  getLexicon(locale: string): { enTerm: string; canonical: string; variants: string[] }[] {
    const rows = this.db
      .prepare("SELECT en_term, canonical, variants FROM lexicon WHERE locale = ?")
      .all(locale) as { en_term: string; canonical: string; variants: string }[];
    return rows.map((r) => ({
      enTerm: r.en_term,
      canonical: r.canonical,
      variants: r.variants.split("\n").filter(Boolean),
    }));
  }

  close(): void {
    this.db.close();
  }
}
