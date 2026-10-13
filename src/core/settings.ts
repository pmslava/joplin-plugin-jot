/** README ******************************************************************************************************************************************
 * Jot's settings, under Settings > Plugins > Jot: what every part of the form starts with - the type, the notebook, the tags of the note you are  *
 * in, the back link, whether the new note opens, the In this note choice for highlighted text and for the typed trigger - and the typed trigger, the *
 * day start time and the toolbar button. Every selector in the form has its default here and remembers nothing between opens (issue 5: the In this  *
 * note choice used to be remembered from the last create instead). The notebook, tags and back link settings answer issues 3, 1 and 2, and depend *
 * on how Jot was opened (issue 6): a quick note (nothing highlighted) or a note from text in a note (highlighted text, the typed trigger).          *
 *                                                                                                                                                  *
 * WHEN A CHANGED TRIGGER APPLIES. The Markdown editor's content script asks for the trigger when it loads, whenever the editor is given another note *
 * (or its text is replaced from outside, as a sync does) and after every fire (src/contentScript.ts). Settings is a screen of its own on both       *
 * platforms: opening it takes the editor down and leaving it builds a new one, which asks again - so a change applies as soon as the settings are   *
 * left (seen in the e2e app on desktop; mobile is expected to do the same, as its note screen is rebuilt, and is unchecked).                       *
 *                                                                                                                                                  *
 * THE NOTEBOOK SETTINGS (quick notes; notes from text in a note) are dropdowns of the notebooks that exist: "The current notebook" (the note you are *
 * its path, stored by id. A plugin's options are fixed when it registers a setting, but Joplin (3.7.21, Setting.registerSetting) lets it register   *
 * the same key again - the new options replace the old and the stored value is kept - so the list is registered at startup and again whenever the    *
 * form reads a notebook list that differs (registerNotebookChoices). A stored notebook that no longer exists falls back to the current one.          *
 *                                                                                                                                                  *
 * The keyboard shortcut is not a setting: the menu item carries an accelerator, so the command is listed under Options > Keyboard Shortcuts.        *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { SettingItemType } from "api/types"

/** Keys and values ********************************************************************************************************************************/
export const SECTION = "jot"
export const DEFAULT_TYPE_KEY = "defaultType"
export const DEFAULT_NOTEBOOK_KEY = "defaultNotebook"
export const TAGS_FROM_KEY = "tagsFrom"
export const BACKLINK_FOR_KEY = "backlinkFor"
// The notebook for notes from text in a note (issue 6); defaultNotebook is the one for quick notes, under its 0.2.0 key so a chosen inbox is kept.
export const TEXT_NOTEBOOK_KEY = "textNotebook"
// 0.2.0's two switches, kept hidden only so migrateSettings can carry a choice made in them over to tagsFrom and backlinkFor.
export const OLD_COPY_TAGS_KEY = "copyTags"
export const OLD_BACKLINK_KEY = "backlink"
export const BACKLINK_TEMPLATE_KEY = "backlinkTemplate"
export const BACKLINK_POSITION_KEY = "backlinkPosition"
export const OPEN_AFTER_CREATE_KEY = "openAfterCreate"
export const DAY_START_TIME_KEY = "dayStartTime"
export const SHOW_TOOLBAR_BUTTON_KEY = "showToolbarButton"
export const SELECTION_ACTION_KEY = "selectionAction"
export const TRIGGER_KEY = "trigger"
export const TRIGGER_ACTION_KEY = "triggerAction"

