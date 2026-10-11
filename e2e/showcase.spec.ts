import { test, expect, Page, Frame, CDPSession } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { activateJoplinMenuItem, callPluginCommand, dataApi, dataApiSettings } from './helpers';

/**
 * The README screenshot rig, in the shape of Cockpit's e2e/showcase.spec.ts. Not an assertion suite: it seeds one
 * neutral dataset through Joplin's own data API, opens the form the five ways the README shows, and writes the shots
 * into docs/images/. Every wait here is a "has the screen settled" wait, not a promise about behaviour; the specs
 * beside it make those.
 *
 * It needs a real display and is skipped unless asked for, so the normal suite is unchanged:
 *
 *     npm run dist && SHOWCASE=1 xvfb-run -a --server-args="-screen 0 1920x1080x24" \
 *       npx playwright test e2e/showcase.spec.ts --retries=0
 *
 * THE LOOK. Joplin's own dark theme (theme 2, no auto-detection), as Cockpit's shots are. The window is set to a fixed
 * size and every shot is taken at device scale factor 2, so the images stay crisp when the README shows them at half
 * their pixel width. Joplin's flag parser refuses --force-device-scale-factor, so the scale is a DevTools device
 * metrics override on the main window (Emulation.setDeviceMetricsOverride, the size left alone), and the shots are
 * Page.captureScreenshot clips in CSS pixels, which come out at twice their size.
 *
 * THE CROPS. Joplin's sidebar and note list are hidden and the editor shows without its viewer, so the editor fills the
 * window and its text starts at the left edge, beside the dialog rather than under it. The form shots are cropped to
 * the dialog's card with a small margin, taken over the empty Reading notebook so the margin is plain background. The
 * selection and trigger shots are cropped to the window region holding the editor and the dialog.
 */

