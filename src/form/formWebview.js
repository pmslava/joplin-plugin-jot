/** README ******************************************************************************************************************************************
 * The DOM glue of Jot's form dialog (brief 4.1, 4.2). The markup is the host's (formHtml.ts, written with dialogs.setHtml on every open); every     *
 * decision is formModel.js's (window.FormModel) and every quick-button date is alarmQuick.js's (window.AlarmQuick, copied from Cockpit). This file   *
 * wires them to the fields and keeps five things in step: the Type toggle and the heading, the suggestion lists of Notebook and Tags, the Due row,  *
 * the picker folded behind the bell (Cockpit's alarmWebview.js, ported, single to-do), and on the selection and trigger routes In this note.      *
 *                                                                                                                                                  *
 * WHY A MutationObserver. setHtml writes new markup into a document whose scripts have already run, and does not run them again; a reopened dialog   *
 * may also be a fresh document where this file runs after the markup. So the form is wired whenever a form appears that is not wired yet (a marker  *
 * attribute on the form), from the observer and from the first run below - Cockpit's bootstrap, for the same reason. Everything the wiring needs     *
 * is read from the markup and its JSON island, never kept from a previous open.                                                                     *
 *                                                                                                                                                  *
 * GLOBALS AT CALL TIME. The dialog's scripts run in the order they finish loading, so window.FormModel and window.AlarmQuick are looked up when       *
 * they are used (model() and the AlarmQuick.* calls inside handlers), never bound when this file loads.                                             *
 *                                                                                                                                                  *
 * THE KEYBOARD AND THE HOST. Joplin's own script in the dialog submits the form (the Create button, id ok) on Enter in any <input type=text>, from a *
 * document-level keydown listener in the bubble phase that ignores defaultPrevented, and cancels it on Escape. Enter inside an open suggestion list  *
 * must pick the row and not create, so the list's input handles keydown on itself (the target phase) and calls stopPropagation and preventDefault;  *
 * the host's listener never sees that press. Escape is taken the same way while a list is open, and closes only the list; with no list open it is   *
 * left to the host, which cancels the form. Enter in the Text is a newline, which the host does not touch.                                         *
 ***************************************************************************************************************************************************/

/** State of the current open **********************************************************************************************************************/
// The island of the current open: { mode: 'create' | 'edit', notebooks: [{id, path}], tags: [title], defaults: { type, notebookId, dayStart },
// pickerOpen, inThisNote: { choices, value, fallback } on the selection and trigger routes, else null }.
var jotData = { mode: 'create', notebooks: [], tags: [], defaults: {}, pickerOpen: false, inThisNote: null }
// The open suggestion list: { kind: 'notebook'|'tag', input, list, rows, highlight, token, moved }, or null when none is open. moved is whether the
// user went to the highlighted row with the arrow keys (formModel.pickOnLeave).
var jotSuggest = null

/** State of the picker (ported from alarmWebview.js) **********************************************************************************************/
// The first day of the month the calendar shows. Reset from the Due date every time the picker unfolds.
var alarmCalendarAnchor = null
// Whether the to-do already had a due time when the form opened (edit mode's prefill, or a reopen after a refused Create or Save), and whether
// the user has set the time this session. Together they decide preservedTime: a quick button keeps the shown clock time when either is true.
var alarmHadExistingAlarm = false
var alarmTimeUserSet = false

function model(){
    return window.FormModel
}

function jotById(id){
    return document.getElementById(id)
}

function jotForm(){
    return document.querySelector('form[name="jot"]')
}

function jotDayStart(){
    return model().dayStartText(jotData.defaults && jotData.defaults.dayStart)
}

function readJotData(){
    var node = jotById('jotFormData')
    var data = {}
    if (node){
        try { data = JSON.parse(node.textContent || '{}') || {} } catch (error){ data = {} }
    }
    return {
        mode: data.mode === 'edit' ? 'edit' : 'create',
        notebooks: Array.isArray(data.notebooks) ? data.notebooks : [],
        tags: Array.isArray(data.tags) ? data.tags : [],
        defaults: data.defaults || {},
        pickerOpen: !!data.pickerOpen,
        inThisNote: data.inThisNote && Array.isArray(data.inThisNote.choices) ? data.inThisNote : null,
        timing: data.timing && typeof data.timing === 'object' ? data.timing : null,
    }
}

/** Selectors ***************************************************************************************************************************************
 * Every selector is a .jot-seg radiogroup (formHtml.ts, segmentRow): Type, In this note, Back link and Open. One tab stop, the selected button; the *
 * arrow keys move the choice, wrapping at both ends; the hidden input named after the group's data-field carries it, so Create sends it and a      *
 * refused Create reopens on it. setJotSeg is the one writer. A value the group does not offer resolves as each selector's rule says: Type as       *
 * formModel.normalizeType; In this note to the route's default when drawn (the island's fallback: replace on the selection route, link on the      *
 * trigger route, both drawn first), else the first button - formModel.inThisNoteAction's rule; the others to their first button.                 *
 ***************************************************************************************************************************************************/
function jotSegGroup(field){
    var form = jotForm()
    return form ? form.querySelector('.jot-seg[data-field="' + field + '"]') : null
}

function jotSegOptions(group){
    return group ? group.querySelectorAll('.jot-seg-option') : []
}

function jotSegInput(group){
    var field = group && group.getAttribute('data-field')
    return field && group.parentNode ? group.parentNode.querySelector('input[name="' + field + '"]') : null
}

function resolveJotSeg(field, options, value){
    var offered = []
    for (var index = 0; index < options.length; index++) offered.push(options[index].getAttribute('data-value'))
    if (field === 'type') return model().normalizeType(value)
    if (offered.indexOf(value) >= 0) return value
    var fallback = field === 'inThisNote' && jotData.inThisNote ? jotData.inThisNote.fallback : null
    if (fallback && offered.indexOf(fallback) >= 0) return fallback
    return offered.length ? offered[0] : ''
}

