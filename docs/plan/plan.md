# Sims helper: build plan

Goal: Lila's Sims 4 keeps crashing on her Windows PC. She has many packs and mods, most from CurseForge. Tyler sends
her one `.exe` installer. The app finds her game files and explains in plain words what is likely wrong. Each fix is
one click, takes a backup first, and can be undone. The app also walks her through the 50/50 mod test. It carries a
note from Tyler.

Research: [`docs/research/`](../research/). Fable covered files, logs and safety. Neon covered CurseForge, existing
tools and the stack. Sol covered crash causes and rules. Grok covered posts on X.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Platform | Windows 10 and 11, x64 | Her PC. |
| Stack | Electron, TypeScript, React with Vite, Vitest, Playwright for Electron | One language from the package reader to the UI. Chromium renders the same on the Mac and on Windows. Neon's report, section 5. |
| Installer | electron-builder NSIS, **assisted** wizard (`oneClick: false`), unsigned | Tyler asked for a wizard. The NSIS default is one-click, which has no pages for a finish-page note. |
| Build machine | GitHub Actions `windows-latest` | Builds the `.exe` and runs every test on real Windows. Tyler works on a Mac. |
| Delivery | A Google Drive link to the `.exe` | Gmail blocks `.exe` attachments, zipped ones too. The repo is private, so she cannot use a GitHub release link. |
| Beside PlumbBuddy, not a fork | Own app | PlumbBuddy (MIT, C#) has no crash-log explainer, no CurseForge awareness and no guided 50/50. We borrow its rules and cite it. |
| Package reader | Our own DBPF index reader, about 60 lines, written from the spec | We need only resource keys. Fable and Neon disagree on whether `@s4tk/models` is maintained. |
| CurseForge API | Not in v1 | The key cannot ship inside an `.exe`, and the terms forbid saving API data to disk. Neon's report, section 3. |
| Saves and Tray | Never written, by any code path | EA and CurseForge both document ways to lose them. Fable's report, section 6. |

## The core data shapes

PR 3 defines these types in `src/shared/model.ts`. Every later PR builds on them.

```ts
type SimsFolder = { path: string; inOneDrive: boolean; newestFileAt: Date }   // only folders holding Options.ini; date from game-written files, not Mods
type GameInstall = { path: string; version: string; packs: PackCode[] }   // PackCode: "EP01", "GP02", "SP18"
type ModFile = { relPath: string; kind: "package" | "script" | "archive" | "other"; bytes: number; sha256: string;
	depth: number; dbpf?: { major: number; minor: number; keys: ResourceKey[] } | { error: string } }
type ModGroup = { id: string; label: string; files: string[]; source: "curseforge" | "folder" | "loose" }
type LogReport = { file: string; kind: "exception" | "uiException" | "crash" | "betterExceptions" | "mccc";
	at: Date; gameVersion?: string; categoryId?: string; frames: string[]; modHints: string[] }
type Finding = { rule: RuleId; severity: "stop" | "warn" | "info"; title: string; detail: string;
	evidence: string[]; fixes: FixId[] }
type JournalEntry = { id: string; at: Date; action: FixId; moves: { from: string; to: string; sha256: string }[];
	backupId: string; undoneAt?: Date }
type FiftyFifty = { round: number; suspects: string[]; cleared: string[]; parked: string[]; awaiting: "test" | "answer" }
```

`Finding.title` and `Finding.detail` are the words she reads. Every rule writes them for a player, not a developer.

## Landing order and dependencies

| PR | Change | Depends on | Builder | Files it may touch |
|---|---|---|---|---|
| 1 | Scaffold, Windows CI, installer wizard, dedication | none | Neon | everything at the root, `src/`, `.github/`, `build/`, `AGENTS.md` |
| 2 | Fixture generator | 1 | Neon | `scripts/fixtures/`, `test/fixtures/` |
| 3 | Find her Sims folder and game install (read-only) | 1, 2 | Neon | `src/shared/model.ts`, `src/main/locate/` |
| 4 | Mods inventory and package reader (read-only) | 3 | Neon | `src/main/inventory/` |
| 5 | Crash and exception log readers | 3 | Neon | `src/main/logs/` |
| 6 | Rules and findings v1 | 4, 5 | Neon | `src/main/rules/`, `src/shared/copy/` |
| 7 | Read-only app screens and the "send to Tyler" report | 6 | Neon | `src/renderer/`, `src/main/report/` |
| G1 | **Gate:** Tyler runs build 7 on her PC | 7 | Tyler | none |
| 8 | Write gate | 7 | **Fable** | `src/main/safety/gate.ts` and its test |
| 9 | Backup, journal and undo | 8, G1 | Neon, from a Fable brief | `src/main/safety/` except `gate.ts` |
| 10 | One-click fixes | 9 | Neon | `src/main/fixes/`, `src/renderer/fixes/` |
| 11 | Guided 50/50 test | 10 | Neon | `src/main/fiftyfifty/`, `src/renderer/fiftyfifty/` |
| 12 | Optional: "Ask for help" with AI | 7, G1 | Neon; **Fable** writes `key-store.ts` | `src/main/assist/`, `src/renderer/assist/` |

PRs 4 and 5 are independent and can run at the same time. PR 8 can start once 7 lands. Every other PR waits for
the one above it.

The **review-gated set** is PRs 1, 7, 10 and 11. Each one changes what she sees or clicks. Tyler looks at the
screens before each one merges.

Neon builds every PR except PR 8. Opus reviews each PR, then Fable does the last check. Whoever finds an issue fixes
it. Sol does one light review per finished stage. Neon builds by Tyler's choice, so the
`feature` line in the pstack model sheet (Opus) is overridden.

## Today, before any code

Her game crashes now, and the app is weeks away. Two things can help this week.

1. Ask her for these files from `Documents\Electronic Arts\The Sims 4`: every `lastException*.txt`,
   `lastUIException*.txt` and `lastCrash*.txt` file, `Options.ini`, `GameVersion.txt`, any `BE-ExceptionReport.html`,
   and a screenshot of the `Mods` folder. A hand reading often names the mod. Her files also become the first real
   test fixtures.
2. Tell her one rule now. After a game update, the game turns mods off. Saving in that state can remove modded items
   from her save. If mods are off, she should exit without saving.

---

## PR 1: Scaffold, Windows CI, installer wizard and dedication

- [ ] Depends on: nothing.
- [ ] Files: `package.json`, `electron-builder.yml`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`,
  `tsconfig*.json`, `src/main/index.ts`, `src/preload/`, `src/renderer/` (an empty shell and the About screen),
  `build/installer.nsh`, `.github/workflows/ci.yml`, `AGENTS.md`.
- [ ] Change:
  - Electron with Vite, React and TypeScript.
  - `vitest.config.ts` sets `maxWorkers: 2`, and `playwright.config.ts` sets `workers: 1`.
  - electron-builder `nsis` with `oneClick: false`, `allowToChangeInstallationDirectory: true`, a Start menu entry
    and a desktop shortcut.
  - `build/installer.nsh` sets the finish page text to "Made for Lila, with love from Tyler 💚".
  - The About screen says "Built by Tyler, for Lila."
  - CI on `windows-latest` runs typecheck, unit tests and Playwright, then uploads `Sims Helper Setup <version>.exe`
    as an artifact.
  - `AGENTS.md` gets the real commands for one test file, the full check and the installer build.
- [ ] Result you see: a CI run on the PR shows green and an `.exe` artifact.
- [ ] Unit: a Vitest test renders the About screen and finds the dedication.
- [ ] Live: CI installs the built `.exe` silently on the Windows runner (`/S`), launches the installed app with
  Playwright, and reads the About text. Pass means the window opens and the text matches. Tyler runs the wizard once
  on a Windows machine and sees the finish page note.
- [ ] Perf: installer size. The probe is the artifact's byte count. A run fails if the installer is over 200 MB.
- [ ] Tyler approves the dedication wording and the window before merge.

## PR 2: Fixture generator

- [ ] Depends on: PR 1.
- [ ] Files: `scripts/fixtures/make-fixture.ts`, `scripts/fixtures/specs/*.json`, `test/fixtures/` (generated; the
  specs are committed, and the output is rebuilt in CI).
- [ ] Change: a script that builds a fake `The Sims 4` user folder and game install from a JSON spec. It writes
  valid DBPF 2.1 packages with chosen resource keys, broken packages (bad magic, cut-off index), Sims 3 packages
  (version 2.0), `.ts4script` zips holding named `.pyc` entries, `.zip` archives, `Resource.cfg`, `Options.ini`
  variants, `lastException` and `lastCrash` files in the formats from Fable's report, section 3, and a sample
  CurseForge `AddonGameInstance.json`. Specs: `clean`, `patch-day` (mods off), `nested-scripts`, `duplicates`,
  `broken-packages`, `onedrive`, `exceptions`, and `big` (5,000 packages, 300 scripts).
- [ ] Result you see: `npm run fixtures` builds every spec into `test/fixtures/<spec>/`.
- [ ] Unit: building the same spec twice gives byte-identical output. Each generated package passes the DBPF sanity
  checks in Fable's report, section 4.
- [ ] Live: a fixture package opens in Sims 4 Studio or s4pe and lists the keys the spec named (Tyler, once).
- [ ] Perf: none.

## PR 3: Find her Sims folder and game install

- [ ] Depends on: PRs 1 and 2.
- [ ] Files: `src/shared/model.ts`, `src/main/locate/*.ts` and tests.
- [ ] Change:
  - Finds every candidate user folder. It looks under `app.getPath('documents')`, under both OneDrive Documents paths
    and in every localized folder name. A candidate counts when it holds `Options.ini`.
  - For each candidate it reports `inOneDrive` and the newest date of the files the game writes (`Options.ini`, logs,
    `saves/`). `Mods/` does not count, because CurseForge can install into a stale folder.
  - Finds the game from the registry value `Install Dir` (`HKLM\SOFTWARE\WOW6432Node\Maxis\The Sims 4`), then from the
    EA app, Steam and Origin default paths.
  - Reads the version from the file version of `Game\Bin\TS4_x64.exe`, and from `GameVersion.txt` as a fallback.
  - Lists pack folders that match `^[EGSF]P\d{2,}$`.
  - Detects the running game from the processes `TS4_x64`, `TS4_x64_fpb` and `TS4_DX9_x64`.
- [ ] Result you see: a debug command prints the `SimsFolder[]` and `GameInstall` for a fixture.
- [ ] Unit: each fixture spec gives the expected candidates. Two candidates are both returned, with dates. The
  French folder name with no-break spaces is found.
- [ ] Live: on a real Windows machine with the game installed, the command finds the real folder, version and packs.
  **Unproven until G1** if Tyler has no Windows machine.
- [ ] Perf: none.

## PR 4: Mods inventory and package reader

- [ ] Depends on: PR 3.
- [ ] Files: `src/main/inventory/*.ts` and tests.
- [ ] Change:
  - Walks `Mods/` and sorts each file into a `kind`. Computes each file's depth and SHA-256.
  - Reads the DBPF header and index of each package into `ResourceKey[]`, or records the parse error.
  - Lists the entries of each `.ts4script` zip.
  - Groups files into `ModGroup`s: by CurseForge record when one is present, else by top-level folder, else one
    group per loose file.
  - Reads files shared and read-only, so a scan is safe while the game runs.
- [ ] Result you see: an inventory of every fixture.
- [ ] Unit: per fixture, expected kinds, depths, keys, parse errors and groups.
- [ ] Live: an inventory of `test/fixtures/big` on the Windows CI runner matches the spec's counts.
- [ ] Perf: the metric is wall time for a full inventory of `big` on `windows-latest`. Measure the baseline on the
  first green run and record it in the PR. A later run fails if it takes more than twice the baseline or more than
  30 s.

## PR 5: Crash and exception log readers

- [ ] Depends on: PR 3. It does not depend on PR 4.
- [ ] Files: `src/main/logs/*.ts` and tests.
- [ ] Change:
  - Parses `lastException*.txt` and `lastUIException*.txt`. Their root is `<root>` holding `<report>` elements.
    Reports are grouped by `categoryid`. A cut-off file falls back to a regular expression per report.
  - Parses `lastCrash*.txt`. Its root is `<report>`. This reader gives only the time and the version, and never
    names a mod.
  - Reads `BE-ExceptionReport.html` from its embedded `beRawLEData` block.
  - Pulls `File "..."` lines out of `mc_lastexception.html`.
  - Marks frames under `T:\InGame\` as game code. Every other frame becomes a `modHint`.
- [ ] Result you see: `LogReport[]` for the `exceptions` fixture.
- [ ] Unit: one test per format in Fable's report, section 3, plus a cut-off file and a log with only game frames.
- [ ] Live: her real logs from "Today, before any code" parse without error, and every mod frame in them becomes a
  `modHint`. Until those arrive, this box stays open.
- [ ] Perf: none.

## PR 6: Rules and findings v1

- [ ] Depends on: PRs 4 and 5.
- [ ] Files: `src/main/rules/*.ts`, `src/shared/copy/findings.ts` and tests.
- [ ] Change: one pure function per rule, `(scan) => Finding[]`, in this order. The sources are Fable's report,
  section 2, and Sol's report, "First-version rules".
  1. **Mods are off after an update** (`modsdisabled=1` or `scriptmodsenabled=0` while mods exist). Severity
     `stop`. "Don't save your game until mods are back on."
  2. **Her Sims folder is in OneDrive, or two Sims folders exist.**
  3. **A crash log names a mod.** A `modHint` matches a `.pyc` name inside one of her `.ts4script` files.
  4. **A script mod sits too deep** (more than one folder down).
  5. **Packages sit deeper than her own `Resource.cfg` allows.**
  6. **A zip, rar or 7z file is in Mods.**
  7. **A package is broken or is from another Sims game.**
  8. **Two copies of the same file** (same SHA-256).
  9. **A script mod is older than the last game update.** The file date is before the version change. This rule is
     a hint, not proof, and its words say so.
  10. **The thumbnail cache is older than the latest mod change.**
  11. **The game crashed, and the log can't say why** (a `lastCrash` only). It points her to the 50/50 test,
      script mods first.
- [ ] Result you see: a `Finding[]` per fixture, with the player-facing words.
- [ ] Unit: each rule fires on its fixture and stays silent on `clean`. A snapshot test holds every message, so a
  wording change shows up in review.
- [ ] Live: on her real files, every finding the rules produce is one that Tyler, reading the files by hand, agrees
  with. Record any false alarm in the PR.
- [ ] Perf: rules on `big` add under 1 s to the PR 4 baseline.

The likeliest cause, an outdated script mod after a patch, cannot be proven from files on disk. v1 handles it three
ways: rule 3 when a log names the mod, rule 9 as a labelled hint, and the 50/50 test with script mods first.

## PR 7: Read-only screens and the "send to Tyler" report

- [ ] Depends on: PR 6.
- [ ] Files: `src/renderer/**`, `src/main/report/*.ts`, `src/preload/` and tests.
- [ ] Change:
  - **Welcome screen,** first run only: "Hi Lila! Tyler made this so your game can stop crashing. Let's take a look
    at your mods."
  - **Folder picker,** shown only when more than one candidate exists. It shows each folder with its dates.
  - **"What happened?":** the game closed, froze, won't load, or breaks on one save or lot.
  - **Check-up screen:** a scan with progress, then finding cards sorted by severity, in plain words. No fix buttons
    yet.
  - **"Send to Tyler":** builds a zip of her logs, `Options.ini`, `GameVersion.txt`, the inventory as JSON, and the
    CurseForge `AddonGameInstance.json` only. It never includes other CurseForge files, which can hold sign-in
    tokens. It replaces her Windows user name with `<user>` in every path. The zip goes to her Desktop.
- [ ] Result you see: the full read-only flow on each fixture.
- [ ] Unit: the report zip from the `exceptions` fixture holds exactly the listed files, and no path in it contains
  the fixture's user name.
- [ ] Live: Playwright on the CI Windows runner opens the installed app on the `patch-day` fixture. Pass means the
  "mods are off" card shows first.
- [ ] Perf: from opening the app to the first finding on `big`, under twice the PR 4 baseline plus 3 s.
- [ ] Tyler approves every screen before merge.

## G1: Tyler runs build 7 on her PC

Nothing that writes files is built until this gate passes. Tyler does each step on her PC with her there.

- [ ] Send the `.exe` through a Google Drive link. She installs it and clicks **More info**, then **Run anyway**, at
  the SmartScreen warning. Record what each screen said.
- [ ] Run the check-up. Save the "Send to Tyler" zip. Its contents become fixtures, with her consent.
- [ ] Confirm the folder, version and packs that PR 3 found, which closes PR 3's live box.
- [ ] **The CurseForge test.** Pick one small CurseForge custom content item she doesn't care about, and close the
  game. Move its file out of `Mods`, then open CurseForge, then record what it shows and whether it downloads the file
  again. Put the file back. Then repeat with a rename to `.package.disabled`. The result decides how PR 10 disables
  a mod.
- [ ] Record whether CurseForge is the standalone app (`%APPDATA%\CurseForge`) or the Overwolf one.

## PR 8: Write gate (Fable writes this one)

- [ ] Depends on: PR 7.
- [ ] Files: `src/main/safety/gate.ts`, `src/main/safety/gate.test.ts`.
- [ ] Change: the only function in the app that may write, move or delete a file. Each call names a reason and the
  paths it touches. It refuses when any of these holds:
  - A path is inside `saves/` or `Tray/`, or resolves there through a link.
  - A path is outside the Mods folder, the cache list in Fable's report (section 1), `Options.ini`, and the app's own
    data folder.
  - The game is running.
  - No verified backup exists from after the last change in `Mods`.
  A lint test fails if any file other than `gate.ts` imports `fs` write functions.
- [ ] Result you see: refused calls name the rule that refused them.
- [ ] Unit: the tests are written first and fail first. One test covers each refusal, including `..` paths, links,
  case changes (`SAVES`), and the French folder name.
- [ ] Live: none (no screen).
- [ ] Perf: none.

## PR 9: Backup, journal and undo

- [ ] Depends on: PR 8 and G1.
- [ ] Files: `src/main/safety/*` except `gate.ts`, and tests.
- [ ] Change:
  - **Backup:** copies the whole Sims folder, minus caches, to `%LOCALAPPDATA%\SimsHelper\backups\<time>`. It refuses
    when that path is inside OneDrive. It checks every copied file by size and SHA-256 before it marks the backup
    verified.
  - **Journal:** each action is a `JournalEntry` written to disk before the first move. A crash part way through
    therefore leaves a record that undo can finish.
  - **Undo:** moves the files back and checks their hashes. Running undo twice does nothing the second time.
- [ ] Result you see: back up the `duplicates` fixture, change it, undo, and the folder matches the original byte for
  byte.
- [ ] Unit: an interrupted action is resumed or undone on the next start. A failed backup blocks every fix.
- [ ] Live: on CI Windows, a backup of `big` is verified, and an undo restores it exactly.
- [ ] Perf: the metric is wall time for a backup of `big`. Record the baseline. A run fails at twice the baseline.

## PR 10: One-click fixes

- [ ] Depends on: PR 9.
- [ ] Files: `src/main/fixes/*.ts`, `src/renderer/fixes/**` and tests.
- [ ] Change: a **Fix** button on the finding cards for rules 1, 4, 6, 7, 8 and 10.
  - **Turn mods back on** rewrites the two keys in `Options.ini`.
  - **Move script up a folder.**
  - **Set aside** archives, broken packages and the extra copy.
  - **Clear caches** removes the cache list in Fable's report, section 1, and nothing else.
  - **Disable** and **enable** for any mod group, using the mechanism G1 chose, behind one interface.
  - A **History** screen lists every change with an **Undo** button.
  Every fix goes through the gate and the journal.
- [ ] Result you see: each fix on its fixture, then undo, and the folder matches the original.
- [ ] Unit: each fix, plus its undo, plus its refusal while the game runs.
- [ ] Live: Playwright on CI Windows runs each fix and its undo through the real buttons. Then Tyler disables and
  re-enables one mod group on her PC, and CurseForge behaves as G1 recorded.
- [ ] Perf: none.
- [ ] Tyler approves the buttons and wording before merge.

## PR 11: Guided 50/50 test

- [ ] Depends on: PR 10.
- [ ] Files: `src/main/fiftyfifty/*.ts`, `src/renderer/fiftyfifty/**` and tests.
- [ ] Change: a state machine over `FiftyFifty`, saved to disk after every step so it survives a restart. Each round
  works like this:
  1. Asks her to close CurseForge. A download part way through a round would ruin the test.
  2. Sets aside half of the suspect groups, script mods first, and clears the caches.
  3. Tells her to start the game, load a **new** test household, and try the thing that crashed.
  4. Asks "Did it crash?" and narrows the suspects.
  At the end it names the group, offers to keep it disabled, and puts everything else back. It never asks her to
  play her real save during a round.
- [ ] Result you see: on a fixture with 64 groups and one marked bad, the test names it in 6 rounds.
- [ ] Unit: the number of rounds is at most ⌈log₂ N⌉ for N groups. Quitting part way puts every file back. A restart
  part way resumes at the same round.
- [ ] Live: Playwright on CI Windows walks a full session with scripted answers. Then Tyler and Lila run one real
  session on her PC.
- [ ] Perf: none.
- [ ] Tyler approves the flow before merge.

## PR 12 (optional): "Ask for help" with AI

Tyler asked for this on 2026-11-24. It comes after G1 and PR 7, so her real files show which crashes the rules
miss. It is optional, and v1 ships without it.

- [ ] Depends on: PR 7 and G1. It does not need PRs 8 to 11.
- [ ] Files: `src/main/assist/*.ts`, `src/renderer/assist/**` and tests. Fable writes `src/main/assist/key-store.ts`,
  the only code that stores, reads or sends the key. Fable briefs the rest and Neon builds it.
- [ ] Change:
  - **Key setup:** a hidden setup screen opens with a key combination. Tyler types the Anthropic API key once on her
    PC. Electron `safeStorage` encrypts it with Windows DPAPI, and the encrypted key goes in the app's own data
    folder. The key is never in the code, the installer, the repo, a log or the "Send to Tyler" zip.
  - **The button:** **Ask for help** shows only when the rules give no `stop` or `warn` finding, or a crash log
    names no mod.
  - **What gets sent:** first the button shows her the exact text it will send, which is the newest log reports, the
    game version, and the mod group names and file names. It never sends saves, Tray files, her Windows user name or
    other paths. She clicks **Send** or **Cancel**.
  - **The answer:** it shows in plain words, labelled as a guess. The answer can point to a fix button, but the AI
    never runs a fix itself.
  - **Model:** Claude Haiku 5.5 (`claude-haiku-5-5`, $0.10 in and $0.50 out per million tokens) by default, through
    the official `@anthropic-ai/sdk`. Claude Sonnet 5.5 (`claude-sonnet-5-5`, $2 and $10) is the step up. The model ID
    is one constant. Before merge, run both on her real logs from G1, and keep Haiku unless its answers are vague or
    wrong. Haiku has no server-side fallback on a refusal, so the app shows a plain "couldn't answer this one" message.
  - **Cost:** Tyler sets a monthly spending cap on the key in the Anthropic console before setup.
- [ ] Result you see: on the `exceptions` fixture, the button sends the previewed text and shows the answer.
- [ ] Unit: the key never appears in any log, report zip or renderer message. The text sent matches the preview,
  byte for byte. With no key stored, the button doesn't appear.
- [ ] Live: Tyler sets up the key on her PC, and one real question gets an answer. The Anthropic console shows the
  spending cap.
- [ ] Perf: none.
- [ ] Tyler approves the wording and the preview screen before merge.

---

## After v1 (not planned in detail)

- **Conflict scan:** list two packages that hold the same resource key. It is kept apart from crash diagnosis,
  because shared keys are often on purpose (MCCC's author, Fable's report, section 3).
- **CurseForge API lookups:** only if Tyler gets a personal key and a way to keep it out of the `.exe`.
- **Auto-update:** the repo is public now, so GitHub releases can serve updates.
- **Code signing:** about $10 a month. It removes the SmartScreen warning.

## What stays unproven

- What CurseForge does when a file it installed is moved or renamed. G1 settles it.
- The format of `AddonGameInstance.json` for Sims 4. Neon inferred it from other games. G1's report settles it.
- How script-mod frames look in her real logs. Her files settle it.
- Registry lookup, OneDrive paths and process detection on a real PC. CI proves only the fixtures. A Windows machine
  or G1 settles them.
- That electron-builder's finish-page text can be changed through `build/installer.nsh`. PR 1 proves it or picks
  another place for the note.
- Some of Sol's sources are EA forum pages that Fable could not open. Any rule that rests only on one of them gets
  checked before it ships.
