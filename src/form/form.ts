/** README ******************************************************************************************************************************************
 * The host side of Jot's form (brief 4.1 to 4.5): openForm(route, presets) gathers what create mode shows, opens the dialog, and applies the       *
 * answer; openEditForm(noteId) does the same for edit mode; runOpenCommand(args) reads jot.open's argument (brief section 6) and picks between     *
 * them.                                                                                                                                            *
 *                                                                                                                                                  *
 * THE COMMAND CONTRACT (brief section 6, formModel.openRequest). jot.open with { mode: 'edit', noteId } is edit mode and resolves { id, changed }  *
 * (the fields written, among title, parent_id, is_todo, todo_due, tags) or null; with { mode: 'new', type?, title?, body?, notebookId? } it is     *
 * create mode on the caller's route, those presets in the fields, no selection read and no In this note row, and resolves { id, opened } or null;  *
 * with no argument, or a mode the contract does not know, it is the shortcut's behaviour (openJot, the selection route when text is highlighted).  *
 *                                                                                                                                                  *
 * EDIT MODE (brief 4.5). The form prefilled from GET notes/:id (title, is_todo, parent_id, todo_due) and GET notes/:id/tags: Type, Title,          *
 * Notebook, Tags and Due, no Text and no In this note, with Save and Cancel. Save writes only what changed (formModel.planEdit): one PUT notes/:id *
 * with that subset - a type switch clears todo_due and todo_completed in both directions, as Joplin's changeNoteType does, the Due applied on top  *
 * for a to-do - then the tag diff (attached as on Create, detached with DELETE tags/:id/notes/:noteId, each tag guarded on its own). An unchanged  *
 * form writes nothing. The body and the completion are never read; nothing is opened and the focus is not moved. A note that cannot be read (gone, *
 * or its tags unreadable) is "Jot: this note no longer exists." and null.                                                                          *
 *                                                                                                                                                  *
 * THE SELECTION ROUTE. openJot(route) is what the three commands run: it reads the editor's selection first (editorSelection.ts) and, when there is  *
 * one, opens the form on the 'selection' route, prefilled from it (formModel.splitSelection), with the In this note row; with none, the route it    *
 * was given, the plain form. After a create on that route the choice is applied to the editor while it surely holds the note the selection came   *
 * from - right after POST notes, BEFORE the tags (writing a tag can make Joplin select another note, see below) and before anything is opened       *
 * (Create and open would switch the editor to the new note, and the edit would land there). The row starts on the selectionAction setting.        *
 *                                                                                                                                                  *
 * THE TRIGGER ROUTE. openTriggerForm(trigger) is what the typed trigger's message runs (src/trigger.ts): the plain form with no prefill, plus the In *
 * this note row with Replace ++ with a link to the new note and Remove ++ (the trigger printed), starting on the triggerAction setting. The edit is not      *
 * made here: the content script makes it in the editor, as one transaction, once it has the answer this resolves ({ action: 'remove' }, { action:  *
 * 'link', link } or { action: 'cancel' }). With Open on, the note is therefore not opened at once - the                                           *
 * editor would switch to the new note before the content script's edit reached the note the trigger was typed in - but puts the new note's id in    *
 * the answer (open); the content script makes its edit and then asks for the open (openTriggerNote), which opens that one id only, once. The tags   *
 * wait too: they are written after the answer has gone (writeTriggerTags, GUARD_TIMING.triggerEditMs later), so a selection Joplin moves while they  *
 * are written cannot take the edit's note away first.                                                                                              *
 *                                                                                                                                                  *
 * THE SELECTION GUARD (selectionGuard.ts). Writing a tag makes Joplin refresh the note list and select a note again, and in All notes that is the     *
 * list's first note - the one just created; moving a listed note to another notebook selects its neighbour. So every tag write (Create's, Save's)    *
 * and every notebook change in edit mode is bracketed by holdSelection / keepSelection, which open the note being read again, with its scroll and     *
 * caret, when Joplin moved off it. Not when the note is about to be opened anyway (Create and open).                                               *
 *                                                                                                                                                  *
 * Every decision is formModel.js's (planCreate and the rules under it), so this file is the I/O around it: the notebooks and tags read from the     *
 * data API, the dialog, the POST notes, the tags (reused as Joplin matches titles, created when missing, attached; never fatal), and the open.     *
 * Create opens nothing and moves no focus: the editor keeps its note, and the selection guard keeps it there when Joplin would not.               *
 *                                                                                                                                                  *
 * THE DIALOGS. Two handles, because buttons are set per handle: jot.form for create mode, with Create (id ok, which Enter in a text input          *
 * resolves to), Create and open (id openAfter) and Cancel (id cancel, which Escape resolves to); jot.edit for edit mode, with Save (id ok) and     *
 * Cancel. Each is created on its first open (Harper's lazy build: a failed build is not remembered, so the next open tries again), with the same   *
 * scripts and stylesheet, and its buttons set once. The markup is set on every open (formHtml.ts, one builder for both modes); setHtml does not    *
 * re-run the scripts, which wire each new form themselves (formWebview.js). One form at a time, whichever the mode.                                *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in one expression.                                                              *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from "api"
import { buildFormHtml, FormNotebook, FormValues } from "./formHtml"
import { FormSettings, getDayStartTime, getFormSettings, OPEN_IN_WINDOW, registerNotebookChoices, watchSettings } from "../core/settings"
import { SHOW_OPEN_TIMINGS, Stopwatch, stopwatch } from "../core/timing"
import { isMobile } from "../core/platform"
import { applySelectionEdit, editorIsMarkdown, readSelectedText } from "./editorSelection"
import { guardTiming, holdSelection, keepSelection } from "./selectionGuard"
const FormModel = require("./formModel")

/** Constants ***************************************************************************************************************************************/
export const FORM_DIALOG_ID = "jot.form"
export const EDIT_DIALOG_ID = "jot.edit"
// The route of a form opened from highlighted text, whichever command opened it.
export const SELECTION_ROUTE = "selection"
// The route of a form opened by the typed trigger in the Markdown editor (the content script's message).
export const TRIGGER_ROUTE = "trigger"
// The route of a form another plugin opened with jot.open { mode: 'new', ... }: the caller's presets, no selection read, no In this note row.
export const CALLER_ROUTE = "caller"
// Two buttons: Create (id ok, which Enter in a text input resolves to) and Cancel (id cancel, which Escape resolves to). Whether the new note opens
// is the form's Open row.
export const FORM_BUTTONS = [
    { id: "ok", title: "Create" },
    { id: "cancel", title: "Cancel" },
]
export const EDIT_BUTTONS = [
    { id: "ok", title: "Save" },
    { id: "cancel", title: "Cancel" },
]
// The two handles and their buttons (buttons are set per handle).
const CREATE_DIALOG: DialogSpec = { id: FORM_DIALOG_ID, buttons: FORM_BUTTONS }
const EDIT_DIALOG: DialogSpec = { id: EDIT_DIALOG_ID, buttons: EDIT_BUTTONS }
// The data API's largest page: a list is read in as few calls as it allows (its default is 10 a page).
const PAGE_LIMIT = 100
// What edit mode reads of the note (brief 4.5): never the body, never the completion.
const EDIT_NOTE_FIELDS = ["id", "title", "is_todo", "parent_id", "todo_due"]
// Loaded into the dialog in this order, though they run in the order they finish loading (hence the call-time globals in formWebview.js).
export const FORM_SCRIPTS = [
    "./form/form.css",
    "./form/alarmQuick.js",
    "./form/searchTokens.js",
    "./form/formModel.js",
    "./form/formWebview.js",
]

