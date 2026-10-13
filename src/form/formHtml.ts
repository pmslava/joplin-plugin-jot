/** README ******************************************************************************************************************************************
 * The form's markup, built by the host on every open and handed to dialogs.setHtml (brief 4.1, 4.2). Pure: everything it shows comes in as data,    *
 * so the harness reads what it emits through the stubbed setHtml.                                                                                  *
 *                                                                                                                                                  *
 * EVERY FIELD IS IN THE INITIAL MARKUP. Joplin takes the dialog's first size from this markup before any script has run, and then re-measures it    *
 * live (a ResizeObserver on #joplin-plugin-content, 3.6.14), so a field added by script would open the dialog short and then make it jump. The       *
 * script only fills what does not change the size: the suggestion rows (absolutely positioned, out of the flow) and the calendar and time columns   *
 * of the picker (in a section that starts folded; unfolding it grows the dialog, which is the intent).                                             *
 *                                                                                                                                                  *
 * THE ISLAND. What the script needs and the markup does not show - the notebooks (id, path, sorted by path), the tag titles, the defaults (type,     *
 * notebook id, day start time) - travels in a <script type="application/json"> element, with every "<" written as < so no value can close it.  *
 * setHtml writes the markup through innerHTML, so the element is never executed, only read.                                                         *
 *                                                                                                                                                  *
 * THE SELECTORS are one-line segmented controls, one builder for all (segmentRow): Type (To-do, Note); In this note on the selection and trigger    *
 * routes (Replace with link, Keep text and, in the Markdown editor, Add link after; or Replace ++ with link and Remove ++ - short labels, the full    *
 * wording as each button's tooltip, the default first); Back link (Add, Don't add) when there is a note to link back to, the line it would add as    *
 * the Add button's tooltip; and Open (No, In editor, New window; no window on mobile). Each is a radiogroup of buttons over a hidden input named     *
 * after its field, so the form sends the choice. The island carries the In this note list and the starting choice with the route's default ({       *
 * choices, value, fallback }, null on the plain routes), so the markup and the island never disagree. Notebook and Tags stay text fields with their *
 * suggestion lists, and Due stays last, so unfolding its picker pushes nothing down.                                                              *
 *                                                                                                                                                  *
 * TITLE AND TAGS are textareas of one row (.jot-grow) only so they can wrap: formWebview.js grows them to three lines and then lets them scroll       *
 * (issue 4), keeps Enter from ever making a new line in them, and turns a pasted line break into a space. Their content starts with a newline, as  *
 * the Text's does, because the HTML parser drops one there.                                                                                         *
 *                                                                                                                                                  *
 * EDIT MODE (view.mode "edit", brief 4.5) is the same form for an existing note: the heading says Edit to-do or Edit note, and there is no Text    *
 * and no In this note row, so Type, Title, Notebook, Tags and Due remain. The island carries the mode, so the script's heading follows the Type    *
 * toggle in the edit wording.                                                                                                                      *
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
}

interface SegmentOption { value: string; label: string; title?: string }

/** Imports *****************************************************************************************************************************************/
const FormModel = require("./formModel")

/** Constants ***************************************************************************************************************************************/
// The chevron at the Notebook field's right edge, which opens the list: Material Design's "arrow_drop_down" glyph (Apache 2.0), inlined as the bell is.
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5z"/></svg>'
// The bell beside the Due row: Material Design's "notifications" glyph (Apache 2.0), inlined so it needs no icon font on either platform.
const BELL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">'
    + '<path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 '
    + '5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>'

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
 * One selector: a label, a radiogroup of buttons (one tab stop, the selected one; formWebview.js moves the choice with the arrow keys), and the     *
 * hidden input the form sends. `id` is the hidden input's id; the row is `${id}Row` and the label `${id}Label`.                                     *
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
    const island = islandJson({
        mode: mode,
        notebooks: view.notebooks.map(item => ({ id: item.id, path: item.path })),
        tags: view.tags,
        defaults: { type: type, notebookId: values.notebookId, dayStart: view.dayStart },
        pickerOpen: !!view.pickerOpen,
        inThisNote: choices.length ? { choices: choices, value: choice, fallback: fallback } : null,
    })
    // A hidden marker on mobile only, as Cockpit's #cockpitPlatform: the script mirrors it onto #joplin-plugin-content as the jot-mobile class,
    // which the narrow layout in form.css is gated on (never a viewport @media query, which would also match Joplin's measuring pass).
    const platformMarker = view.mobile ? '<div id="jotPlatform" hidden></div>' : ""
    const typeRow = segmentRow("jotType", "type", "Type", [
        { value: FormModel.TODO, label: "To-do" },
        { value: FormModel.NOTE, label: "Note" },
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
    const textInput = 'autocomplete="off" autocorrect="off" autocapitalize="off"'
    // The textarea's content starts with a newline because the HTML parser drops one there: a Text that itself starts with an empty line keeps it.
    const textRow = editing ? "" : `
            <div class="jot-row jot-row-top">
                <label class="jot-label" for="jotBody">Text</label>
                <textarea name="body" id="jotBody" class="jot-input" rows="3" autocomplete="off" placeholder="Optional">\n${escapeHtml(values.body)}</textarea>
            </div>`
    const hint = view.mobile ? "" : `<span class="jot-hint" aria-hidden="true">Enter ${editing ? "saves" : "creates"} · Esc cancels</span>`

    return `
        ${platformMarker}
        <script type="application/json" id="jotFormData">${island}</script>
        <form name="jot" id="jotForm" class="jot-form${isNote ? " -note" : ""}" autocomplete="off">
            <div class="jot-head">
                <strong id="jotHeading" class="jot-heading">${escapeHtml(FormModel.headingFor(type, mode))}</strong>${hint}
            </div>${typeRow}
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
            </div>${inThisNoteRow}${backlinkRow}${openRow}
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
