// Jot harness (phases 1 and 2).
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
// its place in the call order), every rule of the pure src/form/formModel.js, the copies from Cockpit, the
// dialog glue's shape, and the sandbox proxy rule over every source file.

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
// Besides the per-kind records, `timeline` lists the plugin's writes and commands in the order they were made
// ("POST notes", "POST tags/<id>/notes", "execute insertText", "setValue lastSelectionAction=replace", ...), so
// a check can pin the order of the create, the tags, the edit in the editor and the open.
function makeJoplin(options) {
    const state = {
        onStart: null, commands: [], menuItems: [], toolbarButtons: [], messageBoxes: [], warnings: [],
        sections: [], settingSpecs: {}, settingWrites: [], globalReads: [],
        dialogCreates: [], dialogScripts: [], dialogButtons: [], dialogHtml: [], dialogOpens: 0,
        dataGets: [], dataPosts: [], executes: [], workspaceCalls: [], timeline: [],
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
            registerSettings: async (specs) => { Object.assign(state.settingSpecs, specs) },
            value: async (key) => {
                if (key in written) return written[key]
                if (options.settings && key in options.settings) return options.settings[key]
                return state.settingSpecs[key] ? state.settingSpecs[key].value : undefined
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
        },
        data: {
            get: async (pathParts, query) => {
                state.dataGets.push({ path: pathParts, query })
                if (pathParts.length === 1 && pathParts[0] === 'folders') return page(options.folders || [], query)
                if (pathParts.length === 1 && pathParts[0] === 'tags') return page(tags, query)
                throw new Error(`unexpected GET ${pathParts.join('/')}`)
            },
            post: async (pathParts, query, body) => {
                state.dataPosts.push({ path: pathParts, query, body })
                state.timeline.push(`POST ${pathParts.join('/')}`)
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

// The labels of the In this note buttons a form's markup draws, in order.
function choiceLabels(html) {
    return (html.match(/class="jot-choice-option[^"]*"[^>]*>([^<]*)<\/button>/g) || []).map(match => match.replace(/^[^>]*>/, '').replace(/<\/button>$/, ''))
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
        assert.strictEqual(pkg.repository.url, manifest.repository_url)
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

    await check('build: dist/contentScript.js exists and bundles no CodeMirror of its own', () => {
        const full = path.join(DIST, 'contentScript.js')
        assert.ok(fs.existsSync(full), 'dist/contentScript.js exists')
        const source = fs.readFileSync(full, 'utf8')
        // Every @codemirror/* module the script uses must stay a require() of Joplin's own copy (the externals
        // block in webpack.config.js). A bundled copy shows up as CodeMirror's own code without such a require;
        // the placeholder imports nothing, so for now this only proves the file is the small placeholder.
        const mentions = source.match(/@codemirror\/[a-z-]+/g) || []
        const required = source.match(/require\(\s*["']@codemirror\/[a-z-]+["']\s*\)/g) || []
        assert.strictEqual(mentions.length, required.length, 'every @codemirror/ mention is a require() call, not a bundled copy')
        assert.ok(!/class\s+EditorView\b|\bViewPlugin\.fromClass\b.*\bEditorState\.create\b/s.test(source), 'no CodeMirror view code in the bundle')
        assert.ok(source.length < 20000, `the placeholder is small (${source.length} bytes)`)
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

    await check('desktop: onStart registers jot.open, labelled Jot…, jot.fromSelection, labelled Jot from the selection…, and jot.button, labelled Jot', () => {
        assert.deepStrictEqual(desktop.commands.map(command => [command.name, command.label]),
            [['jot.open', 'Jot…'], ['jot.fromSelection', 'Jot from the selection…'], ['jot.button', 'Jot']])
    })

    await check('desktop: Tools > Jot… is one menu item with the Ctrl+Shift+J accelerator, and jot.fromSelection is in the editor\'s right-click menu', () => {
        assert.deepStrictEqual(desktop.menuItems, [
            { id: 'jot.open.menu', commandName: 'jot.open', location: 'tools', options: { accelerator: 'Ctrl+Shift+J' } },
            { id: 'jot.fromSelection.menu', commandName: 'jot.fromSelection', location: 'editorContextMenu', options: undefined },
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
        assert.deepStrictEqual(mobile.commands.map(command => command.name), ['jot.open', 'jot.fromSelection', 'jot.button'])
        assert.deepStrictEqual(mobile.menuItems, [])
        assert.deepStrictEqual(mobile.warnings, [])
    })

    const refused = await runBundle({ versionInfo: DESKTOP, menuItemsThrow: true })

    await check('an app that refuses the menu items still starts the plugin, with one console warning for each item', () => {
        assert.deepStrictEqual(refused.commands.map(command => command.name), ['jot.open', 'jot.fromSelection', 'jot.button'])
        assert.strictEqual(refused.warnings.length, 2)
        assert.ok(refused.warnings[0].startsWith('Jot: could not add Tools > Jot…'), refused.warnings[0])
        assert.ok(refused.warnings[1].startsWith('Jot: could not add Jot from the selection… to the editor\'s right-click menu'), refused.warnings[1])
    })

    // ---------------------------------------------------------------- settings and the toolbar gate
    await check('settings: section Jot with exactly defaultType, openTarget, dayStartTime and showToolbarButton on screen, worded as the brief\'s 4.6 table, and the hidden lastSelectionAction', () => {
        assert.deepStrictEqual(desktop.sections.map(section => [section.name, section.spec.label]), [['jot', 'Jot']])
        const specs = desktop.settingSpecs
        assert.deepStrictEqual(Object.keys(specs), ['defaultType', 'openTarget', 'dayStartTime', 'showToolbarButton', 'lastSelectionAction'])
        for (const key of Object.keys(specs)) {
            assert.strictEqual(specs[key].section, 'jot', `${key} is in the Jot section`)
            assert.strictEqual(specs[key].public, key !== 'lastSelectionAction', `${key} is ${key === 'lastSelectionAction' ? 'hidden' : 'public'}`)
        }
        assert.deepStrictEqual([specs.lastSelectionAction.value, specs.lastSelectionAction.type, specs.lastSelectionAction.isEnum], ['keep', 2, undefined],
            'a per-device string, keep until the user picks another')
        const STRING = 2, BOOL = 3
        assert.deepStrictEqual(
            { label: specs.defaultType.label, description: specs.defaultType.description, value: specs.defaultType.value, type: specs.defaultType.type, isEnum: specs.defaultType.isEnum, options: specs.defaultType.options },
            { label: 'What Jot creates', description: 'Whether the form opens as a to-do or a note. You can switch in the form.', value: 'todo', type: STRING, isEnum: true, options: { todo: 'A to-do', note: 'A note' } })
        assert.deepStrictEqual(
            { label: specs.openTarget.label, description: specs.openTarget.description, value: specs.openTarget.value, type: specs.openTarget.type, isEnum: specs.openTarget.isEnum, options: specs.openTarget.options },
            { label: 'Create and open opens the note', description: 'In the editor, or in a new window on desktop. Create (without "and open") never opens anything.', value: 'editor', type: STRING, isEnum: true, options: { editor: 'In the editor', window: 'In a new window' } })
        assert.deepStrictEqual(
            { label: specs.dayStartTime.label, description: specs.dayStartTime.description, value: specs.dayStartTime.value, type: specs.dayStartTime.type },
            { label: 'Day start time (HH:MM)', description: 'The time a to-do gets when its date is picked before its time, as in Cockpit\'s picker.', value: '09:00', type: STRING })
        assert.deepStrictEqual(
            { label: specs.showToolbarButton.label, description: specs.showToolbarButton.description, value: specs.showToolbarButton.value, type: specs.showToolbarButton.type },
            { label: 'Show the Jot button in the note toolbar', description: 'The button opens the form; on mobile it and the typed trigger are the ways in. Takes effect after Joplin restarts, since Joplin cannot add or remove a toolbar button while running.', value: true, type: BOOL })
        assert.ok(!('trigger' in specs), 'the trigger setting comes with the content script (phase 3)')
    })

    await check('toolbar gate: with showToolbarButton on (the default) jot.button is a NoteToolbar button on desktop and on mobile', () => {
        const button = [{ id: 'jot.button.toolbar', commandName: 'jot.button', location: 'noteToolbar' }]
        assert.deepStrictEqual(desktop.toolbarButtons, button)
        assert.deepStrictEqual(mobile.toolbarButtons, button)
    })

    await check('toolbar gate: with showToolbarButton off no button is made, and the three commands are still registered', async () => {
        const off = await runBundle({ versionInfo: DESKTOP, settings: { showToolbarButton: false } })
        assert.deepStrictEqual(off.toolbarButtons, [])
        assert.deepStrictEqual(off.commands.map(command => command.name), ['jot.open', 'jot.fromSelection', 'jot.button'])
        const offMobile = await runBundle({ versionInfo: MOBILE, settings: { showToolbarButton: false } })
        assert.deepStrictEqual(offMobile.toolbarButtons, [])
    })

    // ---------------------------------------------------------------- the form's dialog and markup
    await check('form: the dialog is built on the first open only (not at startup): one handle, five scripts in order, the three buttons', async () => {
        assert.deepStrictEqual(desktop.dialogCreates, [], 'nothing is built while the plugin starts')
        const state = await runBundle({ ...FORM_BASE })
        const command = state.commands.find(item => item.name === 'jot.open')
        await command.execute()
        await command.execute()
        assert.deepStrictEqual(state.dialogCreates, ['jot.form'])
        assert.deepStrictEqual(state.dialogScripts, ['./form/form.css', './form/alarmQuick.js', './form/searchTokens.js', './form/formModel.js', './form/formWebview.js'])
        assert.deepStrictEqual(state.dialogButtons, [[
            { id: 'ok', title: 'Create' },
            { id: 'openAfter', title: 'Create and open' },
            { id: 'cancel', title: 'Cancel' },
        ]])
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

    await check('form markup: the fields in DOM order (Type, Title, Text, Notebook, Tags, Due), all in the initial markup, the Title focused', async () => {
        const { state } = await openFormWith({})
        const html = state.dialogHtml[0]
        assert.ok(html.includes('<form name="jot"'), 'one form named jot (formData.jot)')
        const order = ['id="jotHeading"', 'name="type"', 'name="title"', 'name="body"', 'id="jotNotebook"', 'name="notebookId"', 'name="tags"',
            'id="jotDueText"', 'id="jotBell"', 'id="jotDueClear"', 'name="dueDate"', 'name="dueTime"', 'id="jotPicker"']
        const positions = order.map(marker => html.indexOf(marker))
        positions.forEach((position, index) => assert.ok(position >= 0, `${order[index]} is in the markup`))
        assert.deepStrictEqual(positions.slice().sort((a, b) => a - b), positions, 'the fields come in the brief\'s order')
        assert.ok(/<input type="text" name="title"[^>]*\bautofocus\b/.test(html), 'the Title is a text input with autofocus')
        assert.ok(/<textarea name="body"[^>]*rows="3"/.test(html), 'the Text is a three-line textarea')
        assert.ok(/<input type="text" id="jotNotebook"[^>]*value="Work"/.test(html), 'the Notebook input shows the default notebook\'s path')
        assert.ok(/<input type="hidden" name="notebookId" id="jotNotebookId" value="fWork">/.test(html), 'and its id rides in the hidden notebookId')
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
        assert.deepStrictEqual(folderReads.map(get => get.query.page), [1, 2, 3], 'the folders are read page by page')
        assert.deepStrictEqual(folderReads[0].query.fields, ['id', 'title', 'parent_id'])
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
        assert.ok(/data-type="note" role="radio" aria-checked="true" tabindex="0"/.test(html), 'Note is the checked radio and the tab stop')
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
        assert.deepStrictEqual(state.dialogCreates, [])
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
        const { state, outcome } = await openFormWith({ dialogResults: [formResult('openAfter', { title: 'Open me' })] })
        assert.deepStrictEqual(state.executes, [READ_SELECTION, { name: 'openNote', args: [outcome.id] }])
        assert.deepStrictEqual(outcome, { id: outcome.id, opened: true })
    })

    await check('Create and open: with openTarget "In a new window" runs openNoteInNewWindow; when that throws, openNote with one console warning', async () => {
        const inWindow = await openFormWith({ settings: { openTarget: 'window' }, dialogResults: [formResult('openAfter', { title: 'Window' })] })
        assert.deepStrictEqual(inWindow.state.executes, [READ_SELECTION, { name: 'openNoteInNewWindow', args: [inWindow.outcome.id] }])
        assert.deepStrictEqual(inWindow.state.warnings, [])
        const fallback = await openFormWith({
            settings: { openTarget: 'window' }, executeThrows: ['openNoteInNewWindow'], dialogResults: [formResult('openAfter', { title: 'Old app' })],
        })
        assert.deepStrictEqual(fallback.state.executes.map(call => call.name), ['selectedText', 'openNoteInNewWindow', 'openNote'])
        assert.deepStrictEqual(fallback.state.executes[2].args, [fallback.outcome.id])
        assert.strictEqual(fallback.state.warnings.length, 1)
        assert.ok(fallback.state.warnings[0].startsWith('Jot: could not open the note in a new window'), fallback.state.warnings[0])
        assert.deepStrictEqual(fallback.state.messageBoxes, [], 'silently: no message box')
        const onMobile = await openFormWith({ versionInfo: MOBILE, settings: { openTarget: 'window' }, dialogResults: [formResult('openAfter', { title: 'Phone' })] })
        assert.deepStrictEqual(onMobile.state.executes.map(call => call.name), ['selectedText', 'openNote'], 'mobile opens in the editor')
    })

    await check('both empty: Create creates nothing and closes; Create and open creates the empty note and opens it', async () => {
        const create = await openFormWith({ dialogResults: [formResult('ok', { title: '', body: ' \n ', tags: 'work', dueDate: '2026-10-14' })] })
        assert.deepStrictEqual(create.state.dataPosts, [])
        assert.deepStrictEqual(create.state.executes, [READ_SELECTION])
        assert.strictEqual(create.state.dialogOpens, 1, 'closed, not reopened')
        assert.strictEqual(create.outcome, null)
        const open = await openFormWith({ dialogResults: [formResult('openAfter', { title: '', body: '' })] })
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
        assert.ok(/name="title"[^>]*value="Pay rent"/.test(again), 'the title is kept')
        assert.ok(again.includes('>\nflat</textarea>'), 'the text is kept')
        assert.ok(/name="tags"[^>]*value="home"/.test(again), 'the tags are kept')
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
    await check('selection route: jot.fromSelection reads the selection and opens the form prefilled (first non-empty line the Title, the rest the Text), with In this note after Due', async () => {
        const { state, outcome } = await openSelectionWith('\n  Buy milk  \n\nsemi-skimmed\n  2 litres')
        assert.deepStrictEqual(state.executes, [READ_SELECTION], 'the selection is read before the form opens; Cancel runs nothing else')
        assert.deepStrictEqual(state.globalReads, ['editor.codeView'], 'which editor is up is read once, for the buttons')
        const html = state.dialogHtml[0]
        assert.ok(/<input type="text" name="title"[^>]*value="Buy milk"/.test(html), 'the first non-empty line, trimmed, is the Title')
        assert.ok(html.includes('>\nsemi-skimmed\n  2 litres</textarea>'), 'the lines after it, blank lines first dropped, are the Text as typed')
        const order = ['id="jotDueRow"', 'id="jotPicker"', 'id="jotInThisNoteRow"', 'id="jotNotebookList"']
        const positions = order.map(marker => html.indexOf(marker))
        positions.forEach((position, index) => assert.ok(position >= 0, `${order[index]} is in the markup`))
        assert.deepStrictEqual(positions.slice().sort((a, b) => a - b), positions, 'In this note comes after the Due row and its picker')
        assert.ok(html.includes('<span class="jot-label" id="jotInThisNoteLabel">In this note</span>'))
        assert.ok(/<div class="jot-choice" role="radiogroup" aria-labelledby="jotInThisNoteLabel">/.test(html))
        assert.deepStrictEqual(choiceLabels(html), ['Keep the text', 'Replace it with a link to the new note', 'Add a link after it'])
        assert.ok(/data-choice="keep" role="radio" aria-checked="true" tabindex="0">Keep the text</.test(html), 'keep is the default')
        assert.ok(/<input type="hidden" name="inThisNote" id="jotInThisNote" value="keep">/.test(html))
        for (const button of html.match(/<button\b[^>]*>/g) || []) assert.ok(button.includes('type="button"'), `every button is type="button": ${button}`)
        assert.deepStrictEqual(islandOf(html).data.inThisNote, { choices: ['keep', 'replace', 'after'], value: 'keep' })
        assert.strictEqual(outcome, null)
        assert.deepStrictEqual([state.dataPosts, state.settingWrites], [[], []], 'Cancel writes nothing and remembers nothing')
    })

    await check('selection route: the In this note default is lastSelectionAction; the Rich Text editor (editor.codeView false, or unreadable) offers Keep and Replace only', async () => {
        const remembered = await openSelectionWith('Pay rent', { settings: { lastSelectionAction: 'replace' } })
        assert.deepStrictEqual(islandOf(remembered.state.dialogHtml[0]).data.inThisNote, { choices: ['keep', 'replace', 'after'], value: 'replace' })
        assert.ok(/data-choice="replace" role="radio" aria-checked="true" tabindex="0"/.test(remembered.state.dialogHtml[0]))
        assert.ok(/name="inThisNote" id="jotInThisNote" value="replace"/.test(remembered.state.dialogHtml[0]))
        const after = await openSelectionWith('Pay rent', { settings: { lastSelectionAction: 'after' } })
        assert.strictEqual(islandOf(after.state.dialogHtml[0]).data.inThisNote.value, 'after')
        const richText = await openSelectionWith('Pay rent', { settings: { lastSelectionAction: 'after' }, globalSettings: { 'editor.codeView': false } })
        const richHtml = richText.state.dialogHtml[0]
        assert.deepStrictEqual(islandOf(richHtml).data.inThisNote, { choices: ['keep', 'replace'], value: 'keep' }, 'a remembered "after" falls back to keep')
        assert.deepStrictEqual(choiceLabels(richHtml), ['Keep the text', 'Replace it with a link to the new note'])
        assert.ok(!richHtml.includes('Add a link after it'), 'Add a link after it is not offered in the Rich Text editor')
        const richReplace = await openSelectionWith('Pay rent', { settings: { lastSelectionAction: 'replace' }, globalSettings: { 'editor.codeView': false } })
        assert.strictEqual(islandOf(richReplace.state.dialogHtml[0]).data.inThisNote.value, 'replace')
        const unreadable = await openSelectionWith('Pay rent', { globalValueThrows: true })
        assert.deepStrictEqual(islandOf(unreadable.state.dialogHtml[0]).data.inThisNote.choices, ['keep', 'replace'], 'an editor that cannot be told is treated as Rich Text')
        assert.strictEqual(unreadable.state.warnings.length, 1)
        assert.ok(unreadable.state.warnings[0].startsWith('Jot: could not tell which editor is open'), unreadable.state.warnings[0])
        const forged = await openSelectionWith('Pay rent', {
            globalSettings: { 'editor.codeView': false }, dialogResults: [formResult('ok', { title: 'Pay rent', inThisNote: 'after' })],
        })
        assert.deepStrictEqual(forged.state.timeline, ['execute selectedText', 'POST notes', 'setValue lastSelectionAction=keep'],
            'an "after" the Rich Text form never offered is applied as keep: no edit')
    })

    await check('selection route, replace: POST notes, the tag calls, then insertText with [Title](:/id) under the final title; nothing opened; the choice remembered', async () => {
        const { state, outcome } = await openSelectionWith('Call the bank\nabout the card', {
            dialogResults: [formResult('ok', { title: ' Call the [bank] ', body: 'about the card', tags: 'work, new one', inThisNote: 'replace' })],
        })
        assert.deepStrictEqual(outcome, { id: outcome.id, opened: false })
        assert.deepStrictEqual(state.timeline, [
            'execute selectedText', 'POST notes', 'POST tags/tWork/notes', 'POST tags', 'POST tags/tag0002/notes',
            'execute insertText', 'setValue lastSelectionAction=replace',
        ])
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
            dialogResults: [formResult('openAfter', { title: 'Rent', body: 'by Friday', tags: 'home', inThisNote: 'after' })],
        })
        assert.deepStrictEqual(several.state.timeline, [
            'execute selectedText', 'POST notes', 'POST tags', 'POST tags/tag0002/notes',
            'execute replaceSelection', 'setValue lastSelectionAction=after', 'execute openNote',
        ], 'Create and open: the edit reaches the note the selection came from before the editor switches')
        assert.deepStrictEqual(several.state.executes[1].args, [`Pay rent\nby Friday\n[Rent](:/${several.outcome.id})`])
        assert.deepStrictEqual(several.state.executes[2], { name: 'openNote', args: [several.outcome.id] })
        assert.deepStrictEqual(several.outcome, { id: several.outcome.id, opened: true })
    })

    await check('selection route, keep: no edit at all; Create and open opens the new note; replace with an empty Title links the title the empty-title rule gave', async () => {
        const keep = await openSelectionWith('Idea\nmore', { dialogResults: [formResult('openAfter', { title: 'Idea', body: 'more', inThisNote: 'keep' })] })
        assert.deepStrictEqual(keep.state.timeline, ['execute selectedText', 'POST notes', 'setValue lastSelectionAction=keep', 'execute openNote'])
        assert.deepStrictEqual(keep.outcome, { id: keep.outcome.id, opened: true })
        const missing = await openSelectionWith('Idea', { dialogResults: [formResult('ok', { title: 'Idea' })] })
        assert.deepStrictEqual(missing.state.timeline, ['execute selectedText', 'POST notes', 'setValue lastSelectionAction=keep'], 'a result without the field is keep')
        const emptied = await openSelectionWith('First\nrest', { dialogResults: [formResult('ok', { title: '  ', body: 'First line\nrest', inThisNote: 'replace' })] })
        assert.strictEqual(notePosts(emptied.state)[0].body.title, 'First line')
        assert.deepStrictEqual(emptied.state.executes[1].args, [`[First line](:/${emptied.outcome.id})`])
    })

    await check('lastSelectionAction is written after a create on the selection route only: not on the plain route, not on Cancel, not when nothing is created', async () => {
        const plain = await openFormWith({ dialogResults: [formResult('ok', { title: 'Plain', inThisNote: 'replace' })] })
        assert.deepStrictEqual(plain.state.settingWrites, [], 'the plain route remembers nothing')
        assert.deepStrictEqual(plain.state.executes, [READ_SELECTION], 'and makes no edit, whatever the result carries')
        assert.ok(!plain.state.dialogHtml[0].includes('jotInThisNote'), 'the plain form has no In this note row')
        assert.strictEqual(islandOf(plain.state.dialogHtml[0]).data.inThisNote, null)
        const cancelled = await openSelectionWith('Idea', { dialogResults: [formResult('cancel', { title: 'Idea', inThisNote: 'replace' })] })
        assert.deepStrictEqual(cancelled.state.settingWrites, [])
        const nothing = await openSelectionWith('Idea', { dialogResults: [formResult('ok', { title: '', body: '', inThisNote: 'replace' })] })
        assert.deepStrictEqual([nothing.state.dataPosts, nothing.state.settingWrites, nothing.outcome], [[], [], null])
        const created = await openSelectionWith('Idea', { dialogResults: [formResult('ok', { title: 'Idea', inThisNote: 'after' })] })
        assert.deepStrictEqual(created.state.settingWrites, [{ key: 'lastSelectionAction', value: 'after' }])
    })

    await check('no selection: a throwing selectedText, a non-string, an empty or whitespace-only answer all open the plain form (no row, no editor read)', async () => {
        const thrown = await openSelectionWith(undefined, { executeThrows: ['selectedText'], dialogResults: [formResult('ok', { title: 'Plain', inThisNote: 'replace' })] })
        assert.ok(!thrown.state.dialogHtml[0].includes('jotInThisNoteRow'))
        assert.strictEqual(islandOf(thrown.state.dialogHtml[0]).data.inThisNote, null)
        assert.deepStrictEqual(thrown.state.globalReads, [], 'the editor is not asked about on the plain route')
        assert.strictEqual(thrown.state.warnings.length, 1)
        assert.ok(thrown.state.warnings[0].startsWith('Jot: could not read the editor\'s selection'), thrown.state.warnings[0])
        assert.deepStrictEqual(thrown.state.timeline, ['execute selectedText', 'POST notes'], 'the note is created, with no edit and no memory')
        assert.ok(/name="title"[^>]*value=""/.test(thrown.state.dialogHtml[0]), 'nothing prefilled')
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
                settings: { lastSelectionAction: 'replace' }, dialogResults: [formResult('ok', { title: 'Idea for later', inThisNote: 'replace' })],
            }, command)
            assert.ok(/name="title"[^>]*value="Idea for later"/.test(state.dialogHtml[0]), `${command} prefills the Title`)
            assert.ok(state.dialogHtml[0].includes('id="jotInThisNoteRow"'), `${command} shows In this note`)
            assert.deepStrictEqual(state.executes.slice(1), [{ name: 'insertText', args: [`[Idea for later](:/${outcome.id})`] }])
        }
        const none = await openSelectionWith(undefined, {}, 'jot.fromSelection')
        assert.ok(!none.state.dialogHtml[0].includes('jotInThisNoteRow'), 'no selection: the same form as jot.open')
        assert.strictEqual(none.state.dialogOpens, 1)
    })

    await check('an edit that throws is a console warning: the note stays created, the choice is remembered, and Create and open still opens', async () => {
        const { state, outcome } = await openSelectionWith('Idea', {
            executeThrows: ['insertText'], dialogResults: [formResult('openAfter', { title: 'Idea', inThisNote: 'replace' })],
        })
        assert.deepStrictEqual(outcome, { id: outcome.id, opened: true })
        assert.deepStrictEqual(state.timeline, ['execute selectedText', 'POST notes', 'execute insertText', 'setValue lastSelectionAction=replace', 'execute openNote'])
        assert.strictEqual(state.warnings.length, 1)
        assert.ok(state.warnings[0].startsWith('Jot: could not change the highlighted text (insertText)'), state.warnings[0])
        assert.deepStrictEqual(state.messageBoxes, [])
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
        assert.ok(/data-choice="after" role="radio" aria-checked="true" tabindex="0"/.test(again), 'after is still the checked radio')
        assert.ok(/name="inThisNote" id="jotInThisNote" value="after"/.test(again))
        assert.deepStrictEqual(islandOf(again).data.inThisNote, { choices: ['keep', 'replace', 'after'], value: 'after' })
        assert.deepStrictEqual(state.globalReads, ['editor.codeView'], 'the editor is asked once, not on the reopen')
        assert.deepStrictEqual(state.executes.slice(1), [{ name: 'replaceSelection', args: [`Pay rent\nflat\n[Pay rent](:/${outcome.id})`] }])
    })

    // ---------------------------------------------------------------- the pure model
    const FormModel = require(path.join(ROOT, 'src', 'form', 'formModel.js'))
    const SearchTokens = require(path.join(ROOT, 'src', 'form', 'searchTokens.js'))
    const AlarmQuick = require(path.join(ROOT, 'src', 'form', 'alarmQuick.js'))

    await check('formModel.dialogAction: ok creates, openAfter creates and opens, anything else does nothing', () => {
        assert.strictEqual(FormModel.dialogAction({ id: 'ok' }), 'create')
        assert.strictEqual(FormModel.dialogAction({ id: 'openAfter' }), 'createAndOpen')
        for (const result of [{ id: 'cancel' }, { id: 'clear' }, {}, null, undefined]) assert.strictEqual(FormModel.dialogAction(result), 'none')
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
        const empty = FormModel.planCreate(formResult('openAfter', { notebookId: '' }), options)
        assert.deepStrictEqual([empty.kind, empty.open, empty.note], ['create', true, { parent_id: 'fWork', is_todo: 1, title: '', body: '', todo_due: 0 }])
        const note = FormModel.planCreate({ id: 'ok', formData: { jot: { title: 'n', dueDate: 'x' } } }, { ...options, defaultType: 'note' })
        assert.deepStrictEqual([note.kind, note.note.is_todo, note.note.todo_due, note.tags], ['create', 0, 0, []], 'a result without a type reads as the default type')
        const todo = FormModel.planCreate(formResult('ok', { title: 't', tags: 'A,b,a', dueDate: '2026-10-14', dueTime: '10:30' }), options)
        assert.deepStrictEqual([todo.open, todo.tags, todo.note.todo_due], [false, ['a', 'b'], new Date(2026, 9, 14, 10, 30).getTime()])
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
        assert.deepStrictEqual(FormModel.selectionChoices(true), ['keep', 'replace', 'after'])
        assert.deepStrictEqual(FormModel.selectionChoices(false), ['keep', 'replace'])
        assert.strictEqual(FormModel.selectionAction('after', ['keep', 'replace', 'after']), 'after')
        assert.strictEqual(FormModel.selectionAction('after', ['keep', 'replace']), 'keep')
        for (const value of ['', 'bogus', undefined, null]) assert.strictEqual(FormModel.selectionAction(value, ['keep', 'replace', 'after']), 'keep')
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
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't', inThisNote: 'after' }), { ...options, inThisNoteChoices: ['keep', 'replace'] }).inThisNote, 'keep')
        assert.strictEqual(FormModel.planCreate(formResult('ok', { title: 't' }), { ...options, inThisNoteChoices: ['keep', 'replace'] }).inThisNote, 'keep')
        const refused = FormModel.planCreate(formResult('ok', { title: 't', dueTime: '10:00', inThisNote: 'replace' }), { ...options, inThisNoteChoices: ['keep', 'replace'] })
        assert.deepStrictEqual([refused.kind, refused.values.inThisNote], ['invalidDue', 'replace'], 'a refused Create keeps the choice')
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
    await check('dialog files: the five are in dist/form, and form.css keeps the dialog rules (360px column, no @media, lists out of the flow)', () => {
        for (const file of ['form.css', 'alarmQuick.js', 'searchTokens.js', 'formModel.js', 'formWebview.js']) {
            assert.ok(fs.existsSync(path.join(DIST, 'form', file)), `dist/form/${file} exists`)
        }
        const css = read('src/form/form.css').replace(/\/\*[\s\S]*?\*\//g, '')
        assert.ok(!/@media/.test(css), 'no @media rule in the dialog CSS')
        assert.ok(/#joplin-plugin-content\s*\{\s*width:\s*360px;/.test(css), 'one 360px column')
        assert.ok(/#joplin-plugin-content\.jot-mobile\s*\{/.test(css), 'the narrow layout is gated on the jot-mobile class')
        assert.ok(/\.jot-mobile #alarmBody\s*\{\s*flex-direction:\s*column;/.test(css), 'Cockpit\'s stacked picker on mobile')
        assert.ok(/\.jot-suggest\s*\{\s*position:\s*absolute;/.test(css), 'the suggestion lists are absolutely positioned')
        assert.ok(/\.jot-form\s*\{\s*position:\s*relative;/.test(css), 'inside the form')
        assert.ok(!/cockpit-mobile|alarmExplain|alarmMode/.test(css), 'Cockpit\'s names and multi-to-do rows are not carried over')
    })

    await check('dialog glue: Enter in a suggestion list is taken at the target phase (stopPropagation + preventDefault), Escape is the host\'s, globals at call time', () => {
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
        assert.ok(!/(document|window)\.addEventListener\(\s*'keydown'/.test(glue), 'no document- or window-level keydown listener')
        assert.ok(!/addEventListener\([^)]*,\s*true\s*\)/.test(glue), 'no capture-phase listener')
        assert.ok(!/Escape/.test(glue.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'Escape is never handled: the host cancels')
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

    await check('dialog glue: the In this note radios are wired on their group (click, arrow keys wrapping through moveHighlight), write the hidden inThisNote, and fall back to keep', () => {
        const glue = read('src/form/formWebview.js')
        assert.ok(glue.includes("choiceGroup.addEventListener('click', onJotChoiceClick)") && glue.includes("choiceGroup.addEventListener('keydown', onJotChoiceKeyDown)"),
            'the listeners sit on the radiogroup, only when the row is there')
        const keys = glue.slice(glue.indexOf('function onJotChoiceKeyDown'), glue.indexOf('/** Due row'))
        assert.ok(keys.includes('model().moveHighlight(options.length, current, delta)'), 'the arrow keys wrap through the offered buttons')
        assert.ok(keys.includes('event.preventDefault()'), 'an arrow key does not scroll the dialog')
        const setter = glue.slice(glue.indexOf('function setJotInThisNote'), glue.indexOf('function onJotChoiceClick'))
        assert.ok(setter.includes('input.value = value') && setter.includes('model().KEEP'), 'the hidden input carries the choice; an unknown one is keep')
        const css = read('src/form/form.css').replace(/\/\*[\s\S]*?\*\//g, '')
        assert.ok(/\.jot-choice\s*\{[^}]*flex-direction:\s*column;/.test(css), 'the long labels are stacked')
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
        for (const file of ['index.ts', 'core/settings.ts', 'form/form.ts', 'form/formHtml.ts', 'form/formModel.js', 'form/formWebview.js', 'form/editorSelection.ts']) {
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