/** Types *******************************************************************************************************************************************/
// What a route or a caller can preset. The selection route presets the title and body split from the selection, and carries the selection itself
// (Add a link after it writes it back); the trigger route carries the trigger typed (printed in its In this note labels); another plugin's
// jot.open { mode: 'new' } presets type, title, body and notebookId (formModel.openRequest keeps each only when it has the right shape).
export interface FormPresets {
    type?: string
    title?: string
    body?: string
    notebookId?: string
    selection?: string
    trigger?: string
    // Internal: the open's stopwatch, started at the tap (openJot), so the selection read is timed too (core/timing.ts).
    timing?: Stopwatch
    // Internal: the note the editor holds, read at the tap together with the selection (openJot), so the form does not ask again; null: none.
    editorNote?: any
}

// What the commands resolve in create mode (brief section 6).
export interface FormOutcome {
    id: string
    opened: boolean
}

// What jot.open resolves in edit mode (brief section 6): the note and the fields written, in formModel.planEdit's order.
export interface EditOutcome {
    id: string
    changed: string[]
}

interface DialogSpec {
    id: string
    buttons: { id: string, title: string }[]
}

// What the content script gets back on the trigger route (formModel.triggerAnswer), with the id to open after its edit on Create and open.
export interface TriggerAnswer {
    action: string
    link?: string
    open?: string
}

// A create, as runForm reports it to the route that opened the form.
interface Created {
    id: string
    opened: boolean
    // Where the note opens ("editor" or "window"), "" when it does not.
    openTarget: string
    inThisNote: string | null
    link: string
    openLater: boolean
    // The trigger route's tags, written once the answer has gone (writeTriggerTags); empty on every other route, which writes them in createNote.
    laterTags: string[]
}

// The In this note row of one open: the buttons, their labels, the starting choice, the route's default (what a value the buttons do not offer
// reads as: formModel.SELECTION_DEFAULT or TRIGGER_DEFAULT), and what the route needs to apply the choice.
interface InThisNote {
    choices: string[]
    labels: { [choice: string]: string }
    titles: { [choice: string]: string }
    value: string
    fallback: string
    selection: string | null
    trigger: string | null
}

/** Variable Setup **********************************************************************************************************************************/
// Each dialog handle's build, by dialog id, once started.
var dialogPromises: { [id: string]: Promise<string> } = {}
// A second open while the form is up (the shortcut pressed twice) is ignored rather than replacing the markup under the user.
var formIsOpen = false
// The note created on the trigger route with Open on, and where it opens, waiting for the content script to ask for its open (openTriggerNote).
var triggerOpenPending: { id: string, target: string } | null = null

