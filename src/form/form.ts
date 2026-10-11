/** README ******************************************************************************************************************************************
 * The host side of Jot's form (brief 4.1 to 4.4): openForm(route, presets) gathers what the form shows, opens the dialog, and applies the answer.   *
 * Create mode only for now (phase 4 adds edit mode behind the same function).                                                                     *
 *                                                                                                                                                  *
 * THE SELECTION ROUTE. openJot(route) is what the three commands run: it reads the editor's selection first (editorSelection.ts) and, when there is  *
 * one, opens the form on the 'selection' route, prefilled from it (formModel.splitSelection), with the In this note row; with none, the route it    *
 * was given, the plain form. After a create on that route the choice is applied to the editor while it still holds the note the selection came    *
 * from - after POST notes and the tags, BEFORE anything is opened (Create and open would switch the editor to the new note, and the edit would     *
 * land there) - and remembered in lastSelectionAction for next time.                                                                               *
 *                                                                                                                                                  *
 * THE TRIGGER ROUTE. openTriggerForm(trigger) is what the typed trigger's message runs (src/trigger.ts): the plain form with no prefill, plus the In *
 * this note row with Remove ++ and Replace ++ with a link to the new note (the trigger printed), starting on lastTriggerAction. The edit is not      *
 * made here: the content script makes it in the editor, as one transaction, once it has the answer this resolves ({ action: 'remove' }, { action:  *
 * 'link', link } or { action: 'cancel' }), and the choice is remembered after the create. Create and open therefore does not open at once - the     *
 * editor would switch to the new note before the content script's edit reached the note the trigger was typed in - but puts the new note's id in    *
 * the answer (open); the content script makes its edit and then asks for the open (openTriggerNote), which opens that one id only, once.           *
 *                                                                                                                                                  *
 * Every decision is formModel.js's (planCreate and the rules under it), so this file is the I/O around it: the notebooks and tags read from the     *
 * data API, the dialog, the POST notes, the tags (reused by lower-cased title, created when missing, attached), and the open after Create and open. *
 * Create opens nothing and moves no focus: the editor keeps its note.                                                                              *
 *                                                                                                                                                  *
 * THE DIALOG. One handle, created on the first open (Harper's lazy build: a failed build is not remembered, so the next open tries again), its      *
 * scripts added and its buttons set once. The buttons are Create (id ok, which Enter in a text input resolves to), Create and open (id openAfter)    *
 * and Cancel (id cancel, which Escape resolves to). The markup is set on every open (formHtml.ts); setHtml does not re-run the scripts, which wire   *
 * each new form themselves (formWebview.js).                                                                                                       *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in one expression.                                                              *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from "api"
import { buildFormHtml, FormNotebook, FormValues } from "./formHtml"
import {
    getDayStartTime, getDefaultType, getLastSelectionAction, getLastTriggerAction, getOpenTarget, OPEN_IN_WINDOW, setLastSelectionAction, setLastTriggerAction,
} from "../core/settings"
import { isMobile } from "../core/platform"
import { applySelectionEdit, editorIsMarkdown, readSelectedText } from "./editorSelection"
const FormModel = require("./formModel")

/** Constants ***************************************************************************************************************************************/
export const FORM_DIALOG_ID = "jot.form"
// The route of a form opened from highlighted text, whichever command opened it.
export const SELECTION_ROUTE = "selection"
// The route of a form opened by the typed trigger in the Markdown editor (the content script's message).
export const TRIGGER_ROUTE = "trigger"
export const FORM_BUTTONS = [
    { id: "ok", title: "Create" },
    { id: "openAfter", title: "Create and open" },
    { id: "cancel", title: "Cancel" },
]
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
// (Add a link after it writes it back); the trigger route carries the trigger typed (printed in its In this note labels); other plugins (type,
// notebookId, title, body) come in phase 4, through the same function.
export interface FormPresets {
    type?: string
    title?: string
    body?: string
    notebookId?: string
    selection?: string
    trigger?: string
}

// What the commands resolve (brief section 6).
export interface FormOutcome {
    id: string
    opened: boolean
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
    inThisNote: string | null
    link: string
    openLater: boolean
}

// The In this note row of one open: the buttons, their labels, the starting choice, and what the route needs to apply the choice.
interface InThisNote {
    choices: string[]
    labels: { [choice: string]: string }
    value: string
    selection: string | null
    trigger: string | null
}

/** Variable Setup **********************************************************************************************************************************/
var formDialogPromise: Promise<string> | null = null
// A second open while the form is up (the shortcut pressed twice) is ignored rather than replacing the markup under the user.
var formIsOpen = false
// The note created by Create and open on the trigger route, waiting for the content script to ask for its open (openTriggerNote).
var triggerOpenPending: string | null = null

/** getFormDialog ***********************************************************************************************************************************
 * The dialog handle, built once on the first open. Concurrent callers share the same build; a failed build is forgotten so the next open retries.  *
 ***************************************************************************************************************************************************/
