import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  WorkspaceLeaf,
  ItemView,
} from "obsidian";
import * as path from "path";

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

interface BiblePluginSettings {
  dbPath: string;
  defaultTranslation: string;
}

const DEFAULT_SETTINGS: BiblePluginSettings = {
  dbPath: "",
  defaultTranslation: "niv",
};

const TRANSLATIONS = ["gnt", "niv", "ceb", "msg", "nrsv"];
const VIEW_TYPE = "bible-study-view";

class BibleDatabase {
  private db: any = null;
  private books: Book[] = [];

  // The WASM binary is bundled inline — no external files needed
  async load(pluginDir: string, dbPath: string): Promise<void> {
    const fs = require("fs");
    const initSqlJs = require("sql.js/dist/sql-wasm.js");
    // wasmBinary is injected at build time via esbuild binary loader
    const wasmBinary: Uint8Array = require("./sql-wasm.wasm");
    const SQL = await initSqlJs({ wasmBinary });
    const fileBuffer = fs.readFileSync(dbPath);
    this.db = new SQL.Database(fileBuffer);
    this.books = this.fetchBooks();
  }

  isLoaded(): boolean { return this.db !== null; }

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

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }
}

// ─── Reference Parser ────────────────────────────────────────────────────────
// Parses strings like "John 3:16", "Romans 8:1-4", "Romans 8:1-4 NIV"
// Returns null if the reference can't be resolved.

interface ParsedRef {
  book: Book;
  chapter: number;
  startVerse: number;
  endVerse: number;
  translation: string;
}

function parseReference(raw: string, books: Book[], defaultTranslation: string): ParsedRef | null {
  // Strip outer {{ }} if present
  const s = raw.replace(/^\{\{|\}\}$/g, "").trim();

  // Optional translation suffix, e.g. "NIV" or "GNT"
  const transMatch = s.match(/\s+(GNT|NIV|CEB|MSG|NRSV)$/i);
  const translation = transMatch ? transMatch[1].toLowerCase() : defaultTranslation;
  const refStr = transMatch ? s.slice(0, -transMatch[0].length).trim() : s;

  // Match "Book Chapter:Verse" or "Book Chapter:Verse-EndVerse"
  const m = refStr.match(/^(.+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (!m) return null;

  const [, bookRaw, chapterStr, startStr, endStr] = m;
  const chapter = parseInt(chapterStr);
  const startVerse = parseInt(startStr);
  const endVerse = endStr ? parseInt(endStr) : startVerse;

  // Match book name — try exact first, then case-insensitive prefix
  const bookQuery = bookRaw.trim().toLowerCase();
  const book =
    books.find((b) => b.book.toLowerCase() === bookQuery) ??
    books.find((b) => b.abbreviation.toLowerCase() === bookQuery) ??
    books.find((b) => b.book.toLowerCase().startsWith(bookQuery));

  if (!book) return null;
  return { book, chapter, startVerse, endVerse, translation };
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

      // Show preview
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
    // Focus the input after the modal renders
    setTimeout(() => input.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

class BibleStudyView extends ItemView {
  private plugin: BibleStudyPlugin;
  private currentMode: "passage" | "search" = "passage";

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
    const searchTab = tabs.createEl("button", { text: "Search", cls: "bible-tab" });
    if (this.currentMode === "passage") passageTab.addClass("active");
    else searchTab.addClass("active");

    const body = container.createDiv("bible-body");

    passageTab.onclick = () => {
      this.currentMode = "passage";
      passageTab.addClass("active"); searchTab.removeClass("active");
      body.empty(); this.renderPassagePanel(body);
    };
    searchTab.onclick = () => {
      this.currentMode = "search";
      searchTab.addClass("active"); passageTab.removeClass("active");
      body.empty(); this.renderSearchPanel(body);
    };

    if (!this.plugin.db.isLoaded()) {
      body.createEl("p", { text: "⚠  No database loaded. Set the path in Settings → Bible.", cls: "bible-notice" });
      return;
    }

    if (this.currentMode === "passage") this.renderPassagePanel(body);
    else this.renderSearchPanel(body);
  }

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

    const lookupBtn = container.createEl("button", { text: "Look Up Passage", cls: "bible-btn" });
    const results = container.createDiv("bible-results");

    lookupBtn.onclick = () => {
      const translation = translationSel.value;
      const bookId = parseInt(bookSel.value);
      const chapter = parseInt(chapterSel.value);
      const startVerse = parseInt(verseStartSel.value);
      const endVerse = parseInt(verseEndSel.value);
      const bookName = books.find((b) => b.id === bookId)?.book ?? "";

      const verses = this.plugin.db.getPassage(translation, bookId, chapter, startVerse, endVerse);
      results.empty();

      if (!verses.length) {
        results.createEl("p", { text: "No verses found.", cls: "bible-empty" }); return;
      }

      const refLine = `${bookName} ${chapter}:${startVerse}${endVerse > startVerse ? `–${endVerse}` : ""} (${translation.toUpperCase()})`;
      results.createEl("div", { text: refLine, cls: "bible-ref" });

      const block = results.createDiv("bible-verse-block");
      verses.forEach((v) => {
        const vEl = block.createDiv("bible-verse");
        vEl.createEl("sup", { text: String(v.verse), cls: "bible-verse-num" });
        vEl.createSpan({ text: " " + v.words });
      });

      const insertBtn = results.createEl("button", { text: "⬆  Insert into Note", cls: "bible-btn bible-insert-btn" });
      insertBtn.onclick = () => {
        const text = this.buildInsertText(bookName, chapter, startVerse, endVerse, translation, verses);
        this.insertIntoEditor(text);
      };
    };
  }

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
        item.createEl("div", { text: `${v.book_name} ${v.chapter}:${v.verse}`, cls: "bible-search-ref" });
        item.createEl("div", { text: v.words, cls: "bible-search-text" });
        const insertBtn = item.createEl("button", { text: "Insert", cls: "bible-btn-sm" });
        insertBtn.onclick = () => {
          const text = this.buildInsertText(v.book_name, v.chapter, v.verse, v.verse, translationSel.value,
            [{ book_id: v.book_id, chapter: v.chapter, verse: v.verse, words: v.words }]);
          this.insertIntoEditor(text);
        };
      });
    };

    searchBtn.onclick = doSearch;
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  }

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
      new Notice("Passage inserted.");
    } else {
      new Notice("Please open a Markdown note to insert into.");
    }
  }
}