/** getDialog ***************************************************************************************************************************************
 * A dialog handle (create mode's or edit mode's), built once on its first open, with the shared scripts and its own buttons. Concurrent callers    *
 * share the same build; a failed build is forgotten so the next open retries.                                                                      *
 ***************************************************************************************************************************************************/
function getDialog(spec: DialogSpec): Promise<string> {
    if (!dialogPromises[spec.id]){
        dialogPromises[spec.id] = buildDialog(spec).catch(error => {
            delete dialogPromises[spec.id]
            throw error
        })
    }
    return dialogPromises[spec.id]
}

async function buildDialog(spec: DialogSpec): Promise<string> {
    const handle = await joplin.views.dialogs.create(spec.id)
    for (const script of FORM_SCRIPTS){
        await joplin.views.dialogs.addScript(handle, script)
    }
    await joplin.views.dialogs.setButtons(handle, spec.buttons)
    return handle
}

/** runOpenCommand **********************************************************************************************************************************
 * What jot.open runs with its argument (brief section 6, formModel.openRequest): { mode: 'edit', noteId } is edit mode; { mode: 'new', ... } is    *
 * create mode on the caller's route with the presets kept; anything else (no argument from the menu, the shortcut or the palette) is openJot.      *
 ***************************************************************************************************************************************************/
export async function runOpenCommand(args?: unknown): Promise<FormOutcome | EditOutcome | null> {
    const request = FormModel.openRequest(args)
    if (request.mode === FormModel.EDIT_MODE) return openEditForm(request.noteId)
    if (request.mode === "new") return openForm(CALLER_ROUTE, request.presets)
    return openJot("menu")
}

/** openJot *****************************************************************************************************************************************
 * What jot.open, jot.fromSelection and jot.button run (brief 4.4: one chord serves both). The selection is read first: highlighted text opens the    *
 * form on the selection route, its first non-empty line as the Title and the rest as the Text; no selection (none, whitespace only, unreadable)     *
 * opens the plain form on `route`. A form already open is left alone without reading anything.                                                    *
 ***************************************************************************************************************************************************/
export async function openJot(route: string): Promise<FormOutcome | null> {
    if (formIsOpen) return null
    const timing = stopwatch()
    // Both at once: on a busy phone each call waits its turn, so two in a row cost two waits.
    const [selection, editorNote] = await Promise.all([readSelectedText(), selectedNote()])
    timing.lap("selection")
    const split = FormModel.splitSelection(selection)
    if (split.empty) return openForm(route, { timing, editorNote })
    return openForm(SELECTION_ROUTE, { title: split.title, body: split.body, selection, timing, editorNote })
}

/** openForm ****************************************************************************************************************************************
 * Opens the form and applies what the user chose. `route` names the way in ("menu" for Tools > Jot… and its shortcut, "contextMenu" for the        *
 * editor's right-click menu, "button" for the toolbar, "caller" for another plugin's { mode: 'new' }, all four the same plain form; "selection"    *
 * for highlighted text, which adds the In this note row). `presets` fill the fields: type, title, body, notebookId (passed over when it is not a   *
 * notebook). Resolves { id, opened } when a note was created, null when nothing was (Cancel, Escape, an empty Create, no notebook to create in, or *
 * a form already open).                                                                                                                            *
 ***************************************************************************************************************************************************/
export async function openForm(route: string, presets: FormPresets = {}): Promise<FormOutcome | null> {
    const created = await withFormOpen(() => runForm(route, presets || {}))
    return created ? { id: created.id, opened: created.opened } : null
}

/** openTriggerForm *********************************************************************************************************************************
 * The trigger route (brief 4.4): the form with no prefill and In this note offering Remove and Replace with a link, `trigger` printed in both. The  *
 * answer is the content script's to apply: { action: 'remove' }, { action: 'link', link } (the link to the new note, as the selection route builds *
 * it), or { action: 'cancel' } when nothing was created - Cancel, Escape, an empty Create, no notebook, or a form already open (one form at a time). *
 * Create and open adds open: the new note's id, opened by openTriggerNote once the content script has made its edit.                               *
 ***************************************************************************************************************************************************/
export async function openTriggerForm(trigger: string): Promise<TriggerAnswer> {
    const created = await withFormOpen(() => runForm(TRIGGER_ROUTE, { trigger: String(trigger || "") }))
    if (!created) return FormModel.triggerAnswer(null)
    const answer: TriggerAnswer = FormModel.triggerAnswer(created.inThisNote, created.link)
    if (created.openLater){
        triggerOpenPending = { id: created.id, target: created.openTarget }
        answer.open = created.id
    }
    if (created.laterTags.length) void writeTriggerTags(created.id, created.laterTags, !created.openLater)
    return answer
}

