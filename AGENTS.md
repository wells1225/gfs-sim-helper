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
- Full local check: `npm run typecheck && npm test && npm run build`
- Build the Windows NSIS installer: `npm run dist:win` (runs `electron-vite build` then `electron-builder --win nsis --x64`)
- Installed-app Playwright smoke test (Windows CI): `npm run test:e2e`

## Rules to follow

- Her saves come first. Never write to `Saves/` or `Tray/`. Any change to `Mods/` or game settings makes a backup
  first and can be undone from the app.
- The app only acts when she clicks. Scanning reads files and changes nothing.
- Tests run against fixture folders checked into the repo, never against a real game folder.

## Checks (this Mac runs out of memory)

- Run only your own test files, with 2 workers at most. Never use a command that starts one worker or job per core.

## Pull requests

- Branch from `main`, one change per PR, title `type(scope): subject`.
- Who does what in this project: Neon builds. Opus reviews each PR, then Fable does the last check. Whoever finds an
  issue fixes it, with a failing test first. Sol does one quick, light review of a finished stage. Astra is not used
  here.
