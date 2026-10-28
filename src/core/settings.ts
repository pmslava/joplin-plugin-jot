/** README ******************************************************************************************************************************************
 * Jot's settings, under Settings > Plugins > Jot: what every part of the form starts with - the type, the notebook, the tags of the note you are   *
 * in, the back link, whether the new note opens, whether it is pinned in Note Tabs, the In this note choice for highlighted text and for the typed *
 * trigger - and the typed trigger, the day start time and the toolbar button. Every selector in the form has its default here and remembers        *
 * nothing between opens (issue 5: the In this note choice used to be remembered from the last create instead). The notebook, tags and back link    *
 * settings answer issues 3, 1 and 2, and depend on how Jot was opened (issue 6): a quick note (nothing highlighted) or a note from text in a note  *
 * (highlighted text, the typed trigger).                                                                                                           *
 *                                                                                                                                                  *
 * THE NOTE TABS SETTING (issue 7) also decides whether the form has its row at all: Not used, the default, draws no Note Tabs row, and Jot never   *
 * calls the Note Tabs plugin; Pin and Don't pin draw the row, starting there. No plugin can ask which other plugins are installed, so it is this   *
 * setting that says Note Tabs is there. Plugin settings stay on the device, so a phone shows the row only when it is set on that phone.            *
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
 *                                                                                                                                                  *
 * QUICK TO START, QUICK TO OPEN. On a phone each call to Joplin is a round trip, and while a sync runs and the other plugins start each one waited  *
 * about two seconds (Jot's start took 26.6 s, 2026-10-14). So the section and the settings are registered together, everything the start and the  *
 * form need is then read in ONE call (readStartupSettings: the form's settings, the toolbar gate, the 0.2.0 switches, the stored lists), and the    *
 * form's settings are kept in memory from it. THE STORED LISTS (listCache, hidden): the notebooks and tag titles as Jot last read them, so a form   *
 * opened right after the app starts, before the first read of the lists has come back, has them; plugin settings stay on the device (they are not *
 * synced) and come back after a restart. Written only when a fresh read differs, and its own change notice is ignored (watchSettings).            *
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
// Whether the new note is pinned in the Note Tabs plugin (issue 7), and whether the form offers it at all.
export const NOTE_TABS_KEY = "noteTabs"
export const DAY_START_TIME_KEY = "dayStartTime"
export const SHOW_TOOLBAR_BUTTON_KEY = "showToolbarButton"
export const SELECTION_ACTION_KEY = "selectionAction"
export const TRIGGER_KEY = "trigger"
export const TRIGGER_ACTION_KEY = "triggerAction"
// The notebook and tag lists as last read, kept across restarts (see the README); hidden.
export const LIST_CACHE_KEY = "listCache"

export const TYPE_TODO = "todo"
export const TYPE_NOTE = "note"
// The Open row's values (formModel's OPEN_NO, OPEN_EDITOR, OPEN_WINDOW).
export const OPEN_NO = "no"
export const OPEN_IN_EDITOR = "editor"
export const OPEN_IN_WINDOW = "window"
// The Note Tabs setting's values: no row and no call to Note Tabs (the default), or the row starting on Pin or on Don't pin (formModel's
// NOTE_TABS_OFF, NOTE_TABS_PIN, NOTE_TABS_NONE).
export const NOTE_TABS_OFF = "off"
export const NOTE_TABS_PIN = "pin"
export const NOTE_TABS_NONE = "none"
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

// Settles once Jot's settings are registered (setupSettings): a setting read before that throws "Unknown key", and a notebook list registered
// before it would be wiped by it.
let registration: Promise<void> | null = null
let markRegistered: () => void = () => undefined
const registered = new Promise<void>(resolve => { markRegistered = resolve })

export function settingsRegistered(): Promise<void> {
    return registered
}

/** setupSettings ***********************************************************************************************************************************
 * Registers the section and its settings, both at once, then reads what the start needs in one call (readStartupSettings) and carries the 0.2.0     *
 * switches over. Resolves that read: the toolbar gate and the stored lists. Never throws past a failed registration's warning.                   *
 ***************************************************************************************************************************************************/
