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
 * Cancel. The create form's is built at the plugin's start (warmUp), edit mode's on its first open; each build is the create, then the scripts and *
 * the buttons sent together (applied in the order sent: one wait instead of six), and a failed build is not remembered, so the next open tries     *
 * again (the handle is kept: a second create of the same id throws). The stylesheet is not one of the scripts: it travels in the markup            *
 * (formHtml.ts). The markup is set on every open, sent with the open itself rather than awaited before it (Joplin applies the two in the order     *
 * sent). Each open is a fresh page on both platforms (3.7), where the scripts wire the form (formWebview.js). One form at a time, whichever the mode. *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in one expression.                                                              *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from "api"
import { buildFormHtml, FormNotebook, FormValues } from "./formHtml"
import { FormSettings, getFormSettings, OPEN_IN_WINDOW, registerNotebookChoices, settingsRegistered, StoredLists, storeLists } from "../core/settings"
import { SHOW_OPEN_TIMINGS, Stopwatch, stopwatch } from "../core/timing"
import { formWidthOnMobile, isMobile, screenWidthSeen } from "../core/platform"
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
// What the form uses of the note the editor holds (its notebook, the back link, its tags): never the body.
const EDITOR_NOTE_FIELDS = ["id", "title", "is_todo", "parent_id"]
// Loaded into the dialog in this order, though they run in the order they finish loading (hence the call-time globals in formWebview.js). The
// stylesheet is not here: it is part of the markup (formHtml.ts, FORM_CSS).
export const FORM_SCRIPTS = [
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
// Each dialog handle's build, by dialog id, once started; and each handle once created, kept through a failed build (create is not repeated).
var dialogPromises: { [id: string]: Promise<string> } = {}
var dialogHandles: { [id: string]: string } = {}
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
    if (!dialogHandles[spec.id]) dialogHandles[spec.id] = await joplin.views.dialogs.create(spec.id)
    const handle = dialogHandles[spec.id]
    // The scripts and the buttons together: Joplin applies each as it arrives, in the order sent, so the scripts keep their order.
    await Promise.all([
        ...FORM_SCRIPTS.map(script => joplin.views.dialogs.addScript(handle, script)),
        joplin.views.dialogs.setButtons(handle, spec.buttons),
    ])
    return handle
}

/** showDialog **************************************************************************************************************************************
 * Sets the markup and opens the dialog, resolving what open resolves. The markup is not awaited before the open: both are applied by Joplin in the  *
 * order they are sent (each is one store update made the moment it arrives, mobile 3.7.8 and desktop alike), and on a busy phone the wait saved is *
 * one round trip, measured at up to a second. A refused setHtml is a console warning (open is refused alike, being the same dialog).               *
 ***************************************************************************************************************************************************/
