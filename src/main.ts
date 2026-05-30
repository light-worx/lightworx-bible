import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
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
}

const DEFAULT_SETTINGS: BiblePluginSettings = {
  dbPath: "",
  defaultTranslation: "niv",
  insertMode: "clipboard",
};

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

    // readBinary works on both desktop and mobile via Obsidian's adapter
    const fileBuffer = await adapter.readBinary(dbVaultPath);
    this.db = new SQL.Database(new Uint8Array(fileBuffer));
    this.ensureNotesSchema();
    this.books = this.fetchBooks();
  }

  isLoaded(): boolean { return this.db !== null; }

  // ── Schema ──────────────────────────────────────────────────────────────────

  private ensureNotesSchema(): void {
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
    // Don't await — schema save can be fire-and-forget on first run
    this.saveToDisk();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  saveToDisk(): void {
    if (!this.db || !this.adapter || !this.dbVaultPath) return;
    try {
      const data: Uint8Array = this.db.export();
      // writeBinary is available on both desktop and mobile adapters
      this.adapter.writeBinary(this.dbVaultPath, data.buffer).catch((e: any) => {
        console.error("Bible plugin: failed to save DB", e);
      });
    } catch (e: any) {
      console.error("Bible plugin: failed to export DB", e);
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

  createNote(note: Omit<BibleNote, "id" | "created_at" | "updated_at">): number {
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
    this.saveToDisk();
    return id;
  }

  updateNote(id: number, body: string, tags: string | null): void {
    if (!this.db) return;
    const safeBody = body.replace(/'/g, "''");
    const safeTags = tags === null ? "NULL" : `'${tags.replace(/'/g, "''")}'`;
    this.db.run(
      `UPDATE notes SET body = '${safeBody}', tags = ${safeTags}, updated_at = datetime('now') WHERE id = ${id}`
    );
    this.saveToDisk();
  }

  deleteNote(id: number): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM notes WHERE id = ${id}`);
    this.saveToDisk();
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

  importTranslation(
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
    this.saveToDisk();
  }

  deleteTranslation(slug: string): void {
    if (!this.db) return;
    this.db.run(`DROP TABLE IF EXISTS ${slug.toLowerCase()}_verses`);
    this.saveToDisk();
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
    // strongs_list column holds space-separated numbers e.g. "H7225 H430 H1254"
    const res = this.db.exec(
      `SELECT v.book_id, v.chapter, v.verse, v.words, b.book as book_name
       FROM ${table} v JOIN books b ON b.id = v.book_id
       WHERE v.strongs_list LIKE '% ${safe} %'
          OR v.strongs_list LIKE '${safe} %'
          OR v.strongs_list LIKE '% ${safe}'
          OR v.strongs_list = '${safe}'
       ORDER BY v.book_id, v.chapter, v.verse LIMIT ${limit}`
    );
    if (!res.length) return [];
    return res[0].values.map((r: any[]) => ({
      book_id: r[0], chapter: r[1], verse: r[2], words: r[3], book_name: r[4],
    }));
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

interface ParsedRef {
  book: Book;
  chapter: number;
  startVerse: number;
  endVerse: number;
  translation: string;
}

function parseReference(raw: string, books: Book[], defaultTranslation: string, translations?: string[]): ParsedRef | null {
  const s = raw.replace(/^\{\{|\}\}$/g, "").trim();
  // Match any known translation suffix, or fall back to a generic 2-5 uppercase letter word
  const transPattern = translations && translations.length
    ? `(${translations.map(t => t.toUpperCase()).join("|")})`
    : `([A-Z]{2,5})`;
  const transMatch = s.match(new RegExp(`\\s+${transPattern}$`, "i"));
  const translation = transMatch ? transMatch[1].toLowerCase() : defaultTranslation;
  const refStr = transMatch ? s.slice(0, -transMatch[0].length).trim() : s;
  const m = refStr.match(/^(.+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const [, bookRaw, chapterStr, startStr, endStr] = m;
  const chapter = parseInt(chapterStr);
  const startVerse = parseInt(startStr);
  const endVerse = endStr ? parseInt(endStr) : startVerse;
  const bookQuery = bookRaw.trim().toLowerCase();
  const book =
    books.find((b) => b.book.toLowerCase() === bookQuery) ??
    books.find((b) => b.abbreviation.toLowerCase() === bookQuery) ??
    books.find((b) => b.book.toLowerCase().startsWith(bookQuery));
  if (!book) return null;
  return { book, chapter, startVerse, endVerse, translation };
}

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
      text: 'Type a reference, e.g.  John 3:16  or  Romans 8:1-4 NIV',
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

    let lastParsed: ParsedRef | null = null;
    let lastVerses: BibleVerse[] = [];

    const tryParse = () => {
      const val = input.value.trim();
      preview.empty();
      feedback.setText("");
      insertBtn.disabled = true;
      lastParsed = null;
      lastVerses = [];

      if (!val) return;

      const parsed = parseReference(val, this.plugin.db.getBookList(), this.plugin.settings.defaultTranslation, this.plugin.db.getTranslations());
      if (!parsed) {
        feedback.setText('⚠  Reference not recognised — try e.g. "John 3:16" or "Rom 8:1-4 GNT"');
        return;
      }

      const verses = this.plugin.db.getPassage(
        parsed.translation, parsed.book.id, parsed.chapter, parsed.startVerse, parsed.endVerse
      );

      if (!verses.length) {
        feedback.setText("⚠  No verses found for that reference.");
        return;
      }

      lastParsed = parsed;
      lastVerses = verses;

      const refPart = parsed.endVerse > parsed.startVerse
        ? `${parsed.startVerse}–${parsed.endVerse}` : `${parsed.startVerse}`;
      const refLine = `${parsed.book.book} ${parsed.chapter}:${refPart} (${parsed.translation.toUpperCase()})`;
      preview.createEl("div", { text: refLine, cls: "bible-ref" });
      const block = preview.createDiv("bible-verse-block");
      verses.forEach((v) => {
        const vEl = block.createDiv("bible-verse");
        vEl.createEl("sup", { text: String(v.verse), cls: "bible-verse-num" });
        vEl.createSpan({ text: " " + v.words });
      });
      insertBtn.disabled = false;
    };

    input.addEventListener("input", tryParse);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !insertBtn.disabled) doInsert();
    });

    const doInsert = () => {
      if (!lastParsed || !lastVerses.length) return;
      const refPart = lastParsed.endVerse > lastParsed.startVerse
        ? `${lastParsed.startVerse}–${lastParsed.endVerse}` : `${lastParsed.startVerse}`;
      const ref = `${lastParsed.book.book} ${lastParsed.chapter}:${refPart} (${lastParsed.translation.toUpperCase()})`;
      const text = lastVerses.map((v) => `${v.verse} ${v.words}`).join(" ");
      this.plugin.deliverText(`${ref}\n${text}\n`);
      this.close();
    };

    insertBtn.onclick = doInsert;
    setTimeout(() => input.focus(), 50);
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

  /** Switch to the Passage tab and open the given verse, defaulting to whole chapter */
  navigateToPassage(bookId: number, chapter: number, verse: number, translation: string): void {
    this.currentPassage = {
      translation,
      bookId,
      chapter,
      startVerse: Math.max(1, verse - 2),
      endVerse: verse + 2,
    };
    this.currentMode = "passage";
    this.render();
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

    // ── Row 1: Trans. | Book | Ch. | From | To ───────────────────────────────
    const row1 = container.createDiv("bible-row-inline bible-controls-row");

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

      // ── Nav row: ‹  BOOK Ch:Vv–Vv  › ─────────────────────────────────────
      const refEl = results.createDiv("bible-ref");

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

      // ── Verse block ────────────────────────────────────────────────────────
      const hasTagging = this.plugin.db.translationHasTagging(translation);
      const hasStrongs = hasTagging && this.plugin.db.hasStrongsTable();

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
                span.onclick = (e) => {
                  e.stopPropagation();
                  console.log("Bible plugin: word clicked", tok.strongs, "ref.panel=", ref.panel);
                  showStrongs(tok.strongs!, span);
                };
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
      const isStrongs = strongsOverride || /^[HG]\d+$/i.test(query);

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
      .setName("Reload Database")
      .setDesc("Apply a new database path without restarting Obsidian.")
      .addButton((btn) => btn.setButtonText("Reload").onClick(async () => {
        await this.plugin.loadDatabase();
        new Notice(this.plugin.db.isLoaded() ? "✓ Database loaded." : "✗ Failed — check the path shown above.");
      }));

    // ── Import ────────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Bible Translations" });

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

    this.addSettingTab(new BibleSettingTab(this.app, this));
  }

  async onunload(): Promise<void> { this.db.close(); }

  async loadDatabase(): Promise<void> {
    const adapter = this.app.vault.adapter;
    // Use a vault-relative path — works on both desktop and mobile
    const defaultVaultPath = normalizePath(
      `.obsidian/plugins/lightworx-bible/data/bible.db`
    );
    // If the user set a custom path assume it is also vault-relative;
    // if they put an absolute path on desktop it will still be tried via the adapter
    const dbVaultPath = this.settings.dbPath
      ? normalizePath(this.settings.dbPath)
      : defaultVaultPath;

    console.log("Bible plugin: attempting to load DB from:", dbVaultPath);
    try {
      await this.db.load(adapter, dbVaultPath);
      console.log("Bible plugin: DB loaded successfully.");
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
      const parsed = parseReference(original, this.db.getBookList(), this.settings.defaultTranslation, this.db.getTranslations());
      if (!parsed) continue;
      const verses = this.db.getPassage(
        parsed.translation, parsed.book.id, parsed.chapter, parsed.startVerse, parsed.endVerse
      );
      if (!verses.length) continue;
      const refPart = parsed.endVerse > parsed.startVerse
        ? `${parsed.startVerse}–${parsed.endVerse}` : `${parsed.startVerse}`;
      const ref = `${parsed.book.book} ${parsed.chapter}:${refPart} (${parsed.translation.toUpperCase()})`;
      const text = verses.map((v) => `${v.verse} ${v.words}`).join(" ");
      replacements.push({ original, replacement: `${ref}\n${text}` });
      count++;
    }

    if (!count) { new Notice("No {{Bible references}} found in this note."); return; }
    for (const { original, replacement } of replacements) {
      newContent = newContent.split(original).join(replacement);
    }
    editor.setValue(newContent);
    new Notice(`Expanded ${count} Bible reference${count === 1 ? "" : "s"}.`);
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