export const TYPE_TODO = "todo"
export const TYPE_NOTE = "note"
// The Open row's values (formModel's OPEN_NO, OPEN_EDITOR, OPEN_WINDOW).
export const OPEN_NO = "no"
export const OPEN_IN_EDITOR = "editor"
export const OPEN_IN_WINDOW = "window"
// The back link's position (formModel's BACKLINK_TOP, BACKLINK_BOTTOM) and its default text (formModel's DEFAULT_BACKLINK_TEMPLATE).
export const BACKLINK_TOP = "top"
export const BACKLINK_BOTTOM = "bottom"
export const DEFAULT_BACKLINK_TEMPLATE = "Parent {note_type}: {note_link}"
// The notebook setting's "The current notebook" value.
export const CURRENT_NOTEBOOK = ""
// When the tags and the back link apply (issue 6): never, for notes from text in a note (highlighted text or the typed trigger), or always.
export const FOR_NEVER = "never"
export const FOR_TEXT = "text"
export const FOR_ALWAYS = "always"
// The In this note choices (formModel's KEEP, REPLACE, AFTER): the selectionAction setting's values, replace by default (formModel.SELECTION_DEFAULT).
export const SELECTION_REPLACE = "replace"
export const SELECTION_KEEP = "keep"
export const SELECTION_AFTER = "after"
// The trigger route's choices (formModel's LINK, REMOVE): the triggerAction setting's values, link by default (formModel.TRIGGER_DEFAULT).
export const TRIGGER_LINK = "link"
export const TRIGGER_REMOVE = "remove"
// The trigger's default (triggerRule's DEFAULT_TRIGGER).
export const DEFAULT_TRIGGER = "++"

const TriggerRule = require("../form/triggerRule")

/** notebookSettingSpecs ****************************************************************************************************************************
 * The two notebook settings (issue 6), with the same options: "The current notebook" first, then every notebook by path ({ id, path }, sorted, as   *
 * the form shows them). One for quick notes - Jot opened with nothing highlighted - and one for notes from text in a note - highlighted text or the *
 * typed trigger; each says so in its own label, so no setting depends on another.                                                                  *
 ***************************************************************************************************************************************************/
function notebookSettingSpecs(notebooks: { id: string, path: string }[]){
    const options: { [id: string]: string } = { [CURRENT_NOTEBOOK]: "The current notebook" }
    for (const notebook of notebooks) options[notebook.id] = notebook.path
    const spec = (label: string, description: string) => ({
        label, description, value: CURRENT_NOTEBOOK, type: SettingItemType.String, isEnum: true, options: { ...options }, public: true, section: SECTION,
    })
    return {
        [DEFAULT_NOTEBOOK_KEY]: spec("Notebook for quick notes",
            "Where a note starts when you open Jot with nothing highlighted (the shortcut, the menu, the toolbar button): the notebook of the note you are in, or always the same notebook, such as an inbox. You can pick another in the form. Notebooks made later appear here once Jot has been used."),
        [TEXT_NOTEBOOK_KEY]: spec("Notebook for notes from text in a note",
            "Where a note starts when you open Jot from highlighted text or by typing the trigger: the notebook of the note the text is in, or always the same notebook. You can pick another in the form."),
    }
}