async function showDialog(handle: string, html: string): Promise<any> {
    const htmlSet = joplin.views.dialogs.setHtml(handle, html)
    htmlSet.catch(error => console.warn("Jot: could not write the form", error))
    return joplin.views.dialogs.open(handle)
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
    // Both at once: on a busy phone each call waits its turn, so two in a row cost two waits. The note is usually known already (noteAtTap).
    const [selection, editorNote] = await Promise.all([readSelectedText(), noteAtTap(timing)])
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
    // read 2.9 to 12.5 s), so the open makes as few as it can before the form shows, and sends together the ones it needs: the settings from memory
    // (getFormSettings, read once at the start, again after a change), the notebook and tag lists from the cache (formLists: read at the start, kept
    // across restarts, read again after a sync and a while after a form), the dialog built at the start (warmUp), the note the editor holds from the
    // record kept of it (noteAtTap), and its tags and the editor's kind read together.
    const timing = presets.timing || stopwatch()
    const fromText = route === SELECTION_ROUTE || route === TRIGGER_ROUTE
    const editorNoteRead = route === CALLER_ROUTE ? Promise.resolve(undefined)
        : presets.editorNote !== undefined ? Promise.resolve(presets.editorNote) : noteAtTap(timing)
    const [settings, mobile, editorNote] = await Promise.all([getFormSettings(), isMobile(), editorNoteRead])
    timing.lap("settings")
    const settingNotebookId = fromText ? settings.textNotebookId : settings.quickNotebookId
    const tagsFrom = settings.tagsFrom
    // The note the user is in (not on the caller's route: another plugin's panel has no such note): its tags fill the Tags when the setting says,
    // and the back link points to it. Its tags are read alongside the lists and the In this note row.
    const parent = route !== CALLER_ROUTE && editorNote && editorNote.id ? editorNote : null
    const parentTagsRead = parent && FormModel.appliesFor(tagsFrom, fromText) ? readNoteTagsCsv(parent.id) : Promise.resolve("")
    const [startLists, row, parentTags] = await Promise.all([
        formLists([settingNotebookId, editorNote && editorNote.parent_id, presets.notebookId]),
        inThisNoteFor(route, presets, settings),
        parentTagsRead,
    ])
    timing.lap("lists")
    const backlinkSettings = settings.backlink
    const openDefault = settings.openAfterCreate
    // What the form makes of the lists: the notebooks by path, the tag titles, the notebook it starts on and the back link (which names the note's
    // notebook). Made again from fresh lists when the notebook picked turns out to be gone (below).
    const fromLists = async (lists: FormLists) => {
        const notebooks: FormNotebook[] = FormModel.buildNotebookPaths(lists.folders)
        const tagTitles: string[] = lists.tags.map(tag => tag.title).filter(title => !!title).sort()
        const notebookId = notebooks.length ? await currentNotebookId(notebooks, presets.notebookId, settingNotebookId, editorNote) : ""
        const backlinkLine: string = parent ? FormModel.backlinkText(backlinkSettings.template, parent, lists.folders) : ""
        const backlink = backlinkLine ? { text: backlinkLine, position: backlinkSettings.position, on: FormModel.appliesFor(backlinkSettings.for, fromText) } : null
        return { lists, notebooks, tagTitles, notebookId, backlinkLine, backlink }
    }
    let shown = await fromLists(startLists)
    if (!shown.notebooks.length){
        await joplin.views.dialogs.showMessageBox(FormModel.NO_NOTEBOOK_MESSAGE)
        return null
    }
    const resolvedType = FormModel.normalizeType(presets.type, settings.defaultType)
    const dayStart = FormModel.dayStartText(settings.dayStartTime)
    const inThisNoteChoices = row.choices
    const open = FormModel.openChoice(openDefault, mobile)
    const mobileWidth = mobile ? formWidthOnMobile() : null

    let values: FormValues = {
        type: resolvedType,
        title: presets.title || "",
        body: presets.body || "",
        notebookId: shown.notebookId,
        tags: parentTags,
        dueDate: "",
        dueTime: "",
        inThisNote: row.value,
        backlink: shown.backlink ? (shown.backlink.on ? FormModel.BACKLINK_ADD : FormModel.BACKLINK_NONE) : "",
        open: open,
    }
    let pickerOpen = false
    timing.lap("form")
    const handle = await getDialog(CREATE_DIALOG)
    timing.lap("dialog")

    try {
        for (;;){
            const result = await showDialog(handle, buildFormHtml({
                notebooks: shown.notebooks, tags: shown.tagTitles, values, dayStart, mobile, mobileWidth, pickerOpen, inThisNoteChoices,
                inThisNoteLabels: row.labels, inThisNoteTitles: row.titles, inThisNoteDefault: row.fallback, backlinkText: shown.backlinkLine,
                timing: SHOW_OPEN_TIMINGS ? { start: timing.start, parts: timing.parts, htmlAt: Date.now(), screen: screenWidthSeen() } : null,
            }))
            const plan = FormModel.planCreate(result, {
                defaultType: resolvedType, dayStart, notebookId: shown.notebookId, inThisNoteChoices, inThisNoteDefault: row.fallback, mobile,
                openDefault: open, backlink: shown.backlink,
            })
            if (plan.kind === "none" || plan.kind === "nothing") return null
            if (plan.kind === "invalidDue"){
                // Refused: say why, then show the form again with everything as typed and the picker unfolded on the value that was refused.
                await joplin.views.dialogs.showMessageBox(FormModel.DUE_MESSAGE)
                values = plan.values
                pickerOpen = true
                continue
            }
            const fresh = await notebookGone(shown.lists, plan.note.parent_id)
            if (fresh){
                // Picked from the lists kept from the last start, and gone since (deleted on another device): say so, and show the form again as
                // typed, its notebooks read afresh and the notebook it starts on chosen again.
                await joplin.views.dialogs.showMessageBox(FormModel.NOTEBOOK_GONE_MESSAGE)
                shown = await fromLists(fresh)
                if (!shown.notebooks.length){
                    await joplin.views.dialogs.showMessageBox(FormModel.NO_NOTEBOOK_MESSAGE)
                    return null
                }
                values = { ...plan.values, notebookId: shown.notebookId }
                pickerOpen = false
                continue
            }
            return await createNote(plan, row)
        }
    } finally {
        // The lists for the next open, read a while after this one is over (a notebook or tag made meanwhile shows from the next open), not at once:
        // a second form opened right away would wait behind the read.
        scheduleListRefresh()
    }
}

