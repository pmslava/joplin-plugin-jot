import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, COCKPIT_JPL } from './launch';
import { activateJoplinMenuItem, callPluginCommand, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * Jot 0.6.0: the Pin row pins the new note in Cockpit's Pinned section, in a real Joplin desktop with Cockpit (io.github.pmslava.cockpit,
 * 2.11.1, the first release with cockpit.pinNotes) installed beside Jot the way a user installs it - its .jpl in the profile's plugins folder
 * (launchJoplin's extraPlugins).
 *
 * Jot's two pin settings are set on the Options screen, as note-tabs.spec.ts sets the first: a plugin's settings live in Joplin's database, so a
 * profile cannot preset them. The form is opened with jot.open { mode: 'new', type: 'todo', title } through the app's CommandService (hence
 * `envDev`), as another plugin opens it, and answered with Joplin's own Create button; the command resolves { id, opened, pinned } once the note
 * is written. What Cockpit did is read from its own panel, a plugin panel iframe in the main window whose id carries Cockpit's plugin id
 * (plugin-view-io.github.pmslava.cockpit-panel, Cockpit's e2e/helpers.ts PANEL_IFRAME): the Pinned section is
 * `section.pinned-section` with an h2 "Pinned" and the pinned rows under it. The editor holds a note made in beforeAll throughout, and the pin
 * must not move it.
 */
test.describe('Cockpit: Pin the new note in its Pinned section (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-cockpit-pin-${stamp}`;
  const API_PORT = 41218;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Cockpit ${stamp}`;
  const reading = `Reading ${stamp}`;
  let readingId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN), extraPlugins: [COCKPIT_JPL] });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    const bookId = folders.items.find((folder: any) => folder.title === book).id;
    readingId = (await api.post('/notes', { parent_id: bookId, title: reading, body: 'What I am reading.' })).id;
    await callPluginCommand(win, 'openNote', readingId);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);
    // Cockpit is running once its panel has drawn.
    await cockpitFrame(win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** Cockpit's panel frame, found by its iframe's id, which carries Cockpit's plugin id (plugin-view-<plugin id>-<view id>). */
  async function findCockpitFrame(win: Page): Promise<Frame | null> {
    for (const frame of win.frames()) {
      const element = await frame.frameElement().catch(() => null);
      if (!element) continue; // the main window's own frame
      const id = await element.getAttribute('id').catch(() => null);
      if (id && id.startsWith('plugin-view-io.github.pmslava.cockpit')) return frame;
    }
    return null;
  }

  async function cockpitFrame(win: Page): Promise<Frame> {
    await expect.poll(async () => (await findCockpitFrame(win)) != null, { timeout: 60_000 }).toBe(true);
    return (await findCockpitFrame(win))!;
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

  /** Jot's "Pin the new note" and "Where the new note is pinned" on the Options screen, by their options' labels. */
  async function setPinSettings(win: Page, pin: string, target: string): Promise<void> {
    expect(await activateJoplinMenuItem(win, /^(Options|Preferences\.\.\.)$/)).toBe(true);
    const screen = win.locator('.config-screen');
    await screen.waitFor({ state: 'visible', timeout: 60_000 });
    await screen.getByRole('tab', { name: 'Jot', exact: true }).first().click();
    const pinField = win.getByLabel('Pin the new note', { exact: true }).first();
    await pinField.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(pinField.locator('option')).toHaveText(['Not used', 'Pin', "Don't pin"]);
    await pinField.selectOption({ label: pin });
    const targetField = win.getByLabel('Where the new note is pinned', { exact: true }).first();
    await expect(targetField.locator('option')).toHaveText(['Note Tabs', "Cockpit's Pinned section", 'Note Tabs and Cockpit']);
    await targetField.selectOption({ label: target });
    await screen.locator('.button-bar button', { hasText: 'OK' }).first().click();
    await expect.poll(async () => screen.isVisible().catch(() => false), { timeout: 30_000 }).toBe(false);
    // Joplin tells plugins of a setting change a second after the last one (Setting.scheduleChangeEvent), and Jot keeps its settings in
    // memory until it hears.
    await win.waitForTimeout(1500);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);
  }

  test("Pin with the target on Cockpit: the row reads Pin in Cockpit, and jot.open's to-do is drawn under Cockpit's Pinned heading", async () => {
    const { win } = joplin;
    const panel = await cockpitFrame(win);
    await expect(panel.locator('.pinned-section')).toHaveCount(0);
    await setPinSettings(win, 'Pin', "Cockpit's Pinned section");

    const title = `Pinned in Cockpit ${stamp}`;
    const pending = callPluginCommand(win, 'jot.open', { mode: 'new', type: 'todo', title });
    pending.catch(() => undefined);
    const form = await formFrame(win);
    await expect(form.locator('#jotNoteTabsRow .jot-label')).toHaveText('Pin in Cockpit');
    await expect(form.locator('#jotNoteTabsRow .jot-seg-option')).toHaveText(['Pin', "Don't pin"]);
    await expect(form.locator('#jotNoteTabs')).toHaveValue('pin');
    await expect(form.locator('#jotType')).toHaveValue('todo');
    await expect(form.locator('#jotTitle')).toHaveValue(title);
    await dialogButton(win, 'Create').click();
    const outcome: any = await pending;
    expect(outcome).toEqual({ id: outcome.id, opened: false, pinned: true });
    await expect.poll(async () => (await findFormFrame(win)) != null, { timeout: 10_000 }).toBe(false);
    const note = await api.get(`/notes/${outcome.id}?fields=title,is_todo`);
    expect(note).toMatchObject({ title, is_todo: 1 });

    const section = (await cockpitFrame(win)).locator('section.pinned-section');
    await expect(section.locator('h2')).toHaveText('Pinned', { timeout: 30_000 });
    await expect(section.locator(`[data-todo-id="${outcome.id}"]`)).toHaveCount(1);
    await expect(section.locator('.todo-title', { hasText: title })).toHaveCount(1);
    expect(await selectedNoteId(win), 'the note being read is still the one selected').toBe(readingId);
  });
});