// The notebook list the setting was last registered with, as a signature, so an unchanged list is not registered again.
let registeredNotebooks: string | null = null

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
        ...notebookSettingSpecs([]),
        [TAGS_FROM_KEY]: {
            label: "Fill in the tags of the note you are in",
            description: "For notes from text in a note: when Jot is opened from highlighted text or by the typed trigger, the form's Tags start with the tags of that note. Always: whenever you are in a note. You can change or clear them in the form.",
            value: FOR_TEXT,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [FOR_NEVER]: "Never",
                [FOR_TEXT]: "For notes from text in a note",
                [FOR_ALWAYS]: "Always",
            },
            public: true,
            section: SECTION,
        },
        [BACKLINK_FOR_KEY]: {
            label: "Add a back link to the note you are in",
            description: "Where the form's Back link starts: on Add for notes from text in a note (highlighted text or the typed trigger), always, or never. You can switch it in the form.",
            value: FOR_NEVER,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [FOR_NEVER]: "Never",
                [FOR_TEXT]: "For notes from text in a note",
                [FOR_ALWAYS]: "Always",
            },
            public: true,
            section: SECTION,
        },
        [BACKLINK_TEMPLATE_KEY]: {
            label: "Back link text",
            description: "Placeholders for the note you are in: {note_link} (a Markdown link to it), {note_title}, {note_id}, {note_type} (to-do or note), {notebook_name}, {notebook_path} (such as Work/Projects), {notebook_id}. Empty means the default, Parent {note_type}: {note_link}.",
            value: DEFAULT_BACKLINK_TEMPLATE,
            type: SettingItemType.String,
            public: true,
            section: SECTION,
        },
        [BACKLINK_POSITION_KEY]: {
            label: "Back link position",
            description: "The back link's own line, with an empty line between it and the text.",
            value: BACKLINK_TOP,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [BACKLINK_TOP]: "First line, above the text",
                [BACKLINK_BOTTOM]: "Last line, below the text",
            },
            public: true,
            section: SECTION,
        },
        [OPEN_AFTER_CREATE_KEY]: {
            label: "Open the new note",
            description: "Where the form's Open starts: stay where you are, open the note in the editor, or in a new window (desktop). You can switch it in the form.",
            value: OPEN_NO,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [OPEN_NO]: "No, stay where you are",
                [OPEN_IN_EDITOR]: "In the editor",
                [OPEN_IN_WINDOW]: "In a new window",
            },
            public: true,
            section: SECTION,
        },
        [SELECTION_ACTION_KEY]: {
            label: "In this note, for highlighted text",
            description: "Where the form's In this note starts when Jot is opened from highlighted text. You can switch it in the form. Add a link after it is offered in the Markdown editor only; in the Rich Text editor the form starts on Replace instead.",
            value: SELECTION_REPLACE,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [SELECTION_REPLACE]: "Replace it with a link to the new note",
                [SELECTION_KEEP]: "Keep the text",
                [SELECTION_AFTER]: "Add a link after it",
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
        [TRIGGER_ACTION_KEY]: {
            label: "In this note, for the typed trigger",
            description: "Where the form's In this note starts when Jot is opened by the typed trigger. You can switch it in the form.",
            value: TRIGGER_LINK,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [TRIGGER_LINK]: "Replace the trigger with a link to the new note",
                [TRIGGER_REMOVE]: "Remove the trigger",
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
        [OLD_COPY_TAGS_KEY]: {
            label: "Fill in the tags of the note you are in (0.2.0, carried over to tagsFrom)",
            value: true,
            type: SettingItemType.Bool,
            public: false,
            section: SECTION,
        },
        [OLD_BACKLINK_KEY]: {
            label: "Add a back link to the note you are in (0.2.0, carried over to backlinkFor)",
            value: false,
            type: SettingItemType.Bool,
            public: false,
            section: SECTION,
        },
    })
    await migrateSettings()
}

/** migrateSettings *********************************************************************************************************************************
 * Carries 0.2.0's two switches over to their three-way successors once (issue 6): tags switched off becomes Never, a back link switched on becomes   *
 * Always. Each old switch is then put back to its default, so the carry-over happens once and never overrides a later choice. Nothing is written   *
 * on an install that never touched them, which gets the new defaults (tags for notes from text, no back link). Never throws.                      *
 ***************************************************************************************************************************************************/
async function migrateSettings(){
    try {
        if ((await joplin.settings.value(OLD_COPY_TAGS_KEY)) === false){
            await joplin.settings.setValue(TAGS_FROM_KEY, FOR_NEVER)
            await joplin.settings.setValue(OLD_COPY_TAGS_KEY, true)
        }
        if ((await joplin.settings.value(OLD_BACKLINK_KEY)) === true){
            await joplin.settings.setValue(BACKLINK_FOR_KEY, FOR_ALWAYS)
            await joplin.settings.setValue(OLD_BACKLINK_KEY, false)
        }
    } catch (error) {
        console.warn("Jot: could not carry the 0.2.0 tag and back link settings over", error)
    }
}

/** getDefaultType **********************************************************************************************************************************
 * The type the form opens with, "todo" or "note"; anything unreadable is a to-do, the setting's default.                                           *
 ***************************************************************************************************************************************************/
export async function getDefaultType(){
    var value = await joplin.settings.value(DEFAULT_TYPE_KEY)
    return value === TYPE_NOTE ? TYPE_NOTE : TYPE_TODO
}

