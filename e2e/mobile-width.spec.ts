import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { callPluginCommand, createNotebook, dataApiSettings } from './helpers';

/**
 * The form's width on mobile must not feed back into itself. Joplin sizes a fit-to-content dialog to its content's measured width - on mobile
 * (PluginDialogWebView.tsx, every 500 ms) and on desktop alike (useContentSize, live) - and the webview inside is the dialog's width, so a content
 * width taken from the viewport shrinks the dialog at every measurement: the bug seen on Android in 0.2.0, where the mobile rule was
 * calc(100vw - 16px). Desktop's host closes the same loop, so this spec reproduces it here: it switches the open form to its mobile layout (the
 * #jotPlatform marker, as the mobile markup carries it) with the screen reported as a 412px phone, and samples the dialog's width. First the old
 * rule, to show the loop is real; then the fix, which must hold still at 94% of the screen.
 */
test.describe('The mobile width (the loop reproduced on desktop)', () => {
  let joplin: JoplinInstance;
  const API_PORT = 41213;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, `jot-e2e-width-${Date.now()}`) });
    // A fresh profile has no notebook, and the form will not open without one.
    await createNotebook(joplin.win, `Width ${Date.now()}`);
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

  async function dialogWidth(win: Page): Promise<number> {
    const box = await win.locator('dialog.user-webview-dialog iframe').first().boundingBox();
    return box ? Math.round(box.width) : -1;
  }

  async function samples(win: Page, count: number): Promise<number[]> {
    const widths: number[] = [];
    for (let index = 0; index < count; index++) {
      await win.waitForTimeout(250);
      widths.push(await dialogWidth(win));
    }
    return widths;
  }

  test('the old viewport rule shrinks the dialog at every measurement; the screen-based width holds still at 94% of a 412px screen', async () => {
    const { win } = joplin;
    const pending = callPluginCommand(win, 'jot.open');
    pending.catch(() => undefined);
    const form = await formFrame(win);
    const before = await dialogWidth(win);
    expect(before).toBeGreaterThan(400);

    // The fix: the mobile marker, as the mobile markup carries it, with the screen reported as a 412px phone. formWebview.js's own mobile switch
    // (run by its mutation observer) takes the width from the screen: 94% of 412 is 387, and it must hold still while Joplin keeps measuring.
    await form.evaluate(() => {
      Object.defineProperty(window.screen, 'width', { configurable: true, get: () => 412 });
      document.body.insertAdjacentHTML('afterbegin', '<div id="jotPlatform" hidden></div>');
    });
    await expect.poll(async () => form.evaluate(() => document.getElementById('joplin-plugin-content')!.style.width), { timeout: 10_000 }).toBe('387px');
    await win.waitForTimeout(1000);
    const steady = await samples(win, 8);
    console.log(`[jot-e2e] desktop: ${before}; fixed mobile: ${steady.join(', ')}`);
    expect(new Set(steady).size).toBe(1);
    expect(Math.abs(steady[0] - 387)).toBeLessThanOrEqual(4);

    // The bug, reproduced, so this spec is known to catch it: the content as wide as the viewport less 16px (0.2.0's rule). Desktop measures
    // live, so the dialog collapses at once to Joplin's 200px floor; on the phone, 500 ms a step, it was seen shrinking step by step.
    await form.evaluate(() => { document.getElementById('joplin-plugin-content')!.style.width = 'calc(100vw - 16px)'; });
    const shrinking = await samples(win, 8);
    console.log(`[jot-e2e] old rule: ${shrinking.join(', ')}`);
    expect(shrinking[shrinking.length - 1]).toBeLessThanOrEqual(210);

    await win.locator('.user-webview-dialog button', { hasText: /^Cancel$/ }).last().click();
    expect(await pending).toBeNull();
  });
});