const OUT_DIR = path.join(__dirname, '..', 'docs', 'images');
const API_PORT = 41211;
const API_TOKEN = `jot-showcase-${Date.now()}`;
const WINDOW = { width: 1200, height: 800 };
const SCALE = 2;
/** The margin around the dialog's card, in CSS pixels. */
const PAD = 22;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A date `days` from today as YYYY-MM-DD, local time. */
function isoInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The same date at a local time, as a timestamp. */
function timestampInDays(days: number, hours: number, minutes: number): number {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

test.describe('README screenshots', () => {
  test.skip(!process.env.SHOWCASE, 'Set SHOWCASE=1 to capture the README screenshots');
  test.describe.configure({ retries: 0 });

  let joplin: JoplinInstance;
  let cdp: CDPSession;
  const api = dataApi(API_PORT, API_TOKEN);
  const ids: Record<string, string> = {};

  test.beforeAll(async () => {
    test.setTimeout(5 * 60_000);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    joplin = await launchJoplin({
      envDev: true,
      settings: {
        ...dataApiSettings(API_PORT, API_TOKEN),
        // Joplin's own dark theme, as Cockpit's README shots are.
        theme: 2,
        themeAutoDetect: false,
        // Joplin's one-off banners would otherwise sit across the editor (Cockpit's showcase does the same).
        'editor.migration': 1,
        richTextBannerDismissed: true,
        // No spelling squiggles under British spellings ("tyres") in the shots.
        'spellChecker.enabled': false,
      },
    });
    const { win } = joplin;
    await win.evaluate((size) => {
      const remote = (window as any).require('@electron/remote');
      remote.getCurrentWindow().setBounds({ x: 0, y: 0, width: size.width, height: size.height });
    }, WINDOW);
    await win.waitForTimeout(1500);
    await api.ready(win);
    await seed();

    // The editor alone in the window: no sidebar, no note list, no viewer beside the editor (Toggle editor layout).
    await callPluginCommand(win, 'toggleSideBar');
    await callPluginCommand(win, 'toggleNoteList');
    await openNote(win, ids.review, 'Weekly review');
    await callPluginCommand(win, 'toggleVisiblePanes');
    await win.waitForTimeout(1000);

    cdp = await win.context().newCDPSession(win);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: SCALE, mobile: false });
    await win.waitForTimeout(1000);
    // eslint-disable-next-line no-console
    console.log(`[showcase] window ${JSON.stringify(await win.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })))}`);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** Notebooks, tags and notes for every shot: neutral, invented content. */
  async function seed(): Promise<void> {
    const folder = async (title: string, parentId = '') => (await api.post('/folders', { title, parent_id: parentId })).id;
    const personal = await folder('Personal');
    ids.admin = await folder('Admin', personal);
    ids.home = await folder('Home', personal);
    ids.work = await folder('Work');
    ids.reading = await folder('Reading');
    const tags: Record<string, string> = {};
    for (const title of ['admin', 'bank', 'car', 'errand', 'home', 'phone', 'travel']) tags[title] = (await api.post('/tags', { title })).id;
    const note = async (parent: string, title: string, body: string, extra: Record<string, unknown> = {}, tagTitles: string[] = []) => {
      const created = await api.post('/notes', { parent_id: parent, title, body, ...extra });
      for (const tag of tagTitles) await api.post(`/tags/${tags[tag]}/notes`, { id: created.id });
      return created.id;
    };
    ids.review = await note(ids.work, 'Weekly review', [
      'Done this week:', '', '- Closed the quarter\'s open invoices', '- Booked the room for the team day', '',
      'Next week: the onboarding guide, and a date for the offsite.',
    ].join('\n'));
    ids.trip = await note(ids.home, 'Trip in May', [
      'Things to sort out before we go.', '', 'Renew the travel insurance', 'Compare the two annual policies by Friday.', '',
      'The packing list is in its own note.',
    ].join('\n'));
    ids.car = await note(ids.home, 'Car', ['Service booked for the 14th.', 'New wiper blades are in the boot.', '', ''].join('\n'));
    ids.passport = await note(ids.admin, 'Renew the passport', 'The form is on the government site; two photos needed.',
      { is_todo: 1, todo_due: timestampInDays(24, 9, 30) }, ['travel']);
    await note(ids.admin, 'Pay the electricity bill', '', { is_todo: 1, todo_due: timestampInDays(5, 18, 0) }, ['home']);
    await note(ids.home, 'Pick up the dry cleaning', '', { is_todo: 1 }, ['errand']);
  }

  async function findFormFrame(win: Page): Promise<Frame | null> {
    for (const frame of win.frames()) {
      if (await frame.locator('#jotForm').count().catch(() => 0)) return frame;
    }
    return null;
  }

  /** The form's frame once its script has wired it, given a moment for the dialog to settle at its size. */
  async function formFrame(win: Page, timeout = 30_000): Promise<Frame> {
    await expect.poll(async () => (await findFormFrame(win)) != null, { timeout }).toBe(true);
    const frame = (await findFormFrame(win))!;
    await expect(frame.locator('#jotForm[data-jot-ready="1"]')).toHaveCount(1, { timeout: 10_000 });
    await win.waitForTimeout(800);
    return frame;
  }

  function dialogButton(win: Page, label: string) {
    return win.locator('.user-webview-dialog button', { hasText: new RegExp(`^${label}$`) }).last();
  }

  async function closeForm(win: Page): Promise<void> {
    await dialogButton(win, 'Cancel').click();
    await expect.poll(async () => (await findFormFrame(win)) == null, { timeout: 20_000 }).toBe(true);
    await win.waitForTimeout(500);
  }

  /**
   * The dialog's card: the smallest element holding both the form's iframe and Joplin's button row (the <dialog> itself
   * fills the window). Falls back to the union of the iframe and the buttons when no such smaller element exists.
   */
  async function cardBox(win: Page): Promise<Box> {
    const box = await win.evaluate(() => {
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      };
      for (const dialog of Array.from(document.querySelectorAll('.user-webview-dialog'))) {
        const iframe = dialog.querySelector('iframe');
        const buttons = Array.from(dialog.querySelectorAll('button')).filter((button) => button.getBoundingClientRect().width > 0);
        if (!iframe || !iframe.getBoundingClientRect().width || !buttons.length) continue;
        let node: Element | null = iframe.parentElement;
        while (node && node !== dialog && !buttons.every((button) => node!.contains(button))) node = node.parentElement;
        if (node && node !== dialog && node.getBoundingClientRect().width < window.innerWidth * 0.9) return { card: rect(node), how: node.className };
        const parts = [iframe, ...buttons].map(rect);
        const left = Math.min(...parts.map((p) => p.x));
        const top = Math.min(...parts.map((p) => p.y));
        const right = Math.max(...parts.map((p) => p.x + p.width));
        const bottom = Math.max(...parts.map((p) => p.y + p.height));
        return { card: { x: left, y: top, width: right - left, height: bottom - top }, how: 'union' };
      }
      return null;
    });
    if (!box) throw new Error('no dialog on screen');
    // eslint-disable-next-line no-console
    console.log(`[showcase] card (${box.how}): ${JSON.stringify(box.card)}`);
    return box.card;
  }

  /** The note editor's pane: the smallest element holding the note's title input and the CodeMirror editor. */
  async function editorPaneBox(win: Page): Promise<Box> {
    const box = await win.evaluate(() => {
      const title = document.querySelector('input.title-input');
      const editor = document.querySelector('.cm-editor');
      if (!title || !editor) return null;
      let node: Element | null = title.parentElement;
      while (node && !node.contains(editor)) node = node.parentElement;
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    if (!box) throw new Error('no note editor on screen');
    // eslint-disable-next-line no-console
    console.log(`[showcase] editor pane: ${JSON.stringify(box)}`);
    return box;
  }

  /** Writes a clip (CSS pixels, inside the window) at the device scale factor. */
  async function shoot(win: Page, name: string, clip: Box): Promise<void> {
    const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const x = Math.max(0, Math.floor(clip.x));
    const y = Math.max(0, Math.floor(clip.y));
    const width = Math.min(viewport.width - x, Math.ceil(clip.x + clip.width) - x);
    const height = Math.min(viewport.height - y, Math.ceil(clip.y + clip.height) - y);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    // eslint-disable-next-line no-console
    console.log(`[showcase] ${name}: clip ${width}x${height} css px, ${fs.statSync(file).size} bytes`);
  }

  async function shootDialog(win: Page, name: string): Promise<void> {
    const card = await cardBox(win);
    await shoot(win, name, { x: card.x - PAD, y: card.y - PAD, width: card.width + 2 * PAD, height: card.height + 2 * PAD });
  }

  /** The editor pane from its top-left corner to just past the dialog's right and bottom edges. */
  async function shootEditorAndDialog(win: Page, name: string): Promise<void> {
    const pane = await editorPaneBox(win);
    const card = await cardBox(win);
    const left = Math.min(pane.x, card.x - PAD);
    const top = Math.min(pane.y, card.y - PAD);
    const right = Math.min(pane.x + pane.width, card.x + card.width + 2 * PAD);
    const bottom = Math.min(pane.y + pane.height, card.y + card.height + 2 * PAD);
    await shoot(win, name, { x: left, y: top, width: right - left, height: bottom - top });
  }

  /** Opens a note in the editor; the note list is hidden, so the editor's title says when it is there. */
  async function openNote(win: Page, id: string, title: string): Promise<void> {
    await callPluginCommand(win, 'openNote', id);
    await expect.poll(async () => win.locator('input.title-input').inputValue().catch(() => ''), { timeout: 20_000 }).toBe(title);
    await win.waitForTimeout(1200);
  }

  /** Shows the empty Reading notebook, so no note is open and the window behind a dialog is plain background. */
  async function showEmptyNotebook(win: Page): Promise<void> {
    await callPluginCommand(win, 'openFolder', ids.reading);
    await expect(win.locator('input.title-input')).toHaveCount(0, { timeout: 20_000 });
    await win.waitForTimeout(1000);
  }

  async function focusEditor(win: Page): Promise<void> {
    const content = win.locator('.cm-content').first();
    for (let attempt = 0; attempt < 10; attempt++) {
      await content.click();
      await win.waitForTimeout(150);
      if (await win.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.cm-editor'))) return;
    }
    throw new Error('Could not move the focus into the CodeMirror editor');
  }

  /** Starts a command without waiting for it: it resolves only when the form is answered. */
  function start(win: Page, name: string, ...args: unknown[]): void {
    callPluginCommand(win, name, ...args).catch(() => undefined);
  }

  /** Types into a suggestion field and leaves it by a click on the heading, so its list closes without picking. */
  async function typeTags(win: Page, form: Frame, tags: string): Promise<void> {
    await form.locator('#jotTags').click();
    await win.keyboard.type(tags);
    await form.locator('#jotHeading').click();
    await expect(form.locator('#jotTagList')).toBeHidden();
  }

  test('form-new-todo.png and form-picker.png: the form from the shortcut, filled in, then with the picker unfolded', async () => {
    const { win } = joplin;
    // The chord reaches Joplin's menu from a focused editor (with no note open, nothing has the focus it needs), so it is
    // pressed in a note with the caret in its text and nothing highlighted: the plain form, as from anywhere else.
    await openNote(win, ids.review, 'Weekly review');
    await focusEditor(win);
    await win.keyboard.press('Control+End');

    // The shortcut first; Tools > Jot… (the same command, no argument) if the chord does not reach Joplin's menu here.
    await win.keyboard.press('Control+Shift+J');
    let form = await formFrame(win, 6_000).catch(() => null);
    if (!form) {
      // eslint-disable-next-line no-console
      console.log('[showcase] Ctrl+Shift+J opened nothing; using Tools > Jot…');
      expect(await activateJoplinMenuItem(win, /^Jot…$/)).toBe(true);
      form = await formFrame(win);
    } else {
      // eslint-disable-next-line no-console
      console.log('[showcase] the form came from Ctrl+Shift+J');
    }
    await expect(form.locator('#jotHeading')).toHaveText('New to-do');
    await expect(form.locator('#jotInThisNoteRow')).toHaveCount(0);
    // Behind the dialog, the window moves to the empty notebook, so the shot's margin is plain background. The form
    // does not change: it was built when it opened.
    await showEmptyNotebook(win);

    await form.locator('#jotTitle').fill('Call the bank about the new card');
    await form.locator('#jotBody').fill('Ask whether the limit can be raised before the trip.');
    await form.locator('#jotNotebook').click();
    await win.keyboard.type('admin');
    await expect(form.locator('#jotNotebookList .jot-suggest-row.-highlighted')).toHaveText('Personal / Admin');
    await win.keyboard.press('Enter');
    await expect(form.locator('#jotNotebook')).toHaveValue('Personal / Admin');
    await typeTags(win, form, 'phone, bank');
    await expect(form.locator('#jotTags')).toHaveValue('phone, bank');

    const date = isoInDays(3);
    await form.locator('#jotBell').click();
    await form.locator('#alarmDate').fill(date);
    await form.locator('#alarmTime').fill('10:00');
    await form.locator('#jotBell').click();
    await expect(form.locator('#jotPicker')).toBeHidden();
    await expect(form.locator('#jotDueText')).toHaveText(`${date} 10:00`);

    // Back to the end of the Title, where the focus is when the form opens.
    await form.locator('#jotTitle').click();
    await win.keyboard.press('End');
    await win.waitForTimeout(800);
    await shootDialog(win, 'form-new-todo.png');

    await form.locator('#jotBell').click();
    await expect(form.locator('#jotPicker')).toBeVisible();
    await win.waitForTimeout(1200);
    await shootDialog(win, 'form-picker.png');
    await closeForm(win);
  });

  test('form-edit.png: Edit with Jot… on a to-do with a tag and a due date', async () => {
    const { win } = joplin;
    await showEmptyNotebook(win);
    // What the note list's right-click menu runs: jot.edit with the selected notes' ids.
    start(win, 'jot.edit', [ids.passport]);
    const form = await formFrame(win);
    await expect(form.locator('#jotHeading')).toHaveText('Edit to-do');
    await expect(form.locator('#jotTitle')).toHaveValue('Renew the passport');
    await expect(form.locator('#jotTags')).toHaveValue('travel');
    await win.waitForTimeout(600);
    await shootDialog(win, 'form-edit.png');
    await closeForm(win);
  });

  test('form-selection.png: two highlighted lines, the form from Jot from the selection…', async () => {
    const { win } = joplin;
    await openNote(win, ids.trip, 'Trip in May');
    await focusEditor(win);
    await win.keyboard.press('Control+Home');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Home');
    await win.keyboard.press('Shift+ArrowDown');
    await win.keyboard.press('Shift+End');
    const selected = 'Renew the travel insurance\nCompare the two annual policies by Friday.';
    await expect.poll(async () => callPluginCommand(win, 'selectedText'), { timeout: 10_000 }).toBe(selected);

    start(win, 'jot.fromSelection');
    const form = await formFrame(win);
    await expect(form.locator('#jotTitle')).toHaveValue('Renew the travel insurance');
    await expect(form.locator('#jotBody')).toHaveValue('Compare the two annual policies by Friday.');
    await expect(form.locator('.jot-choice-option')).toHaveText(['Replace it with a link to the new note', 'Keep the text', 'Add a link after it']);
    await win.waitForTimeout(600);
    await shootEditorAndDialog(win, 'form-selection.png');
    await closeForm(win);
  });

  test('form-trigger.png: "Order the winter tyres ++" typed at the end of a note', async () => {
    const { win } = joplin;
    await openNote(win, ids.car, 'Car');
    await focusEditor(win);
    await win.keyboard.press('Control+End');
    await win.keyboard.type('Order the winter tyres ++');
    const form = await formFrame(win);
    await expect(form.locator('.jot-choice-option')).toHaveText(['Replace ++ with a link to the new note', 'Remove ++']);
    await form.locator('#jotTitle').fill('Order the winter tyres');
    await typeTags(win, form, 'car');
    await form.locator('#jotTitle').click();
    await win.keyboard.press('End');
    await win.waitForTimeout(600);
    await shootEditorAndDialog(win, 'form-trigger.png');
    await closeForm(win);
  });
});
