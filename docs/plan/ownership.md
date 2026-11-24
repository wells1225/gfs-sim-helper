# Who may touch which file (PRs 4 to 12)

One rule: **a file has one owner.** A PR creates and edits only the paths in its row. Nobody edits a shared file
after the contract commit. Where `plan.md`'s "Files it may touch" column differs, this file wins (for example,
`plan.md` gives PR 7 all of `src/renderer/` and `src/preload/`; here it does not get them).

The contract commit creates a stub at every fixed path named in [`contracts.md`](contracts.md). From then on that
stub belongs to the PR whose row covers it.

## Branches and names

| PR | Slug and branch | Base |
|---|---|---|
| contract | `wells/contracts` | `wells/locate-sims-folders` (PR 3) |
| 4 | `wells/pr-04-inventory` | `wells/contracts` |
| 5 | `wells/pr-05-logs` | `wells/contracts` |
| 6 | `wells/pr-06-rules` | `wells/contracts` |
| 7 | `wells/pr-07-screens` | `wells/contracts` |
| 8 | `wells/pr-08-gate` | `wells/contracts` |
| 9 | `wells/pr-09-backup` | `wells/contracts` |
| 10 | `wells/pr-10-fixes` | `wells/contracts` |
| 11 | `wells/pr-11-fifty-fifty` | `wells/contracts` |
| 12 | `wells/pr-12-assist` | `wells/contracts` |

## Owned paths

`**` means the folder and everything under it, tests and snapshots included.

| PR | May create or edit |
|---|---|
| 4 | `src/main/inventory/**` · `.github/workflows/pr-04-inventory.yml` · `scripts/fixtures/specs/pr-04-*.json` |
| 5 | `src/main/logs/**` · `scripts/fixtures/specs/pr-05-*.json` |
| 6 | `src/main/rules/**` · `src/shared/copy/**` · `scripts/fixtures/specs/pr-06-*.json` |
| 7 | `src/main/scan/**` · `src/main/report/**` · `src/renderer/screens/**` · `src/renderer/About.tsx` · `src/renderer/About.test.tsx` · `test/e2e/app.spec.ts` · `test/e2e/screens/pr-07-screens.spec.ts` · `test/e2e/live/pr-07-screens.spec.ts` |
| 8 | `src/main/safety/gate.ts` · `src/main/safety/gate.test.ts` · `src/main/safety/gate-lint.test.ts` (first version from the contract commit) |
| 9 | `src/main/safety/**` except the three `gate*` files · `.github/workflows/pr-09-backup.yml` |
| 10 | `src/main/fixes/**` · `src/renderer/fixes/**` · `test/e2e/screens/pr-10-fixes.spec.ts` · `test/e2e/live/pr-10-fixes.spec.ts` |
| 11 | `src/main/fiftyfifty/**` · `src/renderer/fiftyfifty/**` · `test/e2e/screens/pr-11-fifty-fifty.spec.ts` · `test/e2e/live/pr-11-fifty-fifty.spec.ts` |
| 12 | `src/main/assist/**` · `src/renderer/assist/**` · `test/e2e/screens/pr-12-assist.spec.ts` |

Inside PR 12, Fable writes `src/main/assist/key-store.ts` and `src/main/assist/key-store.test.ts`. The PR 12 builder
writes everything else in that row and does not edit those two files.

## Shared files: the contract commit only

- **Root and config:** `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.node.json`,
  `tsconfig.web.json`, `electron.vite.config.ts`, `electron-builder.yml`, `vitest.config.ts`, `playwright.config.ts`,
  `components.json`, `.gitignore`, `.github/workflows/ci.yml`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `build/**`,
  `assets/**`.
- **Shared code:** `src/shared/model.ts`, `src/shared/ipc.ts`, `src/shared/app.ts`, `src/shared/testing/**`.
- **Main:** `src/main/index.ts`, `src/main/ipc.ts`, `src/main/services.ts`, `src/main/ports.ts`,
  `src/main/app-host.ts`, `src/main/app-paths.ts`, `src/main/fs-read.ts`, `src/main/redact.ts`, their tests, and
  `src/main/contract.test.ts`.
