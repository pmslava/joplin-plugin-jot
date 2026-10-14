// Jot harness (phases 1 to 4).
//
// Runner and assertion frame follow joplin-plugin-cockpit's test/run.js: a tiny homemade runner over
// Node's assert, a failures counter, a final "All checks passed" / "N failing check(s)" line, and
// process.exit(failures ? 1 : 0). Checks are numbered in the order they run, so a failure report can
// name one by its number. `npm test` builds first (npm run dist), so dist/ and publish/ are fresh here.
//
// What is checked: the version quadruple, the manifest's identity, the build's outputs (the .jpl, the
// content script kept free of a bundled CodeMirror, the form dialog's five files), the compiled bundle
// driven against a stubbed `joplin` on desktop and mobile (the commands, the menu item, the settings, the
// toolbar gate, and the form's host handler: the dialog, its markup, the POST payloads, the tags, the
// opens; the selection route: the prefill, the In this note row and its memory, the edit in the editor and
// its place in the call order; the typed trigger: the content script's registration and the plugin's handler
// of its messages; edit mode and jot.open's arguments: the second dialog, the prefill, the one PUT of what
// changed, the tag diff, the note list's item), every rule of the pure src/form/formModel.js and src/form/triggerRule.js, the content
// script itself run in Node against a real CodeMirror EditorState (a stand-in for the view: there is no DOM
// here), the copies from Cockpit, the dialog glue's shape, and the sandbox proxy rule over every source file.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PUBLISH = path.join(ROOT, 'publish')
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8')
const readJson = (relPath) => JSON.parse(read(relPath))

const PLUGIN_ID = 'io.github.pmslava.jot'

let count = 0
let failures = 0
async function check(name, fn) {
    count++
    const number = String(count).padStart(2, '0')
    try {
        await fn()
        console.log(`  PASS  ${number}  ${name}`)
    } catch (error) {
        failures++
        console.log(`  FAIL  ${number}  ${name}\n        ${error.message}`)
    }
}


// ------------------------------------------------------------------------------------------ the stub
// The compiled bundle refers to `joplin` as a free global (api/index.ts), so it can be driven from Node
// with a stub in its place. The stub records every call the plugin makes (registrations, settings,
// dialog calls, data API reads and writes, command executions, workspace reads) and answers from
// `options`:
//   versionInfo                  what joplin.versionInfo() answers (the platform)
//   menuItemsThrow               views.menuItems.create rejects, as an app without menus would
//   settings                     values joplin.settings.value() answers over the registered defaults
//   folders, tags                what GET folders / GET tags page through, `pageSize` items a page
//   selectedNote, selectedFolder what joplin.workspace answers
//   dialogResults                what dialogs.open answers, in order (then Cancel); openDialog overrides it
//   executeThrows                command names whose commands.execute rejects
//   executeResults               what commands.execute answers, by command name (a function is called with the args);
//                                anything not listed answers undefined, so selectedText reads as no selection by default
//   globalSettings               what joplin.settings.globalValue() answers (editor.codeView is true, the Markdown
//                                editor, unless given); globalValueThrows makes every globalValue reject
//   contentScriptsThrow          joplin.contentScripts.register rejects, as an app without content scripts would
//   postThrows                   (path, body) => boolean: a data POST it answers true for rejects (recorded first), as Joplin refusing it would
//   tagsGetThrows                GET tags rejects after this many successful reads (0: every read rejects)
//   notes                        what GET notes/:id answers, by id (a copy; null answers null); an id not listed rejects, as Joplin's not-found does
//   noteTags                     what GET notes/:id/tags pages through, by note id (none: no tags); noteTagsGetThrows makes that read reject
//   putThrows, deleteThrows      (path, body) => boolean / (path) => boolean: a data PUT / DELETE it answers true for rejects (recorded first)
//   selectedNoteIds              what joplin.workspace.selectedNoteIds() answers: an array, or (readIndex, state) => array, so a check can make
//                                Joplin's selection jump after a write; none: [] (nothing selected, so the selection guard holds nothing).
//                                Each read is counted in state.selectionReads (not in workspaceCalls, which pins the notebook default's reads).
// The selection guard's clock is shortened for the whole harness (globalThis.__jotGuardTiming, set below).
// The content script's registration lands in state.contentScripts and its message handler in
// state.contentScriptHandlers, by content script id.
// Besides the per-kind records, `timeline` lists the plugin's writes and commands in the order they were made
// ("POST notes", "POST tags/<id>/notes", "PUT notes/<id>", "DELETE tags/<id>/notes/<noteId>", "execute insertText",
// "setValue lastSelectionAction=replace", ...), so a check can pin the order of the create, the tags, the edit in
// the editor and the open.
function makeJoplin(options) {
    const state = {
        onStart: null, commands: [], menuItems: [], toolbarButtons: [], messageBoxes: [], warnings: [],
        sections: [], settingSpecs: {}, settingWrites: [], globalReads: [], settingRegistrations: [], settingReads: [], settingBatches: [], syncHandlers: [],
        dialogCreates: [], dialogScripts: [], dialogButtons: [], dialogHtml: [], dialogOpens: 0,
        dataGets: [], dataPosts: [], dataPuts: [], dataDeletes: [], executes: [], workspaceCalls: [], timeline: [],
        contentScripts: [], contentScriptHandlers: {}, selectionReads: 0,
    }
    const written = {}
    const globals = { 'editor.codeView': true, ...(options.globalSettings || {}) }
    let nextId = 1
    const newId = (prefix) => `${prefix}${String(nextId++).padStart(4, '0')}`
    const pageSize = options.pageSize || 2
    const page = (items, query) => {
        const number = (query && query.page) || 1
        return {
            items: items.slice((number - 1) * pageSize, number * pageSize).map(item => ({ ...item })),
            has_more: number * pageSize < items.length,
        }
    }
    const tags = (options.tags || []).map(tag => ({ ...tag }))
    const results = (options.dialogResults || []).slice()
    const joplin = {
        plugins: { register: async (plugin) => { state.onStart = plugin.onStart } },
        versionInfo: async () => options.versionInfo,
        require: () => { throw new Error('Unable to require module in the harness.') },
        settings: {
            registerSection: async (name, spec) => { state.sections.push({ name, spec }) },
            registerSettings: async (specs) => { state.settingRegistrations.push(Object.keys(specs)); Object.assign(state.settingSpecs, specs) },
            value: async (key) => {
                state.settingReads.push(key)
                if (key in written) return written[key]
                if (options.settings && key in options.settings) return options.settings[key]
                return state.settingSpecs[key] ? state.settingSpecs[key].value : undefined
            },
            // joplin.settings.values (3.7.21): { key: value } for the keys asked, in one call; settingsValuesMissing makes an app without it.
            values: async (keys) => {
                if (options.settingsValuesMissing) throw new Error('joplin.settings.values is not a function')
                state.settingBatches.push(keys.slice())
                const out = {}
                for (const key of keys) {
                    if (key in written) out[key] = written[key]
                    else if (options.settings && key in options.settings) out[key] = options.settings[key]
                    else out[key] = state.settingSpecs[key] ? state.settingSpecs[key].value : undefined
                }
                return out
            },
            setValue: async (key, value) => {
                state.settingWrites.push({ key, value })
                state.timeline.push(`setValue ${key}=${value}`)
                written[key] = value
            },
            globalValue: async (key) => {
                state.globalReads.push(key)
                if (options.globalValueThrows) throw new Error(`cannot read ${key}`)
                return globals[key]
            },
        },
        commands: {
            register: async (command) => { state.commands.push(command) },
            execute: async (name, ...args) => {
                state.executes.push({ name, args })
                state.timeline.push(`execute ${name}`)
                if (options.executeThrows && options.executeThrows.includes(name)) throw new Error(`Command not found: ${name}`)
                const results = options.executeResults || {}
                if (!(name in results)) return undefined
                return typeof results[name] === 'function' ? results[name](...args) : results[name]
            },
        },
        workspace: {
            selectedNote: async () => { state.workspaceCalls.push('selectedNote'); return options.selectedNote === undefined ? null : options.selectedNote },
            selectedFolder: async () => { state.workspaceCalls.push('selectedFolder'); return options.selectedFolder === undefined ? null : options.selectedFolder },
            onSyncComplete: async (handler) => { state.syncHandlers.push(handler) },
            selectedNoteIds: async () => {
                const read = state.selectionReads++
                const ids = typeof options.selectedNoteIds === 'function' ? options.selectedNoteIds(read, state) : options.selectedNoteIds
                return Array.isArray(ids) ? ids.slice() : []
            },
        },
        data: {
            get: async (pathParts, query) => {
                state.dataGets.push({ path: pathParts, query })
                if (pathParts[0] === 'tags' && typeof options.tagsGetThrows === 'number') {
                    const reads = state.dataGets.filter(get => get.path[0] === 'tags').length
                    if (reads > options.tagsGetThrows) throw new Error('cannot read the tags')
                }
                if (pathParts.length === 1 && pathParts[0] === 'folders') return page(options.folders || [], query)
                if (pathParts.length === 1 && pathParts[0] === 'tags') return page(tags, query)
                if (pathParts.length === 2 && pathParts[0] === 'notes') {
                    const notes = options.notes || {}
                    if (!(pathParts[1] in notes)) throw new Error(`Not Found: notes/${pathParts[1]}`)
                    return notes[pathParts[1]] ? { ...notes[pathParts[1]] } : notes[pathParts[1]]
                }
                if (pathParts.length === 3 && pathParts[0] === 'notes' && pathParts[2] === 'tags') {
                    if (options.noteTagsGetThrows) throw new Error('cannot read the note\'s tags')
                    return page(((options.noteTags || {})[pathParts[1]]) || [], query)
                }
                throw new Error(`unexpected GET ${pathParts.join('/')}`)
            },
            put: async (pathParts, query, body) => {
                state.dataPuts.push({ path: pathParts, query, body })
                state.timeline.push(`PUT ${pathParts.join('/')}`)
                if (options.putThrows && options.putThrows(pathParts, body)) throw new Error(`refused: PUT ${pathParts.join('/')}`)
                if (pathParts.length === 2 && pathParts[0] === 'notes') return { id: pathParts[1], ...body }
                throw new Error(`unexpected PUT ${pathParts.join('/')}`)
            },
            delete: async (pathParts, query) => {
                state.dataDeletes.push({ path: pathParts, query })
                state.timeline.push(`DELETE ${pathParts.join('/')}`)
                if (options.deleteThrows && options.deleteThrows(pathParts)) throw new Error(`refused: DELETE ${pathParts.join('/')}`)
                if (pathParts.length === 4 && pathParts[0] === 'tags' && pathParts[2] === 'notes') return null
                throw new Error(`unexpected DELETE ${pathParts.join('/')}`)
            },
            post: async (pathParts, query, body) => {
                state.dataPosts.push({ path: pathParts, query, body })
                state.timeline.push(`POST ${pathParts.join('/')}`)
                if (options.postThrows && options.postThrows(pathParts, body)) throw new Error(`refused: POST ${pathParts.join('/')}`)
                if (pathParts.length === 1 && pathParts[0] === 'notes') return { id: newId('note'), ...body }
                if (pathParts.length === 1 && pathParts[0] === 'tags') {
                    const tag = { id: newId('tag'), title: body.title }
                    tags.push(tag)
                    return tag
                }
                if (pathParts.length === 3 && pathParts[0] === 'tags' && pathParts[2] === 'notes') return {}
                throw new Error(`unexpected POST ${pathParts.join('/')}`)
            },
        },
        views: {
            dialogs: {
                create: async (id) => { state.dialogCreates.push(id); return `dialog:${id}` },
                addScript: async (handle, script) => { state.dialogScripts.push(script) },
                setButtons: async (handle, buttons) => { state.dialogButtons.push(buttons); return buttons },
                setHtml: async (handle, html) => { state.dialogHtml.push(html); return html },
                open: async () => {
                    state.dialogOpens++
                    if (options.openDialog) return options.openDialog(state)
                    return results.length ? results.shift() : { id: 'cancel' }
                },
                showMessageBox: async (message) => { state.messageBoxes.push(message); return 0 },
            },
            menuItems: {
                create: async (id, commandName, location, options2) => {
                    if (options.menuItemsThrow) throw new Error('menus are not available')
                    state.menuItems.push({ id, commandName, location, options: options2 })
                },
            },
            toolbarButtons: {
                create: async (id, commandName, location) => { state.toolbarButtons.push({ id, commandName, location }) },
            },
        },
        contentScripts: {
            register: async (type, id, scriptPath) => {
                if (options.contentScriptsThrow) throw new Error('content scripts are not available')
                state.contentScripts.push({ type, id, path: scriptPath })
            },
            onMessage: async (id, callback) => { state.contentScriptHandlers[id] = callback },
        },
    }
    return { joplin, state }
}

// Runs `fn` with console.warn recorded into state.warnings.
async function withWarnings(state, fn) {
    const realWarn = console.warn
    console.warn = (...args) => { state.warnings.push(args.map(String).join(' ')) }
    try {
        return await fn()
    } finally {
        console.warn = realWarn
    }
}

// The selection guard's clock (src/form/selectionGuard.ts, GUARD_TIMING), shortened so a guarded write costs milliseconds here.
globalThis.__jotGuardTiming = { pollMs: 1, watchMs: 40, settleMs: 2, viewWaitMs: 40, viewChecks: 3, viewCheckMs: 1, maxRestores: 2, triggerEditMs: 2 }

async function runBundle(options) {
    const { joplin, state } = makeJoplin(options)
    global.joplin = joplin
    const bundlePath = path.join(DIST, 'index.js')
    delete require.cache[require.resolve(bundlePath)]
    require(bundlePath)
    if (!state.onStart) throw new Error('the plugin did not register an onStart handler')
    await withWarnings(state, () => state.onStart({}))
    return state
}

// ------------------------------------------------------------------------------------------ form fixtures
const DESKTOP = { version: '3.6.14', platform: 'desktop' }
const MOBILE = { version: '3.6.0', platform: 'mobile' }
// Five notebooks over three pages, one nested, one named to break out of a <script> element.
const FOLDERS = [
    { id: 'fWork', title: 'Work', parent_id: '' },
    { id: 'fProj', title: 'Projects', parent_id: 'fWork' },
    { id: 'fHome', title: 'home', parent_id: '' },
    { id: 'fArch', title: 'Archive', parent_id: '' },
    { id: 'fOdd', title: '</script><b>odd', parent_id: '' },
]
const SORTED_NOTEBOOKS = [
    { id: 'fOdd', path: '</script><b>odd' },
    { id: 'fArch', path: 'Archive' },
    { id: 'fHome', path: 'home' },
    { id: 'fWork', path: 'Work' },
    { id: 'fProj', path: 'Work / Projects' },
]
const TAGS = [
    { id: 'tWork', title: 'work' },
    { id: 'tUrgent', title: 'urgent' },
    { id: 'tIdea', title: 'idea' },
]
const FORM_BASE = { versionInfo: DESKTOP, folders: FOLDERS, tags: TAGS, selectedNote: { id: 'nOpen', parent_id: 'fWork' } }

// A dialog result as Joplin returns it: the button's id and the "jot" form's fields.
function formResult(id, fields) {
    return {
        id,
        formData: { jot: { type: 'todo', title: '', body: '', notebookId: 'fProj', tags: '', dueDate: '', dueTime: '', ...fields } },
    }
}

// Starts a bundle with the form fixtures and `options`, runs jot.open once, and returns the stub's record and what the command resolved.
async function openFormWith(options) {
    const state = await runBundle({ ...FORM_BASE, ...options })
    const command = state.commands.find(item => item.name === 'jot.open')
    const outcome = await withWarnings(state, () => command.execute())
    return { state, outcome }
}

// The selection read every command makes before it opens the form (the plain route included).
const READ_SELECTION = { name: 'selectedText', args: [] }

// Starts a bundle with the form fixtures, `selection` as what the editor's selectedText answers, and `options`, runs `command` (jot.fromSelection
// unless given) once, and returns the stub's record and what the command resolved.
async function openSelectionWith(selection, options, command = 'jot.fromSelection') {
    const executeResults = { ...((options && options.executeResults) || {}), selectedText: selection }
    const state = await runBundle({ ...FORM_BASE, ...options, executeResults })
    const registered = state.commands.find(item => item.name === command)
    const outcome = await withWarnings(state, () => registered.execute())
    return { state, outcome }
}

// A growing field's content (Title, Tags) or the Text's, as the markup writes it: a textarea whose content starts with a newline.
function fieldValue(html, name) {
    const match = new RegExp(`<textarea name="${name}"[^>]*>\\n([\\s\\S]*?)</textarea>`).exec(html)
    return match ? match[1] : undefined
}

// The In this note group of a form's markup ('' without the row), its buttons' labels in order (short, one line) and their tooltips (the full
// wording, which the labels shorten).
function choiceGroup(html) {
    const match = /data-field="inThisNote">([\s\S]*?)<\/div>/.exec(html)
    return match ? match[1] : ''
}