/** writeTriggerTags ********************************************************************************************************************************
 * The trigger route's tags, after the answer has gone: GUARD_TIMING.triggerEditMs for the content script to make its edit in the note the trigger  *
 * was typed in, then the tags, holding the selection unless the note is being opened. Never throws (it runs after the message is answered).        *
 ***************************************************************************************************************************************************/
async function writeTriggerTags(noteId: string, titles: string[], hold: boolean): Promise<void> {
    try {
        await new Promise<void>(resolve => setTimeout(resolve, guardTiming().triggerEditMs))
        await writeTags(noteId, titles, hold)
    } catch (error) {
        console.warn("Jot: could not add the tags to the new note", error)
    }
}

/** openTriggerNote *********************************************************************************************************************************
 * The second half of Create and open on the trigger route: the content script, its edit made, asks for the note to be opened. Only the note the    *
 * last trigger form created and has not opened yet is opened, and only once; anything else is refused. Resolves whether it opened.                 *
 ***************************************************************************************************************************************************/
export async function openTriggerNote(noteId: unknown): Promise<boolean> {
    const pending = triggerOpenPending
    if (typeof noteId !== "string" || !noteId || !pending || noteId !== pending.id) return false
    triggerOpenPending = null
    await openCreatedNote(noteId, pending.target)
    return true
}

/** withFormOpen ************************************************************************************************************************************
 * Runs one form at a time: a call while the form is up resolves null at once, whatever route it came from.                                         *
 ***************************************************************************************************************************************************/
async function withFormOpen<T>(work: () => Promise<T>): Promise<T | null> {
    if (formIsOpen) return null
    formIsOpen = true
    try {
        return await work()
    } finally {
        formIsOpen = false
    }
}

/** inThisNoteFor ***********************************************************************************************************************************
 * The In this note row of one open. The selection route: Replace, Keep (and Add after in the Markdown editor), starting on the selectionAction     *
 * setting, else on Replace. The trigger route: Replace with a link and Remove, labelled with the trigger, starting on triggerAction, else the link.  *
 * Every other route: no row, and nothing is read.                                                                                                  *
 ***************************************************************************************************************************************************/
async function inThisNoteFor(route: string, presets: FormPresets, settings: FormSettings): Promise<InThisNote> {
    if (route === SELECTION_ROUTE && typeof presets.selection === "string"){
        const choices: string[] = FormModel.selectionChoices(await editorIsMarkdown())
        const fallback: string = FormModel.SELECTION_DEFAULT
        const value = FormModel.inThisNoteAction(settings.selectionAction, choices, fallback)
        return { choices, labels: FormModel.SELECTION_SHORT_LABELS, titles: FormModel.SELECTION_LABELS, value, fallback, selection: presets.selection, trigger: null }
    }
    if (route === TRIGGER_ROUTE && typeof presets.trigger === "string"){
        const choices: string[] = FormModel.triggerChoices()
        const fallback: string = FormModel.TRIGGER_DEFAULT
        const value = FormModel.inThisNoteAction(settings.triggerAction, choices, fallback)
        return {
            choices, labels: FormModel.triggerShortLabels(presets.trigger), titles: FormModel.triggerLabels(presets.trigger), value, fallback,
            selection: null, trigger: presets.trigger,
        }
    }
    return { choices: [], labels: {}, titles: {}, value: "", fallback: "", selection: null, trigger: null }
}

