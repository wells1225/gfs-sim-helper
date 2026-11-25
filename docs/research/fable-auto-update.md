# Updating the app from inside the app (Fable, 2026-11-24)

Question: Tyler ships a new version, Lila clicks **Update** in the app, and it installs. How, and how safely?

Each claim is marked **[S]** (sourced; keys are in the last section) or **[I]** (inferred, not proven).

## The answer in short

- Use **electron-updater 6.8.x with the GitHub Releases provider**, on the NSIS installer the repo already builds.
  The repo is public, so her PC needs no token.
- The app checks GitHub when it opens. It downloads only when she clicks **Update now** and installs only when she
  clicks **Restart now**. The installer runs silently, per user, with no admin prompt, and reopens the app.
- A tag push builds the installer on `windows-latest` and leaves a **draft** release. Tyler clicks **Publish**. That
  click is the moment a version ships.
- The app is unsigned, so GitHub is the only thing that vouches for an update: **whoever can publish a release on
  this repo can run code on her PC after one click.** Section 2 says how to keep that to Tyler.
- Do not host updates on M8. It adds work and ties her PC's safety to the game servers' safety.

## 0. Two versions of the tool: read this first

- The repo pins `electron-builder ^26.18.0`, npm's `latest`. Its updater is `electron-updater` 6.8.11. Builder 27
  and updater 7 are still alpha. **[S npm]**
- **The website electron.build now describes version 27.** It names things 6.8.11 does not have: `crossOriginHeaders`,
  `autoInstallEvent`, `allowInsecureFeed`, `verifyUpdateFile`, signed manifests, and `disableWebInstaller` defaulting
  to `true`. A search of the 6.8.11 package finds none of them. **[S EU, EB27]**
- So every behaviour claim below comes from reading the 6.8.11 and 26.18.0 code. Code copied from the website will
  not compile.

## 1. The options

| Option | Verdict | Why |
|---|---|---|
| electron-updater + GitHub Releases | **Recommended** | Works with NSIS, no server to run, no token on her PC; HTTPS and uptime are GitHub's. **[S EU]** |
| electron-updater + generic HTTPS server on M8 | Works, not recommended | Same client code, but Tyler runs the server and its security (below). |
| Electron's built-in `autoUpdater`, update.electronjs.org | Does not fit | On Windows it needs a Squirrel.Windows or MSIX package. It cannot update an NSIS install, and Tyler asked for the wizard. **[S EL]** |
| A cloud bucket (S3, R2) with electron-updater | No gain | Same trust model as GitHub, plus an account and a key to keep. **[I]** |
| A "Get the new version" link to the Releases page | Fallback only | A browser download, so SmartScreen warns every time. Keep it as plan B when an update fails. **[I]** |
| Microsoft Store (MSIX) | Later, maybe | Microsoft signs and updates it and the warning goes away. It needs a new package format and store review. **[I]** |

### What hosting on M8 would take

The generic provider needs `latest.yml` and the `.exe` at an HTTPS address her PC can reach. **[S EU]**

- **Path A, port forwarding.** A domain name and a DNS record that follows the home IP. The router forwards TCP 443
  to M8. Let's Encrypt's simplest check also needs port 80, which some home providers block; its DNS check avoids
  that but puts DNS credentials on M8. **[S LE]** None of it works behind the provider's shared address (CGNAT).
  **[I]** Then a web server with automatic certificates, serving one read-only folder as its own user, a firewall
  open only on the web ports, and automatic security updates. **[I]**
- **Path B, a tunnel (better).** Cloudflare Tunnel connects outbound only: the router stays closed and the home IP
  stays hidden. It needs a domain on Cloudflare. **[S CF]** Tailscale Funnel gives a public HTTPS name with no
  domain, but it is beta with fixed bandwidth limits. **[S TS]**
- **Either way, releases must reach M8:** by hand over the home network, or through an SSH door for GitHub's
  runners, which is one more open port and one more key. **[I]**

