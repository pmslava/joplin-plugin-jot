/** README ******************************************************************************************************************************************
 * Jot: quick capture of a note or to-do without leaving the one you are in (docs/BRIEF-1.0-jot.md).                                                *
 *                                                                                                                                                  *
 * PHASE 0 SKELETON. This file registers one command, jot.open ("Jot…"), and puts it straight under Tools with its default chord. Its execute is a  *
 * placeholder message box; the form (brief 4.1 to 4.4) replaces it, behind one openForm(route, presets) shared by the three commands of 4.4.        *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in ONE expression (`await joplin.commands.register({...})`, never a member kept  *
 * in a variable and called later), because the proxy path corrupts otherwise. test/run.js audits every source file for it.                        *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from 'api'
import { MenuItemLocation } from 'api/types'
import { isMobile } from './core/platform'

/** Constants ***************************************************************************************************************************************/
// The command other plugins call (brief section 6), and the menu item that carries its chord. Both ids are part of Jot's public surface.
export const OPEN_COMMAND = 'jot.open'
const OPEN_MENU_ITEM = 'jot.open.menu'
// The default chord (brief open question 3). The user rebinds it under Options > Keyboard Shortcuts; Joplin keeps that choice over this default.
const OPEN_ACCELERATOR = 'Ctrl+Shift+J'

/** Plugin Registration *****************************************************************************************************************************
 * Registers the plugin with joplin.                                                                                                                *
 ***************************************************************************************************************************************************/
joplin.plugins.register({ onStart: setupPlugin })

/** setupPlugin *************************************************************************************************************************************
 * Runs everything that initializes the plugin. The command comes first, as the menu item refers to it by name.                                     *
 ***************************************************************************************************************************************************/
export async function setupPlugin(){
    await setupCommands()
    await setupMenu()
}

/** setupCommands ***********************************************************************************************************************************
 * Registers jot.open. Its label is what the Tools menu, the Keyboard Shortcuts screen and the command palette show. The execute is the phase 0      *
 * placeholder: a message box that proves the command and the chord reach the plugin.                                                               *
 ***************************************************************************************************************************************************/
async function setupCommands(){
    await joplin.commands.register({
        name: OPEN_COMMAND,
        label: 'Jot…',
        execute: async () => {
            await joplin.views.dialogs.showMessageBox('Jot 0.1.0: the form comes next.')
        },
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
