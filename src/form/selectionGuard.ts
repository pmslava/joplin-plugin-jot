/** README ******************************************************************************************************************************************
 * Keeps the editor on the note the user was reading while Jot writes tags (and, in edit mode, moves a note to another notebook).                  *
 *                                                                                                                                                  *
 * WHY. Joplin refreshes the note list after every tag change - a tag created or attached dispatches TAG_UPDATE_ONE, a tag removed NOTE_TAG_REMOVE -  *
 * and the refresh selects a note again: the last one selected in that list, or, when the list keeps none, its FIRST note. A smart filter such as    *
 * All notes keeps none (stateUtils.parentItem has no id for it), so there the refresh selects the list's first note, which after a create is the    *
 * note Jot has just made: the editor leaves the note being read. Separately, a listed note moved to another notebook makes Joplin select the note    *
 * that took its place in the list, whichever note was selected. Both read in the 3.6.14 and 3.7.21 bundles (BaseApplication.refreshNotes, the       *
 * NOTE_UPDATE_ONE reducer) and reproduced in e2e/selection-guard.spec.ts. A plugin cannot stop the refresh, and Joplin has no command that selects    *
 * a note in place, so Jot holds the selection before such a write and gives it back after.                                                         *
 *                                                                                                                                                  *
 * HOW. holdSelection() reads the selected note (one note only; a multi-selection or none is not held) and asks the Markdown editor for its view -     *
 * scroll offset, caret, focus - through the content script's jot.getView command (no answer in the Rich Text editor: the note alone is held).        *
 * keepSelection(held) then watches the selection for GUARD_TIMING.watchMs after the write. When it leaves the held note, it waits settleMs for the    *
 * remaining refreshes (one per tag) to land, opens the held note again (openNote, which also shows the note's notebook in the note list - the only   *
 * command that selects a note), waits for the editor to hold it, and puts the view back with jot.setView, checking it held, since Joplin keeps no    *
 * scroll position per note and would otherwise show the note from its top. A second jump inside the window is undone once more. A multi-selection    *
 * that appears is the user's own, and ends the watch.                                                                                               *
 *                                                                                                                                                  *
 * WHAT IT COSTS. Nothing on mobile (not held: its note list and its editor work differently, and nothing there was seen to jump). On desktop, a write *
 * that may move the selection makes the command resolve up to watchMs later; the dialog is already closed by then.                                  *
 *                                                                                                                                                  *
 * NEVER THROWS: every call is guarded, and a step that fails ends the guard with a console warning.                                                *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in one expression.                                                              *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from "api"
import { isMobile } from "../core/platform"

/** Types *******************************************************************************************************************************************/
// What the content script's jot.getView answers (src/contentScript.ts, viewState).
export interface EditorViewState {
    noteId: string | null
    scrollTop: number
    anchor: number
    head: number
    docLength: number
    focused: boolean
}

export interface HeldSelection {
    noteId: string
    view: EditorViewState | null
}

/** GUARD_TIMING ************************************************************************************************************************************
 * The guard's clock, in milliseconds. The harness (test/run.js) shortens it by setting globalThis.__jotGuardTiming before it loads the bundle; the    *
 * values are read at call time.                                                                                                                    *
 ***************************************************************************************************************************************************/
export const GUARD_TIMING = {
    pollMs: 50,          // how often the selection is read while watching
    watchMs: 2000,       // how long after a write the selection is watched (the refresh of a large All notes list can take a while)
    settleMs: 250,       // after a jump, how long the remaining refreshes get before the note is opened again
    viewWaitMs: 3000,    // how long the editor gets to hold the reopened note before the view is put back
    viewChecks: 3,       // how many times the view is put back if the editor moves it again while it settles
    viewCheckMs: 250,    // how long after putting the view back it is checked
    maxRestores: 2,      // how many jumps one write may undo
    triggerEditMs: 300,  // on the trigger route, how long the content script gets to make its edit before the tags are written
}

