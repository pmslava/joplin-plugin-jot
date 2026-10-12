import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { activateJoplinMenuItem, callPluginCommand, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * Jot's typed trigger in the Markdown editor (CodeMirror 6), in a real Joplin desktop (brief 4.4, phase 3).
 *
 * Each case writes an empty note through Joplin's data API, opens it (`openNote` through the app's CommandService,
 * hence `launchJoplin({ envDev: true })`), puts the caret in the editor and TYPES with the keyboard, which is what
 * the content script listens for. The form is opened by the content script's message, not by a command the spec
 * starts, so a case simply waits for the dialog to appear, drives it, and reads back what the content script did to
 * the editor's document (CodeMirror's own state, read from the page) and what was created (the data API).
 *
 * The In this note default is the choice remembered from the last create in this profile, so `lastChoice` follows
 * it; it is reset in beforeAll, with the fresh profile, so a retried case in a new worker expects the right one.
 * The last case changes the trigger setting through the Options screen, so it runs last.
 */
test.describe('The typed trigger (desktop, Markdown editor)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-trigger-${stamp}`;
  const API_PORT = 41209;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Trigger ${stamp}`;
  let bookId = '';
  let lastChoice = 'link';
  // How long a case waits to be sure that something did NOT open the form.
  const QUIET_MS = 2500;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    const found = folders.items.find((folder: any) => folder.title === book);
    if (!found) throw new Error(`no notebook ${book}`);
    bookId = found.id;
    lastChoice = 'link';
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

  /** Wait for the form dialog and return its frame, once its script has wired it. */
  async function formFrame(win: Page): Promise<Frame> {
    await expect.poll(async () => (await findFormFrame(win)) != null, { timeout: 30_000 }).toBe(true);
    const frame = (await findFormFrame(win))!;
    await expect(frame.locator('#jotForm[data-jot-ready="1"]')).toHaveCount(1, { timeout: 10_000 });
    return frame;
  }

  async function formIsOpen(win: Page): Promise<boolean> {
    return (await findFormFrame(win)) != null;
  }

  /** Waits QUIET_MS and checks that no form appeared meanwhile. */
  async function expectNoForm(win: Page): Promise<void> {
    const deadline = Date.now() + QUIET_MS;
    while (Date.now() < deadline) {
      expect(await formIsOpen(win)).toBe(false);
      await win.waitForTimeout(250);
    }
  }

  /** One of Joplin's dialog buttons, by its exact label. */
  function dialogButton(win: Page, label: string) {
    return win.locator('.user-webview-dialog button', { hasText: new RegExp(`^${label}$`) }).last();
  }

  /**
   * The editor's document, from CodeMirror's own state: Joplin's CodeMirror tags the content element with its view
   * (`cmView`, whose `rootView.view` is the EditorView), so trailing spaces and empty lines read exactly. Falls back
   * to the rendered text if that handle is ever missing.
   */
  async function editorDoc(win: Page): Promise<string> {
    return win.evaluate(() => {
      const content = document.querySelector('.cm-editor .cm-content') as any;
      if (!content) return '<no editor>';
      const root = content.cmView && content.cmView.rootView;
      const view = root && root.view;
      return view ? view.state.doc.toString() : (content as HTMLElement).innerText;
    });
  }

  async function editorHasFocus(win: Page): Promise<boolean> {
    return win.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.cm-editor'));
  }

  /** Clicks into the CodeMirror body until the focus is really there, then puts the caret at the end. */
  async function focusEditorAtEnd(win: Page): Promise<void> {
    const content = win.locator('.cm-content').first();
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await editorHasFocus(win)) break;
      await content.click();
      await win.waitForTimeout(150);
    }
    if (!(await editorHasFocus(win))) throw new Error('Could not move the focus into the CodeMirror editor');
    await win.keyboard.press('Control+End');
  }

  /** Writes an empty note through the data API, opens it, and puts the caret in its body. */
  async function openEmptyNote(win: Page, title: string): Promise<string> {
    const note = await api.post('/notes', { parent_id: bookId, title, body: '' });
    await callPluginCommand(win, 'openNote', note.id);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(note.id);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 20_000 }).toBe(title);
    await expect.poll(async () => editorDoc(win), { timeout: 20_000 }).toBe('');
    await focusEditorAtEnd(win);
    return note.id;
  }

  /** The id of the note titled `title` in the spec's notebook, or '' when there is none. */
  async function noteIdByTitle(title: string): Promise<string> {
    const listed = await api.get(`/folders/${bookId}/notes?fields=id,title&limit=100`);
    const found = listed.items.find((item: any) => item.title === title);
    return found ? found.id : '';
  }

  /** Checks the In this note row of the trigger route (the two buttons with the trigger printed, the remembered default). */
  async function expectTriggerRow(form: Frame, trigger = '++'): Promise<void> {
    await expect(form.locator('#jotInThisNoteRow')).toBeVisible();
    await expect(form.locator('#jotInThisNoteRow .jot-seg-option')).toHaveText([`Replace ${trigger} with link`, `Remove ${trigger}`]);
    await expect(form.locator('#jotInThisNote')).toHaveValue(lastChoice);
    await expect(form.locator('#jotTitle')).toHaveValue('');
  }

  async function choose(form: Frame, choice: string): Promise<void> {
    await form.locator(`#jotInThisNoteRow .jot-seg-option[data-value="${choice}"]`).click();
    await expect(form.locator('#jotInThisNote')).toHaveValue(choice);
  }

  test('remove: "hello ++" typed opens the form; Create removes the ++ in one undo step, the note exists, and the editor keeps the focus and the caret', async () => {
    const { win } = joplin;
    const title = `Trigger remove ${stamp}`;
    const sourceId = await openEmptyNote(win, `Source remove ${stamp}`);
    await win.keyboard.type('hello ++');

    const form = await formFrame(win);
    await expectTriggerRow(form);
    await choose(form, 'remove');
    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    lastChoice = 'remove';

    await expect.poll(async () => editorDoc(win), { timeout: 20_000 }).toBe('hello ');
    await expect.poll(async () => noteIdByTitle(title), { timeout: 20_000 }).not.toBe('');
    // Create opened nothing, and nothing moved the focus: it is back in the editor, the caret where the trigger was.
    expect(await selectedNoteId(win)).toBe(sourceId);
    await expect.poll(async () => editorHasFocus(win), { timeout: 10_000 }).toBe(true);
    // One Undo restores what was typed (and an undo never fires the trigger); Redo takes it away again (Ctrl+Z and Ctrl+Y,
    // Joplin's own globalUndo and globalRedo on Linux).
    await win.keyboard.press('Control+z');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('hello ++');
    expect(await formIsOpen(win)).toBe(false);
    await win.keyboard.press('Control+y');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('hello ');
    await win.keyboard.type('world');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('hello world');
    expect(await formIsOpen(win)).toBe(false);
    await expect.poll(async () => (await api.get(`/notes/${sourceId}?fields=body`)).body, { timeout: 30_000 }).toBe('hello world');
  });

  test('link: Create with "Replace ++ with a link" turns the line into "hello [Title](:/id)"', async () => {
    const { win } = joplin;
    const title = `Trigger link ${stamp}`;
    const sourceId = await openEmptyNote(win, `Source link ${stamp}`);
    await win.keyboard.type('hello ++');

    const form = await formFrame(win);
    await expectTriggerRow(form);
    await choose(form, 'link');
    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    lastChoice = 'link';

    await expect.poll(async () => noteIdByTitle(title), { timeout: 20_000 }).not.toBe('');
    const id = await noteIdByTitle(title);
    const expected = `hello [${title}](:/${id})`;
    await expect.poll(async () => editorDoc(win), { timeout: 20_000 }).toBe(expected);
    await expect.poll(async () => (await api.get(`/notes/${sourceId}?fields=body`)).body, { timeout: 30_000 }).toBe(expected);
    expect(await selectedNoteId(win)).toBe(sourceId);
  });

  test('cancel: the ++ stays, and typing one more character does not reopen the form', async () => {
    const { win } = joplin;
    await openEmptyNote(win, `Source cancel ${stamp}`);
    const before = (await api.get(`/folders/${bookId}/notes?fields=id&limit=100`)).items.length;
    await win.keyboard.type('hello ++');

    const form = await formFrame(win);
    await expectTriggerRow(form);
    await dialogButton(win, 'Cancel').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('hello ++');
    if (!(await editorHasFocus(win))) await focusEditorAtEnd(win);
    await win.keyboard.type('x');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('hello ++x');
    await expectNoForm(win);
    expect((await api.get(`/folders/${bookId}/notes?fields=id&limit=100`)).items.length).toBe(before);
  });

  test('C++ typed without a space before it opens nothing (and a ++ after a space still does)', async () => {
    const { win } = joplin;
    await openEmptyNote(win, `Source cpp ${stamp}`);
    await win.keyboard.type('C++ and i++');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('C++ and i++');
    await expectNoForm(win);

    // The trigger is alive in this note: the negative above is not a dead content script.
    await win.keyboard.type(' ++');
    await formFrame(win);
    await dialogButton(win, 'Cancel').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('C++ and i++ ++');
  });

  test('the trigger arriving by paste or by the insertText command opens nothing', async () => {
    const { win } = joplin;
    await openEmptyNote(win, `Source paste ${stamp}`);
    await win.keyboard.type('via paste ');
    await win.evaluate((text) => (window as any).require('electron').clipboard.writeText(text), '++');
    await win.keyboard.press('Control+v');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('via paste ++');
    await expectNoForm(win);

    await win.keyboard.type(' via insertText');
    await callPluginCommand(win, 'insertText', ' ++');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('via paste ++ via insertText ++');
    await expectNoForm(win);

    if (!(await editorHasFocus(win))) await focusEditorAtEnd(win);
    await win.keyboard.type(' ++');
    await formFrame(win);
    await dialogButton(win, 'Cancel').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
  });

  test('Open on In editor: the ++ is removed from the note it was typed in, and then the new note opens in the editor', async () => {
    const { win } = joplin;
    const title = `Trigger open ${stamp}`;
    const sourceId = await openEmptyNote(win, `Source open ${stamp}`);
    await win.keyboard.type('carry on ++');

    const form = await formFrame(win);
    await expectTriggerRow(form);
    await choose(form, 'remove');
    await form.locator('#jotTitle').fill(title);
    await form.locator('#jotOpenRow .jot-seg-option[data-value="editor"]').click();
    await expect(form.locator('#jotOpen')).toHaveValue('editor');
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    lastChoice = 'remove';

    await expect.poll(async () => noteIdByTitle(title), { timeout: 20_000 }).not.toBe('');
    const id = await noteIdByTitle(title);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(id);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 20_000 }).toBe(title);
    await expect.poll(async () => editorDoc(win), { timeout: 20_000 }).toBe('');
    // The edit reached the note the trigger was typed in, and was saved there before the editor switched.
    await expect.poll(async () => (await api.get(`/notes/${sourceId}?fields=body`)).body, { timeout: 30_000 }).toBe('carry on ');
  });

  test('a changed trigger setting applies as soon as the Options screen is left: ;; opens the form in the same note, ++ no longer does', async () => {
    const { win } = joplin;
    const sourceId = await openEmptyNote(win, `Source setting ${stamp}`);

    const opened = await activateJoplinMenuItem(win, /^(Options|Preferences\.\.\.)$/);
    expect(opened).toBe(true);
    const screen = win.locator('.config-screen');
    await screen.waitFor({ state: 'visible', timeout: 60_000 });
    await screen.getByRole('tab', { name: 'Jot', exact: true }).first().click();
    const field = win.getByLabel('Typed trigger', { exact: true }).first();
    await field.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(field).toHaveValue('++');
    await field.fill(';;');
    await field.blur();
    await expect.poll(async () => field.inputValue(), { timeout: 10_000 }).toBe(';;');
    await screen.locator('.button-bar button', { hasText: 'OK' }).first().click();
    await expect.poll(async () => screen.isVisible().catch(() => false), { timeout: 30_000 }).toBe(false);

    // Back on the same note, with no other note opened in between.
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(sourceId);
    await expect.poll(async () => editorDoc(win), { timeout: 20_000 }).toBe('');
    await focusEditorAtEnd(win);
    await win.keyboard.type('old ++');
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('old ++');
    await expectNoForm(win);
    await win.keyboard.type(' new ;;');
    const form = await formFrame(win);
    await expectTriggerRow(form, ';;');
    await dialogButton(win, 'Cancel').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    await expect.poll(async () => editorDoc(win), { timeout: 10_000 }).toBe('old ++ new ;;');
  });
});
