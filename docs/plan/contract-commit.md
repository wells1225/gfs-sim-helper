# Brief: the contract commit

**Goal.** Put everything PRs 4 to 12 share onto one branch, so nine builders can start at once and never edit the
same file. You write the shared files, the wiring, the app shell and a stub at every fixed path. You build no feature.

- **Base:** `wells/locate-sims-folders` (PR 3), after its last check is done. **Branch:** `wells/contracts`.
- **PR title:** `feat(contract): shared types, ports, IPC and app shell for PRs 4 to 12`. Base of the PR: PR 3's branch.
- **Read first:** [`contracts.md`](contracts.md) (the source for every type and signature; copy them exactly) and
  [`ownership.md`](ownership.md) (every path).
- Never add a `Co-Authored-By` line. Tyler is the only author. Keep it small and fast: when in doubt, write less.

## What you write, in this order

1. **Packages and config.**
   - Install the packages in `ownership.md`, all as `devDependencies`, newest stable from `npm view`. Put the exact
     versions in the PR body.
   - `electron.vite.config.ts`: add `@tailwindcss/vite` to the renderer. Build once and confirm `out/main/index.js`
     holds `fflate` and `@anthropic-ai/sdk` bundled in (no bare `require` of either), because the installer ships
     only `out/**`. To prove it, import each from a throwaway line, build, look, then remove the line.
   - `tsconfig.web.json`: add `allowImportingTsExtensions`. `tsconfig.node.json`: add `erasableSyntaxOnly`; if PR 1
     to 3 code fails under it, take the flag back out, change nothing else, and say so in the PR body.
   - `package.json` scripts from `ownership.md`. `playwright.config.ts`: the three projects from `contracts.md`,
     section 10. `components.json` and the twelve shadcn/ui primitives (Radix base).
2. **Types.** `src/shared/model.ts` and `src/shared/ipc.ts`, exactly as in `contracts.md`, sections 2 and 7.
   `src/main/ports.ts`, section 3. Do not edit `src/main/locate/**`.
