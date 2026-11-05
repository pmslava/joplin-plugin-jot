import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { activateJoplinMenuItem, callPluginCommand, createNotebook, dataApi, dataApiSettings, pressRealKeys, selectedNoteId } from './helpers';

/**
 * Issue 8 in a real Joplin desktop: the arrows that move a line between the Title and the Text, Alt+Down and Alt+Up, and the setting that
 * fills the form from highlighted text with all of it as the Text.
 *
 * Each case writes a three-line note through the data API, opens it, highlights all of it in the Markdown editor and runs jot.fromSelection
 * (hence `envDev`), as selection.spec.ts does. The arrows are looked at as a user sees them: hidden until the pointer is over their field
 * (Playwright's hover), and only while their move applies. Alt+Down and Alt+Up are pressed as real keys (pressRealKeys: X input, not the
 * DevTools protocol), because Joplin binds the same keys to Edit > Swap line down / up, a menu shortcut that moves a line in the note being
 * read whenever the focus is outside its editor: pressed in the form they must move the form's line and leave that note alone.
 *
 * The setting is changed on the Options screen, as note-tabs.spec.ts changes its own, in the last case, so the cases before it see the default.
 */
test.describe('Issue 8: a line between the Title and the Text (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-arrows-${stamp}`;
  const API_PORT = 41217;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Arrows ${stamp}`;
  let bookId = '';
  const body = 'Dear Ann,\nthe draft\nBest';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    const found = folders.items.find((folder: any) => folder.title === book);
    if (!found) throw new Error(`no notebook ${book}`);
    bookId = found.id;
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

  function editorText(win: Page): Promise<string> {
    return win.locator('.cm-content').first().evaluate((el) => (el as HTMLElement).innerText);
  }

  async function noteBody(id: string): Promise<string> {
    return (await api.get(`/notes/${id}?fields=body`)).body;
  }

  /** Writes the note, opens it, highlights all of it in the editor and starts jot.fromSelection; resolves the source's id, the form and the command. */
  async function jotFromAll(win: Page, title: string): Promise<{ sourceId: string, form: Frame, pending: Promise<any> }> {
    const note = await api.post('/notes', { parent_id: bookId, title, body });
    await callPluginCommand(win, 'openNote', note.id);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(note.id);
    await expect.poll(async () => editorText(win), { timeout: 20_000 }).toBe(body);
    const content = win.locator('.cm-content').first();
    for (let attempt = 0; attempt < 10; attempt++) {
      await content.click();
      await win.waitForTimeout(150);
      if (await win.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.cm-editor'))) break;
    }
    await win.keyboard.press('Control+Home');
    await win.keyboard.press('Control+Shift+End');
    await expect.poll(async () => callPluginCommand(win, 'selectedText'), { timeout: 10_000 }).toBe(body);
    const pending = callPluginCommand(win, 'jot.fromSelection');
    pending.catch(() => undefined);
    return { sourceId: note.id, form: await formFrame(win), pending };
  }

  /** Whether an arrow can be seen and clicked: form.css shows it with visibility, after a short fade. */
  async function arrowShown(form: Frame, id: string): Promise<boolean> {
    return form.locator(`#${id}`).evaluate((el) => getComputedStyle(el).visibility === 'visible');
  }

  async function formClasses(form: Frame): Promise<string[]> {
    return (await form.locator('#jotForm').getAttribute('class') || '').split(/\s+/).filter((name) => name.startsWith('-can-'));
  }

  test('the Title\'s arrow shows only on hover; Alt+Down, a real key, moves the title into the Text and leaves the note being read alone; Alt+Up brings it back', async () => {
    const { win } = joplin;
    const { sourceId, form, pending } = await jotFromAll(win, `Arrows keys ${stamp}`);
    await expect(form.locator('#jotTitle')).toHaveValue('Dear Ann,');
    await expect(form.locator('#jotBody')).toHaveValue('the draft\nBest');
    expect(await formClasses(form)).toEqual(['-can-down']);

    await form.locator('#jotHeading').hover();
    expect(await arrowShown(form, 'jotTitleDown')).toBe(false);
    await form.locator('#jotTitle').hover();
    await expect.poll(async () => arrowShown(form, 'jotTitleDown')).toBe(true);
    expect(await arrowShown(form, 'jotBodyUp')).toBe(false);
    await form.locator('#jotBody').hover();
    await expect.poll(async () => arrowShown(form, 'jotTitleDown')).toBe(false);
    expect(await arrowShown(form, 'jotBodyUp')).toBe(false);

    // The Title has the focus, as on every open.
    expect(await form.evaluate(() => document.activeElement && document.activeElement.id)).toBe('jotTitle');
    pressRealKeys('alt+Down');
    await expect(form.locator('#jotTitle')).toHaveValue('');
    await expect(form.locator('#jotBody')).toHaveValue(body);
    expect(await formClasses(form)).toEqual(['-can-up']);
    expect(await form.evaluate(() => document.activeElement && document.activeElement.id)).toBe('jotTitle');
    pressRealKeys('alt+Down');
    await win.waitForTimeout(500);
    await expect(form.locator('#jotBody')).toHaveValue(body);

    pressRealKeys('alt+Up');
    await expect(form.locator('#jotTitle')).toHaveValue('Dear Ann,');
    await expect(form.locator('#jotBody')).toHaveValue('the draft\nBest');

    await dialogButton(win, 'Cancel').click();
    expect(await pending).toBe(null);
    // Swap line would have moved a line of the highlighted text in the editor, and the editor saves what it shows.
    await win.waitForTimeout(2500);
    expect(await editorText(win)).toBe(body);
    expect(await noteBody(sourceId)).toBe(body);
  });

  test('by mouse: the Title\'s arrow moves the title into the Text and keeps the focus in the Title; a title typed then keeps the whole text in the note, and the link carries it', async () => {
    const { win } = joplin;
    const { sourceId, form, pending } = await jotFromAll(win, `Arrows mouse ${stamp}`);
    await form.locator('#jotTitle').hover();
    await expect.poll(async () => arrowShown(form, 'jotTitleDown')).toBe(true);
    await form.locator('#jotTitleDown').click();
    await expect(form.locator('#jotTitle')).toHaveValue('');
    await expect(form.locator('#jotBody')).toHaveValue(body);
    expect(await form.evaluate(() => document.activeElement && document.activeElement.id)).toBe('jotTitle');
    await expect.poll(async () => arrowShown(form, 'jotTitleDown')).toBe(false);

    await win.keyboard.type('Email to Ann');
    await dialogButton(win, 'Create').click();
    const outcome = await pending;
    expect(outcome && outcome.id).toBeTruthy();
    const created = await api.get(`/notes/${outcome.id}?fields=title,body`);
    expect([created.title, created.body]).toEqual(['Email to Ann', body]);
    await expect.poll(async () => noteBody(sourceId), { timeout: 30_000 }).toBe(`[Email to Ann](:/${outcome.id})`);
  });

  test('the setting: All of it as the text opens the form with the Title empty and the whole selection in the Text; the Text\'s arrow shows on hover and moves the first line up', async () => {
    const { win } = joplin;
    expect(await activateJoplinMenuItem(win, /^(Options|Preferences\.\.\.)$/)).toBe(true);
    const screen = win.locator('.config-screen');
    await screen.waitFor({ state: 'visible', timeout: 60_000 });
    await screen.getByRole('tab', { name: 'Jot', exact: true }).first().click();
    const field = win.getByLabel('Highlighted text in the form', { exact: true }).first();
    await field.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(field.locator('option')).toHaveText(['The first line as the title, the rest as the text', 'All of it as the text, the title empty']);
    await field.selectOption({ label: 'All of it as the text, the title empty' });
    await screen.locator('.button-bar button', { hasText: 'OK' }).first().click();
    await expect.poll(async () => screen.isVisible().catch(() => false), { timeout: 30_000 }).toBe(false);
    // Joplin tells plugins of a setting change a second after the last one, and Jot keeps its settings in memory until it hears.
    await win.waitForTimeout(1500);

    const { form, pending } = await jotFromAll(win, `Arrows setting ${stamp}`);
    await expect(form.locator('#jotTitle')).toHaveValue('');
    await expect(form.locator('#jotBody')).toHaveValue(body);
    expect(await formClasses(form)).toEqual(['-can-up']);
    await form.locator('#jotTitle').hover();
    await win.waitForTimeout(300);
    expect(await arrowShown(form, 'jotTitleDown')).toBe(false);
    await form.locator('#jotBody').hover();
    await expect.poll(async () => arrowShown(form, 'jotBodyUp')).toBe(true);
    await form.locator('#jotBodyUp').click();
    await expect(form.locator('#jotTitle')).toHaveValue('Dear Ann,');
    await expect(form.locator('#jotBody')).toHaveValue('the draft\nBest');
    expect(await formClasses(form)).toEqual(['-can-down']);
    await dialogButton(win, 'Cancel').click();
    expect(await pending).toBe(null);
  });
});
