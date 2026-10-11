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
 * THE IN THIS NOTE ROW (the selection and trigger routes, after Tags and before Due): the buttons the host offers - on the selection route        *
 * Replace it with a link to the new note, Keep the text, and in the Markdown editor Add a link after it; on the trigger route Replace ++ with a    *
 * link to the new note and Remove ++, the trigger printed; the default first on both - drawn as radios in the Type toggle's pattern, with the choice in a hidden inThisNote. Their  *
 * labels come with them (inThisNoteLabels; the selection route's are formModel's SELECTION_LABELS). The island carries the same list and the        *
 * starting choice with the route's default ({ choices, value, fallback }, null on the plain routes), so the markup and the island never disagree.   *
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
}

export interface FormView {
    notebooks: FormNotebook[]
    tags: string[]
    values: FormValues
    dayStart: string
    mobile: boolean
    pickerOpen: boolean
    // The In this note buttons to draw, in order (formModel.selectionChoices or triggerChoices); empty or absent: no row.
    inThisNoteChoices?: string[]
    // Their labels by choice (formModel.triggerLabels on the trigger route); a choice without one shows its SELECTION_LABELS label.
    inThisNoteLabels?: { [choice: string]: string }
    // The route's default choice (formModel.SELECTION_DEFAULT or TRIGGER_DEFAULT): what a starting value the buttons do not offer reads as.
    inThisNoteDefault?: string
}

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

/** buildFormHtml ***********************************************************************************************************************************
 * The whole dialog markup for one open. `values` are the fields' starting values: the defaults on a fresh open, or what the user had typed when    *
 * the form is reopened after a refused Create (then `pickerOpen` shows the picker, so the date that was refused is in view).                        *
 ***************************************************************************************************************************************************/
export function buildFormHtml(view: FormView): string {
    const values = view.values
    const type = FormModel.normalizeType(values.type)
    const isNote = type === FormModel.NOTE
    const notebook = view.notebooks.find(item => item.id === values.notebookId)
    const hasDue = !!(String(values.dueDate || "").trim() || String(values.dueTime || "").trim())
    const choices: string[] = Array.isArray(view.inThisNoteChoices) ? view.inThisNoteChoices : []
    const fallback = choices.length ? FormModel.inThisNoteAction(view.inThisNoteDefault, choices) : ""
    const choice = choices.length ? FormModel.inThisNoteAction(values.inThisNote, choices, fallback) : ""
    const labels: { [choice: string]: string } = view.inThisNoteLabels || {}
    const island = islandJson({
        notebooks: view.notebooks.map(item => ({ id: item.id, path: item.path })),
        tags: view.tags,
        defaults: { type: type, notebookId: values.notebookId, dayStart: view.dayStart },
        pickerOpen: !!view.pickerOpen,
        inThisNote: choices.length ? { choices: choices, value: choice, fallback: fallback } : null,
    })
    // A hidden marker on mobile only, as Cockpit's #cockpitPlatform: the script mirrors it onto #joplin-plugin-content as the jot-mobile class,
    // which the narrow layout in form.css is gated on (never a viewport @media query, which would also match Joplin's measuring pass).
    const platformMarker = view.mobile ? '<div id="jotPlatform" hidden></div>' : ""
    const typeOption = (value: string, label: string) => {
        const selected = value === type
        return `<button type="button" class="jot-type-option${selected ? " -selected" : ""}" data-type="${value}" role="radio"`
            + ` aria-checked="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}">${label}</button>`
    }
    const choiceOption = (value: string) => {
        const selected = value === choice
        return `<button type="button" class="jot-choice-option${selected ? " -selected" : ""}" data-choice="${escapeHtml(value)}" role="radio"`
            + ` aria-checked="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}">${escapeHtml(labels[value] || FormModel.SELECTION_LABELS[value] || value)}</button>`
    }
    const inThisNoteRow = !choices.length ? "" : `
            <div class="jot-row jot-row-top" id="jotInThisNoteRow">
                <span class="jot-label" id="jotInThisNoteLabel">In this note</span>
                <div class="jot-choice" role="radiogroup" aria-labelledby="jotInThisNoteLabel">
                    ${choices.map(choiceOption).join("")}
                </div>
                <input type="hidden" name="inThisNote" id="jotInThisNote" value="${escapeHtml(choice)}">
            </div>`
    const textInput = 'autocomplete="off" autocorrect="off" autocapitalize="off"'
    // The textarea's content starts with a newline because the HTML parser drops one there: a Text that itself starts with an empty line keeps it.

    return `
        ${platformMarker}
        <script type="application/json" id="jotFormData">${island}</script>
        <form name="jot" id="jotForm" class="jot-form${isNote ? " -note" : ""}" autocomplete="off">
            <strong id="jotHeading" class="jot-heading">${escapeHtml(FormModel.headingFor(type))}</strong>
            <div class="jot-row">
                <span class="jot-label" id="jotTypeLabel">Type</span>
                <div class="jot-type" role="radiogroup" aria-labelledby="jotTypeLabel">
                    ${typeOption(FormModel.TODO, "To-do")}${typeOption(FormModel.NOTE, "Note")}
                </div>
                <input type="hidden" name="type" id="jotType" value="${type}">
            </div>
            <div class="jot-row">
                <label class="jot-label" for="jotTitle">Title</label>
                <input type="text" name="title" id="jotTitle" class="jot-input" value="${escapeHtml(values.title)}" autocomplete="off" autofocus>
            </div>
            <div class="jot-row jot-row-top">
                <label class="jot-label" for="jotBody">Text</label>
                <textarea name="body" id="jotBody" class="jot-input" rows="3" autocomplete="off">\n${escapeHtml(values.body)}</textarea>
            </div>
            <div class="jot-row">
                <label class="jot-label" for="jotNotebook">Notebook</label>
                <div class="jot-combo">
                    <input type="text" id="jotNotebook" class="jot-input" value="${escapeHtml(notebook ? notebook.path : "")}" ${textInput} spellcheck="false"
                        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="jotNotebookList">
                    <button type="button" id="jotNotebookOpen" class="jot-combo-open" tabindex="-1" aria-hidden="true">${CHEVRON_ICON}</button>
                </div>
                <input type="hidden" name="notebookId" id="jotNotebookId" value="${escapeHtml(values.notebookId)}">
            </div>
            <div class="jot-row">
                <label class="jot-label" for="jotTags">Tags</label>
                <input type="text" name="tags" id="jotTags" class="jot-input" value="${escapeHtml(values.tags)}" ${textInput} spellcheck="false"
                    role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="jotTagList">
            </div>${inThisNoteRow}
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
