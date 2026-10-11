/** README ******************************************************************************************************************************************
 * Every rule of Jot's form, in ONE pure module (brief 4.1): no DOM, no joplin, no clock of its own. The host (form.ts) requires it through webpack, *
 * the dialog loads it as a script (window.FormModel, for formWebview.js), and the Node harness requires it directly (module.exports), so the three   *
 * run the same decisions and every rule below is pinned by a check rather than by reading the source. UMD in the shape of Cockpit's noteMenu.js.    *
 *                                                                                                                                                  *
 * What is here: the dialog result's dispatch (which button), the form values read back from formData, the empty-title rule, the tag csv, the date   *
 * and time validation (Cockpit's parseAlarmFields), the due timestamp, the day start time, the notebook paths and the notebook default order, the    *
 * create plan the host executes, the selection route's rules (the title/text split, the In this note choices and their default, the link, the edit  *
 * the host makes in the note), the trigger route's (its two choices, their labels with the trigger printed, the answer the content script gets),     *
 * and the small helpers the dialog's glue asks (the heading, the Due row text, the suggestion lists, the tag token).                                *
 *                                                                                                                                                  *
 * CROSS-SCRIPT GLOBALS. In the dialog, window.SearchTokens (searchTokens.js, the filter rule copied from Cockpit) may load before or after this file:*
 * addScript appends plain <script> elements, which run in the order they finish loading. So it is looked up per call (searchTokens below), never     *
 * bound at load time.                                                                                                                              *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node harness and the host bundle (require)
    if (typeof window !== 'undefined') window.FormModel = api                        // the form dialog's iframe
    else if (root) root.FormModel = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    var TODO = 'todo'
    var NOTE = 'note'

    // The user-facing strings this module owns (brief section 5, word for word).
    var DUE_MESSAGE = 'Jot: the date must be YYYY-MM-DD and the time HH:MM (24-hour).'
    var NO_NOTEBOOK_MESSAGE = 'Jot: there is no notebook to create in.'
    var NO_DATE = 'No date'
    var DEFAULT_DAY_START = '09:00'

    // The In this note choices of the selection route (brief 4.4), their labels (section 5, word for word) and the order they are shown in.
    var KEEP = 'keep'
    var REPLACE = 'replace'
    var AFTER = 'after'
    var SELECTION_LABELS = {
        keep: 'Keep the text',
        replace: 'Replace it with a link to the new note',
        after: 'Add a link after it',
    }
    // The In this note choices of the trigger route (brief 4.4): remove the typed trigger, or replace it with the link; and the answer that says
    // nothing is to change. Their labels print the trigger itself (triggerLabels).
    var REMOVE = 'remove'
    var LINK = 'link'
    var CANCEL = 'cancel'
    // The title Joplin shows for a note whose title is empty, used as the link's text so a link to such a note is never invisible.
    var UNTITLED = 'Untitled'

    function text(value){ return value == null ? '' : String(value) }
    function pad2(value){ return String(value).padStart(2, '0') }
    function isoDate(date){ return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) }

    /** searchTokens ************************************************************************************************************************************
     * The filter rule's module, resolved at CALL time: window.SearchTokens in the dialog (whenever its script has run), require() in Node and in the    *
     * host bundle. Null when neither is there yet, in which case every row matches until the script arrives.                                            *
     ***************************************************************************************************************************************************/
    function searchTokens(){
        if (typeof window !== 'undefined' && window.SearchTokens) return window.SearchTokens
        if (typeof require === 'function'){
            try { return require('./searchTokens') } catch (error){ return null }
        }
        return null
    }

    function matches(label, filter){
        var tokens = searchTokens()
        return tokens ? tokens.matchesFilter(label, filter) : true
    }

    /** normalizeType / headingFor **********************************************************************************************************************
     * The form's two types, and the title line that follows the Type toggle.                                                                            *
     ***************************************************************************************************************************************************/
    function normalizeType(value, fallback){
        if (value === TODO || value === NOTE) return value
        return fallback === NOTE ? NOTE : TODO
    }

    function headingFor(type){
        return normalizeType(type) === NOTE ? 'New note' : 'New to-do'
    }

    /** dialogAction ************************************************************************************************************************************
     * What a dialog result asks for: 'create' (the ok button, which Enter in a text input also resolves to), 'createAndOpen' (the openAfter button), or *
     * 'none' for anything else (Cancel, Escape, a closed dialog, no result at all).                                                                      *
     ***************************************************************************************************************************************************/
    function dialogAction(result){
        var id = result && result.id
        if (id === 'ok') return 'create'
        if (id === 'openAfter') return 'createAndOpen'
        return 'none'
    }

    /** readFormValues **********************************************************************************************************************************
     * The form's fields as plain strings, from a dialog result's formData (the form is named "jot"). A missing field reads as empty, so a result from a  *
     * dialog that never rendered its form still gives a complete, harmless value set.                                                                    *
     ***************************************************************************************************************************************************/
    function readFormValues(formData, defaultType){
        var form = (formData && formData.jot) || {}
        return {
            type: normalizeType(form.type, defaultType),
            title: text(form.title),
            body: text(form.body),
            notebookId: text(form.notebookId),
            tags: text(form.tags),
            dueDate: text(form.dueDate),
            dueTime: text(form.dueTime),
            inThisNote: text(form.inThisNote),
        }
    }

    /** applyEmptyTitleRule *****************************************************************************************************************************
     * The empty-title rule (brief 4.2): an empty Title with Text takes the first non-empty line of the Text as the title and removes it from the body,  *
     * together with the blank lines around it, so the body starts at its next line of content. A Title of spaces only is empty. Both empty means there  *
     * is nothing to create. A non-empty Title leaves the body exactly as typed.                                                                          *
     ***************************************************************************************************************************************************/
    function applyEmptyTitleRule(title, body){
        var cleanTitle = text(title).trim()
        var cleanBody = text(body).replace(/\r\n?/g, '\n')
        if (cleanTitle) return { title: cleanTitle, body: cleanBody, nothing: false }
        var lines = cleanBody.split('\n')
        var index = 0
        while (index < lines.length && !lines[index].trim()) index++
        if (index >= lines.length) return { title: '', body: '', nothing: true }
        var rest = lines.slice(index + 1)
        while (rest.length && !rest[0].trim()) rest.shift()
        return { title: lines[index].trim(), body: rest.join('\n'), nothing: false }
    }

    /** parseTagCsv *************************************************************************************************************************************
     * The Tags field's comma-separated value as tag titles: each trimmed and lower-cased (Joplin compares tags that way), blanks dropped, duplicates    *
     * dropped, the first spelling's order kept. Cockpit's setNoteTagsFromCsv parses the same way.                                                       *
     ***************************************************************************************************************************************************/
    function parseTagCsv(csv){
        var seen = {}
        var titles = []
        var pieces = text(csv).split(',')
        for (var index = 0; index < pieces.length; index++){
            var title = pieces[index].trim().toLowerCase()
            if (!title || seen[title]) continue
            seen[title] = true
            titles.push(title)
        }
        return titles
    }

    /** parseDateTime ***********************************************************************************************************************************
     * Cockpit's parseAlarmFields (src/ui/alarm/alarm.ts): YYYY-MM-DD and HH:MM in 24 hours into a local Date, or null when they are not a real date and  *
     * time. The check against the constructed date catches values such as a 31st of February, which the Date constructor would roll into March.         *
     ***************************************************************************************************************************************************/
    function parseDateTime(dateString, timeString){
        var dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text(dateString).trim())
        var timeMatch = /^(\d{1,2}):(\d{2})$/.exec(text(timeString).trim())
        if (!dateMatch || !timeMatch) return null
        var year = Number(dateMatch[1]), month = Number(dateMatch[2]), day = Number(dateMatch[3])
        var hours = Number(timeMatch[1]), minutes = Number(timeMatch[2])
        if (hours > 23 || minutes > 59) return null
        var parsed = new Date(year, month - 1, day, hours, minutes, 0, 0)
        if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null
        return parsed
    }

    /** parseDayStart / dayStartText ********************************************************************************************************************
     * The day start time setting as { hours, minutes } and as HH:MM, falling back to 09:00 when it cannot be read (as Cockpit's getDayStartTime does).  *
     ***************************************************************************************************************************************************/
    function parseDayStart(value){
        var match = /^(\d{1,2}):(\d{2})$/.exec(text(value).trim())
        if (!match) return { hours: 9, minutes: 0 }
        return { hours: Math.min(23, Number(match[1])), minutes: Math.min(59, Number(match[2])) }
    }

    function dayStartText(value){
        var start = parseDayStart(value)
        return pad2(start.hours) + ':' + pad2(start.minutes)
    }

    /** dueTimestamp ************************************************************************************************************************************
     * The to-do's todo_due from the Due fields: 0 when both are empty (no date); the date at the day start time when only the date is there (a date      *
     * picked before any time); the local timestamp of date + time otherwise. null when the fields cannot be read: a time without a date, or anything      *
     * parseDateTime refuses. null is what makes the host refuse Create with DUE_MESSAGE.                                                                 *
     ***************************************************************************************************************************************************/
    function dueTimestamp(dateString, timeString, dayStart){
        var date = text(dateString).trim()
        var time = text(timeString).trim()
        if (!date && !time) return 0
        if (!date) return null
        var parsed = parseDateTime(date, time || dayStartText(dayStart))
        return parsed ? parsed.getTime() : null
    }

    /** dueText *****************************************************************************************************************************************
     * What the Due row shows: the date and time ("2026-10-14 09:00"), or "No date".                                                                       *
     ***************************************************************************************************************************************************/
    function dueText(dateString, timeString){
        var shown = (text(dateString).trim() + ' ' + text(timeString).trim()).trim()
        return shown || NO_DATE
    }

    /** dueAfterDatePick / dueAfterTimePick *************************************************************************************************************
     * What the Due fields become after a pick in the picker. A date picked before any time takes the day start time; a time picked before any date     *
     * lands today (the picker's calendar starts on today's month, as Cockpit's does).                                                                    *
     ***************************************************************************************************************************************************/
    function dueAfterDatePick(current, date, dayStart){
        var time = text(current && current.time).trim()
        return { date: text(date).trim(), time: time || dayStartText(dayStart) }
    }

    function dueAfterTimePick(current, time, now){
        var date = text(current && current.date).trim()
        return { date: date || isoDate(now || new Date()), time: text(time).trim() }
    }

    /** buildNotebookPaths ******************************************************************************************************************************
     * Every notebook as { id, path }, the path built from the parent chain ("Work / Projects"), sorted by path: case-insensitively first, then by the  *
     * exact spelling, so the order is the same on every platform. A notebook in the trash (deleted_time set) is left out. The guard stops a corrupted    *
     * parent chain from looping forever (Cockpit's getNotebookMap).                                                                                      *
     ***************************************************************************************************************************************************/
    function buildNotebookPaths(folders){
        var byId = {}
        var list = Array.isArray(folders) ? folders : []
        for (var index = 0; index < list.length; index++){
            if (list[index] && list[index].id) byId[list[index].id] = list[index]
        }
        var notebooks = []
        for (var id in byId){
            var folder = byId[id]
            if (folder.deleted_time) continue
            var titles = [text(folder.title)]
            var parent = byId[folder.parent_id]
            var guard = 0
            while (parent && guard++ < 32){
                titles.unshift(text(parent.title))
                parent = byId[parent.parent_id]
            }
            notebooks.push({ id: id, path: titles.join(' / ') })
        }
        notebooks.sort(function(a, b){
            var x = a.path.toLowerCase(), y = b.path.toLowerCase()
            if (x !== y) return x < y ? -1 : 1
            if (a.path !== b.path) return a.path < b.path ? -1 : 1
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
        })
        return notebooks
    }

    /** defaultNotebookId *******************************************************************************************************************************
     * The notebook the form starts on (brief 4.2): the caller's notebook id when given; otherwise the notebook of the note the editor holds; otherwise  *
     * the notebook the app is showing; otherwise the first by path. A candidate that is not among the notebooks (gone, in the trash) is passed over.     *
     * null only when there is no notebook at all.                                                                                                        *
     ***************************************************************************************************************************************************/
    function defaultNotebookId(notebooks, candidates){
        var list = Array.isArray(notebooks) ? notebooks : []
        var known = {}
        for (var index = 0; index < list.length; index++) known[list[index].id] = true
        var spec = candidates || {}
        var order = [
            spec.callerNotebookId,
            spec.editorNote && spec.editorNote.parent_id,
            spec.shownFolder && spec.shownFolder.id,
        ]
        for (var step = 0; step < order.length; step++){
            if (order[step] && known[order[step]]) return order[step]
        }
        return list.length ? list[0].id : null
    }

    /** planCreate **************************************************************************************************************************************
     * Turns a dialog result into what the host does, with no I/O, so every rule is decided here:                                                        *
     *   { kind: 'none' }       Cancel, Escape, or a result with no button.                                                                              *
     *   { kind: 'nothing' }    Create with an empty Title and an empty Text: nothing is created, the form just closes.                                  *
     *   { kind: 'invalidDue' } a to-do whose Due fields cannot be read: Create is refused with DUE_MESSAGE and the form reopens with its values.        *
     *   { kind: 'create', note, tags, open }  the POST notes payload, the tag titles to attach, and whether to open the note (Create and open).         *
     * Create and open with both fields empty creates the empty note and opens it (Joplin's own New note, one step later). A note has no due date, so   *
     * its Due fields are neither read nor validated (switching to Note clears nothing in the form, but writes none of it). options: { defaultType,       *
     * dayStart, notebookId, inThisNoteChoices } - the type a result without one reads as, the day start time, the notebook used when the form sent none,*
     * and the In this note choices the form offered (the selection and trigger routes). The plan's inThisNote is the choice to apply, one of those      *
     * offered (anything else reads as the first offered), or null on a route that offered none.                                                          *
     ***************************************************************************************************************************************************/
    function planCreate(result, options){
        var settings = options || {}
        var action = dialogAction(result)
        if (action === 'none') return { kind: 'none' }
        var values = readFormValues(result && result.formData, settings.defaultType)
        var named = applyEmptyTitleRule(values.title, values.body)
        if (named.nothing && action === 'create') return { kind: 'nothing', values: values }
        var isTodo = values.type === TODO
        var due = isTodo ? dueTimestamp(values.dueDate, values.dueTime, settings.dayStart) : 0
        if (due === null) return { kind: 'invalidDue', values: values }
        var choices = Array.isArray(settings.inThisNoteChoices) ? settings.inThisNoteChoices : []
        return {
            kind: 'create',
            values: values,
            open: action === 'createAndOpen',
            inThisNote: choices.length ? inThisNoteAction(values.inThisNote, choices) : null,
            note: {
                parent_id: values.notebookId || text(settings.notebookId),
                is_todo: isTodo ? 1 : 0,
                title: named.title,
                body: named.body,
                todo_due: due,
            },
            tags: parseTagCsv(values.tags),
        }
    }

    /** splitSelection **********************************************************************************************************************************
     * The selection route's prefill (brief 4.4, open question 1): the selection's first non-empty line, trimmed, is the Title, and the lines after it,  *
     * with the blank lines that lead them dropped, are the Text, as typed. The empty-title rule's split, applied to the selection. A selection that is   *
     * not a string, is empty or holds only whitespace is `empty`: the host then takes the plain route, as if nothing were highlighted.                  *
     ***************************************************************************************************************************************************/
    function splitSelection(selection){
        if (typeof selection !== 'string') return { title: '', body: '', empty: true }
        var named = applyEmptyTitleRule('', selection)
        return { title: named.title, body: named.body, empty: named.nothing }
    }

    /** selectionChoices / inThisNoteAction **************************************************************************************************************
     * The In this note buttons the selection route offers: Keep, Replace and Add after in the Markdown editor; Keep and Replace in the Rich Text editor,*
     * where the selection comes back as plain text and writing it back would lose its formatting. inThisNoteAction is the choice that holds among the   *
     * buttons offered, on either route: the value when it is one of them, otherwise the first offered (keep on the selection route, remove on the       *
     * trigger route). It is the form's default (from the choice remembered last time) and what a create applies. selectionAction is its first name.    *
     ***************************************************************************************************************************************************/
    function selectionChoices(markdownEditor){
        return markdownEditor ? [KEEP, REPLACE, AFTER] : [KEEP, REPLACE]
    }

    function inThisNoteAction(value, choices){
        var list = Array.isArray(choices) ? choices : []
        if (list.indexOf(value) >= 0) return value
        return list.length ? list[0] : KEEP
    }

    /** triggerChoices / triggerLabels / triggerAnswer ***************************************************************************************************
     * The trigger route's In this note row (brief 4.4 and section 5): Remove ++ (the default until another is remembered) and Replace ++ with a link to *
     * the new note, with the trigger the user typed printed in both labels. triggerAnswer is what the content script gets back once the form closes:    *
     * { action: 'remove' }, { action: 'link', link } with the Markdown link to the new note, or { action: 'cancel' } when nothing was created (Cancel,   *
     * Escape, an empty Create) or no choice of the two was made. The content script applies remove and link to the document; cancel changes nothing.   *
     ***************************************************************************************************************************************************/
    function triggerChoices(){
        return [REMOVE, LINK]
    }

    function triggerLabels(trigger){
        var shown = text(trigger)
        var labels = {}
        labels[REMOVE] = 'Remove ' + shown
        labels[LINK] = 'Replace ' + shown + ' with a link to the new note'
        return labels
    }

    function triggerAnswer(choice, link){
        if (choice === REMOVE) return { action: REMOVE }
        if (choice === LINK && text(link)) return { action: LINK, link: text(link) }
        return { action: CANCEL }
    }

    /** noteLink ****************************************************************************************************************************************
     * The link to a note, as Joplin's own Note.markdownTag writes it: [Title](:/id), with "[" and "]" in the title escaped. An empty title is linked as  *
     * "Untitled", the name Joplin shows for it, so the link never renders as nothing.                                                                    *
     ***************************************************************************************************************************************************/
    function noteLink(title, id){
        var shown = text(title) || UNTITLED
        return '[' + shown.replace(/(\[|\])/g, '\\$1') + '](:/' + text(id) + ')'
    }

    /** selectionEdit ***********************************************************************************************************************************
     * The edit the host makes in the note the selection came from, after the new note exists: { command, text } for joplin.commands.execute, or null.   *
     *   keep     null: the note is not touched.                                                                                                          *
     *   replace  insertText with the link. In the Markdown editor insertText replaces the selection; in the Rich Text editor it renders the Markdown    *
     *            and replaces the selection with the result (3.6.14).                                                                                    *
     *   after    replaceSelection with the selection, then the link: after a space when the selection is one line, on a line of its own when it spans   *
     *            several. The Markdown editor only (selectionChoices never offers it in the Rich Text editor, where replaceSelection takes HTML).        *
     * A selection that ends with a line break (a triple-clicked line in CodeMirror ends at the next line's start) keeps that break after the link, so   *
     * the text that followed the selection stays on its own line.                                                                                       *
     ***************************************************************************************************************************************************/
    function selectionEdit(action, selection, link){
        var source = text(selection)
        var trailing = /\r?\n$/.exec(source)
        var lineBreak = trailing ? trailing[0] : ''
        var core = source.slice(0, source.length - lineBreak.length)
        if (action === REPLACE) return { command: 'insertText', text: link + lineBreak }
        if (action === AFTER) return { command: 'replaceSelection', text: core + (/\n/.test(core) ? '\n' : ' ') + link + lineBreak }
        return null
    }

    /** Suggestion lists ********************************************************************************************************************************
     * The Notebook field and the Tags field each show a list under them while typing, narrowed by the filter rule (window.SearchTokens.matchesFilter).  *
     * The glue holds the DOM; these decide the rows, the highlight and what a pick writes.                                                               *
     ***************************************************************************************************************************************************/

    // The notebooks whose path survives the filter, in their (path) order.
    function notebookSuggestions(notebooks, filter){
        var list = Array.isArray(notebooks) ? notebooks : []
        var out = []
        for (var index = 0; index < list.length; index++){
            if (matches(list[index].path, filter)) out.push(list[index])
        }
        return out
    }

    // The comma-separated token around the caret in the Tags field: { start, end, value }, start and end bounding the token's text without the
    // spaces around it (an empty token sits at the caret).
    function tagTokenAt(csv, caret){
        var source = text(csv)
        var at = Math.max(0, Math.min(Number(caret), source.length))
        if (!Number.isFinite(at)) at = source.length
        var start = at > 0 ? source.lastIndexOf(',', at - 1) + 1 : 0
        var end = source.indexOf(',', at)
        if (end < 0) end = source.length
        while (start < end && /\s/.test(source.charAt(start))) start++
        while (end > start && /\s/.test(source.charAt(end - 1))) end--
        return { start: start, end: end, value: source.slice(start, end) }
    }

    // The tag titles to offer for the token being typed: those the filter keeps, minus the ones already in the field (other than the token itself).
    // An empty token offers nothing, so the list only opens while a tag is being typed.
    function tagSuggestions(tags, csv, token){
        var spec = token || tagTokenAt(csv, text(csv).length)
        if (!text(spec.value).trim()) return []
        var source = text(csv)
        var present = {}
        var others = parseTagCsv(source.slice(0, spec.start) + ',' + source.slice(spec.end))
        for (var index = 0; index < others.length; index++) present[others[index]] = true
        var list = Array.isArray(tags) ? tags : []
        var out = []
        for (var row = 0; row < list.length; row++){
            var title = text(list[row])
            if (!title || present[title.toLowerCase()]) continue
            if (matches(title, spec.value)) out.push(title)
        }
        return out
    }

    // The Tags field after picking `title` for `token`: only the token's span is replaced. At the end of the field a ", " follows, so the next tag
    // can be typed straight away; in the middle the comma that already follows is kept. Returns { value, caret }, the caret just after the title.
    function applyTagPick(csv, token, title){
        var source = text(csv)
        var head = source.slice(0, token.start)
        var tail = source.slice(token.end)
        var picked = text(title)
        if (/^\s*$/.test(tail)) return { value: head + picked + ', ', caret: (head + picked + ', ').length }
        return { value: head + picked + tail, caret: (head + picked).length }
    }

    // The next highlighted row after an arrow key: wraps at both ends; from no highlight, down enters at the first row and up at the last.
    function moveHighlight(count, current, delta){
        if (!(count > 0)) return -1
        if (!(current >= 0 && current < count)) return delta < 0 ? count - 1 : 0
        return ((current + delta) % count + count) % count
    }

    // The row a list highlights as it opens, which Enter picks: the one whose label is exactly what was typed (case and the spaces around it aside),
    // else the first row; -1 with no rows. The rows match by substring and come in alphabetical order, so without this "work" typed in full would
    // highlight "homework" above it, and Enter would pick a tag the user did not type.
    function exactIndex(labels, typed){
        var wanted = text(typed).trim().toLowerCase()
        if (!wanted) return -1
        for (var index = 0; index < labels.length; index++) if (text(labels[index]).trim().toLowerCase() === wanted) return index
        return -1
    }

    function suggestionHighlight(labels, typed){
        var list = Array.isArray(labels) ? labels : []
        if (!list.length) return -1
        var exact = exactIndex(list, typed)
        return exact >= 0 ? exact : 0
    }

    // The same for the Notebook list, whose rows show paths: a path typed in full, else a notebook's own name (the path's last part) typed in full,
    // so "projects" highlights "Work / Projects" rather than an "Old Projects" sorted above it; else the first row.
    function notebookHighlight(notebooks, typed){
        var list = Array.isArray(notebooks) ? notebooks : []
        if (!list.length) return -1
        var paths = list.map(function(item){ return text(item && item.path) })
        var exact = exactIndex(paths, typed)
        if (exact < 0) exact = exactIndex(paths.map(function(path){ return path.split(' / ').pop() }), typed)
        return exact >= 0 ? exact : 0
    }

    return {
        TODO: TODO,
        NOTE: NOTE,
        DUE_MESSAGE: DUE_MESSAGE,
        NO_NOTEBOOK_MESSAGE: NO_NOTEBOOK_MESSAGE,
        NO_DATE: NO_DATE,
        DEFAULT_DAY_START: DEFAULT_DAY_START,
        KEEP: KEEP,
        REPLACE: REPLACE,
        AFTER: AFTER,
        SELECTION_LABELS: SELECTION_LABELS,
        REMOVE: REMOVE,
        LINK: LINK,
        CANCEL: CANCEL,
        normalizeType: normalizeType,
        headingFor: headingFor,
        dialogAction: dialogAction,
        readFormValues: readFormValues,
        applyEmptyTitleRule: applyEmptyTitleRule,
        parseTagCsv: parseTagCsv,
        parseDateTime: parseDateTime,
        parseDayStart: parseDayStart,
        dayStartText: dayStartText,
        dueTimestamp: dueTimestamp,
        dueText: dueText,
        dueAfterDatePick: dueAfterDatePick,
        dueAfterTimePick: dueAfterTimePick,
        buildNotebookPaths: buildNotebookPaths,
        defaultNotebookId: defaultNotebookId,
        planCreate: planCreate,
        splitSelection: splitSelection,
        selectionChoices: selectionChoices,
        inThisNoteAction: inThisNoteAction,
        selectionAction: inThisNoteAction,
        triggerChoices: triggerChoices,
        triggerLabels: triggerLabels,
        triggerAnswer: triggerAnswer,
        noteLink: noteLink,
        selectionEdit: selectionEdit,
        notebookSuggestions: notebookSuggestions,
        tagTokenAt: tagTokenAt,
        tagSuggestions: tagSuggestions,
        applyTagPick: applyTagPick,
        moveHighlight: moveHighlight,
        suggestionHighlight: suggestionHighlight,
        notebookHighlight: notebookHighlight,
    }
})
