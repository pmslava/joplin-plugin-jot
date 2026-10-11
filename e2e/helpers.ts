import { Page, expect } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { PLUGIN_ID } from './launch';

/**
 * Reusable, real-app interaction helpers for the Jot e2e suite, ported from Cockpit's e2e/helpers.ts
 * (its panel, profile, calendar and settings helpers are left behind: Jot has no panel).
 *
 * Every helper drives the genuine Joplin desktop GUI through the main renderer `Page` (`win`). The
 * selectors were verified against a real Joplin 3.6 build in Cockpit's suite.
 */

/** Short settle delay used after GUI actions that trigger async React re-renders. */
const SETTLE = 1500;

/** ----------------------------------------------------------------------------------------------
 * The plugin itself
 * ------------------------------------------------------------------------------------------- */

/**
 * Whether the plugin's background page is running: Joplin loads each plugin's main script in a page
 * whose URL carries `pluginId=<id>`, so its presence among the CDP pages proves the runtime started.
 */
export function pluginBackgroundPageRunning(win: Page): boolean {
  const urls: string[] = [];
  for (const ctx of win.context().browser()!.contexts()) {
    for (const p of ctx.pages()) urls.push(p.url());
  }
  return urls.some((u) => u.includes(`pluginId=${PLUGIN_ID}`));
}

/**
 * The lines of the profile's log.txt that report a problem with THIS plugin: Joplin writes a plugin
 * that fails to load ("Could not load plugin ...") or throws during startup there, naming its id.
 * Read it before closeJoplin, which deletes the throwaway profile.
 */
export function pluginErrorLogLines(profileDir: string): string[] {
  let log = '';
  try {
    log = fs.readFileSync(path.join(profileDir, 'log.txt'), 'utf8');
  } catch {
    return [];
  }
  return log
    .split('\n')
    .filter((line) => line.includes(PLUGIN_ID) || /\bjot\b/i.test(line))
    .filter((line) => /error|exception|could not|uncaught|failed/i.test(line));
}

/** Every line of the profile's log.txt that names the plugin, for evidence in the test output. */
export function pluginLogLines(profileDir: string): string[] {
  try {
    return fs
      .readFileSync(path.join(profileDir, 'log.txt'), 'utf8')
      .split('\n')
      .filter((line) => line.includes(PLUGIN_ID));
  } catch {
    return [];
  }
}

/** ----------------------------------------------------------------------------------------------
 * Joplin's own application menu
 * ------------------------------------------------------------------------------------------- */

export interface MenuItemInfo {
  label: string;
  accelerator: string | null;
  enabled: boolean;
  visible: boolean;
}

/**
 * Find an item of Joplin's application menu WITHOUT clicking it: the item whose label matches
 * `label`, inside the top-level menu whose label matches `topLevel`, or null when there is none.
 *
 * Joplin's menu bar is a native Electron menu, not DOM. Like Cockpit's activateJoplinMenuItem, this
 * reaches it through `@electron/remote`, which Joplin enables for its main window.
 */
export async function findJoplinMenuItem(
  win: Page,
  topLevel: RegExp,
  label: RegExp
): Promise<MenuItemInfo | null> {
  const spec = {
    top: { source: topLevel.source, flags: topLevel.flags },
    item: { source: label.source, flags: label.flags },
  };
  return win.evaluate((s) => {
    const remote = (window as any).require('@electron/remote');
    const menu = remote && remote.Menu && remote.Menu.getApplicationMenu();
    if (!menu) return null;
    const wantedTop = new RegExp(s.top.source, s.top.flags);
    const wantedItem = new RegExp(s.item.source, s.item.flags);
    const walk = (items: any[]): any => {
      for (const item of items) {
        if (wantedItem.test(String(item.label || ''))) return item;
        if (item.submenu) {
          const found = walk(item.submenu.items);
          if (found) return found;
        }
      }
      return null;
    };
    for (const top of menu.items) {
      if (!wantedTop.test(String(top.label || '')) || !top.submenu) continue;
      const found = walk(top.submenu.items);
      if (found) {
        return {
          label: String(found.label),
          accelerator: found.accelerator ? String(found.accelerator) : null,
          enabled: found.enabled !== false,
          visible: found.visible !== false,
        };
      }
    }
    return null;
  }, spec);
}

/** ----------------------------------------------------------------------------------------------
 * Notebooks and notes
 * ------------------------------------------------------------------------------------------- */

