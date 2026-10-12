/** README ******************************************************************************************************************************************
 * Jot's CodeMirror 6 content script: the typed trigger in the Markdown editor (brief 4.4), for desktop and mobile from one file (Harper's shape),     *
 * registered by src/trigger.ts with ContentScriptType.CodeMirrorPlugin. Every @codemirror/* import stays a require() of Joplin's own copy:           *
 * webpack.config.js marks those modules external, because a bundled second CodeMirror breaks the editor (test/run.js checks dist/contentScript.js).  *
 *                                                                                                                                                  *
 * WHAT IT WATCHES. An EditorView.updateListener looks at every transaction. Only typing counts (tr.isUserEvent('input.type'): never a paste, an      *
 * undo or redo, an autocompletion, Joplin's insertText and replaceSelection - the commands the selection route uses, which carry no user event -    *
 * nor this script's own edit, which carries 'input.jot'). Each inserted range is put to the rule (src/form/triggerRule.js: the trigger ends where     *
 * the insertion ends, after a line start or whitespace, and is not an occurrence the user cancelled). While the view is composing (an input method  *
 * at work, view.composing) the ranges wait, mapped through every change, and are put to the rule once the composition is over: at the next update, *
 * or shortly after the compositionend event when no update follows it. One fire at a time; the first range that fires wins.                         *
 *                                                                                                                                                  *
 * THE ROUND TRIP. A fire posts { type: 'trigger', from, to, trigger } and awaits the answer, which the plugin gives when the form closes (the desktop *
 * IPC holds the reply as long as that takes). Meanwhile from and to are mapped through every change. The answer is applied as ONE transaction:       *
 * remove deletes the trigger, link replaces it with the Markdown link, so one Undo restores what was typed; the history is closed after it (a        *
 * selection-only transaction), so text typed straight after the dialog closes is an undo step of its own. The edit is skipped, with a console        *
 * warning, when the trigger is no longer where it was (the editor got another note, or the text there changed); another note also lets the fire   *
 * go, so the trigger works there at once even if the answer never comes. cancel (and no answer at all)                                            *
 * changes nothing and remembers the occurrence, so the same trigger is not asked about again (triggerRule's README says how long). Create and open    *
 * answers with open: the note's id, which is asked back ({ type: 'open', id }) once the edit is made, so the edit lands in the note it was typed in.  *
 * Nothing here moves the focus or the caret: the caret maps through the edit as CodeMirror maps it.                                                *
 *                                                                                                                                                  *
 * THE TRIGGER STRING. Asked from the plugin ({ type: 'config' } -> { trigger }) when the script mounts on an editor, whenever the editor's document   *
 * is replaced wholesale - Joplin giving the editor another note: in 3.6.14 one transaction with no user event that replaces the whole document and   *
 * carries the new note's id in an effect (either sign counts; the id alone covers two notes with the same text) - and after every fire. Until the     *
 * first answer the trigger is off. An answer that does not come (a timeout) or comes back empty (the plugin had not wired its handler yet, Harper's   *
 * measured ~25 ms window at startup) is asked again a few times; a newer question supersedes an older one; a failed one keeps the value in force.     *
 *                                                                                                                                                  *
 * DOUBLE MOUNT. Mobile mounts content scripts twice on the same editor (joplin#12891); a registry on window keyed by the EditorView makes the second   *
 * mount a no-op (Harper's guard), so the trigger can never fire twice.                                                                             *
 *                                                                                                                                                  *
 * THE VIEW COMMANDS. jot.getView and jot.setView, registered on the editor control (editor.execCommand reaches them), serve src/form/selectionGuard.ts:*
 * Joplin can select another note while Jot writes tags, and Jot opens the note being read again; getView answers { noteId, scrollTop, anchor, head,  *
 * docLength, focused } before the write, setView puts the scroll offset, the caret and the focus back once the editor holds that note again, and     *
 * refuses a view of another note. The note id is the one Joplin's last note switch carried (null until the first switch this script sees).          *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import { EditorView, ViewUpdate } from '@codemirror/view'
import { ChangeDesc, EditorSelection, Text, Transaction } from '@codemirror/state'
const TriggerRule = require('./form/triggerRule')

/** Types *******************************************************************************************************************************************/
// Joplin's ContentScriptContext, typed here as Harper types it (the api/ types would pull runtime enums into the editor's bundle).
interface ContentScriptContext {
    postMessage: (message: unknown) => Promise<unknown>
    pluginId: string
    contentScriptId: string
}

// The CodeMirror control Joplin passes to plugin(): cm6 and editor are the EditorView; addExtension appends to the editor's configuration.
interface CodeMirrorControl {
    cm6?: unknown
    editor?: EditorView
    addExtension: (extension: unknown) => void
    registerCommand?: (name: string, callback: (...args: unknown[]) => unknown) => void
}

