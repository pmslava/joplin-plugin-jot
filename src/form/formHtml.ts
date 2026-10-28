/** README ******************************************************************************************************************************************
 * The form's markup, built by the host on every open and handed to dialogs.setHtml (brief 4.1, 4.2). Pure: everything it shows comes in as data,    *
 * so the harness reads what it emits through the stubbed setHtml.                                                                                  *
 *                                                                                                                                                  *
 * EVERY FIELD AND EVERY SIZE IS IN THE INITIAL MARKUP. Joplin takes the dialog's first size from this markup before any script or file has      *
 * arrived: on desktop a ResizeObserver re-measures it live; on a phone (3.7.8, useDialogSize) the dialog shows at the first measurement and is    *
 * measured again every 500 ms - seconds, while a sync keeps Joplin busy - so anything that changed the size after the first measurement made the  *
 * form change size and shape under a user already typing (Android, 2026-10-14). Hence the stylesheet travels IN the markup (form.css, minified,  *
 * the first element: FORM_CSS), the platform's layout is a class on the form (-mobile), the phone's width is a pixel rule made here from the       *
 * screen (mobileWrapperCss), and the script fills only what does not change the size: the suggestion rows (absolutely positioned, out of the       *
 * flow) and the calendar and time columns of the picker (in a section that starts folded, its height reserved; unfolding it grows the dialog,     *
 * which is the intent).                                                                                                                            *
 *                                                                                                                                                  *
 * THE ISLAND. What the script needs and the markup does not show - the notebooks (id, path, sorted by path), the tag titles, the defaults (type,     *
 * notebook id, day start time) - travels in a <script type="application/json"> element, with every "<" written as < so no value can close it.  *
 * setHtml writes the markup through innerHTML, so the element is never executed, only read.                                                         *
 *                                                                                                                                                  *
 * THE SELECTORS are one-line segmented controls, one builder for all (segmentRow): Type (Note, To-do); In this note on the selection and trigger   *
 * routes (Replace with link, Keep text and, in the Markdown editor, Add link after; or Replace ++ with link and Remove ++ - short labels, the full *
 * wording as each button's tooltip, the default first); Back link (Add, Don't add) when there is a note to link back to, the line it would add as  *
 * the Add button's tooltip; Open (No, In editor, New window; no window on mobile); and Note Tabs (Pin, Don't pin) when its setting is Pin or Don't *
 * pin, starting there (issue 7; Not used draws no row). Each is a radiogroup of buttons over a hidden input named after its field, so the form     *
 * sends the choice. The island carries the In this note list and the starting choice with the route's default ({ choices, value, fallback }, null  *
 * on the plain routes), so the markup and the island never disagree. Notebook and Tags stay text fields with their suggestion lists, and Due stays *
 * last, so unfolding its picker pushes nothing down.                                                                                               *
 *                                                                                                                                                  *
 * TITLE AND TAGS are textareas of one row (.jot-grow) only so they can wrap: formWebview.js grows them to three lines and then lets them scroll       *
 * (issue 4), keeps Enter from ever making a new line in them, and turns a pasted line break into a space. Their content starts with a newline, as  *
 * the Text's does, because the HTML parser drops one there.                                                                                         *
 *                                                                                                                                                  *
 * EDIT MODE (view.mode "edit", brief 4.5) is the same form for an existing note: the heading says Edit to-do or Edit note, and there is no Text    *
 * and no In this note, Back link, Open or Note Tabs row, so Type, Title, Notebook, Tags and Due remain. The island carries the mode, so the        *
 * script's heading follows the Type toggle in the edit wording.                                                                                    *
 *                                                                                                                                                  *
 * The picker section is Cockpit's set alarm dialog (src/ui/alarm/alarm.ts, openAlarmDialog), single to-do only: the YYYY-MM-DD and HH:MM inputs,   *
 * the two rows of quick buttons, the calendar and the two time columns, with the same ids and the same inline handlers, which formWebview.js        *
 * defines (ported from Cockpit's alarmWebview.js). Its inputs carry no name: the Due row's hidden dueDate and dueTime are the values the form sends. *
 ***************************************************************************************************************************************************/

/** Types *******************************************************************************************************************************************/
export interface FormNotebook { id: string; path: string }

