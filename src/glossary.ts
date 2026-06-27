import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GlossaryEntry } from "./types.js";

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
        created_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS alias (
        alias TEXT PRIMARY KEY,
        term  TEXT NOT NULL
      );
    `);
  }

  /** Look up many terms (resolving aliases); returns found entries keyed by the
   *  REQUESTED term so callers can map item.xterm -> entry directly. */
  getMany(terms: string[]): Map<string, GlossaryEntry> {
    const out = new Map<string, GlossaryEntry>();
    if (!terms.length) return out;
    const aliasStmt = this.db.prepare("SELECT term FROM alias WHERE alias = ?");
    const getStmt = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM glossary WHERE term = ?`,
    );
    for (const t of terms) {
      const a = aliasStmt.get(t) as { term: string } | undefined;
      const row = getStmt.get(a ? a.term : t) as GlossaryEntry | undefined;
      if (row) out.set(t, row);
    }
    return out;
  }

  /** Insert or update a glossary entry. */
  put(entry: GlossaryEntry, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO glossary
           (term, display_en, display_zh, explain_en, explain_zh, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(term) DO UPDATE SET
           display_en = excluded.display_en,
           display_zh = excluded.display_zh,
           explain_en = excluded.explain_en,
           explain_zh = excluded.explain_zh,
           category   = excluded.category`,
      )
      .run(
        entry.term, entry.display_en, entry.display_zh,
        entry.explain_en, entry.explain_zh, entry.category, createdAt,
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

  close(): void {
    this.db.close();
  }
}