/** The notebook and tag lists: a cache ****************************************************************************************************************
 * The form shows every notebook and every tag, which on a phone took a round trip per hundred before it could open (12 s during a sync). So the    *
 * form opens on what was read last (formLists), and the lists are read when the plugin starts (warmUp), after every sync, and a while after every  *
 * form (scheduleListRefresh: not at once, or a second form opened right away would wait behind the read). The first form after a start, before    *
 * that read is back, opens on the lists stored at the last read (adoptStoredLists; settings.ts, the stored lists). A notebook the form must start  *
 * on that the cache does not hold (made since the last read: the note you are in may live there) makes the form read the lists first, so it never  *
 * starts on the wrong notebook; so does a cache with no notebook at all, so the form never says there is none when one was made since. A notebook   *
 * picked from stored lists is checked against the first fresh read before anything is created in it (notebookGone). Tags typed that are not in the *
 * cache are still created on Create, which reads the tags afresh (attachTags), and those Jot creates join the cache at once (rememberTag).         *
 *                                                                                                                                                  *
 * What a read changes besides the cache - the notebook settings' dropdowns (registerNotebookChoices) and the stored copy (storeLists) - follows it  *
 * in the background, one read after the other, and only once Jot's settings are registered (an earlier registration would be wiped by theirs); the *
 * form waits for neither.                                                                                                                          *
 ***************************************************************************************************************************************************/
interface FormLists {
    folders: any[]
    tags: any[]
    // Read in this run of the plugin (true), or stored from the last one (false).
    fresh: boolean
}

var listCache: FormLists | null = null
var listRead: Promise<void> | null = null
var listReadAfter: Promise<void> | null = null
var listFollowUps: Promise<void> = Promise.resolve()

// `readAfterNow`: the caller needs a read begun after this moment (a sync has just ended: a read already out may have taken its pages before the
// sync wrote them), so one more read follows the one in flight. Anyone else joins the read in flight.
export function refreshLists(readAfterNow = false): Promise<void> {
    if (listRead && readAfterNow){
        if (!listReadAfter) listReadAfter = listRead.then(() => { listReadAfter = null; return refreshLists() })
        return listReadAfter
    }
    if (!listRead){
        listRead = (async () => {
            try {
                const [folders, tags] = await Promise.all([getAllFolders(), getAllTags()])
                listCache = { folders, tags, fresh: true }
                followListRead(folders, tags, true)
            } catch (error) {
                console.warn("Jot: could not read the notebooks and tags", error)
            } finally {
                listRead = null
            }
        })()
    }
    return listRead
}

