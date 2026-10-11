# Jot 1.0: quick capture of a note or to-do without leaving the one you are in (orchestration brief)

Written 2026-10-11 by the managing session, from xiaofeng's request in the Cockpit forum thread (post 19 of "Plugin: Cockpit"), Slava's candidate implementations, and his decision the same day to make this a plugin of its own rather than a Cockpit feature. It is for the session that plans and runs the build, in the shape of Cockpit's `docs/BRIEF-2.7-local-mirror.md`: what the user asked, what exists to build on, the facts (verified and to verify), the design, every user-facing string, the Cockpit side, the phases with their gates, the open questions, and the standing rules. Nothing is built yet; sections 4 to 6 are for Slava's review before any code.

Read these first: this brief; Cockpit's `docs/BRIEF-2.7-local-mirror.md` section 8 (the standing rules, which apply here too) and its `docs/MOBILE.md` §1a (what a plugin dialog can and cannot do on Android); Harper's `src/index.ts` banner "SETTINGS DIALOG" (four load-bearing facts about plugin dialogs); and the Cockpit main Joplin note (`164d64772c624ef99baeb751d4ef8e36`) for the gotchas every plugin of this family shares.

---

## 1. What Jot is

**The need.** While reading or working in one note, record an idea and forget about it: a title, a line or two of text, the notebook, sometimes a tag, and a due date. Joplin's New note and New to-do create an empty note and open it, so the focus is lost, and the way back (Back) lands at the top of the note that was being read. xiaofeng asked Cockpit for "an option not to open the task note after creation", and Slava's own habit is the same: capture, then carry on.

**The answer.** Jot is one small form, opened from wherever the user is, that creates a note or a to-do with its title, text, notebook, tags and due date, and by default does not open it. The form opens five ways:

1. a keyboard shortcut, or Tools › Jot…, on desktop;
2. the editor's right-click menu with text highlighted, on desktop: the first line of the selection becomes the title;
3. a typed trigger (`++` by default, user-defined) in the Markdown editor, on desktop and mobile;
4. a button in the note toolbar, on mobile (and on desktop if wanted);
5. another plugin's call: Cockpit's New note and New to-do buttons on a right-click, and its row menu's Quick edit… (section 6).

The same form, prefilled, edits an existing note's title, type, notebook, tags and due date without opening it (edit mode). The text (body) of an existing note is never shown or written by Jot; it belongs to the editor.

**Why a plugin of its own, not a Cockpit feature** (decided 2026-10-11): the need is independent of any panel; the keyboard route and the typed trigger live in the editor, where Cockpit has no business; on mobile a plugin dialog draws behind a plugin panel, so a form inside Cockpit had to be an in-panel overlay, whereas a form opened from the editor can be an ordinary dialog; and Cockpit stays the size it is. Cockpit only calls Jot, and only on desktop.

**Name and identity.** Plugin name **Jot**; id `io.github.pmslava.jot`; npm package `joplin-plugin-jot` (confirmed free on 2026-10-11); repository `pmslava/joplin-plugin-jot`; MIT. Description: *Quick capture of a note or to-do without leaving the one you are in. A small form for the title, a line or two of text, the notebook, tags and the due date, opened by a shortcut, from highlighted text, or by typing ++ in the editor. The note is created where you say, and you stay where you were.*

**Non-goals for 1.0.** Attachments and templates; the typed trigger in the Rich Text editor (no plugin code runs there); a panel of any kind; editing the body of an existing note; intercepting Joplin's own New note and New to-do buttons (no API for it; the shortcut covers the need, and a user who wants Ctrl+N to mean Jot frees it under Options › Keyboard Shortcuts and binds it).

---

## 2. What exists to build on