**The risk:**
- With an unsigned app the server is the trust anchor: whoever can change those two files can run code on her PC.
  **[S EU, EB27]** M8 also runs game servers that face the internet. A hole in one becomes a way into her PC. **[I]**
- Path A adds an inbound service to the home network and puts the home IP in public DNS. A flood aimed at it takes
  the game servers down too. Updates stop whenever the home line, the power or M8 is down. **[I]**
- 6.8.11 does not refuse a plain `http` feed (27 does), so a mistyped address is accepted silently. **[S EU, EB27]**

GitHub removes every item here. M8 would only add privacy for the installer, and the repo is already public.

## 2. Integrity and security

**What 6.8.11 checks:**
- It reads `latest.yml` from the release over HTTPS, downloads the installer, and compares its **SHA-512** with the
  one in `latest.yml`. A mismatch deletes the file and fails with `ERR_CHECKSUM_MISMATCH`. **[S EU, BUR]**
- It accepts only a **higher** version, and only from the release GitHub marks as latest, which is never a draft or
  a pre-release. **[S EU, GH-LATEST]**
- **Publisher check:** on Windows it can check the installer's signature against a `publisherName` stored in the
  app. The builder stores that name only for a signed app. **Ours is unsigned, so the name is absent and the check
  returns "fine" without looking.** **[S EU `NsisUpdater.verifySignature`, ABL]**
- So `latest.yml` is protected only by HTTPS and GitHub's storage. The checksum proves the download matches
  `latest.yml`. It does not prove who wrote `latest.yml`. **[S EU, EB27]**

**What an attacker needs,** plus her click (a bad update looks exactly like a good one):
1. **To publish a release** with a higher version: write access to the repo. That is Tyler's GitHub login, any token
   of his that can write contents (the `gh` login on his Mac that agents use counts), or code running in a workflow
   job that holds a write token. **[S GH-TOKEN] [I]**
2. **To swap the files of a published release:** the same access. Immutable releases close this. **[S GH-IMM]**
3. **The repo's name.** The address is baked into every installed copy. If the repo is renamed, transferred or
   deleted, GitHub frees the name and whoever takes it can serve updates. **[S EB27]**
4. **To break HTTPS on her PC** with a rogue root certificate. Her PC is already lost in that case. **[I]**

Not enough alone: a pull request from a fork (read-only token, no secrets) **[S GH-TOKEN]**, a draft, a
pre-release, an older version, or tampering with the download in transit. **[S EU]**

**Keeping the publish credential safe:**
- **No stored secret.** The workflow uses the built-in `GITHUB_TOKEN`. No personal token goes into repo secrets.
- **Least privilege, split by job.** `permissions: {}` at the top. The job that runs `npm ci`, the tests and the
  build gets `contents: read`. A second job gets `contents: write` and runs no repo code and no npm package: it only
  downloads the build's files and calls `gh release create --draft`. A poisoned npm dependency never sees a write
  token. **[S GH-TOKEN, GH-CLI] [I]**
- **The repo default is already read-only** for workflow tokens (checked with `gh api` today). **[S REPO]** Keep
  it, and never add a `pull_request_target` workflow, which would hand fork code a write token. **[I]**
- **Draft, then Tyler publishes.** The app cannot see a draft. **[S EU, GH-LATEST]**
- **Turn on immutable releases** in the repo settings: after publishing, the tag and files cannot change. GitHub's
  advised flow for them is ours: draft, attach, publish. **[S GH-IMM]**
- **A tag ruleset** so only Tyler may create, move or delete `v*` tags. **Tyler's account:** a passkey or 2FA, and a
  look through his tokens and authorised apps. **[I]**
