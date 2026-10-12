/** README ******************************************************************************************************************************************
 * Jot: quick capture of a note or to-do without leaving the one you are in (docs/BRIEF-1.0-jot.md).                                                *
 *                                                                                                                                                  *
 * PHASES 1 TO 3: the form in create mode (src/form/), reached three ways through commands, all behind one openJot(route) (brief 4.4):             *
 *   - jot.open, "Jot…": Tools > Jot… with its default chord on desktop, the command palette, and other plugins' entry point (below);               *
 *   - jot.fromSelection, "Jot from the selection…": the editor's right-click menu on desktop;                                                      *
 *   - jot.button, "Jot": the note toolbar button, on desktop and mobile, made at startup only while showToolbarButton is on.                        *
 * Each reads the editor's selection first: highlighted text opens the form prefilled from it, with the In this note row (the selection route), so  *
 * one chord serves both; no selection opens the plain form. A menu passes a command no argument, so the selection is always read, never received.  *
 * A command has one label, and the menu items and the toolbar button each show their command's, so each wording is a command of its own.          *
 *                                                                                                                                                  *
 * And a fourth way, with no command: the typed trigger (++ by default) in the Markdown editor, on desktop and mobile, watched by the CodeMirror 6    *
 * content script that src/trigger.ts registers; the form opens on its own route and the content script applies the answer to the editor.          *
 *                                                                                                                                                  *
 * PHASE 4: edit mode and the command contract (brief 4.5 and section 6). jot.open takes one argument: { mode: 'edit', noteId } opens edit mode and *
 * resolves { id, changed }; { mode: 'new', type?, title?, body?, notebookId? } opens create mode with those presets and resolves { id, opened };   *
 * no argument, or an unknown mode, is the shortcut's behaviour above. jot.edit, "Edit with Jot…", is edit mode from the note list's right-click    *
 * menu on desktop, which passes the selected notes' ids: the first is edited.                                                                      *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in ONE expression (`await joplin.commands.register({...})`, never a member kept  *
 * in a variable and called later), because the proxy path corrupts otherwise. test/run.js audits every source file for it.                        *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from 'api'
import { MenuItemLocation, ToolbarButtonLocation } from 'api/types'
import { isMobile } from './core/platform'
import { isToolbarButtonEnabled, setupSettings } from './core/settings'
import { openEditFromCommand, openJot, refreshNotebookSetting, runOpenCommand } from './form/form'
import { setupTrigger } from './trigger'

/** Constants ***************************************************************************************************************************************/
// The command other plugins call (brief section 6), and the menu item that carries its chord. Both ids are part of Jot's public surface.
export const OPEN_COMMAND = 'jot.open'
const OPEN_MENU_ITEM = 'jot.open.menu'
// The default chord (brief open question 3). The user rebinds it under Options > Keyboard Shortcuts; Joplin keeps that choice over this default.
const OPEN_ACCELERATOR = 'Ctrl+Shift+J'
// The editor context menu's command and its menu item.
export const SELECTION_COMMAND = 'jot.fromSelection'
const SELECTION_MENU_ITEM = 'jot.fromSelection.menu'
// The toolbar button's command and the button itself.
export const BUTTON_COMMAND = 'jot.button'
const TOOLBAR_BUTTON = 'jot.button.toolbar'
// Edit mode's command, in the note list's right-click menu, and its menu item.
export const EDIT_COMMAND = 'jot.edit'
const EDIT_MENU_ITEM = 'jot.edit.menu'
const ICON = 'fas fa-feather-alt'

/** Plugin Registration *****************************************************************************************************************************
 * Registers the plugin with joplin.                                                                                                                *
 ***************************************************************************************************************************************************/
joplin.plugins.register({ onStart: setupPlugin })

/** setupPlugin *************************************************************************************************************************************
 * Runs everything that initializes the plugin. The settings come first (the toolbar gate reads one), then the commands, which the menu item and the *
 * toolbar button refer to by name, and last the typed trigger's content script and its message handler.                                           *
 ***************************************************************************************************************************************************/