export interface StartupSettings {
    showToolbarButton: boolean
    storedLists: StoredLists | null
}

export async function setupSettings(): Promise<StartupSettings> {
    if (!registration) registration = registerJotSettings().finally(() => markRegistered())
    await registration
    const startup = await readStartupSettings()
    await migrateSettings(startup.raw)
    return { showToolbarButton: startup.raw[SHOW_TOOLBAR_BUTTON_KEY] !== false, storedLists: parseStoredLists(startup.raw[LIST_CACHE_KEY]) }
}

async function registerJotSettings(): Promise<void> {
    const section = joplin.settings.registerSection(SECTION, {
        label: "Jot",
        iconName: "fas fa-feather-alt",
        description: "Quick capture of a note or to-do without leaving the one you are in.",
    })
    const settings = joplin.settings.registerSettings({
        [DEFAULT_TYPE_KEY]: {
            label: "What Jot creates",
            description: "Whether the form opens as a to-do or a note. You can switch in the form.",
            value: TYPE_TODO,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [TYPE_NOTE]: "A note",
                [TYPE_TODO]: "A to-do",
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
        [NOTE_TABS_KEY]: {
            label: "Pin the new note in Note Tabs",
            description: "Needs the Note Tabs plugin. Pin, or Don't pin: the form gets a Note Tabs row that starts there, and you can switch it in the form. Not used: no row, and Note Tabs is never called.",
            value: NOTE_TABS_OFF,
            type: SettingItemType.String,
            isEnum: true,
            options: {
                [NOTE_TABS_OFF]: "Not used",
                [NOTE_TABS_PIN]: "Pin",
                [NOTE_TABS_NONE]: "Don't pin",
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
        [LIST_CACHE_KEY]: {
            label: "The notebooks and tags as Jot last read them (kept for the first form after a start)",
            value: "",
            type: SettingItemType.String,
            public: false,
            section: SECTION,
        },
    })
    await Promise.all([section, settings])
}

/** migrateSettings *********************************************************************************************************************************
 * Carries 0.2.0's two switches over to their three-way successors once (issue 6): tags switched off becomes Never, a back link switched on becomes   *
 * Always. Each old switch is then put back to its default, so the carry-over happens once and never overrides a later choice. Nothing is written   *
 * on an install that never touched them, which gets the new defaults (tags for notes from text, no back link). The switches come from the startup  *
 * read. Never throws.                                                                                                                              *
 ***************************************************************************************************************************************************/
async function migrateSettings(raw: Record<string, unknown>){
    try {
        if (raw[OLD_COPY_TAGS_KEY] === false){
            await joplin.settings.setValue(TAGS_FROM_KEY, FOR_NEVER)
            await joplin.settings.setValue(OLD_COPY_TAGS_KEY, true)
            formSettingsCache = null
        }
        if (raw[OLD_BACKLINK_KEY] === true){
            await joplin.settings.setValue(BACKLINK_FOR_KEY, FOR_ALWAYS)
            await joplin.settings.setValue(OLD_BACKLINK_KEY, false)
            formSettingsCache = null
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

/** getFormSettings *******************************************************************************************************************************
 * Every setting the form starts from, in ONE call (joplin.settings.values, 3.7.21: { key: value } for the keys asked), normalized as the getters    *
 * above normalize them. On a phone each call from the plugin to Joplin is a round trip, and the form used to make about ten of them before it could *
 * open. An app without values() is read key by key. Never throws: an unreadable setting is its default.                                          *
 ***************************************************************************************************************************************************/
const FORM_SETTING_KEYS = [
    DEFAULT_TYPE_KEY, DAY_START_TIME_KEY, DEFAULT_NOTEBOOK_KEY, TEXT_NOTEBOOK_KEY, TAGS_FROM_KEY, BACKLINK_FOR_KEY, BACKLINK_TEMPLATE_KEY,
    BACKLINK_POSITION_KEY, OPEN_AFTER_CREATE_KEY, NOTE_TABS_KEY, SELECTION_ACTION_KEY, TRIGGER_ACTION_KEY,
]

export interface FormSettings {
    defaultType: string
    dayStartTime: string
    quickNotebookId: string
    textNotebookId: string
    tagsFrom: string
    backlink: { for: string, template: string, position: string }
    openAfterCreate: string
    // "off" (no row), "pin" or "none".
    noteTabs: string
    selectionAction: string
    triggerAction: string
}

// What the start reads besides the form's settings: the toolbar gate, the 0.2.0 switches and the stored lists.
const STARTUP_SETTING_KEYS = [...FORM_SETTING_KEYS, SHOW_TOOLBAR_BUTTON_KEY, OLD_COPY_TAGS_KEY, OLD_BACKLINK_KEY, LIST_CACHE_KEY]

async function readSettingValues(keys: string[]): Promise<Record<string, unknown>> {
    try {
        const values = await joplin.settings.values(keys)
        if (values && typeof values === "object") return values
    } catch (error) {
        // An app without settings.values: one read each, below.
    }
    const values: Record<string, unknown> = {}
    for (const key of keys){
        try {
            values[key] = await joplin.settings.value(key)
        } catch (error) {
            values[key] = undefined
        }
    }
    return values
}

// The form's settings as last read, kept in memory: an open makes no call for them. Any change to a setting forgets them (watchSettings), and the
// next open reads them again. On a phone during or just after a sync, one settings call was measured at 2.9 to 12.5 s. Joplin tells plugins of a
// change a second after the last one (Setting.scheduleChangeEvent, 3.7.21), so a form opened within that second still starts on the old values;
// the next open has the new ones.
let formSettingsCache: FormSettings | null = null
// The start's read while it is on its way: a form opened meanwhile waits for it rather than asking again.
let startupRead: Promise<unknown> | null = null

export async function getFormSettings(): Promise<FormSettings> {
    if (formSettingsCache) return formSettingsCache
    if (startupRead){
        await startupRead.catch(() => undefined)
        if (formSettingsCache) return formSettingsCache
    }
    await settingsRegistered()
    const read = normalizeFormSettings(await readSettingValues(FORM_SETTING_KEYS))
    if (settingsWatched) formSettingsCache = read
    return read
}

/** readStartupSettings *****************************************************************************************************************************
 * The start's one read (STARTUP_SETTING_KEYS), sent together with the change listener (watchSettings, sent first, so no change can fall between    *
 * the two): the form's settings are kept from it, and the rest goes back to setupSettings. Never throws: an unreadable key is undefined.          *
 ***************************************************************************************************************************************************/
async function readStartupSettings(): Promise<{ raw: Record<string, unknown> }> {
    const read = (async () => {
        const [, raw] = await Promise.all([watchSettings(), readSettingValues(STARTUP_SETTING_KEYS)])
        if (settingsWatched) formSettingsCache = normalizeFormSettings(raw)
        return { raw }
    })()
    startupRead = read
    try {
        return await read
    } finally {
        startupRead = null
    }
}

/** watchSettings ***********************************************************************************************************************************
 * Forgets the form's settings whenever one changes (the Settings screen, a sync of settings, Jot's own carry-over), so the next open reads them     *
 * again - except when the only key that changed is the stored lists, which Jot writes itself after reading the lists. Never throws: an app that    *
 * cannot report changes leaves the cache off, and every open reads the settings.                                                                   *
 ***************************************************************************************************************************************************/
let settingsWatched = false

export async function watchSettings(): Promise<void> {
    if (settingsWatched) return
    try {
        await joplin.settings.onChange((event: any) => {
            const keys = event && Array.isArray(event.keys) ? event.keys : null
            if (keys && keys.length && keys.every((key: unknown) => key === LIST_CACHE_KEY)) return
            formSettingsCache = null
        })
        settingsWatched = true
    } catch (error) {
        console.warn("Jot: could not follow setting changes; the form reads its settings on every open", error)
    }
}

function normalizeFormSettings(raw: Record<string, unknown>): FormSettings {
    const open = raw[OPEN_AFTER_CREATE_KEY]
    const noteTabs = raw[NOTE_TABS_KEY]
    return {
        defaultType: raw[DEFAULT_TYPE_KEY] === TYPE_NOTE ? TYPE_NOTE : TYPE_TODO,
        dayStartTime: String(raw[DAY_START_TIME_KEY] || ""),
        quickNotebookId: String(raw[DEFAULT_NOTEBOOK_KEY] || ""),
        textNotebookId: String(raw[TEXT_NOTEBOOK_KEY] || ""),
        tagsFrom: forValue(raw[TAGS_FROM_KEY], FOR_TEXT),
        backlink: {
            for: forValue(raw[BACKLINK_FOR_KEY], FOR_NEVER),
            template: String(raw[BACKLINK_TEMPLATE_KEY] || "").trim() || DEFAULT_BACKLINK_TEMPLATE,
            position: raw[BACKLINK_POSITION_KEY] === BACKLINK_BOTTOM ? BACKLINK_BOTTOM : BACKLINK_TOP,
        },
        openAfterCreate: open === OPEN_IN_EDITOR || open === OPEN_IN_WINDOW ? open : OPEN_NO,
        noteTabs: noteTabs === NOTE_TABS_PIN || noteTabs === NOTE_TABS_NONE ? noteTabs : NOTE_TABS_OFF,
        selectionAction: String(raw[SELECTION_ACTION_KEY] || SELECTION_REPLACE),
        triggerAction: String(raw[TRIGGER_ACTION_KEY] || TRIGGER_LINK),
    }
}

// Whether the settings may be kept: only while changes are followed.
export function settingsCacheable(): boolean {
    return settingsWatched
}

/** The stored lists ********************************************************************************************************************************
 * The notebooks ({ id, title, parent_id }) and the tag titles as Jot last read them, in one hidden setting (see the README), as compact JSON:        *
 * { v: 1, f: [[id, parent_id, title], ...], t: [title, ...] }. parseStoredLists reads it back (null for anything else: never stored, another       *
 * version, damaged); storeLists writes a fresh read when it differs from what is stored, in the background. Never throw.                           *
 ***************************************************************************************************************************************************/
export interface StoredLists {
    folders: { id: string, title: string, parent_id: string }[]
    tags: { id: string, title: string }[]
}

const STORED_LISTS_VERSION = 1
// The stored value as last read or written, so an unchanged list is not written again.
let storedListsText: string | null = null

export function parseStoredLists(raw: unknown): StoredLists | null {
    if (typeof raw !== "string" || !raw) return null
    try {
        const data = JSON.parse(raw)
        if (!data || data.v !== STORED_LISTS_VERSION || !Array.isArray(data.f) || !Array.isArray(data.t)) return null
        const folders = data.f
            .filter((row: unknown) => Array.isArray(row) && typeof row[0] === "string" && row[0])
            .map((row: any[]) => ({ id: row[0], parent_id: typeof row[1] === "string" ? row[1] : "", title: typeof row[2] === "string" ? row[2] : "" }))
        // The form needs only the tag titles (Create reads the tags afresh to attach them), so the ids are not kept.
        const tags = data.t.filter((title: unknown) => typeof title === "string" && title).map((title: string) => ({ id: "", title }))
        if (!folders.length) return null
        storedListsText = raw
        return { folders, tags }
    } catch (error) {
        return null
    }
}

export function storedListsValue(folders: any[], tags: any[]): string {
    return JSON.stringify({
        v: STORED_LISTS_VERSION,
        f: folders.filter(folder => folder && folder.id).map(folder => [String(folder.id), String(folder.parent_id || ""), String(folder.title || "")]),
        t: tags.map(tag => String((tag && tag.title) || "")).filter(title => !!title),
    })
}

export async function storeLists(folders: any[], tags: any[]): Promise<void> {
    const value = storedListsValue(folders, tags)
    if (value === storedListsText) return
    try {
        await joplin.settings.setValue(LIST_CACHE_KEY, value)
        storedListsText = value
    } catch (error) {
        console.warn("Jot: could not keep the notebook and tag lists for the next start", error)
    }
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
