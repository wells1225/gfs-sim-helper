# Electron auto-update, from X

Searched X from 1 May 2025 through 24 Nov 2026. Every item is a post. Treat it as opinion unless the line says the account is a company account. No Electron org account posted on these queries. `@Free_BlackHole` says in his bio that he is an Electron member; that is his claim, not an org post.

Searches that returned nothing in this window: the string `latest.yml`; `electron-updater` with private repo, `GH_TOKEN`, or `GITHUB_TOKEN`; update loops; `sha512` mismatch; a home server or `generic` provider hosting an Electron update feed, and any incident on one.

## GitHub Releases and electron-updater

**Stale cache skips the check.** [@Kraggich, 14 May 2026](https://x.com/Kraggich/status/2054985817265750185) (Nyx 0.6.5): auto-update stalled with no error because a stale `pending/` cache made electron-updater skip GitHub checks. His fix: wipe that cache at startup.

**GitHub API limit, or a tag with no metadata.** [@libapi_, 2 Jun 2026](https://x.com/libapi_/status/2061824556722233822) (Hermes Studio 0.6.9): the desktop check falls back to the release feed when the GitHub API is rate-limited or the tag path has no metadata. On macOS, quit-and-install did nothing until they stopped a local Web UI server first, then handed the quit to electron-updater.

**The manifest is the switch, and drafts do not count.** No post named Windows `latest.yml`. The macOS file `latest-mac.yml` is the same job. [@aronprins, 13 Apr 2026](https://x.com/aronprins/status/2043758508051448140) (Paperclip Desktop, Electron or Tauri): electron-updater reads `latest-mac.yml` only from a published GitHub Release, not a draft. Publishing that file before notarization finishes lets clients pull a signed but unnotarized build. If the update never appears, the file is missing or on the wrong release. His recovery if it went up too early: delete the release and stage again without the manifest. He also says `*.blockmap` is what makes the delta small, and that electron-builder has to re-package the stapled `.app`, so a rebuild between sign and staple breaks the ticket. This is a macOS notarization pipeline, not an NSIS field report.

**Deltas, and when they become a full download.** [@EEEEYHN, 20 May 2026](https://x.com/EEEEYHN/status/2057053862666834357) tells every Electron app to leave electron-builder for Velopack: hundreds of KB instead of hundreds of MB, and a later jump from Electron to Tauri or native without a reinstall. [@zhcf1ess, 20 May 2026](https://x.com/zhcf1ess/status/2057167107075584432) answers that electron-builder `.blockmap` already does about 3 MB a day for Syncless, with a fast restart. [@subframe7536, 20 May 2026](https://x.com/subframe7536/status/2057066854208950437) points at `electron-vite/electron-incremental-update` instead.

[@Free_BlackHole, 22 May 2026](https://x.com/Free_BlackHole/status/2057658229883302198) tried the move and would stay on blockmap unless updates are frequent and small and you accept the extra upkeep. His notes on the same thread:

- [Blockmap and Range](https://x.com/Free_BlackHole/status/2057658229883302198): if the CDN does not honor Range requests, electron-builder falls back to a full download.
- [Where the diff is made](https://x.com/Free_BlackHole/status/2057655225465610252): electron-builder does not need the previous build on the CI machine; the client computes the diff from one blockmap, including a jump across several versions. Velopack must download the previous nupkg at build time, then either chain nupkgs or fall back to a full file.
- [What the migration cost](https://x.com/Free_BlackHole/status/2057628279818047636): electron-builder still produces the unpacked dir and deep-signs it; Velopack packs, signs, and notarizes; you add a .NET `vpk` runtime, build the dmg yourself, and he thinks leaving Velopack later would be expensive.

No post in this window described an NSIS differential bug, an update loop, a private-repo token failure, or a broken `latest.yml`.

## Unsigned Windows apps

Posts describe SmartScreen on the first run of an unsigned installer. None said it returns on every later update, and none reported a Defender false positive on an electron-updater download.

- [@CarlosR26271158, 8 May 2026](https://x.com/CarlosR26271158/status/2052881789128171980): unsigned NSIS, SmartScreen "publisher unknown" the first time, then electron-updater. He tells people More info, then Run anyway.
- [@thisguyknowsai, 1 Sep 2026](https://x.com/thisguyknowsai/status/2094759718602641409): community Hermes desktop is unsigned on Windows, so SmartScreen warns on first launch. He also says the `.rpm` is not GPG-signed and cannot auto-update. That second point is Linux packaging, not NSIS.
- [@rvm0n_, 15 Jul 2026](https://x.com/rvm0n_/status/2077469967100833881): his ship list pairs notarize/sign with adding electron-updater. No failure written down.
- [@ahadkholiqov, 28 Sep 2026](https://x.com/ahadkholiqov/status/2104594777106677843): a Tauri app, not Electron. He shipped a per-user NSIS install with no admin, and a path the user can see. Adjacent only.
- [@JamesArslanSwe, 23 Nov 2026](https://x.com/JamesArslanSwe/status/2124885062936060043): design choice, not a bug. Per-user install, no admin, no background update check, SHA-256 on the kits, Electron version pinned.

## Self-hosting the feed

No post reported trouble or a breach from serving Electron updates off a home server, or from electron-updater's generic provider. A "self-hosted Electron build service" post ([@ucworkroom1, 19 Jun 2026](https://x.com/ucworkroom1/status/2067996700396970270)) is not an update-feed report.

The nearest desktop-updater story is not Electron. [@FlyanLu, 16 Nov 2026](https://x.com/FlyanLu/status/2122341822764888381) (水杉输入法, Windows): background auto-update had never run, so 0.13.2 and older never saw a prompt and had to use Check for updates or a manual download. The check now follows the user's proxy, a dropped download resumes, and the digest and signature are checked again before install. A wizard started from Settings vanished on the install step. Useful as a "dead updater strands old clients" report, not as electron-updater evidence.

## Supply chain

No post in this window was a confirmed takeover of a small app's electron-updater channel or its GitHub Release feed. What people did post, nearby:

**A signed NSIS helper can be the bug.** [@takaradariku, 30 May 2026](https://x.com/takaradariku/status/2060730610331910487) (339 likes): electron-builder's NSIS packaging includes a hack that raises privileges, so signed exes can show a trusted UAC prompt and then run something else. [@Galkon, 31 May 2026](https://x.com/Galkon/status/2060981219610022385), previously at Medal, says Squirrel.Windows, Chrome, Edge, and Steam have the same class of problem, and blames the Windows elevation dance.

**Publish the manifest last.** Same Aron post as above: the auto-update file is how a bad build reaches machines with no extra click. He keeps the GitHub Release as a draft until the final artifacts exist.

**npm, not a desktop channel, is what people warn about.** [@0xKaiSec, 22 Nov 2026](https://x.com/0xKaiSec/status/2124372089675370629): Shai-Hulud, Sep 2025, poisoned 500+ npm packages and stole keys from the install step. He says pin versions, read the diff, do not blind-install a fresh update. [@jpaulommatias, 23 Nov 2026](https://x.com/jpaulommatias/status/2124872724271006089) says CISA asked people to review dependencies, pin versions, and use phishing-resistant MFA. That is his summary of CISA, not a CISA post. [@liran_tal, 23 Nov 2026](https://x.com/liran_tal/status/2124847452092006590) (Snyk, Node.js security) treats an unexpected offer to buy a maintainer's project as a possible supply-chain approach, citing Shai-Hulud and the `user-agent` npm incident.

**Fake "update" outside Electron.** [@GuardianAudits, 22 Nov 2026](https://x.com/GuardianAudits/status/2124503246463213818) (company account): axios, 31 Mar, attackers posed as a company founder on a Teams call, a fake update installed a trojan, then two npm releases went out from the maintainer's account. [@vxunderground, 10 Oct 2026](https://x.com/vxunderground/status/2108778178604884149): a fake Toast POS update domain and an MSI, not an app's real feed. [@rst_cloud, 19 Nov 2026](https://x.com/rst_cloud/status/2123450631264391608) summarizes HDGfx, which calls an update server and strips Authenticode. [@DFIR_Radar, 6 Nov 2026](https://x.com/DFIR_Radar/status/2118811362566578645): fake GitHub security tools drop an Electron loader named `Microsoft.exe`. [@DFIR_Radar, 20 May 2026](https://x.com/DFIR_Radar/status/2057009454047179256): ValleyRAT via fake Teams sites and NSIS. These are lures that use GitHub, NSIS, or the word "update." They are not a hijacked electron-updater feed.

**A company account on auto-update as a patch path.** [@CheckmarxZero, 12 Nov 2026](https://x.com/CheckmarxZero/status/2120989516009800111): CVE-2026-88968 in Claude Code. They say auto-update should have moved people to 2.1.251 or later, and manual installs still need an upgrade. That is a vendor-tool advisory, not a small-app channel breach.

## What this search does not support

Nobody on X in this window posted a working recipe for private-repo GitHub updates, an NSIS update loop, SmartScreen on every unsigned update, an antivirus hit on a differential download, or a home-server update feed that was attacked. Those silences are the result of the searches above, not evidence that the problems never happen.