// What jot.getView answers and jot.setView takes (src/form/selectionGuard.ts, EditorViewState).
interface ViewState { noteId: string | null; scrollTop: number; anchor: number; head: number; docLength: number; focused: boolean }

interface Range { from: number; to: number }
interface Occurrence { from: number; to: number; text: string }
interface Pending { view: EditorView; from: number; to: number; text: string; lost: boolean }

/** Constants ***************************************************************************************************************************************/
const CONFIG_ATTEMPTS = 5
const CONFIG_TIMEOUT_MS = 5000
const CONFIG_BACKOFF_MS = 500
const CONFIG_TIMED_OUT = 'jot-config-timeout'
// How long after compositionend the waiting ranges are checked when no update has checked them (CodeMirror flushes the last composed text within
// about 50 ms of the event).
const COMPOSITION_SETTLE_MS = 120
// The user event of this script's own edit: not 'input.type' (so it never fires the trigger) and not joinable with typing in CodeMirror's history.
const EDIT_USER_EVENT = 'input.jot'
const MAX_CANCELLED = 64
const NOTE_ID = /^[0-9a-f]{32}$/

/** alreadyActivated ********************************************************************************************************************************
 * Harper's double-mount guard (joplin#12891): the activated editors in a WeakSet on window, which both evaluations of this script share in the same   *
 * editor webview (a module-level set would not be shared). Without a view, or without a window (the Node harness), activation proceeds.            *
 ***************************************************************************************************************************************************/
function alreadyActivated(view: unknown): boolean {
    if (!view || typeof view !== 'object') return false
    try {
        const host = window as unknown as { __jotActivatedEditors?: WeakSet<object> }
        if (!host.__jotActivatedEditors) host.__jotActivatedEditors = new WeakSet<object>()
        if (host.__jotActivatedEditors.has(view as object)) return true
        host.__jotActivatedEditors.add(view as object)
        return false
    } catch (error) {
        return false
    }
}

/** switchesDocument ********************************************************************************************************************************
 * Whether a transaction gives the editor another document: it carries a note id in an effect (Joplin's setNoteIdEffect, dispatched on every note      *
 * switch), or it has no user event and replaces the whole previous document in one change (Joplin's updateBody: another note, or the open note's     *
 * text replaced from outside, as a sync does).                                                                                                       *
 ***************************************************************************************************************************************************/
function effectNoteId(tr: Transaction): string | null {
    for (const effect of tr.effects) {
        if (typeof effect.value === 'string' && NOTE_ID.test(effect.value)) return effect.value
    }
    return null
}

function switchesDocument(tr: Transaction): boolean {
    if (effectNoteId(tr)) return true
    if (!tr.docChanged || tr.annotation(Transaction.userEvent) !== undefined) return false
    let changes = 0
    let whole = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        changes++
        whole = fromA === 0 && toA === tr.startState.doc.length
    })
    return changes === 1 && whole
}

/** Mapping helpers *********************************************************************************************************************************
 * A typed range keeps its own characters (start after, end before what is inserted at its edges) and is gone once empty. A remembered occurrence is   *
 * mapped by its end and keeps its length; it then stays remembered only while the document still holds it (triggerRule.occurrenceHolds).            *
 ***************************************************************************************************************************************************/
function mapRanges(ranges: Range[], changes: ChangeDesc): Range[] {
    const out: Range[] = []
    for (const range of ranges) {
        const from = changes.mapPos(range.from, 1)
        const to = changes.mapPos(range.to, -1)
        if (to > from) out.push({ from, to })
    }
    return out
}

function mapOccurrence(occurrence: Occurrence, changes: ChangeDesc): Occurrence {
    const to = changes.mapPos(occurrence.to, -1)
    return { from: to - occurrence.text.length, to, text: occurrence.text }
}