async function runForm(route: string, presets: FormPresets): Promise<Created | null> {
    // Everything the form shows, read at once (the pages of a long list are still read one after the other).
    // Issue 6: a note from text in a note (highlighted text, the typed trigger) and a quick note (nothing highlighted, or another plugin's call) start
    // differently - each has its own notebook setting, and the tags and the back link say for which.
    //
    // QUICK TO OPEN. On a phone every call to Joplin is a round trip, and during or just after a sync each one waits for Joplin (measured: a settings
    // read 2.9 to 12.5 s), so the open makes as few as it can before the form shows: the settings from memory (getFormSettings, read once, again
    // after a change), the notebook and tag lists from the cache (formLists; read again in the background once the form closes), the dialog built at
    // startup (warmUp), and the current note read together with the selection at the tap (openJot).
    const timing = presets.timing || stopwatch()
    const fromText = route === SELECTION_ROUTE || route === TRIGGER_ROUTE
    const editorNoteRead = route === CALLER_ROUTE ? Promise.resolve(undefined)
        : presets.editorNote !== undefined ? Promise.resolve(presets.editorNote) : selectedNote()
    const [settings, mobile, editorNote] = await Promise.all([getFormSettings(), isMobile(), editorNoteRead])
    timing.lap("settings")
    const settingNotebookId = fromText ? settings.textNotebookId : settings.quickNotebookId
    const lists = await formLists([settingNotebookId, editorNote && editorNote.parent_id, presets.notebookId])
    timing.lap("lists")
    const folders = lists.folders
    const tagList = lists.tags
    const row = await inThisNoteFor(route, presets, settings)
    const defaultType = settings.defaultType
    const dayStartSetting = settings.dayStartTime
    const tagsFrom = settings.tagsFrom
    const backlinkSettings = settings.backlink
    const openDefault = settings.openAfterCreate
    const notebooks: FormNotebook[] = FormModel.buildNotebookPaths(folders)
    if (!notebooks.length){
        await joplin.views.dialogs.showMessageBox(FormModel.NO_NOTEBOOK_MESSAGE)
        return null
    }
    const tagTitles = tagList.map(tag => tag.title).filter(title => !!title).sort()
    const resolvedType = FormModel.normalizeType(presets.type, defaultType)
    const dayStart = FormModel.dayStartText(dayStartSetting)
    // The note the user is in (not on the caller's route: another plugin's panel has no such note): its tags fill the Tags when the setting says,
    // and the back link points to it.
    const parent = route !== CALLER_ROUTE && editorNote && editorNote.id ? editorNote : null
    const parentTags = parent && FormModel.appliesFor(tagsFrom, fromText) ? await readNoteTagsCsv(parent.id) : ""
    const backlinkLine = parent ? FormModel.backlinkText(backlinkSettings.template, parent, folders) : ""
    const backlink = backlinkLine ? { text: backlinkLine, position: backlinkSettings.position, on: FormModel.appliesFor(backlinkSettings.for, fromText) } : null
    const notebookId = await currentNotebookId(notebooks, presets.notebookId, settingNotebookId, editorNote)
    const inThisNoteChoices = row.choices
    const open = FormModel.openChoice(openDefault, mobile)

    let values: FormValues = {
        type: resolvedType,
        title: presets.title || "",
        body: presets.body || "",
        notebookId: notebookId,
        tags: parentTags,
        dueDate: "",
        dueTime: "",
        inThisNote: row.value,
        backlink: backlink ? (backlink.on ? FormModel.BACKLINK_ADD : FormModel.BACKLINK_NONE) : "",
        open: open,
    }
    let pickerOpen = false
    timing.lap("form")
    const handle = await getDialog(CREATE_DIALOG)
    timing.lap("dialog")

    try {
        for (;;){
            await joplin.views.dialogs.setHtml(handle, buildFormHtml({
                notebooks, tags: tagTitles, values, dayStart, mobile, pickerOpen, inThisNoteChoices, inThisNoteLabels: row.labels, inThisNoteTitles: row.titles,
                inThisNoteDefault: row.fallback, backlinkText: backlinkLine,
                timing: SHOW_OPEN_TIMINGS ? { start: timing.start, parts: timing.parts, htmlAt: Date.now() } : null,
            }))
            const result = await joplin.views.dialogs.open(handle)
            const plan = FormModel.planCreate(result, {
                defaultType: resolvedType, dayStart, notebookId, inThisNoteChoices, inThisNoteDefault: row.fallback, mobile, openDefault: open, backlink,
            })
            if (plan.kind === "none" || plan.kind === "nothing") return null
            if (plan.kind === "invalidDue"){
                // Refused: say why, then show the form again with everything as typed and the picker unfolded on the value that was refused.
                await joplin.views.dialogs.showMessageBox(FormModel.DUE_MESSAGE)
                values = plan.values
                pickerOpen = true
                continue
            }
            return await createNote(plan, row)
        }
    } finally {
        // The lists for the next open, read now that this one is over (a notebook or tag made meanwhile shows from the next open).
        void refreshLists()
    }
}

/** refreshNotebookSetting **************************************************************************************************************************
 * Registers the notebook setting's options from the notebooks that exist (settings.ts, registerNotebookChoices). Run at startup; the form does the  *
 * same each time it reads the notebooks. Never throws.                                                                                             *
 ***************************************************************************************************************************************************/
export async function refreshNotebookSetting(): Promise<void> {
    await refreshLists()
}

/** The notebook and tag lists: a cache ****************************************************************************************************************
 * The form shows every notebook and every tag, which on a phone took a round trip per hundred before it could open. They are read at startup and   *
 * again after every form, and the form opens on what was read last (formLists). A list read is also when the notebook settings' dropdowns are       *
 * registered again. A notebook the form must start on that the cache does not hold (made since the last read: the note you are in may live there)  *
 * makes the form read the lists first, so it never starts on the wrong notebook; so does a cache with no notebook at all, so the form never says   *
 * there is none when one was made since. Tags typed that are not in the cache are still created on Create,                                         *
 * which reads the tags afresh (attachTags).                                                                                                         *
 ***************************************************************************************************************************************************/
var listCache: { folders: any[], tags: any[] } | null = null
var listRead: Promise<void> | null = null

export function refreshLists(): Promise<void> {
    if (!listRead){
        listRead = (async () => {
            try {
                const [folders, tags] = await Promise.all([getAllFolders(), getAllTags()])
                listCache = { folders, tags }
                await registerNotebookChoices(FormModel.buildNotebookPaths(folders))
            } catch (error) {
                console.warn("Jot: could not read the notebooks and tags", error)
            } finally {
                listRead = null
            }
        })()
    }
    return listRead
}