// The dropdowns and, after a fresh read, the stored copy: one read's follow-ups after the last one's, never throwing.
function followListRead(folders: any[], tags: any[], store: boolean): void {
    listFollowUps = listFollowUps.then(async () => {
        await settingsRegistered()
        await registerNotebookChoices(FormModel.buildNotebookPaths(folders))
        if (store) await storeLists(folders, tags)
    }).catch(error => console.warn("Jot: could not update the notebook settings from the lists", error))
}

/** adoptStoredLists ********************************************************************************************************************************
 * The lists stored at the last read (setupSettings' startup read), taken as the cache when no fresh read has come back yet. They fill the notebook *
 * settings' dropdowns too, until the fresh read replaces them.                                                                                     *
 ***************************************************************************************************************************************************/
export function adoptStoredLists(stored: StoredLists | null): void {
    if (!stored || listCache) return
    listCache = { folders: stored.folders, tags: stored.tags, fresh: false }
    followListRead(stored.folders, stored.tags, false)
}

async function formLists(needed: unknown[] = []): Promise<FormLists> {
    const held = (id: unknown) => !id || !listCache || listCache.folders.some(folder => folder && folder.id === id)
    // No cache, a cache with no notebook at all (read before the first one was made: the form would say there is none), or one without a notebook
    // the form must start on: read first.
    if (!listCache || !listCache.folders.length || !needed.every(held)) await refreshLists()
    return listCache || { folders: [], tags: [], fresh: false }
}

/** notebookGone ************************************************************************************************************************************
 * For a form shown from stored lists: the lists to show the form again with when the notebook picked is gone since the last start (deleted on     *
 * another device, or in the trash), else null - also when the lists shown were fresh, or no notebook was picked. The fresh lists decide when they  *
 * are back; until then ONE read of that notebook does, not the whole read of the lists: the dialog has closed by now, and the note and the edit to *
 * the highlighted text wait on this. A notebook that cannot be told gone (any error but not-found) is taken as there, as before lists were stored. *
 ***************************************************************************************************************************************************/
async function notebookGone(shown: FormLists, notebookId: unknown): Promise<FormLists | null> {
    if (shown.fresh || typeof notebookId !== "string" || !notebookId) return null
    const held = (lists: FormLists) => lists.folders.some(folder => folder && folder.id === notebookId)
    if (listCache && listCache.fresh) return held(listCache) ? null : listCache
    if (await notebookExists(notebookId)) return null
    // Gone: the form opens again, on the fresh lists when they can be had, else on the stored ones without that notebook.
    await refreshLists()
    if (listCache && listCache.fresh) return listCache
    return { ...shown, folders: shown.folders.filter(folder => folder && folder.id !== notebookId) }
}

async function notebookExists(id: string): Promise<boolean> {
    try {
        const folder = await joplin.data.get(["folders", id], { fields: ["id", "deleted_time"] })
        return !!folder && folder.id === id && !folder.deleted_time
    } catch (error) {
        if (/not\s*found/i.test(String((error && (error as any).message) || error))) return false
        console.warn(`Jot: could not check the notebook ${id}; creating in it`, error)
        return true
    }
}

/** The background clock *****************************************************************************************************************************
 * How long after a form closes the lists are read again (afterFormMs), and how long after a selection change (selectionMs) and after a change to  *
 * the note, saved as it is typed (changeMs), the note the editor holds is read: a pause, not every keystroke. The harness shortens them           *
 * (globalThis.__jotBackgroundTiming), as it does the selection guard's.                                                                            *
 ***************************************************************************************************************************************************/
const BACKGROUND_TIMING = { afterFormMs: 4000, selectionMs: 300, changeMs: 1000 }

