/** README ******************************************************************************************************************************************
 * Jot: quick capture of a note or to-do without leaving the one you are in (docs/BRIEF-1.0-jot.md).                                                *
 *                                                                                                                                                  *
 * PHASE 1: the form in create mode (src/form/), reached two ways, both behind one openForm(route, presets) (brief 4.4):                            *
 *   - jot.open, "Jot…": Tools > Jot… with its default chord on desktop, the command palette, and (later) other plugins' entry point;              *
 *   - jot.button, "Jot": the note toolbar button, on desktop and mobile, made at startup only while showToolbarButton is on.                        *
 * A command has one label, and the menu item and the toolbar button each show their command's, so each wording is a command of its own.           *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in ONE expression (`await joplin.commands.register({...})`, never a member kept  *
 * in a variable and called later), because the proxy path corrupts otherwise. test/run.js audits every source file for it.                        *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from 'api'
import { MenuItemLocation, ToolbarButtonLocation } from 'api/types'
import { isMobile } from './core/platform'
import { isToolbarButtonEnabled, setupSettings } from './core/settings'
import { openForm } from './form/form'

/** Constants ***************************************************************************************************************************************/
// The command other plugins call (brief section 6), and the menu item that carries its chord. Both ids are part of Jot's public surface.
export const OPEN_COMMAND = 'jot.open'
const OPEN_MENU_ITEM = 'jot.open.menu'
// The default chord (brief open question 3). The user rebinds it under Options > Keyboard Shortcuts; Joplin keeps that choice over this default.
const OPEN_ACCELERATOR = 'Ctrl+Shift+J'
// The toolbar button's command and the button itself.
export const BUTTON_COMMAND = 'jot.button'
const TOOLBAR_BUTTON = 'jot.button.toolbar'
const ICON = 'fas fa-feather-alt'

/** Plugin Registration *****************************************************************************************************************************
 * Registers the plugin with joplin.                                                                                                                *
 ***************************************************************************************************************************************************/
joplin.plugins.register({ onStart: setupPlugin })

/** setupPlugin *************************************************************************************************************************************
 * Runs everything that initializes the plugin. The settings come first (the toolbar gate reads one), then the commands, which the menu item and the *
 * toolbar button refer to by name.                                                                                                                 *
 ***************************************************************************************************************************************************/
export async function setupPlugin(){
    await setupSettings()
    await setupCommands()
    await setupMenu()
    await setupToolbar()
}

/** setupCommands ***********************************************************************************************************************************
 * Registers jot.open ("Jot…", what the Tools menu, the Keyboard Shortcuts screen and the command palette show) and jot.button ("Jot", the toolbar  *
 * button's text and tooltip). Both open the form; jot.open resolves with what openForm resolves ({ id, opened }, or null), the shape brief section  *
 * 6 promises its callers.                                                                                                                          *
 ***************************************************************************************************************************************************/
async function setupCommands(){
    await joplin.commands.register({
        name: OPEN_COMMAND,
        label: 'Jot…',
        iconName: ICON,
        execute: async () => openForm('menu'),
    })
    await joplin.commands.register({
        name: BUTTON_COMMAND,
        label: 'Jot',
        iconName: ICON,
        execute: async () => openForm('button'),
    })
}

/** setupMenu ***************************************************************************************************************************************
 * Puts jot.open straight under Tools as one item, Tools > Jot…, with no submenu. views.menuItems.create (not views.menus.create) is what makes one   *
 * item, and an item with an accelerator is what lists the command on the Keyboard Shortcuts screen, rebindable there.                             *
 *                                                                                                                                                  *
 * Menus are a desktop only part of the plugin API, so the item is not made on mobile (detected as Cockpit does, core/platform.ts), and the call is  *
 * guarded: an app that refuses it must not stop the plugin from starting, since the command stays reachable from the palette and other plugins.    *
 ***************************************************************************************************************************************************/
async function setupMenu(){
    if (await isMobile()) return
    try {
        await joplin.views.menuItems.create(OPEN_MENU_ITEM, OPEN_COMMAND, MenuItemLocation.Tools, { accelerator: OPEN_ACCELERATOR })
    } catch (error) {
        console.warn("Jot: could not add Tools > Jot… (menus do not exist on mobile)", error)
    }
}

/** setupToolbar ************************************************************************************************************************************
 * The note toolbar button, on both platforms (on mobile it is one of the two ways in). Joplin can only add a toolbar button while a plugin starts,  *
 * so the showToolbarButton setting is read here once and its change applies after a restart, as its description says (Cockpit's gate). Guarded as *
 * the menu is: a refusal costs the button, not the plugin.                                                                                         *
 ***************************************************************************************************************************************************/
async function setupToolbar(){
    if (!(await isToolbarButtonEnabled())) return
    try {
        await joplin.views.toolbarButtons.create(TOOLBAR_BUTTON, BUTTON_COMMAND, ToolbarButtonLocation.NoteToolbar)
    } catch (error) {
        console.warn("Jot: could not add the Jot button to the note toolbar", error)
    }
}
