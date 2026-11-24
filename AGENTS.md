# Gfs Sim helper: rules for agents

A desktop helper for one Sims 4 player on a Windows PC. It scans her game folder (Documents/Electronic Arts/The Sims 4),
explains likely crash causes in plain language, and manages her mods (most installed through CurseForge). She runs it
herself, so every screen is for a non-technical player.

## State of the repo

- No code, tests or build yet. The plan lives in `docs/plan/`, and the research it rests on lives in `docs/research/`.
- There is no full check yet. When the first code lands, this file names its test and build commands.

## Rules to follow

- Her saves come first. Never write to `Saves/` or `Tray/`. Any change to `Mods/` or game settings makes a backup
  first and can be undone from the app.
- The app only acts when she clicks. Scanning reads files and changes nothing.
- Tests run against fixture folders checked into the repo, never against a real game folder.

## Checks (this Mac runs out of memory)

- Run only your own test files, with 2 workers at most. Never use a command that starts one worker or job per core.

## Pull requests

- Branch from `main`, one change per PR, title `type(scope): subject`.
- Code that Neon or Grok built gets an Opus review before merge. Astra does the deep review check before a PR is
  called ready to merge.
