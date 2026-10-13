import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { activateJoplinMenuItem, callPluginCommand, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * The 0.2 requests in a real Joplin desktop: issue 1 (the Tags start with the tags of the note you are in), issue 2 (a back link to that note,
 * added from the form's Back link row), issue 3 (the notebook setting, a dropdown of the notebooks that exist, chosen on the Options screen as
 * a user would), and the popup's two buttons with the Open row starting on No.
 *
 * Launched with `envDev` (callPluginCommand) and the data API on its own port.
 */
test.describe('The 0.2 requests (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-requests-${stamp}`;
  const API_PORT = 41212;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Requests ${stamp}`;
  const inbox = `Inbox ${stamp}`;
  const reading = `Reading ${stamp}`;
  let bookId = '';
  let inboxId = '';
  let readingId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    bookId = folders.items.find((folder: any) => folder.title === book).id;
    inboxId = (await api.post('/folders', { title: inbox })).id;
    readingId = (await api.post('/notes', { parent_id: bookId, title: reading, body: 'What I am reading.' })).id;
    for (const title of [`alpha-${stamp}`, `beta-${stamp}`]) {
      const tag = await api.post('/tags', { title });
      await api.post(`/tags/${tag.id}/notes`, { id: readingId });
    }
    await callPluginCommand(win, 'openNote', readingId);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);
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

  function startJot(win: Page): Promise<any> {
    const pending = callPluginCommand(win, 'jot.open');
    pending.catch(() => undefined);
    return pending;
  }

  test('two buttons, Create and Cancel; the Open row starts on No; Type, Back link and Open are one-line selectors', async () => {
    const { win } = joplin;
    const pending = startJot(win);
    const form = await formFrame(win);
    await expect(win.locator('.user-webview-dialog button')).toHaveText(['Create', 'Cancel']);
    await expect(form.locator('#jotOpen')).toHaveValue('no');
    await expect(form.locator('#jotOpenRow .jot-seg-option')).toHaveText(['No', 'In editor', 'New window']);
    for (const row of ['#jotTypeRow', '#jotBacklinkRow', '#jotOpenRow']) {
      const boxes = await form.locator(`${row} .jot-seg-option`).evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
      expect(new Set(boxes).size, `${row} is one line`).toBe(1);
    }
    await dialogButton(win, 'Cancel').click();
    expect(await pending).toBeNull();
  });

  test('Enter with the Title empty keeps the form open and focuses the Title; with a title it creates', async () => {
    const { win } = joplin;
    const title = `Entered ${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await form.locator('#jotTags').click();
    await win.keyboard.press('Enter');
    await win.waitForTimeout(800);
    expect(await findFormFrame(win)).not.toBeNull();
    await expect.poll(async () => form.evaluate(() => document.activeElement && document.activeElement.id), { timeout: 5_000 }).toBe('jotTitle');
    await win.keyboard.type(title);
    await win.keyboard.press('Enter');
    const outcome: any = await pending;
    expect(outcome && outcome.id).toBeTruthy();
    expect((await api.get(`/notes/${outcome.id}?fields=title`)).title).toBe(title);
  });

  test('issues 1 and 6: a quick note starts with no tags; from highlighted text the Tags start with the note\'s tags, and the new note gets them', async () => {
    const { win } = joplin;
    const quick = startJot(win);
    const quickForm = await formFrame(win);
    await expect(quickForm.locator('#jotTags')).toHaveValue('');
    await dialogButton(win, 'Cancel').click();
    expect(await quick).toBeNull();

    const title = `Tagged ${stamp}`;
    await callPluginCommand(win, 'editor.execCommand', { name: 'select', args: [0, 9] });
    await expect.poll(async () => callPluginCommand(win, 'selectedText'), { timeout: 10_000 }).toBe('What I am');
    const pending = callPluginCommand(win, 'jot.fromSelection');
    pending.catch(() => undefined);
    const form = await formFrame(win);
    await expect(form.locator('#jotTags')).toHaveValue(`alpha-${stamp}, beta-${stamp}, `);
    await form.locator('#jotInThisNoteRow .jot-seg-option[data-value="keep"]').click();
    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create').click();
    const outcome: any = await pending;
    const tags = await api.get(`/notes/${outcome.id}/tags?fields=title`);
    expect(tags.items.map((tag: any) => tag.title).sort()).toEqual([`alpha-${stamp}`, `beta-${stamp}`]);
    // Nothing left highlighted: the next case's shortcut must open a quick note, not take this selection (one chord serves both).
    await callPluginCommand(win, 'editor.execCommand', { name: 'select', args: [0, 0] });
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 10_000 }).toBe(readingId);
  });

  test('issue 2: Back link starts on Don\'t add; Add puts "Parent note: [title](:/id)" first, an empty line, then the text', async () => {
    const { win } = joplin;
    const title = `Linked ${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotBacklink')).toHaveValue('none');
    await expect(form.locator('#jotBacklinkRow .jot-seg-option[data-value="add"]')).toHaveAttribute('title', `Parent note: [${reading}](:/${readingId})`);
    await form.locator('#jotTitle').fill(title);
    await form.locator('#jotBody').fill('The details.');
    await form.locator('#jotBacklinkRow .jot-seg-option[data-value="add"]').click();
    await expect(form.locator('#jotBacklink')).toHaveValue('add');
    await dialogButton(win, 'Create').click();
    const outcome: any = await pending;
    const note = await api.get(`/notes/${outcome.id}?fields=body`);
    expect(note.body).toBe(`Parent note: [${reading}](:/${readingId})\n\nThe details.`);
  });

  test('issue 3: the notebook setting lists the notebooks; with the inbox chosen there the form starts on it and Create puts the note there', async () => {
    const { win } = joplin;
    const opened = await activateJoplinMenuItem(win, /^(Options|Preferences\.\.\.)$/);
    expect(opened).toBe(true);
    const screen = win.locator('.config-screen');
    await screen.waitFor({ state: 'visible', timeout: 60_000 });
    await screen.getByRole('tab', { name: 'Jot', exact: true }).first().click();
    const field = win.getByLabel('Notebook', { exact: true }).first();
    await field.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(field.locator('option')).toContainText(['The current notebook', inbox, book]);
    await field.selectOption({ label: inbox });
    await screen.locator('.button-bar button', { hasText: 'OK' }).first().click();
    await expect.poll(async () => screen.isVisible().catch(() => false), { timeout: 30_000 }).toBe(false);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);

    // Issue 6: the inbox is for quick notes only by default; a note from highlighted text starts in its own note's notebook.
    await callPluginCommand(win, 'editor.execCommand', { name: 'select', args: [0, 9] });
    await expect.poll(async () => callPluginCommand(win, 'selectedText'), { timeout: 10_000 }).toBe('What I am');
    const fromText = callPluginCommand(win, 'jot.fromSelection');
    fromText.catch(() => undefined);
    const textForm = await formFrame(win);
    await expect(textForm.locator('#jotNotebook')).toHaveValue(book);
    await dialogButton(win, 'Cancel').click();
    expect(await fromText).toBeNull();
    await callPluginCommand(win, 'editor.execCommand', { name: 'select', args: [0, 0] });

    const title = `Inboxed ${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotNotebook')).toHaveValue(inbox);
    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create').click();
    const outcome: any = await pending;
    const note = await api.get(`/notes/${outcome.id}?fields=parent_id`);
    expect(note.parent_id).toBe(inboxId);
  });
});