async function formLists(needed: unknown[] = []): Promise<{ folders: any[], tags: any[] }> {
    const held = (id: unknown) => !id || !listCache || listCache.folders.some(folder => folder && folder.id === id)
    // No cache, a cache with no notebook at all (read before the first one was made: the form would say there is none), or one without a notebook
    // the form must start on: read first.
    if (!listCache || !listCache.folders.length || !needed.every(held)) await refreshLists()
    return listCache || { folders: [], tags: [] }
}

/** warmUp ******************************************************************************************************************************************
 * Run once the plugin has started, never in its way: setting changes followed, the settings and the lists read, and the create form's dialog      *
 * built, so the first open costs none of it. Never throws.                                                                                         *
 ***************************************************************************************************************************************************/
export async function warmUp(): Promise<void> {
    await watchSettings()
    try {
        await getFormSettings()
    } catch (error) {
        console.warn("Jot: could not read the settings ahead of the form", error)
    }
    await refreshLists()
    try {
        await getDialog(CREATE_DIALOG)
    } catch (error) {
        console.warn("Jot: could not prepare the form", error)
    }
}

/** readNoteTagsCsv *********************************************************************************************************************************
 * The tags of a note as the Tags field starts with them: titles, sorted, each followed by a comma and a space, so the next tag is typed straight     *
 * after them (parseTagCsv drops the empty last one). "" when the note has none or they cannot be read (a console warning).                        *
 ***************************************************************************************************************************************************/
async function readNoteTagsCsv(noteId: string): Promise<string> {
    try {
        const tags = await getAllPages(["notes", noteId, "tags"], ["id", "title"])
        return tags.map(tag => String(tag.title || "")).filter(title => !!title).sort().map(title => title + ", ").join("")
    } catch (error) {
        console.warn("Jot: could not read the tags of the note you are in", error)
        return ""
    }
}

/** currentNotebookId *******************************************************************************************************************************
 * The notebook the form starts on, in formModel.defaultNotebookId's order: the caller's, else the notebook setting's (an inbox catches another     *
 * plugin's notes too, when it names no notebook), else the notebook of the note the editor holds, else the notebook the app is showing, else the   *
 * first by path. The editor's note and the shown notebook are asked only when nothing before them gave a usable one.                              *
 ***************************************************************************************************************************************************/
async function currentNotebookId(notebooks: FormNotebook[], callerNotebookId?: string, settingNotebookId?: string, editorNote?: any): Promise<string> {
    const known = (id: any) => !!id && notebooks.some(item => item.id === id)
    const settled = known(callerNotebookId) || known(settingNotebookId)
    // The caller's route has not read the editor's note (it has no note to link back to): it is read here, and only when it decides.
    const note = settled ? null : (editorNote === undefined ? await selectedNote() : editorNote)
    const candidates: any = {
        callerNotebookId: callerNotebookId || null,
        settingNotebookId: settingNotebookId || null,
        editorNote: note || null,
        shownFolder: null,
    }
    if (!known(callerNotebookId) && !known(settingNotebookId) && !known(candidates.editorNote && candidates.editorNote.parent_id)){
        candidates.shownFolder = await selectedFolder()
    }
    return FormModel.defaultNotebookId(notebooks, candidates)
}

async function selectedNote(): Promise<any> {
    try {
        return await joplin.workspace.selectedNote()
    } catch (error) {
        console.warn("Jot: could not read the note the editor holds", error)
        return null
    }
}

async function selectedFolder(): Promise<any> {
    try {
        return await joplin.workspace.selectedFolder()
    } catch (error) {
        console.warn("Jot: could not read the notebook the app is showing", error)
        return null
    }
}

/** createNote **************************************************************************************************************************************
 * Executes a 'create' plan: POST notes with the payload formModel built, then the In this note choice, then the tags, and last the open when the  *
 * plan asks for one. The selection route makes its edit first (the link to the new note under its final title), while the editor surely holds the *
 * note the form was opened from: the tags can make Joplin select another note (the selection guard gives it back, but an edit made in between would *
 * land in the wrong note), and opening switches the editor for good. The trigger route makes no edit here: its edit is the content script's,         *
 * made from the answer, so its tags (laterTags) and, on Create and open, the open wait for the content script too (writeTriggerTags, openLater).     *
 ***************************************************************************************************************************************************/
async function createNote(plan: any, row: InThisNote): Promise<Created> {
    const note = await joplin.data.post(["notes"], null, plan.note)
    const link: string = FormModel.noteLink(plan.note.title, note.id)
    if (plan.inThisNote && row.selection !== null){
        await applySelectionEdit(FormModel.selectionEdit(plan.inThisNote, row.selection, link))
    }
    const openTarget: string = plan.open || ""
    const openLater = !!openTarget && row.trigger !== null
    const laterTags: string[] = row.trigger !== null ? plan.tags : []
    if (plan.tags.length && row.trigger === null) await writeTags(note.id, plan.tags, !openTarget)
    if (openTarget && !openLater) await openCreatedNote(note.id, openTarget)
    return { id: note.id, opened: !!openTarget, openTarget, inThisNote: plan.inThisNote || null, link, openLater, laterTags }
}

/** writeTags ***************************************************************************************************************************************
 * attachTags, bracketed by the selection guard when `hold` (the note is not about to be opened): writing a tag can make Joplin select another note. *
 ***************************************************************************************************************************************************/