function setJotSeg(field, value){
    var group = jotSegGroup(field)
    if (!group) return ''
    var options = jotSegOptions(group)
    var resolved = resolveJotSeg(field, options, value)
    var input = jotSegInput(group)
    if (input) input.value = resolved
    for (var index = 0; index < options.length; index++){
        var selected = options[index].getAttribute('data-value') === resolved
        options[index].classList.toggle('-selected', selected)
        options[index].setAttribute('aria-checked', selected ? 'true' : 'false')
        options[index].setAttribute('tabindex', selected ? '0' : '-1')
    }
    if (field === 'type') applyJotType(resolved)
    return resolved
}

function onJotSegClick(event){
    var option = event.target && event.target.closest ? event.target.closest('.jot-seg-option') : null
    var group = option && option.closest('.jot-seg')
    if (!option || !group) return
    setJotSeg(group.getAttribute('data-field'), option.getAttribute('data-value'))
    option.focus()
}

function onJotSegKeyDown(event){
    var delta = (event.key === 'ArrowDown' || event.key === 'ArrowRight') ? 1 : ((event.key === 'ArrowUp' || event.key === 'ArrowLeft') ? -1 : 0)
    if (!delta) return
    event.preventDefault()
    var group = event.currentTarget
    var options = jotSegOptions(group)
    var input = jotSegInput(group)
    var current = -1
    for (var index = 0; index < options.length; index++) if (input && options[index].getAttribute('data-value') === input.value) current = index
    var next = model().moveHighlight(options.length, current, delta)
    if (next < 0) return
    setJotSeg(group.getAttribute('data-field'), options[next].getAttribute('data-value'))
    options[next].focus()
}

/** Type *******************************************************************************************************************************************
 * The heading follows the type in the wording of the form's mode (the island's: New to-do / New note, or Edit to-do / Edit note), and a note greys *
 * the Due row: its bell and No date are disabled and the picker folds. Nothing is cleared, so switching back restores the row.                     *
 ***************************************************************************************************************************************************/
function setJotType(type){
    return setJotSeg('type', type)
}

function applyJotType(type){
    var form = jotForm()
    if (!form) return
    var isNote = type === model().NOTE
    jotById('jotHeading').textContent = model().headingFor(type, jotData.mode)
    form.classList.toggle('-note', isNote)
    jotById('jotBell').disabled = isNote
    jotById('jotDueClear').disabled = isNote
    if (isNote) setJotPickerOpen(false)
}

/** In this note ***********************************************************************************************************************************
 * The selection and trigger routes: the choice of what happens to the highlighted text or the typed trigger, a selector like the others.           *
 ***************************************************************************************************************************************************/
function setJotInThisNote(choice){
    return setJotSeg('inThisNote', choice)
}

/** Due row ****************************************************************************************************************************************
 * The hidden dueDate and dueTime are what the form sends; the text beside the bell shows them ("No date" when empty); the picker's two inputs mirror *
 * them. writeJotDue is the one writer: every pick and every keystroke in the picker's inputs goes through it, so the row is always what Create sends.*
 * An input is only rewritten when its value differs, so typing in it keeps the caret where it is.                                                   *
 ***************************************************************************************************************************************************/
function currentJotDue(){
    return { date: jotById('jotDueDate').value, time: jotById('jotDueTime').value }
}

function writeJotDue(date, time){
    var pairs = [['jotDueDate', date], ['jotDueTime', time], ['alarmDate', date], ['alarmTime', time]]
    for (var index = 0; index < pairs.length; index++){
        var input = jotById(pairs[index][0])
        if (input && input.value !== pairs[index][1]) input.value = pairs[index][1]
    }
    jotById('jotDueText').textContent = model().dueText(date, time)
    var clear = jotById('jotDueClear')
    if (String(date || '').trim() || String(time || '').trim()) clear.removeAttribute('hidden')
    else clear.setAttribute('hidden', '')
}

