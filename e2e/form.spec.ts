import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  callPluginCommand,
  createNote,
  createNotebook,
  dataApi,
  dataApiSettings,
  selectedNoteId,
} from './helpers';

/**
 * Jot's form in create mode, in a real Joplin desktop (brief 4.1 to 4.3, phase 1).
 *
 * The form is opened the way another plugin would open it, `jot.open` through the app's CommandService (hence
 * `launchJoplin({ envDev: true })`), and the command is NOT awaited at once: it resolves only when the form has
 * been answered and the note written, so each case starts it, drives the dialog, then awaits what it resolved
 * ({ id, opened }). What was written is read back through Joplin's own data API, enabled on the throwaway profile.
 *
 * The dialog's fields live in a plugin webview iframe; its Create / Create and open / Cancel buttons are Joplin's,
 * in the main window. A closed dialog unmounts its iframe, so "the form is gone" is "no frame holds #jotForm".
 */
test.describe('The form, create mode (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-${stamp}`;
  const API_PORT = 41207;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Book ${stamp}`;
  const other = `Jot Other ${stamp}`;
  const before = `Before ${stamp}`;
  let beforeId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, other);
    await createNotebook(win, book);
    beforeId = await createNote(win, before);
    await api.ready(win);
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

  /** Wait for the form dialog and return its frame. */
  async function formFrame(win: Page): Promise<Frame> {
    await expect.poll(async () => (await findFormFrame(win)) != null, { timeout: 30_000 }).toBe(true);
    const frame = (await findFormFrame(win))!;
    await expect(frame.locator('#jotForm[data-jot-ready="1"]')).toHaveCount(1, { timeout: 10_000 });
    return frame;
  }

  async function formIsOpen(win: Page): Promise<boolean> {
    return (await findFormFrame(win)) != null;
  }

  /** Start jot.open without waiting for it: it resolves when the form is answered. */
  function startJot(win: Page): Promise<any> {
    const pending = callPluginCommand(win, 'jot.open');
    pending.catch(() => undefined);
    return pending;
  }

  /** One of Joplin's dialog buttons, by its exact label (so "Create" never matches "Create and open"). */
  function dialogButton(win: Page, label: string) {
    return win.locator('.user-webview-dialog button', { hasText: new RegExp(`^${label}$`) }).last();
  }

  async function folderId(title: string): Promise<string> {
    const folders = await api.get('/folders?fields=id,title&limit=100');
    const found = folders.items.find((folder: any) => folder.title === title);
    if (!found) throw new Error(`no notebook ${title}`);
    return found.id;
  }

  async function readNote(id: string): Promise<any> {
    return api.get(`/notes/${id}?fields=id,title,body,parent_id,is_todo,todo_due`);
  }

  async function dialogHeight(win: Page): Promise<number> {
    const box = await win.locator('dialog.user-webview-dialog iframe').first().boundingBox();
    return box ? Math.round(box.height) : -1;
  }

  test('the form opens with the Title focused; typing a title and Enter creates it, and the editor keeps its note', async () => {
    const { win } = joplin;
    const title = `jot-enter-${stamp}`;
    expect(await selectedNoteId(win)).toBe(beforeId);

    const pending = startJot(win);
    const form = await formFrame(win);
    await expect
      .poll(() => form.evaluate(() => (document.activeElement as HTMLInputElement | null)?.id || ''), { timeout: 10_000 })
      .toBe('jotTitle');
    await expect(form.locator('#jotHeading')).toHaveText('New to-do');
    await expect(form.locator('#jotNotebook')).toHaveValue(book);

    await win.keyboard.type(title);
    await win.keyboard.press('Enter');
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    const outcome = await pending;
    expect(outcome && outcome.opened).toBe(false);
    const note = await readNote(outcome.id);
    expect(note.title).toBe(title);
    expect(note.parent_id).toBe(await folderId(book));
    expect(note.is_todo).toBe(1);
    expect(note.todo_due).toBe(0);
    // The note is in the profile by its title, not only by the id the command reported.
    const listed = await api.get(`/folders/${note.parent_id}/notes?fields=id,title&limit=100`);
    expect(listed.items.some((item: any) => item.title === title)).toBe(true);

    // Create opened nothing: the editor still holds the note it had.
    await win.waitForTimeout(1000);
    expect(await selectedNoteId(win)).toBe(beforeId);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 10_000 }).toBe(before);
  });

  test('Enter in the Notebook suggestion list picks the row and does not create; the dialog keeps its size', async () => {
    const { win } = joplin;
    const title = `jot-suggest-${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await form.locator('#jotTitle').fill(title);

    const heightBefore = await dialogHeight(win);
    await form.locator('#jotNotebook').click();
    await win.keyboard.type('other');
    await expect(form.locator('#jotNotebookList .jot-suggest-row')).toHaveText([other]);
    expect(await dialogHeight(win)).toBe(heightBefore);

    await win.keyboard.press('Enter');
    await win.waitForTimeout(1000);
    expect(await formIsOpen(win)).toBe(true);
    await expect(form.locator('#jotNotebook')).toHaveValue(other);
    await expect(form.locator('#jotNotebookList')).toBeHidden();

    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    const outcome = await pending;
    const note = await readNote(outcome.id);
    expect(note.title).toBe(title);
    expect(note.parent_id).toBe(await folderId(other));
  });

  test('a click in the Notebook field opens the whole list on the current notebook; the chevron opens it too; a clicked row is where Create puts the note', async () => {
    const { win } = joplin;
    const title = `jot-combo-${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await form.locator('#jotTitle').fill(title);
    const heightBefore = await dialogHeight(win);

    await form.locator('#jotNotebook').click();
    await expect(form.locator('#jotNotebookList')).toBeVisible();
    await expect(form.locator('#jotNotebookList .jot-suggest-row', { hasText: other })).toHaveCount(1);
    await expect(form.locator('#jotNotebookList .jot-suggest-row.-highlighted')).toHaveText(book);
    expect(await dialogHeight(win)).toBe(heightBefore);

    // Escape closes the list; the chevron opens it again, with the focus still in the field.
    await win.keyboard.press('Escape');
    await expect(form.locator('#jotNotebookList')).toBeHidden();
    await form.locator('#jotNotebookOpen').click();
    await expect(form.locator('#jotNotebookList')).toBeVisible();
    await expect(form.locator('#jotNotebookList .jot-suggest-row.-highlighted')).toHaveText(book);
    expect(await form.evaluate(() => (document.activeElement as HTMLElement | null)?.id || '')).toBe('jotNotebook');

    await form.locator('#jotNotebookList .jot-suggest-row', { hasText: other }).click();
    await expect(form.locator('#jotNotebookList')).toBeHidden();
    await expect(form.locator('#jotNotebook')).toHaveValue(other);

    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    const outcome = await pending;
    const note = await readNote(outcome.id);
    expect(note.title).toBe(title);
    expect(note.parent_id).toBe(await folderId(other));
  });

  test('a Notebook filter left by a mouse click on Create takes the highlighted notebook', async () => {
    const { win } = joplin;
    const title = `jot-click-${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await form.locator('#jotTitle').fill(title);
    await form.locator('#jotNotebook').click();
    await win.keyboard.type('other');
    await expect(form.locator('#jotNotebookList .jot-suggest-row.-highlighted')).toHaveText(other);

    // No Enter, no Tab: the mouse goes straight to Joplin's Create button, so the field only loses the focus.
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    const outcome = await pending;
    const note = await readNote(outcome.id);
    expect(note.title).toBe(title);
    expect(note.parent_id).toBe(await folderId(other));
  });

  test('Escape with a suggestion list open closes the list only; a second Escape cancels the form', async () => {
    const { win } = joplin;
    const pending = startJot(win);
    const form = await formFrame(win);
    await form.locator('#jotNotebook').click();
    await win.keyboard.type('other');
    await expect(form.locator('#jotNotebookList')).toBeVisible();

    await win.keyboard.press('Escape');
    await expect(form.locator('#jotNotebookList')).toBeHidden();
    await win.waitForTimeout(1000);
    expect(await formIsOpen(win)).toBe(true);
    await expect(form.locator('#jotNotebook')).toHaveValue(book);

    await win.keyboard.press('Escape');
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    expect(await pending).toBeFalsy();
  });

  test('the bell unfolds the picker; a calendar day writes the Due row, and the created to-do has that due date at the day start time', async () => {
    const { win } = joplin;
    const title = `jot-due-${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotDueText')).toHaveText('No date');
    await expect(form.locator('#jotPicker')).toBeHidden();

    const folded = await dialogHeight(win);
    await form.locator('#jotBell').click();
    await expect(form.locator('#jotPicker')).toBeVisible();
    await expect.poll(async () => dialogHeight(win), { timeout: 10_000 }).toBeGreaterThan(folded);

    const day = form.locator('.alarm-cal-day:not(.-outside)', { hasText: /^15$/ });
    const iso = (await day.getAttribute('data-date'))!;
    expect(iso).toMatch(/^\d{4}-\d{2}-15$/);
    await day.click();
    await expect(form.locator('#jotDueText')).toHaveText(`${iso} 09:00`);
    await expect(form.locator('#alarmDate')).toHaveValue(iso);
    await expect(form.locator('#alarmTime')).toHaveValue('09:00');

    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);
    const outcome = await pending;
    const note = await readNote(outcome.id);
    const [year, month] = iso.split('-').map(Number);
    expect(note.title).toBe(title);
    expect(note.is_todo).toBe(1);
    expect(note.todo_due).toBe(new Date(year, month - 1, 15, 9, 0, 0, 0).getTime());
  });

  test('Create and open opens the new note in the editor', async () => {
    const { win } = joplin;
    const title = `jot-open-${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create and open').click();
    await expect.poll(async () => formIsOpen(win), { timeout: 20_000 }).toBe(false);

    const outcome = await pending;
    expect(outcome && outcome.opened).toBe(true);
    await expect.poll(async () => selectedNoteId(win), { timeout: 20_000 }).toBe(outcome.id);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 20_000 }).toBe(title);
  });
});
