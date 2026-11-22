import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  WorkspaceLeaf,
  ItemView,
} from "obsidian";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface BibleVerse {
  book_id: number;
  chapter: number;
  verse: number;
  words: string;
}

interface Book {
  id: number;
  book: string;
  abbreviation: string;
  chapters: number;
}

interface BibleNote {
  id: number;
  body: string;
  book_id: number | null;
  chapter: number | null;
  verse_start: number | null;
  verse_end: number | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

interface StrongsEntry {
  number: string;   // e.g. "H7225" or "G26"
  lemma: string;    // original language word
  xlit: string;     // transliteration
  pronounce: string;
  description: string;
}

interface BiblePluginSettings {
  dbPath: string;
  defaultTranslation: string;
  insertMode: "cursor" | "clipboard";
  strongsEnabled: boolean;
  readingProperty: string;   // frontmatter key holding a note's Bible reading
}

const DEFAULT_SETTINGS: BiblePluginSettings = {
  dbPath: "",
  defaultTranslation: "bsb",
  insertMode: "clipboard",
  strongsEnabled: true,
  readingProperty: "reading",
};

// URL of the bible.db release asset on GitHub — update this before each release
const BSB_DB_URL = "https://github.com/YOUR_USERNAME/lightworx-bible/releases/latest/download/bible.db";

const VIEW_TYPE = "bible-study-view";

// ─── Database ─────────────────────────────────────────────────────────────────

class BibleDatabase {
  private db: any = null;
  private books: Book[] = [];
  private adapter: any = null;
  private dbVaultPath: string = ""; // vault-relative path e.g. ".obsidian/plugins/lightworx-bible/data/bible.db"

  async load(adapter: any, dbVaultPath: string): Promise<void> {
    this.adapter = adapter;
    this.dbVaultPath = dbVaultPath;

    const initSqlJs = require("sql.js/dist/sql-wasm.js");
    const wasmBinary: Uint8Array = require("./sql-wasm.wasm");
    const SQL = await initSqlJs({ wasmBinary });

    const fileBuffer = await adapter.readBinary(dbVaultPath);
    const bytes = new Uint8Array(fileBuffer);

    // Validate SQLite magic bytes before handing to sql.js
    // A valid SQLite file always starts with "SQLite format 3\0"
    const MAGIC = "SQLite format 3\0";
    const magic = String.fromCharCode(...bytes.slice(0, 16));
    if (magic !== MAGIC) {
      const hex = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, "0")).join(" ");
      throw new Error(
        `Database file is not a valid SQLite file (bad magic bytes: ${hex}). ` +
        `The file (${bytes.length} bytes) may be corrupted or synced incompletely. ` +
        `Please replace bible.db with a fresh copy from your desktop.`
      );
    }

    this.db = new SQL.Database(bytes);
    const migrated = this.ensureNotesSchema();
    if (migrated) await this.saveToDisk();
    this.books = this.fetchBooks();
  }

  isLoaded(): boolean { return this.db !== null; }

  // ── Schema ──────────────────────────────────────────────────────────────────

  /** Returns true if any migration was applied (so caller knows to save) */
  private ensureNotesSchema(): boolean {
    const existing = this.db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='notes'`
    );
    if (existing.length && existing[0].values.length) return false; // already exists

    this.db.run(`
      CREATE TABLE IF NOT EXISTS notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        body        TEXT    NOT NULL DEFAULT '',
        book_id     INTEGER,
        chapter     INTEGER,
        verse_start INTEGER,
        verse_end   INTEGER,
        tags        TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    return true;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  async saveToDisk(): Promise<void> {
    if (!this.db || !this.adapter || !this.dbVaultPath) return;
    try {
      const exported: Uint8Array = this.db.export();
      // Copy into a fresh ArrayBuffer — on mobile the Uint8Array's underlying
      // buffer may be a shared WASM memory buffer with a non-zero byteOffset,
      // which confuses Obsidian's mobile adapter and produces a malformed file.
      const clean = exported.buffer.slice(
        exported.byteOffset,
        exported.byteOffset + exported.byteLength
      );
      await this.adapter.writeBinary(this.dbVaultPath, clean);
    } catch (e: any) {
      console.error("Bible plugin: failed to save DB", e);
    }
  }

  // ── Books ────────────────────────────────────────────────────────────────────

  private fetchBooks(): Book[] {
    if (!this.db) return [];
    const result = this.db.exec("SELECT id, book, abbreviation, chapters FROM books ORDER BY id");
    if (!result.length) return [];
    return result[0].values.map((r: any[]) => ({ id: r[0], book: r[1], abbreviation: r[2], chapters: r[3] }));
  }

  getBookList(): Book[] { return this.books; }

  getChapterCount(bookId: number): number {
    const book = this.books.find((b) => b.id === bookId);
    return book ? book.chapters : 0;
  }

  // ── Verses ───────────────────────────────────────────────────────────────────

  getVerseCount(translation: string, bookId: number, chapter: number): number {
    if (!this.db) return 0;
    const result = this.db.exec(
      `SELECT COUNT(*) FROM ${translation}_verses WHERE book_id = ${bookId} AND chapter = ${chapter}`
    );
    return result.length ? result[0].values[0][0] : 0;
  }

  /** Verses from (startChapter:startVerse) through (endChapter:endVerse), crossing chapter boundaries */
  getPassageRange(translation: string, bookId: number, startChapter: number, startVerse: number, endChapter: number, endVerse: number): BibleVerse[] {
    if (!this.db) return [];
    const n = (x: number) => Math.trunc(Number(x));   // all values are numeric — keep them that way
    const res = this.db.exec(
      `SELECT book_id, chapter, verse, words FROM ${translation}_verses
       WHERE book_id = ${n(bookId)}
         AND (chapter > ${n(startChapter)} OR (chapter = ${n(startChapter)} AND verse >= ${n(startVerse)}))
         AND (chapter < ${n(endChapter)}   OR (chapter = ${n(endChapter)}   AND verse <= ${n(endVerse)}))
       ORDER BY chapter, verse`
    );
    if (!res.length) return [];
    return res[0].values.map((r: any[]) => ({ book_id: r[0], chapter: r[1], verse: r[2], words: r[3] }));
  }

  getPassage(translation: string, bookId: number, chapter: number, startVerse: number, endVerse: number): BibleVerse[] {
    if (!this.db) return [];
    const result = this.db.exec(
      `SELECT book_id, chapter, verse, words FROM ${translation}_verses
       WHERE book_id = ${bookId} AND chapter = ${chapter}
       AND verse >= ${startVerse} AND verse <= ${endVerse}
       ORDER BY verse`
    );
    if (!result.length) return [];
    return result[0].values.map((r: any[]) => ({ book_id: r[0], chapter: r[1], verse: r[2], words: r[3] }));
  }

  searchWords(translation: string, query: string, limit = 50): (BibleVerse & { book_name: string })[] {
    if (!this.db || !query.trim()) return [];
    const safe = query.replace(/'/g, "''");
    const result = this.db.exec(
      `SELECT v.book_id, v.chapter, v.verse, v.words, b.book as book_name
       FROM ${translation}_verses v JOIN books b ON b.id = v.book_id
       WHERE v.words LIKE '%${safe}%'
       ORDER BY v.book_id, v.chapter, v.verse LIMIT ${limit}`
    );
    if (!result.length) return [];
    return result[0].values.map((r: any[]) => ({
      book_id: r[0], chapter: r[1], verse: r[2], words: r[3], book_name: r[4]
    }));
  }

  // ── Notes CRUD ───────────────────────────────────────────────────────────────

  async createNote(note: Omit<BibleNote, "id" | "created_at" | "updated_at">): number {
    if (!this.db) return -1;
    const { body, book_id, chapter, verse_start, verse_end, tags } = note;
    const safe = (s: string | null) => s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`;
    const num = (n: number | null) => n === null ? "NULL" : String(n);
    this.db.run(
      `INSERT INTO notes (body, book_id, chapter, verse_start, verse_end, tags)
       VALUES (${safe(body)}, ${num(book_id)}, ${num(chapter)}, ${num(verse_start)}, ${num(verse_end)}, ${safe(tags)})`
    );
    const res = this.db.exec("SELECT last_insert_rowid()");
    const id = res[0].values[0][0] as number;
    await this.saveToDisk();
    return id;
  }

  async updateNote(id: number, body: string, tags: string | null): void {
    if (!this.db) return;
    const safeBody = body.replace(/'/g, "''");
    const safeTags = tags === null ? "NULL" : `'${tags.replace(/'/g, "''")}'`;
    this.db.run(
      `UPDATE notes SET body = '${safeBody}', tags = ${safeTags}, updated_at = datetime('now') WHERE id = ${id}`
    );
    await this.saveToDisk();
  }

  async deleteNote(id: number): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM notes WHERE id = ${id}`);
    await this.saveToDisk();
  }

  getNoteById(id: number): BibleNote | null {
    if (!this.db) return null;
    const res = this.db.exec(
      `SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at FROM notes WHERE id = ${id}`
    );
    if (!res.length || !res[0].values.length) return null;
    return this.rowToNote(res[0].values[0]);
  }

  // Returns notes whose scope covers the given verse.
  // A note scoped to a chapter covers all its verses; a book note covers all chapters, etc.
  getNotesForVerse(bookId: number, chapter: number, verse: number): BibleNote[] {
    if (!this.db) return [];
    const res = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE
        (book_id IS NULL) OR
        (book_id = ${bookId} AND chapter IS NULL) OR
        (book_id = ${bookId} AND chapter = ${chapter} AND verse_start IS NULL) OR
        (book_id = ${bookId} AND chapter = ${chapter}
          AND verse_start <= ${verse}
          AND (verse_end IS NULL OR verse_end >= ${verse}))
      ORDER BY updated_at DESC
    `);
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  getNotesForPassage(bookId: number, chapter: number, startVerse: number, endVerse: number): BibleNote[] {
    if (!this.db) return [];
    const res = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE
        (book_id IS NULL) OR
        (book_id = ${bookId} AND chapter IS NULL) OR
        (book_id = ${bookId} AND chapter = ${chapter} AND verse_start IS NULL) OR
        (book_id = ${bookId} AND chapter = ${chapter}
          AND verse_start <= ${endVerse}
          AND (verse_end IS NULL OR verse_end >= ${startVerse}))
      ORDER BY updated_at DESC
    `);
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  /** Split notes for a passage into three independent scope tiers. */
  getPassageNotesByScope(bookId: number, chapter: number, startVerse: number, endVerse: number): {
    bookNotes: BibleNote[];
    chapterNotes: BibleNote[];
    verseNotes: Map<number, BibleNote[]>;
  } {
    if (!this.db) return { bookNotes: [], chapterNotes: [], verseNotes: new Map() };

    // Book-level: chapter IS NULL (and not whole-Bible, which we ignore here)
    const bookRes = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE book_id = ${bookId} AND chapter IS NULL
      ORDER BY updated_at DESC
    `);
    const bookNotes: BibleNote[] = bookRes.length ? bookRes[0].values.map(this.rowToNote) : [];

    // Chapter-level: chapter matches AND verse_start IS NULL
    const chapRes = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE book_id = ${bookId} AND chapter = ${chapter} AND verse_start IS NULL
      ORDER BY updated_at DESC
    `);
    const chapterNotes: BibleNote[] = chapRes.length ? chapRes[0].values.map(this.rowToNote) : [];

    // Verse-level: verse_start IS NOT NULL, overlapping the displayed range
    const verseRes = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE book_id = ${bookId} AND chapter = ${chapter}
        AND verse_start IS NOT NULL
        AND verse_start <= ${endVerse}
        AND (verse_end IS NULL OR verse_end >= ${startVerse})
      ORDER BY verse_start ASC, updated_at DESC
    `);
    const verseNotes = new Map<number, BibleNote[]>();
    if (verseRes.length) {
      verseRes[0].values.forEach((r: any[]) => {
        const note = this.rowToNote(r);
        const vs = note.verse_start!;
        const ve = note.verse_end ?? vs;
        // Attach this note to every verse number it covers within the displayed range
        for (let vn = Math.max(vs, startVerse); vn <= Math.min(ve, endVerse); vn++) {
          if (!verseNotes.has(vn)) verseNotes.set(vn, []);
          verseNotes.get(vn)!.push(note);
        }
      });
    }

    return { bookNotes, chapterNotes, verseNotes };
  }

  getNotesForBook(bookId: number): BibleNote[] {
    if (!this.db) return [];
    const res = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes WHERE book_id = ${bookId}
      ORDER BY chapter ASC, verse_start ASC, updated_at DESC
    `);
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  getAllNotes(): BibleNote[] {
    if (!this.db) return [];
    const res = this.db.exec(
      `SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
       FROM notes ORDER BY updated_at DESC`
    );
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  getAllNotesBiblical(): BibleNote[] {
    if (!this.db) return [];
    const res = this.db.exec(
      `SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
       FROM notes
       ORDER BY
         CASE WHEN book_id IS NULL THEN 0 ELSE 1 END ASC,
         COALESCE(book_id, 0) ASC,
         CASE WHEN chapter IS NULL THEN 0 ELSE 1 END ASC,
         COALESCE(chapter, 0) ASC,
         CASE WHEN verse_start IS NULL THEN 0 ELSE 1 END ASC,
         COALESCE(verse_start, 0) ASC`
    );
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  searchNotesBiblical(query: string): BibleNote[] {
    if (!this.db || !query.trim()) return [];
    const safe = query.replace(/'/g, "''");
    const res = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE body LIKE '%${safe}%' OR tags LIKE '%${safe}%'
      ORDER BY
        CASE WHEN book_id IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(book_id, 0) ASC,
        CASE WHEN chapter IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(chapter, 0) ASC,
        CASE WHEN verse_start IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(verse_start, 0) ASC
    `);
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  getNotesForPassageBiblical(bookId: number, chapter: number, startVerse: number, endVerse: number): BibleNote[] {
    if (!this.db) return [];
    const res = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE
        (book_id = ${bookId} AND chapter IS NULL) OR
        (book_id = ${bookId} AND chapter = ${chapter} AND verse_start IS NULL) OR
        (book_id = ${bookId} AND chapter = ${chapter}
          AND verse_start IS NOT NULL
          AND verse_start <= ${endVerse}
          AND (verse_end IS NULL OR verse_end >= ${startVerse}))
      ORDER BY
        CASE WHEN chapter IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(chapter, 0) ASC,
        CASE WHEN verse_start IS NULL THEN 0 ELSE 1 END ASC,
        COALESCE(verse_start, 0) ASC
    `);
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  searchNotes(query: string): BibleNote[] {
    if (!this.db || !query.trim()) return [];
    const safe = query.replace(/'/g, "''");
    const res = this.db.exec(`
      SELECT id, body, book_id, chapter, verse_start, verse_end, tags, created_at, updated_at
      FROM notes
      WHERE body LIKE '%${safe}%' OR tags LIKE '%${safe}%'
      ORDER BY updated_at DESC
    `);
    if (!res.length) return [];
    return res[0].values.map(this.rowToNote);
  }

  private rowToNote(r: any[]): BibleNote {
    return {
      id: r[0], body: r[1], book_id: r[2], chapter: r[3],
      verse_start: r[4], verse_end: r[5], tags: r[6],
      created_at: r[7], updated_at: r[8],
    };
  }

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }

  // ── Import ───────────────────────────────────────────────────────────────────

  /** Returns list of translation slugs that already have a verses table */
  getInstalledTranslations(): string[] {
    if (!this.db) return [];
    const res = this.db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_verses'`
    );
    if (!res.length) return [];
    return res[0].values.map((r: any[]) => (r[0] as string).replace("_verses", ""));
  }

  /** Alias used by UI — same as getInstalledTranslations but always returns at least [] */
  getTranslations(): string[] {
    return this.getInstalledTranslations();
  }

  async importTranslation(
    slug: string,
    rows: { book_id: number; chapter: number; verse: number; words: string; tagged?: string; strongs_list?: string }[],
    onProgress: (pct: number) => void
  ): void {
    if (!this.db) throw new Error("Database not loaded");
    const table = `${slug.toLowerCase()}_verses`;
    const hasTagging = rows.some(r => r.tagged);

    this.db.run(`DROP TABLE IF EXISTS ${table}`);
    this.db.run(`
      CREATE TABLE ${table} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL,
        chapter      INTEGER,
        verse        INTEGER,
        words        TEXT,
        tagged       TEXT,
        strongs_list TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_${slug}_book_ch ON ${table}(book_id, chapter)`);
    if (hasTagging) {
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_${slug}_strongs ON ${table}(strongs_list)`);
    }

    const BATCH = 500;
    const total = rows.length;
    for (let i = 0; i < total; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const stmt = this.db.prepare(
        `INSERT INTO ${table} (book_id, chapter, verse, words, tagged, strongs_list) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const r of batch) {
        stmt.run([r.book_id, r.chapter, r.verse, r.words, r.tagged ?? null, r.strongs_list ?? null]);
      }
      stmt.free();
      onProgress(Math.round(((i + batch.length) / total) * 100));
    }
    await this.saveToDisk();
  }

  async deleteTranslation(slug: string): void {
    if (!this.db) return;
    this.db.run(`DROP TABLE IF EXISTS ${slug.toLowerCase()}_verses`);
    await this.saveToDisk();
  }

  // ── Strong's Numbers ─────────────────────────────────────────────────────────

  hasStrongsTable(): boolean {
    if (!this.db) return false;
    try {
      const res = this.db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='strongs'`);
      return res.length > 0 && res[0].values.length > 0;
    } catch { return false; }
  }

  getStrongsEntry(number: string): StrongsEntry | null {
    if (!this.db) return null;
    try {
      const safe = number.replace(/'/g, "''");
      const res = this.db.exec(
        `SELECT number, lemma, xlit, pronounce, description FROM strongs WHERE number = '${safe}'`
      );
      if (!res.length || !res[0].values.length) return null;
      const r = res[0].values[0];
      return { number: r[0], lemma: r[1], xlit: r[2], pronounce: r[3], description: r[4] };
    } catch (e: any) {
      // Likely wrong column names — surface a helpful error
      throw new Error(`Strongs lookup failed: ${e?.message ?? e}. Check that your strongs table has columns: number, lemma, xlit, pronounce, description`);
    }
  }

  /** All verses in a translation that contain a given Strong's number */
  getVersesByStrongs(number: string, translation: string, limit = 200): (BibleVerse & { book_name: string })[] {
    if (!this.db) return [];
    const table = `${translation.toLowerCase()}_verses`;
    const safe = number.replace(/'/g, "''");

    // Try strongs_list column first (fast index-friendly search)
    try {
      const res = this.db.exec(
        `SELECT v.book_id, v.chapter, v.verse, v.words, b.book as book_name
         FROM ${table} v JOIN books b ON b.id = v.book_id
         WHERE v.strongs_list LIKE '% ${safe} %'
            OR v.strongs_list LIKE '${safe} %'
            OR v.strongs_list LIKE '% ${safe}'
            OR v.strongs_list = '${safe}'
         ORDER BY v.book_id, v.chapter, v.verse LIMIT ${limit}`
      );
      if (res.length) {
        return res[0].values.map((r: any[]) => ({
          book_id: r[0], chapter: r[1], verse: r[2], words: r[3], book_name: r[4],
        }));
      }
      return [];
    } catch {
      // strongs_list column missing — fall back to searching the tagged column
    }

    // Fallback: search tagged column for [H1234] or [G1234] pattern
    try {
      const res = this.db.exec(
        `SELECT v.book_id, v.chapter, v.verse, v.words, b.book as book_name
         FROM ${table} v JOIN books b ON b.id = v.book_id
         WHERE v.tagged LIKE '%[${safe}]%'
         ORDER BY v.book_id, v.chapter, v.verse LIMIT ${limit}`
      );
      if (!res.length) return [];
      return res[0].values.map((r: any[]) => ({
        book_id: r[0], chapter: r[1], verse: r[2], words: r[3], book_name: r[4],
      }));
    } catch { return []; }
  }

  /** Parse tagged verse text into tokens [{text, strongs}] */
  static parseTaggedText(tagged: string): { text: string; strongs: string | null }[] {
    const tokens: { text: string; strongs: string | null }[] = [];
    const parts = tagged.split(/\[([HG]\d+)\]/);
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i].trim();
      if (!text) continue;
      if (i + 1 < parts.length && /^[HG]\d+$/.test(parts[i + 1])) {
        tokens.push({ text, strongs: parts[i + 1] });
        i++; // skip the strongs number
      } else if (!/^[HG]\d+$/.test(text)) {
        tokens.push({ text, strongs: null });
      }
    }
    return tokens;
  }

  /** Get the tagged verse text for a single verse (returns null if no tagged data) */
  getTaggedVerse(translation: string, bookId: number, chapter: number, verse: number): string | null {
    if (!this.db) return null;
    const table = `${translation.toLowerCase()}_verses`;
    const res = this.db.exec(
      `SELECT tagged FROM ${table} WHERE book_id = ${bookId} AND chapter = ${chapter} AND verse = ${verse}`
    );
    if (!res.length || !res[0].values.length) return null;
    return res[0].values[0][0] as string | null;
  }

  /** Returns true if this translation has any tagged verses */
  translationHasTagging(translation: string): boolean {
    if (!this.db) return false;
    const table = `${translation.toLowerCase()}_verses`;
    try {
      const res = this.db.exec(
        `SELECT 1 FROM ${table} WHERE tagged IS NOT NULL LIMIT 1`
      );
      return res.length > 0 && res[0].values.length > 0;
    } catch { return false; }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Reference parsing ────────────────────────────────────────────────────────
// Understands (readings are separated by ";" or a new line, each with its own book):
//   John 3:16               a single verse
//   John 1:1-3,5,6-8        verses and ranges within one chapter
//   John 1:1-5,2:3-6,7,3:10 an item like "2:3" switches chapter; bare numbers after it are verses of that chapter
//   John 1:51-2:2           a range that crosses a chapter boundary
//   Psalm 1  /  Psalm 1-3   whole chapter(s)
//   Jude 5-7                one-chapter books take bare verse numbers
//   Psalm 3:4-5 NIV         optional trailing translation (applies to every reading without its own)

const END_OF_CHAPTER = 999;

interface RefSegment {
  startChapter: number;
  startVerse: number;
  endChapter: number;
  endVerse: number;      // END_OF_CHAPTER = through the last verse of endChapter
}

interface ParsedReading {
  book: Book;
  translation: string;
  segments: RefSegment[];
}

type ParseResult =
  | { ok: true; readings: ParsedReading[] }
  | { ok: false; error: string };

interface ResolvedReading {
  heading: string;       // e.g. "John 1:1–3, 5 (NIV)"
  translation: string;
  bookId: number;
  segments: RefSegment[];
  verses: BibleVerse[];
}

/** Parse the part after the book name, e.g. "1:1-5,2:3-6,7,3:10". Throws Error with a readable message. */
function parseSegments(body: string, book: Book): RefSegment[] {
  const segments: RefSegment[] = [];
  // In a one-chapter book (Jude, Obadiah, Philemon, 2 & 3 John) bare numbers are verses
  let currentChapter: number | null = book.chapters === 1 ? 1 : null;

  for (const rawToken of body.split(",")) {
    const token = rawToken.trim();
    if (!token) throw new Error(`There is an empty item between commas in "${body.trim()}".`);

    // ch:v   ch:v-v   ch:v-ch:v
    let m = token.match(/^(\d+):(\d+)(?:\s*[-–—]\s*(?:(\d+):)?(\d+))?$/);
    if (m) {
      const startChapter = parseInt(m[1]);
      const startVerse = parseInt(m[2]);
      const endChapter = m[3] ? parseInt(m[3]) : startChapter;
      const endVerse = m[4] ? parseInt(m[4]) : startVerse;
      segments.push({ startChapter, startVerse, endChapter, endVerse });
      currentChapter = endChapter;
      continue;
    }

    // n   n-n  → verses once we are inside a chapter, otherwise whole chapters
    m = token.match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
    if (m) {
      const a = parseInt(m[1]);
      const b = m[2] ? parseInt(m[2]) : a;
      if (currentChapter !== null) {
        segments.push({ startChapter: currentChapter, startVerse: a, endChapter: currentChapter, endVerse: b });
      } else {
        segments.push({ startChapter: a, startVerse: 1, endChapter: b, endVerse: END_OF_CHAPTER });
      }
      continue;
    }

    throw new Error(`Couldn't understand "${token}".`);
  }

  for (const s of segments) {
    if (s.startChapter < 1 || s.endChapter < 1 || s.startChapter > book.chapters || s.endChapter > book.chapters) {
      throw new Error(`${book.book} has only ${book.chapters} chapter${book.chapters === 1 ? "" : "s"}.`);
    }
    if (s.startVerse < 1 || s.endVerse < 1) throw new Error("Verse numbers start at 1.");
    const backwards = s.startChapter > s.endChapter ||
      (s.startChapter === s.endChapter && s.startVerse > s.endVerse);
    if (backwards) throw new Error(`"${formatSegments([s])}" runs backwards.`);
  }
  return segments;
}

