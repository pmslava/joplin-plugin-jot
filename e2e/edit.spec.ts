import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { callPluginCommand, createNote, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * Jot's edit mode and the command contract, in a real Joplin desktop (brief 4.5 and section 6, phase 4).
 *
 * Each case writes a to-do with a tag and a due date through Joplin's data API, then runs `jot.open` with
 * { mode: 'edit', noteId } through the app's CommandService, as another plugin (Cockpit's Quick edit…) would (hence
 * `launchJoplin({ envDev: true })`). The command is NOT awaited at once: it resolves only when the form has been
 * answered and the note written, so each case starts it, drives the dialog, then awaits what it resolved
 * ({ id, changed } or null). What was written is read back through the data API.
 *
 * The edited to-dos are never opened: the editor holds the note made in beforeAll throughout, and edit mode must
 * leave it there. The dialog's fields live in a plugin webview iframe; its Save and Cancel are Joplin's buttons, in
 * the main window.
 */
test.describe('Edit mode (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-edit-${stamp}`;
  const API_PORT = 41210;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Edit ${stamp}`;
  const before = `Before ${stamp}`;
  const tag = `jot-edit-${stamp}`;
  // A due date with no seconds, which the form shows as 2026-12-03 14:45 in the machine's local time.
  const DUE = new Date(2026, 11, 3, 14, 45, 0, 0).getTime();
  const NOTE_FIELDS = 'id,title,body,parent_id,is_todo,todo_due,todo_completed,updated_time';
  let bookId = '';
  let beforeId = '';
  let tagId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, book);
    beforeId = await createNote(win, before);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    const found = folders.items.find((folder: any) => folder.title === book);
    if (!found) throw new Error(`no notebook ${book}`);
    bookId = found.id;
    tagId = (await api.post('/tags', { title: tag })).id;
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

  /** One of Joplin's dialog buttons, by its exact label. */
  function dialogButton(win: Page, label: string) {
    return win.locator('.user-webview-dialog button', { hasText: new RegExp(`^${label}$`) }).last();
  }

  /** Start jot.open in edit mode without waiting for it: it resolves when the form is answered. */
  function startEdit(win: Page, noteId: string): Promise<any> {
    const pending = callPluginCommand(win, 'jot.open', { mode: 'edit', noteId });
    pending.catch(() => undefined);
    return pending;
  }

  /** A to-do in the notebook, with the tag, the due date and a body, written through the data API (never opened). */
  async function makeTodo(title: string): Promise<string> {
    const note = await api.post('/notes', { parent_id: bookId, title, body: `body of ${title}`, is_todo: 1, todo_due: DUE });
    await api.post(`/tags/${tagId}/notes`, { id: note.id });
    return note.id;
  }

  async function readNote(id: string): Promise<any> {
    return api.get(`/notes/${id}?fields=${NOTE_FIELDS}`);
  }

  async function noteTags(id: string): Promise<string[]> {
    return (await api.get(`/notes/${id}/tags?fields=id,title`)).items.map((item: any) => item.title);
  }

  /** The editor still holds the note it had before the case. */
  async function editorKeptItsNote(win: Page): Promise<void> {
    await win.waitForTimeout(1000);
    expect(await selectedNoteId(win)).toBe(beforeId);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 10_000 }).toBe(before);
  }

  test('the form opens as Edit to-do with the title, notebook, tag and due prefilled; a new title and Enter in the Title save only the title', async () => {
    const { win } = joplin;
    const title = `Edit me ${stamp}`;
    const id = await makeTodo(title);
    const original = await readNote(id);
    expect(await selectedNoteId(win)).toBe(beforeId);

    const pending = startEdit(win, id);
    const form = await formFrame(win);
    await expect(form.locator('#jotHeading')).toHaveText('Edit to-do');
    await expect(form.locator('#jotTitle')).toHaveValue(title);
    await expect(form.locator('#jotNotebook')).toHaveValue(book);
    await expect(form.locator('#jotTags')).toHaveValue(tag);
    await expect(form.locator('#jotDueText')).toHaveText('2026-12-03 14:45');
    await expect(form.locator('#jotTypeRow .jot-seg-option[data-value="todo"]')).toHaveAttribute('aria-checked', 'true');
    await expect(form.locator('#jotBody')).toHaveCount(0);
    await expect(form.locator('#jotInThisNoteRow')).toHaveCount(0);
    await expect(dialogButton(win, 'Save')).toBeVisible();
    await expect(dialogButton(win, 'Cancel')).toBeVisible();
    await expect(dialogButton(win, 'Create')).toHaveCount(0);
    await expect
      .poll(() => form.evaluate(() => (document.activeElement as HTMLInputElement | null)?.id || ''), { timeout: 10_000 })
      .toBe('jotTitle');

    await form.locator('#jotTitle').fill(`${title} renamed`);
    await win.keyboard.press('Enter');
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    expect(await pending).toEqual({ id, changed: ['title'] });
    const note = await readNote(id);
    expect(note.title).toBe(`${title} renamed`);
    expect([note.is_todo, note.todo_due, note.parent_id, note.body]).toEqual([1, original.todo_due, bookId, original.body]);
    expect(await noteTags(id)).toEqual([tag]);
    await editorKeptItsNote(win);
  });

  test('Type switched to Note and Save: is_todo 0 and todo_due 0, the command lists both, and the title and the tag are untouched', async () => {
    const { win } = joplin;
    const title = `Switch me ${stamp}`;
    const id = await makeTodo(title);

    const pending = startEdit(win, id);
    const form = await formFrame(win);
    await expect(form.locator('#jotHeading')).toHaveText('Edit to-do');
    await form.locator('#jotTypeRow .jot-seg-option[data-value="note"]').click();
    await expect(form.locator('#jotHeading')).toHaveText('Edit note');
    await expect(form.locator('#jotBell')).toBeDisabled();
    await dialogButton(win, 'Save').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    expect(await pending).toEqual({ id, changed: ['is_todo', 'todo_due'] });
    const note = await readNote(id);
    expect([note.is_todo, note.todo_due, note.todo_completed]).toEqual([0, 0, 0]);
    expect([note.title, note.parent_id, note.body]).toEqual([title, bookId, `body of ${title}`]);
    expect(await noteTags(id)).toEqual([tag]);
    await editorKeptItsNote(win);
  });

  test('Cancel writes nothing, whatever was changed in the form, and the command resolves null', async () => {
    const { win } = joplin;
    const title = `Leave me ${stamp}`;
    const id = await makeTodo(title);
    const original = await readNote(id);

    const pending = startEdit(win, id);
    const form = await formFrame(win);
    await form.locator('#jotTitle').fill('Never saved');
    await form.locator('#jotTypeRow .jot-seg-option[data-value="note"]').click();
    await dialogButton(win, 'Cancel').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    expect(await pending).toBeNull();
    // Give a stray write every chance to land before the note is read back; updated_time shows any write at all.
    await win.waitForTimeout(1500);
    expect(await readNote(id)).toEqual(original);
    expect(await noteTags(id)).toEqual([tag]);
    await editorKeptItsNote(win);
  });
});