async function writeTags(noteId: string, titles: string[], hold: boolean): Promise<number> {
    const held = hold ? await holdSelection() : null
    const attached = await attachTags(noteId, titles)
    await keepSelection(held)
    return attached
}

/** attachTags **************************************************************************************************************************************
 * Attaches the tag titles (formModel.tagKey: trimmed, NFC, lower-cased; de-duplicated) to the new note: an existing tag is reused by its tagKey, as *
 * Joplin's own Tag.loadByTitle matches, a missing one is created (POST tags), and each is attached (POST tags/:id/notes). The tag list is read again *
 * here rather than taken from the open, so a tag made meanwhile (another device's sync, another plugin) is reused rather than duplicated.          *
 *                                                                                                                                                  *
 * NEVER THROWS. The note exists by now, and what follows it (the In this note edit, the open) must still run: a list that cannot be read is a       *
 * console warning (every tag is then created, or refused by Joplin as a duplicate), and a tag that cannot be created or attached is a console       *
 * warning and the next tag is tried. Resolves how many were attached (edit mode reports tags as changed only when one was). Edit mode's Save       *
 * attaches through here too, the note being an existing one.                                                                                       *
 ***************************************************************************************************************************************************/
async function attachTags(noteId: string, titles: string[]): Promise<number> {
    let attached = 0
    const existing = new Map<string, string>()
    try {
        for (const tag of await getAllTags()){
            const key: string = FormModel.tagKey(tag.title)
            if (key && !existing.has(key)) existing.set(key, tag.id)
        }
    } catch (error) {
        console.warn("Jot: could not read the tags; the note is created and its tags are tried one by one", error)
    }
    for (const title of titles){
        try {
            let tagId = existing.get(FormModel.tagKey(title))
            if (!tagId){
                const created = await joplin.data.post(["tags"], null, { title })
                tagId = created.id
                existing.set(FormModel.tagKey(title), tagId)
            }
            await joplin.data.post(["tags", tagId, "notes"], null, { id: noteId })
            attached++
        } catch (error) {
            console.warn(`Jot: could not add the tag "${title}"; the note is created without it`, error)
        }
    }
    return attached
}

/** openCreatedNote *********************************************************************************************************************************
 * The Open row's choice: the note opens in the editor, or in a new window. A new window is a desktop command (openNoteInNewWindow, absent in older  *
 * apps and on mobile); when it is not there, or throws, the note opens in the editor instead, with a console warning and no message.               *
 ***************************************************************************************************************************************************/
async function openCreatedNote(noteId: string, target: string): Promise<void> {
    if (target === OPEN_IN_WINDOW && !(await isMobile())){
        try {
            await joplin.commands.execute("openNoteInNewWindow", noteId)
            return
        } catch (error) {
            console.warn("Jot: could not open the note in a new window, opening it in the editor instead", error)
        }
    }
    await joplin.commands.execute("openNote", noteId)
}

/** openEditFromCommand *****************************************************************************************************************************
 * What jot.edit ("Edit with Jot…", the note list's right-click menu) runs. The menu passes the selected notes' ids (api/types.ts, noteIds:         *
 * string[]); the first is edited and the rest ignored. Run with no argument (the command palette), it edits the note the editor holds.             *
 ***************************************************************************************************************************************************/
export async function openEditFromCommand(noteIds?: unknown): Promise<EditOutcome | null> {
    let noteId: string = FormModel.noteIdFrom(noteIds)
    if (!noteId && !formIsOpen){
        const note = await selectedNote()
        noteId = FormModel.noteIdFrom(note && note.id)
    }
    return openEditForm(noteId)
}

/** openEditForm ************************************************************************************************************************************
 * Edit mode on one note (brief 4.5): resolves { id, changed } after Save (changed empty when nothing was), null on Cancel or Escape, when the note *
 * cannot be read (with "Jot: this note no longer exists."), when no note id was given (a console warning), or while a form is already up.          *
 ***************************************************************************************************************************************************/
export async function openEditForm(noteId: unknown): Promise<EditOutcome | null> {
    const id: string = FormModel.noteIdFrom(noteId)
    if (!id){
        console.warn("Jot: edit mode was asked for without a note id; nothing to edit")
        return null
    }
    return withFormOpen(() => runEdit(id))
}