function getFormDialog(): Promise<string> {
    if (!formDialogPromise){
        formDialogPromise = buildFormDialog().catch(error => {
            formDialogPromise = null
            throw error
        })
    }
    return formDialogPromise
}

async function buildFormDialog(): Promise<string> {
    const handle = await joplin.views.dialogs.create(FORM_DIALOG_ID)
    for (const script of FORM_SCRIPTS){
        await joplin.views.dialogs.addScript(handle, script)
    }
    await joplin.views.dialogs.setButtons(handle, FORM_BUTTONS)
    return handle
}

/** openJot *****************************************************************************************************************************************
 * What jot.open, jot.fromSelection and jot.button run (brief 4.4: one chord serves both). The selection is read first: highlighted text opens the    *
 * form on the selection route, its first non-empty line as the Title and the rest as the Text; no selection (none, whitespace only, unreadable)     *
 * opens the plain form on `route`. A form already open is left alone without reading anything.                                                    *
 ***************************************************************************************************************************************************/
export async function openJot(route: string): Promise<FormOutcome | null> {
    if (formIsOpen) return null
    const selection = await readSelectedText()
    const split = FormModel.splitSelection(selection)
    if (split.empty) return openForm(route)
    return openForm(SELECTION_ROUTE, { title: split.title, body: split.body, selection })
}

/** openForm ****************************************************************************************************************************************
 * Opens the form and applies what the user chose. `route` names the way in ("menu" for Tools > Jot… and its shortcut, "contextMenu" for the        *
 * editor's right-click menu, "button" for the toolbar, all three the same plain form; "selection" for highlighted text, which adds the In this note  *
 * row). Resolves { id, opened } when a note was created, null when nothing was (Cancel, Escape, an empty Create, no notebook to create in, or a     *
 * form already open).                                                                                                                              *
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
        triggerOpenPending = created.id
        answer.open = created.id
    }
    return answer
}

/** openTriggerNote *********************************************************************************************************************************
 * The second half of Create and open on the trigger route: the content script, its edit made, asks for the note to be opened. Only the note the    *
 * last trigger form created and has not opened yet is opened, and only once; anything else is refused. Resolves whether it opened.                 *
 ***************************************************************************************************************************************************/