class BibleSettingTab extends PluginSettingTab {
  plugin: BibleStudyPlugin;
  constructor(app: App, plugin: BibleStudyPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Bible Settings" });

    // Show the resolved default path so the user can confirm it looks right
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

export default class BibleStudyPlugin extends Plugin {
  settings!: BiblePluginSettings;
  db: BibleDatabase = new BibleDatabase();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadDatabase();
    this.registerView(VIEW_TYPE, (leaf) => new BibleStudyView(leaf, this));
    this.addRibbonIcon("book-open", "Bible", () => this.activateSidebar());
    this.addCommand({ id: "open-bible-sidebar", name: "Open Bible Sidebar", callback: () => this.activateSidebar() });

    // Command 1: Quick insert modal — assign a hotkey in Settings → Hotkeys
    this.addCommand({
      id: "bible-quick-insert",
      name: "Quick insert Bible passage",
      editorCallback: (editor: Editor) => {
        if (!this.db.isLoaded()) { new Notice("Bible plugin: database not loaded."); return; }
        new BibleQuickInsertModal(this.app, this, editor).open();
      },
    });

    // Command 2: Expand {{reference}} tags already typed in the note
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
    const dbPath = this.settings.dbPath ||
      path.join(pluginDir, "data", "bible.db");
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

    // Collect all matches first (replacing as we go would shift offsets)
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

    // Apply replacements (replace all occurrences of each tag)
    for (const { original, replacement } of replacements) {
      newContent = newContent.split(original).join(replacement);
    }

    editor.setValue(newContent);
    new Notice(`Expanded ${count} Bible reference${count === 1 ? "" : "s"}.`);
  }
}