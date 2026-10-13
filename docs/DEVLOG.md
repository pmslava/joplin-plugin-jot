# Development log

Dated release narratives and process notes. Newest last. User-facing changelogs live in GitHub Releases.

## 2026-10-11 — v0.1.0: the first release

Designed and built in one day, from xiaofeng's request in the Cockpit forum thread (post 19) and Slava's decision the same afternoon to make quick capture a plugin of its own rather than a Cockpit feature. The design is `docs/BRIEF-1.0-jot.md`. Five Opus workers built it in phases on top of Cockpit's build configuration, harness shape and e2e launcher and Harper's content-script shape: the scaffold (c70dfa1), the form in create mode with Cockpit's date picker behind a bell (80b672f), the highlighted-text route with the In this note choice (e81455f), the typed `++` trigger as a CodeMirror 6 content script (26fb008), and edit mode with the `jot.open` contract for other plugins (7864d9f). A review pass between them fixed a wrong-row pick in the suggestion lists, a lost notebook filter on a mouse click, Escape closing the whole form, Unicode tag titles and a stuck trigger on a note switch.

Slava's corrections from trying the first build: the notebook field became a combobox that opens on a click, the Due row moved last so the unfolded picker pushes nothing down, and "Replace with a link" became the first and default choice on both the selection and the trigger routes.

Verified at release: 110 harness checks and 23 Playwright cases green in the isolated Joplin 3.6.14 AppImage. Not verified: anything on Android, the Rich Text editor live, the trigger under Gboard.

Process: the first publish of a new npm package cannot go through trusted publishing, so 0.1.0 was published locally with a web login and the OIDC trusted publisher configured right after, as Cockpit's first publish was; `publish.yml` skips a version that is already on the registry, so the release workflow stays green.

## 2026-10-12 — v0.1.1: the first release through trusted publishing

No code change. The README gained five screenshots taken in the e2e app (`e2e/showcase.spec.ts`, `SHOWCASE=1`) and the package's repository URL took npm's normalised form, which the npm page had not seen. The release exists to validate the trusted-publisher entry on npmjs.com, which npm now keeps only if one publish passes through it within two days of its creation; from this release on, a GitHub release publishes by itself.

## 2026-10-12 — v0.1.2: the selection guard

Slava reported that Jot sometimes put him in the new note after a plain Create. The cause is Joplin's, read in the 3.6.14 and 3.7.21 bundles and reproduced in the e2e app: every tag change (a tag created or attached dispatches TAG_UPDATE_ONE, a tag removed NOTE_TAG_REMOVE) makes `BaseApplication.refreshNotes` reload the note list and select a note again, the last one selected in that list, or its first note when the list keeps none. A smart filter such as All notes keeps none, so after a Jot create with a tag the refresh selects the new note, which sorts first. Separately, moving a listed note to another notebook makes the reducer select the note that took its place. Without tags, or in a notebook view, nothing moves, which is why it happened only sometimes.

A plugin cannot stop the refresh, and Joplin has no command that selects a note in place, so `src/form/selectionGuard.ts` holds the selected note and the Markdown editor's view (the content script's new `jot.getView` / `jot.setView` commands) before a tag write or a notebook move, watches the selection for two seconds after it, and when Joplin moved off the note opens it again (`openNote`, which also switches the note list to the note's notebook) and puts the scroll offset, caret and focus back, since Joplin keeps no scroll position per note. The selection route now writes its link before the tags, and the trigger route writes its tags after the answer, so a jump can never carry the edit into the new note. `e2e/selection-guard.spec.ts` shows Joplin jumping on its own and both Jot routes ending on the note being read; with the guard disabled the two Jot cases fail. Harness 117, e2e 26 (plus the on-demand showcase).

The same day, Ctrl+Shift+J sometimes opened Firefox's Browser Console: that is Firefox's own shortcut, pressed while Firefox had the keyboard focus; Jot never receives keys while another application is focused.

## 2026-10-12 — v0.2.0: issues 1 to 3 and a calmer form

Three requests from CJeffyB, who wants to retire Convert Text To New Note and a pair of note templates in Jot's favour. **Issue 1**: the Tags start with the tags of the note you are in (setting on by default). **Issue 2**: a back link to that note, with Copy Note ID's placeholders (`{note_link}`, `{note_title}`, `{note_id}`, `{note_type}`, `{notebook_name}`, `{notebook_path}`, `{notebook_id}`, forgiving names, unknown ones kept), default text `Parent {note_type}: {note_link}`, its own line first (default) or last with an empty line between it and the text; off by default, and the form's Back link row (Add / Don't add) starts on the setting. **Issue 3**: a notebook setting, The current notebook or any existing notebook (an inbox); a plugin's enum options are fixed at registration, but Joplin 3.7.21's `Setting.registerSetting` takes the same key again with new options and keeps the stored value, so the list is registered at startup and again whenever the form reads a changed notebook list.

The form, per Slava: two buttons (Create, Cancel), the old Create and open replaced by an **Open** row (No by default, In editor, New window; a setting `openAfterCreate` replaces `openTarget`), every selector one line of segments (Type, In this note with short labels and the full wording as tooltips, Back link, Open), a 440px column, one control height, a heading with a keyboard hint, and selected segments that change colour but never weight. Reading the form's lists now asks for 100 items a page instead of the data API's default 10, and the form's reads run in parallel.

Harness 125 (26 checks retargeted for the new markup, settings and buttons, each named in the commit; 8 new). E2E 30, including `e2e/requests.spec.ts`, which picks the inbox from the Settings dropdown as a user would; the README screenshots were recaptured with `SHOWCASE=1`.

After Slava's first try, two more fixes went in before the release: Enter with an empty Title keeps the form open and focuses the Title (Joplin's own Enter would have closed it with nothing created), and Enter outside a text input - after a date picked with the mouse, on a segment, with nothing focused - submits through the form's submit event, since Joplin submits on Enter only in a text input. The current note's tags end with a comma and a space. Harness 127, e2e 33.

## 2026-10-13 — unreleased: the form no longer shrinks on Android

Slava saw the form open at the right size on the Pixel and then grow narrower and narrower. Joplin mobile sizes a fit-to-content plugin dialog to its content's measured width, re-measured every 500 ms (`PluginDialogWebView.tsx`, `useDialogSize.ts`), and the webview inside the dialog is the dialog's own width; the mobile rule was `width: calc(100vw - 16px)`, so every measurement took 16px off. The width now comes from the screen, which the dialog cannot change (`jotMobileWidth`: 94% of `screen.width`, 240 to 440px), set in pixels by the mobile switch; the form's CSS has no viewport unit left. Desktop closes the same loop live, so `e2e/mobile-width.spec.ts` reproduces it there: with the old rule the dialog collapses to Joplin's 200px floor, with the fix it holds at 387px for a 412px screen. Harness 128, e2e 34.