function onJotDueClear(){
    writeJotDue('', '')
    alarmTimeUserSet = false
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

/** setJotPickerOpen *******************************************************************************************************************************
 * Folds or unfolds the picker. Unfolding starts the calendar on the Due date's month (today's when there is none) and redraws the time columns, so   *
 * their scroll positions are taken while they are visible. The dialog grows and shrinks with it: Joplin measures the content live.                 *
 ***************************************************************************************************************************************************/
function setJotPickerOpen(open){
    var picker = jotById('jotPicker')
    var bell = jotById('jotBell')
    if (!picker || !bell) return
    if (!open){
        picker.setAttribute('hidden', '')
        bell.setAttribute('aria-expanded', 'false')
        return
    }
    var due = currentJotDue()
    writeJotDue(due.date, due.time)
    picker.removeAttribute('hidden')
    bell.setAttribute('aria-expanded', 'true')
    alarmCalendarAnchor = null
    renderAlarmCalendar()
    renderAlarmTimeColumns()
}

function onJotBellClick(){
    var picker = jotById('jotPicker')
    setJotPickerOpen(!!(picker && picker.hasAttribute('hidden')))
}

/** Suggestion lists *******************************************************************************************************************************
 * Notebook, a combobox: focusing or clicking the field, or its chevron, opens the whole list with the picked notebook highlighted and in view;       *
 * typing narrows it. The rows are the notebooks whose path survives the filter (the text typed); a pick writes the path into the input and the id    *
 * into the hidden notebookId. The typed text is only a filter: on leaving the field with no row taken it goes back to the picked notebook's path,    *
 * and Enter with no row left to pick does nothing, so a note is never created in a notebook other than the one the field (or its list) shows.        *
 * Tags: the rows are the tag titles matching the comma-separated token being typed, minus those already in the field; a pick replaces that token     *
 * only. The csv is the value, so a tag that does not exist yet is simply typed and is created on Create. The list opens as one types; focusing the   *
 * empty field opens every tag with none highlighted (formModel.tagListOnFocus), so Enter still creates there.                                        *
 * Leaving a field while its list is open (Tab, a click on Create or on another field) takes the highlighted row first when formModel.pickOnLeave     *
 * says so: in Notebook when a filter is typed or the user arrowed to the row, in Tags only when the user arrowed to it. Escape closes the list       *
 * alone.                                                                                                                                             *
 * Both lists sit in the form (position: relative) out of the flow, under their input when the form has room below it, else over it, capped to that   *
 * room: the form's size, which is what Joplin measures, never changes.                                                                               *
 ***************************************************************************************************************************************************/
function jotNotebookPath(id){
    var notebooks = jotData.notebooks
    for (var index = 0; index < notebooks.length; index++) if (notebooks[index].id === id) return notebooks[index].path
    return ''
}

function closeJotSuggest(){
    if (!jotSuggest) return
    jotSuggest.list.setAttribute('hidden', '')
    jotSuggest.list.textContent = ''
    jotSuggest.input.setAttribute('aria-expanded', 'false')
    jotSuggest = null
}

function openJotSuggest(kind, input, list, rows, highlight, token){
    if (jotSuggest && jotSuggest.list !== list) closeJotSuggest()
    if (!rows.length){
        if (jotSuggest) closeJotSuggest()
        return
    }
    jotSuggest = { kind: kind, input: input, list: list, rows: rows, highlight: highlight, token: token || null, moved: false }
    list.textContent = ''
    for (var index = 0; index < rows.length; index++){
        var row = document.createElement('div')
        row.className = 'jot-suggest-row' + (index === highlight ? ' -highlighted' : '')
        row.setAttribute('role', 'option')
        row.setAttribute('data-index', String(index))
        row.textContent = kind === 'notebook' ? rows[index].path : rows[index]
        list.appendChild(row)
    }
    list.removeAttribute('hidden')
    input.setAttribute('aria-expanded', 'true')
    placeJotSuggest(input, list)
    scrollJotHighlight()
}

// Puts the list under its input, or over it when the form has more room there, with a height capped to that room.
function placeJotSuggest(input, list){
    var form = jotForm()
    var formBox = form.getBoundingClientRect()
    var inputBox = input.getBoundingClientRect()
    var below = formBox.bottom - inputBox.bottom - 2
    var above = inputBox.top - formBox.top - 2
    var wanted = Math.min(list.scrollHeight + 2, 168)
    list.style.left = (inputBox.left - formBox.left) + 'px'
    list.style.width = inputBox.width + 'px'
    if (below >= wanted || below >= above){
        list.style.top = (inputBox.bottom - formBox.top + 2) + 'px'
        list.style.bottom = ''
        list.style.maxHeight = Math.max(0, Math.min(168, below)) + 'px'
    } else {
        list.style.top = ''
        list.style.bottom = (formBox.bottom - inputBox.top + 2) + 'px'
        list.style.maxHeight = Math.max(0, Math.min(168, above)) + 'px'
    }
}

function scrollJotHighlight(){
    if (!jotSuggest) return
    var rows = jotSuggest.list.children
    for (var index = 0; index < rows.length; index++){
        var on = index === jotSuggest.highlight
        rows[index].classList.toggle('-highlighted', on)
        if (on && rows[index].scrollIntoView) rows[index].scrollIntoView({ block: 'nearest' })
    }
}

// `leaving`: the pick is made as the field loses the focus, so the selection and the caret are not touched.
function pickJotSuggest(index, leaving){
    if (!jotSuggest || index < 0 || index >= jotSuggest.rows.length) return
    var current = jotSuggest
    var row = current.rows[index]
    closeJotSuggest()
    if (current.kind === 'notebook'){
        jotById('jotNotebookId').value = row.id
        current.input.value = row.path
        if (!leaving) current.input.select()
    } else {
        var picked = model().applyTagPick(current.input.value, current.token, row)
        current.input.value = picked.value
        sizeJotGrow(current.input)
        if (!leaving) current.input.setSelectionRange(picked.caret, picked.caret)
    }
}

// The field `input` loses the focus: its open list is picked from (formModel.pickOnLeave) or closed.
function leaveJotSuggest(input){
    if (!jotSuggest || jotSuggest.input !== input) return
    var typed = jotSuggest.kind === 'notebook' ? (notebookTextIsFilter() ? input.value : '') : (jotSuggest.token ? jotSuggest.token.value : '')
    var spec = { highlight: jotSuggest.highlight, count: jotSuggest.rows.length, typed: typed, moved: jotSuggest.moved }
    if (model().pickOnLeave(jotSuggest.kind, spec)) pickJotSuggest(jotSuggest.highlight, true)
    else closeJotSuggest()
}

// showAll: the whole list, the picked notebook highlighted and scrolled into view (formModel.notebookListAll); otherwise the rows the typed filter
// leaves, the notebook typed in full highlighted when there is one (formModel.notebookHighlight), so Enter picks what was typed.
function showNotebookSuggestions(showAll){
    var input = jotById('jotNotebook')
    var list = jotById('jotNotebookList')
    if (showAll){
        var all = model().notebookListAll(jotData.notebooks, jotById('jotNotebookId').value)
        openJotSuggest('notebook', input, list, all.rows, all.highlight)
        return
    }
    var rows = model().notebookSuggestions(jotData.notebooks, input.value)
    openJotSuggest('notebook', input, list, rows, model().notebookHighlight(rows, input.value))
}

function showTagSuggestions(){
    var input = jotById('jotTags')
    var caret = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length
    var token = model().tagTokenAt(input.value, caret)
    var rows = model().tagSuggestions(jotData.tags, input.value, token)
    // The tag typed in full is highlighted when it is a row (formModel.suggestionHighlight), so Enter never swaps it for a longer one sorted above.
    openJotSuggest('tag', input, jotById('jotTagList'), rows, model().suggestionHighlight(rows, token.value), token)
}

// The notebook field is "being filtered" while its text is not the picked notebook's path.
function notebookTextIsFilter(){
    return jotById('jotNotebook').value !== jotNotebookPath(jotById('jotNotebookId').value)
}

function onJotSuggestKeyDown(event){
    // A key that ends an input method's composition (Enter included) belongs to the composition, not to the list.
    if (event.isComposing) return
    var input = event.currentTarget
    var kind = input.id === 'jotNotebook' ? 'notebook' : 'tag'
    var open = jotSuggest && jotSuggest.input === input
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp'){
        event.preventDefault()
        if (!open){
            if (kind === 'notebook') showNotebookSuggestions(!notebookTextIsFilter())
            else showTagSuggestions()
            return
        }
        jotSuggest.highlight = model().moveHighlight(jotSuggest.rows.length, jotSuggest.highlight, event.key === 'ArrowDown' ? 1 : -1)
        jotSuggest.moved = true
        scrollJotHighlight()
        return
    }
    if (event.key === 'Escape'){
        // An open list takes Escape and closes, the form stays; a notebook filter goes back to the notebook picked. With no list open the host
        // hears the press and cancels the form.
        if (!open) return
        event.preventDefault()
        event.stopPropagation()
        closeJotSuggest()
        if (kind === 'notebook' && notebookTextIsFilter()){
            input.value = jotNotebookPath(jotById('jotNotebookId').value)
            input.select()
        }
        return
    }
    if (event.key === 'Enter'){
        if (open && jotSuggest.highlight >= 0){
            event.preventDefault()
            event.stopPropagation()
            pickJotSuggest(jotSuggest.highlight)
            return
        }
        // A notebook filter with nothing left to pick: swallowed, so Create cannot land in a notebook the field no longer shows.
        if (kind === 'notebook' && notebookTextIsFilter()){
            event.preventDefault()
            event.stopPropagation()
        }
        return
    }
    if (open && kind === 'tag' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End')){
        // The caret leaves the token the list was made for, so a pick would replace the wrong text: the list closes.
        closeJotSuggest()
        return
    }
    if (event.key === 'Tab'){
        // Tab leaves the field: the highlighted row is taken as on any other way out (formModel.pickOnLeave), before the focus moves.
        if (open) leaveJotSuggest(input)
    }
}