export async function openTriggerNote(noteId: unknown): Promise<boolean> {
    if (typeof noteId !== "string" || !noteId || noteId !== triggerOpenPending) return false
    triggerOpenPending = null
    await openCreatedNote(noteId)
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
 * The In this note row of one open. The selection route: Keep, Replace (and Add after in the Markdown editor), starting on lastSelectionAction. The  *
 * trigger route: Remove and Replace with a link, labelled with the trigger, starting on lastTriggerAction. Every other route: no row, and nothing is  *
 * read.                                                                                                                                            *
 ***************************************************************************************************************************************************/
async function inThisNoteFor(route: string, presets: FormPresets): Promise<InThisNote> {
    if (route === SELECTION_ROUTE && typeof presets.selection === "string"){
        const choices: string[] = FormModel.selectionChoices(await editorIsMarkdown())
        const value = FormModel.inThisNoteAction(await getLastSelectionAction(), choices)
        return { choices, labels: FormModel.SELECTION_LABELS, value, selection: presets.selection, trigger: null }
    }
    if (route === TRIGGER_ROUTE && typeof presets.trigger === "string"){
        const choices: string[] = FormModel.triggerChoices()
        const value = FormModel.inThisNoteAction(await getLastTriggerAction(), choices)
        return { choices, labels: FormModel.triggerLabels(presets.trigger), value, selection: null, trigger: presets.trigger }
    }
    return { choices: [], labels: {}, value: "", selection: null, trigger: null }
}

async function runForm(route: string, presets: FormPresets): Promise<Created | null> {
    const notebooks: FormNotebook[] = FormModel.buildNotebookPaths(await getAllFolders())
    if (!notebooks.length){
        await joplin.views.dialogs.showMessageBox(FormModel.NO_NOTEBOOK_MESSAGE)
        return null
    }
    const tagTitles = (await getAllTags()).map(tag => tag.title).filter(title => !!title).sort()
    const defaultType = FormModel.normalizeType(presets.type, await getDefaultType())
    const dayStart = FormModel.dayStartText(await getDayStartTime())
    const notebookId = await currentNotebookId(notebooks, presets.notebookId)
    const mobile = await isMobile()
    const row = await inThisNoteFor(route, presets)
    const inThisNoteChoices = row.choices

    let values: FormValues = {
        type: defaultType,
        title: presets.title || "",
        body: presets.body || "",
        notebookId: notebookId,
        tags: "",
        dueDate: "",
        dueTime: "",
        inThisNote: row.value,
    }
    let pickerOpen = false
    const handle = await getFormDialog()

    for (;;){
        await joplin.views.dialogs.setHtml(handle, buildFormHtml({
            notebooks, tags: tagTitles, values, dayStart, mobile, pickerOpen, inThisNoteChoices, inThisNoteLabels: row.labels,
        }))
        const result = await joplin.views.dialogs.open(handle)
        const plan = FormModel.planCreate(result, { defaultType, dayStart, notebookId, inThisNoteChoices })
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
}

/** currentNotebookId *******************************************************************************************************************************
 * The notebook the form starts on, in formModel.defaultNotebookId's order: the caller's, else the notebook of the note the editor holds, else the    *
 * notebook the app is showing, else the first by path. Each workspace call is made only when the step before it gave no usable notebook.            *
 ***************************************************************************************************************************************************/
async function currentNotebookId(notebooks: FormNotebook[], callerNotebookId?: string): Promise<string> {
    const known = (id: any) => !!id && notebooks.some(item => item.id === id)
    const candidates: any = { callerNotebookId: callerNotebookId || null, editorNote: null, shownFolder: null }
    if (!known(callerNotebookId)){
        candidates.editorNote = await selectedNote()
        if (!known(candidates.editorNote && candidates.editorNote.parent_id)) candidates.shownFolder = await selectedFolder()
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
 * Executes a 'create' plan: POST notes with the payload formModel built, the tags, then the In this note choice, and last the open when the plan    *
 * asks for one - last, because opening switches the editor to the new note and the edit must reach the note the form was opened from. The selection *
 * route makes its edit here (the link to the new note under its final title) and remembers the choice. The trigger route only remembers it: its edit *
 * is the content script's, made from the answer, so on Create and open the open waits for the content script too (openLater).                       *
 ***************************************************************************************************************************************************/
async function createNote(plan: any, row: InThisNote): Promise<Created> {
    const note = await joplin.data.post(["notes"], null, plan.note)
    if (plan.tags.length) await attachTags(note.id, plan.tags)
    const link: string = FormModel.noteLink(plan.note.title, note.id)
    if (plan.inThisNote && row.selection !== null){
        await applySelectionEdit(FormModel.selectionEdit(plan.inThisNote, row.selection, link))
        await setLastSelectionAction(plan.inThisNote)
    }
    if (plan.inThisNote && row.trigger !== null) await setLastTriggerAction(plan.inThisNote)
    const openLater = !!plan.open && row.trigger !== null
    if (plan.open && !openLater) await openCreatedNote(note.id)
    return { id: note.id, opened: !!plan.open, inThisNote: plan.inThisNote || null, link, openLater }
}

/** attachTags **************************************************************************************************************************************
 * Attaches the tag titles (already trimmed, lower-cased and de-duplicated) to the new note: an existing tag is reused by its lower-cased title, a   *
 * missing one is created (POST tags), and each is attached (POST tags/:id/notes). The tag list is read again here rather than taken from the open,  *
 * so a tag made meanwhile (another device's sync, another plugin) is reused rather than duplicated.                                                *
 ***************************************************************************************************************************************************/
async function attachTags(noteId: string, titles: string[]): Promise<void> {
    const existing = new Map<string, string>()
    for (const tag of await getAllTags()){
        const title = String(tag.title || "").toLowerCase()
        if (title && !existing.has(title)) existing.set(title, tag.id)
    }
    for (const title of titles){
        let tagId = existing.get(title)
        if (!tagId){
            const created = await joplin.data.post(["tags"], null, { title })
            tagId = created.id
            existing.set(title, tagId)
        }
        await joplin.data.post(["tags", tagId, "notes"], null, { id: noteId })
    }
}

/** openCreatedNote *********************************************************************************************************************************
 * Create and open: the note opens where the openTarget setting says. A new window is a desktop command (openNoteInNewWindow, absent in older apps   *
 * and on mobile); when it is not there, or throws, the note opens in the editor instead, with a console warning and no message.                    *
 ***************************************************************************************************************************************************/
async function openCreatedNote(noteId: string): Promise<void> {
    if ((await getOpenTarget()) === OPEN_IN_WINDOW && !(await isMobile())){
        try {
            await joplin.commands.execute("openNoteInNewWindow", noteId)
            return
        } catch (error) {
            console.warn("Jot: could not open the note in a new window, opening it in the editor instead", error)
        }
    }
    await joplin.commands.execute("openNote", noteId)
}

/** getAllFolders / getAllTags **********************************************************************************************************************
 * Every notebook ({ id, title, parent_id }) and every tag ({ id, title }), walked page by page (the data API pages its lists). The API leaves the    *
 * trash out of both.                                                                                                                               *
 ***************************************************************************************************************************************************/
async function getAllFolders(): Promise<any[]> {
    const items: any[] = []
    let page = 1
    let response: any
    do {
        response = await joplin.data.get(["folders"], { fields: ["id", "title", "parent_id"], page: page++ })
        items.push(...((response && response.items) || []))
    } while (response && response.has_more)
    return items
}

async function getAllTags(): Promise<any[]> {
    const items: any[] = []
    let page = 1
    let response: any
    do {
        response = await joplin.data.get(["tags"], { fields: ["id", "title"], page: page++ })
        items.push(...((response && response.items) || []))
    } while (response && response.has_more)
    return items
}
