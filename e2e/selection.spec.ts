import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { callPluginCommand, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * Jot's selection route in the Markdown editor (CodeMirror 6), in a real Joplin desktop (brief 4.4, phase 2).
 *
 * Each case writes a two-line note through Joplin's data API, opens it, highlights text in the editor with the
 * keyboard (a click to focus, Ctrl+Home, then Shift+End for the first line or Ctrl+Shift+End for both), and runs
 * `jot.fromSelection` - the command the editor's right-click menu runs, with no argument - through the app's
 * CommandService (hence `launchJoplin({ envDev: true })`). The command is NOT awaited at once: it resolves only
 * when the form has been answered and the note written, so each case starts it, drives the dialog, then awaits it.
 * What the In this note choice did to the source note is read back through the data API once the editor has saved.
 *
 * The In this note default is the choice remembered from the last create in this profile, so `lastChoice` follows
 * it; it is reset in beforeAll, with the fresh profile (whose default is replace), so a retried case in a new worker
 * expects the right one.
 */
test.describe('The selection route (desktop, Markdown editor)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-selection-${stamp}`;
  const API_PORT = 41208;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Selection ${stamp}`;
  let bookId = '';
  let lastChoice = 'replace';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    const found = folders.items.find((folder: any) => folder.title === book);
    if (!found) throw new Error(`no notebook ${book}`);
    bookId = found.id;
    lastChoice = 'replace';
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

  /** One of Joplin's dialog buttons, by its exact label (so "Create" never matches "Create and open"). */
  function dialogButton(win: Page, label: string) {
    return win.locator('.user-webview-dialog button', { hasText: new RegExp(`^${label}$`) }).last();
  }

  /** Start jot.fromSelection without waiting for it: it resolves when the form is answered. */
  function startFromSelection(win: Page): Promise<any> {
    const pending = callPluginCommand(win, 'jot.fromSelection');
    pending.catch(() => undefined);
    return pending;
  }

  async function noteBody(id: string): Promise<string> {
    return (await api.get(`/notes/${id}?fields=body`)).body;
  }

  async function editorText(win: Page): Promise<string> {
    return win.locator('.cm-content').first().evaluate((el) => (el as HTMLElement).innerText);
  }

  /** Writes a note through the data API and opens it in the editor; resolves its id once the editor shows its body. */
  async function openSourceNote(win: Page, title: string, body: string): Promise<string> {
    const note = await api.post('/notes', { parent_id: bookId, title, body });
    await callPluginCommand(win, 'openNote', note.id);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(note.id);
    await expect.poll(async () => editorText(win), { timeout: 20_000 }).toBe(body);
    return note.id;
  }

  /** Clicks into the CodeMirror body until the focus is really there (the title input takes it otherwise). */
  async function focusEditor(win: Page): Promise<void> {
    const content = win.locator('.cm-content').first();
    for (let attempt = 0; attempt < 10; attempt++) {
      await content.click();
      await win.waitForTimeout(150);
      const inside = await win.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.cm-editor'));
      if (inside) return;
    }
    throw new Error('Could not move the focus into the CodeMirror editor');
  }

  /** Highlights the first line (Ctrl+Home, Shift+End) or the whole body (Ctrl+Home, Ctrl+Shift+End) by keyboard. */
  async function highlight(win: Page, what: 'firstLine' | 'all', expected: string): Promise<void> {
    await focusEditor(win);
    await win.keyboard.press('Control+Home');
    await win.keyboard.press(what === 'firstLine' ? 'Shift+End' : 'Control+Shift+End');
    // The very command the plugin reads, through the same CommandService.
    await expect.poll(async () => callPluginCommand(win, 'selectedText'), { timeout: 10_000 }).toBe(expected);
  }

  /** Checks the In this note row (the three buttons, the remembered default) and picks `choice`. */
  async function chooseInThisNote(form: Frame, choice: string): Promise<void> {
    await expect(form.locator('#jotInThisNoteRow')).toBeVisible();
    await expect(form.locator('.jot-choice-option')).toHaveText(['Replace it with a link to the new note', 'Keep the text', 'Add a link after it']);
    await expect(form.locator('#jotInThisNote')).toHaveValue(lastChoice);
    await form.locator(`.jot-choice-option[data-choice="${choice}"]`).click();
    await expect(form.locator('#jotInThisNote')).toHaveValue(choice);
    await expect(form.locator(`.jot-choice-option[data-choice="${choice}"]`)).toHaveAttribute('aria-checked', 'true');
  }

  test('replace: both lines highlighted prefill the Title and the Text; Create replaces them with [Title](:/id) and the editor keeps its note', async () => {
    const { win } = joplin;
    const title = `Call the bank ${stamp}`;
    const body = `${title}\nabout the card`;
    const sourceId = await openSourceNote(win, `Source replace ${stamp}`, body);
    await highlight(win, 'all', body);

    const pending = startFromSelection(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotTitle')).toHaveValue(title);
    await expect(form.locator('#jotBody')).toHaveValue('about the card');
    await chooseInThisNote(form, 'replace');
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    const outcome = await pending;
    expect(outcome && outcome.opened).toBe(false);
    lastChoice = 'replace';
    const link = `[${title}](:/${outcome.id})`;
    await expect.poll(async () => noteBody(sourceId), { timeout: 30_000 }).toBe(link);
    expect((await noteBody(sourceId)).split('\n')[0]).toBe(link);
    const created = await api.get(`/notes/${outcome.id}?fields=title,body,parent_id`);
    expect([created.title, created.body, created.parent_id]).toEqual([title, 'about the card', bookId]);
    // Create opened nothing: the editor still holds the source note, now showing the link.
    expect(await selectedNoteId(win)).toBe(sourceId);
    await expect.poll(async () => editorText(win), { timeout: 10_000 }).toBe(link);
  });

  test('after: the first line highlighted is the Title with no Text; Create adds the link after it on the same line', async () => {
    const { win } = joplin;
    const title = `Pay rent ${stamp}`;
    const body = `${title}\nby Friday`;
    const sourceId = await openSourceNote(win, `Source after ${stamp}`, body);
    await highlight(win, 'firstLine', title);

    const pending = startFromSelection(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotTitle')).toHaveValue(title);
    await expect(form.locator('#jotBody')).toHaveValue('');
    await chooseInThisNote(form, 'after');
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    const outcome = await pending;
    expect(outcome && outcome.opened).toBe(false);
    lastChoice = 'after';
    const expected = `${title} [${title}](:/${outcome.id})\nby Friday`;
    await expect.poll(async () => noteBody(sourceId), { timeout: 30_000 }).toBe(expected);
    expect(await selectedNoteId(win)).toBe(sourceId);
  });

  test('keep with Create and open: the source note is left as it was and the editor shows the new note', async () => {
    const { win } = joplin;
    const title = `Idea ${stamp}`;
    const body = `${title}\nfor later`;
    const sourceId = await openSourceNote(win, `Source keep ${stamp}`, body);
    await highlight(win, 'all', body);

    const pending = startFromSelection(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotTitle')).toHaveValue(title);
    await expect(form.locator('#jotBody')).toHaveValue('for later');
    await chooseInThisNote(form, 'keep');
    await dialogButton(win, 'Create and open').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    const outcome = await pending;
    expect(outcome && outcome.opened).toBe(true);
    lastChoice = 'keep';
    await expect.poll(async () => selectedNoteId(win), { timeout: 20_000 }).toBe(outcome.id);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 20_000 }).toBe(title);
    await expect.poll(async () => editorText(win), { timeout: 20_000 }).toBe('for later');
    // Give a stray save every chance to land before the source note is read back.
    await win.waitForTimeout(2000);
    expect(await noteBody(sourceId)).toBe(body);
  });
});
