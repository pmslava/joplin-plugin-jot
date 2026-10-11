/** README ******************************************************************************************************************************************
 * Jot's settings, under Settings > Plugins > Jot (brief 4.6; every label and description is the brief's, word for word, section 5). Phase 1         *
 * registers the four the form and the toolbar button read. The typed trigger's setting comes with the content script (phase 3), and the hidden      *
 * per-device memories of the In this note control with that control (phase 2).                                                                    *
 *                                                                                                                                                  *
 * The keyboard shortcut is not a setting: the menu item carries an accelerator, so the command is listed under Options > Keyboard Shortcuts.        *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { SettingItemType } from "api/types"

/** Keys and values ********************************************************************************************************************************/
export const SECTION = "jot"
export const DEFAULT_TYPE_KEY = "defaultType"
export const OPEN_TARGET_KEY = "openTarget"
export const DAY_START_TIME_KEY = "dayStartTime"
export const SHOW_TOOLBAR_BUTTON_KEY = "showToolbarButton"

export const TYPE_TODO = "todo"
export const TYPE_NOTE = "note"
export const OPEN_IN_EDITOR = "editor"
export const OPEN_IN_WINDOW = "window"

/** setupSettings ***********************************************************************************************************************************
 * Registers the section and its settings. Runs first in onStart, as the toolbar button's startup gate reads one of them.                           *
 ***************************************************************************************************************************************************/
export async function setupSettings(){
    await joplin.settings.registerSection(SECTION, {
        label: "Jot",
        iconName: "fas fa-feather-alt",
        description: "Quick capture of a note or to-do without leaving the one you are in.",
    })
    await joplin.settings.registerSettings({
        [DEFAULT_TYPE_KEY]: {
            label: "What Jot creates",
            description: "Whether the form opens as a to-do or a note. You can switch in the form.",
            value: TYPE_TODO,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [TYPE_TODO]: "A to-do",
                [TYPE_NOTE]: "A note",
            },
            public: true,
            section: SECTION,
        },
        [OPEN_TARGET_KEY]: {
            label: "Create and open opens the note",
            description: "In the editor, or in a new window on desktop. Create (without \"and open\") never opens anything.",
            value: OPEN_IN_EDITOR,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [OPEN_IN_EDITOR]: "In the editor",
                [OPEN_IN_WINDOW]: "In a new window",
            },
            public: true,
            section: SECTION,
        },
        [DAY_START_TIME_KEY]: {
            label: "Day start time (HH:MM)",
            description: "The time a to-do gets when its date is picked before its time, as in Cockpit's picker.",
            value: "09:00",
            type: SettingItemType.String,
            public: true,
            section: SECTION,
        },
        [SHOW_TOOLBAR_BUTTON_KEY]: {
            label: "Show the Jot button in the note toolbar",
            description: "The button opens the form; on mobile it and the typed trigger are the ways in. Takes effect after Joplin restarts, since Joplin cannot add or remove a toolbar button while running.",
            value: true,
            type: SettingItemType.Bool,
            public: true,
            section: SECTION,
        },
    })
}

/** getDefaultType **********************************************************************************************************************************
 * The type the form opens with, "todo" or "note"; anything unreadable is a to-do, the setting's default.                                           *
 ***************************************************************************************************************************************************/
export async function getDefaultType(){
    var value = await joplin.settings.value(DEFAULT_TYPE_KEY)
    return value === TYPE_NOTE ? TYPE_NOTE : TYPE_TODO
}

/** getOpenTarget ***********************************************************************************************************************************
 * Where Create and open opens the note, "editor" or "window"; anything unreadable is the editor, the setting's default.                            *
 ***************************************************************************************************************************************************/
export async function getOpenTarget(){
    var value = await joplin.settings.value(OPEN_TARGET_KEY)
    return value === OPEN_IN_WINDOW ? OPEN_IN_WINDOW : OPEN_IN_EDITOR
}

/** getDayStartTime *********************************************************************************************************************************
 * The day start time setting as typed (HH:MM). formModel.dayStartText reads it, falling back to 09:00 when it cannot.                               *
 ***************************************************************************************************************************************************/
export async function getDayStartTime(){
    return String((await joplin.settings.value(DAY_START_TIME_KEY)) || "")
}

/** isToolbarButtonEnabled **************************************************************************************************************************
 * Whether the note toolbar button is created at startup (Cockpit's gate: toolbar buttons can only be added while the plugin starts).               *
 ***************************************************************************************************************************************************/
export async function isToolbarButtonEnabled(){
    return (await joplin.settings.value(SHOW_TOOLBAR_BUTTON_KEY)) !== false
}