/** getOpenAfterCreate ******************************************************************************************************************************
 * Where the Open row starts, "no", "editor" or "window"; anything unreadable is "no", the setting's default.                                      *
 ***************************************************************************************************************************************************/
export async function getOpenAfterCreate(){
    var value = await joplin.settings.value(OPEN_AFTER_CREATE_KEY)
    return value === OPEN_IN_EDITOR || value === OPEN_IN_WINDOW ? value : OPEN_NO
}

/** getDefaultNotebookId ****************************************************************************************************************************
 * The notebook the setting for this kind of note names - quick notes, or notes from text in a note when `fromText` - or "" for the current notebook *
 * (also when it cannot be read).                                                                                                                   *
 ***************************************************************************************************************************************************/
export async function getDefaultNotebookId(fromText = false): Promise<string> {
    try {
        return String((await joplin.settings.value(fromText ? TEXT_NOTEBOOK_KEY : DEFAULT_NOTEBOOK_KEY)) || "")
    } catch (error) {
        console.warn("Jot: could not read the notebook setting, using the current notebook", error)
        return CURRENT_NOTEBOOK
    }
}

/** getTagsFrom / getBacklinkSettings ***************************************************************************************************************
 * When the Tags start with the current note's tags ("never", "text" or "always"; anything else is "text", the default); and the back link's: when   *
 * it starts on Add ("never" unless "text" or "always"), its text (the default when empty) and position (top unless bottom).                        *
 ***************************************************************************************************************************************************/
function forValue(value: unknown, fallback: string): string {
    return value === FOR_NEVER || value === FOR_TEXT || value === FOR_ALWAYS ? value : fallback
}

export async function getTagsFrom(): Promise<string> {
    return forValue(await joplin.settings.value(TAGS_FROM_KEY), FOR_TEXT)
}

export async function getBacklinkSettings(): Promise<{ for: string, template: string, position: string }> {
    const when = forValue(await joplin.settings.value(BACKLINK_FOR_KEY), FOR_NEVER)
    const template = String((await joplin.settings.value(BACKLINK_TEMPLATE_KEY)) || "").trim() || DEFAULT_BACKLINK_TEMPLATE
    const position = (await joplin.settings.value(BACKLINK_POSITION_KEY)) === BACKLINK_BOTTOM ? BACKLINK_BOTTOM : BACKLINK_TOP
    return { for: when, template, position }
}

/** registerNotebookChoices *************************************************************************************************************************
 * Registers the two notebook settings again with `notebooks` ({ id, path }, sorted) as their options, when they differ from the list registered last. *
 * stored value is kept (see the README). Never throws: a refusal is a console warning, and the setting keeps its last options.                     *
 ***************************************************************************************************************************************************/
export async function registerNotebookChoices(notebooks: { id: string, path: string }[]): Promise<void> {
    const signature = JSON.stringify(notebooks.map(notebook => [notebook.id, notebook.path]))
    if (signature === registeredNotebooks) return
    try {
        await joplin.settings.registerSettings(notebookSettingSpecs(notebooks))
        registeredNotebooks = signature
    } catch (error) {
        console.warn("Jot: could not update the notebook list in Settings", error)
    }
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

/** getSelectionAction / getTriggerAction **********************************************************************************************************
 * Where the form's In this note starts: on the selection route "replace", "keep" or "after", on the trigger route "link" or "remove" (the raw value;  *
 * formModel.inThisNoteAction checks it against the buttons offered). Guarded: a setting that cannot be read is the route's default.               *
 ***************************************************************************************************************************************************/
export async function getSelectionAction(): Promise<string> {
    try {
        return String((await joplin.settings.value(SELECTION_ACTION_KEY)) || SELECTION_REPLACE)
    } catch (error) {
        console.warn("Jot: could not read the In this note setting for highlighted text", error)
        return SELECTION_REPLACE
    }
}

export async function getTriggerAction(): Promise<string> {
    try {
        return String((await joplin.settings.value(TRIGGER_ACTION_KEY)) || TRIGGER_LINK)
    } catch (error) {
        console.warn("Jot: could not read the In this note setting for the typed trigger", error)
        return TRIGGER_LINK
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