- **Preload:** `src/preload/**`.
- **Renderer:** `src/renderer/index.html`, `main.tsx`, `App.tsx`, `App.test.tsx`, `nav.tsx`, `session.tsx`,
  `api.tsx`, `styles.css`, `test-setup.ts`, `src/renderer/components/**`, `src/renderer/lib/**`,
  `src/renderer/testing/**`.
- **Fixtures:** `scripts/fixtures/**`, except new spec files named `<pr-slug>-*.json` as listed above.
- **End-to-end support:** `test/e2e/support/**`, `test/e2e/contract.spec.ts`.
- **PR 3's code:** `src/main/locate/**`. Nobody adds or edits a file there.
- **Docs:** `docs/**` belongs to the lead. Builders report in the PR body, not in a doc.

A needed change to any of these goes to the lead as a "Contract request". The lead lands it on `wells/contracts`
(before the merge to `main`) or on `main` (after), and every open branch merges it in.

## Windows CI without sharing a workflow file

`ci.yml` already runs every unit test, the `smoke` and `screens` Playwright projects and the installer build on
`windows-latest` for each PR, and uploads the screenshots as the artifact `screens`. So:

- PRs 5, 6, 8: no workflow file. Their Windows proof is their unit tests in `ci.yml`.
- PRs 7, 10, 11, 12: no workflow file. Their screenshots come from their own `test/e2e/screens/<pr-slug>.spec.ts`,
  which `ci.yml` runs and uploads.
- PRs 4 and 9 have a timing probe, so each adds its own `.github/workflows/<pr-slug>.yml`. Shape:

```yaml
name: pr-04-inventory
on:
  pull_request:
    paths: ['src/main/inventory/**', '.github/workflows/pr-04-inventory.yml']
  push:
    branches: [main]
jobs:
  probe:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run fixtures -- big
      - run: npm run inventory -- test/fixtures/big --time   # the PR's own probe command
```

## npm packages (the contract commit installs all of them, once)

All go in `devDependencies` (see `contracts.md`, section 1). The contract builder takes the newest stable version of
each with `npm view <name> version` and lets `package-lock.json` pin it. No PR runs `npm install <anything>`.

| Package | For | Used by |
|---|---|---|
| `fflate` | list `.ts4script` entries, write the report zip | PRs 4, 7 |
| `@anthropic-ai/sdk` | the AI call, inside `key-store.ts` only | PR 12 |
| `tailwindcss`, `@tailwindcss/vite`, `tw-animate-css` | styling | contract, PRs 7, 10, 11, 12 |
| `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge` | shadcn/ui primitives | contract |
| `lucide-react` | icons | PRs 7, 10, 11, 12 |
| `sonner` | toasts with Undo | PRs 10, 11 |
| `@fontsource-variable/plus-jakarta-sans` | the bundled font | contract |
| `@testing-library/user-event` | clicks and typing in component tests | PRs 7, 10, 11, 12 |

On purpose **not** added: a router, a state library, an XML or HTML parser (the logs are read with bounded regular
expressions), an ini parser, `@s4tk/models` (we read the package index ourselves).

shadcn/ui primitives the contract commit generates into `src/renderer/components/ui/`: `button`, `card`, `badge`,
`alert`, `progress`, `accordion`, `dialog`, `radio-group`, `switch`, `input`, `separator`, `sonner`.

## `package.json` scripts the contract commit adds

| Script | Runs | Owner of the file it runs |
|---|---|---|
| `inventory` | `node src/main/inventory/cli.ts <fixture root> [--time]` | PR 4 |
| `logs` | `node src/main/logs/cli.ts <fixture root>` | PR 5 |
| `findings` | `node src/main/rules/cli.ts <fixture root>` | PR 6 |
| `test:screens` | `playwright test --project=screens` | contract |
| `test:live` | `playwright test --project=live` | contract |