/** Create a new notebook with the given name. It becomes the active/selected notebook. */
export async function createNotebook(win: Page, name: string): Promise<void> {
  await win.click('.sidebar-header-button.-newfolder');
  await win.waitForTimeout(1200);
  await win.locator('input[type="text"]:visible').first().fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
}

/**
 * The id of the note currently selected in the note list. Joplin puts the note id in a `data-id`
 * attribute on the list row, and marks the selected row's inner element with `-selected`.
 */
export async function selectedNoteId(win: Page): Promise<string> {
  const id = await win
    .locator('.note-list-item:has(.content.-selected)')
    .first()
    .getAttribute('data-id');
  if (!id) throw new Error('Could not determine the selected note id');
  return id;
}

/** Create a new plain note in the currently selected notebook. Returns the note id. */
export async function createNote(win: Page, title: string): Promise<string> {
  await win.locator('button:has-text("New note")').first().click();
  await win.waitForTimeout(SETTLE);
  await win.keyboard.type(title);
  await win.waitForTimeout(SETTLE);
  return selectedNoteId(win);
}

/** Create a new to-do in the currently selected notebook and type its title. Returns the note id. */
export async function createTodo(win: Page, title: string): Promise<string> {
  await win.locator('button:has-text("New to-do")').first().click();
  await win.waitForTimeout(SETTLE);
  await win.keyboard.type(title);
  await win.waitForTimeout(SETTLE);
  return selectedNoteId(win);
}

/** ----------------------------------------------------------------------------------------------
 * Commands
 * ------------------------------------------------------------------------------------------- */

/**
 * Execute a plugin command, with arguments, the way another PLUGIN would (Cockpit's helper, unchanged).
 *
 * Joplin's command palette can trigger a registered command but never passes it anything, and the
 * renderer's services are only published - `window.joplin.commandService` and friends - when the app is
 * started with `--env dev`, so a spec that uses this launches Joplin with `launchJoplin({ envDev: true })`.
 * Resolves to whatever the command returned.
 */
export async function callPluginCommand(win: Page, name: string, ...args: unknown[]): Promise<unknown> {
  await expect
    .poll(
      async () =>
        win.evaluate(() => {
          const debug = (window as any).joplin;
          return !!(debug && debug.commandService);
        }),
      { timeout: 60_000 }
    )
    .toBe(true);
  return win.evaluate(
    async (call) => (window as any).joplin.commandService.execute(call.name, ...call.args),
    { name, args }
  );
}

/** callPluginCommand, then a settle for the UI the command changed. */
export async function executePluginCommand(win: Page, name: string, ...args: unknown[]): Promise<unknown> {
  const result = await callPluginCommand(win, name, ...args);
  await win.waitForTimeout(SETTLE);
  return result;
}

/** ----------------------------------------------------------------------------------------------
 * Joplin's own data API (the clipper server), to read back what a spec created
 * ------------------------------------------------------------------------------------------- */

/**
 * A client for the data API of the throwaway profile's Joplin, the way Cockpit's type-flip spec reaches it.
 * The profile presets the server (`launchJoplin({ settings: dataApiSettings(port, token) })`) on a port off
 * Joplin's 41184 default, so a Joplin the developer happens to be running is never talked to by mistake.
 */
export function dataApiSettings(port: number, token: string): Record<string, unknown> {
  return { 'clipperServer.autoStart': true, 'api.token': token, 'api.port': port };
}

export interface DataApi {
  /** GET a data API path (without the token), parsed as JSON; throws on a status other than 200. */
  get(apiPath: string): Promise<any>;
  /** Resolves once the server answers /ping (it starts a moment after the window). */
  ready(win: Page): Promise<void>;
}

export function dataApi(port: number, token: string): DataApi {
  const request = (apiPath: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: apiPath }, (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode || 0, text }));
      });
      req.on('error', reject);
      req.end();
    });
  return {
    async get(apiPath: string) {
      const separator = apiPath.includes('?') ? '&' : '?';
      const response = await request(`${apiPath}${separator}token=${encodeURIComponent(token)}`);
      if (response.status !== 200) throw new Error(`GET ${apiPath}: ${response.status} ${response.text}`);
      return JSON.parse(response.text);
    },
    async ready(win: Page) {
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          if ((await request('/ping')).status === 200) return;
        } catch {
          /* not up yet */
        }
        await win.waitForTimeout(1000);
      }
      throw new Error(`Joplin's data API never answered on 127.0.0.1:${port}`);
    },
  };
}