export interface FormValues {
    type: string
    title: string
    body: string
    notebookId: string
    tags: string
    dueDate: string
    dueTime: string
    // The In this note choice ("keep", "replace", "after" on the selection route, "remove", "link" on the trigger route); "" on a route without the row.
    inThisNote: string
    // The Back link choice ("add" or "none"); "" on a route without the row.
    backlink?: string
    // The Open choice ("no", "editor" or "window"); "" in edit mode.
    open?: string
    // The Note Tabs choice ("pin" or "none"); "" when the row is not shown (the setting is Not used, or edit mode).
    noteTabs?: string
}

export interface FormView {
    // "edit" for edit mode (formModel.EDIT_MODE): the Edit headings, no Text, no In this note. Anything else, or absent, is create mode.
    mode?: string
    notebooks: FormNotebook[]
    tags: string[]
    values: FormValues
    dayStart: string
    mobile: boolean
    pickerOpen: boolean
    // The In this note buttons to draw, in order (formModel.selectionChoices or triggerChoices); empty or absent: no row.
    inThisNoteChoices?: string[]
    // Their short labels by choice (formModel.SELECTION_SHORT_LABELS, or triggerShortLabels on the trigger route), and their full wording as the
    // buttons' tooltips (SELECTION_LABELS, triggerLabels). A choice without a label shows its value; without a title, its label.
    inThisNoteLabels?: { [choice: string]: string }
    inThisNoteTitles?: { [choice: string]: string }
    // The route's default choice (formModel.SELECTION_DEFAULT or TRIGGER_DEFAULT): what a starting value the buttons do not offer reads as.
    inThisNoteDefault?: string
    // The line the Back link row would add (formModel.backlinkText), shown as the Add button's tooltip; empty or absent: no row (no note to link to).
    backlinkText?: string
    // The Note Tabs row's default, the noteTabs setting when it is Pin or Don't pin ("pin" or "none", formModel.NOTE_TABS_PIN and NOTE_TABS_NONE):
    // what values.noteTabs starts on and what a value the buttons do not offer reads as. Empty or absent: no row (the setting is Not used). Never
    // drawn in edit mode, like Open.
    noteTabsDefault?: string
    // On mobile, the form's width in CSS pixels (core/platform.ts, formWidthOnMobile: from the screen, which the plugin's own webview reports as the
    // dialog's does); absent or null: the form fills the dialog, which Joplin opens at 97% of the window and then sizes to it - the same width.
    mobileWidth?: number | null
    // A test build's open timings (core/timing.ts, SHOW_OPEN_TIMINGS): the tap's time, the parts timed in the plugin, when setHtml was called and the
    // screen width the plugin saw; the form's script adds how long the dialog took to show and writes the line under the heading. Absent or null: no
    // line.
    timing?: { start: number, parts: [string, number][], htmlAt: number, screen?: number | null } | null
}

interface SegmentOption { value: string; label: string; title?: string }

/** Imports *****************************************************************************************************************************************/
const FormModel = require("./formModel")
// form.css as text (webpack.config.js: CSS is imported as source), for the <style> element every form starts with.
const FORM_CSS_SOURCE: string = require("./form.css")

/** Constants ***************************************************************************************************************************************/
// The chevron at the Notebook field's right edge, which opens the list: Material Design's "arrow_drop_down" glyph (Apache 2.0), inlined as the bell is.
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5z"/></svg>'
// The bell beside the Due row: Material Design's "notifications" glyph (Apache 2.0), inlined so it needs no icon font on either platform.
const BELL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">'
    + '<path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 '
    + '5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>'

/** FORM_CSS ****************************************************************************************************************************************
 * The form's stylesheet as the markup carries it: form.css without its comments and with its whitespace collapsed (about 8 KB). Made once, when    *
 * the plugin loads.                                                                                                                                *
 ***************************************************************************************************************************************************/
export function minifyCss(css: string): string {
    return String(css || "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .replace(/\s*([{};,])\s*/g, "$1")
        .replace(/;}/g, "}")
        .trim()
}

export const FORM_CSS = minifyCss(FORM_CSS_SOURCE)

/** mobileWrapperCss ********************************************************************************************************************************
 * The phone's width rule, after form.css's 440px for the desktop: `width` CSS pixels when the host knows the screen, else the dialog's own width   *
 * (auto: Joplin opens the dialog at 97% of the window, the wrapper fills it, and the measured width is that width again - nothing is taken off, so *
 * it holds still, unlike 0.2.0's calc(100vw - 16px)). Never more than the desktop's 440px, nor than the dialog itself (100%, again with nothing     *
 * taken off): a window narrower than the screen - split screen, a phone turned with the form open - would otherwise cut the form's right edge.     *
 ***************************************************************************************************************************************************/
