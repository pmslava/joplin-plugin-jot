import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { callPluginCommand, createNotebook, dataApiSettings } from './helpers';

/**
 * The form's first layout is its final one (0.2.3). Joplin sizes a fit-to-content dialog from the markup the moment the page has it - on a phone
 * (3.7.8) it shows the dialog at that first measurement and measures again only every 500 ms, seconds apart while a sync keeps it busy - so a form
 * whose stylesheet came as a file, and whose script then set its width and the fields' heights, opened at one size and changed size and shape under
 * a user already typing (Android, 2026-10-14). Now the stylesheet travels in the markup and the script sizes nothing.
 *
 * Desktop measures live, so this spec watches the dialog's frame from the open, every animation frame, and asks that once the form is in it the size
 * never changes again: no step for the stylesheet arriving, none for the script running, none for the theme. It also checks what the phone's first
 * paint depends on: the markup alone (the stylesheet and the script's files removed) lays out exactly as the scripted form.
 */
test.describe('The first paint (desktop)', () => {
  let joplin: JoplinInstance;
  const API_PORT = 41215;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true, settings: dataApiSettings(API_PORT, `jot-e2e-paint-${Date.now()}`) });
    await createNotebook(joplin.win, `Paint ${Date.now()}`);
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

  test('once the form is in the dialog, its size never changes: no step for the stylesheet, the script or the theme', async () => {
    const { win } = joplin;
    // Every animation frame from before the open: the dialog frame's size, and whether its document holds the form yet.
    await win.evaluate(() => {
      const w = window as any;
      w.__jotSizes = [];
      const sample = () => {
        const frame = document.querySelector('dialog.user-webview-dialog iframe') as HTMLIFrameElement | null;
        if (frame) {
          const box = frame.getBoundingClientRect();
          let hasForm = false;
          try { hasForm = !!frame.contentDocument && !!frame.contentDocument.getElementById('jotForm'); } catch (error) { hasForm = false; }
          const last = w.__jotSizes[w.__jotSizes.length - 1];
          const entry = `${Math.round(box.width)}x${Math.round(box.height)}${hasForm ? '' : ' (empty)'}`;
          if (last !== entry) w.__jotSizes.push(entry);
        }
        if (!w.__jotStop) requestAnimationFrame(sample);
      };
      w.__jotStop = false;
      requestAnimationFrame(sample);
    });
    const pending = callPluginCommand(win, 'jot.open');
    pending.catch(() => undefined);
    const form = await formFrame(win);
    await win.waitForTimeout(2000);
    const sizes: string[] = await win.evaluate(() => { (window as any).__jotStop = true; return (window as any).__jotSizes; });
    console.log(`[jot-e2e] dialog sizes from the open: ${sizes.join(' -> ')}`);
    // Joplin's frame starts at its 200x20 floor, empty and then for a frame with the form in it (its first resize comes a render after its first
    // measurement); from the first size Joplin gives it, the size must be one. Before 0.2.3 the form came in unstyled and grew as the stylesheet
    // and then the script arrived, a step each.
    const theme = await form.evaluate(() => ({ fontSize: getComputedStyle(document.getElementById('jotForm')!).fontSize,
      themeFont: getComputedStyle(document.documentElement).getPropertyValue('--joplin-font-size').trim(),
      themeFamily: getComputedStyle(document.documentElement).getPropertyValue('--joplin-font-family').trim(),
      bodyFamily: getComputedStyle(document.body).fontFamily }));
    console.log(`[jot-e2e] theme: ${JSON.stringify(theme)}`);
    const measured = sizes.filter(size => !size.endsWith('(empty)') && !size.startsWith('200x20'));
    expect(measured.length).toBeGreaterThan(0);
    expect(new Set(measured).size).toBe(1);

    // The markup alone lays out as the scripted form: the same height for the form, Title and Tags one line each at the control height.
    const scripted = await form.evaluate(() => {
      const box = (id: string) => Math.round(document.getElementById(id)!.getBoundingClientRect().height);
      return { form: box('jotForm'), title: box('jotTitle'), tags: box('jotTags'), fontSize: getComputedStyle(document.getElementById('jotForm')!).fontSize,
        themeFont: getComputedStyle(document.documentElement).getPropertyValue('--joplin-font-size').trim() };
    });
    console.log(`[jot-e2e] scripted form: ${JSON.stringify(scripted)}`);
    const markupOnly = await form.evaluate(async () => {
      // The same markup in a page of its own, with the dialog page's head (Joplin's styles and the theme) and none of the form's scripts: what a
      // phone lays out before they arrive. The live form's script changed nothing of its layout, so its markup is the one that was set.
      const live = document.getElementById('joplin-plugin-content')!;
      const markup = live.innerHTML.replace(/ data-jot-ready="1"/g, '');
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:absolute;left:-2000px;top:0;width:700px;height:900px;border:0;visibility:hidden';
      const head = document.head.innerHTML.replace(/<script\b[\s\S]*?<\/script>/g, '');
      frame.srcdoc = `<!DOCTYPE html><html><head>${head}</head><body><div id="joplin-plugin-content-root"><div id="joplin-plugin-content">${markup}</div></div></body></html>`;
      await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
      await new Promise(resolve => setTimeout(resolve, 300));
      const doc = frame.contentDocument!;
      const box = (id: string) => Math.round(doc.getElementById(id)!.getBoundingClientRect().height);
      const result = { form: box('jotForm'), title: box('jotTitle'), tags: box('jotTags'),
        scripts: doc.querySelectorAll('script[src]').length };
      frame.remove();
      return result;
    });
    console.log(`[jot-e2e] markup only: ${JSON.stringify(markupOnly)}`);
    expect(markupOnly).toEqual({ form: scripted.form, title: scripted.title, tags: scripted.tags, scripts: 0 });

    await win.locator('.user-webview-dialog button', { hasText: /^Cancel$/ }).last().click();
    expect(await pending).toBeNull();
  });
});