- **A rule for agents** (the lead's call, for `AGENTS.md`): agents may prepare a draft. Only Tyler publishes.

**Does code signing change the story? Yes.**
- A signed build gets `publisherName` baked in, and the updater then refuses any installer not signed by that
  publisher. An attacker would need the certificate as well as GitHub. It also quiets SmartScreen. **[S EU, ABL, MS]**
- **It can be added later.** An installed unsigned copy has no publisher name, so it accepts the first signed
  update, and the check starts from that version. Going back to unsigned would lock those copies out. **[S EU]**
- **Version 27 adds a cheaper guard, signed manifests.** The builder signs `latest.yml` with an Ed25519 key and the
  app refuses an unsigned or altered one before downloading. Older copies keep working; protection starts one
  release after adoption. **[S EB27]** It is the right next step once 27 is stable, with no certificate and no
  cost. With the key in a GitHub secret it stops a leaked contents-only token or a swapped file, not a full
  takeover of Tyler's account. **[I]**

## 3. The release flow

Three traps in the 26.18.0 code. Each breaks the flow quietly:

1. **`publish: null` in `electron-builder.yml` turns everything off.** No `latest.yml` is written and no
   `app-update.yml` goes into the app. It must become a `github` entry with `owner` and `repo` written out. **[S ABL]**
2. **With a `publish` entry, the build on `main` starts failing.** With no `--publish` flag the builder sees CI,
   decides to publish, and throws "GitHub Personal Access Token is not set". Pull request builds skip that step, so
   it shows only after the merge. `dist:win` must pass `--publish never`; both update files are still written.
   **[S ABL `PublishManager.js`, EP]**
3. **The file name.** The installer is `Sims Helper Setup <v>.exe`. For GitHub, `latest.yml` names it
   `Sims-Helper-Setup-<v>.exe`, the updater also turns spaces into dashes, and GitHub renames uploads that hold
   special characters. Upload the file under the exact name in `latest.yml`, or every update fails with "not
   found". **[S ABL, EU `GitHubProvider.resolveFiles`, GH-ASSET]**

The builder never publishes for us, which keeps the write token away from it. The flow is plain `gh`:

```yaml
# .github/workflows/release.yml (shape, not final syntax)
on: { push: { tags: ['v*'] } }
permissions: {}
jobs:
  build:      # windows-latest, contents: read
    # checkout, node 22, npm ci; fail unless the tag is "v" + package.json version;
    # typecheck, fixtures, npm test, npm run dist:win;
    # stage: copy the installer to the name in latest.yml, recompute its SHA-512, fail on a mismatch;
    # proof: install the newest published release, update it to this build (skip when there is none);
    # upload the staged folder as an artifact
  publish:    # ubuntu-latest, needs: build, contents: write, no checkout, no npm
    # download the artifact; gh release create "$TAG" staged/* --draft --verify-tag
```

**How Tyler ships an update:**
1. Merge the feature PRs.
2. Merge one small PR that raises `version` in `package.json` (0.2.0 to 0.3.0). The app compares versions, so a
   release with the same number is never offered. **[S EU]**
3. Push the tag `v0.3.0` on that commit (an agent can).
4. Wait for the `release` workflow. It tests, builds, proves the last release can update to this one, and leaves a
   draft.
5. Open the draft on GitHub and click **Publish release**.
6. Lila opens Sims Helper, sees "A new version is ready", and clicks **Update now**, then **Restart now**.

**Draft or published:** a draft is invisible to the app and can be deleted. A pre-release is ignored too, as long
as version numbers stay plain (`0.3.0`, never `0.3.0-beta.1`). **[S EU, GH-LATEST]** **A bad release:** there is no
rollback. Publish a fixed, higher version; if the bad one cannot start, she installs the fix by hand. **[S EU] [I]**

## 4. What she sees

- **A check when the app opens,** and again after 24 hours if it stays open: three small requests to GitHub. **[S EU]**
- **Nothing downloads without her click.** The updater's defaults are the opposite (`autoDownload` and
  `autoInstallOnAppQuit` are `true`), so the wrapper sets both to `false` before the first check. **[S EU]**
- **A calm banner under the header,** only when there is something to do: "A new version of Sims Helper is ready."
  **Update now** / **Later**; then "Getting the update… 42%"; then "The update is ready. Sims Helper will close and
  open again to finish." **Restart now** / **Later**.
