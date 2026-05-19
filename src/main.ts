import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  ItemView,
} from "obsidian";
import * as path from "path";

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

interface BiblePluginSettings {
  dbPath: string;
  defaultTranslation: string;
}

const DEFAULT_SETTINGS: BiblePluginSettings = {
  dbPath: "",
  defaultTranslation: "niv",
};

const TRANSLATIONS = ["gnt", "niv"];
const VIEW_TYPE = "bible-study-view";

// ─── Database ─────────────────────────────────────────────────────────────────

class BibleDatabase {
  private db: any = null;
  private books: Book[] = [];
  private dbPath: string = "";

  async load(pluginDir: string, dbPath: string): Promise<void> {
    const fs = require("fs");
    const initSqlJs = require("sql.js/dist/sql-wasm.js");
    const wasmBinary: Uint8Array = require("./sql-wasm.wasm");
    const SQL = await initSqlJs({ wasmBinary });
    const fileBuffer = fs.readFileSync(dbPath);
    this.db = new SQL.Database(fileBuffer);
    this.dbPath = dbPath;
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
    this.saveToDisk();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  saveToDisk(): void {
    if (!this.db || !this.dbPath) return;
    const fs = require("fs");
    try {
      const data: Uint8Array = this.db.export();
      fs.writeFileSync(this.dbPath, data);
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ParsedRef {
  book: Book;
  chapter: number;
  startVerse: number;
  endVerse: number;
  translation: string;
}

function parseReference(raw: string, books: Book[], defaultTranslation: string): ParsedRef | null {
  const s = raw.replace(/^\{\{|\}\}$/g, "").trim();
  const transMatch = s.match(/\s+(GNT|NIV|CEB|MSG)$/i);
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
      text: "Insert into Note",
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

      const parsed = parseReference(val, this.plugin.db.getBookList(), this.plugin.settings.defaultTranslation);
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
      this.editor.replaceRange(`${ref}\n${text}\n`, this.editor.getCursor());
      new Notice("Passage inserted.");
      this.close();
    };

    insertBtn.onclick = doInsert;
    setTimeout(() => input.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
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

  constructor(leaf: WorkspaceLeaf, plugin: BibleStudyPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Bible"; }
  getIcon(): string { return "book-open"; }

  async onOpen(): Promise<void> { this.render(); }
  async onClose(): Promise<void> {}

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

    const row1 = container.createDiv("bible-row");
    row1.createEl("label", { text: "Translation", cls: "bible-label" });
    const translationSel = row1.createEl("select", { cls: "bible-select" });
    TRANSLATIONS.forEach((t) => {
      const opt = translationSel.createEl("option", { text: t.toUpperCase(), value: t });
      if (t === this.plugin.settings.defaultTranslation) opt.selected = true;
    });

    const row2 = container.createDiv("bible-row");
    row2.createEl("label", { text: "Book", cls: "bible-label" });
    const bookSel = row2.createEl("select", { cls: "bible-select" });
    books.forEach((b) => bookSel.createEl("option", { text: b.book, value: String(b.id) }));

    const row3 = container.createDiv("bible-row bible-row-inline");
    row3.createEl("label", { text: "Ch.", cls: "bible-label" });
    const chapterSel = row3.createEl("select", { cls: "bible-select-sm" });
    row3.createEl("label", { text: "Verses", cls: "bible-label" });
    const verseStartSel = row3.createEl("select", { cls: "bible-select-sm" });
    row3.createEl("span", { text: "–", cls: "bible-dash" });
    const verseEndSel = row3.createEl("select", { cls: "bible-select-sm" });

    const populateVerses = () => {
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
    };

    const populateChapters = () => {
      const bookId = parseInt(bookSel.value);
      const count = this.plugin.db.getChapterCount(bookId);
      chapterSel.empty();
      for (let i = 1; i <= count; i++) chapterSel.createEl("option", { text: String(i), value: String(i) });
      populateVerses();
    };

    bookSel.onchange = populateChapters;
    chapterSel.onchange = populateVerses;
    translationSel.onchange = populateVerses;
    populateChapters();

    // Restore previous passage selection
    if (this.currentPassage) {
      const p = this.currentPassage;
      translationSel.value = p.translation;
      bookSel.value = String(p.bookId);
      populateChapters();
      chapterSel.value = String(p.chapter);
      populateVerses();
      verseStartSel.value = String(p.startVerse);
      verseEndSel.value = String(p.endVerse);
    }

    const lookupBtn = container.createEl("button", { text: "Look Up Passage", cls: "bible-btn" });
    const results = container.createDiv("bible-results");

    // Auto-run if a previous passage is stored
    if (this.currentPassage) setTimeout(() => lookupBtn.click(), 0);

    lookupBtn.onclick = () => {
      const translation = translationSel.value;
      const bookId = parseInt(bookSel.value);
      const chapter = parseInt(chapterSel.value);
      const startVerse = parseInt(verseStartSel.value);
      const endVerse = parseInt(verseEndSel.value);
      const bookObj = books.find((b) => b.id === bookId);
      const bookName = bookObj?.book ?? "";

      const verses = this.plugin.db.getPassage(translation, bookId, chapter, startVerse, endVerse);
      results.empty();

      if (!verses.length) {
        results.createEl("p", { text: "No verses found.", cls: "bible-empty" }); return;
      }

      // Persist so Notes tab can filter to it and it survives tab switches
      this.currentPassage = { translation, bookId, chapter, startVerse, endVerse };

      // ── Fetch notes pre-split by scope ──────────────────────────────────────
      const { bookNotes, chapterNotes, verseNotes } =
        this.plugin.db.getPassageNotesByScope(bookId, chapter, startVerse, endVerse);

      // ── Build the heading from individual spans so book/chapter can be badged ─
      const refEl = results.createDiv("bible-ref");

      // Book name span — badge if book-level notes exist
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
          new BibleNoteModal(this.app, this.plugin, () => lookupBtn.click(), bookNotes[0]).open();
        };
      }

      refEl.createEl("span", { text: " " });

      // Chapter number span — badge if chapter-level notes exist
      const chapterLabel = `${chapter}:${startVerse}${endVerse > startVerse ? `–${endVerse}` : ""}`;
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
          new BibleNoteModal(this.app, this.plugin, () => lookupBtn.click(), chapterNotes[0]).open();
        };
      }

      refEl.createEl("span", { text: ` (${translation.toUpperCase()})` });

      // ── Verse block ──────────────────────────────────────────────────────────
      const block = results.createDiv("bible-verse-block");
      verses.forEach((v) => {
        const vEl = block.createDiv("bible-verse");
        const vNotes = verseNotes.get(v.verse) ?? [];

        const numEl = vEl.createEl("sup", {
          text: String(v.verse),
          cls: vNotes.length ? "bible-verse-num bible-verse-num--noted" : "bible-verse-num",
        });
        vEl.createSpan({ text: " " + v.words });

        if (vNotes.length) {
          const tooltip = vEl.createDiv("bible-verse-tooltip");
          this.buildTooltipContent(tooltip, vNotes, books);
          numEl.addEventListener("mouseenter", () => tooltip.addClass("bible-verse-tooltip--visible"));
          numEl.addEventListener("mouseleave", () => tooltip.removeClass("bible-verse-tooltip--visible"));
          numEl.onclick = (e) => {
            e.stopPropagation();
            new BibleNoteModal(this.app, this.plugin, () => lookupBtn.click(), vNotes[0]).open();
          };
        }
      });

      // ── Notes panel below verses ─────────────────────────────────────────────
      this.renderPassageNotes(results, bookId, bookName, chapter, startVerse, endVerse);

      const insertBtn = results.createEl("button", { text: "⬆  Insert into Note", cls: "bible-btn bible-insert-btn" });
      insertBtn.onclick = () => {
        const text = this.buildInsertText(bookName, chapter, startVerse, endVerse, translation, verses);
        this.insertIntoEditor(text);
      };
    };
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
    TRANSLATIONS.forEach((t) => {
      const opt = translationSel.createEl("option", { text: t.toUpperCase(), value: t });
      if (t === this.plugin.settings.defaultTranslation) opt.selected = true;
    });

    const row2 = container.createDiv("bible-row");
    const searchInput = row2.createEl("input", {
      type: "text", placeholder: "Search for words or phrases…", cls: "bible-search-input",
    });

    const searchBtn = container.createEl("button", { text: "Search", cls: "bible-btn" });
    const results = container.createDiv("bible-results");

    const doSearch = () => {
      const query = searchInput.value.trim();
      if (!query) return;
      const hits = this.plugin.db.searchWords(translationSel.value, query);
      results.empty();

      if (!hits.length) { results.createEl("p", { text: "No results found.", cls: "bible-empty" }); return; }

      results.createEl("div", { text: `${hits.length} result${hits.length === 1 ? "" : "s"}`, cls: "bible-ref" });

      hits.forEach((v) => {
        const item = results.createDiv("bible-search-result");
        const refRow = item.createEl("div", { cls: "bible-search-ref" });
        refRow.createEl("span", { text: `${v.book_name} ${v.chapter}:${v.verse}` });
        const btnGroup = refRow.createDiv("bible-search-ref-btns");
        const insertBtn = btnGroup.createEl("button", { text: "Insert", cls: "bible-btn-sm" });
        insertBtn.onclick = () => {
          const text = this.buildInsertText(v.book_name, v.chapter, v.verse, v.verse, translationSel.value,
            [{ book_id: v.book_id, chapter: v.chapter, verse: v.verse, words: v.words }]);
          this.insertIntoEditor(text);
        };
        const noteBtn = btnGroup.createEl("button", { text: "Note", cls: "bible-btn-sm" });
        noteBtn.onclick = () => {
          const books = this.plugin.db.getBookList();
          new BibleNoteModal(this.app, this.plugin, () => {}, null, {
            book_id: v.book_id, bookName: v.book_name, chapter: v.chapter,
            verse_start: v.verse, verse_end: v.verse,
          }).open();
        };
        item.createEl("div", { text: v.words, cls: "bible-search-text" });
      });
    };

    searchBtn.onclick = doSearch;
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
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
          this.insertIntoEditor(text);
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

  private insertIntoEditor(text: string): void {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) { new Notice("No active editor found."); return; }
    const view = leaf.view;
    if (view instanceof MarkdownView && view.editor) {
      view.editor.replaceRange(text, view.editor.getCursor());
      new Notice("Inserted.");
    } else {
      new Notice("Please open a Markdown note to insert into.");
    }
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

    const adapter = this.plugin.app.vault.adapter as any;
    const basePath = adapter.basePath ?? adapter.getBasePath?.() ?? adapter.fs?.basePath ?? "(could not resolve vault path)";
    const resolvedDefault = path.join(basePath, ".obsidian", "plugins", "lightworx-bible", "data", "bible.db");
    containerEl.createEl("p", {
      text: `Resolved default path: ${resolvedDefault}`,
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("SQLite Database Path")
      .setDesc("Override the default path above. Leave blank to use the default.")
      .addText((text) => text
        .setPlaceholder("(using default path above)")
        .setValue(this.plugin.settings.dbPath)
        .onChange(async (value) => { this.plugin.settings.dbPath = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Default Translation")
      .addDropdown((drop) => {
        TRANSLATIONS.forEach((t) => drop.addOption(t, t.toUpperCase()));
        drop.setValue(this.plugin.settings.defaultTranslation);
        drop.onChange(async (value) => { this.plugin.settings.defaultTranslation = value; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("Reload Database")
      .setDesc("Apply a new database path without restarting Obsidian.")
      .addButton((btn) => btn.setButtonText("Reload").onClick(async () => {
        await this.plugin.loadDatabase();
        new Notice(this.plugin.db.isLoaded() ? "✓ Database loaded." : "✗ Failed — check the path shown above.");
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
    const adapter = this.app.vault.adapter as any;
    const basePath = adapter.basePath ?? adapter.getBasePath?.() ?? adapter.fs?.basePath ?? "";
    const pluginDir = path.join(basePath, ".obsidian", "plugins", "lightworx-bible");
    const dbPath = this.settings.dbPath || path.join(pluginDir, "data", "bible.db");
    console.log("Bible plugin: attempting to load DB from:", dbPath);
    try {
      await this.db.load(pluginDir, dbPath);
      console.log("Bible plugin: DB loaded successfully.");
    } catch (e: any) {
      console.error("Bible plugin: DB load error", e);
      new Notice(`Bible plugin: could not load database.\nPath: ${dbPath}\nError: ${e?.message ?? e}`);
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
      const parsed = parseReference(original, this.db.getBookList(), this.settings.defaultTranslation);
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
}