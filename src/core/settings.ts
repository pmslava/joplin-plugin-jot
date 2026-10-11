/** README ******************************************************************************************************************************************
 * Jot's settings, under Settings > Plugins > Jot (brief 4.6; every label and description is the brief's, word for word, section 5, except the last *
 * sentence of the trigger's, which says when a change really applies): the five the form, the toolbar button and the typed trigger read, and the    *
 * hidden per-device memory of the In this note choice on the selection route and on the trigger route (public: false, so never on the Settings     *
 * screen; a plugin's settings are not synced, so each device remembers its own).                                                                  *
 *                                                                                                                                                  *
 * WHEN A CHANGED TRIGGER APPLIES. The Markdown editor's content script asks for the trigger when it loads, whenever the editor is given another note *
 * (or its text is replaced from outside, as a sync does) and after every fire (src/contentScript.ts). Settings is a screen of its own on both       *
 * platforms: opening it takes the editor down and leaving it builds a new one, which asks again - so a change applies as soon as the settings are   *
 * left (seen in the e2e app on desktop; mobile is expected to do the same, as its note screen is rebuilt, and is unchecked).                       *
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
export const LAST_SELECTION_ACTION_KEY = "lastSelectionAction"
export const TRIGGER_KEY = "trigger"
export const LAST_TRIGGER_ACTION_KEY = "lastTriggerAction"

export const TYPE_TODO = "todo"
export const TYPE_NOTE = "note"
export const OPEN_IN_EDITOR = "editor"
export const OPEN_IN_WINDOW = "window"
// The In this note choices (formModel's KEEP, REPLACE, AFTER); replace is the default until the user picks another (formModel.SELECTION_DEFAULT).
// An install that already remembers another choice keeps it.
export const SELECTION_REPLACE = "replace"
// The trigger route's choices (formModel's REMOVE, LINK); remove is the default until the user picks another.
export const TRIGGER_REMOVE = "remove"
// The trigger's default (triggerRule's DEFAULT_TRIGGER).
export const DEFAULT_TRIGGER = "++"

const TriggerRule = require("../form/triggerRule")

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
        [TRIGGER_KEY]: {
            label: "Typed trigger",
            description: "Typing this at the start of a line or after a space opens Jot, in the Markdown editor on desktop and mobile. Leave empty to turn it off. A change applies as soon as you leave the settings.",
            value: DEFAULT_TRIGGER,
            type: SettingItemType.String,
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
        [LAST_SELECTION_ACTION_KEY]: {
            label: "In this note, the choice made last time (selection)",
            value: SELECTION_REPLACE,
            type: SettingItemType.String,
            public: false,
            section: SECTION,
        },
        [LAST_TRIGGER_ACTION_KEY]: {
            label: "In this note, the choice made last time (typed trigger)",
            value: TRIGGER_REMOVE,
            type: SettingItemType.String,
            public: false,
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

/** getLastSelectionAction / setLastSelectionAction *************************************************************************************************
 * The In this note choice remembered from the last create on the selection route ("keep", "replace" or "after"), the form's default next time. The  *
 * read gives the raw value (formModel.selectionAction checks it against the buttons offered); both are guarded, since a memory that cannot be read  *
 * or written must never cost the user the note: the read falls back to replace, a failed write is a console warning.                                *
 ***************************************************************************************************************************************************/
export async function getLastSelectionAction(){
    try {
        return String((await joplin.settings.value(LAST_SELECTION_ACTION_KEY)) || SELECTION_REPLACE)
    } catch (error) {
        console.warn("Jot: could not read the In this note choice made last time", error)
        return SELECTION_REPLACE
    }
}

export async function setLastSelectionAction(value: string){
    try {
        await joplin.settings.setValue(LAST_SELECTION_ACTION_KEY, value)
    } catch (error) {
        console.warn("Jot: could not remember the In this note choice", error)
    }
}


/** getTrigger **************************************************************************************************************************************
 * The typed trigger as the content script uses it (triggerRule.normalizeTrigger: trimmed; "" turns the route off). A setting that cannot be read is *
 * "" too, so a broken read never makes the editor open forms on its own.                                                                           *
 ***************************************************************************************************************************************************/
export async function getTrigger(): Promise<string> {
    try {
        return TriggerRule.normalizeTrigger(await joplin.settings.value(TRIGGER_KEY))
    } catch (error) {
        console.warn("Jot: could not read the typed trigger, leaving it off", error)
        return ""
    }
}

/** getLastTriggerAction / setLastTriggerAction *****************************************************************************************************
 * The In this note choice remembered from the last create on the trigger route ("remove" or "link"), the form's default next time; guarded as the    *
 * selection route's memory is.                                                                                                                    *
 ***************************************************************************************************************************************************/
export async function getLastTriggerAction(){
    try {
        return String((await joplin.settings.value(LAST_TRIGGER_ACTION_KEY)) || TRIGGER_REMOVE)
    } catch (error) {
        console.warn("Jot: could not read the In this note choice made last time for the typed trigger", error)
        return TRIGGER_REMOVE
    }
}

export async function setLastTriggerAction(value: string){
    try {
        await joplin.settings.setValue(LAST_TRIGGER_ACTION_KEY, value)
    } catch (error) {
        console.warn("Jot: could not remember the In this note choice for the typed trigger", error)
    }
}