**Prior art in the registry (checked 2026-10-11, 369 plugins).** *Convert Text To New Note* (ambrt, 1.5.1, desktop): a toolbar star or a right-click entry takes the first line of the selection as the title and the whole block as the body, replaces the selection with a backlink, copies the tags, and switches to the new note by default. *New Note To Default Folder* (1.1.2): a shortcut creates and opens a note in a fixed notebook. *Quick Note* (1.1.6): opens one designated note. *Quick Links Plus* (0.8.3, desktop and mobile in its manifest): a typed `@@` trigger in the CodeMirror 6 editor, which is the mechanism of Jot's trigger; its README says the Rich Text editor and the old CodeMirror 5 are not supported. Nothing offers a form with notebook, tags and due date, and nothing stays where you were. Jot is "Convert" done properly plus the capture use case.

**In-house code to copy (same author, MIT).** From Cockpit: the build configuration (`webpack.config.js`, `plugin.config.json`, `tsconfig.json`, `api/`), the harness shape (`test/run.js`: numbered checks over pure modules and a stubbed `joplin`), the e2e launcher (`e2e/launch.ts`, with the gnome-keyring isolation of 2026-09-30, memory `e2e-joplin-keyring-hang`), `scripts/setup-e2e.sh`, the CI workflows (`.github/workflows/tests.yml`, `publish.yml` with npm trusted publishing), the whole alarm picker (`src/ui/alarm/alarm.ts` for the markup and its narrow mobile layout, `alarmWebview.js` for the calendar, the time columns and the wiring, the pure `alarmQuick.js` for the quick-button math; Jot ports it as a section of its own form, see 4.2), the date and time validation of `alarm.ts` (`parseAlarmFields`: `YYYY-MM-DD`, `HH:MM` 24-hour; the message text is Jot's own), the comma-separated tag convention and the diff of `setNoteTagsFromCsv` (`src/ui/panel/panel.ts`), the notebook path map (`getNotebookMap` in `src/core/joplin.ts`) and the filter rule (`matchesFilter` in `src/ui/panel/searchTokens.js`), and the notebook-name settings convention (a name, a `Parent/Sub` path or an id typed; resolved by Jot). From Harper: a CodeMirror 6 content script that runs on desktop and mobile from one file (`src/contentScript.ts`, registered once with `ContentScriptType.CodeMirrorPlugin` in `index.ts` near line 2868), the `@codemirror/*` externals block of its `webpack.config.js` (lines 236 to 244; a bundled second CodeMirror breaks the editor, and Cockpit's config has no such block because its content script imports nothing), its guard against mobile mounting the script twice (`contentScript.ts` near line 771, joplin#12891), a dialog driven by `views.panels.onMessage` on both platforms, the note-toolbar button that opens it on mobile (`ToolbarButtonLocation.NoteToolbar`, `index.ts` near line 2349), and the `app_min_version` floor (desktop 3.1, mobile 3.3) that those mechanisms were proven against.

**Joplin API facts the design rests on** (verified in the 3.6.14 bundle during the Cockpit work; memory `joplin-plugin-dialog-facts`):
- A plugin dialog's frame is centred and cannot be positioned; only its size is a lever. Fit-to-content is measured live (a ResizeObserver), so a suggestion list that grows under a field grows and recentres the dialog unless it is absolutely positioned inside a fixed-height box.
- Enter in an `<input type=text>` is a submit by the host's own document-level keydown handler, in the bubble phase, ignoring `defaultPrevented`; the submit resolves the button whose id is `ok` (`findSubmitButton`), and Escape the one whose id is `cancel` (`findDismissButton`). A script that must take Enter itself (a suggestion list) handles it at the target phase with `stopPropagation` and `preventDefault`. Enter in a `<textarea>` is a newline and the host does not touch it.
- `joplin.views.dialogs` has no messaging of its own; `views.panels.onMessage(dialogHandle, cb)` is the way, since a dialog handle and a panel handle are the same controller underneath (Harper's fact 1). `setHtml` does not re-run scripts (Harper's fact 2); `addScript` scripts run in completion order, so cross-script globals are resolved at call time.
- `joplin.commands.execute('openNoteInNewWindow', id)` opens a note in its own window (Cockpit uses it; present in 3.6.14, absent in older apps: `execute` throws).
- A `views.menus.create` item is on the Keyboard Shortcuts screen only when it carries an `accelerator`, and `menus.create` always makes a submenu (Tools › Cockpit › …); `views.menuItems.create(id, command, location, { accelerator })` puts one item straight under the location and always registers the command on the shortcuts screen (memory `joplin-keyboard-shortcut-registration`). `MenuItemLocation.EditorContextMenu` puts a command in the editor's right-click menu and passes it no argument, so the command reads the selection itself.
- A command has one `label` (`api/types.ts`, `Command`): a menu item, a context-menu item and a toolbar button all show the command's label (only a `menus.create` item can override it). Each visible wording therefore needs its own small command.
- `joplin.commands.execute` is typed desktop-only in `api/JoplinCommands.d.ts`, but Harper and Cockpit call it on mobile and it works there.
- `joplin.views.toolbarButtons` only creates; show/hide is a startup gate and applies after a restart (memory `joplin-toolbar-button-restart-constraint`).
- `joplin.*` members are read and called in ONE expression, or the sandbox proxy path corrupts (memory `joplin-sandbox-proxy-rule`).
- The data API: `POST notes` with `parent_id`, `is_todo`, `title`, `body`, `todo_due`; `PUT notes/:id` for any subset; `GET notes/:id/tags`; `POST tags`, `POST tags/:id/notes`, `DELETE tags/:id/notes/:noteId`. A note created with an empty title is shown as "Untitled"; nothing derives a title from the body for a data-API note.

---

## 3. Facts to verify in phase 0 (probes, before any form code)

Each probe is a tiny throwaway command in the scaffolded plugin, run in the e2e app (desktop) and on the Pixel (mobile), and its answer is written back into this section before phase 1 starts.

1. **Focus after the dialog.** With the cursor in the Markdown editor's body, open a dialog from a shortcut, close it with OK: does the caret return to the editor where it was (the HTML `<dialog>` restores the previously focused element)? The same from the Rich Text editor, and with the dialog closed by Enter. If not, Jot runs `focusElementNoteBody` after a create that does not open, from the shortcut route only.
2. **The selection on desktop.** `selectedText`, `replaceSelection` and `insertText` are in the 3.6.14 bundle's editor command declarations. In CodeMirror `selectedText` returns the first selection and `replaceSelection` inserts text; in the Rich Text editor `selectedText` is the selection stripped to plain text, `replaceSelection` sets raw **HTML**, and `insertText` renders Markdown to HTML first. So in the Rich Text editor the link is written as `<a href=":/id">Title</a>` through `replaceSelection`, or as Markdown through `insertText`; the probe settles which, and whether a replace plus an insert can be one undo step there.
3. **Into the content script.** A command registered by the CodeMirror 6 content script (`codeMirrorWrapper.registerCommand('jot.getSelection', ...)`) is callable from the plugin through `joplin.commands.execute('editor.execCommand', { name: 'jot.getSelection' })` and returns a value, on desktop and on mobile. If mobile has it, the toolbar route reads the selection this way; if not, the content script posts the selection with every trigger and the toolbar route on mobile opens the form without a prefill.
4. **Out of the content script.** A content script's `context.postMessage` resolves with what the plugin's `contentScripts.onMessage` handler returns (documented in `api/types.ts`; Harper's `contentScript.ts` line 782 relies on it), after an `await` of a dialog open that may last minutes: the desktop IPC holds a reply with no timeout (Harper's `index.ts` near line 885); **mobile is unverified** and is the point of this probe.
5. **The dialog on the Pixel.** Opened from the note-toolbar button while the editor is up: it draws over the editor (Harper's settings dialog does); the software keyboard does not cover the title field; Enter on the keyboard submits; a `<textarea>` scrolls inside the dialog; with the picker unfolded behind the bell the dialog scrolls and the calendar days are tappable.
6. **The trigger through Gboard.** `++` typed with autocorrect and with composition (`isComposing`), and pasted: the trigger must fire once on a typed `++`, never on a paste, and never twice.
7. **`openNoteInNewWindow`'s floor:** the first Joplin version with the command (the Cockpit note may already record it), for the setting's description.
8. **Mobile editor commands:** whether `selectedText` / `replaceSelection` exist on mobile at all (3.3+). If they do, the content script is only needed for the trigger.

---

## 4. The design (for Slava's review before any code)

### 4.1 One form, two modes, both platforms

The form is a plugin dialog on both platforms (`joplin.views.dialogs`), two handles created lazily on first use (create mode and edit mode have different buttons, and buttons are set per handle), one markup builder, one script, one stylesheet. Everything that decides something is in one pure module, `src/form/formModel.js`, `require`d by the harness: the field model, the empty-title rule, the title/text split of a selection, the date and time validation, the "what changed" diff of edit mode, the notebook default order, and the link text. The DOM glue is thin.

**Create mode** shows, in this order (Tab order is DOM order; the Title is focused on open, so Shift+Tab reaches the Type toggle): **Type** (To-do | Note), **Title**, **Text** (a `<textarea>`, three lines, the first lines of the body), **Notebook**, **Tags**, **Due** (to-do only: the date and time beside a bell that unfolds the picker), and, when the form was opened from a selection or from the trigger, **In this note** (section 4.4). Buttons: **Create** (id `ok`, so Enter in the Title creates), **Create and open**, **Cancel**. Heading: "New to-do" or "New note".

**Edit mode** shows Type, Title, Notebook, Tags and Due, prefilled; no Text, no In this note. Buttons: **Save** (id `ok`), **Cancel**. Heading: "Edit to-do" or "Edit note".

### 4.2 The fields

- **Type.** Two buttons that act as radios. Preselected by the route: the default-type setting (shortcut, trigger, toolbar, selection), the caller's argument (Cockpit's buttons), or the note (edit). Switching to Note greys the Due row and clears nothing until Create or Save. An edit that switches the type writes `is_todo` and clears `todo_due` and `todo_completed` in **both** directions, as Joplin's own `changeNoteType` does (verified in the bundle; Cockpit's own toggle writes only `is_todo`, which Jot does not copy); a switch to to-do then applies the Due field on top.
- **Title.** One line. Enter creates.
- **Text** (create only). Plain Markdown, becomes the body as typed. **The empty-title rule:** an empty Title with Text takes the first non-empty line of the Text as the title and removes it from the body (what typing into a fresh Joplin note does). Empty Title and empty Text: **Create** creates nothing and closes; **Create and open** creates the empty note and opens it (Joplin's own New note, one step later).
- **Notebook.** A text input showing the notebook's path, with a suggestion list under it filtered as you type (Cockpit's `matchesFilter`), the list absolutely positioned in a fixed-height box so the dialog never resizes, arrow keys and Enter picking a row (Enter handled at the target phase). Jot has no excluded-notebooks list; every notebook is offered. **The default is the current notebook:** the notebook of the note the editor holds (`joplin.workspace.selectedNote()`), or, with no note open, the notebook the app is showing (`selectedFolder()`); a caller's `notebookId` (Cockpit's filtered notebook) wins when given. There is no default-notebook setting. Edit mode starts on the note's own notebook. With no notebook at all (an empty collection) the form refuses to open with a message.
- **Tags.** One comma-separated input, with the same suggestion list for the token being typed, from `GET tags`. Lower-cased and de-duplicated on commit; missing tags are created; in edit mode a diff attaches and detaches only what changed.
- **Due.** One row showing the date and time (`2026-10-14 09:00`) or **No date**, with a **bell** button beside it and a **No date** link. The bell unfolds, inside the same dialog below the row, Cockpit's date picker ported whole: the `YYYY-MM-DD` and `HH:MM` inputs with their validation, the Monday-first calendar, the time columns and the two rows of quick buttons (Today, Tomorrow, Weekends, Next Monday; +hour, +day, +week, +month by weekday, +month by date), in Cockpit's desktop and narrow mobile layouts. The picker has no buttons of its own (Cockpit's OK, Clear alarm and Cancel are dialog buttons, and the form's are taken): every pick writes into the Due row at once, a second press on the bell folds the picker, and No date clears the row (open question 9). A date picked before a time starts at the day-start setting (09:00 by default, the same setting Cockpit has, registered by Jot too), as Cockpit's picker starts. The dialog grows while the picker is open (fit-to-content is live) and scrolls on a phone (probe 5). Greyed when Type is Note.