export async function setupPlugin(){
    await setupSettings()
    await setupCommands()
    await setupMenu()
    await setupToolbar()
    await setupTrigger()
    // The notebook setting's dropdown lists the notebooks that exist: read once the rest is up, and never in the way of the start.
    void refreshNotebookSetting()
}

/** setupCommands ***********************************************************************************************************************************
 * Registers jot.open ("Jot…", what the Tools menu, the Keyboard Shortcuts screen and the command palette show), jot.fromSelection ("Jot from the    *
 * selection…", the editor's right-click menu), jot.button ("Jot", the toolbar button's text and tooltip) and jot.edit ("Edit with Jot…", the note  *
 * list's right-click menu). jot.fromSelection and jot.button open the form through openJot, which takes the selection route when text is           *
 * highlighted; jot.open does the same with no argument and reads the contract's argument otherwise (runOpenCommand); jot.edit opens edit mode on   *
 * the first note id it is given. Each resolves with what the form resolves ({ id, opened }, { id, changed }, or null), the shapes brief section 6  *
 * promises jot.open's callers.                                                                                                                     *
 ***************************************************************************************************************************************************/
async function setupCommands(){
    await joplin.commands.register({
        name: OPEN_COMMAND,
        label: 'Jot…',
        iconName: ICON,
        execute: async (args?: unknown) => runOpenCommand(args),
    })
    await joplin.commands.register({
        name: SELECTION_COMMAND,
        label: 'Jot from the selection…',
        iconName: ICON,
        execute: async () => openJot('contextMenu'),
    })
    await joplin.commands.register({
        name: BUTTON_COMMAND,
        label: 'Jot',
        iconName: ICON,
        execute: async () => openJot('button'),
    })
    await joplin.commands.register({
        name: EDIT_COMMAND,
        label: 'Edit with Jot…',
        iconName: ICON,
        execute: async (noteIds?: unknown) => openEditFromCommand(noteIds),
    })
}

/** setupMenu ***************************************************************************************************************************************
 * Puts jot.open straight under Tools as one item, Tools > Jot…, with no submenu. views.menuItems.create (not views.menus.create) is what makes one *
 * item, and an item with an accelerator is what lists the command on the Keyboard Shortcuts screen, rebindable there. Then jot.fromSelection in    *
 * the editor's right-click menu (MenuItemLocation.EditorContextMenu), which passes the command nothing: it reads the selection itself. Last,       *
 * jot.edit in the note list's right-click menu (MenuItemLocation.NoteListContextMenu), which passes the selected notes' ids.                       *
 *                                                                                                                                                  *
 * Menus are a desktop only part of the plugin API, so the items are not made on mobile (detected as Cockpit does, core/platform.ts), and each call  *
 * is guarded on its own: an app that refuses one must not stop the plugin from starting, nor cost the other item, since the commands stay          *
 * reachable from the palette, the shortcut and other plugins.                                                                                     *
 ***************************************************************************************************************************************************/
async function setupMenu(){
    if (await isMobile()) return
    try {
        await joplin.views.menuItems.create(OPEN_MENU_ITEM, OPEN_COMMAND, MenuItemLocation.Tools, { accelerator: OPEN_ACCELERATOR })
    } catch (error) {
        console.warn("Jot: could not add Tools > Jot… (menus do not exist on mobile)", error)
    }
    try {
        await joplin.views.menuItems.create(SELECTION_MENU_ITEM, SELECTION_COMMAND, MenuItemLocation.EditorContextMenu)
    } catch (error) {
        console.warn("Jot: could not add Jot from the selection… to the editor's right-click menu", error)
    }
    try {
        await joplin.views.menuItems.create(EDIT_MENU_ITEM, EDIT_COMMAND, MenuItemLocation.NoteListContextMenu)
    } catch (error) {
        console.warn("Jot: could not add Edit with Jot… to the note list's right-click menu", error)
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
