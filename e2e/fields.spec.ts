import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { activateJoplinMenuItem, callPluginCommand, createNotebook, dataApi, dataApiSettings, selectedNoteId } from './helpers';

/**
 * Issues 4 and 5 in a real Joplin desktop. Issue 4: Title and Tags grow with what they hold, to three lines, then scroll; Tab puts the caret at
 * the end, a click where it lands; Enter creates from them and never makes a new line; a pasted line break becomes a space. Issue 5: the In this
 * note choice for highlighted text has its default in Settings (chosen on the Options screen, as a user would) and the form starts there.
 *
 * Launched with `envDev` (callPluginCommand) and the data API on its own port.
 */
test.describe('Growing Title and Tags, and the In this note defaults (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const API_TOKEN = `jot-e2e-fields-${stamp}`;
  const API_PORT = 41214;
  const api = dataApi(API_PORT, API_TOKEN);
  const book = `Jot Fields ${stamp}`;
  let bookId = '';
  let readingId = '';
  const TAGS = ['project-alpha', 'reading-list', 'waiting-for', 'someday-maybe', 'research', 'follow-up', 'meeting-notes', 'quarterly-review',
    'travel-plans', 'household', 'finance-admin', 'health', 'garden', 'books-to-read', 'car-service', 'birthday-ideas'].map(tag => `${tag}-${stamp % 1000}`);

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, API_TOKEN) });
    const { win } = joplin;
    await createNotebook(win, book);
    await api.ready(win);
    const folders = await api.get('/folders?fields=id,title&limit=100');
    bookId = folders.items.find((folder: any) => folder.title === book).id;
    readingId = (await api.post('/notes', { parent_id: bookId, title: `Reading ${stamp}`, body: 'Idea worth keeping\nmore of it' })).id;
    for (const title of TAGS) {
      const tag = await api.post('/tags', { title });
      await api.post(`/tags/${tag.id}/notes`, { id: readingId });
    }
    await callPluginCommand(win, 'openNote', readingId);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  async function formFrame(win: Page): Promise<Frame> {
    let found: Frame | null = null;
    await expect.poll(async () => {
      for (const frame of win.frames()) {
        if (await frame.locator('#jotForm[data-jot-ready="1"]').count().catch(() => 0)) { found = frame; return true; }
      }
      return false;
    }, { timeout: 30_000 }).toBe(true);
    return found!;
  }

  function startJot(win: Page, command = 'jot.open'): Promise<any> {
    const pending = callPluginCommand(win, command);
    pending.catch(() => undefined);
    return pending;
  }

  const field = (form: Frame, id: string) => form.evaluate((which) => {
    const element = document.getElementById(which) as HTMLTextAreaElement;
    const style = getComputedStyle(element);
    return {
      value: element.value, height: element.getBoundingClientRect().height, lines: Math.round((element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)),
      overflowY: element.style.overflowY, scrollable: element.scrollHeight > element.clientHeight + 1, start: element.selectionStart, end: element.selectionEnd,
      active: document.activeElement === element,
    };
  }, id);

  test('Tags grow to three lines and then scroll; Tab puts the caret at the end, a click where it lands; Enter in Tags creates and adds no new line', async () => {
    const { win } = joplin;
    const pending = startJot(win);
    const form = await formFrame(win);
    const title = await field(form, 'jotTitle');
    let tags = await field(form, 'jotTags');
    expect(tags.value).toBe([...TAGS].sort().join(', ') + ', ');
    expect(tags.lines).toBe(3);
    expect(tags.height).toBeGreaterThan(title.height * 2);
    expect([tags.overflowY, tags.scrollable]).toEqual(['auto', true]);

    await form.locator('#jotTitle').fill(`Grown ${stamp}`);
    await form.locator('#jotTitle').focus();
    await win.keyboard.press('Tab');
    await win.keyboard.press('Tab');
    await win.keyboard.press('Tab');
    await win.waitForTimeout(200);
    tags = await field(form, 'jotTags');
    expect(tags.active).toBe(true);
    expect([tags.start, tags.end]).toEqual([tags.value.length, tags.value.length]);

    // A click lands where it is made: scrolled back to the top (Tab left the field scrolled to its end), a press at the top-left corner puts the
    // caret in the first tag, not at the end.
    await form.locator('#jotTitle').focus();
    await form.evaluate(() => { (document.getElementById('jotTags') as HTMLTextAreaElement).scrollTop = 0; });
    await form.locator('#jotTags').click({ position: { x: 12, y: 10 } });
    await win.waitForTimeout(200);
    tags = await field(form, 'jotTags');
    expect(tags.active).toBe(true);
    expect(tags.start).toBeLessThan(5);

    // No list is open (a click opens none on a field with tags), so Enter in Tags is the form's: it creates, and no new line is made.
    await win.keyboard.press('Control+End');
    await win.keyboard.press('Enter');
    const outcome: any = await pending;
    expect(outcome && outcome.id).toBeTruthy();
    const created = await api.get(`/notes/${outcome.id}/tags?fields=title&limit=100`);
    expect(created.items.map((tag: any) => tag.title).sort()).toEqual([...TAGS].sort());
  });

  test('Title grows with a long title; a pasted line break becomes a space; Enter in the Title creates', async () => {
    const { win } = joplin;
    const pending = startJot(win);
    const form = await formFrame(win);
    await form.locator('#jotTags').fill('');
    const one = await field(form, 'jotTitle');
    expect(one.lines).toBe(1);
    const long = `A long title that will not fit on one line of this form, so the field grows to show it all ${stamp}`;
    await form.locator('#jotTitle').fill(long);
    const two = await field(form, 'jotTitle');
    expect(two.lines).toBeGreaterThanOrEqual(2);
    expect(two.overflowY).toBe('hidden');
    await form.locator('#jotTitle').fill(`First line\nsecond line ${stamp}`);
    expect((await field(form, 'jotTitle')).value).toBe(`First line second line ${stamp}`);
    await form.locator('#jotTitle').press('End');
    await form.locator('#jotTitle').press('Enter');
    const outcome: any = await pending;
    const note = await api.get(`/notes/${outcome.id}?fields=title`);
    expect(note.title).toBe(`First line second line ${stamp}`);
  });

  test('issue 5: "In this note, for highlighted text" chosen in Settings is where the form starts', async () => {
    const { win } = joplin;
    const opened = await activateJoplinMenuItem(win, /^(Options|Preferences\.\.\.)$/);
    expect(opened).toBe(true);
    const screen = win.locator('.config-screen');
    await screen.waitFor({ state: 'visible', timeout: 60_000 });
    await screen.getByRole('tab', { name: 'Jot', exact: true }).first().click();
    const selection = win.getByLabel('In this note, for highlighted text', { exact: true }).first();
    await selection.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(selection.locator('option')).toHaveText(['Replace it with a link to the new note', 'Keep the text', 'Add a link after it']);
    await selection.selectOption({ label: 'Keep the text' });
    const trigger = win.getByLabel('In this note, for the typed trigger', { exact: true }).first();
    await expect(trigger.locator('option')).toHaveText(['Replace the trigger with a link to the new note', 'Remove the trigger']);
    await screen.locator('.button-bar button', { hasText: 'OK' }).first().click();
    await expect.poll(async () => screen.isVisible().catch(() => false), { timeout: 30_000 }).toBe(false);
    await expect.poll(async () => selectedNoteId(win).catch(() => ''), { timeout: 20_000 }).toBe(readingId);

    await callPluginCommand(win, 'editor.execCommand', { name: 'select', args: [0, 18] });
    await expect.poll(async () => callPluginCommand(win, 'selectedText'), { timeout: 10_000 }).toBe('Idea worth keeping');
    const pending = startJot(win, 'jot.fromSelection');
    const form = await formFrame(win);
    await expect(form.locator('#jotInThisNote')).toHaveValue('keep');
    await win.locator('.user-webview-dialog button', { hasText: /^Cancel$/ }).last().click();
    expect(await pending).toBeNull();
  });
});