function onJotNotebookInput(){
    jotNotebookSelectOnMouseUp = false
    showNotebookSuggestions(false)
}

// Entering the Notebook field selects its text, so typing starts a filter at once, and opens the whole list. A click would put the caret back
// where the pointer was on its mouseup, so the first mouseup after the focus selects again.
var jotNotebookSelectOnMouseUp = false

function onJotNotebookFocus(event){
    event.currentTarget.select()
    jotNotebookSelectOnMouseUp = true
    showNotebookSuggestions(!notebookTextIsFilter())
}

// A click in the field (already focused, its list closed by a pick or by Escape) opens the list again.
function onJotNotebookClick(event){
    if (jotSuggest && jotSuggest.input === event.currentTarget) return
    showNotebookSuggestions(!notebookTextIsFilter())
}

// The chevron: a press gives the field the focus (its focus opens the list) or, when it has it, opens the list. The press itself never takes the
// focus (preventDefault), so the field is not left and its list not closed on the way.
function onJotNotebookOpenMouseDown(event){
    event.preventDefault()
    var input = jotById('jotNotebook')
    if (document.activeElement !== input){
        input.focus()
        // The mouseup lands on the chevron, not in the field: nothing to re-select there.
        jotNotebookSelectOnMouseUp = false
    }
    if (!(jotSuggest && jotSuggest.input === input)) showNotebookSuggestions(!notebookTextIsFilter())
}

function onJotNotebookMouseUp(event){
    if (!jotNotebookSelectOnMouseUp) return
    jotNotebookSelectOnMouseUp = false
    event.preventDefault()
    event.currentTarget.select()
}

function onJotNotebookBlur(event){
    jotNotebookSelectOnMouseUp = false
    leaveJotSuggest(event.currentTarget)
    if (notebookTextIsFilter()) event.currentTarget.value = jotNotebookPath(jotById('jotNotebookId').value)
}

function onJotTagsInput(){
    showTagSuggestions()
}

// Focusing the empty Tags field offers every tag, none highlighted (formModel.tagListOnFocus); with a tag typed it opens nothing.
function onJotTagsFocus(event){
    var input = event.currentTarget
    var opening = model().tagListOnFocus(jotData.tags, input.value)
    if (opening.rows.length) openJotSuggest('tag', input, jotById('jotTagList'), opening.rows, opening.highlight, model().tagTokenAt(input.value, 0))
}

// A click moves the caret off the token the list was made for, as the arrow keys do.
function onJotTagsMouseDown(event){
    if (jotSuggest && jotSuggest.input === event.currentTarget) closeJotSuggest()
}

function onJotTagsBlur(event){
    leaveJotSuggest(event.currentTarget)
}

// A press on a row must not take the focus from the input (which would close the list before the click lands).
function onJotSuggestMouseDown(event){
    event.preventDefault()
}

function onJotSuggestClick(event){
    var row = event.target && event.target.closest ? event.target.closest('.jot-suggest-row') : null
    if (!row || !jotSuggest) return
    pickJotSuggest(Number(row.getAttribute('data-index')))
}

/** The picker: quick buttons (ported from alarmWebview.js) ****************************************************************************************
 * Two rows: the absolute dates (Today / Tomorrow / Weekends / Next Monday) and the accumulating increments (+hour / +day / +week / +month(day) /     *
 * +month(date)). The date and time math is window.AlarmQuick's; these wrappers read the fields and write the result into the Due row at once. A      *
 * single to-do only: Cockpit's multi-to-do plan, mode and explanation line are not part of Jot.                                                     *
 ***************************************************************************************************************************************************/
