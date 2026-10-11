import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, PLUGIN_ID } from './launch';
import {
  findJoplinMenuItem,
  pluginBackgroundPageRunning,
  pluginErrorLogLines,
  pluginLogLines,
} from './helpers';

/**
 * Proof of life for Jot in a real Joplin desktop instance (adapted from Cockpit's plugin-loads spec):
 *  - its background page exists (CDP), proving the plugin runtime started,
 *  - onStart got through its registrations: Tools > Jot… is in Joplin's application menu, with the
 *    default chord, which also proves jot.open is registered (the item shows the command's label),
 *  - and the profile's log shows onStart ran to its end and reports no error for the plugin.
 *
 * The command itself is not executed here: it opens the form, which form.spec.ts drives.
 */
test.describe('Plugin loads', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('plugin background page is running (CDP)', async () => {
    await expect.poll(() => pluginBackgroundPageRunning(joplin.win), { timeout: 30_000 }).toBe(true);
  });

  test('Tools > Jot… exists, with the Ctrl+Shift+J accelerator', async () => {
    // The item appears once onStart has run, a moment after the background page does.
    await expect
      .poll(() => findJoplinMenuItem(joplin.win, /^&?Tools$/, /^Jot…$/), { timeout: 30_000 })
      .not.toBeNull();
    const item = await findJoplinMenuItem(joplin.win, /^&?Tools$/, /^Jot…$/);
    // eslint-disable-next-line no-console
    console.log(`[jot-e2e] Tools menu item: ${JSON.stringify(item)}`);
    expect(item!.visible).toBe(true);
    expect(item!.accelerator).toBe('Ctrl+Shift+J');
  });

  test('the profile log shows onStart finished, and reports no error for the plugin', async () => {
    // Give a late startup error the time to reach the log before it is read.
    await joplin.win.waitForTimeout(3000);
    const lines = pluginLogLines(joplin.profileDir);
    // eslint-disable-next-line no-console
    console.log(`[jot-e2e] log lines naming ${PLUGIN_ID}:\n${lines.join('\n')}`);
    // Joplin logs this once the plugin's onStart has returned (seen in 3.6.14), so it proves onStart ran to the end.
    expect(lines.some((line) => line.includes(`Finished running onStart handler: ${PLUGIN_ID}`))).toBe(true);
    expect(pluginErrorLogLines(joplin.profileDir)).toEqual([]);
  });
});