async function runEdit(noteId: string): Promise<EditOutcome | null> {
    const loaded = await readNoteToEdit(noteId)
    if (!loaded){
        await joplin.views.dialogs.showMessageBox(FormModel.NO_NOTE_MESSAGE)
        return null
    }
    const [lists, dayStartSetting, mobile] = await Promise.all([formLists([loaded.note.parent_id]), getDayStartTime(), isMobile()])
    const folders = lists.folders
    const tagList = lists.tags
    const notebooks: FormNotebook[] = FormModel.buildNotebookPaths(folders)
    const tagTitles = tagList.map(tag => tag.title).filter(title => !!title).sort()
    const dayStart = FormModel.dayStartText(dayStartSetting)
    const start = FormModel.editStart(loaded.note, loaded.tags)

    let values: FormValues = {
        type: start.type,
        title: start.title,
        body: "",
        notebookId: start.notebookId,
        tags: start.tags,
        dueDate: start.dueDate,
        dueTime: start.dueTime,
        inThisNote: "",
    }
    let pickerOpen = false
    const handle = await getDialog(EDIT_DIALOG)

    for (;;){
        await joplin.views.dialogs.setHtml(handle, buildFormHtml({ mode: FormModel.EDIT_MODE, notebooks, tags: tagTitles, values, dayStart, mobile, pickerOpen }))
        const result = await joplin.views.dialogs.open(handle)
        const plan = FormModel.planEdit(result, start, { dayStart })
        if (plan.kind === "none") return null
        if (plan.kind === "invalidDue"){
            // Refused as Create is: say why, then show the form again as typed, the picker unfolded on the value that was refused.
            await joplin.views.dialogs.showMessageBox(FormModel.DUE_MESSAGE)
            values = plan.values
            pickerOpen = true
            continue
        }
        return await saveEdit(noteId, plan)
    }
}

/** readNoteToEdit **********************************************************************************************************************************
 * The note's fields edit mode shows (EDIT_NOTE_FIELDS) and its tags, or null when the note cannot be read: a GET that throws (Joplin answers a     *
 * missing note with a not-found error) or answers nothing, or a tag list that cannot be read (most likely the note went in between), since a form  *
 * that showed no tags would show the note wrongly. A throw is a console warning.                                                                   *
 ***************************************************************************************************************************************************/
async function readNoteToEdit(noteId: string): Promise<{ note: any, tags: any[] } | null> {
    try {
        const note = await joplin.data.get(["notes", noteId], { fields: EDIT_NOTE_FIELDS })
        if (!note || !note.id) return null
        const tags = await getAllPages(["notes", noteId, "tags"], ["id", "title"])
        return { note, tags }
    } catch (error) {
        console.warn(`Jot: could not read the note ${noteId} to edit it`, error)
        return null
    }
}

/** saveEdit ****************************************************************************************************************************************
 * Executes a 'save' plan: the one PUT notes/:id when a note field changed, then the tag diff - attached as on Create (attachTags: reused by        *
 * tagKey, created when missing), detached with DELETE tags/:id/notes/:noteId. A PUT that throws rejects the command, before any tag call; once it  *
 * is done, no tag call throws. "tags" is reported as changed only when a tag call went through. A Save that moves the note to another notebook or   *
 * changes its tags is bracketed by the selection guard.                                                                                           *
 ***************************************************************************************************************************************************/
async function saveEdit(noteId: string, plan: any): Promise<EditOutcome> {
    // A tag change, or a note moved to another notebook, can make Joplin select another note (selectionGuard.ts): held around the whole Save.
    const movesSelection = !!(plan.put && "parent_id" in plan.put) || plan.attach.length > 0 || plan.detach.length > 0
    const held = movesSelection ? await holdSelection() : null
    if (plan.put) await joplin.data.put(["notes", noteId], null, plan.put)
    let tagCalls = 0
    if (plan.attach.length) tagCalls += await attachTags(noteId, plan.attach)
    if (plan.detach.length) tagCalls += await detachTags(noteId, plan.detach)
    await keepSelection(held)
    const changed: string[] = plan.changed.filter((field: string) => field !== "tags" || tagCalls > 0)
    return { id: noteId, changed }
}

/** detachTags **************************************************************************************************************************************
 * Removes each tag ({ id, title }, the ids the note had) from the note. NEVER THROWS, as attachTags: a tag that cannot be removed is a console     *
 * warning and the next one is tried. Resolves how many were removed.                                                                               *
 ***************************************************************************************************************************************************/
async function detachTags(noteId: string, tags: { id: string, title: string }[]): Promise<number> {
    let detached = 0
    for (const tag of tags){
        try {
            await joplin.data.delete(["tags", tag.id, "notes", noteId])
            detached++
        } catch (error) {
            console.warn(`Jot: could not remove the tag "${tag.title}"; the note keeps it`, error)
        }
    }
    return detached
}

/** getAllFolders / getAllTags / getAllPages ********************************************************************************************************
 * Every notebook ({ id, title, parent_id }), every tag ({ id, title }), and any other list (a note's tags), walked page by page (the data API      *
 * pages its lists). The API leaves the trash out of the notebooks and the tags.                                                                    *
 ***************************************************************************************************************************************************/
async function getAllFolders(): Promise<any[]> {
    return getAllPages(["folders"], ["id", "title", "parent_id"])
}

async function getAllTags(): Promise<any[]> {
    return getAllPages(["tags"], ["id", "title"])
}

async function getAllPages(path: string[], fields: string[]): Promise<any[]> {
    const items: any[] = []
    let page = 1
    let response: any
    do {
        response = await joplin.data.get(path, { fields, page: page++, limit: PAGE_LIMIT })
        items.push(...((response && response.items) || []))
    } while (response && response.has_more)
    return items
}