- **Two clicks on purpose:** the app never restarts by itself. One click (restart as soon as the download ends) is
  possible and is a question for Tyler.
- **Install on restart only.** **Restart now** runs `quitAndInstall(true, true)`: a silent install, then the app
  opens again. The templates confirm an assisted installer honours a silent forced run. **[S EU, NSIS]** After
  **Later**, the next launch offers it again and reuses the finished download after a checksum check. **[S EU]**
- **If the game is running:** it does not matter. The updater touches only the app's install folder and its own
  cache, never the game or the Sims folder.
- **If the helper is mid-change** (backup, fix, undo, a 50/50 move): refuse **Restart now** until it is done. A
  restart there is a power cut. The journal recovers from one, but we should not cause it.
- **Failure:** a failed check on start shows nothing. A failed download says "The update didn't download. Nothing
  changed." with **Try again**. A failed manual check says "Couldn't check right now."
- **After an update** the installer starts the app with `--updated`, so it can say "Sims Helper was updated."
  **[S NSIS `common.nsh`]**
- **What a check sends:** her IP address, as any web request does, and `User-Agent: electron-builder`. No name, path
  or scan data. One thing to switch off: the updater makes a random id (a file named `.updaterId`) and sends it as
  `x-user-staging-id` on every check. Setting that header ourselves replaces the value (tested), so the id never
  leaves her PC. **[S EU, BUR, TEST]**

## 5. How it fits the app's rules

**Where the updater writes** (none of it through the gate):