function alarmPad(value){
    return String(value).padStart(2, '0')
}

function alarmDateToISO(date){
    return `${date.getFullYear()}-${alarmPad(date.getMonth() + 1)}-${alarmPad(date.getDate())}`
}

function alarmParseISO(value){
    var match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim())
    if (!match) return null
    var parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (parsed.getFullYear() !== Number(match[1]) || parsed.getMonth() !== Number(match[2]) - 1 || parsed.getDate() !== Number(match[3])) return null
    return parsed
}

// The date the +week / +month buttons walk forward from: the date field's value, or today when it is empty or invalid.
function alarmBaseDate(){
    return alarmParseISO(jotById('alarmDate').value) || new Date()
}

// The clock time a quick button should keep ({hours,minutes}), or null when it should take ceilHour(now): non-null only when the to-do had a
// due time when the form opened, or the user set the time.
function alarmPreservedTime(){
    if (!alarmHadExistingAlarm && !alarmTimeUserSet) return null
    var time = currentAlarmTime()
    if (time.hours === null || time.minutes === null) return null
    return { hours: time.hours, minutes: time.minutes }
}

// Writes an AlarmQuick { date, time } into the Due row and re-syncs the calendar month and the time highlight.
function applyAlarmQuick(result){
    writeJotDue(result.date, result.time)
    var parsed = alarmParseISO(result.date)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

function alarmAccumulatorPress(key){
    var now = new Date(), base = alarmBaseDate(), preserved = alarmPreservedTime()
    if (key === 'hours') return AlarmQuick.hour(now, base, preserved)
    if (key === 'days') return AlarmQuick.day(now, base, preserved)
    if (key === 'weeks') return AlarmQuick.week(now, base, preserved)
    if (key === 'monthsDay') return AlarmQuick.monthWeekday(now, base, preserved)
    return AlarmQuick.monthDate(now, base, preserved)
}

function runAlarmAccumulator(key){
    applyAlarmQuick(alarmAccumulatorPress(key))
    if (key === 'hours') alarmTimeUserSet = true    // so the next +hour keeps this time and compounds
}

function onAlarmQuickToday(){ applyAlarmQuick(AlarmQuick.today(new Date())) }
function onAlarmQuickTomorrow(){ applyAlarmQuick(AlarmQuick.tomorrow(new Date(), alarmPreservedTime())) }
function onAlarmQuickWeekends(){ applyAlarmQuick(AlarmQuick.weekends(new Date(), alarmPreservedTime())) }
function onAlarmQuickNextMonday(){ applyAlarmQuick(AlarmQuick.monday(new Date(), alarmPreservedTime())) }

function onAlarmQuickHour(){ runAlarmAccumulator('hours') }
function onAlarmQuickDay(){ runAlarmAccumulator('days') }
function onAlarmQuickWeek(){ runAlarmAccumulator('weeks') }
function onAlarmQuickMonthWeekday(){ runAlarmAccumulator('monthsDay') }
function onAlarmQuickMonthDate(){ runAlarmAccumulator('monthsDate') }

/** The picker: calendar (ported from alarmWebview.js) *********************************************************************************************
 * Monday-first, English month names, always six weeks so the height never changes between months. A day picked before any time takes the day start *
 * time (formModel.dueAfterDatePick).                                                                                                               *
 ***************************************************************************************************************************************************/
function onAlarmCalendarNavigate(delta){
    alarmCalendarAnchor = new Date(alarmCalendarAnchor.getFullYear(), alarmCalendarAnchor.getMonth() + delta, 1)
    renderAlarmCalendar()
}

function pickAlarmDay(isoDate){
    var due = model().dueAfterDatePick(currentJotDue(), isoDate, jotDayStart())
    writeJotDue(due.date, due.time)
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

// Typing in the date input: the Due row follows every keystroke, and the calendar follows a date it can read. A readable date typed before any
// time takes the day start time, as a picked one does.
function onAlarmDateEdited(){
    var typed = jotById('alarmDate').value
    var parsed = alarmParseISO(typed)
    var time = jotById('alarmTime').value
    if (parsed && !String(time).trim()) time = jotDayStart()
    writeJotDue(typed, time)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

function renderAlarmCalendar(){
    var container = jotById('alarmCalendar')
    if (!container) return
    var selected = alarmParseISO(jotById('alarmDate').value)
    if (!alarmCalendarAnchor){
        var base = selected || new Date()
        alarmCalendarAnchor = new Date(base.getFullYear(), base.getMonth(), 1)
    }
    var anchor = alarmCalendarAnchor
    var title = anchor.toLocaleDateString('en', { month: 'long', year: 'numeric' })
    var todayISO = alarmDateToISO(new Date())
    var selectedISO = selected ? alarmDateToISO(selected) : null

    var firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    var day = new Date(firstOfMonth)
    day.setDate(firstOfMonth.getDate() - ((firstOfMonth.getDay() + 6) % 7))
    // Always six weeks, so the dialog height never changes while navigating between months
    var end = new Date(day)
    end.setDate(day.getDate() + 41)

    var headers = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(label => `<th>${label}</th>`).join('')
    var rows = '', cells = '', column = 0
    while (day <= end){
        var iso = alarmDateToISO(day)
        var classes = ['alarm-cal-day']
        if (day.getMonth() !== anchor.getMonth()) classes.push('-outside')
        if (iso === todayISO) classes.push('-today')
        if (iso === selectedISO) classes.push('-selected')
        cells += `<td><button type="button" class="${classes.join(' ')}" data-date="${iso}" onclick="pickAlarmDay('${iso}')">${day.getDate()}</button></td>`
        if (++column === 7){
            rows += `<tr>${cells}</tr>`
            cells = ''
            column = 0
        }
        day.setDate(day.getDate() + 1)
    }

    container.innerHTML = `
        <div class="alarm-cal-nav">
            <button type="button" title="Previous month" onclick="onAlarmCalendarNavigate(-1)">&#8249;</button>
            <span class="alarm-cal-title">${title}</span>
            <button type="button" title="Next month" onclick="onAlarmCalendarNavigate(1)">&#8250;</button>
        </div>
        <table class="alarm-cal-grid"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
    `
}

/** The picker: time columns (ported from alarmWebview.js) *****************************************************************************************
 * Hours 00-23 and minutes 00-59. A pick writes the Due row; a time picked before any date lands today (formModel.dueAfterTimePick).                 *
 ***************************************************************************************************************************************************/
function currentAlarmTime(){
    var match = /^(\d{1,2}):(\d{2})$/.exec(String(jotById('alarmTime').value || '').trim())
    if (!match) return { hours: null, minutes: null }
    var hours = Number(match[1]), minutes = Number(match[2])
    return { hours: hours <= 23 ? hours : null, minutes: minutes <= 59 ? minutes : null }
}

function writeAlarmTime(time){
    var due = model().dueAfterTimePick(currentJotDue(), time, new Date())
    writeJotDue(due.date, due.time)
    alarmTimeUserSet = true
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

function pickAlarmHour(hours){
    var time = currentAlarmTime()
    writeAlarmTime(`${alarmPad(hours)}:${alarmPad(time.minutes === null ? 0 : time.minutes)}`)
}

function pickAlarmMinute(minutes){
    var time = currentAlarmTime()
    var hours = time.hours === null ? model().parseDayStart(jotDayStart()).hours : time.hours
    writeAlarmTime(`${alarmPad(hours)}:${alarmPad(minutes)}`)
}

// Typing in the time input: the Due row follows every keystroke; a readable time typed before any date lands today, as a picked one does.
function onAlarmTimeEdited(){
    alarmTimeUserSet = true
    var typed = jotById('alarmTime').value
    var date = jotById('alarmDate').value
    if (currentAlarmTime().hours !== null && currentAlarmTime().minutes !== null) date = model().dueAfterTimePick({ date: date }, typed, new Date()).date
    writeJotDue(date, typed)
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

// Moves the -selected highlight to the buttons matching the time field, without rebuilding the columns, so the scroll positions stay put.
function updateAlarmTimeSelection(){
    var time = currentAlarmTime()
    for (var button of document.querySelectorAll('.alarm-time-item')){
        var isHour = button.dataset.hour !== undefined
        var value = Number(isHour ? button.dataset.hour : button.dataset.minute)
        button.classList.toggle('-selected', value === (isHour ? time.hours : time.minutes))
    }
}

function renderAlarmTimeColumns(){
    var hourColumn = jotById('alarmHourCol')
    var minuteColumn = jotById('alarmMinuteCol')
    if (!hourColumn || !minuteColumn) return
    var hourButtons = '', minuteButtons = ''
    for (var hour = 0; hour < 24; hour++){
        hourButtons += `<button type="button" class="alarm-time-item" data-hour="${hour}" onclick="pickAlarmHour(${hour})">${alarmPad(hour)}</button>`
    }
    for (var minute = 0; minute < 60; minute++){
        minuteButtons += `<button type="button" class="alarm-time-item" data-minute="${minute}" onclick="pickAlarmMinute(${minute})">${alarmPad(minute)}</button>`
    }
    hourColumn.innerHTML = hourButtons
    minuteColumn.innerHTML = minuteButtons
    updateAlarmTimeSelection()
    // Start with the chosen hour and minute (else the day start time) in the middle of their columns
    var time = currentAlarmTime()
    var start = model().parseDayStart(jotDayStart())
    scrollAlarmColumn(hourColumn, time.hours === null ? start.hours : time.hours, 24)
    scrollAlarmColumn(minuteColumn, time.minutes === null ? start.minutes : time.minutes, 60)
}

function scrollAlarmColumn(column, index, total){
    column.scrollTop = Math.max(0, (column.scrollHeight * index / total) - (column.clientHeight / 2))
}

/** applyJotPlatformClass **************************************************************************************************************************
 * On mobile the markup carries the #jotPlatform marker; mirror it onto the persistent #joplin-plugin-content wrapper as the jot-mobile class, which   *
 * the narrow layout in form.css is gated on. Add-only and gated on the marker, so on desktop the wrapper is never touched (Cockpit's pattern).        *
 ***************************************************************************************************************************************************/
function applyJotPlatformClass(){
    if (!jotById('jotPlatform')) return
    var wrapper = jotById('joplin-plugin-content')
    if (!wrapper) return
    wrapper.classList.add('jot-mobile')
    wrapper.style.width = jotMobileWidth() + 'px'
}

/** jotMobileWidth **********************************************************************************************************************************
 * The form's width on mobile, from the SCREEN, never from the viewport. Joplin mobile sizes a fit-to-content dialog to its content's measured width  *
 * (PluginDialogWebView.tsx, re-measured every 500 ms by useDialogSize, capped at 97% of the window), and the webview inside the dialog is the        *
 * dialog's width - so a width taken from the viewport (it was calc(100vw - 16px)) made the content 16px narrower than the dialog, the dialog then   *
 * 16px narrower, and so on at every measurement: the form shrank on the phone until it was a sliver. The screen's width does not change with the     *
 * dialog, so this is measured once per layout and holds still: 94% of it (inside Joplin's 97% cap), at most the desktop's 440px, at least 240px.    *
 ***************************************************************************************************************************************************/
function jotMobileWidth(){
    var screenWidth = window.screen && Number(window.screen.width)
    if (!screenWidth || !isFinite(screenWidth)) screenWidth = 360
    return Math.max(240, Math.min(440, Math.floor(screenWidth * 0.94)))
}

/** Enter with no title ****************************************************************************************************************************
 * Joplin submits the form on Enter in any text input (its own keydown listener on the dialog's document, in the bubble phase). With the Title empty  *
 * that would close the form having created nothing (in edit mode, save a note called Untitled), so that Enter is kept from Joplin and the Title gets  *
 * the focus instead. The listener sits on the form, in the bubble phase, so an open suggestion list takes its own Enter first (its handler stops     *
 * the event at the input). Enter in the Text is a new line and never reaches here as a submit; Create clicked with the mouse still applies the       *
 * empty-title rule.                                                                                                                                *
 ***************************************************************************************************************************************************/
function onJotFormKeyDown(event){
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
    var target = event.target
    if (!target) return
    var grows = isJotGrow(target)
    if (target.tagName !== 'INPUT' && !grows) return
    var title = jotById('jotTitle')
    var titleEmpty = !title || !String(title.value).trim()
    // A one-line input with a title: Joplin's own listener submits. Title and Tags are textareas, which Joplin leaves alone, so they submit here.
    if (!titleEmpty && !grows) return
    event.stopPropagation()
    event.preventDefault()
    if (titleEmpty){
        if (title) title.focus()
        return
    }
    submitJotForm()
}

// The form's submit event, which Joplin's own submit listener answers with Create (or Save).
function submitJotForm(){
    var form = jotForm()
    if (!form) return
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/** Enter anywhere else ***************************************************************************************************************************
 * Joplin submits on Enter only in a text input (UserWebviewIndex.js, 3.6.14 and 3.7.21). After a pick in the picker the focus is on the calendar    *
 * day, the time or the quick button just clicked - or on nothing at all, once the calendar redraws under the click - and a segment or the bell can   *
 * hold it too; there Joplin does nothing with Enter, and a button would take it as a click. So Enter there submits the form as well, as the         *
 * heading's hint says, through the form's submit event, which Joplin's own submit listener answers with Create (or Save); Space still presses a    *
 * button. With the Title empty it focuses the Title, as Enter in a text input does. Text inputs are Joplin's (above), the Text keeps Enter as a new   *
 * line, and an Enter something else has already taken (defaultPrevented) is left alone. On the window, in the bubble phase: last of all.            *
 ***************************************************************************************************************************************************/
function onJotWindowKeyDown(event){
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
    var tag = event.target && event.target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    var form = jotForm()
    if (!form || form.getAttribute('data-jot-ready') !== '1') return
    event.preventDefault()
    var title = jotById('jotTitle')
    if (title && !String(title.value).trim()){
        title.focus()
        return
    }
    submitJotForm()
}

/** Title and Tags: growing fields ******************************************************************************************************************
 * Issue 4: a long title or a long list of tags (the note you are in can bring a dozen) was hidden past the field's edge. Title and Tags are         *
 * textareas of one row that grow with what they hold, to three lines; past three they scroll, and the scrollbar says there is more. sizeJotGrow      *
 * measures the content at the one-line height and sets the height, capped; the dialog grows with it (Joplin measures it live), as it does when the *
 * picker unfolds - and nothing here depends on the dialog's own size, so it cannot feed back (the Android width loop of 0.2.0). A tag list open      *
 * under Tags follows it.                                                                                                                            *
 *                                                                                                                                                  *
 * They stay one-line fields in every other way: Enter never makes a new line (onJotFormKeyDown), a pasted line break becomes a space (a title or a  *
 * tag has none; the browser hands a textarea's value over with \n only, so the swap keeps the caret where it was), and the keyboard puts the caret   *
 * at the end - Tab into the field, as into an email's recipients, ready to add to it, where a one-line input would have selected everything (the    *
 * first keystroke then replaced every tag of the note you are in). A click leaves the caret where it lands.                                         *
 ***************************************************************************************************************************************************/
var JOT_GROW_LINES = 3

function isJotGrow(element){
    return !!(element && element.tagName === 'TEXTAREA' && element.classList && element.classList.contains('jot-grow'))
}

function sizeJotGrow(field){
    if (!field || !field.style || typeof window.getComputedStyle !== 'function') return
    var style = window.getComputedStyle(field)
    var borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
    var padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    var line = parseFloat(style.lineHeight) || 18
    var floor = Math.ceil(line + padding + borders)
    var cap = Math.ceil(line * JOT_GROW_LINES + padding + borders)
    // At the one-line height first, so scrollHeight measures the content rather than the height it had.
    field.style.height = floor + 'px'
    var wanted = field.scrollHeight + borders
    field.style.height = Math.max(floor, Math.min(cap, wanted)) + 'px'
    field.style.overflowY = wanted > cap + 1 ? 'auto' : 'hidden'
    if (jotSuggest && jotSuggest.input === field) placeJotSuggest(field, jotSuggest.list)
}

function sizeJotGrowAll(){
    var form = jotForm()
    if (!form) return
    var fields = form.querySelectorAll('textarea.jot-grow')
    for (var index = 0; index < fields.length; index++) sizeJotGrow(fields[index])
}

function onJotGrowInput(event){
    var field = event.currentTarget
    if (field.value.indexOf('\n') >= 0){
        var start = field.selectionStart, end = field.selectionEnd
        field.value = field.value.replace(/\n/g, ' ')
        try { field.setSelectionRange(start, end) } catch (error){}
    }
    sizeJotGrow(field)
}

// A press puts the caret where it lands: the flag lives only through the press's own task, in which the focus event fires.
function onJotGrowPointerDown(event){
    var field = event.currentTarget
    field.jotPointerFocus = true
    setTimeout(function(){ field.jotPointerFocus = false }, 0)
}

function onJotGrowFocus(event){
    var field = event.currentTarget
    if (field.jotPointerFocus) return
    jotCaretToEnd(field)
    // Again once the focus has settled, in case the browser selected the field's text after this handler.
    setTimeout(function(){ if (document.activeElement === field && !field.jotPointerFocus) jotCaretToEnd(field) }, 0)
}

function jotCaretToEnd(field){
    var end = field.value.length
    try { field.setSelectionRange(end, end) } catch (error){}
    field.scrollTop = field.scrollHeight
}

/** showJotTiming **********************************************************************************************************************************
 * A test build's line under the heading (core/timing.ts): from the tap to this script running, then each part - the plugin's (selection,         *
 * settings, lists, form, dialog) and the dialog showing itself, from setHtml to now. Both clocks are the device's wall clock.                       *
 ***************************************************************************************************************************************************/
function showJotTiming(){
    var line = jotById('jotTiming')
    var timing = jotData.timing
    if (!line || !timing) return
    var now = Date.now()
    var seconds = function(ms){ return (Math.max(0, ms) / 1000).toFixed(2) }
    var parts = (timing.parts || []).map(function(part){ return part[0] + ' ' + seconds(part[1]) })
    parts.push('show ' + seconds(now - timing.htmlAt))
    line.textContent = 'Opened in ' + seconds(now - timing.start) + ' s: ' + parts.join(', ')
}

/** focusJotTitle **********************************************************************************************************************************
 * The Title has the focus on open, so typing goes there, Enter creates and Shift+Tab reaches the Type toggle. autofocus in the markup only counts     *
 * while a document is parsing, and this markup arrives later, so the focus is given here - and once more when the dialog's frame itself receives the *
 * focus (Joplin focuses it when the dialog is ready), in case that came after.                                                                       *
 ***************************************************************************************************************************************************/
function focusJotTitle(){
    var title = jotById('jotTitle')
    if (!title) return
    title.focus()
    var end = title.value.length
    try { title.setSelectionRange(end, end) } catch (error){}
}

function onJotWindowFocus(){
    var form = jotForm()
    if (!form || form.getAttribute('data-jot-ready') !== '1') return
    if (!document.activeElement || document.activeElement === document.body) focusJotTitle()
}

/** initJotFormIfNeeded ****************************************************************************************************************************
 * Wires one freshly written form, exactly once (the data-jot-ready marker on the form element, so a reopen - a new form element - is wired again).  *
 ***************************************************************************************************************************************************/
function initJotFormIfNeeded(){
    applyJotPlatformClass()
    var form = jotForm()
    if (!form || form.getAttribute('data-jot-ready') === '1') return
    if (!window.FormModel){
        // formModel.js has not run yet; its own load does not touch the DOM, so try again shortly rather than wait for a mutation.
        setTimeout(initJotFormIfNeeded, 20)
        return
    }
    form.setAttribute('data-jot-ready', '1')
    jotData = readJotData()
    jotSuggest = null
    alarmCalendarAnchor = null
    alarmTimeUserSet = false
    var due = currentJotDue()
    alarmHadExistingAlarm = !!(String(due.date).trim() && String(due.time).trim())

    var groups = form.querySelectorAll('.jot-seg')
    for (var group = 0; group < groups.length; group++){
        groups[group].addEventListener('click', onJotSegClick)
        groups[group].addEventListener('keydown', onJotSegKeyDown)
    }

    var notebook = jotById('jotNotebook')
    notebook.addEventListener('input', onJotNotebookInput)
    notebook.addEventListener('keydown', onJotSuggestKeyDown)
    notebook.addEventListener('focus', onJotNotebookFocus)
    notebook.addEventListener('click', onJotNotebookClick)
    notebook.addEventListener('mouseup', onJotNotebookMouseUp)
    notebook.addEventListener('blur', onJotNotebookBlur)
    jotById('jotNotebookOpen').addEventListener('mousedown', onJotNotebookOpenMouseDown)

    var growing = form.querySelectorAll('textarea.jot-grow')
    for (var grow = 0; grow < growing.length; grow++){
        growing[grow].addEventListener('input', onJotGrowInput)
        growing[grow].addEventListener('pointerdown', onJotGrowPointerDown)
        growing[grow].addEventListener('focus', onJotGrowFocus)
    }

    var tags = jotById('jotTags')
    tags.addEventListener('input', onJotTagsInput)
    tags.addEventListener('keydown', onJotSuggestKeyDown)
    tags.addEventListener('mousedown', onJotTagsMouseDown)
    tags.addEventListener('focus', onJotTagsFocus)
    tags.addEventListener('blur', onJotTagsBlur)

    var lists = [jotById('jotNotebookList'), jotById('jotTagList')]
    for (var index = 0; index < lists.length; index++){
        lists[index].addEventListener('mousedown', onJotSuggestMouseDown)
        lists[index].addEventListener('click', onJotSuggestClick)
    }

    if (jotById('jotInThisNote')) setJotInThisNote(jotById('jotInThisNote').value)

    jotById('jotBell').addEventListener('click', onJotBellClick)
    jotById('jotDueClear').addEventListener('click', onJotDueClear)
    // A real submission would navigate the iframe away; Joplin's own listener on the document still hears the event and runs Create.
    form.addEventListener('submit', function(event){ event.preventDefault() })
    form.addEventListener('keydown', onJotFormKeyDown)

    setJotType(jotById('jotType').value)
    showJotTiming()
    sizeJotGrowAll()
    writeJotDue(due.date, due.time)
    renderAlarmCalendar()
    if (!jotById('jotPicker').hasAttribute('hidden')) setJotPickerOpen(true)
    focusJotTitle()
}

window.addEventListener('focus', onJotWindowFocus)
window.addEventListener('keydown', onJotWindowKeyDown)
window.addEventListener('resize', sizeJotGrowAll)
new MutationObserver(initJotFormIfNeeded).observe(document.documentElement, { childList: true, subtree: true })
if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initJotFormIfNeeded)
} else {
    initJotFormIfNeeded()
}