function backgroundTiming(): typeof BACKGROUND_TIMING {
    const override = (globalThis as any).__jotBackgroundTiming
    return override && typeof override === "object" ? { ...BACKGROUND_TIMING, ...override } : BACKGROUND_TIMING
}

/** scheduleListRefresh *****************************************************************************************************************************
 * The lists read again a while after a form closes (afterFormMs), the timer restarted by every form; while a form is up (another create form, or  *
 * edit mode's) it waits again rather than compete with that form's own calls.                                                                      *
 ***************************************************************************************************************************************************/
var listRefreshTimer: any = null

function scheduleListRefresh(): void {
    if (listRefreshTimer) clearTimeout(listRefreshTimer)
    listRefreshTimer = setTimeout(() => {
        listRefreshTimer = null
        if (formIsOpen) scheduleListRefresh()
        else void refreshLists()
    }, backgroundTiming().afterFormMs)
}

// A tag Jot has just created joins the cached list, so the next form suggests it before the lists are read again.
function rememberTag(tag: any): void {
    if (!listCache || !tag || !tag.title) return
    if (!listCache.tags.some(item => item && item.title === tag.title)) listCache.tags = [...listCache.tags, { id: tag.id || "", title: tag.title }]
}

/** warmUp ******************************************************************************************************************************************
 * Started first thing in onStart and never awaited, never in its way, needing nothing the start sets up: the create form's dialog built, the lists *
 * read, and the note the editor holds followed (followEditorNote), so the first open costs none of it. The settings are read by the start itself  *
 * (setupSettings). Never throws.                                                                                                                   *
 ***************************************************************************************************************************************************/
export async function warmUp(): Promise<void> {
    const dialog = getDialog(CREATE_DIALOG).catch(error => console.warn("Jot: could not prepare the form", error))
    await Promise.all([dialog, refreshLists(), followEditorNote()])
}

/** The note the editor holds: a record ************************************************************************************************************
 * Every way into the form wants the note you are in (its notebook, its tags, the back link), and asking Joplin at the tap (workspace.selectedNote) *
 * is a database read of the whole note, body and all: seconds on a phone just after a sync (the 7.33 s "selection" of 2026-10-14). So the note is  *
 * read ahead, when Joplin reports that the selection changed (onNoteSelectionChange), with the fields the form uses and never the body; a change   *
 * to the note (onNoteChange: its title, its notebook, or only its text) has it read again a moment later. A tap takes the record when it is the     *
 * one selected note's and no change has come since its read began; otherwise it reads the note then, as before. Nothing here throws: an app that    *
 * cannot report either event leaves the record off.                                                                                                *
 ***************************************************************************************************************************************************/
var editorRecord: { id: string, note: any, changesAtRead: number } | null = null
// The one selected note's id as the last event gave it ("" for none or several), the changes counted since, and the read on its way.
var editorSelectedId = ""
var editorChanges = 0
var editorRecordTimer: any = null

async function followEditorNote(): Promise<void> {
    const changesBefore = editorChanges
    try {
        await joplin.workspace.onNoteSelectionChange((event: any) => {
            const ids = event && Array.isArray(event.value) ? event.value : []
            editorSelectedId = ids.length === 1 && typeof ids[0] === "string" ? ids[0] : ""
            editorChanges++
            scheduleEditorRecord(backgroundTiming().selectionMs)
        })
        await joplin.workspace.onNoteChange(() => {
            editorChanges++
            scheduleEditorRecord(backgroundTiming().changeMs)
        })
    } catch (error) {
        console.warn("Jot: could not follow the note you are in; the form reads it when it opens", error)
        return
    }
    // The note already open when the listener came: Joplin reports a selection only when it changes after that (one previous value per property,
    // shared by every plugin that listens), so it is asked once (selectedNoteIds, no database read), as Cockpit does - unless an event came first.
    try {
        const ids = await joplin.workspace.selectedNoteIds()
        if (editorChanges !== changesBefore) return
        editorSelectedId = Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string" ? ids[0] : ""
        editorChanges++
        scheduleEditorRecord(0)
    } catch (error) {
        // Left to the first event.
    }
}