function choiceLabels(html) {
    return (choiceGroup(html).match(/class="jot-seg-option[^"]*"[^>]*>([^<]*)<\/button>/g) || []).map(match => match.replace(/^[^>]*>/, '').replace(/<\/button>$/, ''))
}

function choiceTitles(html) {
    return (choiceGroup(html).match(/ title="([^"]*)"/g) || []).map(match => match.slice(8, -1))
}

// The JSON island of a form's markup, parsed.
function islandOf(html) {
    const match = /<script type="application\/json" id="jotFormData">([\s\S]*?)<\/script>/.exec(html)
    if (!match) throw new Error('the markup carries no #jotFormData island')
    return { raw: match[1], data: JSON.parse(match[1]) }
}

function notePosts(state) {
    return state.dataPosts.filter(post => post.path.length === 1 && post.path[0] === 'notes')
}

// ------------------------------------------------------------------------------------------ edit mode
// A to-do in Work with two tags and a due date that carries seconds: the form shows minutes, so a Due left alone must not be rewritten.
const EDIT_DUE = new Date(2026, 9, 14, 10, 30, 0, 0).getTime()
const EDIT_NOTE = { id: 'nEdit', title: 'Call the bank', is_todo: 1, parent_id: 'fWork', todo_due: EDIT_DUE + 25_000, todo_completed: 0, body: 'never shown' }
const EDIT_NOTE_TAGS = [{ id: 'tWork', title: 'work' }, { id: 'tUrgent', title: 'urgent' }]
const EDIT_BASE = { notes: { nEdit: EDIT_NOTE }, noteTags: { nEdit: EDIT_NOTE_TAGS } }
const EDIT_ARGS = { mode: 'edit', noteId: 'nEdit' }
// The edit form's fields as its prefill shows them: Save on these is an unchanged form.
const EDIT_UNCHANGED = { type: 'todo', title: 'Call the bank', notebookId: 'fWork', tags: 'urgent, work', dueDate: '2026-10-14', dueTime: '10:30' }

// An edit-mode dialog result: the button's id and the "jot" form's fields - no body and no inThisNote, which edit mode does not draw - as the
// prefill showed them unless `fields` says otherwise.
function editResult(id, fields) {
    return { id, formData: { jot: { ...EDIT_UNCHANGED, ...fields } } }
}

// Starts a bundle with the form and edit fixtures and `options`, runs `command` (jot.open unless given) once with `args` (edit mode on nEdit unless
// given), and returns the stub's record and what the command resolved.
async function editWith(options, args = EDIT_ARGS, command = 'jot.open') {
    const state = await runBundle({ ...FORM_BASE, ...EDIT_BASE, ...options })
    const registered = state.commands.find(item => item.name === command)
    const outcome = await withWarnings(state, () => registered.execute(args))
    return { state, outcome }
}

// The note reads edit mode made: GET notes/:id and GET notes/:id/tags, as "path fields" strings.
function noteReads(state) {
    return state.dataGets.filter(get => get.path[0] === 'notes').map(get => `${get.path.join('/')} ${get.query && get.query.fields ? get.query.fields.join(',') : ''}`)
}

// ------------------------------------------------------------------------------------------ the typed trigger
const CONTENT_SCRIPT_ID = 'jot.trigger'

// Starts a bundle with the form fixtures and `options`, and returns the stub's record and the content script's message handler.
async function triggerHandlerWith(options) {
    const state = await runBundle({ ...FORM_BASE, ...options })
    const handler = state.contentScriptHandlers[CONTENT_SCRIPT_ID]
    if (typeof handler !== 'function') throw new Error('no message handler for the content script')
    return { state, handler: (message) => withWarnings(state, () => handler(message)) }
}

// Sends one { type: 'trigger' } message, as the content script does on a fire, and returns the stub's record and the answer.
async function fireTriggerWith(options, trigger = '++') {
    const { state, handler } = await triggerHandlerWith(options)
    const answer = await handler({ type: 'trigger', from: 6, to: 6 + trigger.length, trigger })
    return { state, handler, answer }
}

// ------------------------------------------------------------------------------------------ the content script in Node
// dist/contentScript.js is the webpack build, a CommonJS module whose @codemirror/* requires resolve to node_modules here
// (the same copies this file requires, so the facets are the same objects). There is no DOM in this harness, so the
// EditorView is a stand-in: a real EditorState, dispatch() building real transactions with state.update(), the
// update listeners of the state's EditorView.updateListener facet called with { view, state, startState, transactions },
// and a `composing` flag. What the stand-in cannot show (the DOM, focus, CodeMirror's history) the e2e spec shows.
const { EditorView: CMEditorView } = require('@codemirror/view')
const { EditorState: CMEditorState, StateEffect: CMStateEffect } = require('@codemirror/state')

function loadContentScript() {
    const full = path.join(DIST, 'contentScript.js')
    delete require.cache[require.resolve(full)]
    return require(full).default
}

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

// A stand-in for the plugin side of postMessage: `config` answers { trigger } (a function of the attempt, or a value), `trigger`
// waits for the test to answer it (answerTrigger), anything else answers null. Every message is recorded in posts.
function makeContentContext(config = { trigger: '++' }) {
    const posts = []
    const waiting = []
    let configAsks = 0
    const context = {
        pluginId: PLUGIN_ID,
        contentScriptId: CONTENT_SCRIPT_ID,
        postMessage: async (message) => {
            posts.push(JSON.parse(JSON.stringify(message)))
            if (message.type === 'config') return typeof config === 'function' ? config(++configAsks) : config
            if (message.type === 'trigger') return new Promise(resolve => waiting.push(resolve))
            return null
        },
    }
    const answerTrigger = async (answer) => {
        const resolve = waiting.shift()
        if (!resolve) throw new Error('no trigger is waiting for an answer')
        resolve(answer)
        await tick()
    }
    return { context, posts, answerTrigger, waiting }
}

// Mounts the content script on a stand-in view holding `doc`, the caret at its end; waits for the first config answer.
async function mountTrigger(doc = '', config) {
    const { context, posts, answerTrigger, waiting } = makeContentContext(config)
    const extensions = []
    const view = {
        composing: false,
        state: null,
        scrollDOM: { scrollTop: 0 },
        hasFocus: false,
        focus() { this.hasFocus = true },
        dispatch(...specs) { this.apply([this.state.update(...specs)]) },
        apply(transactions) {
            const startState = this.state
            for (const tr of transactions) this.state = tr.state
            const update = { view: this, state: this.state, startState, transactions }
            for (const listener of this.state.facet(CMEditorView.updateListener)) listener(update)
        },
    }
    const warnings = []
    const realWarn = console.warn
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
    const commands = {}
    try {
        loadContentScript()(context).plugin({
            cm6: view, editor: view, addExtension: (extension) => extensions.push(extension), registerCommand: (name, callback) => { commands[name] = callback },
        })
    } finally {
        console.warn = realWarn
    }
    view.state = CMEditorState.create({ doc, extensions, selection: { anchor: doc.length } })
    await tick()
    const type = (text, userEvent = 'input.type') => {
        for (const character of text) {
            const at = view.state.selection.main.head
            view.dispatch({ changes: { from: at, insert: character }, selection: { anchor: at + character.length }, userEvent })
        }
    }
    const text = () => view.state.doc.toString()
    const triggers = () => posts.filter(post => post.type === 'trigger')
    const configs = () => posts.filter(post => post.type === 'config')
    // Runs `fn` with console.warn recorded into warnings.
    const quietly = async (fn) => {
        console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
        try { return await fn() } finally { console.warn = realWarn }
    }
    return { view, extensions, posts, answerTrigger, waiting, type, text, triggers, configs, warnings, quietly, commands }
}

// ------------------------------------------------------------------------------------------ the selection guard
// A Markdown editor as the guard sees it through editor.execCommand: jot.getView answers its view, jot.setView sets it (refusing another note's
// view, as the content script does), and openNote loads a note at its top. `jumpTo` is the note Joplin's refresh selects after the tag write: the
// selection reads ['nRead'] until the first tag call, then [jumpTo] (and the editor holds it) until Jot opens nRead again.
const HELD_VIEW = { noteId: 'nRead', scrollTop: 840, anchor: 1200, head: 1210, docLength: 3000, focused: true }

function guardedEditor(options = {}) {
    const jumpTo = options.jumpTo === undefined ? 'note0001' : options.jumpTo
    let editor = { ...HELD_VIEW }
    let jumped = false
    let reopened = false
    const setViews = []
    const opens = []
    const fixture = {
        selectedNoteIds: (read, state) => {
            if (options.selection) return options.selection(read, state)
            const tagWritten = state.timeline.some(line => /^(POST tags|DELETE tags|PUT notes)/.test(line))
            if (!tagWritten || reopened || !jumpTo) return ['nRead']
            if (!jumped) { jumped = true; editor = { noteId: jumpTo, scrollTop: 0, anchor: 0, head: 0, docLength: 40, focused: false } }
            return [jumpTo]
        },
        executeResults: {
            'editor.execCommand': (call) => {
                if (options.richText) return undefined
                if (call.name === 'jot.getView') return { ...editor }
                if (call.name === 'jot.setView') {
                    const wanted = call.args[0]
                    setViews.push(wanted)
                    if (wanted.noteId && wanted.noteId !== editor.noteId) return null
                    editor = { ...editor, scrollTop: wanted.scrollTop, anchor: wanted.anchor, head: wanted.head, focused: wanted.focused }
                    return { ...editor }
                }
                return undefined
            },
            openNote: (noteId) => {
                opens.push(noteId)
                if (options.openThrows) throw new Error('No such note')
                if (noteId === 'nRead') reopened = true
                editor = { noteId, scrollTop: 0, anchor: 0, head: 0, docLength: noteId === 'nRead' ? 3000 : 40, focused: false }
            },
        },
    }
    return { fixture, setViews, opens, view: () => ({ ...editor }) }
}

// ------------------------------------------------------------------------------------------ the checks
async function main() {
    const pkg = readJson('package.json')
    const manifest = readJson('src/manifest.json')
    const lock = readJson('package-lock.json')

    // ---------------------------------------------------------------- identity
    await check('version quadruple: package.json, src/manifest.json, package-lock.json version and packages[""].version agree', () => {
        const versions = {
            'package.json': pkg.version,
            'src/manifest.json': manifest.version,
            'package-lock.json version': lock.version,
            'package-lock.json packages[""].version': lock.packages && lock.packages[''] && lock.packages[''].version,
        }
        assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version "${pkg.version}" is not x.y.z`)
        for (const [where, version] of Object.entries(versions)) {
            assert.strictEqual(version, pkg.version, `${where} is ${version}, package.json is ${pkg.version}`)
        }
    })

    await check('manifest: id, name, platforms and minimum app versions', () => {
        assert.strictEqual(manifest.manifest_version, 1)
        assert.strictEqual(manifest.id, PLUGIN_ID)
        assert.strictEqual(manifest.name, 'Jot')
        assert.deepStrictEqual(manifest.platforms, ['desktop', 'mobile'])
        // The floor the mechanisms Jot copies from Harper were proven against (brief section 2).
        assert.strictEqual(manifest.app_min_version, '3.1')
        assert.strictEqual(manifest.app_min_version_mobile, '3.3')
    })

    await check('manifest and package.json carry the same description, repository and package name', () => {
        assert.strictEqual(manifest.description, pkg.description)
        assert.ok(manifest.description.startsWith('Quick capture of a note or to-do'), 'the brief\'s section 1 description')
        assert.strictEqual(manifest.repository_url, 'https://github.com/pmslava/joplin-plugin-jot')
        assert.strictEqual(manifest.homepage_url, manifest.repository_url)
        // package.json carries the URL in the form npm normalises it to (npm pkg fix), the manifest the plain one.
        assert.strictEqual(pkg.repository.url, `git+${manifest.repository_url}.git`)
        assert.strictEqual(pkg.name, 'joplin-plugin-jot')
        // The Joplin plugin repository finds packages on npm by this keyword.
        assert.ok(pkg.keywords.includes('joplin-plugin'), 'package.json keywords include joplin-plugin')
    })

    // ---------------------------------------------------------------- the build
    await check('build: dist/index.js and dist/manifest.json exist, and the built manifest is the source one', () => {
        assert.ok(fs.existsSync(path.join(DIST, 'index.js')), 'dist/index.js exists')
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8')), manifest)
    })

    await check(`build: publish/${PLUGIN_ID}.jpl and its .json exist and are not empty`, () => {
        for (const file of [`${PLUGIN_ID}.jpl`, `${PLUGIN_ID}.json`]) {
            const full = path.join(PUBLISH, file)
            assert.ok(fs.existsSync(full), `publish/${file} exists`)
            assert.ok(fs.statSync(full).size > 0, `publish/${file} is not empty`)
        }
    })

    await check('build: dist/contentScript.js requires @codemirror/view and @codemirror/state from Joplin and bundles no CodeMirror of its own', () => {
        const full = path.join(DIST, 'contentScript.js')
        assert.ok(fs.existsSync(full), 'dist/contentScript.js exists')
        const source = fs.readFileSync(full, 'utf8')
        // Every @codemirror/* module the script uses must stay a require() of Joplin's own copy (the externals
        // block in webpack.config.js). A bundled copy shows up as CodeMirror's own code without such a require.
        const mentions = source.match(/@codemirror\/[a-z-]+/g) || []
        const required = source.match(/require\(\s*["']@codemirror\/[a-z-]+["']\s*\)/g) || []
        assert.strictEqual(mentions.length, required.length, 'every @codemirror/ mention is a require() call, not a bundled copy')
        assert.deepStrictEqual([...new Set(required.map(call => call.match(/@codemirror\/[a-z-]+/)[0]))].sort(), ['@codemirror/state', '@codemirror/view'])
        assert.ok(!/class\s+EditorView\b|\bViewPlugin\.fromClass\b.*\bEditorState\.create\b/s.test(source), 'no CodeMirror view code in the bundle')
        assert.ok(source.length < 20000, `the content script is small: the trigger and its rule only (${source.length} bytes)`)
        for (const name of ['triggerAt', 'occurrenceHolds', 'contextRange', '__jotActivatedEditors']) {
            assert.ok(source.includes(name), `${name} is in the bundle (the rule bundled in, the double-mount guard kept)`)
        }
    })

    await check('build: webpack.config.js keeps the six @codemirror/* modules of Harper external for the extra scripts, and contentScript.ts is the one extra script', () => {
        const config = read('webpack.config.js')
        for (const name of ['view', 'state', 'lint', 'language', 'commands', 'autocomplete']) {
            assert.ok(config.includes(`'@codemirror/${name}': 'commonjs @codemirror/${name}'`), `@codemirror/${name} is a commonjs external`)
        }
        assert.deepStrictEqual(readJson('plugin.config.json').extraScripts, ['contentScript.ts'])
    })

    // ---------------------------------------------------------------- the bundle against a stub
    const desktop = await runBundle({ versionInfo: DESKTOP })

    await check('desktop: onStart registers jot.open, labelled Jot…, jot.fromSelection, labelled Jot from the selection…, jot.button, labelled Jot, and jot.edit, labelled Edit with Jot…', () => {
        assert.deepStrictEqual(desktop.commands.map(command => [command.name, command.label]),
            [['jot.open', 'Jot…'], ['jot.fromSelection', 'Jot from the selection…'], ['jot.button', 'Jot'], ['jot.edit', 'Edit with Jot…']])
    })

    await check('desktop: Tools > Jot… is one menu item with the Ctrl+Shift+J accelerator, jot.fromSelection is in the editor\'s right-click menu, and jot.edit in the note list\'s', () => {
        assert.deepStrictEqual(desktop.menuItems, [
            { id: 'jot.open.menu', commandName: 'jot.open', location: 'tools', options: { accelerator: 'Ctrl+Shift+J' } },
            { id: 'jot.fromSelection.menu', commandName: 'jot.fromSelection', location: 'editorContextMenu', options: undefined },
            { id: 'jot.edit.menu', commandName: 'jot.edit', location: 'noteListContextMenu', options: undefined },
        ])
        assert.deepStrictEqual(desktop.warnings, [])
    })

    await check('desktop: jot.open opens the form (no placeholder message box any more), and Cancel creates nothing', async () => {
        const { state, outcome } = await openFormWith({})
        assert.strictEqual(state.dialogOpens, 1)
        assert.deepStrictEqual(state.messageBoxes, [])
        assert.deepStrictEqual(state.dataPosts, [])
        assert.deepStrictEqual(state.executes, [READ_SELECTION], 'the selection is read first; nothing else is run')
        assert.strictEqual(outcome, null)
    })

    const mobile = await runBundle({ versionInfo: MOBILE })

    await check('mobile: the commands are registered and no menu item is made', () => {
        assert.deepStrictEqual(mobile.commands.map(command => command.name), ['jot.open', 'jot.fromSelection', 'jot.button', 'jot.edit'])
        assert.deepStrictEqual(mobile.menuItems, [])
        assert.deepStrictEqual(mobile.warnings, [])
    })

    const refused = await runBundle({ versionInfo: DESKTOP, menuItemsThrow: true })

    await check('an app that refuses the menu items still starts the plugin, with one console warning for each item', () => {
        assert.deepStrictEqual(refused.commands.map(command => command.name), ['jot.open', 'jot.fromSelection', 'jot.button', 'jot.edit'])
        assert.strictEqual(refused.warnings.length, 3)
        assert.ok(refused.warnings[0].startsWith('Jot: could not add Tools > Jot…'), refused.warnings[0])
        assert.ok(refused.warnings[1].startsWith('Jot: could not add Jot from the selection… to the editor\'s right-click menu'), refused.warnings[1])
        assert.ok(refused.warnings[2].startsWith('Jot: could not add Edit with Jot… to the note list\'s right-click menu'), refused.warnings[2])
    })

    await check('typed trigger: onStart registers src/contentScript.ts as a CodeMirror plugin (one file for desktop and mobile) and its message handler', () => {
        const registered = [{ type: 'codeMirrorPlugin', id: 'jot.trigger', path: './contentScript.js' }]
        assert.deepStrictEqual(desktop.contentScripts, registered)
        assert.deepStrictEqual(mobile.contentScripts, registered)
        assert.deepStrictEqual(Object.keys(desktop.contentScriptHandlers), ['jot.trigger'])
        assert.deepStrictEqual(Object.keys(mobile.contentScriptHandlers), ['jot.trigger'])
        assert.ok(fs.existsSync(path.join(DIST, 'contentScript.js')), 'the path names the built script, next to index.js')
        const source = read('src/index.ts')
        assert.ok(/await setupTrigger\(\)\n(?:\s*\/\/[^\n]*\n)*\s*void warmUp\(\)\n/.test(source),
            'setupTrigger is the last setup awaited; the warm-up (lists and the form\'s dialog) follows, not awaited')
        assert.ok(source.includes('await joplin.workspace.onSyncComplete(() => { void refreshLists() })'), 'and the lists are read again after each sync')
    })

    await check('typed trigger: an app that refuses the content script still starts the plugin, with one console warning', async () => {
        const state = await runBundle({ versionInfo: DESKTOP, contentScriptsThrow: true })
        assert.deepStrictEqual(state.commands.map(command => command.name), ['jot.open', 'jot.fromSelection', 'jot.button', 'jot.edit'])
        assert.deepStrictEqual(state.toolbarButtons.length, 1)
        assert.strictEqual(state.warnings.length, 1)
        assert.ok(state.warnings[0].startsWith('Jot: could not add the typed trigger to the Markdown editor'), state.warnings[0])
    })

    // ---------------------------------------------------------------- settings and the toolbar gate
    await check('settings: section Jot with exactly defaultType, defaultNotebook, textNotebook, tagsFrom, backlinkFor, backlinkTemplate, backlinkPosition, openAfterCreate, selectionAction, trigger, triggerAction, dayStartTime and showToolbarButton on screen, and 0.2.0\'s copyTags and backlink hidden', () => {
        assert.deepStrictEqual(desktop.sections.map(section => [section.name, section.spec.label]), [['jot', 'Jot']])
        const specs = desktop.settingSpecs
        assert.deepStrictEqual(Object.keys(specs), ['defaultType', 'defaultNotebook', 'textNotebook', 'tagsFrom', 'backlinkFor', 'backlinkTemplate', 'backlinkPosition',
            'openAfterCreate', 'selectionAction', 'trigger', 'triggerAction', 'dayStartTime', 'showToolbarButton', 'copyTags', 'backlink'],
            'every selector has its default on screen (issue 5); the 0.2.0 switches hidden, kept for the carry-over (issue 6)')
        const hidden = ['copyTags', 'backlink']
        for (const key of Object.keys(specs)) {
            assert.strictEqual(specs[key].section, 'jot', `${key} is in the Jot section`)
            assert.strictEqual(specs[key].public, !hidden.includes(key), `${key} is ${hidden.includes(key) ? 'hidden' : 'public'}`)
        }
        assert.deepStrictEqual({ label: specs.selectionAction.label, description: specs.selectionAction.description, value: specs.selectionAction.value, isEnum: specs.selectionAction.isEnum, options: specs.selectionAction.options }, {
            label: 'In this note, for highlighted text',
            description: 'Where the form\'s In this note starts when Jot is opened from highlighted text. You can switch it in the form. Add a link after it is offered in the Markdown editor only; in the Rich Text editor the form starts on Replace instead.',
            value: 'replace', isEnum: true, options: { replace: 'Replace it with a link to the new note', keep: 'Keep the text', after: 'Add a link after it' },
        }, 'issue 5')
        assert.deepStrictEqual({ label: specs.triggerAction.label, description: specs.triggerAction.description, value: specs.triggerAction.value, isEnum: specs.triggerAction.isEnum, options: specs.triggerAction.options }, {
            label: 'In this note, for the typed trigger',
            description: 'Where the form\'s In this note starts when Jot is opened by the typed trigger. You can switch it in the form.',
            value: 'link', isEnum: true, options: { link: 'Replace the trigger with a link to the new note', remove: 'Remove the trigger' },
        }, 'issue 5')
        const STRING = 2, BOOL = 3
        assert.deepStrictEqual(
            { label: specs.defaultType.label, description: specs.defaultType.description, value: specs.defaultType.value, type: specs.defaultType.type, isEnum: specs.defaultType.isEnum, options: specs.defaultType.options },
            { label: 'What Jot creates', description: 'Whether the form opens as a to-do or a note. You can switch in the form.', value: 'todo', type: STRING, isEnum: true, options: { todo: 'A to-do', note: 'A note' } })
        const pick = (spec) => ({ label: spec.label, description: spec.description, value: spec.value, type: spec.type, isEnum: spec.isEnum, options: spec.options })
        assert.deepStrictEqual(pick(specs.defaultNotebook), {
            label: 'Notebook for quick notes',
            description: 'Where a note starts when you open Jot with nothing highlighted (the shortcut, the menu, the toolbar button): the notebook of the note you are in, or always the same notebook, such as an inbox. You can pick another in the form. Notebooks made later appear here once Jot has been used.',
            value: '', type: STRING, isEnum: true, options: { '': 'The current notebook' },
        }, 'the current notebook by default, under its 0.2.0 key so a chosen inbox is kept; the startup fixture has no notebooks to list')
        assert.deepStrictEqual(pick(specs.textNotebook), {
            label: 'Notebook for notes from text in a note',
            description: 'Where a note starts when you open Jot from highlighted text or by typing the trigger: the notebook of the note the text is in, or always the same notebook. You can pick another in the form.',
            value: '', type: STRING, isEnum: true, options: { '': 'The current notebook' },
        }, 'issue 6: a setting of its own, said in its own label')
        assert.deepStrictEqual(pick(specs.tagsFrom), {
            label: 'Fill in the tags of the note you are in',
            description: 'For notes from text in a note: when Jot is opened from highlighted text or by the typed trigger, the form\'s Tags start with the tags of that note. Always: whenever you are in a note. You can change or clear them in the form.',
            value: 'text', type: STRING, isEnum: true, options: { never: 'Never', text: 'For notes from text in a note', always: 'Always' },
        }, 'issue 6: for notes from text by default')
        assert.deepStrictEqual(pick(specs.backlinkFor), {
            label: 'Add a back link to the note you are in',
            description: 'Where the form\'s Back link starts: on Add for notes from text in a note (highlighted text or the typed trigger), always, or never. You can switch it in the form.',
            value: 'never', type: STRING, isEnum: true, options: { never: 'Never', text: 'For notes from text in a note', always: 'Always' },
        }, 'issue 6: never by default, as 0.2.0\'s switch')
        assert.deepStrictEqual([specs.copyTags.value, specs.copyTags.type, specs.backlink.value, specs.backlink.type], [true, BOOL, false, BOOL], 'the 0.2.0 switches, at their defaults')
        assert.deepStrictEqual(pick(specs.backlinkTemplate), {
            label: 'Back link text',
            description: 'Placeholders for the note you are in: {note_link} (a Markdown link to it), {note_title}, {note_id}, {note_type} (to-do or note), {notebook_name}, {notebook_path} (such as Work/Projects), {notebook_id}. Empty means the default, Parent {note_type}: {note_link}.',
            value: 'Parent {note_type}: {note_link}', type: STRING, isEnum: undefined, options: undefined,
        })
        assert.deepStrictEqual(pick(specs.backlinkPosition), {
            label: 'Back link position', description: 'The back link\'s own line, with an empty line between it and the text.',
            value: 'top', type: STRING, isEnum: true, options: { top: 'First line, above the text', bottom: 'Last line, below the text' },
        })
        assert.deepStrictEqual(pick(specs.openAfterCreate), {
            label: 'Open the new note',
            description: 'Where the form\'s Open starts: stay where you are, open the note in the editor, or in a new window (desktop). You can switch it in the form.',
            value: 'no', type: STRING, isEnum: true, options: { no: 'No, stay where you are', editor: 'In the editor', window: 'In a new window' },
        }, 'stay by default')
        assert.deepStrictEqual(
            { label: specs.dayStartTime.label, description: specs.dayStartTime.description, value: specs.dayStartTime.value, type: specs.dayStartTime.type },
            { label: 'Day start time (HH:MM)', description: 'The time a to-do gets when its date is picked before its time, as in Cockpit\'s picker.', value: '09:00', type: STRING })
        assert.deepStrictEqual(
            { label: specs.showToolbarButton.label, description: specs.showToolbarButton.description, value: specs.showToolbarButton.value, type: specs.showToolbarButton.type },
            { label: 'Show the Jot button in the note toolbar', description: 'The button opens the form; on mobile it and the typed trigger are the ways in. Takes effect after Joplin restarts, since Joplin cannot add or remove a toolbar button while running.', value: true, type: BOOL })
        assert.deepStrictEqual(
            { label: specs.trigger.label, description: specs.trigger.description, value: specs.trigger.value, type: specs.trigger.type, isEnum: specs.trigger.isEnum },
            { label: 'Typed trigger', description: 'Typing this at the start of a line or after a space opens Jot, in the Markdown editor on desktop and mobile. Leave empty to turn it off. A change applies as soon as you leave the settings.', value: '++', type: STRING, isEnum: undefined })
    })

    await check('toolbar gate: with showToolbarButton on (the default) jot.button is a NoteToolbar button on desktop and on mobile', () => {
        const button = [{ id: 'jot.button.toolbar', commandName: 'jot.button', location: 'noteToolbar' }]
        assert.deepStrictEqual(desktop.toolbarButtons, button)
        assert.deepStrictEqual(mobile.toolbarButtons, button)
    })

    await check('toolbar gate: with showToolbarButton off no button is made, and the four commands are still registered', async () => {
        const off = await runBundle({ versionInfo: DESKTOP, settings: { showToolbarButton: false } })
        assert.deepStrictEqual(off.toolbarButtons, [])
        assert.deepStrictEqual(off.commands.map(command => command.name), ['jot.open', 'jot.fromSelection', 'jot.button', 'jot.edit'])
        const offMobile = await runBundle({ versionInfo: MOBILE, settings: { showToolbarButton: false } })
        assert.deepStrictEqual(offMobile.toolbarButtons, [])
    })

    // ---------------------------------------------------------------- the form's dialog and markup
    await check('form: the create form\'s dialog is built once, in the background once the plugin has started (so the first open does not wait for it): one handle, five scripts in order, two buttons (Create, Cancel)', async () => {
        assert.deepStrictEqual(desktop.dialogCreates, ['jot.form'], 'built by the warm-up, after onStart')
        const source = read('src/index.ts')
        assert.ok(!/await warmUp\(\)/.test(source), 'never awaited by onStart')
        const state = await runBundle({ ...FORM_BASE })
        const command = state.commands.find(item => item.name === 'jot.open')
        await command.execute()
        await command.execute()
        assert.deepStrictEqual(state.dialogCreates, ['jot.form'], 'the opens reuse it')
        assert.deepStrictEqual(state.dialogScripts, ['./form/form.css', './form/alarmQuick.js', './form/searchTokens.js', './form/formModel.js', './form/formWebview.js'])
        assert.deepStrictEqual(state.dialogButtons, [[
            { id: 'ok', title: 'Create' },
            { id: 'cancel', title: 'Cancel' },
        ]], 'whether the note opens is the form\'s Open row, not a third button')
        assert.strictEqual(state.dialogHtml.length, 2, 'the markup is set on every open')
        assert.strictEqual(state.dialogOpens, 2)
    })

    await check('form: jot.button opens the same form', async () => {
        const state = await runBundle({ ...FORM_BASE })
        await state.commands.find(item => item.name === 'jot.button').execute()
        assert.strictEqual(state.dialogOpens, 1)
        assert.deepStrictEqual(state.dialogCreates, ['jot.form'])
    })

    await check('form: a second open while the form is up is ignored', async () => {
        let release
        const held = new Promise(resolve => { release = resolve })
        const state = await runBundle({ ...FORM_BASE, openDialog: () => held })
        const command = state.commands.find(item => item.name === 'jot.open')
        const first = command.execute()
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.strictEqual(await command.execute(), null)
        release({ id: 'cancel' })
        assert.strictEqual(await first, null)
        assert.strictEqual(state.dialogOpens, 1)
    })

    await check('form markup: the fields in DOM order (Type, Title, Text, Notebook with its chevron, Tags, Due last with its picker), all in the initial markup, the Title focused', async () => {
        const { state } = await openFormWith({})
        const html = state.dialogHtml[0]
        assert.ok(html.includes('<form name="jot"'), 'one form named jot (formData.jot)')
        const order = ['id="jotHeading"', 'name="type"', 'name="title"', 'name="body"', 'id="jotNotebook"', 'id="jotNotebookOpen"', 'name="notebookId"', 'name="tags"',
            'id="jotDueText"', 'id="jotBell"', 'id="jotDueClear"', 'name="dueDate"', 'name="dueTime"', 'id="jotPicker"', 'id="jotNotebookList"']
        const positions = order.map(marker => html.indexOf(marker))
        positions.forEach((position, index) => assert.ok(position >= 0, `${order[index]} is in the markup`))
        assert.deepStrictEqual(positions.slice().sort((a, b) => a - b), positions, 'the fields come in the brief\'s order')
        assert.ok(/<textarea name="title" id="jotTitle" class="jot-input jot-grow" rows="1"[^>]*\bautofocus\b/.test(html), 'the Title is a growing field (one row to start) with autofocus')
        assert.ok(/<textarea name="body"[^>]*rows="3"/.test(html), 'the Text is a three-line textarea')
        assert.ok(/<input type="text" id="jotNotebook"[^>]*value="Work"/.test(html), 'the Notebook input shows the default notebook\'s path')
        assert.ok(/<input type="hidden" name="notebookId" id="jotNotebookId" value="fWork">/.test(html), 'and its id rides in the hidden notebookId')
        assert.ok(/<div class="jot-combo">\s*<input type="text" id="jotNotebook"[^>]*role="combobox"[^>]*>\s*<button type="button" id="jotNotebookOpen" class="jot-combo-open" tabindex="-1" aria-hidden="true"><svg/.test(html),
            'the chevron sits in the Notebook field\'s box, out of the Tab order (the field is the combobox)')
        assert.ok(html.includes('<strong id="jotHeading" class="jot-heading">New to-do</strong>'))
        for (const label of ['>Type<', '>Title<', '>Text<', '>Notebook<', '>Tags<', '>Due<', '>To-do<', '>Note<', '>No date<']) {
            assert.ok(html.includes(label), `the markup shows ${label}`)
        }
        assert.ok(/id="jotBell"[^>]*title="Pick a date and time"/.test(html), 'the bell\'s tooltip')
        const buttons = html.match(/<button\b[^>]*>/g) || []
        assert.ok(buttons.length >= 13, 'the type toggle, the bell, No date and the nine quick buttons')
        for (const button of buttons) assert.ok(button.includes('type="button"'), `every button is type="button" (no implicit submit): ${button}`)
        assert.ok(!html.includes('jotPlatform'), 'no mobile marker on desktop')
        assert.ok(!/draggable/.test(html), 'nothing draggable in the dialog')
    })

    await check('form markup: the JSON island carries the notebooks sorted by path, the tag titles and the defaults, with every "<" escaped', async () => {
        const { state } = await openFormWith({})
        const island = islandOf(state.dialogHtml[0])
        assert.ok(!island.raw.includes('<'), 'no raw "<" inside the island')
        assert.ok(island.raw.includes('\\u003c/script>'), 'the notebook named </script> is escaped')
        assert.deepStrictEqual(island.data.notebooks, SORTED_NOTEBOOKS)
        assert.deepStrictEqual(island.data.tags, ['idea', 'urgent', 'work'])
        assert.deepStrictEqual(island.data.defaults, { type: 'todo', notebookId: 'fWork', dayStart: '09:00' })
        assert.strictEqual(island.data.pickerOpen, false)
        assert.ok(!state.dialogHtml[0].includes('value="</script>'), 'a path in an attribute is HTML-escaped')
        const folderReads = state.dataGets.filter(get => get.path[0] === 'folders')
        assert.deepStrictEqual(folderReads.map(get => get.query.page), [1, 2, 3, 1, 2, 3],
            'the folders are read page by page: once at startup for the notebook setting\'s list, once by the form')
        assert.deepStrictEqual(folderReads[0].query.fields, ['id', 'title', 'parent_id'])
        assert.ok(folderReads.every(get => get.query.limit === 100), 'a hundred a page, the data API\'s largest (its default is 10)')
    })

    await check('form markup: the picker is Cockpit\'s, folded, single to-do (two quick rows, calendar, time columns; no plan, mode or explanation)', async () => {
        const { state } = await openFormWith({})
        const html = state.dialogHtml[0]
        assert.ok(/<div id="jotPicker" class="jot-picker" hidden>/.test(html), 'folded on open')
        for (const id of ['alarmFields', 'alarmDate', 'alarmTime', 'alarmQuick', 'alarmBody', 'alarmCalendar', 'alarmTimePanel', 'alarmHourCol', 'alarmMinuteCol']) {
            assert.ok(html.includes(`id="${id}"`), `#${id} is in the markup`)
        }
        const quick = html.slice(html.indexOf('id="alarmQuick"'), html.indexOf('id="alarmBody"'))
        const labels = (quick.match(/>([^<>]+)<\/button>/g) || []).map(match => match.slice(1, -9))
        assert.deepStrictEqual(labels, ['Today', 'Tomorrow', 'Weekends', 'Next Monday', '+hour', '+day', '+week', '+month(day)', '+month(date)'])
        assert.ok(/id="alarmDate" placeholder="YYYY-MM-DD"/.test(html) && /id="alarmTime" placeholder="HH:MM"/.test(html))
        assert.ok(!/<input[^>]*id="alarm(Date|Time)"[^>]*\bname=/.test(html), 'the picker\'s inputs carry no name: dueDate and dueTime are the values sent')
        for (const gone of ['alarmExplain', 'alarmMode', 'name="plan"', 'name="mode"']) assert.ok(!html.includes(gone), `${gone} is not ported`)
    })

    await check('form markup: the default type follows the setting (A note: "New note", the Due row greyed), and mobile carries the #jotPlatform marker', async () => {
        const { state } = await openFormWith({ settings: { defaultType: 'note' } })
        const html = state.dialogHtml[0]
        assert.ok(html.includes('>New note</strong>'))
        assert.ok(html.includes('class="jot-form -note"'))
        assert.ok(/<input type="hidden" name="type" id="jotType" value="note">/.test(html))
        assert.ok(/id="jotBell"[^>]*\bdisabled\b/.test(html), 'the bell is disabled for a note')
        assert.ok(/class="jot-seg-option -selected" data-value="note" role="radio" aria-checked="true" tabindex="0"/.test(html), 'Note is the checked radio and the tab stop')
        assert.strictEqual(islandOf(html).data.defaults.type, 'note')
        const onMobile = await openFormWith({ versionInfo: MOBILE })
        assert.ok(onMobile.state.dialogHtml[0].includes('<div id="jotPlatform" hidden></div>'))
    })

    await check('form: the default notebook is the editor note\'s, else the shown notebook, else the first by path (workspace read only as needed)', async () => {
        const fromNote = await openFormWith({ selectedNote: { id: 'n1', parent_id: 'fHome' }, selectedFolder: { id: 'fArch' } })
        assert.strictEqual(islandOf(fromNote.state.dialogHtml[0]).data.defaults.notebookId, 'fHome')
        assert.deepStrictEqual(fromNote.state.workspaceCalls, ['selectedNote'], 'selectedFolder is not asked when the note answered')
        const fromFolder = await openFormWith({ selectedNote: null, selectedFolder: { id: 'fArch' } })
        assert.strictEqual(islandOf(fromFolder.state.dialogHtml[0]).data.defaults.notebookId, 'fArch')
        assert.deepStrictEqual(fromFolder.state.workspaceCalls, ['selectedNote', 'selectedFolder'])
        const fromNothing = await openFormWith({ selectedNote: { id: 'n2', parent_id: 'gone' }, selectedFolder: { id: 'alsoGone' } })
        assert.strictEqual(islandOf(fromNothing.state.dialogHtml[0]).data.defaults.notebookId, 'fOdd', 'the first notebook by path')
    })

    await check('form: with no notebook at all the form does not open, and says "Jot: there is no notebook to create in."', async () => {
        const { state, outcome } = await openFormWith({ folders: [] })
        assert.deepStrictEqual(state.messageBoxes, ['Jot: there is no notebook to create in.'])
        assert.strictEqual(state.dialogOpens, 0)
        assert.deepStrictEqual(state.dialogCreates, ['jot.form'], 'only the warm-up\'s build; nothing opened')
        assert.strictEqual(outcome, null)
    })

    // ---------------------------------------------------------------- the form's writes
    await check('Create: a to-do with a due date and two tags (one existing, one new) is one POST notes, then the tags; nothing is opened', async () => {
        const { state, outcome } = await openFormWith({
            dialogResults: [formResult('ok', { title: '  Call the bank ', body: 'about the card', tags: ' Work, new one,work, ,', dueDate: '2026-10-14', dueTime: '10:30' })],
        })
        const noteId = outcome && outcome.id
        assert.ok(noteId, 'the command resolves with the new note id')
        assert.deepStrictEqual(outcome, { id: noteId, opened: false })
        assert.deepStrictEqual(state.dataPosts, [
            { path: ['notes'], query: null, body: { parent_id: 'fProj', is_todo: 1, title: 'Call the bank', body: 'about the card', todo_due: new Date(2026, 9, 14, 10, 30, 0, 0).getTime() } },
            { path: ['tags', 'tWork', 'notes'], query: null, body: { id: noteId } },
            { path: ['tags'], query: null, body: { title: 'new one' } },
            { path: ['tags', 'tag0002', 'notes'], query: null, body: { id: noteId } },
        ])
        assert.deepStrictEqual(state.executes, [READ_SELECTION], 'Create runs no command after the selection read: no open, no focus move, no edit')
        assert.deepStrictEqual(state.messageBoxes, [])
    })

    await check('Create: a note is is_todo 0 with todo_due 0, its Due fields neither read nor validated; no tags means no tag calls', async () => {
        const { state, outcome } = await openFormWith({
            dialogResults: [formResult('ok', { type: 'note', title: 'A thought', body: 'line one\nline two', dueDate: 'not a date', dueTime: '99:99' })],
        })
        assert.deepStrictEqual(state.dataPosts, [
            { path: ['notes'], query: null, body: { parent_id: 'fProj', is_todo: 0, title: 'A thought', body: 'line one\nline two', todo_due: 0 } },
        ])
        assert.deepStrictEqual(state.messageBoxes, [])
        assert.deepStrictEqual(state.executes, [READ_SELECTION])
        assert.strictEqual(outcome.opened, false)
    })

    await check('Create: the empty-title rule takes the first non-empty line of the Text as the title and removes it from the body', async () => {
        const { state } = await openFormWith({
            dialogResults: [formResult('ok', { title: '   ', body: '\n  Idea for later  \n\nmore text\nline 3' })],
        })
        const posts = notePosts(state)
        assert.strictEqual(posts.length, 1)
        assert.strictEqual(posts[0].body.title, 'Idea for later')
        assert.strictEqual(posts[0].body.body, 'more text\nline 3')
    })

    await check('Create and open: opens the new note in the editor (openNote with its id)', async () => {
        const { state, outcome } = await openFormWith({ dialogResults: [formResult('ok', { open: 'editor',  title: 'Open me' })] })
        assert.deepStrictEqual(state.executes, [READ_SELECTION, { name: 'openNote', args: [outcome.id] }])
        assert.deepStrictEqual(outcome, { id: outcome.id, opened: true })
    })

    await check('Open: New window runs openNoteInNewWindow; when that throws, openNote with one console warning; mobile offers no window and opens in the editor', async () => {
        const inWindow = await openFormWith({ dialogResults: [formResult('ok', { open: 'window', title: 'Window' })] })
        assert.deepStrictEqual(inWindow.state.executes, [READ_SELECTION, { name: 'openNoteInNewWindow', args: [inWindow.outcome.id] }])
        assert.deepStrictEqual(inWindow.state.warnings, [])
        const fallback = await openFormWith({
            executeThrows: ['openNoteInNewWindow'], dialogResults: [formResult('ok', { open: 'window', title: 'Old app' })],
        })
        assert.deepStrictEqual(fallback.state.executes.map(call => call.name), ['selectedText', 'openNoteInNewWindow', 'openNote'])
        assert.deepStrictEqual(fallback.state.executes[2].args, [fallback.outcome.id])
        assert.strictEqual(fallback.state.warnings.length, 1)
        assert.ok(fallback.state.warnings[0].startsWith('Jot: could not open the note in a new window'), fallback.state.warnings[0])
        assert.deepStrictEqual(fallback.state.messageBoxes, [], 'silently: no message box')
        const onMobile = await openFormWith({ versionInfo: MOBILE, dialogResults: [formResult('ok', { open: 'window', title: 'Phone' })] })
        assert.deepStrictEqual(onMobile.state.executes.map(call => call.name), ['selectedText', 'openNote'], 'mobile opens a forged window choice in the editor')
        assert.ok(!/data-value="window"/.test(onMobile.state.dialogHtml[0]), 'mobile offers no New window')
        const fromSetting = await openFormWith({ settings: { openAfterCreate: 'window' }, dialogResults: [formResult('ok', { title: 'Default window' })] })
        assert.deepStrictEqual(fromSetting.state.executes.map(call => call.name), ['selectedText', 'openNoteInNewWindow'], 'a result without the Open field takes the setting')
    })

    await check('both empty: Create creates nothing and closes; Create and open creates the empty note and opens it', async () => {
        const create = await openFormWith({ dialogResults: [formResult('ok', { title: '', body: ' \n ', tags: 'work', dueDate: '2026-10-14' })] })
        assert.deepStrictEqual(create.state.dataPosts, [])
        assert.deepStrictEqual(create.state.executes, [READ_SELECTION])
        assert.strictEqual(create.state.dialogOpens, 1, 'closed, not reopened')
        assert.strictEqual(create.outcome, null)
        const open = await openFormWith({ dialogResults: [formResult('ok', { open: 'editor',  title: '', body: '' })] })
        assert.deepStrictEqual(notePosts(open.state).map(post => post.body), [{ parent_id: 'fProj', is_todo: 1, title: '', body: '', todo_due: 0 }])
        assert.deepStrictEqual(open.state.executes, [READ_SELECTION, { name: 'openNote', args: [open.outcome.id] }])
    })

    await check('Cancel (and Escape, any other button) writes nothing and opens nothing', async () => {
        for (const id of ['cancel', 'close', undefined]) {
            const { state, outcome } = await openFormWith({ dialogResults: [formResult(id, { title: 'Never' })] })
            assert.deepStrictEqual(state.dataPosts, [], `button ${id}`)
            assert.deepStrictEqual(state.executes, [READ_SELECTION], `button ${id}`)
            assert.strictEqual(outcome, null)
        }
    })

    await check('invalid due: Create is refused with the brief\'s message, the form reopens with its values and the picker unfolded, then creates', async () => {
        const { state, outcome } = await openFormWith({
            dialogResults: [
                formResult('ok', { title: 'Pay rent', body: 'flat', tags: 'home', notebookId: 'fHome', dueDate: '2026-02-31', dueTime: '09:00' }),
                formResult('ok', { title: 'Pay rent', body: 'flat', tags: 'home', notebookId: 'fHome', dueDate: '2026-02-28', dueTime: '09:00' }),
            ],
        })
        assert.deepStrictEqual(state.messageBoxes, ['Jot: the date must be YYYY-MM-DD and the time HH:MM (24-hour).'])
        assert.strictEqual(state.dialogOpens, 2)
        const again = state.dialogHtml[1]
        assert.strictEqual(fieldValue(again, 'title'), 'Pay rent', 'the title is kept')
        assert.ok(again.includes('>\nflat</textarea>'), 'the text is kept')
        assert.strictEqual(fieldValue(again, 'tags'), 'home', 'the tags are kept')
        assert.ok(/name="notebookId" id="jotNotebookId" value="fHome"/.test(again), 'the notebook is kept')
        assert.ok(/name="dueDate" id="jotDueDate" value="2026-02-31"/.test(again), 'the refused date is kept, to be corrected')
        assert.ok(/<div id="jotPicker" class="jot-picker">/.test(again), 'the picker is unfolded')
        assert.strictEqual(islandOf(again).data.pickerOpen, true)
        assert.deepStrictEqual(notePosts(state).map(post => post.body.todo_due), [new Date(2026, 1, 28, 9, 0, 0, 0).getTime()])
        assert.strictEqual(outcome.opened, false)
    })

    await check('day start: a date without a time takes the dayStartTime setting; an unreadable setting falls back to 09:00', async () => {
        const set = await openFormWith({ settings: { dayStartTime: '07:30' }, dialogResults: [formResult('ok', { title: 'Early', dueDate: '2026-10-20' })] })
        assert.strictEqual(islandOf(set.state.dialogHtml[0]).data.defaults.dayStart, '07:30')
        assert.strictEqual(notePosts(set.state)[0].body.todo_due, new Date(2026, 9, 20, 7, 30).getTime())
        const unreadable = await openFormWith({ settings: { dayStartTime: 'soon' }, dialogResults: [formResult('ok', { title: 'Default', dueDate: '2026-10-20' })] })
        assert.strictEqual(islandOf(unreadable.state.dialogHtml[0]).data.defaults.dayStart, '09:00')
        assert.strictEqual(notePosts(unreadable.state)[0].body.todo_due, new Date(2026, 9, 20, 9, 0).getTime())
    })

    // ---------------------------------------------------------------- the selection route
    await check('selection route: jot.fromSelection reads the selection and opens the form prefilled (first non-empty line the Title, the rest the Text), with In this note before Due, the last row', async () => {
        const { state, outcome } = await openSelectionWith('\n  Buy milk  \n\nsemi-skimmed\n  2 litres')
        assert.deepStrictEqual(state.executes, [READ_SELECTION], 'the selection is read before the form opens; Cancel runs nothing else')
        assert.deepStrictEqual(state.globalReads, ['editor.codeView'], 'which editor is up is read once, for the buttons')
        const html = state.dialogHtml[0]
        assert.strictEqual(fieldValue(html, 'title'), 'Buy milk', 'the first non-empty line, trimmed, is the Title')
        assert.ok(html.includes('>\nsemi-skimmed\n  2 litres</textarea>'), 'the lines after it, blank lines first dropped, are the Text as typed')
        const order = ['name="tags"', 'id="jotInThisNoteRow"', 'id="jotDueRow"', 'id="jotPicker"', 'id="jotNotebookList"']
        const positions = order.map(marker => html.indexOf(marker))
        positions.forEach((position, index) => assert.ok(position >= 0, `${order[index]} is in the markup`))
        assert.deepStrictEqual(positions.slice().sort((a, b) => a - b), positions, 'In this note comes after Tags and before Due, so the picker unfolds last and pushes nothing down')
        assert.ok(html.includes('<span class="jot-label" id="jotInThisNoteLabel">In this note</span>'))
        assert.ok(/<div class="jot-seg -fill" role="radiogroup" aria-labelledby="jotInThisNoteLabel" data-field="inThisNote">/.test(html))
        assert.deepStrictEqual(choiceLabels(html), ['Replace with link', 'Keep text', 'Add link after'], 'one line of short labels, the default drawn first')
        assert.deepStrictEqual(choiceTitles(html), ['Replace it with a link to the new note', 'Keep the text', 'Add a link after it'], 'the full wording as tooltips')
        assert.ok(/data-value="keep" role="radio" aria-checked="false" tabindex="-1" title="Keep the text">Keep text</.test(html), 'Keep the text is offered, not chosen')
        assert.ok(/data-value="replace" role="radio" aria-checked="true" tabindex="0" title="Replace it with a link to the new note">Replace with link</.test(html), 'replace is the default')
        assert.ok(/<input type="hidden" name="inThisNote" id="jotInThisNote" value="replace">/.test(html))
        for (const button of html.match(/<button\b[^>]*>/g) || []) assert.ok(button.includes('type="button"'), `every button is type="button": ${button}`)
        assert.deepStrictEqual(islandOf(html).data.inThisNote, { choices: ['replace', 'keep', 'after'], value: 'replace', fallback: 'replace' })
        assert.strictEqual(outcome, null)
        assert.deepStrictEqual([state.dataPosts, state.settingWrites], [[], []], 'Cancel writes nothing and remembers nothing')
    })

    await check('selection route: the In this note default is lastSelectionAction; the Rich Text editor (editor.codeView false, or unreadable) offers Keep and Replace only', async () => {
        const remembered = await openSelectionWith('Pay rent', { settings: { selectionAction: 'replace' } })
        assert.deepStrictEqual(islandOf(remembered.state.dialogHtml[0]).data.inThisNote, { choices: ['replace', 'keep', 'after'], value: 'replace', fallback: 'replace' })
        const kept = await openSelectionWith('Pay rent', { settings: { selectionAction: 'keep' } })
        assert.strictEqual(islandOf(kept.state.dialogHtml[0]).data.inThisNote.value, 'keep', 'an install that remembers keep keeps it')
        assert.ok(/data-value="replace" role="radio" aria-checked="true" tabindex="0"/.test(remembered.state.dialogHtml[0]))
        assert.ok(/name="inThisNote" id="jotInThisNote" value="replace"/.test(remembered.state.dialogHtml[0]))
        const after = await openSelectionWith('Pay rent', { settings: { selectionAction: 'after' } })
        assert.strictEqual(islandOf(after.state.dialogHtml[0]).data.inThisNote.value, 'after')
        const richText = await openSelectionWith('Pay rent', { settings: { selectionAction: 'after' }, globalSettings: { 'editor.codeView': false } })
        const richHtml = richText.state.dialogHtml[0]
        assert.deepStrictEqual(islandOf(richHtml).data.inThisNote, { choices: ['replace', 'keep'], value: 'replace', fallback: 'replace' },
            'a remembered "after" falls back to the route\'s default, replace')
        assert.deepStrictEqual(choiceLabels(richHtml), ['Replace with link', 'Keep text'])
        assert.ok(!richHtml.includes('Add a link after it'), 'Add a link after it is not offered in the Rich Text editor')
        const richReplace = await openSelectionWith('Pay rent', { settings: { selectionAction: 'replace' }, globalSettings: { 'editor.codeView': false } })
        assert.strictEqual(islandOf(richReplace.state.dialogHtml[0]).data.inThisNote.value, 'replace')
        const unreadable = await openSelectionWith('Pay rent', { globalValueThrows: true })
        assert.deepStrictEqual(islandOf(unreadable.state.dialogHtml[0]).data.inThisNote.choices, ['replace', 'keep'], 'an editor that cannot be told is treated as Rich Text')
        assert.strictEqual(unreadable.state.warnings.length, 1)
        assert.ok(unreadable.state.warnings[0].startsWith('Jot: could not tell which editor is open'), unreadable.state.warnings[0])
        const forged = await openSelectionWith('Pay rent', {
            globalSettings: { 'editor.codeView': false }, dialogResults: [formResult('ok', { title: 'Pay rent', inThisNote: 'after' })],
        })
        assert.deepStrictEqual(forged.state.timeline, ['execute selectedText', 'POST notes', 'execute insertText'],
            'an "after" the Rich Text form never offered is applied as the route\'s default, replace (insertText, never the HTML replaceSelection)')
    })

    await check('selection route, replace: POST notes, then insertText with [Title](:/id) under the final title, then the tag calls; nothing opened; the choice remembered', async () => {
        const { state, outcome } = await openSelectionWith('Call the bank\nabout the card', {
            dialogResults: [formResult('ok', { title: ' Call the [bank] ', body: 'about the card', tags: 'work, new one', inThisNote: 'replace' })],
        })
        assert.deepStrictEqual(outcome, { id: outcome.id, opened: false })
        assert.deepStrictEqual(state.timeline, [
            'execute selectedText', 'POST notes', 'execute insertText',
            'POST tags/tWork/notes', 'POST tags', 'POST tags/tag0002/notes',
        ], 'the edit before the tags: a tag write can make Joplin select another note')
        assert.deepStrictEqual(state.executes[1], { name: 'insertText', args: [`[Call the \\[bank\\]](:/${outcome.id})`] }, 'the trimmed title, brackets escaped')
        assert.deepStrictEqual(state.warnings, [])
        const rich = await openSelectionWith('Call the bank', {
            globalSettings: { 'editor.codeView': false }, dialogResults: [formResult('ok', { title: 'Call the bank', inThisNote: 'replace' })],
        })
        assert.deepStrictEqual(rich.state.executes.slice(1), [{ name: 'insertText', args: [`[Call the bank](:/${rich.outcome.id})`] }], 'insertText in the Rich Text editor too')
    })

    await check('selection route, after (Markdown editor): replaceSelection with the selection and the link, after a space for one line, on its own line for several; the open comes last', async () => {
        const one = await openSelectionWith('Pay rent', { dialogResults: [formResult('ok', { title: 'Pay rent', inThisNote: 'after' })] })
        assert.deepStrictEqual(one.state.executes.slice(1), [{ name: 'replaceSelection', args: [`Pay rent [Pay rent](:/${one.outcome.id})`] }])
        const several = await openSelectionWith('Pay rent\nby Friday', {
            dialogResults: [formResult('ok', { open: 'editor',  title: 'Rent', body: 'by Friday', tags: 'home', inThisNote: 'after' })],
        })
        assert.deepStrictEqual(several.state.timeline, [
            'execute selectedText', 'POST notes', 'execute replaceSelection',
            'POST tags', 'POST tags/tag0002/notes', 'execute openNote',
        ], 'Create and open: the edit reaches the note the selection came from before the tags and before the editor switches')
        assert.deepStrictEqual(several.state.executes[1].args, [`Pay rent\nby Friday\n[Rent](:/${several.outcome.id})`])
        assert.deepStrictEqual(several.state.executes[2], { name: 'openNote', args: [several.outcome.id] })
        assert.deepStrictEqual(several.outcome, { id: several.outcome.id, opened: true })
    })

    await check('selection route, keep: no edit at all; Create and open opens the new note; replace with an empty Title links the title the empty-title rule gave', async () => {
        const keep = await openSelectionWith('Idea\nmore', { dialogResults: [formResult('ok', { open: 'editor',  title: 'Idea', body: 'more', inThisNote: 'keep' })] })
        assert.deepStrictEqual(keep.state.timeline, ['execute selectedText', 'POST notes', 'execute openNote'])
        assert.deepStrictEqual(keep.outcome, { id: keep.outcome.id, opened: true })
        const missing = await openSelectionWith('Idea', { dialogResults: [formResult('ok', { title: 'Idea' })] })
        assert.deepStrictEqual(missing.state.timeline, ['execute selectedText', 'POST notes', 'execute insertText'],
            'a result without the field is the route\'s default, replace')
        const emptied = await openSelectionWith('First\nrest', { dialogResults: [formResult('ok', { title: '  ', body: 'First line\nrest', inThisNote: 'replace' })] })
        assert.strictEqual(notePosts(emptied.state)[0].body.title, 'First line')
        assert.deepStrictEqual(emptied.state.executes[1].args, [`[First line](:/${emptied.outcome.id})`])
    })

    await check('issue 5: In this note remembers nothing - no setting is written on any route; each open starts on the selectionAction / triggerAction setting', async () => {
        const plain = await openFormWith({ dialogResults: [formResult('ok', { title: 'Plain', inThisNote: 'replace' })] })
        assert.deepStrictEqual(plain.state.settingWrites, [], 'the plain route writes nothing')
        assert.deepStrictEqual(plain.state.executes, [READ_SELECTION], 'and makes no edit, whatever the result carries')
        assert.ok(!plain.state.dialogHtml[0].includes('jotInThisNote'), 'the plain form has no In this note row')
        assert.strictEqual(islandOf(plain.state.dialogHtml[0]).data.inThisNote, null)
        const created = await openSelectionWith('Idea', { dialogResults: [formResult('ok', { title: 'Idea', inThisNote: 'after' })] })
        assert.deepStrictEqual(created.state.settingWrites, [], 'Add a link after it chosen in the form is not remembered')
        const trigger = await fireTriggerWith({ dialogResults: [formResult('ok', { title: 'T', inThisNote: 'remove' })] })
        assert.deepStrictEqual(trigger.state.settingWrites, [])
        const keep = await openSelectionWith('Idea', { settings: { selectionAction: 'keep' } })
        assert.strictEqual(islandOf(keep.state.dialogHtml[0]).data.inThisNote.value, 'keep', 'the setting is where it starts')
        const remove = await fireTriggerWith({ settings: { triggerAction: 'remove' } })
        assert.strictEqual(islandOf(remove.state.dialogHtml[0]).data.inThisNote.value, 'remove')
    })

    await check('no selection: a throwing selectedText, a non-string, an empty or whitespace-only answer all open the plain form (no row, no editor read)', async () => {
        const thrown = await openSelectionWith(undefined, { executeThrows: ['selectedText'], dialogResults: [formResult('ok', { title: 'Plain', inThisNote: 'replace' })] })
        assert.ok(!thrown.state.dialogHtml[0].includes('jotInThisNoteRow'))
        assert.strictEqual(islandOf(thrown.state.dialogHtml[0]).data.inThisNote, null)
        assert.deepStrictEqual(thrown.state.globalReads, [], 'the editor is not asked about on the plain route')
        assert.strictEqual(thrown.state.warnings.length, 1)
        assert.ok(thrown.state.warnings[0].startsWith('Jot: could not read the editor\'s selection'), thrown.state.warnings[0])
        assert.deepStrictEqual(thrown.state.timeline, ['execute selectedText', 'POST notes'], 'the note is created, with no edit and no memory')
        assert.strictEqual(fieldValue(thrown.state.dialogHtml[0], 'title'), '', 'nothing prefilled')
        for (const answer of [42, null, { text: 'x' }, '', '  \n\t ']) {
            const { state } = await openSelectionWith(answer)
            assert.ok(!state.dialogHtml[0].includes('jotInThisNoteRow'), `${JSON.stringify(answer)} is no selection`)
            assert.deepStrictEqual(state.globalReads, [])
            assert.deepStrictEqual(state.warnings, [])
        }
    })

    await check('one chord serves both: jot.open and jot.button take the selection route when selectedText returns text; jot.fromSelection with none is the plain form', async () => {
        for (const command of ['jot.open', 'jot.button']) {
            const { state, outcome } = await openSelectionWith('Idea for later', {
                settings: { selectionAction: 'replace' }, dialogResults: [formResult('ok', { title: 'Idea for later', inThisNote: 'replace' })],
            }, command)
            assert.strictEqual(fieldValue(state.dialogHtml[0], 'title'), 'Idea for later', `${command} prefills the Title`)
            assert.ok(state.dialogHtml[0].includes('id="jotInThisNoteRow"'), `${command} shows In this note`)
            assert.deepStrictEqual(state.executes.slice(1), [{ name: 'insertText', args: [`[Idea for later](:/${outcome.id})`] }])
        }
        const none = await openSelectionWith(undefined, {}, 'jot.fromSelection')
        assert.ok(!none.state.dialogHtml[0].includes('jotInThisNoteRow'), 'no selection: the same form as jot.open')
        assert.strictEqual(none.state.dialogOpens, 1)
    })

    await check('an edit that throws is a console warning: the note stays created, the choice is remembered, and Create and open still opens', async () => {
        const { state, outcome } = await openSelectionWith('Idea', {
            executeThrows: ['insertText'], dialogResults: [formResult('ok', { open: 'editor',  title: 'Idea', inThisNote: 'replace' })],
        })
        assert.deepStrictEqual(outcome, { id: outcome.id, opened: true })
        assert.deepStrictEqual(state.timeline, ['execute selectedText', 'POST notes', 'execute insertText', 'execute openNote'])
        assert.strictEqual(state.warnings.length, 1)
        assert.ok(state.warnings[0].startsWith('Jot: could not change the highlighted text (insertText)'), state.warnings[0])
        assert.deepStrictEqual(state.messageBoxes, [])
    })

    await check('tags in Unicode NFC: the csv, the suggestions and the reuse of an existing tag compare titles as Joplin does (trimmed, NFC, lower-cased)', async () => {
        // The pure module is required further down for its own checks; this one sits with the host's.
        const Model = require(path.join(ROOT, 'src', 'form', 'formModel.js'))
        const nfc = 'caf\u00e9', nfd = 'cafe\u0301'
        assert.notStrictEqual(nfc, nfd)
        assert.strictEqual(Model.tagKey(` ${nfd.toUpperCase()} `), nfc)
        assert.deepStrictEqual(Model.parseTagCsv(`${nfd}, ${nfc}, Caf\u00c9`), [nfc], 'one tag however it was typed')
        assert.deepStrictEqual(Model.tagSuggestions([nfc, 'cafeteria'], `${nfd}, caf`, Model.tagTokenAt(`${nfd}, caf`, 9)), ['cafeteria'], 'a tag already in the field in another form is not offered again')
        const { state, outcome } = await openFormWith({
            tags: [{ id: 'tCafe', title: 'Caf\u00e9' }, ...TAGS],
            dialogResults: [formResult('ok', { title: 'Coffee', tags: nfd.toUpperCase() })],
        })
        assert.deepStrictEqual(state.dataPosts.slice(1), [{ path: ['tags', 'tCafe', 'notes'], query: null, body: { id: outcome.id } }],
            'the tag typed in another normal form is the existing one: no POST tags, which Joplin would refuse as a duplicate')
        const host = read('src/form/form.ts')
        const attach = host.slice(host.indexOf('async function attachTags'), host.indexOf('/** openCreatedNote'))
        assert.ok(attach.includes('FormModel.tagKey(tag.title)') && !attach.includes('toLowerCase()'), 'the map keys are tagKeys')
    })

    await check('a tag call that fails is a console warning: the note stays created, the other tags are attached, the In this note edit and the open still run', async () => {
        // POST tags refused (as Joplin refuses a duplicate): that tag is skipped, the next is created and attached, then the edit and the open.
        const refused = await openSelectionWith('Idea', {
            postThrows: (pathParts, body) => pathParts.length === 1 && pathParts[0] === 'tags' && body.title === 'first',
            dialogResults: [formResult('ok', { open: 'editor',  title: 'Idea', tags: 'first, second, work', inThisNote: 'replace' })],
        })
        assert.deepStrictEqual(refused.outcome, { id: refused.outcome.id, opened: true }, 'the command resolves, it does not throw')
        assert.deepStrictEqual(refused.state.timeline, [
            'execute selectedText', 'POST notes', 'execute insertText',
            'POST tags', 'POST tags', 'POST tags/tag0002/notes', 'POST tags/tWork/notes', 'execute openNote',
        ])
        assert.deepStrictEqual(refused.state.warnings.filter(line => line.startsWith('Jot: could not add the tag "first"')).length, 1, refused.state.warnings.join(' | '))
        // POST tags/:id/notes refused: the same.
        const unattached = await openFormWith({
            postThrows: (pathParts) => pathParts.length === 3 && pathParts[1] === 'tWork',
            dialogResults: [formResult('ok', { open: 'editor',  title: 'Plan', tags: 'work, idea' })],
        })
        assert.deepStrictEqual(unattached.outcome.opened, true)
        assert.deepStrictEqual(unattached.state.timeline, ['execute selectedText', 'POST notes', 'POST tags/tWork/notes', 'POST tags/tIdea/notes', 'execute openNote'])
        assert.ok(unattached.state.warnings.some(line => line.startsWith('Jot: could not add the tag "work"')), unattached.state.warnings.join(' | '))
        // The tag list unreadable at Create (the two pages read for the form succeed, the read in attachTags fails): every tag is tried by POST tags.
        const unread = await openFormWith({ tagsGetThrows: 2, dialogResults: [formResult('ok', { title: 'Plan', tags: 'urgent' })] })
        assert.ok(unread.outcome && unread.outcome.id, 'the command resolves with the note')
        assert.deepStrictEqual(unread.state.timeline, ['execute selectedText', 'POST notes', 'POST tags', 'POST tags/tag0002/notes'])
        assert.ok(unread.state.warnings.some(line => line.startsWith('Jot: could not read the tags')), unread.state.warnings.join(' | '))
    })

    await check('a refused Create on the selection route reopens with the In this note choice kept, the Title and Text as typed', async () => {
        const { state, outcome } = await openSelectionWith('Pay rent\nflat', {
            dialogResults: [
                formResult('ok', { title: 'Pay rent', body: 'flat', inThisNote: 'after', dueDate: '2026-02-31', dueTime: '09:00' }),
                formResult('ok', { title: 'Pay rent', body: 'flat', inThisNote: 'after', dueDate: '2026-02-28', dueTime: '09:00' }),
            ],
        })
        assert.strictEqual(state.dialogOpens, 2)
        const again = state.dialogHtml[1]
        assert.ok(/data-value="after" role="radio" aria-checked="true" tabindex="0"/.test(again), 'after is still the checked radio')
        assert.ok(/name="inThisNote" id="jotInThisNote" value="after"/.test(again))
        assert.deepStrictEqual(islandOf(again).data.inThisNote, { choices: ['replace', 'keep', 'after'], value: 'after', fallback: 'replace' })
        assert.deepStrictEqual(state.globalReads, ['editor.codeView'], 'the editor is asked once, not on the reopen')
        assert.deepStrictEqual(state.executes.slice(1), [{ name: 'replaceSelection', args: [`Pay rent\nflat\n[Pay rent](:/${outcome.id})`] }])
    })

    // ---------------------------------------------------------------- the typed trigger: the plugin's handler
    await check('trigger handler: a config message answers { trigger } with the setting trimmed ("" off); anything unknown answers null', async () => {
        const { handler } = await triggerHandlerWith({})
        assert.deepStrictEqual(await handler({ type: 'config' }), { trigger: '++' }, 'the default')
        for (const [value, expected] of [[' ;; ', ';;'], ['', ''], ['   ', ''], [42, ''], ['@@jot', '@@jot']]) {
            const set = await triggerHandlerWith({ settings: { trigger: value } })
            assert.deepStrictEqual(await set.handler({ type: 'config' }), { trigger: expected }, JSON.stringify(value))
        }
        for (const message of [{ type: 'lint' }, {}, null, 'config', 42]) assert.strictEqual(await handler(message), null, JSON.stringify(message))
    })

    await check('trigger handler: a trigger message opens the form on the trigger route - no prefill, no selection read, In this note with Replace ++ with a link to the new note and Remove ++, the link first and the default - and Cancel answers cancel', async () => {
        const { state, answer } = await fireTriggerWith({})
        assert.deepStrictEqual(answer, { action: 'cancel' })
        assert.strictEqual(state.dialogOpens, 1)
        assert.deepStrictEqual(state.executes, [], 'no editor command at all: the selection is not read, nothing is edited from the plugin')
        assert.deepStrictEqual(state.globalReads, [], 'which editor is up is not asked: the content script only runs in the Markdown editor')
        const html = state.dialogHtml[0]
        assert.strictEqual(fieldValue(html, 'title'), '', 'no title prefill')
        assert.ok(html.includes('>\n</textarea>'), 'no text prefill')
        assert.ok(html.includes('<strong id="jotHeading" class="jot-heading">New to-do</strong>'), 'the default type')
        assert.ok(/name="notebookId" id="jotNotebookId" value="fWork"/.test(html), 'the notebook of the note the editor holds')
        assert.deepStrictEqual(choiceLabels(html), ['Replace ++ with link', 'Remove ++'])
        assert.deepStrictEqual(choiceTitles(html), ['Replace ++ with a link to the new note', 'Remove ++'])
        assert.ok(/data-value="link" role="radio" aria-checked="true" tabindex="0" title="Replace \+\+ with a link to the new note">Replace \+\+ with link</.test(html), 'link is the default')
        assert.ok(/<input type="hidden" name="inThisNote" id="jotInThisNote" value="link">/.test(html))
        assert.deepStrictEqual(islandOf(html).data.inThisNote, { choices: ['link', 'remove'], value: 'link', fallback: 'link' })
        for (const button of html.match(/<button\b[^>]*>/g) || []) assert.ok(button.includes('type="button"'), `every button is type="button": ${button}`)
        assert.deepStrictEqual([state.dataPosts, state.settingWrites], [[], []], 'Cancel writes nothing and remembers nothing')
    })

    await check('trigger handler: the labels print the trigger fired with (HTML-escaped), the setting when the message has none; the default is lastTriggerAction, an unknown one is link', async () => {
        const custom = await fireTriggerWith({}, ';;')
        assert.deepStrictEqual(choiceLabels(custom.state.dialogHtml[0]), ['Replace ;; with link', 'Remove ;;'])
        assert.deepStrictEqual(choiceTitles(custom.state.dialogHtml[0]), ['Replace ;; with a link to the new note', 'Remove ;;'])
        const odd = await fireTriggerWith({}, '<b>')
        assert.ok(odd.state.dialogHtml[0].includes('>Remove &lt;b&gt;</button>'), 'the trigger is escaped in the markup')
        const { handler, state } = await triggerHandlerWith({ settings: { trigger: '@@' } })
        await handler({ type: 'trigger', from: 0, to: 2 })
        assert.deepStrictEqual(choiceLabels(state.dialogHtml[0]), ['Replace @@ with link', 'Remove @@'])
        const kept = await fireTriggerWith({ settings: { triggerAction: 'remove' } })
        assert.deepStrictEqual(islandOf(kept.state.dialogHtml[0]).data.inThisNote, { choices: ['link', 'remove'], value: 'remove', fallback: 'link' }, 'an install that remembers remove keeps it')
        assert.ok(/data-value="remove" role="radio" aria-checked="true" tabindex="0"/.test(kept.state.dialogHtml[0]))
        const remembered = await fireTriggerWith({ settings: { triggerAction: 'link' } })
        assert.deepStrictEqual(islandOf(remembered.state.dialogHtml[0]).data.inThisNote, { choices: ['link', 'remove'], value: 'link', fallback: 'link' })
        assert.ok(/data-value="link" role="radio" aria-checked="true" tabindex="0"/.test(remembered.state.dialogHtml[0]))
        const bogus = await fireTriggerWith({ settings: { triggerAction: 'keep' } })
        assert.strictEqual(islandOf(bogus.state.dialogHtml[0]).data.inThisNote.value, 'link', 'the selection route\'s keep is not a trigger choice: the default, link')
    })

    await check('trigger handler: Create with remove answers { action: \'remove\' }; with link { action: \'link\', link: [Title](:/id) } as the selection route builds it; the choice is remembered', async () => {
        const remove = await fireTriggerWith({ dialogResults: [formResult('ok', { title: 'Call the bank', tags: 'work', inThisNote: 'remove' })] })
        assert.deepStrictEqual(remove.answer, { action: 'remove' })
        assert.deepStrictEqual(remove.state.timeline, ['POST notes'], 'answered before the tags: the content script makes its edit first')
        await tick(30)
        assert.deepStrictEqual(remove.state.timeline, ['POST notes', 'POST tags/tWork/notes'], 'then the tags; nothing opened, no editor command')
        assert.deepStrictEqual(notePosts(remove.state)[0].body, { parent_id: 'fProj', is_todo: 1, title: 'Call the bank', body: '', todo_due: 0 })
        const link = await fireTriggerWith({ dialogResults: [formResult('ok', { title: ' Call the [bank] ', inThisNote: 'link' })] })
        assert.deepStrictEqual(link.answer, { action: 'link', link: '[Call the \\[bank\\]](:/note0001)' }, 'the trimmed title, brackets escaped')
        assert.deepStrictEqual(link.state.timeline, ['POST notes'])
        assert.deepStrictEqual(link.state.executes, [])
        const emptied = await fireTriggerWith({ dialogResults: [formResult('ok', { title: '', body: 'First line\nrest', inThisNote: 'link' })] })
        assert.deepStrictEqual(emptied.answer, { action: 'link', link: '[First line](:/note0001)' }, 'the title the empty-title rule gave')
        const missing = await fireTriggerWith({ dialogResults: [formResult('ok', { title: 'No field' })] })
        assert.deepStrictEqual(missing.answer, { action: 'link', link: '[No field](:/note0001)' }, 'a result without the field is the route\'s default, the link')
    })

    await check('trigger handler: an empty Create, Escape and any other button answer cancel and write nothing; a refused Create reopens and then answers', async () => {
        for (const result of [formResult('ok', { title: '', body: ' \n ', inThisNote: 'link' }), formResult('cancel', { title: 'x' }), formResult(undefined, { title: 'x' }), formResult('close', {})]) {
            const { state, answer } = await fireTriggerWith({ dialogResults: [result] })
            assert.deepStrictEqual(answer, { action: 'cancel' }, JSON.stringify(result.id))
            assert.deepStrictEqual([state.dataPosts, state.settingWrites, state.executes], [[], [], []])
        }
        const refused = await fireTriggerWith({
            dialogResults: [
                formResult('ok', { title: 'Pay rent', inThisNote: 'link', dueDate: '2026-02-31', dueTime: '09:00' }),
                formResult('ok', { title: 'Pay rent', inThisNote: 'link', dueDate: '2026-02-28', dueTime: '09:00' }),
            ],
        })
        assert.strictEqual(refused.state.dialogOpens, 2)
        assert.deepStrictEqual(islandOf(refused.state.dialogHtml[1]).data.inThisNote, { choices: ['link', 'remove'], value: 'link', fallback: 'link' }, 'the choice is kept on the reopen')
        assert.deepStrictEqual(choiceLabels(refused.state.dialogHtml[1]), ['Replace ++ with link', 'Remove ++'])
        assert.deepStrictEqual(refused.answer, { action: 'link', link: '[Pay rent](:/note0001)' })
        const none = await fireTriggerWith({ folders: [] })
        assert.deepStrictEqual([none.answer, none.state.messageBoxes], [{ action: 'cancel' }, ['Jot: there is no notebook to create in.']])
    })

    await check('trigger handler: Create and open answers with open: id and opens nothing until the content script asks; the open message opens that note once, in the editor or a new window', async () => {
        const { state, handler, answer } = await fireTriggerWith({ dialogResults: [formResult('ok', { open: 'editor',  title: 'Open me', inThisNote: 'remove' })] })
        assert.deepStrictEqual(answer, { action: 'remove', open: 'note0001' })
        assert.deepStrictEqual(state.timeline, ['POST notes'], 'not opened yet: the edit must reach the note the trigger was typed in first')
        assert.deepStrictEqual(await handler({ type: 'open', id: 'someOtherNote' }), { opened: false }, 'only the note the trigger form created')
        assert.deepStrictEqual(await handler({ type: 'open', id: 'note0001' }), { opened: true })
        assert.deepStrictEqual(state.executes, [{ name: 'openNote', args: ['note0001'] }])
        assert.deepStrictEqual(await handler({ type: 'open', id: 'note0001' }), { opened: false }, 'once')
        assert.deepStrictEqual(await handler({ type: 'open' }), { opened: false })
        assert.strictEqual(state.executes.length, 1)
        const windowed = await fireTriggerWith({ dialogResults: [formResult('ok', { open: 'window', title: 'Window', inThisNote: 'link' })] })
        assert.deepStrictEqual(windowed.answer, { action: 'link', link: '[Window](:/note0001)', open: 'note0001' })
        await windowed.handler({ type: 'open', id: 'note0001' })
        assert.deepStrictEqual(windowed.state.executes, [{ name: 'openNoteInNewWindow', args: ['note0001'] }])
    })

    await check('trigger handler: one form at a time - a trigger while the form is up answers cancel at once, and a command while the trigger\'s form is up resolves null', async () => {
        let release
        const held = new Promise(resolve => { release = resolve })
        const { state, handler } = await triggerHandlerWith({ openDialog: () => held })
        const first = handler({ type: 'trigger', from: 0, to: 2, trigger: '++' })
        await tick(10)
        assert.deepStrictEqual(await handler({ type: 'trigger', from: 5, to: 7, trigger: '++' }), { action: 'cancel' })
        assert.strictEqual(await state.commands.find(item => item.name === 'jot.open').execute(), null)
        release(formResult('ok', { title: 'First', inThisNote: 'remove' }))
        assert.deepStrictEqual(await first, { action: 'remove' })
        assert.strictEqual(state.dialogOpens, 1)
    })

    // ---------------------------------------------------------------- edit mode and the command contract
    await check('edit mode: jot.open { mode: \'edit\', noteId } reads the note (title, is_todo, parent_id, todo_due) and its tags, and builds a second handle, jot.edit, on its first open - the same five scripts, Save (id ok) and Cancel; nothing is run in the editor', async () => {
        const { state, outcome } = await editWith({})
        assert.strictEqual(outcome, null, 'Cancel (the stub\'s default answer) resolves null')
        assert.deepStrictEqual(noteReads(state), ['notes/nEdit id,title,is_todo,parent_id,todo_due', 'notes/nEdit/tags id,title'])
        assert.deepStrictEqual(state.dialogCreates, ['jot.form', 'jot.edit'], 'the create form\'s from the warm-up, then edit mode\'s on its first open')
        const five = ['./form/form.css', './form/alarmQuick.js', './form/searchTokens.js', './form/formModel.js', './form/formWebview.js']
        assert.deepStrictEqual(state.dialogScripts.slice().sort(), five.concat(five).sort(), 'the same five scripts for each handle (the two builds may interleave)')
        assert.deepStrictEqual(state.dialogButtons.map(buttons => buttons.map(button => button.title).join('/')).sort(), ['Create/Cancel', 'Save/Cancel'],
            'the create form\'s buttons (warm-up) and edit mode\'s: Save (id ok) and Cancel')
        assert.ok(state.dialogButtons.some(buttons => JSON.stringify(buttons) === JSON.stringify([{ id: 'ok', title: 'Save' }, { id: 'cancel', title: 'Cancel' }])))
        assert.deepStrictEqual(state.executes, [], 'no selection read, no open, no focus move')
        assert.deepStrictEqual(state.timeline, [])
        // Both modes in one session: each handle built once, with its own buttons.
        const both = await runBundle({ ...FORM_BASE, ...EDIT_BASE })
        const open = both.commands.find(item => item.name === 'jot.open')
        await withWarnings(both, async () => { await open.execute(); await open.execute(EDIT_ARGS); await open.execute(EDIT_ARGS); await open.execute() })
        assert.deepStrictEqual(both.dialogCreates, ['jot.form', 'jot.edit'])
        assert.deepStrictEqual(both.dialogButtons.map(buttons => buttons.map(button => button.title)), [['Create', 'Cancel'], ['Save', 'Cancel']])
        assert.strictEqual(both.dialogOpens, 4)
    })

    await check('edit mode prefill: "Edit to-do", the title, the notebook\'s path, the tags as a csv, the due date and time in local time (seconds dropped); Type, Title, Notebook, Tags and Due only - no Text, no In this note', async () => {
        const { state } = await editWith({})
        const html = state.dialogHtml[0]
        assert.ok(html.includes('<strong id="jotHeading" class="jot-heading">Edit to-do</strong>'))
        assert.ok(/data-value="todo" role="radio" aria-checked="true"/.test(html), 'the note\'s type')
        assert.ok(fieldValue(html, 'title') === 'Call the bank' && /<textarea name="title"[^>]*\bautofocus\b/.test(html), 'the title, focused')
        assert.ok(/<input type="text" id="jotNotebook"[^>]*value="Work"/.test(html) && /name="notebookId" id="jotNotebookId" value="fWork"/.test(html), 'the notebook')
        assert.strictEqual(fieldValue(html, 'tags'), 'urgent, work', 'the tags, sorted, as the csv the field edits')
        assert.ok(/name="dueDate" id="jotDueDate" value="2026-10-14"/.test(html) && /name="dueTime" id="jotDueTime" value="10:30"/.test(html), 'the due, local')
        assert.ok(html.includes('<span id="jotDueText" class="jot-due-text">2026-10-14 10:30</span>'))
        assert.ok(/id="alarmDate"[^>]*value="2026-10-14"/.test(html) && /id="alarmTime"[^>]*value="10:30"/.test(html), 'the picker\'s inputs too')
        for (const gone of ['name="body"', 'id="jotBody"', '>Text<', 'jotInThisNoteRow', 'name="inThisNote"']) assert.ok(!html.includes(gone), `${gone} is not in edit mode`)
        const order = ['name="type"', 'name="title"', 'id="jotNotebook"', 'name="tags"', 'id="jotDueRow"', 'id="jotPicker"']
        const positions = order.map(marker => html.indexOf(marker))
        positions.forEach((position, index) => assert.ok(position >= 0, `${order[index]} is in the markup`))
        assert.deepStrictEqual(positions.slice().sort((a, b) => a - b), positions)
        for (const button of html.match(/<button\b[^>]*>/g) || []) assert.ok(button.includes('type="button"'), `every button is type="button": ${button}`)
        const island = islandOf(html).data
        assert.strictEqual(island.mode, 'edit', 'the island says edit, so the script keeps the Edit wording when Type is switched')
        assert.deepStrictEqual(island.defaults, { type: 'todo', notebookId: 'fWork', dayStart: '09:00' })
        assert.strictEqual(island.inThisNote, null)
        assert.deepStrictEqual(island.tags, ['idea', 'urgent', 'work'], 'every tag is offered, as in create mode')
        // A note: "Edit note", the Due row greyed and No date, even with a todo_due left on it (Joplin keeps none on a note).
        const note = await editWith({ notes: { nEdit: { ...EDIT_NOTE, is_todo: 0 } } })
        const noteHtml = note.state.dialogHtml[0]
        assert.ok(noteHtml.includes('>Edit note</strong>') && noteHtml.includes('class="jot-form -note"'))
        assert.ok(noteHtml.includes('<span id="jotDueText" class="jot-due-text">No date</span>') && /id="jotBell"[^>]*\bdisabled\b/.test(noteHtml))
        // Create mode's island says create.
        const created = await openFormWith({})
        assert.strictEqual(islandOf(created.state.dialogHtml[0]).data.mode, 'create')
    })

    await check('edit mode: Save on an unchanged form makes no call at all and resolves { id, changed: [] } (the Due\'s seconds are not a change; nor are the title\'s spaces, the tags\' case and order, or an empty notebook id)', async () => {
        const { state, outcome } = await editWith({ dialogResults: [editResult('ok', {})] })
        assert.deepStrictEqual(outcome, { id: 'nEdit', changed: [] })
        assert.deepStrictEqual(state.timeline, [], 'no PUT, no tag call, no command')
        assert.deepStrictEqual([state.dataPuts, state.dataPosts, state.dataDeletes, state.executes, state.messageBoxes], [[], [], [], [], []])
        const loose = await editWith({ dialogResults: [editResult('ok', { title: '  Call the bank ', tags: ' WORK,urgent, ', notebookId: '' })] })
        assert.deepStrictEqual(loose.outcome, { id: 'nEdit', changed: [] })
        assert.deepStrictEqual(loose.state.timeline, [])
    })

    await check('edit mode: each field changed alone is exactly one PUT notes/:id with only that field - title (trimmed), parent_id, todo_due (0 to clear); several are still one PUT', async () => {
        const cases = [
            [{ title: '  Call the bank today ' }, { title: 'Call the bank today' }, ['title']],
            [{ title: '' }, { title: '' }, ['title']],
            [{ notebookId: 'fProj' }, { parent_id: 'fProj' }, ['parent_id']],
            [{ dueDate: '2026-10-15' }, { todo_due: new Date(2026, 9, 15, 10, 30).getTime() }, ['todo_due']],
            [{ dueTime: '18:05' }, { todo_due: new Date(2026, 9, 14, 18, 5).getTime() }, ['todo_due']],
            [{ dueDate: '', dueTime: '' }, { todo_due: 0 }, ['todo_due']],
        ]
        for (const [fields, body, changed] of cases) {
            const { state, outcome } = await editWith({ dialogResults: [editResult('ok', fields)] })
            assert.deepStrictEqual(state.dataPuts, [{ path: ['notes', 'nEdit'], query: null, body }], JSON.stringify(fields))
            assert.deepStrictEqual(state.timeline, ['PUT notes/nEdit'], JSON.stringify(fields))
            assert.deepStrictEqual(outcome, { id: 'nEdit', changed }, JSON.stringify(fields))
        }
        const several = await editWith({ dialogResults: [editResult('ok', { title: 'Renamed', notebookId: 'fHome', dueTime: '11:00' })] })
        assert.deepStrictEqual(several.state.dataPuts.map(put => put.body), [{ title: 'Renamed', parent_id: 'fHome', todo_due: new Date(2026, 9, 14, 11, 0).getTime() }])
        assert.deepStrictEqual(several.outcome, { id: 'nEdit', changed: ['title', 'parent_id', 'todo_due'] })
    })

    await check('edit mode: a type switch writes is_todo and clears todo_due and todo_completed in both directions (Joplin\'s changeNoteType); a switch to to-do takes the Due on top, in the same PUT', async () => {
        const toNote = await editWith({ dialogResults: [editResult('ok', { type: 'note' })] })
        assert.deepStrictEqual(toNote.state.dataPuts.map(put => put.body), [{ is_todo: 0, todo_due: 0, todo_completed: 0 }])
        assert.deepStrictEqual(toNote.outcome, { id: 'nEdit', changed: ['is_todo', 'todo_due'] })
        const unreadDue = await editWith({ dialogResults: [editResult('ok', { type: 'note', dueDate: 'soon' })] })
        assert.deepStrictEqual(unreadDue.state.dataPuts.map(put => put.body), [{ is_todo: 0, todo_due: 0, todo_completed: 0 }], 'a note\'s Due is not read')
        assert.deepStrictEqual(unreadDue.state.messageBoxes, [])
        const asNote = { notes: { nEdit: { ...EDIT_NOTE, is_todo: 0, todo_due: 0 } } }
        const toTodo = await editWith({ ...asNote, dialogResults: [editResult('ok', { type: 'todo', dueDate: '', dueTime: '' })] })
        assert.deepStrictEqual(toTodo.state.dataPuts.map(put => put.body), [{ is_todo: 1, todo_due: 0, todo_completed: 0 }])
        assert.deepStrictEqual(toTodo.outcome, { id: 'nEdit', changed: ['is_todo', 'todo_due'] })
        const withDue = await editWith({ ...asNote, dialogResults: [editResult('ok', { type: 'todo', title: 'Now a task', dueDate: '2026-11-02', dueTime: '' })] })
        assert.deepStrictEqual(withDue.state.dataPuts.map(put => put.body), [{ title: 'Now a task', is_todo: 1, todo_due: new Date(2026, 10, 2, 9, 0).getTime(), todo_completed: 0 }],
            'the Due applied on top (a date alone at the day start time)')
        assert.deepStrictEqual(withDue.outcome.changed, ['title', 'is_todo', 'todo_due'])
        for (const run of [toNote, toTodo, withDue]) assert.deepStrictEqual(run.state.timeline, ['PUT notes/nEdit'])
    })

    await check('edit mode: the tag diff attaches an existing tag by its tagKey, creates and attaches a missing one, and detaches a removed one (DELETE tags/:id/notes/:noteId); tags alone make no PUT', async () => {
        const { state, outcome } = await editWith({ dialogResults: [editResult('ok', { tags: 'work, Idea, brand new' })] })
        assert.deepStrictEqual(state.timeline, ['POST tags/tIdea/notes', 'POST tags', 'POST tags/tag0001/notes', 'DELETE tags/tUrgent/notes/nEdit'])
        assert.deepStrictEqual(state.dataPosts, [
            { path: ['tags', 'tIdea', 'notes'], query: null, body: { id: 'nEdit' } },
            { path: ['tags'], query: null, body: { title: 'brand new' } },
            { path: ['tags', 'tag0001', 'notes'], query: null, body: { id: 'nEdit' } },
        ])
        assert.deepStrictEqual(state.dataDeletes, [{ path: ['tags', 'tUrgent', 'notes', 'nEdit'], query: undefined }])
        assert.deepStrictEqual(state.dataPuts, [])
        assert.deepStrictEqual(outcome, { id: 'nEdit', changed: ['tags'] })
        // Removals only: the tag list is not read again. A field and the tags: the PUT first, then the tags.
        const cleared = await editWith({ dialogResults: [editResult('ok', { title: 'Paid', tags: '' })] })
        assert.deepStrictEqual(cleared.state.timeline, ['PUT notes/nEdit', 'DELETE tags/tUrgent/notes/nEdit', 'DELETE tags/tWork/notes/nEdit'])
        assert.strictEqual(cleared.state.dataGets.filter(get => get.path.length === 1 && get.path[0] === 'tags').length, 2, 'only the form\'s two pages')
        assert.deepStrictEqual(cleared.outcome, { id: 'nEdit', changed: ['title', 'tags'] })
    })

    await check('edit mode: a tag call that fails is a console warning and the next is tried - once the PUT is done nothing throws - and tags is reported only when a tag call went through; a refused PUT rejects before any tag call', async () => {
        const failed = await editWith({
            deleteThrows: (pathParts) => pathParts[1] === 'tUrgent',
            dialogResults: [editResult('ok', { title: 'Renamed', tags: 'idea' })],
        })
        assert.deepStrictEqual(failed.state.timeline, ['PUT notes/nEdit', 'POST tags/tIdea/notes', 'DELETE tags/tUrgent/notes/nEdit', 'DELETE tags/tWork/notes/nEdit'])
        assert.deepStrictEqual(failed.outcome, { id: 'nEdit', changed: ['title', 'tags'] }, 'the command resolves, it does not throw')
        assert.deepStrictEqual(failed.state.warnings.filter(line => line.startsWith('Jot: could not remove the tag "urgent"; the note keeps it')).length, 1, failed.state.warnings.join(' | '))
        assert.deepStrictEqual(failed.state.messageBoxes, [])
        const noneDetached = await editWith({ deleteThrows: () => true, dialogResults: [editResult('ok', { title: 'Renamed again', tags: '' })] })
        assert.deepStrictEqual(noneDetached.outcome, { id: 'nEdit', changed: ['title'] }, 'no tag call went through: tags is not reported')
        assert.strictEqual(noneDetached.state.warnings.filter(line => line.startsWith('Jot: could not remove the tag')).length, 2)
        const noneAttached = await editWith({ postThrows: (pathParts) => pathParts[0] === 'tags', dialogResults: [editResult('ok', { tags: 'urgent, work, idea' })] })
        assert.deepStrictEqual(noneAttached.outcome, { id: 'nEdit', changed: [] })
        assert.ok(noneAttached.state.warnings.some(line => line.startsWith('Jot: could not add the tag "idea"')), noneAttached.state.warnings.join(' | '))
        const putRefused = await runBundle({ ...FORM_BASE, ...EDIT_BASE, putThrows: () => true, dialogResults: [editResult('ok', { title: 'x', tags: 'idea' })] })
        const open = putRefused.commands.find(item => item.name === 'jot.open')
        await withWarnings(putRefused, () => assert.rejects(() => open.execute(EDIT_ARGS), /refused: PUT notes\/nEdit/))
        assert.deepStrictEqual(putRefused.timeline, ['PUT notes/nEdit'])
    })

    await check('edit mode: a note that no longer exists - GET notes/:id rejects or answers nothing, or its tags cannot be read - says "Jot: this note no longer exists." and resolves null, with no dialog; no note id at all is a console warning and null', async () => {
        for (const options of [{ notes: {} }, { notes: { nEdit: null } }, { noteTagsGetThrows: true }]) {
            const { state, outcome } = await editWith(options)
            assert.strictEqual(outcome, null, JSON.stringify(options))
            assert.deepStrictEqual(state.messageBoxes, ['Jot: this note no longer exists.'], JSON.stringify(options))
            assert.deepStrictEqual([state.dialogCreates, state.dialogOpens, state.timeline], [['jot.form'], 0, []], JSON.stringify(options))
        }
        for (const args of [{ mode: 'edit' }, { mode: 'edit', noteId: '' }, { mode: 'edit', noteId: 42 }]) {
            const { state, outcome } = await editWith({}, args)
            assert.strictEqual(outcome, null, JSON.stringify(args))
            assert.deepStrictEqual([state.messageBoxes, noteReads(state), state.dialogOpens], [[], [], 0], JSON.stringify(args))
            assert.ok(state.warnings.some(line => line.startsWith('Jot: edit mode was asked for without a note id')), JSON.stringify(args))
        }
    })

    await check('edit mode: Cancel, Escape and any other answer (Create and open is not one of its buttons) resolve null and write nothing, whatever was changed', async () => {
        for (const id of ['cancel', 'close', 'openAfter', undefined]) {
            const { state, outcome } = await editWith({ dialogResults: [editResult(id, { type: 'note', title: 'Changed', notebookId: 'fHome', tags: 'idea', dueDate: '' })] })
            assert.strictEqual(outcome, null, `button ${id}`)
            assert.deepStrictEqual([state.timeline, state.messageBoxes], [[], []], `button ${id}`)
        }
    })

    await check('edit mode: an unreadable Due is refused with the brief\'s message; the form reopens in edit mode as typed with the picker unfolded, then saves only what changed', async () => {
        const { state, outcome } = await editWith({
            dialogResults: [editResult('ok', { title: 'Renamed', dueDate: '2026-02-31' }), editResult('ok', { title: 'Renamed', dueDate: '2026-02-28' })],
        })
        assert.deepStrictEqual(state.messageBoxes, ['Jot: the date must be YYYY-MM-DD and the time HH:MM (24-hour).'])
        assert.strictEqual(state.dialogOpens, 2)
        const again = state.dialogHtml[1]
        assert.ok(again.includes('>Edit to-do</strong>') && !again.includes('name="body"'), 'still edit mode')
        assert.ok(fieldValue(again, 'title') === 'Renamed' && /name="dueDate" id="jotDueDate" value="2026-02-31"/.test(again), 'as typed')
        assert.ok(/<div id="jotPicker" class="jot-picker">/.test(again) && islandOf(again).data.pickerOpen === true, 'the picker unfolded')
        assert.deepStrictEqual(state.dataPuts.map(put => put.body), [{ title: 'Renamed', todo_due: new Date(2026, 1, 28, 10, 30).getTime() }])
        assert.deepStrictEqual(outcome, { id: 'nEdit', changed: ['title', 'todo_due'] })
    })

    await check('jot.open { mode: \'new\' } honours each preset - type, title, body, notebookId - on the caller\'s route: no selection read, no In this note row; resolves { id, opened }; presets of the wrong shape are passed over', async () => {
        const state = await runBundle({ ...FORM_BASE, executeResults: { selectedText: 'highlighted' },
            dialogResults: [formResult('ok', { type: 'note', title: 'From Cockpit', body: 'line one\nline two', notebookId: 'fHome' })] })
        const open = state.commands.find(item => item.name === 'jot.open')
        const outcome = await withWarnings(state, () => open.execute({ mode: 'new', type: 'note', title: 'From Cockpit', body: 'line one\nline two', notebookId: 'fHome' }))
        const html = state.dialogHtml[0]
        assert.ok(html.includes('>New note</strong>') && /data-value="note" role="radio" aria-checked="true"/.test(html), 'type: the caller\'s note over the setting\'s to-do')
        assert.strictEqual(fieldValue(html, 'title'), 'From Cockpit', 'title')
        assert.ok(html.includes('>\nline one\nline two</textarea>'), 'body, in the Text')
        assert.ok(/<input type="text" id="jotNotebook"[^>]*value="home"/.test(html) && islandOf(html).data.defaults.notebookId === 'fHome', 'notebookId, over the editor note\'s Work')
        assert.ok(!html.includes('jotInThisNoteRow'), 'no In this note row, though text is highlighted')
        assert.deepStrictEqual([state.executes, state.workspaceCalls, state.dialogCreates], [[], [], ['jot.form']], 'no selection read, no workspace read: the caller\'s notebook is known')
        assert.deepStrictEqual(outcome, { id: outcome.id, opened: false })
        assert.deepStrictEqual(notePosts(state).map(post => post.body), [{ parent_id: 'fHome', is_todo: 0, title: 'From Cockpit', body: 'line one\nline two', todo_due: 0 }])
        // A to-do over a note setting; Create and open opens.
        const todo = await runBundle({ ...FORM_BASE, settings: { defaultType: 'note' }, dialogResults: [formResult('ok', { open: 'editor',  title: 'Task' })] })
        const opened = await withWarnings(todo, () => todo.commands.find(item => item.name === 'jot.open').execute({ mode: 'new', type: 'todo' }))
        assert.ok(todo.dialogHtml[0].includes('>New to-do</strong>'))
        assert.deepStrictEqual(opened, { id: opened.id, opened: true })
        assert.deepStrictEqual(todo.executes, [{ name: 'openNote', args: [opened.id] }])
        // Wrong shapes: the setting's type, empty fields, the current notebook.
        const odd = await runBundle({ ...FORM_BASE })
        await withWarnings(odd, () => odd.commands.find(item => item.name === 'jot.open').execute({ mode: 'new', type: 'Note', title: 42, body: { text: 'x' }, notebookId: 'gone' }))
        const oddHtml = odd.dialogHtml[0]
        assert.ok(oddHtml.includes('>New to-do</strong>'))
        assert.ok(fieldValue(oddHtml, 'title') === '' && fieldValue(oddHtml, 'body') === '')
        assert.strictEqual(islandOf(oddHtml).data.defaults.notebookId, 'fWork', 'an unknown notebook falls back to the editor note\'s')
        assert.deepStrictEqual(odd.executes, [])
    })

    await check('jot.open with no argument, or one the contract does not know, is the shortcut\'s behaviour: the selection read first, then the plain form, or the selection route when text is highlighted', async () => {
        for (const args of [undefined, null, {}, { mode: 'open' }, { mode: 'EDIT', noteId: 'nEdit' }, 'edit', ['nEdit'], 7]) {
            const state = await runBundle({ ...FORM_BASE, ...EDIT_BASE })
            const outcome = await withWarnings(state, () => state.commands.find(item => item.name === 'jot.open').execute(args))
            assert.strictEqual(outcome, null, String(JSON.stringify(args)))
            assert.deepStrictEqual([state.executes, state.dialogCreates, noteReads(state)], [[READ_SELECTION], ['jot.form'], []], String(JSON.stringify(args)))
            assert.ok(state.dialogHtml[0].includes('>New to-do</strong>') && !state.dialogHtml[0].includes('jotInThisNoteRow'), JSON.stringify(args))
        }
        const selected = await runBundle({ ...FORM_BASE, executeResults: { selectedText: 'Buy milk\nsemi-skimmed' } })
        await withWarnings(selected, () => selected.commands.find(item => item.name === 'jot.open').execute({ mode: 'unknown' }))
        assert.ok(selected.dialogHtml[0].includes('jotInThisNoteRow') && fieldValue(selected.dialogHtml[0], 'title') === 'Buy milk', 'the selection route')
    })

    await check('jot.edit ("Edit with Jot…", in the note list\'s right-click menu on desktop) edits the first of the note ids it is given and ignores the rest; run with none (the palette), the editor\'s note; with no note, null', async () => {
        const notes = { nEdit: EDIT_NOTE, nOther: { ...EDIT_NOTE, id: 'nOther', title: 'Other' } }
        const { state, outcome } = await editWith({ notes, dialogResults: [editResult('ok', { title: 'Via the list' })] }, ['nEdit', 'nOther'], 'jot.edit')
        assert.deepStrictEqual(noteReads(state), ['notes/nEdit id,title,is_todo,parent_id,todo_due', 'notes/nEdit/tags id,title'])
        assert.ok(state.dialogHtml[0].includes('>Edit to-do</strong>') && fieldValue(state.dialogHtml[0], 'title') === 'Call the bank')
        assert.deepStrictEqual(state.dataPuts, [{ path: ['notes', 'nEdit'], query: null, body: { title: 'Via the list' } }])
        assert.deepStrictEqual(outcome, { id: 'nEdit', changed: ['title'] })
        assert.deepStrictEqual([state.dialogCreates, state.executes], [['jot.form', 'jot.edit'], []])
        const palette = await runBundle({ ...FORM_BASE, ...EDIT_BASE, selectedNote: { id: 'nEdit', parent_id: 'fWork' } })
        await withWarnings(palette, () => palette.commands.find(item => item.name === 'jot.edit').execute())
        assert.deepStrictEqual(noteReads(palette)[0], 'notes/nEdit id,title,is_todo,parent_id,todo_due')
        const none = await runBundle({ ...FORM_BASE, ...EDIT_BASE, selectedNote: null })
        assert.strictEqual(await withWarnings(none, () => none.commands.find(item => item.name === 'jot.edit').execute([])), null)
        assert.deepStrictEqual([noteReads(none), none.dialogOpens, none.messageBoxes], [[], 0, []])
    })

    await check('edit mode: one form at a time - while the edit form is up a create, another edit or jot.edit resolves null at once; while the create form is up an edit does', async () => {
        let release
        const held = new Promise(resolve => { release = resolve })
        const state = await runBundle({ ...FORM_BASE, ...EDIT_BASE, openDialog: () => held })
        const open = state.commands.find(item => item.name === 'jot.open')
        const edit = state.commands.find(item => item.name === 'jot.edit')
        const first = withWarnings(state, () => open.execute(EDIT_ARGS))
        await tick(10)
        assert.strictEqual(await open.execute(), null)
        assert.strictEqual(await open.execute(EDIT_ARGS), null)
        assert.strictEqual(await open.execute({ mode: 'new', title: 'x' }), null)
        assert.strictEqual(await edit.execute(['nEdit']), null)
        release(editResult('ok', { title: 'First' }))
        assert.deepStrictEqual(await first, { id: 'nEdit', changed: ['title'] })
        assert.strictEqual(state.dialogOpens, 1)
        assert.strictEqual(noteReads(state).length, 2, 'the refused edits read nothing')
        let releaseCreate
        const heldCreate = new Promise(resolve => { releaseCreate = resolve })
        const other = await runBundle({ ...FORM_BASE, ...EDIT_BASE, openDialog: () => heldCreate })
        const creating = withWarnings(other, () => other.commands.find(item => item.name === 'jot.open').execute())
        await tick(10)
        assert.strictEqual(await other.commands.find(item => item.name === 'jot.open').execute(EDIT_ARGS), null)
        releaseCreate({ id: 'cancel' })
        assert.strictEqual(await creating, null)
        assert.deepStrictEqual(noteReads(other), [], 'the refused edit read nothing (and a quick note reads no tags)')
    })

    // ---------------------------------------------------------------- the pure model
    const FormModel = require(path.join(ROOT, 'src', 'form', 'formModel.js'))
    const TriggerRule = require(path.join(ROOT, 'src', 'form', 'triggerRule.js'))
    const SearchTokens = require(path.join(ROOT, 'src', 'form', 'searchTokens.js'))
    const AlarmQuick = require(path.join(ROOT, 'src', 'form', 'alarmQuick.js'))

    await check('formModel.dialogAction: ok creates, anything else does nothing (the old openAfter button included: opening is the Open row\'s)', () => {
        assert.strictEqual(FormModel.dialogAction({ id: 'ok' }), 'create')
        for (const result of [{ id: 'openAfter' }, { id: 'cancel' }, { id: 'clear' }, {}, null, undefined]) assert.strictEqual(FormModel.dialogAction(result), 'none')
    })

    await check('formModel.applyEmptyTitleRule: a title keeps the body as typed; an empty title takes the first non-empty line; both empty is nothing', () => {
        assert.deepStrictEqual(FormModel.applyEmptyTitleRule(' Title ', 'Body\nmore'), { title: 'Title', body: 'Body\nmore', nothing: false })
        assert.deepStrictEqual(FormModel.applyEmptyTitleRule('', 'First\nsecond'), { title: 'First', body: 'second', nothing: false })
        assert.deepStrictEqual(FormModel.applyEmptyTitleRule(' \t', '\n\n  Only line  \n'), { title: 'Only line', body: '', nothing: false })
        assert.deepStrictEqual(FormModel.applyEmptyTitleRule('', 'Head\r\n\r\nBody'), { title: 'Head', body: 'Body', nothing: false })
        assert.deepStrictEqual(FormModel.applyEmptyTitleRule('', '  \n \n'), { title: '', body: '', nothing: true })
        assert.deepStrictEqual(FormModel.applyEmptyTitleRule(undefined, undefined), { title: '', body: '', nothing: true })
    })

    await check('formModel.parseTagCsv: trimmed, lower-cased, de-duplicated, blanks dropped, first order kept', () => {
        assert.deepStrictEqual(FormModel.parseTagCsv(' Work, new one,work, ,Idea,,IDEA '), ['work', 'new one', 'idea'])
        assert.deepStrictEqual(FormModel.parseTagCsv(''), [])
        assert.deepStrictEqual(FormModel.parseTagCsv(null), [])
    })

    await check('formModel.parseDateTime: Cockpit\'s parseAlarmFields (YYYY-MM-DD, HH:MM 24-hour, real dates only)', () => {
        assert.strictEqual(FormModel.parseDateTime('2026-10-14', '10:30').getTime(), new Date(2026, 9, 14, 10, 30).getTime())
        assert.strictEqual(FormModel.parseDateTime(' 2026-1-5 ', '7:05').getTime(), new Date(2026, 0, 5, 7, 5).getTime())
        for (const [date, time] of [['2026-02-31', '09:00'], ['2026-13-01', '09:00'], ['2026/10/14', '09:00'], ['14-10-2026', '09:00'],
            ['2026-10-14', '24:00'], ['2026-10-14', '12:60'], ['2026-10-14', '9am'], ['2026-10-14', '09:00:00'], ['', '09:00'], ['2026-10-14', '']]) {
            assert.strictEqual(FormModel.parseDateTime(date, time), null, `${date} ${time} is refused`)
        }
        assert.strictEqual(FormModel.DUE_MESSAGE, 'Jot: the date must be YYYY-MM-DD and the time HH:MM (24-hour).')
    })

    await check('formModel.dueTimestamp: none is 0, a date alone takes the day start, a time alone or a bad value is null', () => {
        assert.strictEqual(FormModel.dueTimestamp('', '', '09:00'), 0)
        assert.strictEqual(FormModel.dueTimestamp('  ', ' ', '09:00'), 0)
        assert.strictEqual(FormModel.dueTimestamp('2026-10-14', '', '08:15'), new Date(2026, 9, 14, 8, 15).getTime())
        assert.strictEqual(FormModel.dueTimestamp('2026-10-14', '', 'nonsense'), new Date(2026, 9, 14, 9, 0).getTime())
        assert.strictEqual(FormModel.dueTimestamp('2026-10-14', '23:59', '09:00'), new Date(2026, 9, 14, 23, 59).getTime())
        assert.strictEqual(FormModel.dueTimestamp('', '10:00', '09:00'), null)
        assert.strictEqual(FormModel.dueTimestamp('2026-02-30', '10:00', '09:00'), null)
        assert.deepStrictEqual(FormModel.parseDayStart('7:5'), { hours: 9, minutes: 0 })
        assert.deepStrictEqual(FormModel.parseDayStart('30:75'), { hours: 23, minutes: 59 })
        assert.strictEqual(FormModel.dayStartText(' 7:30 '), '07:30')
    })

    await check('formModel: the Due row text, and the picks (a date before any time takes the day start, a time before any date lands today)', () => {
        assert.strictEqual(FormModel.dueText('', ''), 'No date')
        assert.strictEqual(FormModel.dueText('2026-10-14', '09:00'), '2026-10-14 09:00')
        assert.deepStrictEqual(FormModel.dueAfterDatePick({ date: '', time: '' }, '2026-10-14', '08:00'), { date: '2026-10-14', time: '08:00' })
        assert.deepStrictEqual(FormModel.dueAfterDatePick({ date: '2026-10-01', time: '17:45' }, '2026-10-14', '08:00'), { date: '2026-10-14', time: '17:45' })
        const now = new Date(2026, 9, 11, 15, 20)
        assert.deepStrictEqual(FormModel.dueAfterTimePick({ date: '', time: '' }, '18:00', now), { date: '2026-10-11', time: '18:00' })
        assert.deepStrictEqual(FormModel.dueAfterTimePick({ date: '2026-12-24', time: '09:00' }, '18:00', now), { date: '2026-12-24', time: '18:00' })
    })

    await check('formModel.buildNotebookPaths: parent paths, sorted by path, trash left out, a looping parent chain stops', () => {
        assert.deepStrictEqual(FormModel.buildNotebookPaths(FOLDERS), SORTED_NOTEBOOKS)
        const trashed = FormModel.buildNotebookPaths([...FOLDERS, { id: 'fBin', title: 'Binned', parent_id: '', deleted_time: 1700000000000 }])
        assert.ok(!trashed.some(item => item.id === 'fBin'))
        const loop = FormModel.buildNotebookPaths([{ id: 'a', title: 'A', parent_id: 'b' }, { id: 'b', title: 'B', parent_id: 'a' }])
        assert.strictEqual(loop.length, 2)
        assert.ok(loop.every(item => item.path.split(' / ').length <= 33))
        assert.deepStrictEqual(FormModel.buildNotebookPaths([{ id: 'x', title: 'beta', parent_id: '' }, { id: 'y', title: 'Alpha', parent_id: '' }]).map(n => n.path), ['Alpha', 'beta'])
    })

    await check('formModel.defaultNotebookId: the caller\'s, else the editor note\'s, else the shown notebook, else the first; unknown ones passed over', () => {
        const list = SORTED_NOTEBOOKS
        assert.strictEqual(FormModel.defaultNotebookId(list, { callerNotebookId: 'fArch', editorNote: { parent_id: 'fHome' }, shownFolder: { id: 'fWork' } }), 'fArch')
        assert.strictEqual(FormModel.defaultNotebookId(list, { callerNotebookId: 'gone', editorNote: { parent_id: 'fHome' }, shownFolder: { id: 'fWork' } }), 'fHome')
        assert.strictEqual(FormModel.defaultNotebookId(list, { editorNote: null, shownFolder: { id: 'fWork' } }), 'fWork')
        assert.strictEqual(FormModel.defaultNotebookId(list, { editorNote: { parent_id: 'gone' }, shownFolder: null }), 'fOdd')
        assert.strictEqual(FormModel.defaultNotebookId(list, {}), 'fOdd')
        assert.strictEqual(FormModel.defaultNotebookId([], { callerNotebookId: 'fArch' }), null)
    })

    await check('formModel.planCreate: none, nothing, invalidDue and create, with the notebook falling back to the default', () => {
        const options = { defaultType: 'todo', dayStart: '09:00', notebookId: 'fWork' }
        assert.deepStrictEqual(FormModel.planCreate({ id: 'cancel' }, options), { kind: 'none' })
        assert.deepStrictEqual(FormModel.planCreate(null, options), { kind: 'none' })
        assert.strictEqual(FormModel.planCreate(formResult('ok', {}), options).kind, 'nothing')
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 'x', dueTime: '10:00' }), options).kind, 'invalidDue')
        const empty = FormModel.planCreate(formResult('ok', { open: 'editor',  notebookId: '' }), options)
        assert.deepStrictEqual([empty.kind, empty.open, empty.note], ['create', 'editor', { parent_id: 'fWork', is_todo: 1, title: '', body: '', todo_due: 0 }],
            'both empty with Open on: the empty note, opened')
        const note = FormModel.planCreate({ id: 'ok', formData: { jot: { title: 'n', dueDate: 'x' } } }, { ...options, defaultType: 'note' })
        assert.deepStrictEqual([note.kind, note.note.is_todo, note.note.todo_due, note.tags], ['create', 0, 0, []], 'a result without a type reads as the default type')
        const todo = FormModel.planCreate(formResult('ok', { title: 't', tags: 'A,b,a', dueDate: '2026-10-14', dueTime: '10:30' }), options)
        assert.deepStrictEqual([todo.open, todo.tags, todo.note.todo_due], ['', ['a', 'b'], new Date(2026, 9, 14, 10, 30).getTime()], 'Open off: open is ""')
    })

    await check('formModel.splitSelection: one line; several lines; blank lines first; whitespace-only and non-strings are empty', () => {
        assert.deepStrictEqual(FormModel.splitSelection('  Call the bank  '), { title: 'Call the bank', body: '', empty: false }, 'one line: the Title, no Text')
        assert.deepStrictEqual(FormModel.splitSelection('Call the bank\nabout the card\n  and the PIN'), { title: 'Call the bank', body: 'about the card\n  and the PIN', empty: false })
        assert.deepStrictEqual(FormModel.splitSelection('\n \n\tHead \n\n\nbody\n\nend\n'), { title: 'Head', body: 'body\n\nend\n', empty: false },
            'blank lines before the first line and before the Text are dropped; the rest is kept as is')
        assert.deepStrictEqual(FormModel.splitSelection('Head\r\n\r\nBody'), { title: 'Head', body: 'Body', empty: false })
        for (const blank of ['', '   ', ' \n\t\n ', null, undefined, 42, {}]) {
            assert.deepStrictEqual(FormModel.splitSelection(blank), { title: '', body: '', empty: true }, `${JSON.stringify(blank)} is no selection`)
        }
    })

    await check('formModel: the In this note choices and labels, the remembered default, the link as Joplin\'s markdownTag, the edit for each choice, and planCreate\'s inThisNote', () => {
        assert.deepStrictEqual(FormModel.SELECTION_LABELS, { keep: 'Keep the text', replace: 'Replace it with a link to the new note', after: 'Add a link after it' })
        assert.deepStrictEqual(FormModel.selectionChoices(true), ['replace', 'keep', 'after'], 'the default drawn first')
        assert.deepStrictEqual(FormModel.selectionChoices(false), ['replace', 'keep'])
        assert.strictEqual(FormModel.SELECTION_DEFAULT, 'replace', 'the selection route starts on Replace it with a link')
        assert.strictEqual(FormModel.selectionAction('after', ['keep', 'replace', 'after'], FormModel.SELECTION_DEFAULT), 'after')
        assert.strictEqual(FormModel.selectionAction('keep', ['keep', 'replace', 'after'], FormModel.SELECTION_DEFAULT), 'keep', 'a remembered keep holds')
        assert.strictEqual(FormModel.selectionAction('after', ['keep', 'replace'], FormModel.SELECTION_DEFAULT), 'replace')
        for (const value of ['', 'bogus', undefined, null]) assert.strictEqual(FormModel.selectionAction(value, ['keep', 'replace', 'after'], FormModel.SELECTION_DEFAULT), 'replace')
        assert.strictEqual(FormModel.selectionAction('bogus', ['keep', 'after'], FormModel.SELECTION_DEFAULT), 'keep', 'a default not offered: the first button drawn')
        const id = '0123456789abcdef0123456789abcdef'
        assert.strictEqual(FormModel.noteLink('Call the bank', id), `[Call the bank](:/${id})`)
        assert.strictEqual(FormModel.noteLink('a [b] c', id), `[a \\[b\\] c](:/${id})`)
        assert.strictEqual(FormModel.noteLink('', id), `[Untitled](:/${id})`)
        const link = '[T](:/x)'
        assert.strictEqual(FormModel.selectionEdit('keep', 'text', link), null)
        assert.deepStrictEqual(FormModel.selectionEdit('replace', 'one line', link), { command: 'insertText', text: link })
        assert.deepStrictEqual(FormModel.selectionEdit('replace', 'two\nlines', link), { command: 'insertText', text: link })
        assert.deepStrictEqual(FormModel.selectionEdit('replace', 'a whole line\n', link), { command: 'insertText', text: `${link}\n` }, 'a selected line break stays')
        assert.deepStrictEqual(FormModel.selectionEdit('after', 'one line', link), { command: 'replaceSelection', text: `one line ${link}` })
        assert.deepStrictEqual(FormModel.selectionEdit('after', 'two\nlines', link), { command: 'replaceSelection', text: `two\nlines\n${link}` })
        assert.deepStrictEqual(FormModel.selectionEdit('after', 'a whole line\n', link), { command: 'replaceSelection', text: `a whole line ${link}\n` })
        assert.deepStrictEqual(FormModel.selectionEdit('after', 'two\nlines\n', link), { command: 'replaceSelection', text: `two\nlines\n${link}\n` })
        const options = { defaultType: 'todo', dayStart: '09:00', notebookId: 'fWork' }
        assert.strictEqual(FormModel.readFormValues({ jot: { inThisNote: 'after' } }).inThisNote, 'after')
        assert.strictEqual(FormModel.readFormValues({}).inThisNote, '')
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't', inThisNote: 'after' }), options).inThisNote, null, 'no choices offered: nothing to apply')
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't', inThisNote: 'after' }), { ...options, inThisNoteChoices: ['keep', 'replace', 'after'] }).inThisNote, 'after')
        const selection = { ...options, inThisNoteDefault: FormModel.SELECTION_DEFAULT }
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't', inThisNote: 'after' }), { ...selection, inThisNoteChoices: ['keep', 'replace'] }).inThisNote, 'replace')
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't' }), { ...selection, inThisNoteChoices: ['keep', 'replace'] }).inThisNote, 'replace')
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't', inThisNote: 'keep' }), { ...selection, inThisNoteChoices: ['keep', 'replace'] }).inThisNote, 'keep')
        const refused = FormModel.planCreate(formResult('ok', { title: 't', dueTime: '10:00', inThisNote: 'replace' }), { ...options, inThisNoteChoices: ['keep', 'replace'] })
        assert.deepStrictEqual([refused.kind, refused.values.inThisNote], ['invalidDue', 'replace'], 'a refused Create keeps the choice')
    })

    await check('formModel: the trigger route\'s choices, labels with the trigger printed, the answer shapes, and inThisNoteAction falling back to the first offered', () => {
        assert.deepStrictEqual(FormModel.triggerChoices(), ['link', 'remove'], 'the default drawn first')
        assert.deepStrictEqual(FormModel.triggerLabels('++'), { remove: 'Remove ++', link: 'Replace ++ with a link to the new note' })
        assert.deepStrictEqual(FormModel.triggerLabels(';;jot'), { remove: 'Remove ;;jot', link: 'Replace ;;jot with a link to the new note' })
        assert.deepStrictEqual(FormModel.triggerAnswer('remove', '[T](:/x)'), { action: 'remove' })
        assert.deepStrictEqual(FormModel.triggerAnswer('link', '[T](:/x)'), { action: 'link', link: '[T](:/x)' })
        assert.deepStrictEqual(FormModel.triggerAnswer('link', ''), { action: 'cancel' }, 'a link with no text is no answer to apply')
        for (const choice of [null, undefined, 'keep', 'cancel']) assert.deepStrictEqual(FormModel.triggerAnswer(choice, '[T](:/x)'), { action: 'cancel' })
        assert.strictEqual(FormModel.inThisNoteAction('link', ['remove', 'link']), 'link')
        assert.strictEqual(FormModel.inThisNoteAction('remove', FormModel.triggerChoices(), FormModel.TRIGGER_DEFAULT), 'remove', 'a remembered remove holds')
        for (const value of ['', 'keep', 'bogus', undefined]) assert.strictEqual(FormModel.inThisNoteAction(value, FormModel.triggerChoices(), FormModel.TRIGGER_DEFAULT), 'link')
        for (const value of ['', 'keep', 'bogus', undefined]) assert.strictEqual(FormModel.inThisNoteAction(value, ['remove', 'link']), 'remove', 'with no default: the first offered')
        assert.strictEqual(FormModel.TRIGGER_DEFAULT, 'link')
        assert.strictEqual(FormModel.inThisNoteAction('bogus', FormModel.triggerChoices()), FormModel.TRIGGER_DEFAULT, 'the first drawn is the default: the two fallbacks coincide')
        assert.strictEqual(FormModel.inThisNoteAction('bogus', FormModel.selectionChoices(true)), FormModel.SELECTION_DEFAULT)
        assert.strictEqual(FormModel.inThisNoteAction('x', [], 'replace'), '', 'nothing offered: no choice')
        assert.strictEqual(FormModel.selectionAction, FormModel.inThisNoteAction, 'selectionAction is the same rule under its first name')
        const options = { defaultType: 'todo', dayStart: '09:00', notebookId: 'fWork', inThisNoteChoices: ['remove', 'link'] }
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't', inThisNote: 'link' }), options).inThisNote, 'link')
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't', inThisNote: 'after' }), options).inThisNote, 'remove')
    })

    await check('formModel: the headings of both modes, and dueFields as the inverse of dueTimestamp (local YYYY-MM-DD and HH:MM, seconds dropped; no due is empty)', () => {
        assert.deepStrictEqual(
            [FormModel.headingFor('todo'), FormModel.headingFor('note'), FormModel.headingFor('note', 'create'), FormModel.headingFor('todo', 'edit'), FormModel.headingFor('note', 'edit'), FormModel.headingFor('x', 'edit')],
            ['New to-do', 'New note', 'New note', 'Edit to-do', 'Edit note', 'Edit to-do'])
        assert.deepStrictEqual(FormModel.dueFields(new Date(2026, 9, 14, 7, 5, 42, 123).getTime()), { date: '2026-10-14', time: '07:05' })
        for (const at of [new Date(2026, 0, 1, 0, 0), new Date(2026, 11, 31, 23, 59), new Date(2028, 1, 29, 12, 30), new Date(2026, 2, 29, 2, 30)]) {
            const fields = FormModel.dueFields(at.getTime())
            assert.strictEqual(FormModel.dueTimestamp(fields.date, fields.time, '09:00'), at.getTime(), `the round trip of ${at.toString()}`)
        }
        for (const none of [0, null, undefined, '', -5, NaN, 'soon', Infinity]) assert.deepStrictEqual(FormModel.dueFields(none), { date: '', time: '' }, String(none))
        assert.strictEqual(FormModel.NO_NOTE_MESSAGE, 'Jot: this note no longer exists.')
    })

    await check('formModel.openRequest and noteIdFrom: edit with its note id, new with only the presets of the right shape, anything else the default; a note list\'s ids give the first', () => {
        assert.deepStrictEqual(FormModel.openRequest({ mode: 'edit', noteId: 'n1' }), { mode: 'edit', noteId: 'n1' })
        assert.deepStrictEqual(FormModel.openRequest({ mode: 'edit' }), { mode: 'edit', noteId: '' })
        assert.deepStrictEqual(FormModel.openRequest({ mode: 'new', type: 'note', title: 'T', body: 'B', notebookId: 'f1', extra: 1 }),
            { mode: 'new', presets: { type: 'note', title: 'T', body: 'B', notebookId: 'f1' } })
        assert.deepStrictEqual(FormModel.openRequest({ mode: 'new', type: 'todo', title: '', body: '' }), { mode: 'new', presets: { type: 'todo', title: '', body: '' } })
        assert.deepStrictEqual(FormModel.openRequest({ mode: 'new' }), { mode: 'new', presets: {} })
        assert.deepStrictEqual(FormModel.openRequest({ mode: 'new', type: 'task', title: 1, body: null, notebookId: '' }), { mode: 'new', presets: {} })
        for (const args of [undefined, null, {}, [], 'edit', 3, { mode: 'Edit' }, { mode: 'open' }, [{ mode: 'edit', noteId: 'n1' }]]) {
            assert.deepStrictEqual(FormModel.openRequest(args), { mode: 'default' }, JSON.stringify(args))
        }
        assert.deepStrictEqual([FormModel.noteIdFrom(['a', 'b']), FormModel.noteIdFrom('a'), FormModel.noteIdFrom([]), FormModel.noteIdFrom([3]), FormModel.noteIdFrom(null), FormModel.noteIdFrom({ id: 'a' })],
            ['a', 'a', '', '', '', ''])
    })

    await check('formModel.editStart: the prefill from the note and its tags - type, title, notebook, the tags as a sorted csv, the Due fields of a to-do only, and each tag\'s id by its tagKey', () => {
        const start = FormModel.editStart(EDIT_NOTE, [{ id: 'tU', title: 'urgent' }, { id: 'tW', title: 'Work' }, { id: 'tDup', title: 'WORK' }, { title: 'no id' }, null])
        assert.deepStrictEqual(JSON.parse(JSON.stringify(start)),
            { type: 'todo', title: 'Call the bank', notebookId: 'fWork', tags: 'Work, urgent', dueDate: '2026-10-14', dueTime: '10:30', tagIds: { urgent: 'tU', work: 'tW' } })
        assert.deepStrictEqual(FormModel.editStart({ ...EDIT_NOTE, is_todo: 0 }, []),
            { type: 'note', title: 'Call the bank', notebookId: 'fWork', tags: '', dueDate: '', dueTime: '', tagIds: {} }, 'a note has no Due')
        assert.deepStrictEqual(FormModel.editStart({ is_todo: 1, todo_due: 0 }, undefined), { type: 'todo', title: '', notebookId: '', tags: '', dueDate: '', dueTime: '', tagIds: {} })
    })

    await check('formModel.planEdit: none, invalidDue and save; the PUT holds only what changed (title trimmed, the Due at the minute), a type switch clears both fields, the tags are a diff of the two csvs', () => {
        const start = FormModel.editStart(EDIT_NOTE, EDIT_NOTE_TAGS)
        const options = { dayStart: '09:00' }
        for (const result of [{ id: 'cancel' }, null, editResult('openAfter', { title: 'x' }), editResult(undefined, { title: 'x' })]) {
            assert.deepStrictEqual(FormModel.planEdit(result, start, options), { kind: 'none' }, JSON.stringify(result))
        }
        assert.strictEqual(FormModel.planEdit(editResult('ok', { dueTime: '25:00' }), start, options).kind, 'invalidDue')
        assert.strictEqual(FormModel.planEdit(editResult('ok', { dueDate: '', dueTime: '10:00' }), start, options).kind, 'invalidDue')
        const same = FormModel.planEdit(editResult('ok', {}), start, options)
        assert.deepStrictEqual([same.kind, same.put, same.changed, same.attach, same.detach], ['save', null, [], [], []])
        const typeless = FormModel.planEdit({ id: 'ok', formData: { jot: { title: 'Call the bank', notebookId: 'fWork', tags: 'work,urgent', dueDate: '2026-10-14', dueTime: '10:30' } } }, start, options)
        assert.deepStrictEqual(typeless.changed, [], 'a result without a type reads as the note\'s own')
        const all = FormModel.planEdit(editResult('ok', { type: 'note', title: ' T ', notebookId: 'fHome', tags: 'work, new' }), start, options)
        assert.deepStrictEqual(all.put, { title: 'T', parent_id: 'fHome', is_todo: 0, todo_due: 0, todo_completed: 0 })
        assert.deepStrictEqual(all.changed, ['title', 'parent_id', 'is_todo', 'todo_due', 'tags'])
        assert.deepStrictEqual([all.attach, all.detach], [['new'], [{ id: 'tUrgent', title: 'urgent' }]])
        const minute = FormModel.planEdit(editResult('ok', { dueTime: '10:31' }), start, options)
        assert.deepStrictEqual(minute.put, { todo_due: new Date(2026, 9, 14, 10, 31).getTime() }, 'a minute is a change; the seconds the note had are not')
        // A tag whose title holds a comma: an untouched field is no change, and removing another tag removes that one only.
        const comma = FormModel.editStart(EDIT_NOTE, [{ id: 'tAB', title: 'a, b' }, { id: 'tC', title: 'c' }])
        assert.strictEqual(comma.tags, 'a, b, c')
        assert.deepStrictEqual(FormModel.planEdit(editResult('ok', { tags: comma.tags }), comma, options).changed, [])
        const dropC = FormModel.planEdit(editResult('ok', { tags: 'a, b' }), comma, options)
        assert.deepStrictEqual([dropC.attach, dropC.detach, dropC.changed], [[], [{ id: 'tC', title: 'c' }], ['tags']])
    })

    await check('triggerRule: the trigger fires at a line start (the document\'s, or after a newline), after a space and after a tab - and never inside a word (C++, i++, a+++)', () => {
        const fire = (doc, trigger = '++') => {
            const end = doc.length
            const around = TriggerRule.contextRange(end, trigger.length)
            return TriggerRule.triggerAt(doc.slice(around.from, around.to), around.from, trigger, { from: end - 1, to: end }, [])
        }
        assert.deepStrictEqual(fire('++'), { fires: true, from: 0, to: 2, cancelled: false }, 'the document\'s start')
        assert.deepStrictEqual(fire('first line\n++'), { fires: true, from: 11, to: 13, cancelled: false }, 'a line start')
        assert.deepStrictEqual(fire('hello ++'), { fires: true, from: 6, to: 8, cancelled: false }, 'after a space')
        assert.deepStrictEqual(fire('hello\t++'), { fires: true, from: 6, to: 8, cancelled: false }, 'after a tab')
        assert.strictEqual(fire('hello\u00a0++').fires, true, 'after a no-break space')
        for (const doc of ['C++', 'i++', 'hello C++', 'a+++', '+++', 'hello +++', 'x++', '(++']) {
            assert.deepStrictEqual(fire(doc), { fires: false, from: null, to: null, cancelled: false }, `${JSON.stringify(doc)} does not fire`)
        }
        assert.strictEqual(fire('hello +').fires, false)
        assert.strictEqual(fire('').fires, false)
    })

    await check('triggerRule: typed one character at a time, the trigger fires exactly on its last; a longer trigger likewise; an empty trigger never fires', () => {
        const typeAll = (text, trigger) => {
            const fired = []
            for (let end = 1; end <= text.length; end++) {
                const around = TriggerRule.contextRange(end, trigger.length)
                const verdict = TriggerRule.triggerAt(text.slice(around.from, around.to), around.from, trigger, { from: end - 1, to: end }, [])
                if (verdict.fires) fired.push([end, verdict.from, verdict.to])
            }
            return fired
        }
        assert.deepStrictEqual(typeAll('hello ++', '++'), [[8, 6, 8]], 'only the second +')
        assert.deepStrictEqual(typeAll('hello +++ C++ i++ ++', '++'), [[8, 6, 8], [20, 18, 20]], 'the third + and the ++ inside words do not fire')
        assert.deepStrictEqual(typeAll('note ;;jot and ;;jo', ';;jot'), [[10, 5, 10]], 'a longer trigger fires on its last character only')
        assert.deepStrictEqual(typeAll(';;jot', ';;jot'), [[5, 0, 5]])
        assert.deepStrictEqual(typeAll('++ ++\n++', ''), [], 'an empty trigger never fires')
        // An insertion of several characters (an input method's commit) fires when it ends with the trigger.
        const commit = TriggerRule.triggerAt('a ++', 0, '++', { from: 0, to: 4 }, [])
        assert.deepStrictEqual(commit, { fires: true, from: 2, to: 4, cancelled: false })
        assert.strictEqual(TriggerRule.triggerAt('a ++ b', 0, '++', { from: 0, to: 6 }, []).fires, false, 'only at the insertion\'s end')
        assert.strictEqual(TriggerRule.triggerAt('a ++', 0, '++', { from: 4, to: 4 }, []).fires, false, 'an empty insertion (a deletion) never fires')
        assert.strictEqual(TriggerRule.triggerAt('++', 1, '++', { from: 2, to: 3 }, []).fires, false, 'a slice too short to decide does not fire')
    })

    await check('triggerRule: a cancelled occurrence does not fire again until the range changes; normalizeTrigger and contextRange', () => {
        const cancelled = [{ from: 6, to: 8, text: '++' }]
        // The same ++ rewritten with the same text (an input method re-committing it) is the cancelled occurrence: no fire.
        assert.deepStrictEqual(TriggerRule.triggerAt(' ++', 5, '++', { from: 6, to: 8 }, cancelled), { fires: false, from: 6, to: 8, cancelled: true })
        assert.deepStrictEqual(TriggerRule.triggerAt(' ++', 5, '++', { from: 7, to: 8 }, cancelled), { fires: false, from: 6, to: 8, cancelled: true })
        assert.strictEqual(TriggerRule.triggerAt(' ++', 5, '++', { from: 7, to: 8 }, [{ from: 6, to: 8, text: ';;' }]).fires, true, 'another trigger\'s memory')
        assert.strictEqual(TriggerRule.triggerAt(' ++', 7, '++', { from: 9, to: 10 }, cancelled).fires, true, 'another occurrence fires')
        // Whether a remembered occurrence still holds after a change: the same text, after a line start or whitespace.
        assert.strictEqual(TriggerRule.occurrenceHolds(' ++', 5, cancelled[0]), true, 'unchanged, or rewritten with the same text')
        assert.strictEqual(TriggerRule.occurrenceHolds('x++', 5, cancelled[0]), false, 'a character typed right before it')
        assert.strictEqual(TriggerRule.occurrenceHolds(' +x', 5, cancelled[0]), false, 'a character of it changed')
        assert.strictEqual(TriggerRule.occurrenceHolds(' +', 5, cancelled[0]), false, 'a character of it deleted')
        assert.strictEqual(TriggerRule.occurrenceHolds('++', 0, { from: 0, to: 2, text: '++' }), true, 'at the document\'s start')
        assert.strictEqual(TriggerRule.occurrenceHolds('++', 0, { from: -1, to: 1, text: '++' }), false, 'mapped off the start')
        assert.strictEqual(TriggerRule.occurrenceHolds('+++', 0, { from: 0, to: 3, text: '++' }), false, 'a length that is not the text\'s')
        // Once the memory is dropped, the occurrence typed again fires.
        assert.strictEqual(TriggerRule.triggerAt(' ++', 5, '++', { from: 7, to: 8 }, []).fires, true)
        assert.strictEqual(TriggerRule.normalizeTrigger(' ++ '), '++')
        for (const value of ['', '   ', null, undefined, 42, {}]) assert.strictEqual(TriggerRule.normalizeTrigger(value), '', JSON.stringify(value))
        assert.strictEqual(TriggerRule.DEFAULT_TRIGGER, '++')
        assert.deepStrictEqual(TriggerRule.contextRange(8, 2), { from: 5, to: 8 })
        assert.deepStrictEqual(TriggerRule.contextRange(2, 2), { from: 0, to: 2 })
        assert.deepStrictEqual(TriggerRule.contextRange(1, 2), { from: 0, to: 1 })
    })

    await check('formModel suggestions: notebooks filtered by matchesFilter, the tag token around the caret, tags minus those present, the pick', () => {
        assert.deepStrictEqual(FormModel.notebookSuggestions(SORTED_NOTEBOOKS, 'WORK').map(n => n.id), ['fWork', 'fProj'])
        assert.deepStrictEqual(FormModel.notebookSuggestions(SORTED_NOTEBOOKS, ' ').length, 5, 'a blank filter keeps every notebook')
        assert.deepStrictEqual(FormModel.notebookSuggestions(SORTED_NOTEBOOKS, 'zzz'), [])
        assert.deepStrictEqual(FormModel.tagTokenAt('work, pro', 9), { start: 6, end: 9, value: 'pro' })
        assert.deepStrictEqual(FormModel.tagTokenAt('pro , work', 2), { start: 0, end: 3, value: 'pro' })
        assert.deepStrictEqual(FormModel.tagTokenAt('work, ', 6), { start: 6, end: 6, value: '' })
        assert.deepStrictEqual(FormModel.tagTokenAt(',x', 0), { start: 0, end: 0, value: '' })
        const all = ['idea', 'project', 'urgent', 'work', 'workshop']
        assert.deepStrictEqual(FormModel.tagSuggestions(all, 'work, WOR', FormModel.tagTokenAt('work, WOR', 9)), ['workshop'], 'work is already in the field')
        assert.deepStrictEqual(FormModel.tagSuggestions(all, 'work, ', FormModel.tagTokenAt('work, ', 6)), [], 'an empty token offers nothing')
        assert.deepStrictEqual(FormModel.applyTagPick('work, pro', { start: 6, end: 9 }, 'project'), { value: 'work, project, ', caret: 15 })
        assert.deepStrictEqual(FormModel.applyTagPick('pro, work', { start: 0, end: 3 }, 'project'), { value: 'project, work', caret: 7 })
        assert.deepStrictEqual([FormModel.moveHighlight(3, 2, 1), FormModel.moveHighlight(3, 0, -1), FormModel.moveHighlight(3, -1, 1), FormModel.moveHighlight(3, -1, -1), FormModel.moveHighlight(0, 0, 1)], [0, 2, 0, 2, -1])
        assert.strictEqual(FormModel.headingFor('todo'), 'New to-do')
        assert.strictEqual(FormModel.headingFor('note'), 'New note')
    })

    await check('suggestion highlight: the tag or notebook typed in full is the row Enter picks, not a longer one sorted above it; else the first row', () => {
        // Tags: the rows match by substring in alphabetical order, so "work" lists "homework" first.
        const tags = ['homework', 'work', 'workshop']
        const rows = FormModel.tagSuggestions(tags, 'work', FormModel.tagTokenAt('work', 4))
        assert.deepStrictEqual(rows, ['homework', 'work', 'workshop'])
        assert.strictEqual(FormModel.suggestionHighlight(rows, 'work'), 1, '"work" typed in full highlights work, not homework')
        assert.strictEqual(FormModel.suggestionHighlight(rows, ' WORK '), 1, 'case and the spaces around it aside')
        assert.strictEqual(FormModel.suggestionHighlight(rows, 'wor'), 0, 'a partial token highlights the first row, as before')
        assert.strictEqual(FormModel.suggestionHighlight([], 'work'), -1, 'no rows, no highlight')
        // Notebooks: a full path first, then a notebook's own name, then the first row.
        const books = [{ id: 'old', path: 'Old Projects' }, { id: 'top', path: 'Projects' }, { id: 'sub', path: 'Work / Projects' }]
        assert.strictEqual(FormModel.notebookHighlight(books, 'projects'), 1, 'the path typed in full wins')
        assert.strictEqual(FormModel.notebookHighlight([books[0], books[2]], 'Projects'), 1, 'else the notebook whose own name was typed in full')
        assert.strictEqual(FormModel.notebookHighlight(books, 'work / projects'), 2)
        assert.strictEqual(FormModel.notebookHighlight(books, 'proj'), 0, 'a partial filter highlights the first row, as before')
        assert.strictEqual(FormModel.notebookHighlight([], 'x'), -1)
        // The glue opens each list on that highlight when it is typed into (the show-all of the arrow keys still starts on the picked notebook).
        const glue = read('src/form/formWebview.js')
        const tagGlue = glue.slice(glue.indexOf('function showTagSuggestions'), glue.indexOf('function notebookTextIsFilter'))
        assert.ok(tagGlue.includes('model().suggestionHighlight(rows, token.value)'), 'the Tags list opens on the tag typed in full')
        const bookGlue = glue.slice(glue.indexOf('function showNotebookSuggestions'), glue.indexOf('function showTagSuggestions'))
        assert.ok(bookGlue.includes('model().notebookHighlight(rows, input.value)'), 'the Notebook list opens on the notebook typed in full')
        assert.ok(bookGlue.includes("model().notebookListAll(jotData.notebooks, jotById('jotNotebookId').value)"), 'the full list still starts on the picked notebook')
    })

    await check('leaving a field with its list open: Notebook takes the highlighted row when a filter is typed or the user arrowed to it; Tags only when the user arrowed to it', () => {
        // Notebook: a click on Create after typing "oth" lands the note in the notebook the list showed.
        assert.strictEqual(FormModel.pickOnLeave('notebook', { highlight: 0, count: 1, typed: 'oth', moved: false }), true, 'a filter typed: its highlighted row is taken')
        assert.strictEqual(FormModel.pickOnLeave('notebook', { highlight: 2, count: 3, typed: '', moved: true }), true, 'a row arrowed to is taken')
        assert.strictEqual(FormModel.pickOnLeave('notebook', { highlight: 0, count: 3, typed: '  ', moved: false }), false, 'no filter and no move: the field goes back to the notebook picked')
        // Tags: the token typed is itself a tag, so only a row the user chose replaces it ("art" typed must not become "party").
        assert.strictEqual(FormModel.pickOnLeave('tag', { highlight: 0, count: 1, typed: 'art', moved: false }), false, 'the row the list opened on does not replace the token')
        assert.strictEqual(FormModel.pickOnLeave('tag', { highlight: 1, count: 2, typed: 'wo', moved: true }), true, 'a row arrowed to is taken')
        for (const highlight of [-1, 3]) assert.strictEqual(FormModel.pickOnLeave('notebook', { highlight, count: 3, typed: 'x', moved: true }), false, 'no row highlighted: nothing taken')
        assert.strictEqual(FormModel.pickOnLeave('other', { highlight: 0, count: 1, typed: 'x', moved: true }), false)
        // The glue: both fields leave through leaveJotSuggest on blur and on Tab; the arrow keys mark the move; a pick on leaving touches no selection.
        const glue = read('src/form/formWebview.js')
        const leave = glue.slice(glue.indexOf('function leaveJotSuggest'), glue.indexOf('function showNotebookSuggestions'))
        assert.ok(leave.includes('model().pickOnLeave(jotSuggest.kind, spec)') && leave.includes('pickJotSuggest(jotSuggest.highlight, true)'), 'leaving asks the model, then picks quietly')
        assert.ok(leave.includes("notebookTextIsFilter() ? input.value : ''"), 'a notebook path left as it was is not a filter')
        for (const name of ['function onJotNotebookBlur', 'function onJotTagsBlur']) {
            const body = glue.slice(glue.indexOf(name), glue.indexOf('\n}\n', glue.indexOf(name)))
            assert.ok(body.includes('leaveJotSuggest(event.currentTarget)'), `${name} leaves through the rule`)
        }
        const keys = glue.slice(glue.indexOf('function onJotSuggestKeyDown'), glue.indexOf('function onJotNotebookInput'))
        assert.ok(keys.slice(keys.indexOf("event.key === 'Tab'")).includes('leaveJotSuggest(input)'), 'Tab leaves through the same rule')
        assert.ok(keys.includes('jotSuggest.moved = true'), 'the arrow keys mark the row as chosen')
        assert.ok(glue.includes('token: token || null, moved: false }'), 'a list opened by typing starts unmoved')
        const pick = glue.slice(glue.indexOf('function pickJotSuggest'), glue.indexOf('function leaveJotSuggest'))
        assert.ok(pick.includes('if (!leaving) current.input.select()') && pick.includes('if (!leaving) current.input.setSelectionRange'), 'a pick on leaving moves no selection')
    })

    await check('the Notebook combobox: focus, a click or the chevron opens the whole list on the picked notebook; the empty Tags field opens every tag, none highlighted', () => {
        const all = FormModel.notebookListAll(SORTED_NOTEBOOKS, 'fHome')
        assert.deepStrictEqual(all.rows.map(n => n.id), SORTED_NOTEBOOKS.map(n => n.id), 'every notebook, in path order')
        assert.strictEqual(all.highlight, 2, 'the picked notebook is highlighted')
        assert.strictEqual(FormModel.notebookListAll(SORTED_NOTEBOOKS, 'gone').highlight, 0, 'an unknown pick highlights the first')
        assert.deepStrictEqual(FormModel.notebookListAll([], 'fHome'), { rows: [], highlight: -1 })
        assert.deepStrictEqual(FormModel.tagListOnFocus(['idea', '', 'work'], ''), { rows: ['idea', 'work'], highlight: -1 }, 'the empty field: every tag, none highlighted (Enter still creates)')
        assert.deepStrictEqual(FormModel.tagListOnFocus(['idea', 'work'], '  '), { rows: ['idea', 'work'], highlight: -1 }, 'spaces only count as empty')
        assert.deepStrictEqual(FormModel.tagListOnFocus(['idea', 'work'], 'idea'), { rows: [], highlight: -1 }, 'a tag typed: the list opens as one types')
        // The glue: the field's focus and a click open the full list (the field showing the picked path); the chevron's press keeps the focus in the
        // field and opens it; the Tags focus asks the model; and the list a pick or Escape closed opens again on a click.
        const glue = read('src/form/formWebview.js')
        const body = (name) => glue.slice(glue.indexOf(`function ${name}`), glue.indexOf('\n}\n', glue.indexOf(`function ${name}`)))
        assert.ok(body('onJotNotebookFocus').includes('showNotebookSuggestions(!notebookTextIsFilter())'), 'focus opens the whole list')
        assert.ok(body('onJotNotebookClick').includes('if (jotSuggest && jotSuggest.input === event.currentTarget) return')
            && body('onJotNotebookClick').includes('showNotebookSuggestions(!notebookTextIsFilter())'), 'a click opens it when it is closed')
        const chevron = body('onJotNotebookOpenMouseDown')
        assert.ok(chevron.indexOf('event.preventDefault()') >= 0 && chevron.indexOf('event.preventDefault()') < chevron.indexOf('input.focus()'), 'the chevron never takes the focus itself')
        assert.ok(chevron.includes('showNotebookSuggestions(!notebookTextIsFilter())'), 'the chevron opens the list when the field already had the focus')
        assert.ok(body('onJotTagsFocus').includes('model().tagListOnFocus(jotData.tags, input.value)'), 'the Tags focus asks the model')
        for (const wiring of ["notebook.addEventListener('focus', onJotNotebookFocus)", "notebook.addEventListener('click', onJotNotebookClick)",
            "jotById('jotNotebookOpen').addEventListener('mousedown', onJotNotebookOpenMouseDown)", "tags.addEventListener('focus', onJotTagsFocus)"]) {
            assert.ok(glue.includes(wiring), wiring)
        }
        // The chevron's look: inside the field's right edge, the field keeping room for it, coloured by the theme.
        const css = read('src/form/form.css').replace(/\/\*[\s\S]*?\*\//g, '')
        assert.ok(/\.jot-combo\s*\{[^}]*position:\s*relative;/.test(css) && /\.jot-combo-open\s*\{[^}]*position:\s*absolute;[^}]*right:\s*2px;/.test(css), 'the chevron sits inside the field')
        assert.ok(/\.jot-combo \.jot-input\s*\{[^}]*padding-right:\s*28px;/.test(css), 'the text never runs under it')
        assert.ok(/\.jot-combo-open\s*\{[^}]*color:\s*var\(--joplin-color/.test(css), 'its colour is the theme\'s')
    })

    await check('formModel resolves window.SearchTokens at call time: before the script has run every row matches, after it the filter applies', () => {
        const vm = require('vm')
        const sandbox = { window: {} }
        vm.createContext(sandbox)
        vm.runInContext(read('src/form/formModel.js'), sandbox)
        const model = sandbox.window.FormModel
        assert.ok(model, 'the model publishes window.FormModel in a webview')
        const rows = [{ id: 'a', path: 'Alpha' }, { id: 'b', path: 'Beta' }]
        // The model's arrays belong to the vm's realm, so they are compared as plain JSON.
        const ids = (filter) => JSON.parse(JSON.stringify(model.notebookSuggestions(rows, filter).map(n => n.id)))
        assert.deepStrictEqual(ids('bet'), ['a', 'b'], 'no matcher yet, no require to fall back to')
        vm.runInContext(read('src/form/searchTokens.js'), sandbox)
        assert.ok(sandbox.window.SearchTokens, 'searchTokens.js publishes window.SearchTokens')
        assert.deepStrictEqual(ids('bet'), ['b'])
    })

    await check('the copies from Cockpit: matchesFilter\'s rule, and alarmQuick.js unchanged under its one added line', () => {
        assert.strictEqual(SearchTokens.matchesFilter('Family / Payments', 'fam'), true)
        assert.strictEqual(SearchTokens.matchesFilter('Family / Payments', ' PAY '), true)
        assert.strictEqual(SearchTokens.matchesFilter('Family', ''), true)
        assert.strictEqual(SearchTokens.matchesFilter('Family', null), true)
        assert.strictEqual(SearchTokens.matchesFilter(null, 'x'), false)
        assert.strictEqual(SearchTokens.matchesFilter('Work', 'home'), false)
        const lines = read('src/form/alarmQuick.js').split('\n')
        assert.ok(/^\/\/ Copied unchanged from Cockpit/.test(lines[0]), 'line 1 says where it is copied from')
        assert.ok(lines[1].startsWith('/** README'), 'line 2 is Cockpit\'s own header')
        assert.ok(read('src/form/searchTokens.js').startsWith('// Copied from Cockpit'))
        // Behaviour, so a broken copy shows: Tomorrow keeps a preserved time, +week walks seven days, Today is ceilHour + 1.
        const now = new Date(2026, 9, 11, 14, 36)
        assert.deepStrictEqual(AlarmQuick.tomorrow(now, { hours: 8, minutes: 5 }), { date: '2026-10-12', time: '08:05' })
        assert.deepStrictEqual(AlarmQuick.week(now, new Date(2026, 9, 30), null), { date: '2026-11-06', time: '15:00' })
        assert.deepStrictEqual(AlarmQuick.today(now), { date: '2026-10-11', time: '16:00' })
    })

    // ---------------------------------------------------------------- the dialog's files
    await check('dialog files: the five are in dist/form, and form.css keeps the dialog rules (one 440px column, no @media, lists out of the flow)', () => {
        for (const file of ['form.css', 'alarmQuick.js', 'searchTokens.js', 'formModel.js', 'formWebview.js']) {
            assert.ok(fs.existsSync(path.join(DIST, 'form', file)), `dist/form/${file} exists`)
        }
        const css = read('src/form/form.css').replace(/\/\*[\s\S]*?\*\//g, '')
        assert.ok(!/@media/.test(css), 'no @media rule in the dialog CSS')
        assert.ok(/#joplin-plugin-content\s*\{\s*width:\s*440px;/.test(css), 'one 440px column on desktop')
        assert.ok(/#joplin-plugin-content\.jot-mobile\s*\{/.test(css), 'the narrow layout is gated on the jot-mobile class')
        assert.ok(/\.jot-mobile #alarmBody\s*\{\s*flex-direction:\s*column;/.test(css), 'Cockpit\'s stacked picker on mobile')
        assert.ok(/\.jot-suggest\s*\{\s*position:\s*absolute;/.test(css), 'the suggestion lists are absolutely positioned')
        assert.ok(/\.jot-form\s*\{[^}]*position:\s*relative;/.test(css), 'inside the form')
        assert.ok(!/cockpit-mobile|alarmExplain|alarmMode/.test(css), 'Cockpit\'s names and multi-to-do rows are not carried over')
    })

    await check('dialog CSS for dark themes: every scrollbar in the form is themed (the Text field\'s too), and no colour is a literal white or black', () => {
        const css = read('src/form/form.css').replace(/\/\*[\s\S]*?\*\//g, '')
        // Each scrollbar part is one rule whose selector list names the lists, the Text field and the time columns.
        const ruleFor = (part) => {
            const rule = new RegExp(`([^{}]*::-webkit-${part}(?![-\\w])[^{}]*)\\{([^}]*)\\}`).exec(css)
            assert.ok(rule, `a ::-webkit-${part} rule`)
            return { selectors: rule[1], body: rule[2] }
        }
        for (const part of ['scrollbar', 'scrollbar-track', 'scrollbar-thumb']) {
            const rule = ruleFor(part)
            for (const owner of ['.jot-suggest', 'textarea.jot-input', '.alarm-time-scroll']) {
                assert.ok(rule.selectors.includes(`${owner}::-webkit-${part}`), `${owner} has the themed ${part}`)
            }
        }
        assert.ok(ruleFor('scrollbar-thumb').body.includes('var(--joplin-scrollbar-thumb-color'), 'the thumb is the theme\'s colour')
        // Colours come from --joplin-* variables or neutral greys that read on both; white appears only as a variable's fallback.
        const literals = css.replace(/var\(--joplin-[a-z-]+,\s*#ffffff\)/g, '').match(/#fff\b|#ffffff\b|#000\b|#000000\b|\bwhite\b(?!-)|\bblack\b(?!-)/gi) || []
        assert.deepStrictEqual(literals, [], 'no hard-coded white or black')
    })

    await check('dialog glue: Enter and Escape in an open suggestion list are taken at the target phase (stopPropagation + preventDefault); with no list open Escape is the host\'s; globals at call time', () => {
        const glue = read('src/form/formWebview.js')
        const handler = glue.slice(glue.indexOf('function onJotSuggestKeyDown'), glue.indexOf('function onJotNotebookInput'))
        const enter = handler.slice(handler.indexOf("event.key === 'Enter'"), handler.indexOf("event.key === 'Tab'"))
        const pick = enter.slice(enter.indexOf('if (open && jotSuggest.highlight >= 0)'), enter.indexOf('pickJotSuggest(jotSuggest.highlight)'))
        assert.ok(pick.length > 0, 'Enter with a highlighted row picks it')
        assert.ok(pick.includes('event.preventDefault()') && pick.includes('event.stopPropagation()'), 'the pick stops the host from seeing the press (no Create)')
        const swallow = enter.slice(enter.indexOf("if (kind === 'notebook' && notebookTextIsFilter())"))
        assert.ok(swallow.includes('event.preventDefault()') && swallow.includes('event.stopPropagation()'), 'a notebook filter with nothing to pick swallows Enter')
        assert.ok(glue.includes("notebook.addEventListener('keydown', onJotSuggestKeyDown)") && glue.includes("tags.addEventListener('keydown', onJotSuggestKeyDown)"),
            'the handler sits on the inputs themselves (the target phase)')
        assert.ok(!/document\.addEventListener\(\s*'keydown'/.test(glue), 'no document-level keydown listener')
        assert.deepStrictEqual(glue.match(/window\.addEventListener\(\s*'keydown'[^)]*\)/g), ["window.addEventListener('keydown', onJotWindowKeyDown)"],
            'one window-level keydown listener, in the bubble phase (no capture flag), and it leaves inputs alone, so a list still takes its Enter first')
        const windowRule = glue.slice(glue.indexOf('function onJotWindowKeyDown'), glue.indexOf('function focusJotTitle'))
        assert.ok(windowRule.indexOf("if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return") < windowRule.indexOf('event.preventDefault()'))
        assert.ok(!/addEventListener\([^)]*,\s*true\s*\)/.test(glue), 'no capture-phase listener')
        // Escape: only the list handler takes it, and only while its list is open (it closes the list alone); with none open it returns before
        // stopping anything, so the host hears the press and cancels the form - a second Escape closes the form.
        const bare = (source) => source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        const escape = bare(handler).slice(bare(handler).indexOf("event.key === 'Escape'"))
        assert.ok(escape.length > 0, 'the list handler looks at Escape')
        const escapeBranch = escape.slice(0, escape.indexOf('return\n    }'))
        assert.ok(escapeBranch.indexOf('if (!open) return') >= 0 && escapeBranch.indexOf('if (!open) return') < escapeBranch.indexOf('event.stopPropagation()'),
            'with no list open Escape is left to the host')
        assert.ok(escapeBranch.includes('event.preventDefault()') && escapeBranch.includes('event.stopPropagation()') && escapeBranch.includes('closeJotSuggest()'),
            'with a list open Escape closes the list and the host never sees it')
        assert.strictEqual((bare(glue).match(/Escape/g) || []).length, 1, 'Escape is looked at in the list handler only')
        assert.ok(glue.includes('new MutationObserver(initJotFormIfNeeded)'), 'every new form is wired by the observer (setHtml does not re-run scripts)')
        for (const line of glue.split('\n')) {
            assert.ok(!/^var\b.*\b(window\.FormModel|window\.AlarmQuick|AlarmQuick\.|window\.SearchTokens)/.test(line), `no load-time binding: ${line}`)
        }
        const code = glue.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        const modelReads = code.match(/window\.FormModel/g) || []
        assert.strictEqual(modelReads.length, 2, 'window.FormModel is read in model() and in the init guard only')
        assert.ok(!/draggable/.test(glue), 'never draggable')
        for (const button of glue.match(/<button\b[^>]*>/g) || []) assert.ok(button.includes('type="button"'), `every drawn button is type="button": ${button}`)
        for (const gone of ['alarmIsMulti', 'describeAlarmPlan', 'applyAlarmPlan', 'onAlarmModeChanged']) assert.ok(!glue.includes(gone), `${gone} is not ported`)
    })

    await check('dialog glue: Enter in a text input or in Title or Tags: with the Title empty it focuses the Title instead of closing the form; Title and Tags (textareas) submit through the form\'s submit event and never take a new line; an open suggestion list takes its Enter first', () => {
        const glue = read('src/form/formWebview.js')
        assert.ok(glue.includes("form.addEventListener('keydown', onJotFormKeyDown)"), 'on the form, in the bubble phase: after the input\'s own list handler, before Joplin\'s document listener')
        const rule = glue.slice(glue.indexOf('function onJotFormKeyDown'), glue.indexOf('// The form\'s submit event'))
        assert.ok(rule.includes("if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return"), 'Enter only, never mid-composition')
        assert.ok(rule.includes("if (target.tagName !== 'INPUT' && !grows) return"), 'one-line inputs and the growing fields; the Text keeps its new line')
        assert.ok(rule.includes('if (!titleEmpty && !grows) return'), 'a one-line input with a title is Joplin\'s to submit')
        assert.ok(rule.indexOf('event.preventDefault()') < rule.indexOf('submitJotForm()') && rule.includes('if (title) title.focus()'), 'no new line; an empty Title focused, else the form submitted')
        assert.ok(glue.includes("function isJotGrow(element)") && glue.includes("element.classList.contains('jot-grow')"))
    })

    await check('dialog glue: Enter outside a text input (a calendar day, a time, a quick button or a segment just clicked, or nothing focused) submits the form through its submit event; the Title empty, it focuses the Title', () => {
        const glue = read('src/form/formWebview.js')
        assert.ok(glue.includes("window.addEventListener('keydown', onJotWindowKeyDown)"), 'on the window, in the bubble phase: last of all')
        const rule = glue.slice(glue.indexOf('function onJotWindowKeyDown'), glue.indexOf('function focusJotTitle'))
        assert.ok(rule.includes("if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return"))
        assert.ok(rule.includes("if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return"), 'text inputs stay Joplin\'s, the Text keeps its new line')
        assert.ok(rule.includes('event.preventDefault()'), 'a focused button does not take Enter as a click')
        assert.ok(rule.indexOf('title.focus()') < rule.indexOf('submitJotForm()'), 'the empty Title first')
        const submit = glue.slice(glue.indexOf('function submitJotForm'), glue.indexOf('function submitJotForm') + 400)
        assert.ok(submit.includes('form.requestSubmit()') && submit.includes("form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))"), 'Joplin\'s document submit listener answers either way')
    })

    await check('mobile width: from the screen, never the viewport (100vw is the dialog\'s own width on mobile, and Joplin sizes the dialog to the content, so it shrank at every measurement); 94% of the screen, 240 to 440px', () => {
        const vm = require('vm')
        const css = read('src/form/form.css').replace(/\/\*[\s\S]*?\*\//g, '')
        assert.ok(!/\d\s*v(w|h|min|max)\b/.test(css), 'no viewport unit anywhere in the form\'s CSS')
        const glue = read('src/form/formWebview.js')
        assert.ok(!/innerWidth|clientWidth\s*\)|100vw/.test(glue.slice(glue.indexOf('function jotMobileWidth'), glue.indexOf('function jotMobileWidth') + 900)))
        const widthFor = (screen) => {
            const sandbox = { document: { readyState: 'complete', documentElement: {}, getElementById: () => null, querySelector: () => null },
                MutationObserver: class { observe() {} }, setTimeout: () => 0, screen }
            sandbox.window = sandbox
            sandbox.addEventListener = () => {}
            vm.createContext(sandbox)
            vm.runInContext(read('src/form/formWebview.js'), sandbox)
            return sandbox.jotMobileWidth()
        }
        assert.deepStrictEqual([{ width: 412 }, { width: 360 }, { width: 1200 }, { width: 200 }, undefined, { width: NaN }].map(widthFor), [387, 338, 440, 240, 338, 338])
        const apply = glue.slice(glue.indexOf('function applyJotPlatformClass'), glue.indexOf('/** jotMobileWidth'))
        assert.ok(apply.includes("wrapper.style.width = jotMobileWidth() + 'px'"), 'the mobile switch sets it')
    })

    await check('dialog glue: every selector (Type, In this note, Back link, Open) is one generic radiogroup - click, arrow keys wrapping through moveHighlight, the hidden input written; In this note falls back to the route\'s default, else the first button drawn; one line, never stacked', () => {
        const glue = read('src/form/formWebview.js')
        assert.ok(glue.includes("var groups = form.querySelectorAll('.jot-seg')") && glue.includes("groups[group].addEventListener('click', onJotSegClick)")
            && glue.includes("groups[group].addEventListener('keydown', onJotSegKeyDown)"), 'the listeners sit on each radiogroup the form draws')
        const keys = glue.slice(glue.indexOf('function onJotSegKeyDown'), glue.indexOf('/** Type ***'))
        assert.ok(keys.includes('model().moveHighlight(options.length, current, delta)'), 'the arrow keys wrap through the offered buttons')
        assert.ok(keys.includes('event.preventDefault()'), 'an arrow key does not scroll the dialog')
        const setter = glue.slice(glue.indexOf('function setJotSeg'), glue.indexOf('function onJotSegClick'))
        assert.ok(setter.includes('if (input) input.value = resolved'), 'the hidden input carries the choice')
        const resolve = glue.slice(glue.indexOf('function resolveJotSeg'), glue.indexOf('function setJotSeg'))
        assert.ok(resolve.includes("var fallback = field === 'inThisNote' && jotData.inThisNote ? jotData.inThisNote.fallback : null"),
            'an unknown In this note choice is the route\'s default from the island (replace on the selection route, link on the trigger route)')
        assert.ok(resolve.includes('return offered.length ? offered[0] : \'\'') && !resolve.includes('model().KEEP'), 'else the first button drawn, never keep on every route')
        assert.ok(glue.includes("if (jotById('jotInThisNote')) setJotInThisNote(jotById('jotInThisNote').value)"), 'In this note is resolved on open, only when the row is there')
        const css = read('src/form/form.css').replace(/\/\*[\s\S]*?\*\//g, '')
        assert.ok(!/\.jot-seg[^{]*\{[^}]*flex-direction:\s*column;/.test(css), 'no selector is stacked')
        assert.ok(/\.jot-seg-option\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/.test(css), 'a label that does not fit ends in an ellipsis')
        assert.ok(/\.jot-seg-option\.-selected\s*\{(?![^}]*font-weight)[^}]*\}/.test(css), 'a selected segment never changes its weight, so choosing never makes a row jump')
    })

    await check('dialog glue: the heading follows the Type toggle in the wording of the island\'s mode - Edit to-do and Edit note in edit mode, New to-do and New note otherwise (run in a stand-in DOM)', () => {
        const vm = require('vm')
        // Just enough of a document for formWebview.js to load (no form yet) and for setJotType to run on one form.
        const element = (id, attributes = {}) => {
            const classes = new Set()
            return {
                id, value: '', textContent: '', disabled: false, attributes: { ...attributes },
                classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name) }, add: (name) => classes.add(name), contains: (name) => classes.has(name) },
                setAttribute(name, value) { this.attributes[name] = String(value) },
                getAttribute(name) { return name in this.attributes ? this.attributes[name] : null },
                removeAttribute(name) { delete this.attributes[name] },
                hasAttribute(name) { return name in this.attributes },
            }
        }
        const run = (mode) => {
            const options = [element('', { 'data-value': 'todo' }), element('', { 'data-value': 'note' })]
            const nodes = { jotType: element('jotType'), jotHeading: element('jotHeading'), jotBell: element('jotBell'), jotDueClear: element('jotDueClear'), jotPicker: element('jotPicker', { hidden: '' }), jotFormData: element('jotFormData') }
            const group = element('', { 'data-field': 'type' })
            group.querySelectorAll = () => options
            group.parentNode = { querySelector: (selector) => (selector === 'input[name="type"]' ? nodes.jotType : null) }
            const form = element('jotForm')
            form.querySelector = (selector) => (selector === '.jot-seg[data-field="type"]' ? group : null)
            form.querySelectorAll = () => options
            nodes.jotFormData.textContent = JSON.stringify({ mode, notebooks: [], tags: [], defaults: {}, pickerOpen: false, inThisNote: null })
            let wired = false
            const sandbox = {
                document: {
                    readyState: 'complete', documentElement: {},
                    getElementById: (id) => nodes[id] || null,
                    querySelector: () => (wired ? form : null),
                },
                MutationObserver: class { observe() {} },
                setTimeout: () => 0,
            }
            sandbox.window = sandbox
            sandbox.addEventListener = () => {}
            vm.createContext(sandbox)
            vm.runInContext(read('src/form/formModel.js'), sandbox)
            vm.runInContext(read('src/form/formWebview.js'), sandbox)
            wired = true
            sandbox.jotData = sandbox.readJotData()
            const headings = []
            for (const type of ['todo', 'note', 'todo']) {
                sandbox.setJotType(type)
                headings.push(nodes.jotHeading.textContent)
            }
            return headings
        }
        assert.deepStrictEqual(run('edit'), ['Edit to-do', 'Edit note', 'Edit to-do'])
        assert.deepStrictEqual(run('create'), ['New to-do', 'New note', 'New to-do'])
        assert.deepStrictEqual(run(undefined), ['New to-do', 'New note', 'New to-do'], 'an island without a mode is create mode')
        const glue = read('src/form/formWebview.js')
        const init = glue.slice(glue.indexOf('function initJotFormIfNeeded'))
        assert.ok(init.indexOf('jotData = readJotData()') >= 0 && init.indexOf('jotData = readJotData()') < init.indexOf("setJotType(jotById('jotType').value)"),
            'each form reads its island before its first heading is set')
    })

    // ---------------------------------------------------------------- the content script, in Node
    await check('content script: plugin() adds one update listener (and the compositionend handler) and asks for the trigger; a second mount on the same view is a no-op; CodeMirror 5 gets nothing', async () => {
        const editor = await mountTrigger('')
        assert.strictEqual(editor.extensions.length, 1, 'one addExtension call')
        assert.strictEqual(editor.view.state.facet(CMEditorView.updateListener).length, 1, 'one update listener')
        assert.deepStrictEqual(editor.posts, [{ type: 'config' }])
        const exported = loadContentScript()
        const added = []
        const sameView = { id: 'view' }
        const control = { cm6: sameView, editor: sameView, addExtension: (extension) => added.push(extension) }
        global.window = {}
        try {
            const contextOnce = makeContentContext().context
            exported(contextOnce).plugin(control)
            exported(contextOnce).plugin(control)
            assert.strictEqual(added.length, 1, 'mobile mounts twice (joplin#12891): the second is a no-op')
            exported(contextOnce).plugin({ ...control, cm6: { id: 'other' }, editor: undefined })
            assert.strictEqual(added.length, 2, 'another editor is watched')
        } finally {
            delete global.window
        }
        exported(makeContentContext().context).plugin({ addExtension: (extension) => added.push(extension) })
        assert.strictEqual(added.length, 2, 'no cm6: nothing added')
        assert.ok(read('src/contentScript.ts').includes('editorControl.addExtension('), 'Joplin ignores what plugin() returns; addExtension is the way in')
    })

    await check('content script: "hello ++" typed one character at a time fires once, on the last +, with from and to; remove deletes it in one transaction and the caret stays where it was', async () => {
        const editor = await mountTrigger('')
        editor.type('hello +')
        assert.deepStrictEqual(editor.triggers(), [])
        let transactions = 0
        editor.type('+')
        assert.deepStrictEqual(editor.triggers(), [{ type: 'trigger', from: 6, to: 8, trigger: '++' }])
        const realApply = editor.view.apply.bind(editor.view)
        editor.view.apply = (trs) => { transactions += trs.filter(tr => tr.docChanged).length; realApply(trs) }
        await editor.answerTrigger({ action: 'remove' })
        assert.strictEqual(editor.text(), 'hello ')
        assert.strictEqual(transactions, 1, 'one transaction changes the text')
        assert.strictEqual(editor.view.state.selection.main.head, 6, 'the caret, after the trigger, is where the trigger was')
        assert.strictEqual(editor.configs().length, 2, 'the trigger is asked again after the fire')
        editor.type('world')
        assert.strictEqual(editor.text(), 'hello world')
        assert.strictEqual(editor.triggers().length, 1, 'nothing else fired')
    })

    await check('content script: link replaces the trigger with the link (the caret after it); Create and open\'s open is asked after the edit; a second ++ waits while one is asked', async () => {
        const editor = await mountTrigger('Call ')
        editor.type('++')
        editor.type(' ++')
        assert.strictEqual(editor.triggers().length, 1, 'one fire at a time')
        await editor.answerTrigger({ action: 'link', link: '[Call](:/0123456789abcdef0123456789abcdef)', open: '0123456789abcdef0123456789abcdef' })
        assert.strictEqual(editor.text(), 'Call [Call](:/0123456789abcdef0123456789abcdef) ++')
        assert.deepStrictEqual(editor.posts.filter(post => post.type === 'open'), [{ type: 'open', id: '0123456789abcdef0123456789abcdef' }])
        const order = editor.posts.map(post => post.type)
        assert.ok(order.indexOf('open') > order.indexOf('trigger'), 'open after the trigger was answered')
        const moved = await mountTrigger('hello ')
        moved.type('++')
        moved.view.dispatch({ changes: { from: 0, insert: 'Oh, ' }, userEvent: 'input.type' })
        await moved.answerTrigger({ action: 'link', link: '[T](:/x)' })
        assert.strictEqual(moved.text(), 'Oh, hello [T](:/x)', 'from and to were mapped through the change made while the form was up')
        assert.strictEqual(moved.view.state.selection.main.head, moved.text().length)
    })

    await check('content script: Cancel leaves the trigger and remembers it - one more character does not fire, the same ++ rewritten does not; deleted and retyped, it fires again', async () => {
        const editor = await mountTrigger('')
        editor.type('++')
        await editor.answerTrigger({ action: 'cancel' })
        assert.strictEqual(editor.text(), '++')
        editor.type('x')
        assert.strictEqual(editor.triggers().length, 1, 'one more character: no fire')
        editor.view.dispatch({ changes: { from: 2, to: 3 }, userEvent: 'delete.backward' })
        editor.view.dispatch({ changes: { from: 0, to: 2, insert: '++' }, userEvent: 'input.type' })
        assert.strictEqual(editor.triggers().length, 1, 'the same ++ rewritten with the same text (an input method re-committing it): no fire')
        editor.view.dispatch({ changes: { from: 1, to: 2 }, userEvent: 'delete.backward' })
        editor.type('+')
        assert.strictEqual(editor.triggers().length, 2, 'a + deleted and typed again is a new occurrence')
        await editor.answerTrigger(undefined)
        editor.view.dispatch({ changes: { from: 0, to: 2, insert: '++' }, userEvent: 'input.type' })
        assert.strictEqual(editor.triggers().length, 2, 'no answer at all is a cancel too')
        const before = await mountTrigger('')
        before.type('++')
        await before.answerTrigger({ action: 'cancel' })
        before.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
        before.view.dispatch({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' })
        before.view.dispatch({ changes: { from: 0, to: 2, insert: '++' }, userEvent: 'input.type' })
        assert.strictEqual(before.triggers().length, 2, 'a character typed before it changed the occurrence: the memory is dropped')
    })

    await check('content script: C++ and i++ do not fire; the trigger arriving by paste, by insertText (no user event), by undo or redo, or by autocompletion does not fire', async () => {
        const editor = await mountTrigger('')
        editor.type('C++ i++ (++')
        assert.deepStrictEqual(editor.triggers(), [])
        for (const userEvent of ['input.paste', 'undo', 'redo', 'input.complete', 'input.drop', 'input.jot', undefined]) {
            const fresh = await mountTrigger('via ')
            fresh.view.dispatch({ changes: { from: 4, insert: '++' }, selection: { anchor: 6 }, ...(userEvent ? { userEvent } : {}) })
            assert.strictEqual(fresh.text(), 'via ++')
            assert.deepStrictEqual(fresh.triggers(), [], `${userEvent || 'no user event'} does not fire`)
            fresh.type('+')
            assert.deepStrictEqual(fresh.triggers(), [], `${userEvent || 'no user event'}, then a third +: still nothing`)
        }
    })

    await check('content script: while the view is composing nothing fires; once the composition is over the composed ++ fires once', async () => {
        const editor = await mountTrigger('hello ')
        editor.view.composing = true
        editor.type('++', 'input.type.compose')
        assert.deepStrictEqual(editor.triggers(), [], 'not while composing')
        editor.view.composing = false
        editor.view.apply([])
        assert.deepStrictEqual(editor.triggers(), [{ type: 'trigger', from: 6, to: 8, trigger: '++' }], 'at the first update after the composition')
        editor.view.dispatch({ changes: { from: 6, to: 8, insert: '++' }, userEvent: 'input.type.compose' })
        assert.strictEqual(editor.triggers().length, 1, 'never twice')
        await editor.answerTrigger({ action: 'remove' })
        assert.strictEqual(editor.text(), 'hello ')
        const source = read('src/contentScript.ts')
        assert.ok(source.includes('compositionend') && source.includes('compositionEnded(view)'), 'compositionend also schedules the check, in case no update follows it')
    })

    await check('content script: another note (a whole-document replacement with no user event, or a note-id effect) re-asks the trigger, drops the memory, and leaves a pending edit undone', async () => {
        const editor = await mountTrigger('hello ')
        editor.type('++')
        editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: 'another note ++' } })
        assert.strictEqual(editor.configs().length, 2, 'a replaced document asks for the trigger again')
        await editor.quietly(() => editor.answerTrigger({ action: 'remove' }))
        assert.strictEqual(editor.text(), 'another note ++', 'the edit is not made in the other note')
        assert.ok(editor.warnings.some(line => line.startsWith('Jot: the typed trigger is no longer where it was typed')), editor.warnings.join(' | '))
        const noteId = CMStateEffect.define()
        const same = await mountTrigger('same text')
        same.view.dispatch({ effects: noteId.of('0123456789abcdef0123456789abcdef') })
        assert.strictEqual(same.configs().length, 2, 'another note with the same text: its id in an effect')
        same.view.dispatch({ effects: noteId.of('not a note id') })
        same.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
        assert.strictEqual(same.configs().length, 2, 'typing and other effects do not ask')
        const memory = await mountTrigger('')
        memory.type('++')
        await memory.answerTrigger({ action: 'cancel' })
        memory.view.dispatch({ changes: { from: 0, to: 2, insert: '++' } })
        memory.view.dispatch({ changes: { from: 0, to: 2, insert: '++' }, userEvent: 'input.type' })
        assert.strictEqual(memory.triggers().length, 2, 'the memory belonged to the document that was replaced')
    })

    await check('content script: another note lets a waiting fire go - a reply that never comes cannot keep the trigger off there, and a late reply edits nothing', async () => {
        const editor = await mountTrigger('hello ')
        editor.type('++')
        assert.strictEqual(editor.triggers().length, 1)
        editor.type('++')
        assert.strictEqual(editor.triggers().length, 1, 'while it waits, a second ++ in the same note does not fire')
        const noteId = CMStateEffect.define()
        editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: 'other note ' }, effects: noteId.of('0123456789abcdef0123456789abcdef') })
        await tick()
        editor.type('++')
        assert.strictEqual(editor.triggers().length, 2, 'the next note fires at once, though the first reply never came')
        assert.deepStrictEqual(editor.triggers()[1], { type: 'trigger', from: 11, to: 13, trigger: '++' })
        // The first (late) reply: its note is gone, so it edits nothing and remembers nothing; the second is applied.
        await editor.quietly(() => editor.answerTrigger({ action: 'remove' }))
        assert.strictEqual(editor.text(), 'other note ++')
        await editor.answerTrigger({ action: 'remove' })
        assert.strictEqual(editor.text(), 'other note ')
    })

    await check('content script: the trigger in force is the plugin\'s answer - "" turns it off, a new one applies from the next answer, an unanswered question is asked again', async () => {
        const off = await mountTrigger('', { trigger: '' })
        off.type('++ ++')
        assert.deepStrictEqual(off.triggers(), [])
        let value = ';;'
        const changing = await mountTrigger('', () => ({ trigger: value }))
        changing.type('++ ;;')
        assert.deepStrictEqual(changing.triggers(), [{ type: 'trigger', from: 3, to: 5, trigger: ';;' }])
        value = '@@'
        await changing.answerTrigger({ action: 'cancel' })
        changing.type(' ;; @@')
        assert.deepStrictEqual(changing.triggers().map(post => post.trigger), [';;', '@@'], 'the answer after the fire brought the new trigger')
        const late = await mountTrigger('', (attempt) => (attempt === 1 ? undefined : { trigger: '++' }))
        late.type('++')
        assert.deepStrictEqual(late.triggers(), [], 'off until the plugin has answered')
        await tick(700)
        assert.strictEqual(late.configs().length, 2, 'an empty answer (the handler not wired yet) is asked again')
        late.type(' ++')
        assert.deepStrictEqual(late.triggers().map(post => [post.from, post.to]), [[3, 5]])
    })

    // ---------------------------------------------------------------- 0.2: tags, back link, notebook, Open (issues 1 to 3)
    const OPEN_NOTE = { id: 'nOpen', title: 'Reading [list]', is_todo: 1, parent_id: 'fProj' }
    const OPEN_TAGS = { nOpen: [{ id: 'tWork', title: 'work' }, { id: 'tIdea', title: 'idea' }] }
    const tagsValue = (html) => fieldValue(html, 'tags')
    const segValue = (html, id) => (new RegExp(`<input type="hidden" name="[a-zA-Z]+" id="${id}" value="([^"]*)">`).exec(html) || [])[1]

    await check('issues 1 and 6: the Tags start with the tags of the note you are in for notes from text (highlighted text, the typed trigger) by default, for every note with Always, never with Never; the caller\'s route and no note read none', async () => {
        const fromText = await openSelectionWith('Idea', { selectedNote: OPEN_NOTE, noteTags: OPEN_TAGS, dialogResults: [formResult('ok', { title: 'Idea', tags: 'idea, work' })] })
        assert.strictEqual(tagsValue(fromText.state.dialogHtml[0]), 'idea, work, ', 'from highlighted text: sorted, comma separated, a comma and a space after the last')
        assert.deepStrictEqual(noteReads(fromText.state), ['notes/nOpen/tags id,title'])
        assert.deepStrictEqual(fromText.state.timeline.filter(line => line.startsWith('POST tags')), ['POST tags/tIdea/notes', 'POST tags/tWork/notes'])
        const trigger = await fireTriggerWith({ selectedNote: OPEN_NOTE, noteTags: OPEN_TAGS })
        assert.strictEqual(tagsValue(trigger.state.dialogHtml[0]), 'idea, work, ', 'by the typed trigger too')
        const quick = await openFormWith({ selectedNote: OPEN_NOTE, noteTags: OPEN_TAGS })
        assert.deepStrictEqual([tagsValue(quick.state.dialogHtml[0]), noteReads(quick.state)], ['', []], 'a quick note (nothing highlighted) starts with no tags, and reads none')
        const always = await openFormWith({ selectedNote: OPEN_NOTE, noteTags: OPEN_TAGS, settings: { tagsFrom: 'always' } })
        assert.strictEqual(tagsValue(always.state.dialogHtml[0]), 'idea, work, ', 'Always: a quick note too')
        const never = await openSelectionWith('Idea', { selectedNote: OPEN_NOTE, noteTags: OPEN_TAGS, settings: { tagsFrom: 'never' } })
        assert.deepStrictEqual([tagsValue(never.state.dialogHtml[0]), noteReads(never.state)], ['', []], 'Never: not even from text')
        const none = await openSelectionWith('Idea', { selectedNote: null, noteTags: OPEN_TAGS })
        assert.deepStrictEqual([tagsValue(none.state.dialogHtml[0]), noteReads(none.state)], ['', []], 'no note open: nothing to copy')
        const caller = await runBundle({ ...FORM_BASE, selectedNote: OPEN_NOTE, noteTags: OPEN_TAGS, settings: { tagsFrom: 'always' } })
        await withWarnings(caller, () => caller.commands.find(item => item.name === 'jot.open').execute({ mode: 'new', type: 'todo' }))
        assert.deepStrictEqual([tagsValue(caller.dialogHtml[0]), noteReads(caller)], ['', []], 'another plugin\'s form has no note you are in')
    })

    await check('issue 6: the Back link starts on Add for notes from text with "For notes from text in a note" and on Don\'t add for a quick note; each kind has its own notebook setting, the current notebook by default', async () => {
        const text = await openSelectionWith('Idea', { selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never', backlinkFor: 'text' } })
        assert.strictEqual(segValue(text.state.dialogHtml[0], 'jotBacklink'), 'add')
        const quick = await openFormWith({ selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never', backlinkFor: 'text' } })
        assert.strictEqual(segValue(quick.state.dialogHtml[0], 'jotBacklink'), 'none')
        const quickInbox = await openFormWith({ selectedNote: OPEN_NOTE, settings: { defaultNotebook: 'fArch' } })
        assert.strictEqual(islandOf(quickInbox.state.dialogHtml[0]).data.defaults.notebookId, 'fArch', 'a quick note: the inbox')
        const textHome = await openSelectionWith('Idea', { selectedNote: OPEN_NOTE, settings: { defaultNotebook: 'fArch' } })
        assert.strictEqual(islandOf(textHome.state.dialogHtml[0]).data.defaults.notebookId, 'fProj', 'from text: its own setting, the current notebook by default')
        const triggerHome = await fireTriggerWith({ selectedNote: OPEN_NOTE, settings: { defaultNotebook: 'fArch' } })
        assert.strictEqual(islandOf(triggerHome.state.dialogHtml[0]).data.defaults.notebookId, 'fProj', 'by the typed trigger: the same')
        const textFixed = await openSelectionWith('Idea', { selectedNote: OPEN_NOTE, settings: { defaultNotebook: 'fArch', textNotebook: 'fHome' } })
        assert.strictEqual(islandOf(textFixed.state.dialogHtml[0]).data.defaults.notebookId, 'fHome', 'Notebook for notes from text in a note, when it names one')
        const quickStill = await openFormWith({ selectedNote: OPEN_NOTE, settings: { defaultNotebook: 'fArch', textNotebook: 'fHome' } })
        assert.strictEqual(islandOf(quickStill.state.dialogHtml[0]).data.defaults.notebookId, 'fArch', 'and a quick note still the quick notes\' one')
        assert.deepStrictEqual([FormModel.appliesFor('text', true), FormModel.appliesFor('text', false), FormModel.appliesFor('always', false), FormModel.appliesFor('never', true), FormModel.appliesFor('x', true)],
            [true, false, true, false, false])
    })

    await check('issue 6: 0.2.0\'s choices carry over once - tags switched off becomes Never, a back link switched on becomes Always, each old switch then back at its default; an install that never touched them writes nothing', async () => {
        const untouched = await runBundle({ versionInfo: DESKTOP })
        assert.deepStrictEqual(untouched.settingWrites, [])
        const changed = await runBundle({ versionInfo: DESKTOP, settings: { copyTags: false, backlink: true } })
        assert.deepStrictEqual(changed.settingWrites, [
            { key: 'tagsFrom', value: 'never' }, { key: 'copyTags', value: true },
            { key: 'backlinkFor', value: 'always' }, { key: 'backlink', value: false },
        ])
    })

    await check('issue 2: the Back link row (Add / Don\'t add) starts on the setting (off); Add puts the line first, an empty line, then the text; bottom puts it last; the form\'s choice wins', async () => {
        const off = await openFormWith({ selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never' }, dialogResults: [formResult('ok', { title: 'T', body: 'text', backlink: 'add' })] })
        const html = off.state.dialogHtml[0]
        assert.strictEqual(segValue(html, 'jotBacklink'), 'none', 'off by default: Don\'t add')
        assert.ok(html.includes('title="Parent to-do: [Reading \\[list\\]](:/nOpen)">Add</button>'), 'Add shows the line it adds as its tooltip')
        assert.strictEqual(notePosts(off.state)[0].body.body, 'Parent to-do: [Reading \\[list\\]](:/nOpen)\n\ntext', 'Add chosen in the form: first line, an empty line, the text')
        const on = await openFormWith({ selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never', backlinkFor: 'always', backlinkPosition: 'bottom' },
            dialogResults: [formResult('ok', { title: 'T', body: 'text\n\n' })] })
        assert.strictEqual(segValue(on.state.dialogHtml[0], 'jotBacklink'), 'add')
        assert.strictEqual(notePosts(on.state)[0].body.body, 'text\n\nParent to-do: [Reading \\[list\\]](:/nOpen)', 'bottom: the text, one empty line, the link; a result without the field takes the setting')
        const declined = await openFormWith({ selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never', backlinkFor: 'always' }, dialogResults: [formResult('ok', { title: 'T', body: 'text', backlink: 'none' })] })
        assert.strictEqual(notePosts(declined.state)[0].body.body, 'text', 'Don\'t add in the form wins over the setting')
        const alone = await openFormWith({ selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never', backlinkFor: 'always' }, dialogResults: [formResult('ok', { title: 'Only a title' })] })
        assert.strictEqual(notePosts(alone.state)[0].body.body, 'Parent to-do: [Reading \\[list\\]](:/nOpen)', 'no text: the link alone')
        const empty = await openFormWith({ selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never', backlinkFor: 'always' }, dialogResults: [formResult('ok', {})] })
        assert.deepStrictEqual(notePosts(empty.state), [], 'an empty Title and Text create nothing, back link or not')
    })

    await check('issue 2: the back link text is the setting with Copy Note ID\'s placeholders, for the note you are in; no row without a note, on the caller\'s route, or in edit mode', async () => {
        const custom = await openFormWith({ selectedNote: { id: 'nOpen', title: 'Plan', is_todo: 0, parent_id: 'fProj' }, settings: { tagsFrom: 'never', backlinkFor: 'always',
            backlinkTemplate: 'From {Note-Type} "{note title}" in {notebook path} ({notebook_name}, {notebook_id}) {note_id} {mystery}' },
            dialogResults: [formResult('ok', { title: 'T' })] })
        assert.strictEqual(notePosts(custom.state)[0].body.body, 'From note "Plan" in Work/Projects (Projects, fProj) nOpen {mystery}', 'forgiving names; an unknown placeholder stays as written')
        const blank = await openFormWith({ selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never', backlinkFor: 'always', backlinkTemplate: '   ' }, dialogResults: [formResult('ok', { title: 'T' })] })
        assert.strictEqual(notePosts(blank.state)[0].body.body, 'Parent to-do: [Reading \\[list\\]](:/nOpen)', 'an empty text is the default')
        const none = await openFormWith({ selectedNote: null })
        assert.ok(!none.state.dialogHtml[0].includes('jotBacklinkRow'), 'no note open: no row')
        const caller = await runBundle({ ...FORM_BASE, selectedNote: OPEN_NOTE })
        await withWarnings(caller, () => caller.commands.find(item => item.name === 'jot.open').execute({ mode: 'new' }))
        assert.ok(!caller.dialogHtml[0].includes('jotBacklinkRow'), 'the caller\'s route: no row')
        const edit = await editWith({ selectedNote: OPEN_NOTE, settings: { backlinkFor: 'always' } })
        assert.ok(!edit.state.dialogHtml[0].includes('jotBacklinkRow') && !edit.state.dialogHtml[0].includes('jotOpenRow'), 'edit mode: neither Back link nor Open')
    })

    await check('issue 3: the notebook setting names where the form starts (over the note you are in); the caller\'s notebook wins over it; a notebook that is gone falls back to the current one', async () => {
        const inbox = await openFormWith({ selectedNote: { id: 'n1', parent_id: 'fHome' }, settings: { defaultNotebook: 'fArch' } })
        assert.strictEqual(islandOf(inbox.state.dialogHtml[0]).data.defaults.notebookId, 'fArch')
        assert.deepStrictEqual(inbox.state.workspaceCalls, ['selectedNote'], 'the note is still read (tags, back link), the shown notebook is not')
        const gone = await openFormWith({ selectedNote: { id: 'n1', parent_id: 'fHome' }, settings: { defaultNotebook: 'fDeleted' } })
        assert.strictEqual(islandOf(gone.state.dialogHtml[0]).data.defaults.notebookId, 'fHome')
        const current = await openFormWith({ selectedNote: { id: 'n1', parent_id: 'fHome' }, settings: { defaultNotebook: '' } })
        assert.strictEqual(islandOf(current.state.dialogHtml[0]).data.defaults.notebookId, 'fHome', 'The current notebook')
        const caller = await runBundle({ ...FORM_BASE, settings: { defaultNotebook: 'fArch' } })
        await withWarnings(caller, () => caller.commands.find(item => item.name === 'jot.open').execute({ mode: 'new', notebookId: 'fHome' }))
        assert.strictEqual(islandOf(caller.dialogHtml[0]).data.defaults.notebookId, 'fHome')
        const callerNone = await runBundle({ ...FORM_BASE, settings: { defaultNotebook: 'fArch' } })
        await withWarnings(callerNone, () => callerNone.commands.find(item => item.name === 'jot.open').execute({ mode: 'new' }))
        assert.strictEqual(islandOf(callerNone.dialogHtml[0]).data.defaults.notebookId, 'fArch', 'the caller\'s route without a notebook: the setting, so an inbox catches it too')
    })

    await check('issue 3: the notebook setting is a dropdown of the notebooks that exist, registered at startup and again only when the list changes', async () => {
        const state = await runBundle({ ...FORM_BASE })
        await tick(5)
        const registrations = () => state.settingRegistrations.filter(keys => JSON.stringify(keys) === JSON.stringify(['defaultNotebook', 'textNotebook'])).length
        assert.strictEqual(registrations(), 1, 'at startup, from the notebooks read then')
        assert.deepStrictEqual(state.settingSpecs.defaultNotebook.options, {
            '': 'The current notebook', fOdd: '</script><b>odd', fArch: 'Archive', fHome: 'home', fWork: 'Work', fProj: 'Work / Projects',
        }, 'the current notebook first, then every notebook by path')
        assert.deepStrictEqual(state.settingSpecs.textNotebook.options, state.settingSpecs.defaultNotebook.options, 'the same list for notes from text')
        const command = state.commands.find(item => item.name === 'jot.open')
        await withWarnings(state, () => command.execute())
        await tick(5)
        assert.strictEqual(registrations(), 1, 'an unchanged list is not registered again')
    })

    await check('the Open row: No, In editor, New window (no window on mobile), starting on the setting (No); a form opened while another is up opens nothing; Create with Open on opens', async () => {
        const plain = await openFormWith({})
        const html = plain.state.dialogHtml[0]
        assert.strictEqual(segValue(html, 'jotOpen'), 'no', 'stay by default')
        assert.deepStrictEqual((/data-field="open">([\s\S]*?)<\/div>/.exec(html)[1].match(/>([^<]+)<\/button>/g) || []).map(label => label.slice(1, -9)), ['No', 'In editor', 'New window'])
        const fromSetting = await openFormWith({ settings: { openAfterCreate: 'editor' }, dialogResults: [formResult('ok', { title: 'Opened', open: 'editor' })] })
        assert.strictEqual(segValue(fromSetting.state.dialogHtml[0], 'jotOpen'), 'editor')
        assert.deepStrictEqual(fromSetting.outcome.opened, true)
        assert.deepStrictEqual(fromSetting.state.executes.map(call => call.name), ['selectedText', 'openNote'])
        const mobile = await openFormWith({ versionInfo: MOBILE, settings: { openAfterCreate: 'window' } })
        assert.strictEqual(segValue(mobile.state.dialogHtml[0], 'jotOpen'), 'editor', 'a window setting on mobile starts on In editor')
    })

    await check('Type: Note first, then To-do (the order of Cockpit\'s New note and New to-do buttons), in the form and in the setting; the default stays To-do', async () => {
        const { state } = await openFormWith({})
        const group = /data-field="type">([\s\S]*?)<\/div>/.exec(state.dialogHtml[0])[1]
        assert.deepStrictEqual((group.match(/data-value="([a-z]+)"/g) || []).map(match => match.slice(12, -1)), ['note', 'todo'])
        assert.strictEqual(segValue(state.dialogHtml[0], 'jotType'), 'todo')
        assert.deepStrictEqual(Object.keys(state.settingSpecs.defaultType.options), ['note', 'todo'])
    })

    await check('quick to open: the settings in one call; the notebook and tag lists from the cache (read at startup), none read before the form shows; read again once it closes', async () => {
        const folderReads = (state) => state.dataGets.filter(get => get.path.length === 1 && (get.path[0] === 'folders' || get.path[0] === 'tags')).length
        let atOpen = -1
        const state = await runBundle({ ...FORM_BASE, openDialog: (st) => { atOpen = folderReads(st); return { id: 'cancel' } } })
        await tick(5)
        const afterStartup = folderReads(state)
        assert.ok(afterStartup > 0, 'the warm-up read the lists')
        state.settingReads.length = 0
        await withWarnings(state, () => state.commands.find(item => item.name === 'jot.open').execute())
        assert.strictEqual(atOpen, afterStartup, 'no list read between the tap and the form')
        assert.deepStrictEqual(state.settingBatches.slice(-1)[0], ['defaultType', 'dayStartTime', 'defaultNotebook', 'textNotebook', 'tagsFrom', 'backlinkFor', 'backlinkTemplate',
            'backlinkPosition', 'openAfterCreate', 'selectionAction', 'triggerAction'], 'every setting the form starts from, in one call')
        assert.deepStrictEqual(state.settingReads, [], 'and no single reads')
        await tick(5)
        assert.ok(folderReads(state) > afterStartup, 'the lists are read again once the form has closed, for the next open')
        assert.strictEqual(state.syncHandlers.length, 1, 'and after every sync')
        const beforeSync = folderReads(state)
        state.syncHandlers[0]()
        await tick(5)
        assert.ok(folderReads(state) > beforeSync)
    })

    await check('quick to open: a notebook the cache does not hold (the note you are in lives in one made since) makes the form read the lists first, so it never starts on the wrong notebook; an app without settings.values reads them one by one', async () => {
        const folders = FOLDERS.slice()
        const state = await runBundle({ ...FORM_BASE, folders, selectedNote: { id: 'nNew', parent_id: 'fNew' } })
        await tick(5)
        folders.push({ id: 'fNew', title: 'Made just now', parent_id: '' })
        await withWarnings(state, () => state.commands.find(item => item.name === 'jot.open').execute())
        assert.strictEqual(islandOf(state.dialogHtml[0]).data.defaults.notebookId, 'fNew')
        const old = await openFormWith({ settingsValuesMissing: true, settings: { defaultType: 'note', openAfterCreate: 'editor' } })
        const html = old.state.dialogHtml[0]
        assert.deepStrictEqual([segValue(html, 'jotType'), segValue(html, 'jotOpen')], ['note', 'editor'], 'the same settings, read one by one')
        assert.ok(old.state.settingReads.includes('defaultType') && old.state.settingReads.includes('openAfterCreate'))
    })

    await check('quick to open: a cache read before the first notebook was made (no notebook at all) is read again before the form says there is none', async () => {
        const folders = []
        const state = await runBundle({ ...FORM_BASE, folders, selectedNote: null })
        await tick(5)
        folders.push({ id: 'fFirst', title: 'First', parent_id: '' })
        await withWarnings(state, () => state.commands.find(item => item.name === 'jot.open').execute())
        assert.deepStrictEqual(state.messageBoxes, [], 'no "there is no notebook" message')
        assert.strictEqual(islandOf(state.dialogHtml[0]).data.defaults.notebookId, 'fFirst')
    })

    await check('quick to open: the timing line is off in every commit (a test build turns it on, never committed); off, the markup carries no line and the island no timing', async () => {
        assert.ok(read('src/core/timing.ts').includes('export const SHOW_OPEN_TIMINGS = false'), 'SHOW_OPEN_TIMINGS is false')
        const { state } = await openFormWith({})
        assert.ok(!state.dialogHtml[0].includes('jotTiming'))
        assert.strictEqual(islandOf(state.dialogHtml[0]).data.timing, null)
    })

    await check('popup: one line per selector in the order Type, Title, Text, Notebook, Tags, In this note, Back link, Open, Due (last); a keyboard hint in the heading on desktop only', async () => {
        const { state } = await openSelectionWith('Pay rent', { selectedNote: OPEN_NOTE, settings: { tagsFrom: 'never' } })
        const html = state.dialogHtml[0]
        const order = ['jotTypeRow', 'id="jotTitle"', 'id="jotBody"', 'id="jotNotebook"', 'id="jotTags"', 'jotInThisNoteRow', 'jotBacklinkRow', 'jotOpenRow', 'jotDueRow', 'id="jotPicker"']
        const positions = order.map(marker => html.indexOf(marker))
        assert.ok(positions.every(at => at >= 0), JSON.stringify(order.filter((marker, index) => positions[index] < 0)))
        assert.deepStrictEqual(positions.slice().sort((a, b) => a - b), positions, 'in that order')
        assert.strictEqual((html.match(/class="jot-seg[ "]/g) || []).length, 4, 'four selectors')
        assert.ok(html.includes('<span class="jot-hint" aria-hidden="true">Enter creates · Esc cancels</span>'))
        const phone = await openFormWith({ versionInfo: MOBILE })
        assert.ok(!phone.state.dialogHtml[0].includes('jot-hint'))
    })

    await check('formModel: backlinkText (Copy Note ID\'s placeholders and rules), composeBody (top, bottom, the empty line), openChoice', () => {
        const folders = [{ id: 'f1', title: 'Work', parent_id: '' }, { id: 'f2', title: 'Projects', parent_id: 'f1' }]
        const parent = { id: 'abc', title: 'Plan', is_todo: 1, parent_id: 'f2' }
        assert.strictEqual(FormModel.backlinkText('', parent, folders), 'Parent to-do: [Plan](:/abc)')
        assert.strictEqual(FormModel.backlinkText('{note_link} {NOTE ID} {notebook-path} {notebook_name} {constructor}', parent, folders), '[Plan](:/abc) abc Work/Projects Projects {constructor}',
            'own keys only: an inherited name is not a placeholder')
        assert.strictEqual(FormModel.backlinkText('x', null, folders), '')
        assert.strictEqual(FormModel.composeBody('\n\n body \n\n', 'L', 'top'), 'L\n\n body')
        assert.strictEqual(FormModel.composeBody('body', 'L', 'bottom'), 'body\n\nL')
        assert.strictEqual(FormModel.composeBody('', 'L', 'bottom'), 'L')
        assert.strictEqual(FormModel.composeBody('as typed\n', '', 'top'), 'as typed\n')
        assert.deepStrictEqual(['editor', 'window', 'no', 'x', undefined].map(value => FormModel.openChoice(value, false)), ['editor', 'window', 'no', 'no', 'no'])
        assert.deepStrictEqual(['window', 'editor'].map(value => FormModel.openChoice(value, true)), ['editor', 'editor'])
    })

    // ---------------------------------------------------------------- the selection guard
    await check('selection guard: a Create whose tag makes Joplin select the new note opens the note being read again, with its scroll, caret and focus', async () => {
        const editor = guardedEditor()
        const { state, outcome } = await openFormWith({ ...editor.fixture, dialogResults: [formResult('ok', { title: 'Call the bank', tags: 'work' })] })
        assert.deepStrictEqual(outcome, { id: 'note0001', opened: false }, 'resolves as a plain Create')
        assert.deepStrictEqual(editor.opens, ['nRead'], 'the note being read, opened once; the new note never by Jot')
        assert.deepStrictEqual(editor.setViews[0], HELD_VIEW, 'the view held before the tag write')
        assert.deepStrictEqual(editor.view(), HELD_VIEW, 'scroll, caret and focus as they were')
        const order = state.timeline.filter(line => line !== 'execute editor.execCommand')
        assert.deepStrictEqual(order, ['execute selectedText', 'POST notes', 'POST tags/tWork/notes', 'execute openNote'])
        assert.ok(state.timeline.indexOf('execute editor.execCommand') < state.timeline.indexOf('POST tags/tWork/notes'), 'the view is read before the tag write')
        assert.deepStrictEqual(state.warnings, [])
    })

    await check('selection guard: nothing moved (a notebook view), nothing reopened; no tags, Create and open, a multi-selection, mobile: nothing held at all', async () => {
        const still = guardedEditor({ jumpTo: null })
        const kept = await openFormWith({ ...still.fixture, dialogResults: [formResult('ok', { title: 'Call the bank', tags: 'work' })] })
        assert.deepStrictEqual(still.opens, [], 'no openNote')
        assert.deepStrictEqual(still.setViews, [])
        assert.ok(kept.state.selectionReads > 2, 'the selection was watched')
        for (const [label, options] of [
            ['no tags', { dialogResults: [formResult('ok', { title: 'Plain' })] }],
            ['Create and open', { dialogResults: [formResult('ok', { open: 'editor',  title: 'Open it', tags: 'work' })] }],
            ['mobile', { versionInfo: MOBILE, dialogResults: [formResult('ok', { title: 'Phone', tags: 'work' })] }],
        ]) {
            const editor = guardedEditor()
            const run = await openFormWith({ ...editor.fixture, ...options })
            assert.strictEqual(run.state.selectionReads, 0, `${label}: nothing held`)
            assert.deepStrictEqual(editor.opens.filter(id => id === 'nRead'), [], `${label}: the note being read is not reopened`)
        }
        const several = guardedEditor({ selection: () => ['nRead', 'nOther'] })
        const multi = await openFormWith({ ...several.fixture, dialogResults: [formResult('ok', { title: 'Two', tags: 'work' })] })
        assert.strictEqual(multi.state.selectionReads, 1, 'a multi-selection is read once and not held')
        assert.ok(!multi.state.executes.some(call => call.name === 'editor.execCommand'), 'no view read for it')
    })

    await check('selection guard: the Rich Text editor (no view) gets its note back without a view; a multi-selection appearing is the user\'s; a failed open is a warning and the command still resolves', async () => {
        const rich = guardedEditor({ richText: true })
        const plain = await openFormWith({ ...rich.fixture, dialogResults: [formResult('ok', { title: 'Rich', tags: 'work' })] })
        assert.deepStrictEqual(rich.opens, ['nRead'])
        assert.deepStrictEqual(rich.setViews, [], 'no view to put back')
        assert.deepStrictEqual(plain.outcome.opened, false)
        const user = guardedEditor({ selection: (read, state) => state.timeline.includes('POST tags/tWork/notes') ? ['nRead', 'nPicked'] : ['nRead'] })
        await openFormWith({ ...user.fixture, dialogResults: [formResult('ok', { title: 'Mine', tags: 'work' })] })
        assert.deepStrictEqual(user.opens, [], 'a multi-selection is not undone')
        const refused = guardedEditor({ openThrows: true })
        const failed = await openFormWith({ ...refused.fixture, dialogResults: [formResult('ok', { title: 'Gone', tags: 'work' })] })
        assert.deepStrictEqual(failed.outcome, { id: 'note0001', opened: false })
        assert.deepStrictEqual(refused.opens, ['nRead'], 'tried once, not again')
        assert.ok(failed.state.warnings.some(line => line.startsWith('Jot: Joplin moved off the note you were reading and it could not be opened again')), failed.state.warnings.join(' | '))
    })

    await check('selection guard: on the selection route the link is written before the tags, so a jump cannot carry it into the new note; the note is then given back', async () => {
        const editor = guardedEditor()
        const { state } = await openSelectionWith('Call the bank', {
            ...editor.fixture,
            executeResults: { ...editor.fixture.executeResults },
            dialogResults: [formResult('ok', { title: 'Call the bank', tags: 'work', inThisNote: 'replace' })],
        })
        const order = state.timeline.filter(line => line !== 'execute editor.execCommand')
        assert.deepStrictEqual(order, ['execute selectedText', 'POST notes', 'execute insertText', 'POST tags/tWork/notes', 'execute openNote'])
        assert.deepStrictEqual(editor.opens, ['nRead'])
    })

    await check('selection guard: the trigger route answers first and writes its tags after, held, and a jump they cause is undone', async () => {
        const editor = guardedEditor()
        const { state, answer } = await fireTriggerWith({ ...editor.fixture, dialogResults: [formResult('ok', { title: 'Order tyres', tags: 'work', inThisNote: 'link' })] })
        assert.deepStrictEqual(answer, { action: 'link', link: '[Order tyres](:/note0001)' })
        assert.ok(!state.timeline.includes('POST tags/tWork/notes'), 'no tag yet when the answer goes')
        await tick(60)
        const order = state.timeline.filter(line => line !== 'execute editor.execCommand')
        assert.deepStrictEqual(order, ['POST notes', 'POST tags/tWork/notes', 'execute openNote'])
        assert.deepStrictEqual(editor.opens, ['nRead'])
        assert.deepStrictEqual(editor.view(), HELD_VIEW)
        const opening = guardedEditor()
        const open = await fireTriggerWith({ ...opening.fixture, dialogResults: [formResult('ok', { open: 'editor',  title: 'Open me', tags: 'work', inThisNote: 'remove' })] })
        await tick(60)
        assert.strictEqual(open.state.selectionReads, 0, 'Create and open on the trigger route: the tags are not held')
        assert.ok(open.state.timeline.includes('POST tags/tWork/notes'), 'the tags are written all the same')
    })

    await check('selection guard: edit mode holds the selection when Save moves the note to another notebook or changes its tags, not for a title alone', async () => {
        for (const [label, fields] of [['notebook', { notebookId: 'fHome' }], ['tags', { tags: 'urgent' }]]) {
            const editor = guardedEditor({ jumpTo: 'nNeighbour' })
            const { outcome, state } = await editWith({ ...editor.fixture, dialogResults: [editResult('ok', fields)] })
            assert.ok(outcome && outcome.changed.length, `${label}: saved`)
            assert.deepStrictEqual(editor.opens, ['nRead'], `${label}: the note being read is given back`)
            assert.deepStrictEqual(editor.view(), HELD_VIEW, `${label}: with its view`)
            assert.ok(state.selectionReads > 1, label)
        }
        const title = guardedEditor({ jumpTo: 'nNeighbour' })
        const renamed = await editWith({ ...title.fixture, dialogResults: [editResult('ok', { title: 'Call the bank today' })] })
        assert.deepStrictEqual(renamed.outcome.changed, ['title'])
        assert.strictEqual(renamed.state.selectionReads, 0, 'a title alone moves no selection: nothing held, no wait')
    })

    await check('content script: jot.getView answers the note, scroll, caret and focus; jot.setView puts them back, clamped, and refuses another note\'s view', async () => {
        const editor = await mountTrigger('0123456789')
        assert.deepStrictEqual(Object.keys(editor.commands).sort(), ['jot.getView', 'jot.setView'])
        assert.deepStrictEqual(editor.commands['jot.getView'](), { noteId: null, scrollTop: 0, anchor: 10, head: 10, docLength: 10, focused: false }, 'no note id until Joplin switches a note')
        const noteId = CMStateEffect.define()
        editor.view.dispatch({ effects: noteId.of('0123456789abcdef0123456789abcdef') })
        assert.strictEqual(editor.commands['jot.getView']().noteId, '0123456789abcdef0123456789abcdef')
        const put = editor.commands['jot.setView']({ noteId: '0123456789abcdef0123456789abcdef', scrollTop: 420, anchor: 2, head: 99, focused: true })
        assert.deepStrictEqual(put, { noteId: '0123456789abcdef0123456789abcdef', scrollTop: 420, anchor: 2, head: 10, docLength: 10, focused: true }, 'the head clamped to the document')
        assert.deepStrictEqual([editor.view.scrollDOM.scrollTop, editor.view.hasFocus], [420, true])
        assert.strictEqual(editor.commands['jot.setView']({ noteId: 'ffffffffffffffffffffffffffffffff', scrollTop: 1, anchor: 0, head: 0 }), null, 'another note\'s view is refused')
        assert.strictEqual(editor.view.scrollDOM.scrollTop, 420, 'and changes nothing')
        assert.strictEqual(editor.commands['jot.setView']('nonsense'), null)
        assert.ok(read('src/contentScript.ts').includes("editorControl.registerCommand('jot.getView', () => watcher.viewState(view))"))
    })

    await check('sandbox proxy: the audit below covers edit mode\'s calls - the note reads, PUT notes/:id, DELETE tags/:id/notes/:noteId, the note list\'s menu item - each a member read and called at once', () => {
        const host = read('src/form/form.ts')
        for (const call of ['joplin.data.get(["notes", noteId], { fields: EDIT_NOTE_FIELDS })', 'joplin.data.put(["notes", noteId], null, plan.put)',
            'joplin.data.delete(["tags", tag.id, "notes", noteId])', 'joplin.data.get(path, { fields, page: page++, limit: PAGE_LIMIT })']) {
            assert.ok(host.includes(call), `src/form/form.ts calls ${call}`)
        }
        assert.ok(read('src/index.ts').includes('await joplin.views.menuItems.create(EDIT_MENU_ITEM, EDIT_COMMAND, MenuItemLocation.NoteListContextMenu)'))
    })

    // ---------------------------------------------------------------- the sandbox proxy rule
    await check('sandbox proxy: no joplin.* member is ever read without being called in the same expression', () => {
        // Cockpit's audit, unchanged in substance. `joplin` is sandboxProxy(wrappedTarget): its handler.get pushes
        // each property onto a SHARED path and only handler.apply pops one, so a member read that is not called at
        // once leaves the path one segment too long and every later call on it is rejected by the host.
        const files = []
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) walk(full)
                else if (/\.(ts|js)$/.test(entry.name)) files.push(full)
            }
        }
        walk(path.join(ROOT, 'src'))
        assert.ok(files.length >= 3, 'the audit must actually have found the source tree')
        for (const file of ['index.ts', 'core/settings.ts', 'form/form.ts', 'form/formHtml.ts', 'form/formModel.js', 'form/formWebview.js', 'form/editorSelection.ts',
            'trigger.ts', 'contentScript.ts', 'form/triggerRule.js', 'form/selectionGuard.ts']) {
            assert.ok(files.includes(path.join(ROOT, 'src', file)), `the audit covers src/${file}`)
        }

        // Comments, string/template literals and regex literals are blanked out first (newlines kept, so line
        // numbers stay true); a ${...} interpolation is re-entered as code.
        const blankNonCode = (source) => {
            let out = ''
            let i = 0
            const n = source.length
            let prev = ''
            while (i < n) {
                const c = source[i], next = source[i + 1]
                if (c === '/' && next === '/') { while (i < n && source[i] !== '\n') { out += ' '; i++ } continue }
                if (c === '/' && next === '*') {
                    while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i++ }
                    out += '  '; i += 2; continue
                }
                if (c === '"' || c === "'") {
                    out += ' '; i++
                    while (i < n && source[i] !== c) {
                        if (source[i] === '\\') { out += '  '; i += 2; continue }
                        out += source[i] === '\n' ? '\n' : ' '; i++
                    }
                    out += ' '; i++; prev = 'x'; continue
                }
                if (c === '`') {
                    out += ' '; i++
                    while (i < n) {
                        if (source[i] === '\\') { out += '  '; i += 2; continue }
                        if (source[i] === '`') { out += ' '; i++; break }
                        if (source[i] === '$' && source[i + 1] === '{') {
                            out += '  '; i += 2
                            let depth = 1
                            const start = i
                            while (i < n && depth) {
                                if (source[i] === '{') depth++
                                else if (source[i] === '}') depth--
                                if (!depth) break
                                i++
                            }
                            out += blankNonCode(source.slice(start, i))
                            out += ' '; i++; continue
                        }
                        out += source[i] === '\n' ? '\n' : ' '; i++
                    }
                    prev = 'x'; continue
                }
                if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(prev || '(')) {
                    out += ' '; i++
                    let inClass = false
                    while (i < n) {
                        if (source[i] === '\\') { out += '  '; i += 2; continue }
                        if (source[i] === '[') inClass = true
                        else if (source[i] === ']') inClass = false
                        else if (source[i] === '/' && !inClass) break
                        else if (source[i] === '\n') break
                        out += ' '; i++
                    }
                    out += ' '; i++
                    while (i < n && /[a-z]/.test(source[i])) { out += ' '; i++ }
                    prev = 'x'; continue
                }
                out += c
                if (!/\s/.test(c)) prev = c
                i++
            }
            return out
        }

        const offenders = []
        for (const file of files) {
            // `(joplin as any).x()` is the same one-get-then-call shape, so the cast is normalised away.
            const code = blankNonCode(fs.readFileSync(file, 'utf8')).replace(/\(\s*joplin\s+as\s+any\s*\)/g, ' joplin        ')
            // A bare `joplin` (the import) is not a member read and never matches: the group is +. A computed
            // member called at once (joplin.workspace[name](handler)) is one get plus one apply, and is correct.
            const re = /\bjoplin\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\])+/g
            let match
            while ((match = re.exec(code)) !== null) {
                const after = (code.slice(match.index + match[0].length).match(/^\s*(\S)/) || [])[1]
                if (after === '(') continue
                const line = code.slice(0, match.index).split('\n').length
                offenders.push(`${path.relative(ROOT, file)}:${line} -> ${match[0].replace(/\s+/g, '')}`)
            }
        }
        assert.strictEqual(offenders.length, 0,
            'a joplin.* member was read without being called in the same expression, which corrupts the sandbox ' +
            'proxy path for every later call on it:\n        ' + offenders.join('\n        '))
    })

    console.log(failures ? `\n${failures} failing check(s) of ${count}` : `\nAll checks passed (${count})`)
    process.exit(failures ? 1 : 0)
}

main().catch(error => { console.error(error); process.exit(1) })