function parseReferences(raw: string, books: Book[], defaultTranslation: string, translations: string[], ignoreUnknownTranslation = false): ParseResult {
  const cleaned = raw.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
  if (!cleaned) return { ok: false, error: "Type a reference, e.g. John 3:16." };

  const known = translations.map((t) => t.toLowerCase());
  const parts = cleaned.split(/[;\n]+/).map((p) => p.trim()).filter(Boolean);
  const REF_SHAPE = /^(.+?)\s+(\d[\d:,\s\-–—]*)$/;   // "<book> <numbers>"
  const drafts: { book: Book; segments: RefSegment[]; translation: string | null }[] = [];

  for (const part of parts) {
    let translation: string | null = null;
    let m = part.match(REF_SHAPE);

    // Optional trailing translation, e.g. "John 3:16 NIV"
    if (!m) {
      const tm = part.match(/^(.+?)\s+([A-Za-z][A-Za-z0-9]*)$/);
      const inner = tm ? tm[1].match(REF_SHAPE) : null;
      if (tm && inner) {
        translation = tm[2].toLowerCase();
        if (!known.includes(translation) && !ignoreUnknownTranslation) return { ok: false, error: `Translation "${tm[2]}" isn't installed.` };
        m = inner;
      }
    }
    if (!m) return { ok: false, error: `Couldn't read "${part}" as a Bible reference.` };

    const bookQuery = m[1].trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
    const book =
      books.find((b) => b.book.toLowerCase() === bookQuery) ??
      books.find((b) => b.abbreviation.toLowerCase().replace(/\./g, "") === bookQuery) ??
      books.find((b) => b.book.toLowerCase().startsWith(bookQuery));
    if (!book) return { ok: false, error: `Unknown book "${m[1].trim()}".` };

    try {
      drafts.push({ book, segments: parseSegments(m[2], book), translation });
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
  if (!drafts.length) return { ok: false, error: "Type a reference, e.g. John 3:16." };

  // A translation on the final reading applies to every reading that has none of its own
  const shared = drafts[drafts.length - 1].translation ?? defaultTranslation.toLowerCase();
  const readings: ParsedReading[] = drafts.map((d) => ({
    book: d.book, segments: d.segments, translation: d.translation ?? shared,
  }));
  const missing = ignoreUnknownTranslation ? undefined : readings.find((r) => !known.includes(r.translation));
  if (missing) return { ok: false, error: `Translation "${missing.translation.toUpperCase()}" isn't installed.` };
  return { ok: true, readings };
}

/** "1:1–5; 2:3–6, 7; 3:10" — commas within a chapter, semicolons between chapters */
function formatSegments(segments: RefSegment[]): string {
  let out = "";
  let joinChapter: number | null = null;   // chapter a following bare verse would belong to
  segments.forEach((s, i) => {
    const endV = (v: number) => (v === END_OF_CHAPTER ? "end" : String(v));
    let text: string;
    let comma = false;
    if (s.startVerse === 1 && s.endVerse === END_OF_CHAPTER) {
      text = s.startChapter === s.endChapter ? `${s.startChapter}` : `${s.startChapter}–${s.endChapter}`;
      joinChapter = null;
    } else if (s.startChapter === s.endChapter) {
      const verses = s.startVerse === s.endVerse ? `${s.startVerse}` : `${s.startVerse}–${endV(s.endVerse)}`;
      if (joinChapter === s.startChapter) { text = verses; comma = true; }
      else text = `${s.startChapter}:${verses}`;
      joinChapter = s.startChapter;
    } else {
      text = `${s.startChapter}:${s.startVerse}–${s.endChapter}:${endV(s.endVerse)}`;
      joinChapter = s.endChapter;
    }
    if (i > 0) out += comma ? ", " : "; ";
    out += text;
  });
  return out;
}

/** Verse labels: plain verse numbers, switching to "ch:v" whenever the chapter changes */
function labelVerses(verses: BibleVerse[]): { label: string; v: BibleVerse }[] {
  let prevChapter: number | null = null;
  return verses.map((v) => {
    const label = prevChapter !== null && v.chapter !== prevChapter ? `${v.chapter}:${v.verse}` : String(v.verse);
    prevChapter = v.chapter;
    return { label, v };
  });
}

/** Plain-text form used for clipboard / insertion */
function readingToText(r: ResolvedReading): string {
  const body = labelVerses(r.verses).map(({ label, v }) => `${label} ${v.words}`).join(" ");
  return `${r.heading}\n${body}`;
}
/** The one-chapter range the Passage tab can show for a reading: its first chapter, from the earliest to the latest verse it uses there */
function sidebarRangeFor(segments: RefSegment[]): { chapter: number; startVerse: number; endVerse: number } {
  const chapter = segments[0].startChapter;
  let startVerse = Infinity;
  let endVerse = 0;
  for (const s of segments) {
    if (chapter < s.startChapter || chapter > s.endChapter) continue;
    startVerse = Math.min(startVerse, s.startChapter === chapter ? s.startVerse : 1);
    endVerse = Math.max(endVerse, s.endChapter === chapter ? s.endVerse : END_OF_CHAPTER);
  }
  return { chapter, startVerse, endVerse };
}
// ─── end reference parsing ────────────────────────────────────────────────────

// ─── Passage usage index ──────────────────────────────────────────────────────
// Finds the notes whose reading overlaps a passage, e.g. searching John 1:5 finds a note reading John 1:1-18.

interface IndexedReading {
  bookId: number;
  segments: RefSegment[];
  label: string;                      // e.g. "John 1:1–18"
  source: "property" | "block";       // where in the note the reading came from
}

interface IndexedNote {
  path: string;
  mtime: number;
  readings: IndexedReading[];         // empty when the note has no readings
}

type Relation = "same" | "includes" | "within" | "overlaps";
interface UsageMatch { label: string; relation: Relation; source: "property" | "block" }
interface UsageHit { path: string; mtime: number; matches: UsageMatch[]; rank: number }

const RELATION_RANK: Record<Relation, number> = { same: 0, includes: 1, within: 2, overlaps: 3 };
const RELATION_TEXT: Record<Relation, string> = {
  same: "same passage",
  includes: "includes this passage",
  within: "inside this passage",
  overlaps: "overlaps",
};

/** A frontmatter value as a reference string; a YAML list becomes "a; b" so its items are separate readings */
function refValueToString(x: any): string | null {
  if (x === undefined || x === null || x === "") return null;
  return Array.isArray(x) ? x.map(String).join("; ") : String(x);
}

/** The text of every ```bible block in a note */
function extractBibleBlocks(content: string): string[] {
  const blocks: string[] = [];
  const re = /^[ \t]*```bible[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1].trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

/** Every reading in a note: the reading property plus any ```bible blocks in the body */
function collectNoteReadings(
  content: string | null, frontmatter: any, property: string,
  books: Book[], defaultTranslation: string, translations: string[]
): IndexedReading[] {
  const out: IndexedReading[] = [];
  const done = new Set<string>();

  const add = (raw: string | null, source: "property" | "block") => {
    const text = raw?.trim();
    if (!text || done.has(text)) return;     // a frontmatter:reading block repeats the property
    done.add(text);
    const parsed = parseReferences(text, books, defaultTranslation, translations, true);
    if (!parsed.ok) return;
    for (const r of parsed.readings) {
      out.push({ bookId: r.book.id, segments: r.segments, label: `${r.book.book} ${formatSegments(r.segments)}`, source });
    }
  };

  add(refValueToString(frontmatter?.[property]), "property");
  if (content) {
    for (const src of extractBibleBlocks(content)) {
      const fm = src.match(/^frontmatter:(.+)$/i);
      add(fm ? refValueToString(frontmatter?.[fm[1].trim()]) : src, "block");
    }
  }
  return out;
}

function cmpPos(c1: number, v1: number, c2: number, v2: number): number {
  return c1 !== c2 ? c1 - c2 : v1 - v2;
}

function segmentsOverlap(a: RefSegment, b: RefSegment): boolean {
  return cmpPos(a.startChapter, a.startVerse, b.endChapter, b.endVerse) <= 0 &&
         cmpPos(b.startChapter, b.startVerse, a.endChapter, a.endVerse) <= 0;
}

/** How a note's passage relates to the one being searched for */
function segmentRelation(note: RefSegment, query: RefSegment): Relation {
  const s = cmpPos(note.startChapter, note.startVerse, query.startChapter, query.startVerse);
  const e = cmpPos(note.endChapter, note.endVerse, query.endChapter, query.endVerse);
  if (s === 0 && e === 0) return "same";
  if (s <= 0 && e >= 0) return "includes";
  if (s >= 0 && e <= 0) return "within";
  return "overlaps";
}

function findUsage(notes: Iterable<IndexedNote>, query: ParsedReading[]): UsageHit[] {
  const hits: UsageHit[] = [];
  for (const note of notes) {
    const matches: UsageMatch[] = [];
    for (const r of note.readings) {
      let best: Relation | null = null;
      for (const q of query) {
        if (q.book.id !== r.bookId) continue;
        for (const qs of q.segments) {
          for (const rs of r.segments) {
            if (!segmentsOverlap(rs, qs)) continue;
            const rel = segmentRelation(rs, qs);
            if (best === null || RELATION_RANK[rel] < RELATION_RANK[best]) best = rel;
          }
        }
      }
      if (best) matches.push({ label: r.label, relation: best, source: r.source });
    }
    if (matches.length) {
      hits.push({ path: note.path, mtime: note.mtime, matches, rank: Math.min(...matches.map((m) => RELATION_RANK[m.relation])) });
    }
  }
  // closest matches first, then most recently edited
  hits.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime);
  return hits;
}
// ─── end passage usage index ──────────────────────────────────────────────────

/** Human-readable scope label for a note, e.g. "John 3:16–18" or "Romans (whole book)" */
function noteRefLabel(note: BibleNote, books: Book[]): string {
  if (note.book_id === null) return "Whole Bible";
  const book = books.find((b) => b.id === note.book_id);
  const bookName = book?.book ?? `Book ${note.book_id}`;
  if (note.chapter === null) return `${bookName} (whole book)`;
  if (note.verse_start === null) return `${bookName} ${note.chapter} (whole chapter)`;
  const end = note.verse_end !== null && note.verse_end !== note.verse_start
    ? `–${note.verse_end}` : "";
  return `${bookName} ${note.chapter}:${note.verse_start}${end}`;
}

/** Format a date string as a short relative label */
function shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}

// ─── Note Modal ───────────────────────────────────────────────────────────────

interface NoteModalPrefill {
  book_id: number | null;
  bookName: string;
  chapter: number | null;
  verse_start: number | null;
  verse_end: number | null;
}

class BibleNoteModal extends Modal {
  private plugin: BibleStudyPlugin;
  private existingNote: BibleNote | null;
  private prefill: NoteModalPrefill | null;
  private onSave: () => void;

  constructor(
    app: App,
    plugin: BibleStudyPlugin,
    onSave: () => void,
    existingNote: BibleNote | null = null,
    prefill: NoteModalPrefill | null = null,
  ) {
    super(app);
    this.plugin = plugin;
    this.existingNote = existingNote;
    this.prefill = prefill;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("bible-note-modal");

    const isEditing = this.existingNote !== null;
    contentEl.createEl("h3", {
      text: isEditing ? "Edit Note" : "New Note",
      cls: "bible-modal-title",
    });

    // ── Scope section ──────────────────────────────────────────────────────────
    contentEl.createEl("p", { text: "Link this note to:", cls: "bible-label" });

    const books = this.plugin.db.getBookList();

    const scopeRow = contentEl.createDiv("bible-note-scope-row");

    // Scope type selector
    const scopeSel = scopeRow.createEl("select", { cls: "bible-select" });
    [
      { value: "none",    text: "No specific reference" },
      { value: "book",    text: "Whole book" },
      { value: "chapter", text: "Chapter" },
      { value: "verse",   text: "Verse / range" },
    ].forEach(({ value, text }) => scopeSel.createEl("option", { value, text }));

    // Sub-controls container (shown/hidden based on scope)
    const subControls = contentEl.createDiv("bible-note-sub-controls");

    // Book selector
    const bookRow = subControls.createDiv("bible-row");
    bookRow.createEl("label", { text: "Book", cls: "bible-label" });
    const bookSel = bookRow.createEl("select", { cls: "bible-select" });
    books.forEach((b) => bookSel.createEl("option", { text: b.book, value: String(b.id) }));

    // Chapter row
    const chapterRow = subControls.createDiv("bible-row");
    chapterRow.createEl("label", { text: "Chapter", cls: "bible-label" });
    const chapterSel = chapterRow.createEl("select", { cls: "bible-select-sm" });

    // Verse range row
    const verseRow = subControls.createDiv("bible-row bible-row-inline");
    verseRow.createEl("label", { text: "Verses", cls: "bible-label" });
    const verseStartSel = verseRow.createEl("select", { cls: "bible-select-sm" });
    verseRow.createEl("span", { text: "–", cls: "bible-dash" });
    const verseEndSel = verseRow.createEl("select", { cls: "bible-select-sm" });

    const populateChapters = () => {
      const bookId = parseInt(bookSel.value);
      const count = this.plugin.db.getChapterCount(bookId);
      chapterSel.empty();
      for (let i = 1; i <= count; i++) chapterSel.createEl("option", { text: String(i), value: String(i) });
      populateVerses();
    };

    const populateVerses = () => {
      const bookId = parseInt(bookSel.value);
      const chapter = parseInt(chapterSel.value);
      const count = this.plugin.db.getVerseCount(this.plugin.settings.defaultTranslation, bookId, chapter);
      verseStartSel.empty(); verseEndSel.empty();
      for (let i = 1; i <= count; i++) {
        verseStartSel.createEl("option", { text: String(i), value: String(i) });
        verseEndSel.createEl("option", { text: String(i), value: String(i) });
      }
      verseEndSel.value = String(count);
    };

    bookSel.onchange = populateChapters;
    chapterSel.onchange = populateVerses;
    populateChapters();

    const applyScope = (scope: string) => {
      subControls.style.display = scope === "none" ? "none" : "";
      chapterRow.style.display = (scope === "chapter" || scope === "verse") ? "" : "none";
      verseRow.style.display = scope === "verse" ? "" : "none";
    };
    scopeSel.onchange = () => applyScope(scopeSel.value);

    // ── Pre-fill values ────────────────────────────────────────────────────────
    const source = isEditing ? this.existingNote! : null;
    const pf = this.prefill;

    if (source) {
      if (source.book_id === null) {
        scopeSel.value = "none";
      } else if (source.chapter === null) {
        scopeSel.value = "book";
        bookSel.value = String(source.book_id);
        populateChapters();
      } else if (source.verse_start === null) {
        scopeSel.value = "chapter";
        bookSel.value = String(source.book_id);
        populateChapters();
        chapterSel.value = String(source.chapter);
        populateVerses();
      } else {
        scopeSel.value = "verse";
        bookSel.value = String(source.book_id);
        populateChapters();
        chapterSel.value = String(source.chapter);
        populateVerses();
        verseStartSel.value = String(source.verse_start);
        verseEndSel.value = String(source.verse_end ?? source.verse_start);
      }
    } else if (pf) {
      if (pf.book_id !== null) {
        bookSel.value = String(pf.book_id);
        populateChapters();
        if (pf.chapter !== null) {
          chapterSel.value = String(pf.chapter);
          populateVerses();
          if (pf.verse_start !== null) {
            scopeSel.value = "verse";
            verseStartSel.value = String(pf.verse_start);
            verseEndSel.value = String(pf.verse_end ?? pf.verse_start);
          } else {
            scopeSel.value = "chapter";
          }
        } else {
          scopeSel.value = "book";
        }
      }
    }
    applyScope(scopeSel.value);

    // ── Note body ──────────────────────────────────────────────────────────────
    contentEl.createEl("label", { text: "Note", cls: "bible-label" });
    const textarea = contentEl.createEl("textarea", { cls: "bible-note-textarea" });
    textarea.value = source?.body ?? "";
    textarea.rows = 8;

    // ── Tags ───────────────────────────────────────────────────────────────────
    contentEl.createEl("label", { text: "Tags (comma-separated)", cls: "bible-label" });
    const tagsInput = contentEl.createEl("input", {
      type: "text",
      cls: "bible-modal-input",
      placeholder: "e.g. grace, faith, sermon",
    });
    tagsInput.value = source?.tags ?? "";

    // ── Buttons ────────────────────────────────────────────────────────────────
    const btnRow = contentEl.createDiv("bible-note-btn-row");

    if (isEditing) {
      const deleteBtn = btnRow.createEl("button", { text: "Delete", cls: "bible-btn bible-btn-danger" });
      deleteBtn.onclick = () => {
        this.plugin.db.deleteNote(this.existingNote!.id);
        new Notice("Note deleted.");
        this.onSave();
        this.close();
      };
    }

    const saveBtn = btnRow.createEl("button", {
      text: isEditing ? "Save Changes" : "Save Note",
      cls: "bible-btn",
    });
    saveBtn.onclick = () => {
      const body = textarea.value.trim();
      if (!body) { new Notice("Note body cannot be empty."); return; }

      const scope = scopeSel.value;
      const book_id   = scope !== "none" ? parseInt(bookSel.value) : null;
      const chapter   = (scope === "chapter" || scope === "verse") ? parseInt(chapterSel.value) : null;
      const verse_start = scope === "verse" ? parseInt(verseStartSel.value) : null;
      const verse_end   = scope === "verse" ? parseInt(verseEndSel.value) : null;
      const tags = tagsInput.value.trim() || null;

      if (isEditing) {
        // Update scope as well as body/tags
        this.plugin.db.db.run(
          `UPDATE notes SET body = ?, book_id = ?, chapter = ?, verse_start = ?, verse_end = ?, tags = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [body, book_id, chapter, verse_start, verse_end, tags, this.existingNote!.id]
        );
        this.plugin.db.saveToDisk();
        new Notice("Note saved.");
      } else {
        this.plugin.db.createNote({ body, book_id, chapter, verse_start, verse_end, tags });
        new Notice("Note created.");
      }

      this.onSave();
      this.close();
    };

    setTimeout(() => textarea.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

// ─── Quick Insert Modal ───────────────────────────────────────────────────────

class BibleQuickInsertModal extends Modal {
  private plugin: BibleStudyPlugin;
  private editor: Editor;

  constructor(app: App, plugin: BibleStudyPlugin, editor: Editor) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Insert Bible Passage", cls: "bible-modal-title" });
    contentEl.createEl("p", {
      text: 'Type a reference, e.g.  John 3:16 · Romans 8:1-4 NIV · John 1:1-3,5 · Psalm 1 · John 1:1-10; Psalm 3:4-5',
      cls: "bible-modal-hint",
    });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "John 3:16 NIV",
      cls: "bible-modal-input",
    });

    const feedback = contentEl.createEl("p", { cls: "bible-modal-feedback" });
    const preview = contentEl.createDiv("bible-modal-preview");

    const insertBtn = contentEl.createEl("button", {
      text: this.plugin.settings.insertMode === "clipboard" ? "Copy to Clipboard" : "Insert into Note",
      cls: "bible-btn bible-modal-btn",
    });
    insertBtn.disabled = true;

    let lastReadings: ResolvedReading[] = [];

    const tryParse = () => {
      const val = input.value.trim();
      preview.empty();
      feedback.setText("");
      insertBtn.disabled = true;
      lastReadings = [];

      if (!val) return;

      const result = this.plugin.resolveReference(val);
      if (!result.ok) { feedback.setText(`⚠  ${result.error}`); return; }

      lastReadings = result.readings;
      result.readings.forEach((r) => {
        preview.createEl("div", { text: r.heading, cls: "bible-ref" });
        const block = preview.createDiv("bible-verse-block");
        labelVerses(r.verses).forEach(({ label, v }) => {
          const vEl = block.createDiv("bible-verse");
          vEl.createEl("sup", { text: label, cls: "bible-verse-num" });
          vEl.createSpan({ text: " " + v.words });
        });
      });
      insertBtn.disabled = false;
    };

    input.addEventListener("input", tryParse);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !insertBtn.disabled) doInsert();
    });

    const doInsert = () => {
      if (!lastReadings.length) return;
      this.plugin.deliverText(lastReadings.map(readingToText).join("\n\n") + "\n");
      this.close();
    };

    insertBtn.onclick = doInsert;
    setTimeout(() => input.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

// ─── Find notes using a passage ───────────────────────────────────────────────

class BibleUsageModal extends Modal {
  private plugin: BibleStudyPlugin;
  private initial: string;

  constructor(app: App, plugin: BibleStudyPlugin, initial = "") {
    super(app);
    this.plugin = plugin;
    this.initial = initial;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Find notes using a passage", cls: "bible-modal-title" });
    contentEl.createEl("p", {
      text: "Type a passage, e.g. John 1:5 · Psalm 23 · Isaiah 40:28-31. Every note whose reading overlaps it is listed. Ctrl/Cmd-click a result to open it in a new tab.",
      cls: "bible-modal-hint",
    });

    const input = contentEl.createEl("input", { type: "text", placeholder: "John 1:1-18", cls: "bible-modal-input" });
    input.value = this.initial;
    const feedback = contentEl.createEl("p", { cls: "bible-modal-feedback" });
    const status = contentEl.createEl("p", { cls: "bible-modal-hint" });
    const list = contentEl.createDiv("bible-usage-list");

    const MAX_ROWS = 200;
    const render = () => {
      list.empty();
      feedback.setText("");
      status.setText("");
      const val = input.value.trim();
      if (!val) return;

      const parsed = parseReferences(
        val, this.plugin.db.getBookList(), this.plugin.settings.defaultTranslation, this.plugin.db.getTranslations(), true
      );
      if (!parsed.ok) { feedback.setText(`⚠  ${parsed.error}`); return; }

      const hits = this.plugin.findPassageUsage(parsed.readings);
      const indexing = this.plugin.usageIndexReady ? "" : "  (still indexing your notes…)";
      status.setText(
        hits.length ? `${hits.length} note${hits.length === 1 ? "" : "s"}${indexing}` : `No notes found for this passage.${indexing}`
      );

      hits.slice(0, MAX_ROWS).forEach((hit) => {
        const row = list.createDiv("bible-usage-row");
        const slash = hit.path.lastIndexOf("/");
        const name = (slash >= 0 ? hit.path.slice(slash + 1) : hit.path).replace(/\.md$/i, "");
        row.createDiv({ text: name, cls: "bible-usage-title" });
        if (slash >= 0) row.createDiv({ text: hit.path.slice(0, slash), cls: "bible-usage-folder" });
        const chips = row.createDiv("bible-usage-matches");
        hit.matches.forEach((m) => {
          chips.createEl("span", {
            text: `${m.label} · ${RELATION_TEXT[m.relation]}`,
            cls: m.relation === "same" ? "bible-usage-chip bible-usage-chip--same" : "bible-usage-chip",
          });
        });
        row.onclick = (e) => {
          const file = this.app.vault.getAbstractFileByPath(hit.path);
          if (!file) return;
          this.app.workspace.getLeaf(e.metaKey || e.ctrlKey ? "tab" : false).openFile(file as any);
          this.close();
        };
      });
      if (hits.length > MAX_ROWS) {
        list.createEl("p", { text: `…and ${hits.length - MAX_ROWS} more. Narrow the passage to see them.`, cls: "bible-modal-hint" });
      }
    };

    input.addEventListener("input", render);
    // Make sure the index is up to date, then show results
    this.plugin.buildUsageIndex().then(render);
    render();
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

// ─── First-run Download Modal ─────────────────────────────────────────────────

class BibleDownloadModal extends Modal {
  private plugin: BibleStudyPlugin;
  private dbVaultPath: string;
  private onComplete: () => void;

  constructor(app: App, plugin: BibleStudyPlugin, dbVaultPath: string, onComplete: () => void) {
    super(app);
    this.plugin = plugin;
    this.dbVaultPath = dbVaultPath;
    this.onComplete = onComplete;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Welcome to Bible Study", cls: "bible-modal-title" });
    contentEl.createEl("p", {
      text: "No Bible database was found. Would you like to download the Berean Standard Bible (BSB) with Strong's numbers?",
      cls: "bible-modal-hint",
    });
    contentEl.createEl("p", {
      text: "The BSB is a free, modern translation released under Creative Commons (CC BY-SA 4.0). The download includes the full Bible text and Strong's Hebrew/Greek lexicon (~50 MB).",
      cls: "bible-modal-hint",
    });

    const status = contentEl.createEl("p", { cls: "bible-modal-feedback" });

    const progress = contentEl.createEl("progress") as HTMLProgressElement;
    progress.style.cssText = "width:100%;height:12px;display:none;margin:8px 0;";

    const btnRow = contentEl.createDiv({ cls: "bible-note-btn-row" });

    const skipBtn = btnRow.createEl("button", { text: "Skip — I'll add a database manually", cls: "bible-btn bible-btn-danger" });
    skipBtn.style.cssText = "width:auto;flex:0 0 auto;font-size:12px;";
    skipBtn.onclick = () => this.close();

    const downloadBtn = btnRow.createEl("button", { text: "Download BSB", cls: "bible-btn" });
    downloadBtn.onclick = async () => {
      downloadBtn.disabled = true;
      skipBtn.disabled = true;
      downloadBtn.setText("Downloading…");
      progress.style.display = "";
      progress.removeAttribute("value"); // indeterminate spinner

      status.setText("Connecting to GitHub…");
      try {
        const response = await requestUrl({ url: BSB_DB_URL, method: "GET" });
        status.setText("Saving database…");

        const adapter = this.app.vault.adapter;
        const dataDir = normalizePath(".obsidian/plugins/lightworx-bible/data");
        if (!(await adapter.exists(dataDir))) await adapter.mkdir(dataDir);

        // Slice to a clean ArrayBuffer (avoids mobile WASM buffer issue)
        const buf = response.arrayBuffer;
        await adapter.writeBinary(this.dbVaultPath, buf);

        progress.value = 100;
        status.setText("✓ Download complete.");
        new Notice("Bible Study: BSB downloaded successfully.");

        await new Promise(r => setTimeout(r, 600));
        this.onComplete();
        this.close();
      } catch (e: any) {
        progress.style.display = "none";
        status.setText(`⚠ Download failed: ${e?.message ?? e}`);
        downloadBtn.disabled = false;
        downloadBtn.setText("Retry");
        skipBtn.disabled = false;
      }
    };
  }

  onClose(): void { this.contentEl.empty(); }
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

class BibleImportModal extends Modal {
  private plugin: BibleStudyPlugin;
  private onComplete: () => void;

  constructor(app: App, plugin: BibleStudyPlugin, onComplete: () => void) {
    super(app);
    this.plugin = plugin;
    this.onComplete = onComplete;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("bible-note-modal");
    contentEl.createEl("h3", { text: "Import Bible Translation", cls: "bible-modal-title" });

    // ── Instructions ──────────────────────────────────────────────────────────
    const info = contentEl.createEl("p", { cls: "bible-modal-hint" });
    info.innerHTML =
      "Upload a <strong>CSV file</strong> with columns in this order:<br>" +
      "<code>book_id, chapter, verse, text</code><br><br>" +
      "The first row may be a header — it will be skipped if <code>book_id</code> is not a number. " +
      "Book IDs must match those in your <code>books</code> table (Genesis = 1, etc.).";

    // ── Translation slug ──────────────────────────────────────────────────────
    const row1 = contentEl.createDiv("bible-row");
    row1.createEl("label", { text: "Translation abbreviation (e.g. NIV, KJV, ESV)", cls: "bible-label" });
    const slugInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "NIV",
      cls: "bible-modal-input",
    });
    slugInput.style.marginBottom = "0";
    slugInput.style.textTransform = "uppercase";
    slugInput.addEventListener("input", () => {
      slugInput.value = slugInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });

    // Warn if translation already exists
    const existsWarning = contentEl.createEl("p", { cls: "bible-modal-feedback" });
    existsWarning.style.marginTop = "4px";
    const checkExists = () => {
      const slug = slugInput.value.toLowerCase();
      const installed = this.plugin.db.getInstalledTranslations();
      existsWarning.setText(
        slug && installed.includes(slug)
          ? `⚠  ${slug.toUpperCase()} is already installed — importing will replace it.`
          : ""
      );
    };
    slugInput.addEventListener("input", checkExists);

    // ── File picker ───────────────────────────────────────────────────────────
    const row2 = contentEl.createDiv("bible-row");
    row2.createEl("label", { text: "CSV File", cls: "bible-label" });
    const fileInput = row2.createEl("input", { type: "file" }) as HTMLInputElement;
    (fileInput as any).accept = ".csv,text/csv";

    const fileInfo = contentEl.createEl("p", { cls: "bible-modal-feedback" });

    // ── Progress bar ──────────────────────────────────────────────────────────
    const progressWrap = contentEl.createDiv();
    progressWrap.style.cssText = "display:none; margin: 8px 0;";
    const progressBar = progressWrap.createEl("progress") as HTMLProgressElement;
    progressBar.max = 100;
    progressBar.value = 0;
    progressBar.style.cssText = "width:100%; height:12px;";
    const progressLabel = progressWrap.createEl("p", { cls: "bible-modal-hint" });
    progressLabel.style.margin = "4px 0 0";

    // ── Import button ─────────────────────────────────────────────────────────
    const importBtn = contentEl.createEl("button", {
      text: "Import",
      cls: "bible-btn bible-modal-btn",
    });
    importBtn.style.marginTop = "8px";

    // Track parsed rows
    let parsedRows: { book_id: number; chapter: number; verse: number; words: string }[] = [];

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        parsedRows = [];
        let skipped = 0;
        let taggedCount = 0;

        for (const line of lines) {
          const cols = parseCsvLine(line);
          if (cols.length < 4) { skipped++; continue; }
          const book_id = parseInt(cols[0]);
          const chapter = parseInt(cols[1]);
          const verse   = parseInt(cols[2]);
          if (isNaN(book_id) || isNaN(chapter) || isNaN(verse)) { skipped++; continue; }

          // Join remaining columns (text may contain commas)
          let rawText = cols.slice(3).join(",").replace(/^"|"$/g, "").trim();

          // Strip non-Strong's XML/HTML tags (<pb/>, <milestone/>, etc.)
          // Preserve <S>number> and <S>number</S> patterns
          rawText = rawText.replace(/<(?!\/?S[\s>])(?:[^>]*)>/gi, " ").replace(/\s+/g, " ").trim();

          // Detect Strong's tags — support both <S>7225</S> and <S>7225 (no closing tag)
          const hasStrongs = /<S>\d+/i.test(rawText);
          let words = rawText;
          let tagged: string | undefined;
          let strongs_list: string | undefined;

          if (hasStrongs) {
            // Determine H or G prefix from book_id (1–39 = OT/Hebrew, 40+ = NT/Greek)
            const prefix = book_id <= 39 ? "H" : "G";
            const tokens: { text: string; strongs: string }[] = [];
            const strongsList: string[] = [];

            // Split on <S>number> or <S>number</S> — word text precedes each tag
            const parts = rawText.split(/(<S>\d+(?:<\/S>)?)/i);
            let pending = "";
            for (const part of parts) {
              const m = part.match(/^<S>(\d+)/i);
              if (m) {
                const num = `${prefix}${m[1]}`;
                const wordText = pending.trim();
                if (wordText) tokens.push({ text: wordText, strongs: num });
                strongsList.push(num);
                pending = "";
              } else {
                pending += part;
              }
            }
            // Any trailing text with no Strong's tag
            if (pending.trim()) tokens.push({ text: pending.trim(), strongs: "" });

            // Plain text = join all token texts
            words = tokens.map(t => t.text).join(" ").replace(/\s+/g, " ").trim();

            // Tagged format: "word text[Hnnnn]" joined by spaces — easy to parse at display time
            tagged = tokens.map(t => t.strongs ? `${t.text}[${t.strongs}]` : t.text).join(" ");
            strongs_list = strongsList.join(" ");
            taggedCount++;
          }

          parsedRows.push({ book_id, chapter, verse, words, tagged, strongs_list });
        }

        const tagMsg = taggedCount ? ` • ${taggedCount} verses with Strong's tags` : "";
        fileInfo.setText(
          parsedRows.length
            ? `✓  ${parsedRows.length.toLocaleString()} verses parsed${skipped ? ` (${skipped} rows skipped)` : ""}${tagMsg}.`
            : "⚠  No valid rows found. Check the file format."
        );
      };
      reader.readAsText(file);
    });

    importBtn.onclick = async () => {
      const slug = slugInput.value.trim().toLowerCase();
      if (!slug) { new Notice("Please enter a translation abbreviation."); return; }
      if (!parsedRows.length) { new Notice("Please select a valid CSV file first."); return; }

      importBtn.disabled = true;
      importBtn.setText("Importing…");
      progressWrap.style.display = "";

      // Yield to UI then run import
      await new Promise<void>((resolve) => setTimeout(resolve, 30));

      try {
        this.plugin.db.importTranslation(slug, parsedRows, (pct) => {
          progressBar.value = pct;
          progressLabel.setText(`Importing… ${pct}%`);
        });

        progressBar.value = 100;
        progressLabel.setText("✓ Import complete.");
        new Notice(`✓ ${slug.toUpperCase()} imported — ${parsedRows.length.toLocaleString()} verses.`);

        // Refresh the sidebar so new translation appears in dropdowns
        this.onComplete();
        setTimeout(() => this.close(), 800);
      } catch (e: any) {
        new Notice(`Import failed: ${e?.message ?? e}`);
        importBtn.disabled = false;
        importBtn.setText("Import");
      }
    };
  }

  onClose(): void { this.contentEl.empty(); }
}

/** Minimal CSV line parser that handles double-quoted fields */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      result.push(current); current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

type TabMode = "passage" | "search" | "notes";

interface PassageState {
  translation: string;
  bookId: number;
  chapter: number;
  startVerse: number;
  endVerse: number;
}

class BibleStudyView extends ItemView {
  private plugin: BibleStudyPlugin;
  private currentMode: TabMode = "passage";
  private currentPassage: PassageState | null = null;
  // Notes tab state
  private notesSearchQuery: string = "";
  private notesFilterToPassage: boolean = true;
  // Strong's cross-reference search triggered from passage panel
  pendingStrongsSearch: { number: string; translation: string } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BibleStudyPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Bible"; }
  getIcon(): string { return "book-open"; }

  async onOpen(): Promise<void> { this.render(); }
  async onClose(): Promise<void> {}

  /** Switch to the Passage tab showing exactly this range, kept within the chapter's real verses */
  showPassage(bookId: number, chapter: number, startVerse: number, endVerse: number, translation: string): void {
    const last = this.plugin.db.getVerseCount(translation, bookId, chapter);
    const end = last > 0 ? Math.min(endVerse, last) : endVerse;
    const start = Math.max(1, Math.min(startVerse, end));
    this.currentPassage = { translation, bookId, chapter, startVerse: start, endVerse: end };
    this.currentMode = "passage";
    this.render();
  }

  /** Open a search hit in the Passage tab with a couple of verses either side for context */
  navigateToPassage(bookId: number, chapter: number, verse: number, translation: string): void {
    this.showPassage(bookId, chapter, verse - 2, verse + 2, translation);
  }

  render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("bible-plugin-container");

    const header = container.createDiv("bible-header");
    header.createEl("span", { text: "✝  Bible", cls: "bible-title" });

    const tabs = container.createDiv("bible-tabs");
    const passageTab = tabs.createEl("button", { text: "Passage", cls: "bible-tab" });
    const searchTab  = tabs.createEl("button", { text: "Search",  cls: "bible-tab" });
    const notesTab   = tabs.createEl("button", { text: "Notes",   cls: "bible-tab" });

    const setActive = (mode: TabMode) => {
      [passageTab, searchTab, notesTab].forEach((t) => t.removeClass("active"));
      if (mode === "passage") passageTab.addClass("active");
      else if (mode === "search") searchTab.addClass("active");
      else notesTab.addClass("active");
    };
    setActive(this.currentMode);

    const body = container.createDiv("bible-body");

    const switchTo = (mode: TabMode) => {
      this.currentMode = mode;
      setActive(mode);
      body.empty();
      // Passage panel manages its own scroll via .bible-results;
      // search and notes scroll the whole body
      if (mode === "passage") {
        body.removeClass("bible-body--scrollable");
      } else {
        body.addClass("bible-body--scrollable");
      }
      if (!this.plugin.db.isLoaded()) {
        body.createEl("p", { text: "⚠  No database loaded. Set the path in Settings → Bible.", cls: "bible-notice" });
        return;
      }
      if (mode === "passage") this.renderPassagePanel(body);
      else if (mode === "search") this.renderSearchPanel(body);
      else this.renderNotesPanel(body);
    };

    passageTab.onclick = () => switchTo("passage");
    searchTab.onclick  = () => switchTo("search");
    notesTab.onclick   = () => switchTo("notes");

    if (!this.plugin.db.isLoaded()) {
      body.createEl("p", { text: "⚠  No database loaded. Set the path in Settings → Bible.", cls: "bible-notice" });
      return;
    }

    switchTo(this.currentMode);
  }

  // ── Passage Panel ────────────────────────────────────────────────────────────

  private renderPassagePanel(container: HTMLElement): void {
    const books = this.plugin.db.getBookList();

    // ── Sticky header: all controls + nav row ────────────────────────────────
    const stickyHeader = container.createDiv("bible-sticky-header");

    // ── Row 1: Trans. | Book | Ch. | From | To ───────────────────────────────
    const row1 = stickyHeader.createDiv("bible-row-inline bible-controls-row");

    const transWrap = row1.createDiv("bible-ctrl-group");
    transWrap.createEl("label", { text: "Trans.", cls: "bible-label" });
    const translationSel = transWrap.createEl("select", { cls: "bible-select bible-select--trans" });
    this.plugin.db.getTranslations().forEach((t) => {
      const opt = translationSel.createEl("option", { text: t.toUpperCase(), value: t });
      if (t === this.plugin.settings.defaultTranslation) opt.selected = true;
    });

    const bookWrap = row1.createDiv("bible-ctrl-group bible-ctrl-group--book");
    bookWrap.createEl("label", { text: "Book", cls: "bible-label" });
    const bookSel = bookWrap.createEl("select", { cls: "bible-select" });
    books.forEach((b) => bookSel.createEl("option", { text: b.book, value: String(b.id) }));

    const chWrap = row1.createDiv("bible-ctrl-group");
    chWrap.createEl("label", { text: "Ch.", cls: "bible-label" });
    const chapterSel = chWrap.createEl("select", { cls: "bible-select-sm" });

    const vsWrap = row1.createDiv("bible-ctrl-group");
    vsWrap.createEl("label", { text: "From", cls: "bible-label" });
    const verseStartSel = vsWrap.createEl("select", { cls: "bible-select-sm" });

    const veWrap = row1.createDiv("bible-ctrl-group");
    veWrap.createEl("label", { text: "To", cls: "bible-label" });
    const verseEndSel = veWrap.createEl("select", { cls: "bible-select-sm" });

    // ── Nav row container — filled/replaced by doLookup ──────────────────────
    const navContainer = stickyHeader.createDiv("bible-nav-container");

    // ── Scrollable verse content ─────────────────────────────────────────────
    const results = container.createDiv("bible-results");

    // ── Core lookup ──────────────────────────────────────────────────────────
    const doLookup = () => {
      const translation = translationSel.value;
      const bookId = parseInt(bookSel.value);
      const chapter = parseInt(chapterSel.value);
      const startVerse = parseInt(verseStartSel.value);
      const endVerse = parseInt(verseEndSel.value);
      if (!translation || !bookId || !chapter || !startVerse || !endVerse) return;

      const bookObj = books.find((b) => b.id === bookId);
      const bookName = bookObj?.book ?? "";
      const verses = this.plugin.db.getPassage(translation, bookId, chapter, startVerse, endVerse);
      results.empty();

      if (!verses.length) {
        results.createEl("p", { text: "No verses found.", cls: "bible-empty" }); return;
      }

      this.currentPassage = { translation, bookId, chapter, startVerse, endVerse };

      // ── Nav row: ‹  BOOK Ch:Vv–Vv  › (inside sticky header) ──────────────
      navContainer.empty();
      const refEl = navContainer.createDiv("bible-ref");

      const prevBtn = refEl.createEl("button", { text: "‹", cls: "bible-chapter-nav bible-chapter-nav--ref" });
      prevBtn.title = "Previous chapter";
      prevBtn.disabled = chapter <= 1;
      prevBtn.onclick = (e) => {
        e.stopPropagation();
        if (chapter <= 1) return;
        chapterSel.value = String(chapter - 1);
        populateVerses(true);
      };

      // ── Notes pre-split by scope ───────────────────────────────────────────
      const { bookNotes, chapterNotes, verseNotes } =
        this.plugin.db.getPassageNotesByScope(bookId, chapter, startVerse, endVerse);

      const bookSpan = refEl.createEl("span", {
        text: bookName,
        cls: bookNotes.length ? "bible-ref-part bible-ref-part--noted" : "bible-ref-part",
      });
      if (bookNotes.length) {
        const tt = refEl.createDiv("bible-ref-tooltip");
        this.buildTooltipContent(tt, bookNotes, books);
        bookSpan.addEventListener("mouseenter", () => tt.addClass("bible-verse-tooltip--visible"));
        bookSpan.addEventListener("mouseleave", () => tt.removeClass("bible-verse-tooltip--visible"));
        bookSpan.onclick = (e) => {
          e.stopPropagation();
          new BibleNoteModal(this.app, this.plugin, () => doLookup(), bookNotes[0]).open();
        };
      }

      refEl.createEl("span", { text: "\u2002", cls: "bible-ref-gap" });

      const chapterLabel = `${chapter}:${startVerse}${endVerse > startVerse ? `\u2013${endVerse}` : ""}`;
      const chapterSpan = refEl.createEl("span", {
        text: chapterLabel,
        cls: chapterNotes.length ? "bible-ref-part bible-ref-part--noted" : "bible-ref-part",
      });
      if (chapterNotes.length) {
        const tt = refEl.createDiv("bible-ref-tooltip");
        this.buildTooltipContent(tt, chapterNotes, books);
        chapterSpan.addEventListener("mouseenter", () => tt.addClass("bible-verse-tooltip--visible"));
        chapterSpan.addEventListener("mouseleave", () => tt.removeClass("bible-verse-tooltip--visible"));
        chapterSpan.onclick = (e) => {
          e.stopPropagation();
          new BibleNoteModal(this.app, this.plugin, () => doLookup(), chapterNotes[0]).open();
        };
      }

      const nextBtn = refEl.createEl("button", { text: "›", cls: "bible-chapter-nav bible-chapter-nav--ref" });
      nextBtn.title = "Next chapter";
      nextBtn.disabled = chapter >= this.plugin.db.getChapterCount(bookId);
      nextBtn.onclick = (e) => {
        e.stopPropagation();
        const max = this.plugin.db.getChapterCount(bookId);
        if (chapter >= max) return;
        chapterSel.value = String(chapter + 1);
        populateVerses(true);
      };

      // Copy/Insert button — sits to the right of the next button
      const insertBtnLabel = this.plugin.settings.insertMode === "clipboard" ? "Copy" : "Insert";
      const insertBtn = refEl.createEl("button", { text: insertBtnLabel, cls: "bible-ref-insert-btn bible-ref-insert-btn--nav" });
      insertBtn.onclick = (e) => {
        e.stopPropagation();
        const text = this.buildInsertText(bookName, chapter, startVerse, endVerse, translation, verses);
        this.plugin.deliverText(text);
      };

      // "Used in" — find notes whose reading overlaps this passage
      if (bookObj) {
        const verseCount = this.plugin.db.getVerseCount(translation, bookId, chapter);
        const usageQuery: ParsedReading[] = [{
          book: bookObj,
          translation,
          segments: [{
            startChapter: chapter, startVerse,
            endChapter: chapter,
            endVerse: startVerse === 1 && endVerse >= verseCount ? END_OF_CHAPTER : endVerse,
          }],
        }];
        const usedCount = this.plugin.usageIndexReady ? this.plugin.findPassageUsage(usageQuery).length : 0;
        const usedBtn = refEl.createEl("button", {
          text: usedCount ? `Used in ${usedCount}` : "Used in",
          cls: "bible-ref-insert-btn bible-ref-insert-btn--nav",
        });
        usedBtn.title = "Find notes that use this passage";
        usedBtn.onclick = (e) => {
          e.stopPropagation();
          new BibleUsageModal(this.app, this.plugin, `${bookName} ${formatSegments(usageQuery[0].segments)}`).open();
        };
      }

      // ── Verse block ────────────────────────────────────────────────────────
      const hasTagging = this.plugin.db.translationHasTagging(translation);
      const hasStrongs = hasTagging && this.plugin.db.hasStrongsTable() && this.plugin.settings.strongsEnabled;

      // Use a ref so showStrongs can reference the panel even though it's
      // created AFTER the verse block (to get correct DOM ordering)
      const ref: { panel: HTMLElement | null; activeWord: HTMLElement | null } = {
        panel: null, activeWord: null,
      };

      const showStrongs = (number: string, wordEl: HTMLElement) => {
        if (!ref.panel) return;
        if (ref.activeWord) ref.activeWord.removeClass("bible-word--active");
        ref.activeWord = wordEl;
        wordEl.addClass("bible-word--active");
        ref.panel.empty();
        ref.panel.style.display = "";
        // Scroll the panel into view smoothly so the user sees it regardless of scroll position
        setTimeout(() => ref.panel?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);

        try {
          const entry = this.plugin.db.getStrongsEntry(number);
          const panelHead = ref.panel.createDiv("bible-strongs-head");
          panelHead.createEl("span", { text: number, cls: "bible-strongs-number" });
          if (entry) {
            panelHead.createEl("span", { text: entry.lemma, cls: "bible-strongs-lemma" });
            panelHead.createEl("span", { text: `${entry.xlit}  (${entry.pronounce})`, cls: "bible-strongs-xlit" });
          }
          const closeBtn = panelHead.createEl("button", { text: "✕", cls: "bible-strongs-close" });
          closeBtn.onclick = () => {
            if (ref.panel) { ref.panel.style.display = "none"; ref.panel.empty(); }
            if (ref.activeWord) { ref.activeWord.removeClass("bible-word--active"); ref.activeWord = null; }
          };
          if (entry) {
            ref.panel.createEl("p", { text: entry.description, cls: "bible-strongs-desc" });
          } else {
            ref.panel.createEl("p", { text: `No entry found for ${number}.`, cls: "bible-empty" });
          }
          const findBtn = ref.panel.createEl("button", {
            text: `Find all uses of ${number} in ${translation.toUpperCase()}`,
            cls: "bible-btn bible-strongs-find-btn",
          });
          findBtn.onclick = () => {
            this.pendingStrongsSearch = { number, translation };
            this.currentMode = "search";
            this.render();
          };
        } catch (e: any) {
          ref.panel?.createEl("p", { text: `⚠ ${e?.message ?? e}`, cls: "bible-notice" });
        }
      };

      // ── Verse block ────────────────────────────────────────────────────────
      const block = results.createDiv("bible-verse-block");
      verses.forEach((v) => {
        const vEl = block.createDiv("bible-verse");
        const vNotes = verseNotes.get(v.verse) ?? [];
        const numEl = vEl.createEl("sup", {
          text: String(v.verse),
          cls: vNotes.length ? "bible-verse-num bible-verse-num--noted" : "bible-verse-num",
        });
        if (vNotes.length) {
          const tooltip = vEl.createDiv("bible-verse-tooltip");
          this.buildTooltipContent(tooltip, vNotes, books);
          numEl.addEventListener("mouseenter", () => tooltip.addClass("bible-verse-tooltip--visible"));
          numEl.addEventListener("mouseleave", () => tooltip.removeClass("bible-verse-tooltip--visible"));
          numEl.onclick = (e) => {
            e.stopPropagation();
            new BibleNoteModal(this.app, this.plugin, () => doLookup(), vNotes[0]).open();
          };
        }

        if (hasTagging) {
          const tagged = this.plugin.db.getTaggedVerse(translation, v.book_id, v.chapter, v.verse);
          if (tagged) {
            vEl.createEl("span", { text: " " });
            const tokens = BibleDatabase.parseTaggedText(tagged);
            tokens.forEach((tok) => {
              if (tok.strongs && hasStrongs) {
                const span = vEl.createEl("span", { text: tok.text, cls: "bible-word bible-word--tagged" });
                span.title = tok.strongs;
                span.onclick = (e) => { e.stopPropagation(); showStrongs(tok.strongs!, span); };
              } else {
                vEl.createEl("span", { text: tok.text });
              }
              vEl.createEl("span", { text: " " });
            });
          } else {
            vEl.createSpan({ text: " " + v.words });
          }
        } else {
          vEl.createSpan({ text: " " + v.words });
        }
      });

      // Create panel AFTER verse block so it appears below the text,
      // then assign to ref so showStrongs can use it
      ref.panel = results.createDiv("bible-strongs-panel");
      ref.panel.style.display = "none";
    }; // end doLookup
    const populateVerses = (andLookup = true) => {
      const bookId = parseInt(bookSel.value);
      const chapter = parseInt(chapterSel.value);
      const translation = translationSel.value;
      const count = this.plugin.db.getVerseCount(translation, bookId, chapter);
      verseStartSel.empty(); verseEndSel.empty();
      for (let i = 1; i <= count; i++) {
        verseStartSel.createEl("option", { text: String(i), value: String(i) });
        verseEndSel.createEl("option", { text: String(i), value: String(i) });
      }
      verseEndSel.value = String(count);
      if (andLookup) doLookup();
    };

    const populateChapters = (andLookup = true) => {
      const bookId = parseInt(bookSel.value);
      const count = this.plugin.db.getChapterCount(bookId);
      chapterSel.empty();
      for (let i = 1; i <= count; i++) chapterSel.createEl("option", { text: String(i), value: String(i) });
      populateVerses(andLookup);
    };

    // ── Wire up change events ────────────────────────────────────────────────
    bookSel.onchange = () => populateChapters(true);
    chapterSel.onchange = () => populateVerses(true);
    translationSel.onchange = () => populateVerses(true);
    verseStartSel.onchange = doLookup;
    verseEndSel.onchange = doLookup;

    // ── Restore previous passage or default to Genesis 1 ────────────────────
    if (this.currentPassage) {
      const p = this.currentPassage;
      translationSel.value = p.translation;
      bookSel.value = String(p.bookId);
      populateChapters(false);
      chapterSel.value = String(p.chapter);
      populateVerses(false);
      verseStartSel.value = String(p.startVerse);
      verseEndSel.value = String(p.endVerse);
      doLookup();
    } else {
      populateChapters(true);
    }
  }

  /** Populate a tooltip div with note content rows. */
  private buildTooltipContent(tooltip: HTMLElement, notes: BibleNote[], books: Book[]): void {
    notes.forEach((n, i) => {
      if (i > 0) tooltip.createEl("hr", { cls: "bible-verse-tooltip-divider" });
      tooltip.createEl("div", { text: noteRefLabel(n, books), cls: "bible-verse-tooltip-ref" });
      tooltip.createEl("div", { text: n.body, cls: "bible-verse-tooltip-body" });
      if (n.tags) {
        const tagLine = n.tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
          .map((t: string) => "#" + t)
          .join("  ");
        tooltip.createEl("div", { text: tagLine, cls: "bible-verse-tooltip-tags" });
      }
    });
  }

  private renderPassageNotes(
    container: HTMLElement,
    bookId: number, bookName: string,
    chapter: number, startVerse: number, endVerse: number
  ): void {
    const notes = this.plugin.db.getNotesForPassage(bookId, chapter, startVerse, endVerse);

    const notesSection = container.createDiv("bible-passage-notes");

    const notesHeader = notesSection.createDiv("bible-passage-notes-header");
    notesHeader.createEl("span", {
      text: notes.length ? `📝 ${notes.length} note${notes.length === 1 ? "" : "s"}` : "📝 No notes",
      cls: "bible-passage-notes-label",
    });

    const addBtn = notesHeader.createEl("button", { text: "+ Add Note", cls: "bible-btn-sm" });
    addBtn.onclick = () => {
      new BibleNoteModal(this.app, this.plugin, () => {
        // Refresh notes section
        notesSection.empty();
        this.renderPassageNotes(container, bookId, bookName, chapter, startVerse, endVerse);
      }, null, {
        book_id: bookId, bookName, chapter, verse_start: startVerse, verse_end: endVerse,
      }).open();
    };

    notes.forEach((note) => {
      const card = notesSection.createDiv("bible-note-card");
      const cardHeader = card.createDiv("bible-note-card-header");
      cardHeader.createEl("span", { text: noteRefLabel(note, this.plugin.db.getBookList()), cls: "bible-note-card-ref" });
      cardHeader.createEl("span", { text: shortDate(note.updated_at), cls: "bible-note-card-date" });

      card.createEl("p", { text: note.body, cls: "bible-note-card-body" });
      if (note.tags) {
        const tagsEl = card.createDiv("bible-note-card-tags");
        note.tags.split(",").map((t) => t.trim()).filter(Boolean).forEach((tag) => {
          tagsEl.createEl("span", { text: tag, cls: "bible-note-tag" });
        });
      }
      const editBtn = card.createEl("button", { text: "Edit", cls: "bible-btn-sm" });
      editBtn.onclick = () => {
        new BibleNoteModal(this.app, this.plugin, () => {
          notesSection.empty();
          this.renderPassageNotes(container, bookId, bookName, chapter, startVerse, endVerse);
        }, note).open();
      };
    });
  }

  // ── Search Panel ─────────────────────────────────────────────────────────────

  private renderSearchPanel(container: HTMLElement): void {
    const row1 = container.createDiv("bible-row");
    row1.createEl("label", { text: "Translation", cls: "bible-label" });
    const translationSel = row1.createEl("select", { cls: "bible-select" });
    this.plugin.db.getTranslations().forEach((t) => {
      const opt = translationSel.createEl("option", { text: t.toUpperCase(), value: t });
      if (t === this.plugin.settings.defaultTranslation) opt.selected = true;
    });

    // If arriving from a Strong's word click, pre-select the translation
    if (this.pendingStrongsSearch) {
      translationSel.value = this.pendingStrongsSearch.translation;
    }

    const row2 = container.createDiv("bible-row");
    const searchInput = row2.createEl("input", {
      type: "text", placeholder: "Search words, phrases, or Strong's (e.g. H7225)…", cls: "bible-search-input",
    });

    const searchBtn = container.createEl("button", { text: "Search", cls: "bible-btn" });
    const results = container.createDiv("bible-results");

    const doSearch = (strongsOverride?: { number: string; translation: string }) => {
      const translation = strongsOverride?.translation ?? translationSel.value;
      const query = searchInput.value.trim();

      // Detect Strong's number search: H or G followed by digits
      const isStrongs = (strongsOverride || /^[HG]\d+$/i.test(query)) && this.plugin.settings.strongsEnabled;

      if (!strongsOverride && !query) return;
      results.empty();

      if (isStrongs) {
        const number = strongsOverride ? strongsOverride.number : query.toUpperCase();
        const entry = this.plugin.db.getStrongsEntry(number);
        const hits = this.plugin.db.getVersesByStrongs(number, translation);

        // Show lexicon entry at top
        if (entry) {
          const entryEl = results.createDiv("bible-strongs-summary");
          const headEl = entryEl.createDiv("bible-strongs-head");
          headEl.createEl("span", { text: number, cls: "bible-strongs-number" });
          headEl.createEl("span", { text: entry.lemma, cls: "bible-strongs-lemma" });
          headEl.createEl("span", { text: `${entry.xlit}  (${entry.pronounce})`, cls: "bible-strongs-xlit" });
          entryEl.createEl("p", { text: entry.description, cls: "bible-strongs-desc" });
        }

        if (!hits.length) {
          results.createEl("p", { text: `No verses found for ${number} in ${translation.toUpperCase()}.`, cls: "bible-empty" });
          return;
        }
        results.createEl("div", {
          text: `${hits.length} verse${hits.length === 1 ? "" : "s"} containing ${number} (${translation.toUpperCase()})`,
          cls: "bible-ref",
        });
        hits.forEach((v) => this.renderSearchResultItem(results, v, translationSel));

      } else {
        const hits = this.plugin.db.searchWords(translation, query);
        if (!hits.length) { results.createEl("p", { text: "No results found.", cls: "bible-empty" }); return; }
        results.createEl("div", { text: `${hits.length} result${hits.length === 1 ? "" : "s"}`, cls: "bible-ref" });
        hits.forEach((v) => this.renderSearchResultItem(results, v, translationSel));
      }
    };

    searchBtn.onclick = () => doSearch();
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

    // Auto-run if arriving from a Strong's word click
    if (this.pendingStrongsSearch) {
      const pending = this.pendingStrongsSearch;
      this.pendingStrongsSearch = null;
      searchInput.value = pending.number;
      setTimeout(() => doSearch({ number: pending.number, translation: pending.translation }), 0);
    }
  }

  private renderSearchResultItem(
    results: HTMLElement,
    v: BibleVerse & { book_name: string },
    translationSel: HTMLSelectElement
  ): void {
    const item = results.createDiv("bible-search-result bible-search-result--clickable");
    item.title = "Click to open in Passage tab";

    const refRow = item.createEl("div", { cls: "bible-search-ref" });
    refRow.createEl("span", { text: `${v.book_name} ${v.chapter}:${v.verse}` });

    const btnGroup = refRow.createDiv("bible-search-ref-btns");

    const openBtn = btnGroup.createEl("button", { text: "Open", cls: "bible-btn-sm bible-btn-sm--open" });
    openBtn.title = "Open in Passage tab";
    openBtn.onclick = (e) => {
      e.stopPropagation();
      this.navigateToPassage(v.book_id, v.chapter, v.verse, translationSel.value);
    };

    const insertBtn = btnGroup.createEl("button", { text: "Insert", cls: "bible-btn-sm" });
    insertBtn.onclick = (e) => {
      e.stopPropagation();
      const text = this.buildInsertText(v.book_name, v.chapter, v.verse, v.verse, translationSel.value,
        [{ book_id: v.book_id, chapter: v.chapter, verse: v.verse, words: v.words }]);
      this.plugin.deliverText(text);
    };
    const noteBtn = btnGroup.createEl("button", { text: "Note", cls: "bible-btn-sm" });
    noteBtn.onclick = (e) => {
      e.stopPropagation();
      new BibleNoteModal(this.app, this.plugin, () => {}, null, {
        book_id: v.book_id, bookName: v.book_name, chapter: v.chapter,
        verse_start: v.verse, verse_end: v.verse,
      }).open();
    };

    item.onclick = () => this.navigateToPassage(v.book_id, v.chapter, v.verse, translationSel.value);
    item.createEl("div", { text: v.words, cls: "bible-search-text" });
  }

  // ── Notes Panel ──────────────────────────────────────────────────────────────

  private renderNotesPanel(container: HTMLElement): void {
    const books = this.plugin.db.getBookList();
    const hasPassage = this.currentPassage !== null;

    // Toolbar: search + New Note
    const toolbar = container.createDiv("bible-notes-toolbar");
    const searchInput = toolbar.createEl("input", {
      type: "text", placeholder: "Search notes…", cls: "bible-search-input",
    });
    searchInput.value = this.notesSearchQuery;
    const newBtn = toolbar.createEl("button", { text: "+ New Note", cls: "bible-btn-sm" });

    // Passage filter toggle
    const filterRow = container.createDiv("bible-notes-filter-row");
    const toggleLabel = filterRow.createEl("label", { cls: "bible-toggle-label" });
    const toggleInput = toggleLabel.createEl("input", { type: "checkbox", cls: "bible-toggle-input" });
    toggleInput.checked = this.notesFilterToPassage && hasPassage;
    toggleInput.disabled = !hasPassage;
    toggleLabel.createEl("span", { cls: "bible-toggle-track" });
    const toggleText = filterRow.createEl("span", {
      cls: "bible-toggle-text",
      text: hasPassage
        ? (this.notesFilterToPassage ? "Showing notes for current passage" : "Showing all notes")
        : "No passage loaded — showing all notes",
    });

    const list = container.createDiv("bible-notes-list");

    const renderList = () => {
      list.empty();
      const query = searchInput.value.trim();
      this.notesSearchQuery = query;

      const filterOn = toggleInput.checked && hasPassage;
      let notes: BibleNote[];

      if (filterOn && this.currentPassage) {
        const { bookId, chapter, startVerse, endVerse } = this.currentPassage;
        notes = this.plugin.db.getNotesForPassageBiblical(bookId, chapter, startVerse, endVerse);
        if (query) {
          const q = query.toLowerCase();
          notes = notes.filter((n) =>
            n.body.toLowerCase().includes(q) ||
            (n.tags ?? "").toLowerCase().includes(q)
          );
        }
      } else {
        notes = query
          ? this.plugin.db.searchNotesBiblical(query)
          : this.plugin.db.getAllNotesBiblical();
      }

      if (!notes.length) {
        list.createEl("p", {
          text: filterOn
            ? "No notes for this passage yet."
            : query ? "No notes match your search." : "No notes yet. Use “+ New Note” to create one.",
          cls: "bible-empty",
        });
        return;
      }

      notes.forEach((note) => {
        const card = list.createDiv("bible-note-card");
        const cardHeader = card.createDiv("bible-note-card-header");
        cardHeader.createEl("span", { text: noteRefLabel(note, books), cls: "bible-note-card-ref" });
        cardHeader.createEl("span", { text: shortDate(note.updated_at), cls: "bible-note-card-date" });

        const preview = note.body.length > 120 ? note.body.slice(0, 120) + "…" : note.body;
        card.createEl("p", { text: preview, cls: "bible-note-card-body" });

        if (note.tags) {
          const tagsEl = card.createDiv("bible-note-card-tags");
          note.tags.split(",").map((t) => t.trim()).filter(Boolean).forEach((tag) => {
            tagsEl.createEl("span", { text: tag, cls: "bible-note-tag" });
          });
        }

        const cardFooter = card.createDiv("bible-note-card-footer");
        const editBtn = cardFooter.createEl("button", { text: "Edit", cls: "bible-btn-sm" });
        editBtn.onclick = () => new BibleNoteModal(this.app, this.plugin, renderList, note).open();

        const insertBtn = cardFooter.createEl("button", { text: "Copy to Note", cls: "bible-btn-sm" });
        insertBtn.onclick = () => {
          const label = noteRefLabel(note, books);
          const text = label !== "Whole Bible"
            ? `📝 **${label}** — ${note.body}\n`
            : `📝 ${note.body}\n`;
          this.plugin.deliverText(text);
        };
      });
    };

    toggleInput.addEventListener("change", () => {
      this.notesFilterToPassage = toggleInput.checked;
      toggleText.setText(
        toggleInput.checked && hasPassage
          ? "Showing notes for current passage"
          : hasPassage ? "Showing all notes" : "No passage loaded — showing all notes"
      );
      renderList();
    });

    newBtn.onclick = () => new BibleNoteModal(this.app, this.plugin, renderList).open();
    searchInput.addEventListener("input", renderList);
    renderList();
  }

  // ── Shared helpers ────────────────────────────────────────────────────────────

  private buildInsertText(bookName: string, chapter: number, startVerse: number, endVerse: number, translation: string, verses: BibleVerse[]): string {
    const refPart = endVerse > startVerse ? `${startVerse}–${endVerse}` : `${startVerse}`;
    const ref = `${bookName} ${chapter}:${refPart} (${translation.toUpperCase()})`;
    const text = verses.map((v) => `${v.verse} ${v.words}`).join(" ");
    return `${ref}\n${text}\n`;
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class BibleSettingTab extends PluginSettingTab {
  plugin: BibleStudyPlugin;
  constructor(app: App, plugin: BibleStudyPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Bible Settings" });

    // ── Collapsible help section ───────────────────────────────────────────────
    const details = containerEl.createEl("details", { cls: "bible-help" });
    const summary = details.createEl("summary", { cls: "bible-help-summary" });
    summary.createEl("span", { text: "📖  How to use — Bible syntax in notes" });

    const help = details.createDiv("bible-help-body");

    const section = (title: string) =>
      help.createEl("h4", { text: title, cls: "bible-help-heading" });

    const code = (text: string) =>
      help.createEl("code", { text, cls: "bible-help-code" });

    const p = (text: string) =>
      help.createEl("p", { text, cls: "bible-help-p" });

    section("Bible code block — direct reference");
    p("Paste a code block with the language set to bible anywhere in a note. In Reading mode the passage renders inline from the database:");
    const eg1 = help.createEl("pre", { cls: "bible-help-pre" });
    eg1.createEl("code", { text: "```bible\nJohn 3:16 NIV\n```" });
    p("The translation is optional — if omitted your default translation is used.");

    section("Reference syntax");
    p("The same syntax works in code blocks, {{…}} tags, frontmatter readings and the quick insert modal:");
    const eg4 = help.createEl("pre", { cls: "bible-help-pre" });
    eg4.createEl("code", { text: "John 3:16\nJohn 1:1-3,5,6-8\nJohn 1:1-5,2:3-6,7,3:10\nJohn 1:51-2:2\nPsalm 1   or   Psalm 1-3\nJohn 1:1-10; Psalm 3:4-5 NIV" });
    p("A comma separates verses or ranges within a chapter. An item such as 2:3 switches chapter, and bare numbers after it are verses of that chapter. A semicolon (or a new line) separates readings, and each reading has its own book. A bare chapter such as Psalm 1 means the whole chapter. A translation at the end applies to every reading that doesn't name its own.");

    section("Frontmatter-driven block — sermon template");
    p("Add a reading key to your note's frontmatter, then reference it in a code block:");
    const eg2 = help.createEl("pre", { cls: "bible-help-pre" });
    eg2.createEl("code", { text: "---\nreading: John 1:1-10 NIV\n---\n\n# {{reading}}\n\n```bible\nfrontmatter:reading\n```" });
    p("The block reads the frontmatter value automatically. Change the reading property and the rendered text updates.");

    section("Inline expansion — {{references}}");
    p("Type a reference anywhere in a note using double curly braces:");
    code("{{Romans 8:28 NIV}}");
    p("Then run the command Bible: Expand {{Bible references}} in note from the command palette (or assign it a hotkey). Every {{...}} tag in the note is replaced with the passage text at the cursor.");

    section("Quick insert modal");
    p("Assign a hotkey to Bible: Quick insert Bible passage. A modal opens where you can type any reference and see a live preview before inserting or copying to clipboard.");

    section("Finding notes that use a passage");
    p("Run Bible: Find notes using a passage (or press Used in on the Passage tab) and type a reference. Every note whose reading overlaps it is listed, so John 1:5 finds a sermon whose reading is John 1:1-18. Notes are found through their reading property (see Settings) and any bible code blocks in their body. Ctrl/Cmd-click a result to open it in a new tab. In a rendered bible block, click the passage heading to show that passage in the Bible panel, then press Used in.");

    section("Sidebar");
    p("Click the open-book icon in the left ribbon (or run Bible: Open Bible Sidebar) to open the passage browser. Use the Passage tab to read and navigate, the Search tab to find words or Strong's numbers (e.g. G2222), and the Notes tab to keep study notes attached to specific verses.");

    section("Strong's numbers");
    p("If your translation was imported with Strong's tagging (e.g. NASB), every word in the passage panel is underlined. Click any word to see the Hebrew or Greek lexicon entry. Use the Find all uses button to search across the whole translation for that word.");

    section("CSV import format");
    p("Settings → Bible Translations → Open Import Wizard. CSV columns:");
    const eg3 = help.createEl("pre", { cls: "bible-help-pre" });
    eg3.createEl("code", { text: "book_id, chapter, verse, text\n1,1,1,In the beginning<S>7225 God<S>430 created..." });
    p("book_id follows the standard Bible book order (Genesis = 1, … Revelation = 66). Strong's tags <S>number are optional — include them for word-level lookup. The H/G prefix is added automatically (books 1–39 = Hebrew, 40–66 = Greek).");
    p("The BSB (Berean Standard Bible) with Strong's numbers is bundled with this plugin and installed automatically. Additional translations can be imported here.");

    containerEl.createEl("hr");
    // ── Settings ──────────────────────────────────────────────────────────────

    const defaultPath = normalizePath(".obsidian/plugins/lightworx-bible/data/bible.db");
    containerEl.createEl("p", {
      text: `Default path (vault-relative): ${defaultPath}`,
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("SQLite Database Path")
      .setDesc("Vault-relative path to bible.db. Leave blank to use the default above.")
      .addText((text) => text
        .setPlaceholder("(using default path above)")
        .setValue(this.plugin.settings.dbPath)
        .onChange(async (value) => { this.plugin.settings.dbPath = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Default Translation")
      .addDropdown((drop) => {
        this.plugin.db.getTranslations().forEach((t) => drop.addOption(t, t.toUpperCase()));
        drop.setValue(this.plugin.settings.defaultTranslation);
        drop.onChange(async (value) => { this.plugin.settings.defaultTranslation = value; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("Passage insert mode")
      .setDesc("Copy to clipboard: text is placed on your clipboard so you can paste wherever you like. Insert at cursor: text is inserted directly into the active note at the cursor position.")
      .addDropdown((drop) => {
        drop.addOption("clipboard", "Copy to clipboard");
        drop.addOption("cursor", "Insert at cursor");
        drop.setValue(this.plugin.settings.insertMode ?? "clipboard");
        drop.onChange(async (value: "cursor" | "clipboard") => {
          this.plugin.settings.insertMode = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Enable Strong's numbers")
      .setDesc("When enabled, words in tagged translations (e.g. BSB, NASB) are underlined and clickable to show the original Hebrew or Greek lexicon entry. Disable if you prefer a cleaner reading experience without word-level tagging.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.strongsEnabled ?? true);
        toggle.onChange(async (value) => {
          this.plugin.settings.strongsEnabled = value;
          await this.plugin.saveSettings();
          // Refresh the sidebar so passage re-renders without/with tagging
          const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE);
          if (leaves.length) (leaves[0].view as any).render?.();
        });
      });

    new Setting(containerEl)
      .setName("Reading property")
      .setDesc("The frontmatter property that holds a note's Bible reading (e.g. reading: John 1:1-10). \"Find notes using a passage\" uses it, along with any bible code blocks in a note's body.")
      .addText((text) => text
        .setPlaceholder("reading")
        .setValue(this.plugin.settings.readingProperty ?? "reading")
        .onChange(async (value) => {
          this.plugin.settings.readingProperty = value.trim() || "reading";
          await this.plugin.saveSettings();
          this.plugin.scheduleUsageRebuild();
        })
      );

    new Setting(containerEl)
      .setName("Reload Database")
      .setDesc("Apply a new database path without restarting Obsidian.")
      .addButton((btn) => btn.setButtonText("Reload").onClick(async () => {
        await this.plugin.loadDatabase();
        new Notice(this.plugin.db.isLoaded() ? "✓ Database loaded." : "✗ Failed — check the path shown above.");
      }));

    // ── Import ────────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Bible Translations" });

    new Setting(containerEl)
      .setName("Download BSB database")
      .setDesc("Download the Berean Standard Bible with Strong's numbers from GitHub (~50 MB). Only needed if you skipped the initial setup or want to reset to the default database.")
      .addButton((btn) => btn.setButtonText("Download BSB").onClick(() => {
        const defaultVaultPath = normalizePath(".obsidian/plugins/lightworx-bible/data/bible.db");
        new BibleDownloadModal(this.app, this.plugin, defaultVaultPath, async () => {
          await this.plugin.loadDatabase();
        }).open();
      }));

    // Installed translations list
    const renderInstalled = () => {
      installedEl.empty();
      if (!this.plugin.db.isLoaded()) {
        installedEl.createEl("p", { text: "Load a database first.", cls: "setting-item-description" });
        return;
      }
      const installed = this.plugin.db.getInstalledTranslations();
      if (!installed.length) {
        installedEl.createEl("p", { text: "No translations installed yet.", cls: "setting-item-description" });
        return;
      }
      installed.forEach((slug) => {
        const row = installedEl.createDiv({ cls: "bible-import-installed-row" });
        row.createEl("span", { text: slug.toUpperCase(), cls: "bible-import-slug" });
        const delBtn = row.createEl("button", { text: "Remove", cls: "bible-btn-sm bible-btn-sm--danger" });
        delBtn.onclick = () => {
          this.plugin.db.deleteTranslation(slug);
          new Notice(`${slug.toUpperCase()} removed.`);
          renderInstalled();
        };
      });
    };

    const installedEl = containerEl.createDiv("bible-import-installed");
    renderInstalled();

    new Setting(containerEl)
      .setName("Import a translation from CSV")
      .setDesc("CSV format: book_id, chapter, verse, text  (one verse per row)")
      .addButton((btn) => btn.setButtonText("Open Import Wizard").onClick(() => {
        if (!this.plugin.db.isLoaded()) { new Notice("Load a database first."); return; }
        new BibleImportModal(this.app, this.plugin, () => renderInstalled()).open();
      }));
  }
}

// ─── Plugin Entry Point ───────────────────────────────────────────────────────

export default class BibleStudyPlugin extends Plugin {
  settings!: BiblePluginSettings;
  db: BibleDatabase = new BibleDatabase();
  private dbLoadCallbacks: (() => void)[] = [];

  // Passage usage index (in memory only; rebuilt from the vault on startup)
  private usageIndex = new Map<string, IndexedNote>();
  usageIndexReady = false;
  private usageBuild: Promise<void> | null = null;
  private usageRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  /** Call cb immediately if DB is ready, otherwise queue it for when it loads */
  onDbReady(cb: () => void): void {
    if (this.db.isLoaded()) cb();
    else this.dbLoadCallbacks.push(cb);
  }

  private flushDbCallbacks(): void {
    const cbs = this.dbLoadCallbacks.splice(0);
    cbs.forEach(cb => cb());
  }

  // ── Passage usage index ──────────────────────────────────────────────────────

  /** (Re)index one note. content may be null when the note has no code blocks to read. */
  indexNote(path: string, mtime: number, content: string | null, frontmatter: any): void {
    if (!this.db.isLoaded()) return;
    const readings = collectNoteReadings(
      content, frontmatter, this.settings.readingProperty || "reading",
      this.db.getBookList(), this.settings.defaultTranslation, this.db.getTranslations()
    );
    this.usageIndex.set(path, { path, mtime, readings });
  }

  /** Scan the vault. Unchanged notes (same mtime) are skipped, so repeat calls are cheap. */
  buildUsageIndex(force = false): Promise<void> {
    if (this.usageBuild) {
      // Already running — for a full rebuild, run another pass once it finishes
      return force ? this.usageBuild.then(() => this.buildUsageIndex(true)) : this.usageBuild;
    }
    if (force) { this.usageIndex.clear(); this.usageIndexReady = false; }
    this.usageBuild = this.runUsageBuild().finally(() => { this.usageBuild = null; });
    return this.usageBuild;
  }

  private async runUsageBuild(): Promise<void> {
    if (!this.db.isLoaded()) return;
    const seen = new Set<string>();
    let incomplete = false;
    let processed = 0;

    for (const file of this.app.vault.getMarkdownFiles()) {
      seen.add(file.path);
      const existing = this.usageIndex.get(file.path);
      if (existing && existing.mtime === file.stat.mtime) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) { incomplete = true; continue; }   // Obsidian hasn't indexed it yet; a later pass will

      // Only read the file when it contains a code block that could be a ```bible block
      const hasCode = (cache.sections ?? []).some((s: any) => s.type === "code");
      const content = hasCode ? await this.app.vault.cachedRead(file) : null;
      this.indexNote(file.path, file.stat.mtime, content, cache.frontmatter);

      if (++processed % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0));   // stay responsive
    }

    for (const path of Array.from(this.usageIndex.keys())) {
      if (!seen.has(path)) this.usageIndex.delete(path);
    }
    this.usageIndexReady = !incomplete;
  }

  scheduleUsageRebuild(): void {
    if (this.usageRebuildTimer) clearTimeout(this.usageRebuildTimer);
    this.usageRebuildTimer = setTimeout(() => {
      this.usageRebuildTimer = null;
      void this.buildUsageIndex(true);
    }, 800);
  }

  findPassageUsage(query: ParsedReading[]): UsageHit[] {
    return findUsage(this.usageIndex.values(), query);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadDatabase();
    this.registerView(VIEW_TYPE, (leaf) => new BibleStudyView(leaf, this));
    this.addRibbonIcon("book-open", "Bible", () => this.activateSidebar());
    this.addCommand({ id: "open-bible-sidebar", name: "Open Bible Sidebar", callback: () => this.activateSidebar() });

    this.addCommand({
      id: "bible-quick-insert",
      name: "Quick insert Bible passage",
      editorCallback: (editor: Editor) => {
        if (!this.db.isLoaded()) { new Notice("Bible plugin: database not loaded."); return; }
        new BibleQuickInsertModal(this.app, this, editor).open();
      },
    });

    this.addCommand({
      id: "bible-expand-refs",
      name: "Expand {{Bible references}} in note",
      editorCallback: (editor: Editor) => {
        if (!this.db.isLoaded()) { new Notice("Bible plugin: database not loaded."); return; }
        this.expandBibleRefs(editor);
      },
    });

    // ── Code block processor: ```bible ────────────────────────────────────────
    // Usage 1: direct reference
    //   ```bible
    //   John 1:1-10 NIV
    //   ```
    // Usage 2: read from frontmatter property
    //   ```bible
    //   frontmatter:reading
    //   ```
    this.registerMarkdownCodeBlockProcessor("bible", (source, el, ctx) => {
      this.renderBibleBlock(source.trim(), el, ctx);
    });

    // ── Find notes that use a passage ─────────────────────────────────────────
    this.addCommand({
      id: "bible-find-usage",
      name: "Find notes using a passage",
      callback: () => {
        if (!this.db.isLoaded()) { new Notice("Bible plugin: database not loaded."); return; }
        const sel = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.getSelection()?.trim() ?? "";
        new BibleUsageModal(this.app, this, sel.length <= 80 ? sel : "").open();
      },
    });

    // Build the index once Obsidian and the database are ready, then keep it in step with edits
    this.app.workspace.onLayoutReady(() => this.onDbReady(() => { void this.buildUsageIndex(); }));
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      if (!this.usageIndexReady && this.db.isLoaded()) void this.buildUsageIndex();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file: any, data: string, cache: any) => {
      if (file?.extension !== "md") return;
      this.indexNote(file.path, file.stat?.mtime ?? 0, data, cache?.frontmatter);
    }));
    this.registerEvent(this.app.vault.on("delete", (f: any) => { this.usageIndex.delete(f.path); }));
    this.registerEvent(this.app.vault.on("rename", (f: any, oldPath: string) => {
      const entry = this.usageIndex.get(oldPath);
      if (!entry) return;
      this.usageIndex.delete(oldPath);
      this.usageIndex.set(f.path, { ...entry, path: f.path });
    }));

    this.addSettingTab(new BibleSettingTab(this.app, this));
  }

  async onunload(): Promise<void> { this.db.close(); }

  async loadDatabase(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const defaultVaultPath = normalizePath(".obsidian/plugins/lightworx-bible/data/bible.db");
    const dbVaultPath = this.settings.dbPath
      ? normalizePath(this.settings.dbPath)
      : defaultVaultPath;

    // ── First-run: offer to download BSB ─────────────────────────────────────
    if (!this.settings.dbPath && !(await adapter.exists(dbVaultPath))) {
      new BibleDownloadModal(this.app, this, dbVaultPath, async () => {
        await this.loadDatabase();
      }).open();
      return; // loadDatabase will be called again by onComplete after download
    }

    console.log("Bible plugin: attempting to load DB from:", dbVaultPath);
    try {
      await this.db.load(adapter, dbVaultPath);
      console.log("Bible plugin: DB loaded successfully.");
      // Flush any code blocks that were waiting for the DB
      this.flushDbCallbacks();
      // Refresh sidebar if open
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      if (leaves.length) (leaves[0].view as any).render?.();
    } catch (e: any) {
      console.error("Bible plugin: DB load error", e);
      new Notice(`Bible plugin: could not load database.\nPath: ${dbVaultPath}\nError: ${e?.message ?? e}`);
    }
  }

  async activateSidebar(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** Show a reading in the sidebar's Passage tab, opening the sidebar first if it isn't open */
  async showReadingInSidebar(r: ResolvedReading): Promise<void> {
    const { chapter, startVerse, endVerse } = sidebarRangeFor(r.segments);
    await this.activateSidebar();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof BibleStudyView) view.showPassage(r.bookId, chapter, startVerse, endVerse, r.translation);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  expandBibleRefs(editor: Editor): void {
    const content = editor.getValue();
    const pattern = /\{\{([^}]+)\}\}/g;
    let match: RegExpExecArray | null;
    let newContent = content;
    let count = 0;
    const replacements: { original: string; replacement: string }[] = [];

    while ((match = pattern.exec(content)) !== null) {
      const original = match[0];
      const result = this.resolveReference(original);
      if (!result.ok) continue;
      replacements.push({ original, replacement: result.readings.map(readingToText).join("\n\n") });
      count++;
    }

    if (!count) { new Notice("No {{Bible references}} found in this note."); return; }
    for (const { original, replacement } of replacements) {
      newContent = newContent.split(original).join(replacement);
    }
    editor.setValue(newContent);
    new Notice(`Expanded ${count} Bible reference${count === 1 ? "" : "s"}.`);
  }

  /** Parse a reference string and fetch the verses for every reading in it */
  resolveReference(raw: string): { ok: true; readings: ResolvedReading[] } | { ok: false; error: string } {
    const parsed = parseReferences(raw, this.db.getBookList(), this.settings.defaultTranslation, this.db.getTranslations());
    if (!parsed.ok) return parsed;

    const readings: ResolvedReading[] = [];
    for (const r of parsed.readings) {
      const seen = new Set<string>();
      const verses: BibleVerse[] = [];
      for (const s of r.segments) {
        const found = this.db.getPassageRange(r.translation, r.book.id, s.startChapter, s.startVerse, s.endChapter, s.endVerse);
        for (const v of found) {
          const key = `${v.chapter}:${v.verse}`;
          if (!seen.has(key)) { seen.add(key); verses.push(v); }   // ignore overlaps like "1:1-5,3-7"
        }
      }
      const label = `${r.book.book} ${formatSegments(r.segments)}`;
      if (!verses.length) return { ok: false, error: `No verses found for ${label}.` };
      readings.push({ heading: `${label} (${r.translation.toUpperCase()})`, translation: r.translation, bookId: r.book.id, segments: r.segments, verses });
    }
    return { ok: true, readings };
  }

  renderBibleBlock(source: string, el: HTMLElement, ctx: any): void {
    el.addClass("bible-block");

    // ── Race condition 1: DB not loaded yet ───────────────────────────────────
    // Queue a re-render for when the DB is ready rather than showing an error
    if (!this.db.isLoaded()) {
      el.createEl("p", { text: "⏳ Loading Bible database…", cls: "bible-block-error" });
      this.onDbReady(() => {
        el.empty();
        this.renderBibleBlock(source, el, ctx);
      });
      return;
    }

    const renderError = (msg: string) => {
      el.empty();
      el.createEl("p", { text: `⚠ Bible: ${msg}`, cls: "bible-block-error" });
    };

    // ── Resolve the reference — direct or from frontmatter ────────────────────
    let refStr = source;
    const fmMatch = source.match(/^frontmatter:(.+)$/i);
    if (fmMatch) {
      const key = fmMatch[1].trim();

      // Always look up the specific key — don't short-circuit on the whole
      // frontmatter object, which may be {} (empty but not null/undefined)
      // A YAML list becomes "a; b" so its items are treated as separate readings
      const toStr = refValueToString;
      const getFmVal = (): string | null => {
        // ctx.frontmatter is a snapshot from render time
        const fromCtx = toStr(ctx.frontmatter?.[key]);
        if (fromCtx) return fromCtx;
        // Fresh lookup from the metadata cache
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (!file) return null;
        return toStr(this.app.metadataCache.getFileCache(file as any)?.frontmatter?.[key]);
      };

      const val = getFmVal();

      // ── Race condition 2: metadata cache not ready yet ────────────────────
      if (!val) {
        el.createEl("p", { text: "⏳ Loading…", cls: "bible-block-error" });

        let done = false;
        const retry = () => {
          if (done) return;
          done = true;
          el.empty();
          this.renderBibleBlock(source, el, ctx);
        };

        // Exponential backoff — cache usually resolves within a few hundred ms
        [150, 400, 1000, 2500].forEach(delay => {
          setTimeout(() => { if (!done && getFmVal()) retry(); }, delay);
        });

        // Fire when this specific file's cache entry is updated
        const changedRef = this.app.metadataCache.on("changed", (file) => {
          if (done || file.path !== ctx.sourcePath) return;
          this.app.metadataCache.offref(changedRef);
          if (getFmVal()) retry();
        });

        // Catch the one-time resolved event if we happen to be early enough
        const resolvedRef = this.app.metadataCache.on("resolved", () => {
          this.app.metadataCache.offref(resolvedRef);
          if (!done && getFmVal()) retry();
        });

        return;
      }

      refStr = val;
    }

    const result = this.resolveReference(refStr);
    if (!result.ok) {
      renderError(`${result.error}  (reference: "${refStr}")`);
      return;
    }

    // ── Render ────────────────────────────────────────────────────────────────
    el.empty();
    result.readings.forEach((r) => {
      const readingEl = el.createDiv("bible-block-reading");
      const headingEl = readingEl.createEl("div", { text: r.heading, cls: "bible-block-ref bible-block-ref--link" });
      headingEl.title = "Show in the Bible panel";
      headingEl.onclick = (e) => { e.stopPropagation(); void this.showReadingInSidebar(r); };
      const block = readingEl.createDiv("bible-block-body");
      labelVerses(r.verses).forEach(({ label, v }) => {
        const vEl = block.createEl("span", { cls: "bible-block-verse" });
        vEl.createEl("sup", { text: label, cls: "bible-block-verse-num" });
        vEl.createSpan({ text: v.words + " " });
      });
    });
  }

  deliverText(text: string): void {
    if (this.settings.insertMode === "clipboard") {
      // Try Electron clipboard (desktop), fall back to navigator.clipboard (mobile),
      // then fall back to execCommand as last resort
      const writeToClipboard = (): Promise<void> => {
        // Desktop: Electron clipboard via window.require
        try {
          const electron = (window as any).require?.("electron");
          const clipboard = electron?.clipboard ?? electron?.remote?.clipboard;
          if (clipboard) {
            clipboard.writeText(text);
            return Promise.resolve();
          }
        } catch { /* not in Electron context */ }

        // Mobile / web: navigator.clipboard (works in Obsidian mobile)
        if (navigator?.clipboard?.writeText) {
          return navigator.clipboard.writeText(text);
        }

        // Last resort: hidden textarea + execCommand
        const el = document.createElement("textarea");
        el.value = text;
        el.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        return Promise.resolve();
      };

      writeToClipboard()
        .then(() => new Notice("Passage copied to clipboard."))
        .catch(() => new Notice("Could not copy to clipboard."));
    } else {
      const leaf = this.app.workspace.getMostRecentLeaf();
      if (!leaf) { new Notice("No active editor found."); return; }
      const view = leaf.view;
      if (view instanceof MarkdownView && view.editor) {
        view.editor.replaceRange(text, view.editor.getCursor());
        new Notice("Passage inserted at cursor.");
      } else {
        new Notice("Please open a Markdown note to insert into.");
      }
    }
  }
}