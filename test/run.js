// Jot harness (phase 0).
//
// Runner and assertion frame follow joplin-plugin-cockpit's test/run.js: a tiny homemade runner over
// Node's assert, a failures counter, a final "All checks passed" / "N failing check(s)" line, and
// process.exit(failures ? 1 : 0). Checks are numbered in the order they run, so a failure report can
// name one by its number. `npm test` builds first (npm run dist), so dist/ and publish/ are fresh here.
//
// What is checked: the version quadruple, the manifest's identity, the build's outputs (the .jpl and
// the content script kept free of a bundled CodeMirror), the compiled bundle driven against a stubbed
// `joplin` on desktop and mobile, and the sandbox proxy rule over every source file.

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
// with a stub in its place. The stub records what onStart registers; `menuItemsThrow` makes
// views.menuItems.create reject, as an app without menus would.
function makeJoplin(options) {
    const state = { onStart: null, commands: [], menuItems: [], messageBoxes: [], warnings: [] }
    const joplin = {
        plugins: { register: async (plugin) => { state.onStart = plugin.onStart } },
        versionInfo: async () => options.versionInfo,
        require: () => { throw new Error('Unable to require module in the harness.') },
        commands: {
            register: async (command) => { state.commands.push(command) },
            execute: async () => undefined,
        },
        views: {
            dialogs: { showMessageBox: async (message) => { state.messageBoxes.push(message); return 0 } },
            menuItems: {
                create: async (id, commandName, location, options2) => {
                    if (options.menuItemsThrow) throw new Error('menus are not available')
                    state.menuItems.push({ id, commandName, location, options: options2 })
                },
            },
        },
    }
    return { joplin, state }
}

async function runBundle(options) {
    const { joplin, state } = makeJoplin(options)
    global.joplin = joplin
    const bundlePath = path.join(DIST, 'index.js')
    delete require.cache[require.resolve(bundlePath)]
    const realWarn = console.warn
    console.warn = (...args) => { state.warnings.push(args.map(String).join(' ')) }
    try {
        require(bundlePath)
        if (!state.onStart) throw new Error('the plugin did not register an onStart handler')
        await state.onStart({})
    } finally {
        console.warn = realWarn
    }
    return state
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
    const desktop = await runBundle({ versionInfo: { version: '3.6.14', platform: 'desktop' } })

    await check('desktop: onStart registers jot.open, labelled Jot…', () => {
        assert.deepStrictEqual(desktop.commands.map(command => command.name), ['jot.open'])
        assert.strictEqual(desktop.commands[0].label, 'Jot…')
    })

    await check('desktop: Tools > Jot… is one menu item with the Ctrl+Shift+J accelerator', () => {
        assert.deepStrictEqual(desktop.menuItems, [
            { id: 'jot.open.menu', commandName: 'jot.open', location: 'tools', options: { accelerator: 'Ctrl+Shift+J' } },
        ])
        assert.deepStrictEqual(desktop.warnings, [])
    })

    await check('desktop: the placeholder command shows its message box', async () => {
        await desktop.commands[0].execute()
        assert.deepStrictEqual(desktop.messageBoxes, ['Jot 0.1.0: the form comes next.'])
    })

    const mobile = await runBundle({ versionInfo: { version: '3.6.0', platform: 'mobile' } })

    await check('mobile: the command is registered and no menu item is made', () => {
        assert.deepStrictEqual(mobile.commands.map(command => command.name), ['jot.open'])
        assert.deepStrictEqual(mobile.menuItems, [])
        assert.deepStrictEqual(mobile.warnings, [])
    })

    const refused = await runBundle({ versionInfo: { version: '3.6.14', platform: 'desktop' }, menuItemsThrow: true })

    await check('an app that refuses the menu item still starts the plugin, with one console warning', () => {
        assert.deepStrictEqual(refused.commands.map(command => command.name), ['jot.open'])
        assert.strictEqual(refused.warnings.length, 1)
        assert.ok(refused.warnings[0].startsWith('Jot: could not add Tools > Jot…'), refused.warnings[0])
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