function timing(): typeof GUARD_TIMING {
    const override = (globalThis as any).__jotGuardTiming
    return override && typeof override === "object" ? { ...GUARD_TIMING, ...override } : GUARD_TIMING
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** guardTiming *************************************************************************************************************************************
 * The clock in force (GUARD_TIMING, or the harness's shorter one), for the callers that wait on it too.                                            *
 ***************************************************************************************************************************************************/
export function guardTiming(): typeof GUARD_TIMING {
    return timing()
}

/** holdSelection ***********************************************************************************************************************************
 * The note the user is on, and the Markdown editor's view of it when the editor answers for that note; null on mobile, with no note or several      *
 * selected, or when the selection cannot be read.                                                                                                  *
 ***************************************************************************************************************************************************/
export async function holdSelection(): Promise<HeldSelection | null> {
    if (await isMobile()) return null
    const ids = await readSelectedNoteIds()
    if (!ids || ids.length !== 1) return null
    const view = await readEditorView()
    return { noteId: ids[0], view: view && (!view.noteId || view.noteId === ids[0]) ? view : null }
}

/** keepSelection ***********************************************************************************************************************************
 * After the write: watches the selection and, when Joplin moved it off the held note, gives the note and its view back (see the README). Resolves  *
 * how many jumps were undone (0 when nothing moved, or nothing was held).                                                                           *
 ***************************************************************************************************************************************************/
export async function keepSelection(held: HeldSelection | null): Promise<number> {
    if (!held) return 0
    const clock = timing()
    const deadline = Date.now() + clock.watchMs
    let restores = 0
    while (Date.now() < deadline && restores < clock.maxRestores){
        await sleep(clock.pollMs)
        const ids = await readSelectedNoteIds()
        if (!ids) return restores
        if (ids.length === 1 && ids[0] === held.noteId) continue
        if (ids.length > 1) return restores
        await sleep(clock.settleMs)
        if (!(await reopen(held))) return restores
        restores++
    }
    return restores
}

/** reopen ******************************************************************************************************************************************
 * Opens the held note again and puts its view back. Resolves whether the note was opened.                                                          *
 ***************************************************************************************************************************************************/
async function reopen(held: HeldSelection): Promise<boolean> {
    try {
        await joplin.commands.execute("openNote", held.noteId)
    } catch (error) {
        console.warn("Jot: Joplin moved off the note you were reading and it could not be opened again", error)
        return false
    }
    if (held.view) await restoreView(held.noteId, held.view)
    return true
}

/** restoreView *************************************************************************************************************************************
 * Waits for the editor to hold the note again, then puts the scroll offset, the caret and the focus back, and checks a little later that they held:  *
 * the editor may still be settling the note it just loaded.                                                                                        *
 ***************************************************************************************************************************************************/
async function restoreView(noteId: string, view: EditorViewState): Promise<void> {
    const clock = timing()
    const until = Date.now() + clock.viewWaitMs
    let current = await readEditorView()
    while (!(current && current.noteId === noteId)){
        if (Date.now() >= until) return
        await sleep(clock.pollMs)
        current = await readEditorView()
    }
    for (let attempt = 0; attempt < clock.viewChecks; attempt++){
        try {
            await joplin.commands.execute("editor.execCommand", { name: "jot.setView", args: [view] })
        } catch (error) {
            console.warn("Jot: could not put the editor's scroll position back", error)
            return
        }
        await sleep(clock.viewCheckMs)
        current = await readEditorView()
        if (!current || current.noteId !== noteId) return
        if (Math.abs(Number(current.scrollTop) - Number(view.scrollTop)) <= 2 && current.head === Math.min(view.head, current.docLength)) return
    }
}

/** readSelectedNoteIds / readEditorView ************************************************************************************************************
 * The selected notes' ids (null when they cannot be read), and the Markdown editor's view (null in the Rich Text editor, without a content script,  *
 * or when the answer is not one).                                                                                                                  *
 ***************************************************************************************************************************************************/
async function readSelectedNoteIds(): Promise<string[] | null> {
    try {
        const ids = await joplin.workspace.selectedNoteIds()
        return Array.isArray(ids) ? ids.map(id => String(id)) : null
    } catch (error) {
        console.warn("Jot: could not read which note is selected", error)
        return null
    }
}

async function readEditorView(): Promise<EditorViewState | null> {
    try {
        const view = await joplin.commands.execute("editor.execCommand", { name: "jot.getView" })
        return view && typeof view === "object" && Number.isFinite(Number(view.scrollTop)) ? view as EditorViewState : null
    } catch (error) {
        return null
    }
}
