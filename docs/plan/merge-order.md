# Merge order for PRs 1 to 12

Where things stand on 2026-11-24: PRs 1, 2 and 3 are open and stacked (`main` ← #1 `wells/electron-installer-scaffold`
← #2 `wells/sims-fixture-generator` ← #3 `wells/locate-sims-folders`). A dry-run merge of `main` with #1 and with #3
shows no conflict. The contract branch and the nine PR branches are in [`ownership.md`](ownership.md).

## The order

| Step | Merge into `main` | Needs first | Notes |
|---|---|---|---|
| 1 | #1 scaffold | Tyler's look at the window and dedication | |
| 2 | #2 fixtures | step 1 | retarget to `main` first |
| 3 | #3 locate | step 2, Fable's last check | retarget to `main` first |
| 4 | contract (`wells/contracts`) | step 3 | retarget to `main` first |
| 5 | PR 8 gate | step 4 | no screen; moved ahead of PR 7 because the report zip and settings are written through it |
| 6 | PR 4 inventory, PR 5 logs | step 4 | either order |
| 7 | PR 6 rules | step 6 | its "after main" tests need 4 and 5 |
| 8 | PR 7 screens | steps 5 and 7 | **Tyler approves the screens** |
| G1 | no merge: Tyler runs the installer from step 8 on her PC | step 8 | see "What G1 settles" |
| 9 | PR 9 backup | step 5 | may merge before G1: nothing in the app can reach it yet |
| 10 | PR 12 AI help | step 8 | may merge before G1: with no key stored, the button never shows |
| 11 | PR 10 fixes | steps 8, 9 and **G1** | first PR that lets her change files; **Tyler approves** |
| 12 | PR 11 50/50 | step 11 | **Tyler approves** |

The plan said nothing that writes files is built before G1. Tyler has since asked for PRs 8 to 12 to be *built* in
parallel, so G1 is now a gate on **merging PR 10**, not on building. Until PR 10 merges, `FIXES_READY` is `false`
and no button in the app can change a game file. The lead confirms this reading with Tyler.

## How to merge without rewriting history

- **Use "Create a merge commit" for steps 1 to 4.** Never squash them. Every later branch has those commits in its
  history; a merge commit keeps the same commit ids in `main`, so nothing below needs a rebase.
- After a step merges, retarget the next PR in the stack: `gh pr edit <number> --base main`.
- Steps 5 to 12 may use a merge commit or a squash. Their branches are siblings and share no file.

## How a later PR catches up

A PR branch never rebases and never force-pushes. It merges:

```sh
git fetch origin
git merge origin/main        # no conflict is expected: no two PRs own the same file
npm run fixtures && npx vitest run <your folders>    # now run your "after main" tests
```

Then retarget the PR to `main` (`gh pr edit <number> --base main`). From that push on, `ci.yml` also runs the `live`
Playwright project for it. A conflict here means someone edited a file they do not own: stop and tell the lead.

**If PR 3 changes after `wells/contracts` exists** (its last check is still running): merge PR 3's new head into
`wells/contracts`, then each open PR branch merges `origin/wells/contracts`. No rebase.

**Only if someone squashed a step 1 to 4 PR by mistake**, the children need moving. For each branch, with `OLD` the
commit of `wells/contracts` it was cut from:

```sh
git fetch origin
git rebase --onto origin/main OLD wells/pr-04-inventory
git push --force-with-lease=wells/pr-04-inventory origin wells/pr-04-inventory   # ask Tyler before any force-push
```

## Building in waves (this Mac: at most 4 builders at once)

| Wave | Builders | Why |
|---|---|---|
| 0 | the contract commit (one builder) | everything waits for its head SHA |
| 1 | PR 8 (Fable), PR 7, PR 4, PR 5 | 7 is the largest and Tyler must see it; 8 is the base of every write |
| 2 | PR 6, PR 9, PR 10, PR 11 | start each as a wave 1 slot frees up, in this order; 6 completes the G1 build |
| 3 | PR 12 (Fable writes `key-store.ts` first), and each PR's "after main" tests as its neighbors land | optional, so last |

Run it as a queue, not as fixed batches: when one builder finishes, the next in the order 8, 7, 4, 5, 6, 9, 10, 11,
12 starts. The first installer for G1 needs 4, 5, 6, 7 and 8, so those five come first.

Each builder runs only its own test files, 2 workers. The full check runs once per merge step, by the merge agent
or CI, never by nine builders at once.

## Known conflict and breakage risks

- **A wrong signature in the contract.** Nine PRs code against it. A fix after the fork touches a shared file, so it
  goes through the lead onto `wells/contracts` and every branch merges it. Expect one or two of these.
- **`gate-lint.test.ts` gets stricter in PR 8.** A branch that passed the first version can fail after merging
  `main`. The fix is in that PR's own files.
- **Screenshots come in two sets.** Branch shots use sample data, and a slot hosted by PR 7's check-up (the Fix
  button, the 50/50 entry, Ask for help) can only be photographed after PR 7 is in `main`. The set Tyler approves is
  the `screens` artifact of each PR after it has merged `main` in, before that PR merges.
- **The backup rule is strict.** A change in `Mods` since the last backup means a new backup before any move, undo
  included. Mods write their own logs there, so this will happen after most play sessions. PR 9 copies only what
  changed, so later backups are quick, but the first one is the size of her whole Sims folder (G1 row below).
- **`package-lock.json`.** Only the contract commit changes it. A PR that ran `npm install <package>` conflicts
  with every other PR: reject it.
- **`AGENTS.md`.** PR 1 and the docs commits on `main` both edit it. Git merges them cleanly today; check the file
  by eye after step 1.
- **Fixture specs.** The generator is frozen. A PR that "just adds a field" to `spec-types.ts` breaks PR 2's
  byte-identical tests for everyone.
- **Workflow minutes.** After step 12, `main` runs `ci.yml` and the two probe workflows on each push. The repo is
  public, so this costs nothing.

## What G1 settles, and what it can still change

| Question for her PC | Decides | Change if the answer is bad |
|---|---|---|
| Does CurseForge download a file again after it moves out of `Mods`? And after a rename to `.package.disabled`? | how PR 10 disables a mod | add the `rename-in-mods` mechanism behind `DisableMechanism` (`contracts.md`, section 6) |
| Where is `AddonGameInstance.json`, and what is in it? Standalone or Overwolf CurseForge? | `readCurseForge` in PR 4, the `cf:` groups | fix the reader; groups fall back to folders meanwhile |
| How do mod frames look in her real logs? What do `lastUIException`, Better Exceptions 3.x and `mc_lastexception.html` really hold? | PR 5's readers, rule `log-names-mod` | fix the readers; her logs become fixtures |
| Does `TS4_x64.exe`'s date follow the last patch? | rule `script-older-than-update` | switch the date source or drop the rule |
| How big is her Sims folder, and how much disk is free? | whether a whole-folder backup before each change is affordable | a smaller backup (Mods and settings only) needs a contract change |
| What is CurseForge's process name? | PR 11's "close CurseForge" check | one constant |
| Do the registry, OneDrive paths and process detection work on a real PC? | PR 3 | fix in `src/main/locate/` |
| Which model answers her real logs well, Haiku or Sonnet? | `ASSIST_MODEL` in PR 12 | one constant |