export function mobileWrapperCss(width?: number | null): string {
    const px = typeof width === "number" && isFinite(width) && width > 0 ? Math.round(width) + "px" : "auto"
    return `#joplin-plugin-content{width:${px};max-width:min(440px,100%)}`
}

/** escapeHtml **************************************************************************************************************************************
 * Text for an element's content or a double-quoted attribute value.                                                                                *
 ***************************************************************************************************************************************************/
export function escapeHtml(value: unknown): string {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/** islandJson **************************************************************************************************************************************
 * The JSON island's text: plain JSON with every "<" escaped, so "</script>" inside a notebook or tag name stays text.                              *
 ***************************************************************************************************************************************************/
export function islandJson(data: unknown): string {
    return JSON.stringify(data).replace(/</g, "\\u003c")
}

/** segmentRow **************************************************************************************************************************************
 * One selector: a label, a radiogroup of buttons (one tab stop, the selected one; formWebview.js moves the choice with the arrow keys), and the    *
 * hidden input the form sends. `id` is the hidden input's id; the row is `${id}Row` and the label `${id}Label`. Every selector is one: Type, In    *
 * this note, Back link, Open and Note Tabs.                                                                                                        *
 ***************************************************************************************************************************************************/
function segmentRow(id: string, field: string, label: string, options: SegmentOption[], selected: string, groupClass = ""): string {
    const buttons = options.map(option => {
        const on = option.value === selected
        return `<button type="button" class="jot-seg-option${on ? " -selected" : ""}" data-value="${escapeHtml(option.value)}" role="radio"`
            + ` aria-checked="${on ? "true" : "false"}" tabindex="${on ? "0" : "-1"}" title="${escapeHtml(option.title || option.label)}">`
            + `${escapeHtml(option.label)}</button>`
    }).join("")
    return `
            <div class="jot-row" id="${id}Row">
                <span class="jot-label" id="${id}Label">${escapeHtml(label)}</span>
                <div class="jot-seg${groupClass ? " " + groupClass : ""}" role="radiogroup" aria-labelledby="${id}Label" data-field="${field}">${buttons}</div>
                <input type="hidden" name="${field}" id="${id}" value="${escapeHtml(selected)}">
            </div>`
}

/** buildFormHtml ***********************************************************************************************************************************
 * The whole dialog markup for one open. `values` are the fields' starting values: the defaults on a fresh open (in edit mode, the note's), or      *
 * what the user had typed when the form is reopened after a refused Create or Save (then `pickerOpen` shows the picker, so the date that was       *
 * refused is in view).                                                                                                                             *
 ***************************************************************************************************************************************************/
export function buildFormHtml(view: FormView): string {
    const values = view.values
    const editing = view.mode === FormModel.EDIT_MODE
    const mode = editing ? FormModel.EDIT_MODE : FormModel.CREATE_MODE
    const type = FormModel.normalizeType(values.type)
    const isNote = type === FormModel.NOTE
    const notebook = view.notebooks.find(item => item.id === values.notebookId)
    const hasDue = !!(String(values.dueDate || "").trim() || String(values.dueTime || "").trim())
    const choices: string[] = !editing && Array.isArray(view.inThisNoteChoices) ? view.inThisNoteChoices : []
    const fallback = choices.length ? FormModel.inThisNoteAction(view.inThisNoteDefault, choices) : ""
    const choice = choices.length ? FormModel.inThisNoteAction(values.inThisNote, choices, fallback) : ""
    const labels: { [choice: string]: string } = view.inThisNoteLabels || {}
    const titles: { [choice: string]: string } = view.inThisNoteTitles || {}
    const backlinkLine = !editing ? String(view.backlinkText || "") : ""
    const backlink = backlinkLine ? (values.backlink === FormModel.BACKLINK_ADD ? FormModel.BACKLINK_ADD : FormModel.BACKLINK_NONE) : ""
    const open = editing ? "" : FormModel.openChoice(values.open, view.mobile)
    const noteTabsDefault: string = !editing && FormModel.noteTabsChoices().indexOf(view.noteTabsDefault) >= 0 ? String(view.noteTabsDefault) : ""
    const noteTabs: string = noteTabsDefault ? FormModel.noteTabsChoice(values.noteTabs, noteTabsDefault) : ""
    const island = islandJson({
        mode: mode,
        notebooks: view.notebooks.map(item => ({ id: item.id, path: item.path })),
        tags: view.tags,
        defaults: { type: type, notebookId: values.notebookId, dayStart: view.dayStart },
        pickerOpen: !!view.pickerOpen,
        inThisNote: choices.length ? { choices: choices, value: choice, fallback: fallback } : null,
        timing: view.timing || null,
    })
    // The stylesheet first, so nothing below it is ever laid out without it; on mobile the phone's width rule after it.
    const style = `<style id="jotFormStyle">${FORM_CSS}${view.mobile ? mobileWrapperCss(view.mobileWidth) : ""}</style>`
    // A hidden marker on mobile only, as Cockpit's #cockpitPlatform. The narrow layout itself is the form's -mobile class, in this markup (never a
    // viewport @media query, which would also match Joplin's measuring pass, and never a class the script adds once the dialog is already shown).
    const platformMarker = view.mobile ? '<div id="jotPlatform" hidden></div>' : ""
    // Note first, then To-do: the order of Cockpit's New note and New to-do buttons, and of Joplin's own.
    const typeRow = segmentRow("jotType", "type", "Type", [
        { value: FormModel.NOTE, label: "Note" },
        { value: FormModel.TODO, label: "To-do" },
    ], type)
    const inThisNoteRow = !choices.length ? "" : segmentRow("jotInThisNote", "inThisNote", "In this note", choices.map(value => ({
        value,
        label: labels[value] || value,
        title: titles[value] || labels[value] || value,
    })), choice, "-fill")
    const backlinkRow = !backlink ? "" : segmentRow("jotBacklink", "backlink", "Back link", [
        { value: FormModel.BACKLINK_ADD, label: FormModel.BACKLINK_LABELS.add, title: backlinkLine },
        { value: FormModel.BACKLINK_NONE, label: FormModel.BACKLINK_LABELS.none },
    ], backlink)
    const openRow = editing ? "" : segmentRow("jotOpen", "open", "Open", FormModel.openChoices(view.mobile).map((value: string) => ({
        value, label: FormModel.OPEN_LABELS[value], title: FormModel.OPEN_TITLES[value],
    })), open)
    const noteTabsRow = !noteTabs ? "" : segmentRow("jotNoteTabs", "noteTabs", "Note Tabs", FormModel.noteTabsChoices().map((value: string) => ({
        value, label: FormModel.NOTE_TABS_LABELS[value], title: FormModel.NOTE_TABS_TITLES[value],
    })), noteTabs)
    const textInput = 'autocomplete="off" autocorrect="off" autocapitalize="off"'
    // The textarea's content starts with a newline because the HTML parser drops one there: a Text that itself starts with an empty line keeps it.
    const textRow = editing ? "" : `
            <div class="jot-row jot-row-top">
                <label class="jot-label" for="jotBody">Text</label>
                <textarea name="body" id="jotBody" class="jot-input" rows="3" autocomplete="off" placeholder="Optional">\n${escapeHtml(values.body)}</textarea>
            </div>`
    const hint = view.mobile ? "" : `<span class="jot-hint" aria-hidden="true">Enter ${editing ? "saves" : "creates"} · Esc cancels</span>`

    return `
        ${style}
        ${platformMarker}
        <script type="application/json" id="jotFormData">${island}</script>
        <form name="jot" id="jotForm" class="jot-form${view.mobile ? " -mobile" : ""}${isNote ? " -note" : ""}" autocomplete="off">
            <div class="jot-head">
                <strong id="jotHeading" class="jot-heading">${escapeHtml(FormModel.headingFor(type, mode))}</strong>${hint}
            </div>${view.timing ? '\n            <div id="jotTiming" class="jot-timing"></div>' : ""}${typeRow}
            <div class="jot-row jot-row-top">
                <label class="jot-label" for="jotTitle">Title</label>
                <textarea name="title" id="jotTitle" class="jot-input jot-grow" rows="1" autocomplete="off" autofocus>\n${escapeHtml(values.title)}</textarea>
            </div>${textRow}
            <div class="jot-row">
                <label class="jot-label" for="jotNotebook">Notebook</label>
                <div class="jot-combo">
                    <input type="text" id="jotNotebook" class="jot-input" value="${escapeHtml(notebook ? notebook.path : "")}" ${textInput} spellcheck="false"
                        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="jotNotebookList">
                    <button type="button" id="jotNotebookOpen" class="jot-combo-open" tabindex="-1" aria-hidden="true">${CHEVRON_ICON}</button>
                </div>
                <input type="hidden" name="notebookId" id="jotNotebookId" value="${escapeHtml(values.notebookId)}">
            </div>
            <div class="jot-row jot-row-top">
                <label class="jot-label" for="jotTags">Tags</label>
                <textarea name="tags" id="jotTags" class="jot-input jot-grow" rows="1" ${textInput} spellcheck="false" placeholder="Comma separated"
                    role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="jotTagList">\n${escapeHtml(values.tags)}</textarea>
            </div>${inThisNoteRow}${backlinkRow}${openRow}${noteTabsRow}
            <div class="jot-row jot-due-row" id="jotDueRow">
                <span class="jot-label">Due</span>
                <span id="jotDueText" class="jot-due-text">${escapeHtml(FormModel.dueText(values.dueDate, values.dueTime))}</span>
                <button type="button" id="jotBell" class="jot-bell" title="Pick a date and time" aria-label="Pick a date and time"
                    aria-expanded="${view.pickerOpen ? "true" : "false"}" aria-controls="jotPicker"${isNote ? " disabled" : ""}>${BELL_ICON}</button>
                <button type="button" id="jotDueClear" class="jot-link"${hasDue ? "" : " hidden"}${isNote ? " disabled" : ""}>No date</button>
                <input type="hidden" name="dueDate" id="jotDueDate" value="${escapeHtml(values.dueDate)}">
                <input type="hidden" name="dueTime" id="jotDueTime" value="${escapeHtml(values.dueTime)}">
            </div>
            <div id="jotPicker" class="jot-picker"${view.pickerOpen && !isNote ? "" : " hidden"}>
                <div id="alarmFields">
                    <input id="alarmDate" placeholder="YYYY-MM-DD" value="${escapeHtml(values.dueDate)}" oninput="onAlarmDateEdited()"
                        inputmode="text" ${textInput} spellcheck="false">
                    <input id="alarmTime" placeholder="HH:MM" value="${escapeHtml(values.dueTime)}" oninput="onAlarmTimeEdited()"
                        inputmode="text" ${textInput} spellcheck="false">
                </div>
                <div id="alarmQuick">
                    <div class="alarm-quick-row">
                        <button type="button" onclick="onAlarmQuickToday()">Today</button>
                        <button type="button" onclick="onAlarmQuickTomorrow()">Tomorrow</button>
                        <button type="button" title="The nearest Saturday (today if today is Saturday)" onclick="onAlarmQuickWeekends()">Weekends</button>
                        <button type="button" title="The Monday after today" onclick="onAlarmQuickNextMonday()">Next Monday</button>
                    </div>
                    <div class="alarm-quick-row">
                        <button type="button" title="Add one hour (may cross midnight)" onclick="onAlarmQuickHour()">+hour</button>
                        <button type="button" title="Add one day" onclick="onAlarmQuickDay()">+day</button>
                        <button type="button" onclick="onAlarmQuickWeek()">+week</button>
                        <button type="button" title="Same weekday next month: the 2nd Sunday stays the 2nd Sunday" onclick="onAlarmQuickMonthWeekday()">+month(day)</button>
                        <button type="button" title="Same day-of-month next month: Jan 9 stays the 9th (Jan 31 clamps to the last day)" onclick="onAlarmQuickMonthDate()">+month(date)</button>
                    </div>
                </div>
                <div id="alarmBody" class="alarm-stretch-row">
                    <div id="alarmCalendar"></div>
                    <div id="alarmTimePanel">
                        <div class="alarm-time-col"><div class="alarm-time-scroll" id="alarmHourCol"></div></div>
                        <div class="alarm-time-col"><div class="alarm-time-scroll" id="alarmMinuteCol"></div></div>
                    </div>
                </div>
            </div>
            <div id="jotNotebookList" class="jot-suggest" role="listbox" aria-label="Notebooks" hidden></div>
            <div id="jotTagList" class="jot-suggest" role="listbox" aria-label="Tags" hidden></div>
        </form>
    `
}
