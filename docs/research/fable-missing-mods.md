# Getting a missing CurseForge mod onto the receiving PC (plan PR 14)

Checked 2026-11-24. Each line is tagged **[Read]** (I read the page that day, URL given), **[Seen]** (observed in a
live page's HTML that day), **[Snippet]** (search summary only, page not read) or **[Guess]** (my reasoning, untested).
Nothing here was tested on a Windows PC with the CurseForge app: see "Could not confirm".

**Short answer:** our app opens CurseForge's own install link for each missing mod, and the CurseForge app does the
download and install. Our app downloads nothing and needs no API key. The ranking table is near the end.

## 1. CurseForge app's own sharing: not found for The Sims 4

- **[Read]** "Share Profile", export as .zip and 7-day profile codes are documented only under the Minecraft folder;
  the steps say "Go to the Minecraft tab". Neither article names The Sims 4.
  <https://support.curseforge.com/support/solutions/articles/9000197912-sharing-modpacks-custom-profiles> ·
  <https://support.curseforge.com/support/solutions/articles/9000198501-exporting-and-importing-modpacks>
- **[Read]** Import takes only modpacks/custom profiles: "Other content types (individual mods, worlds, data packs,
  etc.) cannot be imported this way." (same articles)
- **[Read]** The Sims 4 getting-started article mentions no profiles, modpacks, collections, mod lists, sharing,
  export, import or codes. The support index lists three Sims 4 articles; none covers sharing.
  <https://support.curseforge.com/support/solutions/articles/9000221982-the-sims-4-mods-getting-started>
- This is an absence in the docs, not proof. The app's Sims 4 tab was not looked at. **[Guess]** It has none, which
  fits the Neon doc's "single live installation, no isolated profiles".

## 2. `curseforge://` deep link: exists for The Sims 4