| What | Where | Who |
|---|---|---|
| The downloaded installer, `update-info.json` | `%LOCALAPPDATA%\sims-helper-updater\pending\` | electron-updater **[S EU, ABL]** |
| `.updaterId` | Electron's own data folder under `%APPDATA%` | electron-updater, at the first check **[S EU]** |
| New app files, shortcuts, the uninstall entry | the install folder (default `%LOCALAPPDATA%\Programs\Sims Helper`), `HKCU` | the NSIS installer, a separate program **[S NSIS]** |

It never writes to the Sims folder or to `dataDir` (`%LOCALAPPDATA%\SimsHelper`: backups and set-aside mods). In
update mode the old uninstaller removes only the install folder. App data is deleted only by a real uninstall with
that option on, and then only folders under `%APPDATA%`. **[S NSIS `uninstaller.nsh`]**

**Is writing outside the gate acceptable? Yes, as a named exception.**
- The gate protects her game files and the app's own records. The updater touches neither.
- The gate could not do this job: the installer is another process, and the first install was never the gate's
  business. Rebuilding the downloader inside the gate would mean rewriting the checksum code for no gain.
- Conditions: **one file,** `src/main/update/updater.ts`, is the only one that may load `electron-updater`, and
  `contracts.md` section 1 names the exception. The wrapper turns updates off when the install folder is inside
  Documents or OneDrive: the wizard lets her pick the folder, and an update empties that folder. **[S NSIS]**

**What the lint test must allow.** `gate-lint.test.ts` scans only `src/`. PR 8's version is an allow-list, so it
needs one entry: `electron-updater`, for `main/update/updater.ts` only. The updater's own file and process code is
inside the bundled package, where the lint does not look, so the one-file rule is the containment. `updater.ts`
must use `import`: the lint forbids the word `require`. **[S REPO]**

**Bundling works.** Every package here is a `devDependency` that Vite bundles. In a throwaway project with the same
electron-vite and Vite versions, electron-updater 6.8.11 bundled into one file and loaded. **[S TEST]**

## 6. What "unsigned" means for updates

- **SmartScreen on each update: probably not.** It checks files that carry the "downloaded from the internet"
  mark. A browser adds that mark; the updater's own download does not, and it starts the installer directly.
  **[I]**, widely reported, provable only on her PC. The hand-delivered first install still warns. **[S MS]**
- **Smart App Control** (Windows 11) blocks unsigned programs however they arrived. If it is on, the first install
  fails too, so G1 answers this. **[S MS]** **Antivirus** may hold a fresh unsigned installer: the update fails and
  the old version stays. **[I]**
- **No admin prompt for a per-user install.** A silent update reuses the folder and mode in the registry. **[S NSIS]**
- **What breaks that:** the wizard's "Anyone who uses this computer" choice. Every silent update then raises a UAC
  prompt. **[S NSIS `installer.nsi`]** Fix: force per-user with the `customInstallMode` macro in
  `build/installer.nsh`. It removes one wizard page, so it is Tyler's call.
- **A file in use.** In update mode the old files are moved aside first and put back if one is locked, so a failed
  removal leaves the old version working. A failure later, while copying new files, can leave a broken install. The
  cure is a reinstall by hand; her game files and the app's data are not involved. **[S NSIS] [I]**

## 7. Not proven yet

- Section 6 on her real PC. Add to G1: is Smart App Control on, did she pick "Only for me", and did any warning
  appear at the first real update.
- The silent update and restart on real Windows, and building the second installer with
  `-c.extraMetadata.version`. The CI proof in `briefs/pr-13.md` settles both, and prints the real folders.

## 8. Document changes for the lead (three are mismatches with what I found)

1. `plan.md`, "Delivery" row, says the repo is private. `gh` says **public**, as does that file's "After v1" list.
2. `contracts.md`, section 1: "No file under `src/` except `gate.ts` imports anything that changes the disk." The
   updater needs a named exception.
3. `AGENTS.md`: "The app only acts when she clicks." A check on start is a network read with no click. Suggested:
   "Checking for an update reads one small file from GitHub and changes nothing. Downloading and installing wait
   for her click."
4. `AGENTS.md`, new rule: agents may prepare a draft release; only Tyler publishes one.

## Sources

- **npm:** `npm view electron-builder dist-tags` and the same for `electron-updater`, 2026-11-24.
- **EU:** electron-updater 6.8.11 unpacked from npm, `out/`: `AppUpdater.js`, `BaseUpdater.js`, `NsisUpdater.js`,
  `DownloadedUpdateHelper.js`, `AppAdapter.js`, `providers/GitHubProvider.js`, `providers/GenericProvider.js`.
  **BUR:** builder-util-runtime 9.7.0, `out/httpExecutor.js`. **EP:** electron-publish, `out/gitHubPublisher.js`.
- **ABL:** app-builder-lib 26.18.0 in this repo's `node_modules`, `out/`: `publish/PublishManager.js`,
  `publish/updateInfoBuilder.js`, `appInfo.js`, `platformPackager.js`. **NSIS:** its `templates/nsis/`:
  `installer.nsi`, `installSection.nsh`, `assistedInstaller.nsh`, `multiUserUi.nsh`, `uninstaller.nsh`, `common.nsh`.
- **EB27** (describes version 27): electron.build/docs/features/auto-update, `/security`, `/signed-update-manifests`.
- **EL:** electronjs.org/docs/latest/tutorial/updates and `/api/auto-updater`.
- **GH-TOKEN:** docs.github.com, "Workflow syntax" (`permissions`), "Events that trigger workflows" (fork pull
  requests), "Use GITHUB_TOKEN for authentication in workflows". **GH-IMM:** "Immutable releases".
  **GH-LATEST, GH-ASSET:** docs.github.com/en/rest/releases ("Get the latest release", "Upload a release asset").
  **GH-CLI:** cli.github.com/manual/gh_release_create.
- **MS:** learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation.
- **CF:** developers.cloudflare.com, Cloudflare Tunnel. **TS:** tailscale.com/kb/1223/funnel.
  **LE:** letsencrypt.org/docs/challenge-types.
- **REPO:** `origin/wells/contracts`, `wells/pr-08-gate` (`gate-lint.test.ts`), and `gh api` on this repo's Actions
  settings. **TEST:** a throwaway project in the session scratchpad (electron-vite 6, Vite 8), loaded in Node.