function occurrenceHolds(doc: Text, occurrence: Occurrence): boolean {
    if (occurrence.from < 0 || occurrence.to > doc.length) return false
    const around = TriggerRule.contextRange(occurrence.to, occurrence.text.length)
    return TriggerRule.occurrenceHolds(doc.sliceString(around.from, around.to), around.from, occurrence)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** TriggerWatcher **********************************************************************************************************************************
 * One per activated editor: the trigger in force, the occurrences the user cancelled, the ranges typed during a composition, and the fire waiting    *
 * for its answer.                                                                                                                                   *
 ***************************************************************************************************************************************************/
class TriggerWatcher {
    private trigger = ''
    private configAsk = 0
    private cancelled: Occurrence[] = []
    private deferred: Range[] = []
    private pending: Pending | null = null
    private noteId: string | null = null

    constructor(private context: ContentScriptContext) {}

    /** viewState: what jot.getView answers - the note this editor holds (once Joplin has said), the scroll offset, the main selection, the focus. */
    viewState(view: EditorView): ViewState {
        const main = view.state.selection.main
        return {
            noteId: this.noteId,
            scrollTop: view.scrollDOM ? view.scrollDOM.scrollTop : 0,
            anchor: main.anchor,
            head: main.head,
            docLength: view.state.doc.length,
            focused: !!view.hasFocus,
        }
    }

    /** restoreView: jot.setView - the caret (clamped to the document), the scroll offset and the focus as they were; null for a view of another note. */
    restoreView(view: EditorView, state: unknown): ViewState | null {
        if (!state || typeof state !== 'object') return null
        const wanted = state as Partial<ViewState>
        if (wanted.noteId && this.noteId && wanted.noteId !== this.noteId) return null
        const length = view.state.doc.length
        const clamp = (value: unknown) => {
            const number = Math.floor(Number(value))
            return Number.isFinite(number) ? Math.max(0, Math.min(length, number)) : 0
        }
        try {
            view.dispatch({ selection: EditorSelection.single(clamp(wanted.anchor), clamp(wanted.head)) })
        } catch (error) {
            console.warn('Jot: could not put the caret back', error)
        }
        const scrollTop = Number(wanted.scrollTop)
        if (view.scrollDOM && Number.isFinite(scrollTop)) view.scrollDOM.scrollTop = scrollTop
        if (wanted.focused && typeof view.focus === 'function') view.focus()
        return this.viewState(view)
    }

    /** onUpdate: maps what is kept through the update's changes, collects the typed insertions, and puts them to the rule once nothing composes. */
    onUpdate(update: ViewUpdate): void {
        let typed: Range[] = []
        for (const tr of update.transactions) {
            const switchedTo = effectNoteId(tr)
            if (switchedTo) this.noteId = switchedTo
            if (switchesDocument(tr)) {
                typed = []
                this.deferred = []
                this.cancelled = []
                // The fire waiting for its answer belongs to the document that left: it is marked lost (its edit is never made) and let go, so a reply
                // that never settles (the mobile round trip is unverified) cannot keep the trigger off in the next one. A fire there while the form is
                // still up is answered cancel by the plugin's one-form guard.
                if (this.pending) {
                    this.pending.lost = true
                    this.pending = null
                }
                this.refreshConfig()
                continue
            }
            if (!tr.docChanged) continue
            const changes = tr.changes
            typed = mapRanges(typed, changes)
            if (this.deferred.length) this.deferred = mapRanges(this.deferred, changes)
            if (this.pending && !this.pending.lost) {
                this.pending.from = changes.mapPos(this.pending.from, 1)
                this.pending.to = changes.mapPos(this.pending.to, -1)
            }
            if (this.cancelled.length) {
                this.cancelled = this.cancelled.map(item => mapOccurrence(item, changes)).filter(item => occurrenceHolds(tr.state.doc, item))
            }
            if (tr.isUserEvent('input.type')) {
                changes.iterChanges((fromA, toA, fromB, toB) => {
                    if (toB > fromB) typed.push({ from: fromB, to: toB })
                })
            }
        }
        if (update.view.composing) {
            this.deferred = this.deferred.concat(typed)
            return
        }
        const ranges = this.deferred.concat(typed)
        this.deferred = []
        this.evaluate(update.view, update.state.doc, ranges)
    }

    /** compositionEnded: the ranges typed during a composition are checked shortly after it ends, in case no update comes to check them. */
    compositionEnded(view: EditorView): void {
        setTimeout(() => {
            if (view.composing || !this.deferred.length) return
            const ranges = this.deferred
            this.deferred = []
            this.evaluate(view, view.state.doc, ranges)
        }, COMPOSITION_SETTLE_MS)
    }

    /** evaluate: the first typed range that fires the rule fires; nothing fires while the trigger is off or a fire waits for its answer. */
    private evaluate(view: EditorView, doc: Text, ranges: Range[]): void {
        if (!ranges.length || !this.trigger || this.pending) return
        for (const range of ranges) {
            const around = TriggerRule.contextRange(range.to, this.trigger.length)
            const verdict = TriggerRule.triggerAt(doc.sliceString(around.from, around.to), around.from, this.trigger, range, this.cancelled)
            if (verdict.fires) {
                const pending: Pending = { view, from: verdict.from, to: verdict.to, text: this.trigger, lost: false }
                this.pending = pending
                void this.ask(pending)
                return
            }
        }
    }

    /** ask: the round trip with the plugin, then the answer applied, then the trigger asked again. */
    private async ask(pending: Pending): Promise<void> {
        let answer: any = null
        try {
            answer = await this.context.postMessage({ type: 'trigger', from: pending.from, to: pending.to, trigger: pending.text })
        } catch (error) {
            console.warn('Jot: the typed trigger got no answer from the plugin; the text is left as typed', error)
        }
        if (this.pending === pending) this.pending = null
        try {
            this.apply(pending, answer)
        } finally {
            this.refreshConfig()
        }
    }

    /** apply: remove or link as one transaction where the trigger still is; anything else remembers the occurrence; then Create and open's open. */
    private apply(pending: Pending, answer: any): void {
        const view = pending.view
        const action = answer && typeof answer === 'object' ? answer.action : null
        const link = answer && typeof answer.link === 'string' ? answer.link : ''
        const doc = view.state.doc
        const intact = !pending.lost && pending.from >= 0 && pending.to <= doc.length && doc.sliceString(pending.from, pending.to) === pending.text
        if (action === 'remove' || (action === 'link' && link)) {
            if (!intact) {
                console.warn('Jot: the typed trigger is no longer where it was typed, so it is left as it is (the note is created)')
            } else {
                try {
                    view.dispatch({ changes: { from: pending.from, to: pending.to, insert: action === 'link' ? link : '' }, userEvent: EDIT_USER_EVENT })
                    view.dispatch({ selection: view.state.selection })
                } catch (error) {
                    console.warn('Jot: could not change the typed trigger in the editor (the note is created)', error)
                }
            }
        } else if (intact) {
            this.cancelled = this.cancelled.concat([{ from: pending.from, to: pending.to, text: pending.text }]).slice(-MAX_CANCELLED)
        }
        if (answer && typeof answer.open === 'string' && answer.open) {
            try {
                this.context.postMessage({ type: 'open', id: answer.open }).catch(error => console.warn('Jot: could not open the new note', error))
            } catch (error) {
                console.warn('Jot: could not open the new note', error)
            }
        }
    }

    /** refreshConfig: asks for the trigger, retrying a timeout or an empty answer; a newer question supersedes, a failure keeps the value in force. */
    refreshConfig(): void {
        const ask = ++this.configAsk
        void (async () => {
            for (let attempt = 1; attempt <= CONFIG_ATTEMPTS; attempt++) {
                const reply: any = await this.askConfigOnce()
                if (ask !== this.configAsk) return
                if (reply && typeof reply === 'object' && 'trigger' in reply) {
                    this.trigger = TriggerRule.normalizeTrigger(reply.trigger)
                    return
                }
                await sleep(CONFIG_BACKOFF_MS)
                if (ask !== this.configAsk) return
            }
        })()
    }

    private async askConfigOnce(): Promise<unknown> {
        let timer: ReturnType<typeof setTimeout> | null = null
        try {
            return await Promise.race([
                this.context.postMessage({ type: 'config' }),
                new Promise(resolve => { timer = setTimeout(() => resolve(CONFIG_TIMED_OUT), CONFIG_TIMEOUT_MS) }),
            ])
        } catch (error) {
            return null
        } finally {
            if (timer) clearTimeout(timer)
        }
    }
}

/** default export **********************************************************************************************************************************
 * The content script's entry, called by Joplin with its context. plugin() receives the editor control on each mount: on CodeMirror 6 it adds the   *
 * update listener and the compositionend handler (Joplin ignores what plugin() returns; addExtension is the way in) and asks for the trigger.      *
 * The legacy CodeMirror 5 editor has no cm6 and gets nothing.                                                                                      *
 ***************************************************************************************************************************************************/
export default (context: ContentScriptContext) => {
    return {
        plugin: (editorControl: CodeMirrorControl) => {
            if (!editorControl || !editorControl.cm6) return
            if (alreadyActivated(editorControl.editor || editorControl.cm6)) return
            const watcher = new TriggerWatcher(context)
            editorControl.addExtension([
                EditorView.updateListener.of(update => watcher.onUpdate(update)),
                EditorView.domEventHandlers({
                    compositionend: (event, view) => {
                        watcher.compositionEnded(view)
                        return false
                    },
                }),
            ])
            const view = (editorControl.editor || editorControl.cm6) as EditorView
            if (typeof editorControl.registerCommand === 'function') {
                try {
                    editorControl.registerCommand('jot.getView', () => watcher.viewState(view))
                    editorControl.registerCommand('jot.setView', (state: unknown) => watcher.restoreView(view, state))
                } catch (error) {
                    console.warn('Jot: could not register the editor view commands; a note Joplin moves off is opened again at its top', error)
                }
            }
            watcher.refreshConfig()
        },
    }
}
