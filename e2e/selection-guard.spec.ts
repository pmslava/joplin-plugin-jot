import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { callPluginCommand, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * The selection guard (src/form/selectionGuard.ts), in a real Joplin desktop.
 *
 * Joplin refreshes the note list after every tag change and selects a note again; in All notes (a smart filter, which keeps no last selected
 * note) it selects the list's FIRST note, which after a create is the note just made, so the editor leaves the note being read. The first case
 * shows Joplin doing that on its own (a note and a tag written through the data API, no Jot involved), so a Joplin that ever stops doing it shows
 * up here. The others run Jot's Create with a tag, by the shortcut's command and by the typed trigger, with the note list on All notes and a long
 * note scrolled to its middle: the editor must end on that note, at the same scroll offset, with the caret where it was.
 *
 * Launched with `envDev` (callPluginCommand) and the data API on its own port.
 */
test.describe('The selection guard (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-guard-${stamp}`;
  const API_PORT = 41211;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Guard ${stamp}`;
  const reading = `Reading ${stamp}`;
  const LONG_BODY = Array.from({ length: 240 }, (_, index) => `Line ${index + 1} of a long note that is being read.`).join('\n');
  let bookId = '';
  let readingId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    bookId = folders.items.find((folder: any) => folder.title === book).id;
    readingId = (await api.post('/notes', { parent_id: bookId, title: reading, body: LONG_BODY })).id;
    // Older notes first, so the reading note is not the list's first note by accident.
    for (let index = 0; index < 3; index++) await api.post('/notes', { parent_id: bookId, title: `Filler ${index} ${stamp}`, body: 'x' });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  async function findFormFrame(win: Page): Promise<Frame | null> {
    for (const frame of win.frames()) {
      if (await frame.locator('#jotForm').count().catch(() => 0)) return frame;
    }
    return null;
  }

  async function formFrame(win: Page): Promise<Frame> {
    await expect.poll(async () => (await findFormFrame(win)) != null, { timeout: 30_000 }).toBe(true);
    const frame = (await findFormFrame(win))!;
    await expect(frame.locator('#jotForm[data-jot-ready="1"]')).toHaveCount(1, { timeout: 10_000 });
    return frame;
  }

  function dialogButton(win: Page, label: string) {
    return win.locator('.user-webview-dialog button', { hasText: new RegExp(`^${label}$`) }).last();
  }

  /** The Markdown editor's view, read from CodeMirror itself. */
  async function editorView(win: Page): Promise<{ top: number; head: number; doc: string } | null> {
    return win.evaluate(() => {
      const content = document.querySelector('.cm-editor .cm-content') as any;
      const view = content && content.cmView && content.cmView.rootView && content.cmView.rootView.view;
      return view ? { top: Math.round(view.scrollDOM.scrollTop), head: view.state.selection.main.head, doc: view.state.doc.toString() } : null;
    });
  }

  /** Scrolls the editor to `top` and puts the caret at `head`, then reads the view back once it has settled. */
  async function placeView(win: Page, top: number, head: number): Promise<{ top: number; head: number; doc: string }> {
    await win.evaluate((target) => {
      const content = document.querySelector('.cm-editor .cm-content') as any;
      const view = content.cmView.rootView.view;
      view.focus();
      view.dispatch({ selection: { anchor: target.head } });
      view.scrollDOM.scrollTop = target.top;
    }, { top, head });
    await win.waitForTimeout(400);
    const view = await editorView(win);
    if (!view) throw new Error('no Markdown editor');
    return view;
  }

  /** The note list on All notes, with the reading note selected (clicked, as a user would). */
  async function readInAllNotes(win: Page): Promise<void> {
    await win.getByText('All notes', { exact: true }).first().click();
    await win.waitForTimeout(1200);
    await win.locator(`.note-list-item[data-id="${readingId}"]`).first().click();
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);
    await expect.poll(async () => ((await editorView(win)) || { doc: '' }).doc.startsWith('Line 1 of'), { timeout: 20_000 }).toBe(true);
  }

  async function noteIdByTitle(title: string): Promise<string> {
    const listed = await api.get(`/folders/${bookId}/notes?fields=id,title&limit=100`);
    const found = listed.items.find((item: any) => item.title === title);
    return found ? found.id : '';
  }

  test('Joplin on its own: in All notes, a tag on a new note selects that note (the reason for the guard)', async () => {
    const { win } = joplin;
    await readInAllNotes(win);
    const note = await api.post('/notes', { parent_id: bookId, title: `Joplin alone ${stamp}`, is_todo: 1 });
    const tag = await api.post('/tags', { title: `guard-alone-${stamp}` });
    await api.post(`/tags/${tag.id}/notes`, { id: note.id });
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 10_000 }).toBe(note.id);
  });

  test('the shortcut route: Create with a tag in All notes ends on the note being read, at the same scroll offset and caret', async () => {
    const { win } = joplin;
    await readInAllNotes(win);
    const before = await placeView(win, 1800, 5000);
    expect(before.top).toBeGreaterThan(1000);
    const title = `Guarded create ${stamp}`;
    const pending = callPluginCommand(win, 'jot.open');
    pending.catch(() => undefined);
    const form = await formFrame(win);
    await form.locator('#jotTitle').fill(title);
    await form.locator('#jotTags').fill(`guard-${stamp}`);
    await dialogButton(win, 'Create').click();
    const outcome: any = await pending;
    expect(outcome && outcome.opened).toBe(false);
    expect(await noteIdByTitle(title)).toBe(outcome.id);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 10_000 }).toBe(readingId);
    await expect.poll(async () => {
      const view = await editorView(win);
      return view ? `${Math.abs(view.top - before.top) <= 3} ${view.head}` : 'none';
    }, { timeout: 10_000 }).toBe(`true ${before.head}`);
    const tags = await api.get(`/notes/${outcome.id}/tags?fields=title`);
    expect(tags.items.map((item: any) => item.title)).toEqual([`guard-${stamp}`]);
  });

  test('the typed trigger: ++ with a tag in All notes writes the link in the note being read and ends there, scrolled as it was', async () => {
    const { win } = joplin;
    await readInAllNotes(win);
    const lineEnd = LONG_BODY.indexOf('\n', LONG_BODY.indexOf('Line 120 of'));
    await placeView(win, 1800, lineEnd);
    await win.keyboard.type(' ++');
    const form = await formFrame(win);
    const title = `Guarded trigger ${stamp}`;
    await form.locator('#jotTitle').fill(title);
    await form.locator('#jotTags').fill(`guard-${stamp}`);
    const before = await editorView(win);
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => noteIdByTitle(title), { timeout: 10_000 }).not.toBe('');
    const id = await noteIdByTitle(title);
    // The tags go out after the answer; give the guard its window to see a jump and undo it.
    await win.waitForTimeout(3500);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 10_000 }).toBe(readingId);
    await expect.poll(async () => ((await editorView(win)) || { doc: '' }).doc.includes(`of a long note that is being read. [${title}](:/${id})`), { timeout: 10_000 }).toBe(true);
    const view = await editorView(win);
    expect(Math.abs(view!.top - before!.top)).toBeLessThanOrEqual(40);
    await expect.poll(async () => (await api.get(`/notes/${readingId}?fields=body`)).body.includes(`[${title}](:/${id})`), { timeout: 15_000 }).toBe(true);
  });
});