### 4.3 After Create

**Create** writes the note (`POST notes`), attaches the tags, applies the In-this-note choice if any, closes, and opens nothing. The editor keeps its note and (probe 1) its caret. **Create and open** does the same and then opens the note where the open-target setting says: in the editor (default) or in a new window (desktop; on mobile, and on an app without the command, in the editor). Cancel writes nothing.

### 4.4 Where the form comes from

- **The commands.** One function, `openForm(route, presets)`, behind three thin commands, because every visible wording needs a command of its own: `jot.open` labelled **Jot…** (the menu, the shortcut, and the entry point for other plugins, section 6), `jot.fromSelection` labelled **Jot from the selection…** (the editor's right-click menu), and `jot.button` labelled **Jot** (the toolbar button, which shows the command's label as its tooltip).
- **The shortcut and the menu (desktop).** `views.menuItems.create('jot.open.menu', 'jot.open', MenuItemLocation.Tools, { accelerator: 'Ctrl+Shift+J' })`: one item, Tools › Jot…, no submenu, registered on the Keyboard Shortcuts screen and rebindable; the chord is open question 3. It opens the form with the default type and the current notebook. With text highlighted in the editor it behaves as the selection route below, so one chord serves both.
- **The selection (desktop).** `jot.fromSelection` in `MenuItemLocation.EditorContextMenu`. The command gets no argument from the menu, so it reads the selection with `selectedText` (probe 2); the first line becomes the Title and the rest the Text (open question 1). The **In this note** control offers what to do with the highlighted text: **Keep it** (default), **Replace it with a link to the new note**, **Add a link after it**. The link is Joplin's own `[Title](:/id)` in the Markdown editor and the HTML form of it in the Rich Text editor (probe 2). The last choice is remembered (a hidden per-device setting).
- **The typed trigger (desktop and mobile, Markdown editor).** A CodeMirror 6 content script (Harper's shape: one file for both platforms, the `@codemirror/*` externals, the double-mount guard so a trigger never fires twice on mobile) watches document changes through an update listener, reading each change's inserted text and its user-event annotation (typed input, not paste or undo), which Harper does not do and is new ground; when a typed insertion completes the trigger string **at the start of a line or after whitespace** (so `C++` and `i++` never fire), it posts `{ route: 'trigger', from, to }` and awaits the answer; the plugin opens the form; the answer says what to do and the content script applies it as one transaction, so one Undo restores the text. **In this note** here offers **Remove ++** (default) or **Replace ++ with a link to the new note**; the trigger string is printed in the labels. **Cancel leaves what was typed and does not ask again for that occurrence** (the script remembers the position until the document changes there), so a line that genuinely starts with `++` can be typed once. Paste never fires; composition (probe 6) fires once. The trigger string is a setting; empty turns the route off; the content script asks the plugin for it when it loads, after every fire and whenever the editor gets another document, and on desktop leaving the Options screen rebuilds the editor, so a change applies as soon as the settings are left (verified in `e2e/trigger.spec.ts`).
- **The toolbar button (mobile; desktop optional).** `ToolbarButtonLocation.NoteToolbar` on `jot.button`, whose label **Jot** is the button's text and tooltip. On mobile this and the trigger are the only routes; the form is a dialog over the editor (probe 5). With a selection (probe 3 or 8) it is the selection route; without one, a plain create.
- **Another plugin (desktop).** `jot.open` with arguments, section 6.

### 4.5 Edit mode

Opened only by another plugin for now (Cockpit's Quick edit…, section 6), with a note id. Prefilled from `GET notes/:id` (title, is_todo, parent_id, todo_due) and `GET notes/:id/tags`. **Save writes only what changed:** one `PUT notes/:id` with the changed subset of title, parent_id, is_todo (with the clears of 4.2), todo_due (0 to clear); the tag diff. An unchanged form writes nothing, so Save on it creates no revision. The body and the completion are never read or written. A note open in the editor can be edited this way (Joplin reloads the editor's copy on the change; verify a title change while the editor has unsaved edits of its own).

### 4.6 Settings (Settings › Plugins › Jot)

| key | label | default | description |
|---|---|---|---|
| `defaultType` | What Jot creates | A to-do | *Whether the form opens as a to-do or a note. You can switch in the form.* Options: A to-do, A note. |
| `openTarget` | Create and open opens the note | In the editor | *In the editor, or in a new window on desktop. Create (without "and open") never opens anything.* Options: In the editor, In a new window. |
| `trigger` | Typed trigger | `++` | *Typing this at the start of a line or after a space opens Jot, in the Markdown editor on desktop and mobile. Leave empty to turn it off. A change applies as soon as you leave the settings.* |
| `dayStartTime` | Day start time (HH:MM) | 09:00 | *The time a to-do gets when its date is picked before its time, as in Cockpit's picker.* |
| `showToolbarButton` | Show the Jot button in the note toolbar | on | *The button opens the form; on mobile it and the typed trigger are the ways in. Takes effect after Joplin restarts, since Joplin cannot add or remove a toolbar button while running.* |
| hidden | `lastSelectionAction`, `lastTriggerAction` | | per device, written by the form |

The keyboard shortcut is not a setting; it is changed under Options › Keyboard Shortcuts, where the command is listed because the menu item carries an accelerator.

---

## 5. Every user-facing string (right English, in one place)

- Plugin: **Jot**. Description as in section 1.
- Commands and their labels, which are also what the menu, the context menu, the toolbar button and the command palette show: `jot.open` **Jot…** (Tools › Jot…); `jot.fromSelection` **Jot from the selection…** (the editor's right-click menu); `jot.button` **Jot** (the note-toolbar button).
- Headings: **New to-do**, **New note**, **Edit to-do**, **Edit note**.
- Fields: **Type** (To-do, Note), **Title**, **Text**, **Notebook**, **Tags**, **Due** with its bell (tooltip *Pick a date and time*) and **No date**. Inside the picker, Cockpit's own labels unchanged (Today, Tomorrow, Weekends, Next Monday and the accumulating row).
- In this note (selection): **Keep the text**, **Replace it with a link to the new note**, **Add a link after it**. In this note (trigger, with the trigger printed): **Remove ++**, **Replace ++ with a link to the new note**.
- Buttons: **Create**, **Create and open**, **Cancel**; **Save**, **Cancel**.
- Messages (Jot's own wording; the alarm picker's says "24 hour"): *Jot: the date must be YYYY-MM-DD and the time HH:MM (24-hour).* / *Jot: there is no notebook to create in.* / *Jot: this note no longer exists.*
- Settings: the table of 4.6.
- README title line: *Jot: quick capture of a note or to-do without leaving the one you are in.*

---

## 6. The Cockpit side (desktop only; its own brief in the Cockpit repository, `docs/BRIEF-2.8-jot-integration.md`)

**The contract.** `joplin.commands.execute('jot.open', args)`:
- `{ mode: 'new', type: 'todo' | 'note', title?: string, body?: string, notebookId?: string }` opens create mode with those presets; resolves `{ id, opened: boolean }`, or `null` on Cancel.
- `{ mode: 'edit', noteId }` opens edit mode; resolves `{ id, changed: string[] }` (the fields written), or `null`.
- No arguments: the shortcut behaviour.
The command exists from 1.0.0 and its shape is kept; a caller on an app without Jot gets the "command not found" throw and tells the user once.

**What Cockpit 2.8 does with it.** Two per-device enum settings, "New note and New to-do: click" (default *Create and open in the editor*, today's behaviour) and "New note and New to-do: right-click" (default *Jot*), each with the values *Create and open in the editor*, *Create and open in a new window*, *Jot*. A row-menu entry **Quick edit…** (single-only, greyed in a multi-selection) calling edit mode with the row's id. After `jot.open` resolves with an id, Cockpit drains its change feed at once so the row appears or updates without waiting for the poll. When the command throws "not found", a message box names the Jot plugin once per session and the click falls back to today's create-and-open. Nothing changes on mobile: Cockpit's long press, overlays and create path stay as they are, and the typed trigger is the mobile route into Jot.

---

## 7. Phases and gates

Each phase is one worker, Opus-class, in the project directory (a worktree once there is a main to branch from), finishing with the harness green and a local commit on a branch; the managing session reviews and merges locally, never pushes without Slava's approval, and never publishes without his explicit go for that release (memory `publish-requires-per-release-approval`). Reviewer reports in plain text. One e2e run machine-wide (`pgrep -f e2e-cache` first), about 4 GB free; the e2e lock is shared with Cockpit, Ridgeline and Harper. `npm install` under `~/Lab` is synced by MEGA including `node_modules` (memory `mega-syncs-lab-including-node-modules`): install once, do not churn it.

**Phase 0 — scaffold and probes.** The repository skeleton copied from Cockpit (build config with Harper's `@codemirror/*` externals block added, `api/`, harness shape, e2e launcher with the keyring isolation, `setup-e2e.sh`, the two workflows, `.gitignore`, LICENSE), the manifest (id, name, description, `app_min_version` 3.1, `app_min_version_mobile` 3.3, platforms desktop and mobile, version 1.0.0), an `index.ts` that registers nothing but the probes, a first `npm run dist`, and the eight probes of section 3 run in the e2e app, with the Pixel ones handed to Slava as a checklist. Gate: the build produces a `.jpl`; section 3 updated with the answers; the harness runs with one check (the version quadruple).

**Phase 1 — the form, create mode, the shortcut route.** `formModel.js` and its checks (every rule of 4.2, the current-notebook default); the alarm picker ported whole as a folded section behind the bell, with Cockpit's pure modules copied unchanged; the dialog, its script and stylesheet; the three commands behind one `openForm`; the `menuItems.create` item with its accelerator; settings `defaultType`, `openTarget`, `dayStartTime`; the data writes. Gate: harness checks over the module and over the host handler with a stubbed `joplin` (the POST payload, the tags, no open on Create, the open on Create and open, the empty rule both ways); an e2e spec `shortcut.spec.ts`: the chord opens the form with the editor's note untouched after Create, Enter in the Title creates, a suggestion list's Enter does not submit, Create and open opens.

**Phase 2 — the selection route and In this note.** The context-menu item; `selectedText`, `replaceSelection`, `insertText` as probe 2 decided; the title/text split; the three choices and their memory; the link text. Gate: harness checks over the split and the link; an e2e spec in the Markdown editor (keep, replace, add); the Rich Text editor checked live by Slava.

**Phase 3 — the typed trigger.** The content script (desktop and mobile from one file, as Harper's, with its double-mount guard), the update listener and the user-event test, the trigger rule, the request-response with the plugin, the one-transaction edit, the cancel memory, the setting and its re-read. Gate: harness checks over the trigger rule as a pure function (line start, after whitespace, inside a word, paste, composition); an e2e spec typing the trigger in the Markdown editor; Slava's Pixel round (probe 6's cases, the keyboard, the dialog over the editor).

**Phase 4 — edit mode and the command contract.** The second handle, the prefill, the diff-only Save, the clears on a type switch, `jot.open` with arguments and its return values. Gate: harness checks that an unchanged Save makes no call and each changed field makes exactly its write; an e2e spec calling the command from a test plugin or the launcher's command route (as Cockpit's e2e runs commands) and checking the note.

**Phase 5 — docs and the first release.** README (sections: what it does, the five ways in, the form, edit mode, settings, on Android, for other plugins, build from source, credits: Convert Text To New Note and the request that started it); `docs/DEVLOG.md`; the version quadruple; CI green on the SHA; the release on Slava's go (memory `cockpit-release-procedure`, with `--repo pmslava/joplin-plugin-jot`); the forum thread post and the reply to xiaofeng (appendix), posted by Slava; then the Cockpit 2.8 integration from its own brief.

---

## 8. Open questions for Slava

1. **The selection split.** Proposed: the first line becomes the Title and the remaining lines the Text (Convert puts the whole block in the body as well). Alternative: the whole selection in the Text and the first line also as the Title.
2. **The current note's tags.** Convert copies them to the new note. Proposed: not copied; the Tags field is right there and prefilled tags are a surprise. Could be a setting later.
3. **The default chord.** `Ctrl+Shift+J` (J for Jot; the only known taker is Jarvis, a plugin, and Joplin's keymap screen lets the user resolve a clash). Alternatives from the 2026-09-11 survey, free in Joplin and the plugins checked: `Ctrl+Shift+K`, `F9`, `F12`.
4. **Create and open's target** as a setting (proposed) rather than a third button in the form.
5. **Cancel on the trigger** leaves `++` and does not ask again for it (proposed), rather than removing it.
6. **The toolbar button on desktop too** (proposed: shown on both, one setting), or mobile only.
7. **"Text"** as the field name for the body (proposed), or "Body", or "Note".
8. **The dialog's width**: one narrow column that fits a phone (about 360 px) on both platforms (proposed), with the unfolded picker in Cockpit's narrow layout, or a wider desktop layout with the picker's desktop layout beside the fields.
9. **The picker's buttons.** Proposed: none of its own; every pick writes into the Due row at once, the bell folds it, No date clears it. Alternative: an Apply button, so browsing the calendar does not change the row until confirmed.

---

## 9. Standing rules (they apply to every worker prompt)

- `joplin.*` members are read and called in ONE expression (memory `joplin-sandbox-proxy-rule`); the harness audits the sites as Cockpit's does.
- The dialog facts of section 2 bind the form: all fields in the initial markup, pixel caps, no `@media` in dialog CSS, suggestion lists that never change the dialog's size, Enter handled at the target phase, Escape with `stopPropagation` and `preventDefault` when the script takes it, globals resolved at call time, messaging through `views.panels.onMessage`, `setHtml` never re-run for behaviour.
- Mobile: never a `draggable` element in the dialog; the content script never starts a native drag (memory `android-native-drag-gotcha`); every mobile claim is checked on the Pixel, not assumed (Cockpit's `MOBILE.md` §7 discipline).
- Cockpit's 2.7 brief section 8 holds: plain-text reviewer reports, no `#` suffix in commit subjects, one warm worktree per arc, a worker's report names the new commit hash.
- Toolbar buttons and menus are registered at startup only; a show/hide setting is a startup gate with a restart notice in its description.
- Build and install to `~/.config/joplin-desktop/plugins/` are the worker's; the restart and the live check are Slava's. Commit locally after review; push only after testing and Slava's approval; publish only on his explicit go for that release. Issue and forum replies are posted by Slava, or by the manager only with his approved text.

---

## Appendix: the reply to xiaofeng (for Slava to post in the Cockpit thread)

> Thank you, that is exactly the kind of request that shapes what comes next. You are right that opening the new note is the problem: it takes the focus away from the note you were reading, and Back puts you at its top.
>
> I am making this a small plugin of its own, called Jot, so it works with or without Cockpit: one form for the title, a line or two of text, the notebook, tags and the due date, which creates the note without opening it, so you stay where you are. It opens from a keyboard shortcut, from highlighted text in the editor, or by typing `++` in the editor, on desktop and on Android. The same form, prefilled, edits an existing note's title, tags and due date without opening it.
>
> Cockpit will then call it: a right-click on New note or New to-do opens the form (a click keeps working as it does now), and the row menu gets a "Quick edit…" entry. I will post here when Jot is in the plugin list.
