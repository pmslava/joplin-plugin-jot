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