3. **Real helpers** (small, with tests):
   - `src/main/app-paths.ts`: `appPaths({ localAppData, appData, desktopDir, env }): AppPaths`, pure.
     `oneDriveRoots` comes from `OneDrive`, `OneDriveConsumer` and `OneDriveCommercial` in `env`.
   - `src/main/app-host.ts`: `createAppHost(): Host` on PR 3's `createWindowsHost`, documents folder from
     `SIMS_HELPER_DOCUMENTS_DIR` or `app.getPath('documents')`; `desktopDir()` from `SIMS_HELPER_DESKTOP_DIR` or
     `app.getPath('desktop')`.
   - `src/main/fs-read.ts`: `openForRead`, `readStream`, `sha256File`. Opens with flag `'r'` only and returns a
     narrow object, never the raw file handle.
   - `src/main/redact.ts`: `makeRedactor(env): (text) => string`. The names are `USERNAME` and the last part of
     `USERPROFILE`. Without regard to letter case, replace each name with `<user>` wherever it is a whole path
     segment (between `\`, `/`, or the ends of the text). Never replace inside a longer word (`Lila` in `Lilac`
     stays). No name known: return the text unchanged.
4. **Wiring.**
   - `src/main/services.ts`: `createContext({ host, paths, safeStorage, emit, reveal }): AppContext`. Build each port
     as an object of arrow functions that call the module functions with their `deps` (`contracts.md`, section 4).
     Nothing may run a stub while the context is built.
   - `src/main/ipc.ts`: `registerIpc(ipcMain, ctx, isAppWindow)`. Merge the four handlers files and register every
     channel in `INVOKE_CHANNELS`. Reject a call whose sender is not the app window's main frame on the app's own
     page.
   - `src/main/index.ts`: single-instance lock; window 960 × 700, minimum 500 × 520, `show: false` until
     `ready-to-show`, background color by `nativeTheme`, native title bar, `Menu.setApplicationMenu(null)`; deny
     `window.open` and navigation away from the app page; keep `contextIsolation` and `sandbox`.
   - `src/preload/index.ts`: expose `simsHelper: SimsHelperApi`. `invoke` refuses a channel not in `INVOKE_CHANNELS`.
5. **Stubs.** One file per fixed path in `contracts.md` (sections 4, 7 and 9).
   - Main functions throw `new Error('not implemented: <name>')` when called. `DISABLE.plan` throws the same way.
   - A handlers file returns its object without throwing; each handler in it throws `not implemented: <channel>`.
   - The three `cli.ts` files print `not implemented` and exit 1.
   - Renderer screens and slots render nothing. `FIXES_READY` is `false`. `screens/Start.tsx` goes to `about`.
6. **Shell.** `src/renderer/styles.css` (Tailwind v4 tokens, light and dark, palette from
   `docs/research/neon-ui.md`, section 2), the font import, `components/Emblem.tsx`, `nav.tsx`, `session.tsx`,
   `api.tsx`, and `App.tsx` as described in `contracts.md`, section 9, including Ctrl+Shift+K to `key-setup`. Replace
   `assets/icon.svg` with the emblem.
7. **Test support.**
   - `src/shared/testing/sample.ts` (no Node imports): the four builders. Give `sampleScan()` one finding of each
     severity, using the plan's own words where it has them.
   - `src/renderer/testing/fake-api.ts`: `fakeApi(answers)`, a `SimsHelperApi` that records calls, rejects a channel
     it has no answer for, and can fire `progress`.
   - `test/e2e/support/app.ts`: `launchApp`, `stubIpc`, `inOrder`, `shoot` (`contracts.md`, section 10). Use
     `SIMS_HELPER_EXE` when set, as `test/e2e/app.spec.ts` does today.
   - `test/e2e/contract.spec.ts`, in the `smoke` project: `launchApp({ fixture: 'clean' })` opens the window and
     shows About. This proves on Windows CI that the environment overrides do not stop the app from starting.
   - `src/main/safety/gate-lint.test.ts`, first version: adapt PR 3's `read-only.test.ts` to check every non-test
     file under `src/` (leave out `src/main/locate/`, which has its own guard, and the two `testing/` folders)
     against the read and write rule in `contracts.md`, section 1. Fable hardens it in PR 8.
8. **CI and docs.** `ci.yml`: run `smoke` and `screens`, upload `test-results/screens/` as `screens`
   (`if-no-files-found: ignore`), run `live` only on a push to `main` or when the PR's base is `main`. `AGENTS.md`:
   add the new commands and one line that shared files are frozen, pointing at `docs/plan/ownership.md`. Add to it,
   do not rewrite it.

## Tests to write first

- `src/main/contract.test.ts`:
  - both `tsc` projects from `npm run typecheck` exit 0 (run them with `execFile`, 120 s timeout);
  - the handlers merged from the four handlers files cover every channel in `INVOKE_CHANNELS` exactly once, and
    building the context and the handlers throws nothing;
  - `GameRunState` in `model.ts` and in `locate/process.ts` are the same union (a type-level check both ways).
- `redact.test.ts`: `C:\Users\Lila\Documents` and `c:/users/LILA/x` lose the name; `Lilac.package` keeps it; no name
  known changes nothing.
- `app-paths.test.ts`: every path sits under `<localAppData>\SimsHelper`; `curseForgeInstanceFile` is `null` without
  `appData`.
- `fs-read.test.ts`: reads a byte range and a hash from a temp file; the returned object has no write method.
- `gate-lint.test.ts`: the tree passes, and a list of bad import lines (copy PR 3's list) is each refused.
- `App.test.tsx`: the shell shows the dedication through `start` → `about`; "Your mods" and "History" are hidden.

## Done bar

- `npm run typecheck && npm test && npm run build` pass on the Mac (2 workers; the configs cap this).
- CI on the PR is green on `windows-latest`: the installer builds, the installed app opens, `smoke` passes.
- No stub runs at startup: the built app opens to the About screen with an empty console.
- `git diff --stat` against PR 3 touches no file under `src/main/locate/` and no file under `scripts/fixtures/`.
- The PR body lists package versions and anything in `contracts.md` you could not do as written.

When CI is green, tell the lead the head SHA. The nine builders branch from that SHA.
