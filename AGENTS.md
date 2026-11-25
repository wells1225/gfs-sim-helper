# Gfs Sim helper: rules for agents

A desktop helper for one Sims 4 player on a Windows PC. It scans her game folder (Documents/Electronic Arts/The Sims 4),
explains likely crash causes in plain language, and manages her mods (most installed through CurseForge). She runs it
herself, so every screen is for a non-technical player.

## State of the repo

- Electron + Vite (`electron-vite`) + React + TypeScript (strict) app scaffolded under `src/main/`, `src/preload/`,
  `src/renderer/`, and `src/shared/`. The plan lives in `docs/plan/`, and the research it rests on lives in
  `docs/research/`.
- Worker caps live in the test configs: `vitest.config.ts` sets `maxWorkers: 2`, and `playwright.config.ts` sets
  `workers: 1`.

## Commands

- Run one test file: `npx vitest run <path/to/file.test.ts>`
- Build the fake Sims 4 folders: `npm run fixtures` (plain `node` runs the `.ts` file, so Node 22.18 or newer)
- Full local check: `npm run typecheck && npm test && npm run build`
- Build the Windows NSIS installer: `npm run dist:win` (runs `electron-vite build` then `electron-builder --win nsis --x64 --publish never`)
- Installed-app Playwright smoke test (Windows CI): `npm run test:e2e`
- Stubbed screen screenshots (Playwright): `npm run test:screens`
- Live fixture end-to-end tests (Windows CI): `npm run test:live`
- Debug CLIs (plain `node`): `npm run locate -- <fixture>`, `npm run inventory -- <fixture> [--time]`, `npm run logs -- <fixture>`, `npm run findings -- <fixture>`

## Rules to follow

- Shared files are frozen after the contract commit; edit only your PR's owned paths in `docs/plan/ownership.md`.

- Her saves come first. Never write to `Saves/` or `Tray/`. Any change to `Mods/` or game settings makes a backup
  first and can be undone from the app.
- The app only acts when she clicks. Scanning reads files and changes nothing. One exception (Tyler, 2026-11-24):
  when a change was cut off by a crash, the app puts things back as they were when it next opens, after checking
  the backup, and then tells her.
- Tests run against fake game folders, never against a real one. The specs in `scripts/fixtures/specs/` are committed;
  `npm run fixtures` builds them into `test/fixtures/<spec>/` (git-ignored). Change a spec, not the output.

## Checks (this Mac runs out of memory)

- Run only your own test files, with 2 workers at most. Never use a command that starts one worker or job per core.

## Pull requests

- Branch from `main`, one change per PR, title `type(scope): subject`.
- No `Co-Authored-By` lines in commits and no "Generated with" lines in PR bodies. Tyler is the only author. A
  `commit-msg` hook in this clone strips co-author lines.
- Who does what in this project: Neon and Opus each build about half the PRs, and each reviews the other's PRs. Fable
  does the last check. Fable writes the write gate and the AI key store. Whoever finds an
  issue fixes it, with a failing test first. Sol does one quick, light review of a finished stage. Astra is not used
  here.