function scheduleEditorRecord(delayMs: number): void {
    if (editorRecordTimer) clearTimeout(editorRecordTimer)
    editorRecordTimer = setTimeout(() => { editorRecordTimer = null; void readEditorRecord() }, delayMs)
}

async function readEditorRecord(): Promise<void> {
    const id = editorSelectedId
    const changesAtRead = editorChanges
    if (!id){
        editorRecord = null
        return
    }
    try {
        const note = await joplin.data.get(["notes", id], { fields: EDITOR_NOTE_FIELDS })
        if (note && note.id === id) editorRecord = { id, note, changesAtRead }
    } catch (error) {
        editorRecord = null
    }
}

/** noteAtTap ***************************************************************************************************************************************
 * The note the editor holds, for an open: the record when it is current (above), else workspace.selectedNote as before. A test build notes which.    *
 ***************************************************************************************************************************************************/
async function noteAtTap(timing?: Stopwatch): Promise<any> {
    const record = editorRecord
    if (record && editorSelectedId && record.id === editorSelectedId && record.changesAtRead === editorChanges){
        if (timing) timing.parts.push(["note kept", 0])
        return record.note
    }
    const started = Date.now()
    const note = await selectedNote()
    if (timing) timing.parts.push(["note read", Date.now() - started])
    return note
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
    const note = settled ? null : (editorNote === undefined ? await noteAtTap() : editorNote)
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
                rememberTag(created)
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
    const [lists, settings, mobile] = await Promise.all([formLists([loaded.note.parent_id]), getFormSettings(), isMobile()])
    let notebooks: FormNotebook[] = FormModel.buildNotebookPaths(lists.folders)
    let tagTitles: string[] = lists.tags.map(tag => tag.title).filter(title => !!title).sort()
    let shownLists = lists
    const dayStart = FormModel.dayStartText(settings.dayStartTime)
    const start = FormModel.editStart(loaded.note, loaded.tags)
    const mobileWidth = mobile ? formWidthOnMobile() : null

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
        const result = await showDialog(handle, buildFormHtml({
            mode: FormModel.EDIT_MODE, notebooks, tags: tagTitles, values, dayStart, mobile, mobileWidth, pickerOpen,
        }))
        const plan = FormModel.planEdit(result, start, { dayStart })
        if (plan.kind === "none") return null
        if (plan.kind === "invalidDue"){
            // Refused as Create is: say why, then show the form again as typed, the picker unfolded on the value that was refused.
            await joplin.views.dialogs.showMessageBox(FormModel.DUE_MESSAGE)
            values = plan.values
            pickerOpen = true
            continue
        }
        const fresh = plan.put && plan.put.parent_id ? await notebookGone(shownLists, plan.put.parent_id) : null
        if (fresh){
            // Moved to a notebook picked from the lists kept from the last start, and gone since: say so, and show the form again as typed, its
            // notebooks read afresh and the note's own notebook in the field.
            await joplin.views.dialogs.showMessageBox(FormModel.NOTEBOOK_GONE_MESSAGE)
            shownLists = fresh
            notebooks = FormModel.buildNotebookPaths(fresh.folders)
            tagTitles = fresh.tags.map(tag => tag.title).filter(title => !!title).sort()
            values = { ...plan.values, notebookId: start.notebookId }
            pickerOpen = false
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
        // Together: on a phone each read is a round trip.
        const [note, tags] = await Promise.all([
            joplin.data.get(["notes", noteId], { fields: EDIT_NOTE_FIELDS }),
            getAllPages(["notes", noteId, "tags"], ["id", "title"]),
        ])
        if (!note || !note.id) return null
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