- **[Seen]** The Sims 4 mod page has an "Install via App" button that goes to
  `https://www.curseforge.com/sims4/mods/<slug>/install/<fileId>`. That page ("Installing... Hang tight! Your mod
  should start installing in the CurseForge app") contains this link in its HTML:
  `curseforge://install?addonId=663350&fileId=9396860`
  (MC Command Center: project ID 663350, file 9396860). Read with a headless browser; a plain fetch gets HTTP 403.
  <https://www.curseforge.com/sims4/mods/mc-command-center/install/9396860>
- **Format:** `curseforge://install?addonId=<project ID>&fileId=<file ID>`. Both are integers. No game ID is in it.
- **[Read]** CurseForge's Sims 4 article describes the same flow: "If you already have the CurseForge app installed
  just click 'Open CurseForge' and the mod will be installed right away."
  <https://support.curseforge.com/support/solutions/articles/9000221982-the-sims-4-mods-getting-started>
- **[Read]** The same format was reported for WoW (2020) and Minecraft (2021). CurseForge publishes no spec for
  it, so it could change. <https://github.com/WowUp/WowUp/issues/462> ·
  <https://github.com/gorilla-devs/GDLauncher/issues/1055>
- **Two ways to fire it [Guess]:** (a) open the `curseforge://` link from our app (Electron `shell.openExternal`):
  no browser tab, one click; (b) open the `https://www.curseforge.com/.../install/<fileId>` page: CurseForge's own
  page fires the link and offers "Try Again", but the browser asks "Open CurseForge?" and the URL needs the slug.
- **What our app must have:** `addonId` and `fileId` for each mod on the sending PC. The only source without an API
  key is CurseForge's local `AddonGameInstance.json` (`addonID`, `installedFile.id`), which the Neon doc marks as
  inferred for The Sims 4, not verified on a real install. Option 2 rests on that file holding these two numbers.
- **Why it is the safest [Guess, untested]:** the download and the write into `Mods/` are done by the CurseForge
  app, as when she clicks Install herself, so CurseForge should track and update the mod as usual.
- **Trust boundary [Guess]:** the mod list in the shared folder is input from outside. Accept only two positive
  integers and build the link ourselves; never open a link string from the list. Rescan `Mods/` afterwards and
  tick off what arrived, instead of trusting that the link worked.
- **Open decision: the name in the list is not proof of what the ID installs.** The name and the IDs come from the
  same list, and without a key PC 2 cannot look the ID up. Whoever can write to the Drive folder could put in the
  ID of a bad upload, and the direct link installs "right away" without showing CurseForge's page. Choices:
  - **page first:** open `curseforge.com/projects/<id>` (section 4), he sees the real page and clicks "Install via
    App": about 2 clicks per mod, no new code;
  - **seal the list:** both apps share a pairing code and the sender's app signs the list (HMAC); PC 2 fires direct
    links only for a list whose seal checks. One click per mod. The seal is extremely sensitive code;
  - **keyed name lookup** (section 3) before firing: needs the API key on each PC;
  - **accept the risk** for a two-PC household folder.
  My pick **[Guess]**: seal the list if PR 14 pairs the PCs anyway; otherwise page first.
- **Backup and undo rule:** here the CurseForge app writes to `Mods/`, outside our write gate, on our app's click.
  The planner must decide what backup and undo mean: for example a snapshot of the `Mods/` listing before firing,
  and undo that sends him to CurseForge's own Delete. **[Snippet]** Deleting a CurseForge-installed file by hand
  leaves CurseForge thinking it is still installed.

## 3. CurseForge API: possible, not recommended for downloads

- **[Read]** A key is needed (`x-api-key`). It is requested through a form and reviewed by Overwolf, which looks at
  the impact on authors' earnings, on CurseForge's servers and CDN, and at "Authors' consent when it comes to third
  party distribution". No review time or personal-use rule is stated. **Owner-only step.**
  <https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key>
- **[Read]** Terms (modified 14 Aug 2024):
  <https://support.curseforge.com/support/solutions/articles/9000207405-curseforge-3rd-party-api-terms-and-conditions>
  - §2.2: the key is "non-transferable and may not be shared with any third party";
  - §3.1: no "save or cache any data obtained through the API", so API data may not go into the shared mod list;
  - §3.1: nothing that "competes, directly or indirectly, with CF"; §1.1: the app must add "substantial
    functionality above and beyond" the API;
  - §2.3: the quota is at Overwolf's discretion, no number given;
  - the terms do not mention putting a key inside a distributed program, or downloading mod files.
- **[Guess]** A key inside an installer handed to a second person's PC is hard to square with §2.2. Each PC would
  need the owner's key typed in and kept in the AI key store's kind of storage, or the feature skips the API.
- **[Read]** Authors can turn third-party distribution off; then a third-party client "will not have access to your
  projects or files via the 3rd-party API". Existing projects default to on. A third-party download "will not count
  towards your total downloads nor towards your Reward Program earnings", so it costs the creator money.
  <https://support.curseforge.com/support/solutions/articles/9000207877>
- **[Read]** API docs: `Mod.allowModDistribution` (boolean or null, "Is mod allowed to be distributed");
  `File.isAvailable`, `File.downloadUrl`, `File.fileLength`, `File.hashes[]` (`algo` 1 = SHA1, 2 = MD5),
  `File.fileFingerprint`, `File.modules[]` (name, fingerprint);
  `GET /v1/mods/{modId}/files/{fileId}/download-url`. <https://docs.curseforge.com/rest-api/>
- **[Read]** Sims 4 uploads must be zipped ("Even if its a single .package file"), so `hashes` and `fileLength`
  describe the zip, not the files that end up in `Mods/`.
  <https://support.curseforge.com/support/solutions/articles/9000197279-moderation-policies>
- **If we ever did download, the app would have to [Guess]:** take `downloadUrl` only from the API over HTTPS and
  only when `allowModDistribution` and `isAvailable` are true; check the zip's length and SHA-1 against
  `fileLength` and `hashes` before unpacking, failing closed; unpack in a staging folder, rejecting paths that
  leave it and any file that is not `.package` or `.ts4script`; back up, then write through the write gate.
- **What that check does not give:** a matching SHA-1 proves "this is the file CurseForge hosts". It says nothing
  about whether the file is safe (see section 5: bad uploads have been live on CurseForge). And a mod our app
  installs is not tracked by the CurseForge app ("These mods cannot be managed through the app"), so she would lose
  its Update button. **[Read]** getting-started article above.
- **If a key is ever wanted, keep it read-only:** names, page links and "is a newer file out" (already the Neon
  doc's recommendation). PR 14 does not need one.

## 4. Fallback: the mod's CurseForge web page

- **[Seen]** `https://www.curseforge.com/projects/<project ID>` redirects to the mod's page
  (`/projects/663350` went to `/sims4/mods/mc-command-center`). So the numeric ID alone is enough; no slug or API.
- **[Seen]** That page has "Install via App" (the section 2 flow) and a files list with a manual download.
- Use it when the deep link does nothing (CurseForge app not installed, mod or file removed), and as the "See this
  mod" link beside every row. It costs two or three clicks instead of one.

## 5. Manual (non-CurseForge) mods

- **[Read, F-Secure, 10 Sep 2024]** A Sims 4 infostealer was "hidden in a .ts4script file". It took browser
  passwords, cards and cookies, Discord tokens, Steam logins and crypto wallets. It was spread by a fake ModTheSims
  profile and by a new CurseForge account posing as a known creator.
  <https://www.f-secure.com/en/articles/malicious-mods-the-sims-4-infostealer-threatens-gamers-security>
- **[Seen, EA Forums community thread]** Compromised script mods were on Mod the Sims, The Sims Resource (hacked
  creator accounts), LoversLab, Nexus and CurseForge ("Social Events - Unlimited Time" in 2024; another in May 2026,
  "removed soon afterward"). "The least likely mods to be affected were mods that are only .package files and mods
  uploaded by mod creators on Patreon or their own sites." "Curseforge and The Sims Resource updated their file
  screening for this method of malware inclusion." It recommends TwistedMexi's ModGuard. <https://forums.ea.com/discussions/the-sims-4-mods-and-custom-content-en/malicious-script-mods-and-other-malware/9362227>
- **[Read]** CurseForge says uploads "go through a series of processors, automated checks, and manual reviewing";
  it does not say what is scanned. (moderation policies, above)
- **[Guess]** A `.ts4script` is a zip of Python the game runs with her Windows user's rights, so copying one is
  copying a program. A `.package` holds game data (objects, tuning), not a program. Not read from a primary source.
- **Options:**
  - **Name + link from the sender (recommended).** The list carries the file name, size, and a link the sender
    typed or we know. The receiver opens the creator's page and gets it himself. Open only `https://` links, show
    the full address first.
  - **Copy `.package` files through the shared folder (acceptable, opt-in).** The sender's app writes a SHA-256 for
    each; the receiver checks it. That proves "same file the sender has", nothing more. Still goes through backup
    and the write gate. **[Guess]** Some creators' terms forbid passing on paid or early-access files; between two
    PCs of one household this is small, but say it in the UI.
  - **Copy `.ts4script` files: no.** If the sender's PC ever picked up a bad script mod, the shared folder would
    carry it to the second PC with our app's help, and anyone who can write to the Drive folder could plant one.
    Show "get this from the creator" instead. Many manual script mods (MCCC and others) are on CurseForge anyway.

## Ranking for this user

| Rank | Option | Safety | Clicks | Needs |
| --- | --- | --- | --- | --- |
| 1 | Deep link `curseforge://install?addonId=&fileId=` | CurseForge app does everything; ID unproven unless the list is sealed | 1 per mod | IDs in the list; CurseForge app on PC 2; the open decision in section 2 |
| 2 | Web page `curseforge.com/projects/<id>` | He sees the real page first | 2 to 3 | project ID |
| 3 | Manual mod: name + link | He chooses the source | several | sender's link |
| 4 | Manual `.package` copy with sender hash | Data file, same as sender's | 1 | opt-in, write gate |
| 5 | API download + hash check | Integrity only; untracked by CurseForge | 1 | key, review, terms |

Ruled out: copying `.ts4script` files (code we cannot verify) and CurseForge profile codes (not offered for Sims 4).

## Owner-only steps

- **Test on a real Windows PC with the CurseForge app** (15 minutes, before PR 14 is built on this):
  1. paste `curseforge://install?addonId=663350&fileId=9396860` into Win+R: does the mod install with no further
     click, and is it the pinned file or the latest?
  2. the same when the mod is already installed at another version, and when the game is not linked in CurseForge;
  3. three links one after another: do all three install?
  4. open `%APPDATA%\CurseForge\agent\GameInstances\AddonGameInstance.json` and confirm it lists `addonID` and
     `installedFile.id` for The Sims 4 mods.
- **API key:** only if the read-only uses are wanted. Apply through the form; put the key in by hand on each PC.

## Could not confirm

- How the CurseForge app behaves on the deep link (the tests above). The link on the Sims 4 page and the support
  text are the only evidence. That `AddonGameInstance.json` has those fields for The Sims 4 (inferred by Neon).
- That the CurseForge app has no Sims 4 share feature (docs are silent; app not inspected).
- What the API returns for a mod with distribution off (the Neon doc says a null `downloadUrl`; the docs read do
  not say), the download host, and the review time for a key.
- EA's own help page on mods (timed out). What CurseForge's file screening checks.

**Mismatch with the Neon doc (not edited):** it says the terms forbid embedding the key "in a publicly distributed
desktop binary". The terms as read do not mention embedding; §2.2 only bars sharing or disclosing the key.
