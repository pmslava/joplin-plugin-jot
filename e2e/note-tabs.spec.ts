import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, NOTE_TABS_JPL } from './launch';
import { activateJoplinMenuItem, callPluginCommand, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * Issue 7: Jot pins the new note in the Note Tabs plugin, in a real Joplin desktop with Note Tabs 1.4.0 (joplin.plugin.note.tabs, by
 * benji300) installed beside Jot the way a user installs it - its .jpl in the profile's plugins folder (launchJoplin's extraPlugins).
 *
 * Jot's setting is changed on the Options screen, as requests.spec.ts changes the notebook settings: a plugin's settings live in Joplin's
 * database, not in the profile's settings.json, so a profile cannot preset them. What Note Tabs did is read from its own panel, a plugin
 * panel iframe in the main window (iframe#plugin-view-joplin.plugin.note.tabs-note.tabs.panel): each tab is a [role="tab"] element with
 * the note's id in data-id; a temporary tab (the note being read) has the class "new" and a Pin button, a pinned tab an Unpin button.
 * Note Tabs keeps its tabs in a setting of its own, in the database too, so the panel is the place to look.
 *
 * The form is opened with jot.open through the app's CommandService (hence `envDev`) and answered with Joplin's own dialog buttons; the
 * command resolves { id, opened, pinned } once the note is written. The editor holds a note made in beforeAll throughout, and Jot must
 * never move it: the pin does not open the note.
 */
test.describe('Note Tabs: Pin the new note (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-note-tabs-${stamp}`;
  const API_PORT = 41216;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Note Tabs ${stamp}`;
  const reading = `Reading ${stamp}`;
  let readingId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN), extraPlugins: [NOTE_TABS_JPL] });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    const bookId = folders.items.find((folder: any) => folder.title === book).id;
    readingId = (await api.post('/notes', { parent_id: bookId, title: reading, body: 'What I am reading.' })).id;
    await callPluginCommand(win, 'openNote', readingId);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);
    // Note Tabs is running once its panel shows the note being read, as the temporary tab it gives the selected note.
    await expect.poll(async () => (await tabOf(win, readingId)).count(), { timeout: 60_000 }).toBe(1);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** Note Tabs' panel frame, found by its iframe's id (Joplin names a plugin view's iframe plugin-view-<plugin id>-<view id>). */
  async function findTabsFrame(win: Page): Promise<Frame | null> {
    for (const frame of win.frames()) {
      const element = await frame.frameElement().catch(() => null);
      if (!element) continue; // the main window's own frame
      const id = await element.getAttribute('id').catch(() => null);
      if (id && id.startsWith('plugin-view-joplin.plugin.note.tabs')) return frame;
    }
    return null;
  }

  async function tabsFrame(win: Page): Promise<Frame> {
    await expect.poll(async () => (await findTabsFrame(win)) != null, { timeout: 60_000 }).toBe(true);
    return (await findTabsFrame(win))!;
  }

  /** The tab of one note in Note Tabs' panel (none when it has no tab). */
  async function tabOf(win: Page, noteId: string) {
    return (await tabsFrame(win)).locator(`[role="tab"][data-id="${noteId}"]`);
  }

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

  /** Jot's "Pin the new note in Note Tabs" on the Options screen, by the option's label; then the second Joplin waits before telling plugins. */
  async function setNoteTabsSetting(win: Page, option: string): Promise<void> {
    expect(await activateJoplinMenuItem(win, /^(Options|Preferences\.\.\.)$/)).toBe(true);
    const screen = win.locator('.config-screen');
    await screen.waitFor({ state: 'visible', timeout: 60_000 });
    await screen.getByRole('tab', { name: 'Jot', exact: true }).first().click();
    const field = win.getByLabel('Pin the new note in Note Tabs', { exact: true }).first();
    await field.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(field.locator('option')).toHaveText(['Not used', 'Pin', "Don't pin"]);
    await field.selectOption({ label: option });
    await screen.locator('.button-bar button', { hasText: 'OK' }).first().click();
    await expect.poll(async () => screen.isVisible().catch(() => false), { timeout: 30_000 }).toBe(false);
    // Joplin tells plugins of a setting change a second after the last one (Setting.scheduleChangeEvent), and Jot keeps its settings in
    // memory until it hears.
    await win.waitForTimeout(1500);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);
  }

  test('Not used, the default: the form has no Note Tabs row', async () => {
    const { win } = joplin;
    const pending = startJot(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotOpenRow')).toHaveCount(1);
    await expect(form.locator('#jotNoteTabsRow')).toHaveCount(0);
    await expect(form.locator('input[name="noteTabs"]')).toHaveCount(0);
    await dialogButton(win, 'Cancel').click();
    expect(await pending).toBeNull();
  });

  test('Pin: the row starts on Pin; Create makes the to-do a pinned tab in Note Tabs, and the note being read stays open', async () => {
    const { win } = joplin;
    await setNoteTabsSetting(win, 'Pin');
    const title = `Pinned ${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotNoteTabsRow .jot-label')).toHaveText('Note Tabs');
    await expect(form.locator('#jotNoteTabsRow .jot-seg-option')).toHaveText(['Pin', "Don't pin"]);
    await expect(form.locator('#jotNoteTabs')).toHaveValue('pin');
    await expect(form.locator('#jotNoteTabsRow .jot-seg-option[data-value="pin"]')).toHaveAttribute('aria-checked', 'true');
    const tops = await form.locator('#jotNoteTabsRow .jot-seg-option').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
    expect(new Set(tops).size, 'one line, as the Open row').toBe(1);
    const order = await form.evaluate(() => ['jotOpenRow', 'jotNoteTabsRow', 'jotDueRow'].map(id => {
      const row = document.getElementById(id);
      return row ? Math.round(row.getBoundingClientRect().top) : -1;
    }));
    expect(order[0] < order[1] && order[1] < order[2], `after Open, before Due: ${order}`).toBe(true);
    await expect(form.locator('#jotType')).toHaveValue('todo');
    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create').click();
    const outcome: any = await pending;
    expect(outcome).toEqual({ id: outcome.id, opened: false, pinned: true });
    await expect.poll(async () => (await findFormFrame(win)) != null, { timeout: 10_000 }).toBe(false);
    const note = await api.get(`/notes/${outcome.id}?fields=title,is_todo`);
    expect(note).toMatchObject({ title, is_todo: 1 });

    const tab = await tabOf(win, outcome.id);
    await expect(tab).toHaveCount(1, { timeout: 20_000 });
    await expect(tab).toContainText(title);
    await expect(tab.locator('#Unpin')).toHaveCount(1);
    expect((await tab.getAttribute('class')) || '', 'pinned, not the temporary tab').not.toContain('new');
    expect(await selectedNoteId(win), 'the note being read is still the one selected').toBe(readingId);
    await expect(await tabOf(win, readingId)).toHaveCount(1);
  });

  test("Don't pin as the setting: the row starts there, and Create leaves Note Tabs without a tab for the new note", async () => {
    const { win } = joplin;
    await setNoteTabsSetting(win, "Don't pin");
    const title = `Not pinned ${stamp}`;
    const pending = startJot(win);
    const form = await formFrame(win);
    await expect(form.locator('#jotNoteTabs')).toHaveValue('none');
    await expect(form.locator('#jotNoteTabsRow .jot-seg-option[data-value="none"]')).toHaveAttribute('aria-checked', 'true');
    await form.locator('#jotTitle').fill(title);
    await dialogButton(win, 'Create').click();
    const outcome: any = await pending;
    expect(outcome).toEqual({ id: outcome.id, opened: false, pinned: false });
    // Long enough for a pin to have shown: the one above showed within a second.
    await win.waitForTimeout(3000);
    await expect(await tabOf(win, outcome.id)).toHaveCount(0);
    await expect((await tabsFrame(win)).locator('[role="tab"]', { hasText: title })).toHaveCount(0);
    expect(await selectedNoteId(win)).toBe(readingId);
  });
});
