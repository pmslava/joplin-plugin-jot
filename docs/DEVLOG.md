# Development log

Dated release narratives and process notes. Newest last. User-facing changelogs live in GitHub Releases.

## 2026-10-11 — v0.1.0: the first release

Designed and built in one day, from xiaofeng's request in the Cockpit forum thread (post 19) and Slava's decision the same afternoon to make quick capture a plugin of its own rather than a Cockpit feature. The design is `docs/BRIEF-1.0-jot.md`. Five Opus workers built it in phases on top of Cockpit's build configuration, harness shape and e2e launcher and Harper's content-script shape: the scaffold (c70dfa1), the form in create mode with Cockpit's date picker behind a bell (80b672f), the highlighted-text route with the In this note choice (e81455f), the typed `++` trigger as a CodeMirror 6 content script (26fb008), and edit mode with the `jot.open` contract for other plugins (7864d9f). A review pass between them fixed a wrong-row pick in the suggestion lists, a lost notebook filter on a mouse click, Escape closing the whole form, Unicode tag titles and a stuck trigger on a note switch.

Slava's corrections from trying the first build: the notebook field became a combobox that opens on a click, the Due row moved last so the unfolded picker pushes nothing down, and "Replace with a link" became the first and default choice on both the selection and the trigger routes.

Verified at release: 110 harness checks and 23 Playwright cases green in the isolated Joplin 3.6.14 AppImage. Not verified: anything on Android, the Rich Text editor live, the trigger under Gboard.

Process: the first publish of a new npm package cannot go through trusted publishing, so 0.1.0 was published locally with a web login and the OIDC trusted publisher configured right after, as Cockpit's first publish was; `publish.yml` skips a version that is already on the registry, so the release workflow stays green.

## 2026-10-12 — v0.1.1: the first release through trusted publishing

No code change. The README gained five screenshots taken in the e2e app (`e2e/showcase.spec.ts`, `SHOWCASE=1`) and the package's repository URL took npm's normalised form, which the npm page had not seen. The release exists to validate the trusted-publisher entry on npmjs.com, which npm now keeps only if one publish passes through it within two days of its creation; from this release on, a GitHub release publishes by itself.
