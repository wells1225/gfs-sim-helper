# Sims 4 helper: files, logs and safety facts

Research only, 2026-11-24. Scope: the facts that could cost the player data if the program gets them wrong.

**How to read the marks**

- **S** = sourced: I opened the page or source file and saw the text. The source ID follows in brackets.
- **I** = inferred: follows from sourced facts, or from memory, or from a search summary of a page I could not open.
  Treat every **I** as something to verify on her machine before the program acts on it.
- **Win / Mac** flags a difference between Windows and macOS.

**What I could not open:** every `forums.ea.com` / `answers.ea.com` page (EA Answers HQ) is behind a Cloudflare bot
check, and the Wayback Machine holds only the blocked copies. Patreon posts returned 403. Facts that rest only on those
are marked **I**. The old `forums.thesims.com` is readable through the Wayback Machine.

## Sources

| ID | What | URL |
|---|---|---|
| EA1 | EA Help: Mods, game updates, and error codes | https://help.ea.com/en/help/the-sims/the-sims-4/mods-and-the-sims-4-game-updates/ |
| EA2 | EA Help: How to back up and reset The Sims 4 | https://help.ea.com/en/articles/the-sims/the-sims-4/backing-up-and-resetting-the-sims-4/ |
| EA3 | EA Help: Recover a past saved game (updated mid-2026) | https://help.ea.com/en/articles/the-sims/the-sims-4/how-to-restore-a-previous-saved-game/ |
| CR1 | Crinrict: User files explained (updated 2025-08-26) | https://sims4.crinrict.com/eng/2014/09/user-files-explained/ |
| CR2 | Crinrict: How to find your user folder | https://sims4.crinrict.com/eng/2018/07/how-to-find-your-user-folder/ |
| CR3 | Crinrict: Custom Content and Mods | https://sims4.crinrict.com/eng/2014/08/custom-content-and-mods/ |
| CR4 | Crinrict: Mods/CC doesn't show up | https://sims4.crinrict.com/eng/2018/11/mods-custom-content-doesnt-show-up/ |
| CR5 | Crinrict: Backups | https://sims4.crinrict.com/eng/2014/09/backups/ |
| CR6 | Crinrict: Save Games | https://sims4.crinrict.com/eng/2014/09/save-games/ |
| SGMS | Maxis dev post (SimGuruModSquad, Sept 2015), archived | https://web.archive.org/web/20240821005558/https://forums.thesims.com/en_US/discussion/855532 |
| MCCC | MC Command Center: Troubleshooting (Deaderpool) | https://deaderpool-mccc.com/troubleshooting.html |
| DBPF | TS4 Modders Reference: DBPF format (updated 2025-10-06) | https://ts4-modders-reference.pages.dev/reference/dbpf-format/ |
| PACK | TS4 Modders Reference: Pack Data (updated 2026-11-15) | https://ts4-modders-reference.pages.dev/reference/pack_data/ |
| GRP | TS4 Modders Reference: Restricting a file to a pack using Group ID | https://ts4-modders-reference.pages.dev/tutorials/restrict-pack-by-group-id/ |
| KUR | Kuree/Sims4Tools wiki: DBPF Format, Compression | https://github.com/Kuree/Sims4Tools/wiki/DBPF-Format |
| PB | PlumbBuddy source (Llama Logic, MIT) | https://github.com/Llama-Logic/PlumbBuddy |
| PBP | PlumbBuddy website source: text guides | https://github.com/Llama-Logic/PlumbBuddy-Pages/tree/main/src/pages/text-guides |
| LLP | LlamaLogic.Packages source (MIT) | https://github.com/Llama-Logic/LlamaLogic |
| TM | TwistedMexi's site (Better Exceptions listing) | https://twistedmexi.com/mods/better-exceptions |
| VTX | Vortex Sims 4 extension source (Nexus Mods, GPL-3.0) | https://github.com/Nexus-Mods/Vortex/blob/master/extensions/games/game-sims4/src/index.js |
| CF1 | CurseForge support: Getting started (Sims 4) | https://support.curseforge.com/en/support/solutions/articles/9000221982-getting-started |
| CF2 | CurseForge support: manual install guide | https://support.curseforge.com/en/support/solutions/articles/9000221442-downloading-and-installing-the-sims-4-mods-pc-manual-guide |
| CF3 | CurseForge support: troubleshooting | https://support.curseforge.com/support/solutions/articles/9000222156 |
| MTS1 | ModTheSims thread with a full lastException (2018) | https://modthesims.info/t/608369 |
| MTS2 | ModTheSims thread with a full lastException (2015) | https://modthesims.info/t/555726 |
| MTS3 | ModTheSims thread with a real lastCrash.txt attached (2014) | https://modthesims.info/t/536049 |
| BE1 | A player-posted Better Exceptions v2.03 report (2022) | https://rheall.me/sims-images/error-logs/Better%20Exceptions%20Full%20Report_4.html |
| SC1 | Sims Community: Last Exception guide | https://simscommunity.info/2022/07/15/last-exception-the-sims-4-mod-solution/ |
| SSA | sentient-sims-app: LastExceptionService.ts | https://github.com/guspuffygit/sentient-sims-app/blob/main/src/main/sentient-sims/services/LastExceptionService.ts |
| STM | Steam discussion on Options.ini mod keys (2024-12) | https://steamcommunity.com/app/1222670/discussions/0/4633737354676293934 |

PB file paths cited below are relative to the PlumbBuddy repository.

## 1. The user folder

### Where it is

| Claim | Mark |
|---|---|
| Default: `Documents\Electronic Arts\The Sims 4`. The game folder name differs per language. | S [CR2] |
| Localized names: `Die Sims 4` (de), `Les Sims 4` (fr), `Los Sims 4` (es), `De Sims 4` (nl), `Os Sims 4` (pt), `ザ・シムズ 4` (ja), `模擬市民4` (zh). Other languages use `The Sims 4`. | S [PB `Localization/AppText.*.resx`, key `UserDataFolderName`] |
| The French name is written with no-break spaces (U+00A0), not ordinary spaces. Compare folder names accordingly. | S [VTX, `LOCALE_MODS_FOLDER`] |
| The Documents folder is always used, but it may be the local one or a cloud one (OneDrive, iCloud). After an update the game sometimes switches to the other. Two `The Sims 4` folders can then exist, and the newer file dates usually mark the one in use. | S [CR2] |
| The sure way to learn the folder in use: in the game, Load Game and hover the folder icon, or Options > Game Options > Screen Capture. | S [CR2] |
| A path that contains `Desktop` is probably a backup; the game does not look there. | S [CR2] |
| Mac: same relative path, `Documents/Electronic Arts/The Sims 4/`. | S [CF2] |
| Win: resolve Documents through the system's known-folder call, never by building `C:\Users\<name>\Documents`. OneDrive moves it. PlumbBuddy uses `Environment.SpecialFolder.MyDocuments` and treats a folder as valid when `Options.ini` is inside. | S [PB `Components/Controls/FoldersSelector.razor.cs`] |
| Mac: iCloud "Desktop & Documents" sync is the equivalent hazard. It can move the folder to iCloud so the game makes a fresh empty one. | I (EA forum search summary; page not opened) |

**Design consequence:** never assume the path. Find candidates, show them with dates, and let her confirm. If two exist,
back up both before touching either [CR2].

### What each file and folder is

All rows are **S [CR1]** unless marked. "Recreated" means the game rebuilds it when missing.

| Name | What it is | Delete safely? |
|---|---|---|
| `saves/` | Save games. `Slot_<8 digits>.save` is the current save. `.save.ver0` to `.ver4` are the game's own five rolling backups. Also `scratch/` (exists only while playing; left behind after a crash). | **Never without a backup** |
| `Tray/` | Library households, lots and rooms. Several files per item sharing one ID (`.trayitem`, `.blueprint`, `.bpi`, `.hhi`, `.sgi`, `.householdbinary`, `.room`, `.rmi`). No subfolders allowed [CR3]. | **Never without a backup** |
| `Mods/` | Mods and custom content, plus `Resource.cfg`. | Back up first |
| `Screenshots/`, `Recorded Videos/`, `Custom Music/`, `VideoCameraStates/` | Her own media and saved camera positions. | No. Back up |
| `Options.ini` | Game and graphics options. Can become corrupted; removing it resets options to defaults. Editable in a text editor while the game is closed. | Back up, then yes |
| `Resource.cfg` (in `Mods/`) | Tells the game which `.package` paths to load. Recreated only when missing [SGMS]. | Yes; back up if she edited it |
| `localthumbcache.package` | Thumbnail cache. Grows fast. "Always delete this file after adding/removing CC and Mods." | **Yes** |
| `localsimtexturecache.package` | Cache of composited Sim textures, capped at 100 MB. | **Yes** |
| `avatarcache.package` | Gallery avatar image cache. | Yes (I: CR1 does not say "recreates"; PB clears it) |
| `houseDescription-client.package` | Cache. Recreated. | Yes |
| `clientDB.package` | Photography data; "only contains values while the game runs". | Yes when the game is closed (I; PB clears it) |
| `cache/` | Gallery pictures; should empty itself on exit. | **Yes** |
| `cachestr/` | Main-menu promotions (`spotlight_xx-yy.package`). Recreated. | **Yes** |
| `cachewebkit/` | Exists only while the game runs; a crash can leave it behind. | **Yes** |
| `onlinethumbnailcache/` | Pack preview pictures. Re-downloaded on demand. | **Yes** |
| `lotcachedata/`, `SavedSimsInfoData/`, `saves/SerialGUID/` | No longer used by the game. | Yes |
| `lastException*.txt`, `lastUIException*.txt` | Exception logs. "Can be safely deleted." | Yes, **after the program has read them** |
| `lastCrash*.txt` | Crash log. "Only readable by EA/Maxis. Can be safely deleted." | Yes, after reading |
| `GameVersion.txt` | Current game version. Updated only after the game has started. | Leave |
| `Config.log` | System information. Recreated. | Leave (useful for diagnosis) |
| `UserSetting.ini` | Tutorial tips seen, account and UI settings, and **which packs are disabled**. | No |
| `UserData.lock` | "Only used while the game is running." | Leave. See section 6 |
| `accountDataDB.package`, `notify.glob`, `TrayDeletedItems`, `ReticulatedSplines`, `ReticulatedSplinesView`, `Events.ini`, `GameConfig.ini` | Event data, global notifications, deleted default library items, cached or regenerated state. | Leave |
| `ConfigOverride/` | Her own graphics config overrides. | No. Back up |
| `content/`, `ConnectionStatus.txt`, `EAWebKitCookies.txt` | In-game delivery downloads (re-downloaded if removed); connection diagnostics; embedded-browser cookies. | Leave |

The cache set PlumbBuddy clears is exactly: `avatarcache.package`, `clientDB.package`, `houseDescription-client.package`,
`localsimtexturecache.package`, `localthumbcache.package`, `cachestr/`, `onlinethumbnailcache/`
(S [PB `Services/SmartSimObserver.cs`]). That list is a good conservative default for a "clear caches" button.

Mods also write their own files into `Mods/` and `saves/` (settings, logs, data folders). Removing a mod leaves them
behind (S [CR3], [CR6]). The program must not treat unknown files in `saves/` as junk.

**Two sources disagree on autosave, and it matters.** Crinrict says the game no longer autosaves and that
`Slot_00000001.save` and its backups "can be deleted" (S [CR6]). EA's current help page says the game has one
Autosave slot that is overwritten each time, and that older autosaves cannot be recovered (S [EA3]). EA's page is
newer. The program must never delete any `Slot_*.save` file on the strength of the older advice.

## 2. Mod file rules

| Claim | Mark |
|---|---|
| Two mod file types: `.package` (tuning mods and custom content) and `.ts4script` (script mods). | S [CR3], [CF2] |
| A `.zip`, `.rar` or `.7z` in Mods does not work. It must be unpacked. Zipped script mods can still appear in the game's mod list (an old format) but do not run. | S [CR3], [CR4] |
| Loose `.py`, `.pyc`, `.pyo` files are also treated as mod files by Vortex. | S [VTX `MODS_EXTENSIONS`] |
| A `.ts4script` is a zip archive of compiled Python. | I (memory; consistent with BE's "Junk Files: a script mod was accidentally unzipped" [BE1]) |
| The game-made `Resource.cfg` is: `Priority 500`, then `PackedFile *.package`, `PackedFile */*.package`, down to `PackedFile */*/*/*/*/*.package`. That is the Mods folder itself plus five subfolder levels. | S [SGMS], [VTX] |
| The game writes `Resource.cfg` only when the file is missing. It never updates an existing one. Deleting it makes the game write a fresh one. | S [SGMS] |
| So an old or hand-edited `Resource.cfg` can allow fewer or more levels than five. Before 1.11.64 (Sept 2015) the generated file was shallower. | S [SGMS] for the mechanism; I for "shallower" |
| `.package` deeper than the Resource.cfg allows is silently not loaded. | S [CR4] |
| **Script mods load at most one subfolder deep.** `Mods\MCCC\x.ts4script` works; `Mods\ScriptMods\MCCC\x.ts4script` does not, with no error and no log. | S [MCCC], [CR3], [CR4] |
| PlumbBuddy enforces the same limits: max depth 1 for script archives, 5 for packages. | S [PB `Services/Scans/Depth/*.cs`] |
| A higher `Priority` number wins when two packages hold the same resource. | I (Vortex writes its own block at Priority 1337 so its mods override [VTX]; not stated outright) |
| Sims 2 and Sims 3 `.package` files look the same from outside and "will mess up your game". | S [CR3] |
| Lots, rooms and households go in `Tray/`, not `Mods/`. | S [CR3], [CF2] |

**Design consequence:** read her actual `Resource.cfg` to compute the allowed package depth. Do not hard-code five.
Flag any `.ts4script` deeper than one folder, and any archive file in Mods.

### The two switches in Options.ini

| Claim | Mark |
|---|---|
| In the game: Options > Game Options > Other > "Enable Custom Content and Mods" and "Script Mods Allowed". A change needs a game restart. | S [EA1], [CR3], [MCCC] |
| In `Options.ini`, section `[options]`: `modsdisabled` (`0` = mods on) and `scriptmodsenabled` (`1` = script mods on). A third key, `showmodliststartup`, controls the startup mod list. | S [PB `Services/SmartSimObserver.cs`], [STM] |
| Note the opposite senses: one key is "disabled", the other "enabled". | S [PB] |
| PlumbBuddy fixes these by writing `modsdisabled=0` and `scriptmodsenabled=1`. | S [PB `Services/Scans/Setting/*.cs`] |
| A read-only `Options.ini`, or security software blocking the folder, makes the switches reset on every start. | I ([STM] is one user's claim; EA forum threads not opened) |

### After a game patch

| Claim | Mark |
|---|---|
| EA turns mods off on purpose with each update, to limit problems from mods that are no longer compatible. Since game version 1.13 every update forces both mod settings off. | S [EA1], [MCCC] |
| **Data-loss trap:** "If you select Save and Exit before re-enabling Custom Content and Mods, content may be removed from your saved game." EA's advice is to test with mods off, then exit **without saving**. | S [EA1] |
| Error code 110 "usually appears after a game update, and is caused by outdated Mods". Codes 102, 123, 125, 127, 129, 131 point to a script problem, so a script mod could be the cause. | S [EA1] |
| EA's own method for finding a bad mod is to take all mods out and add them back in batches, halving the bad batch (the "50/50 method"). Game mods first, custom content second. | S [EA1] |
| All script mods from before the Nov 2018 patch (Get Famous) are dead and need an update. | S [CR3] |

**Design consequence:** when `modsdisabled=1` and she has mods, warn loudly: "do not save your game until mods are
back on". This is the single most likely way she loses content.

## 3. Crash and exception logs

### The game's own logs

Location: top level of the user folder. Files are named `lastException.txt` or with a suffix such as
`lastException_63887256771.txt` (S for location [CR1]; the numeric suffix is **I**, seen only in search-result titles).

Verified structure of `lastException.txt` (S [MTS1], [MTS2], [BE1], [SSA]):

- An XML declaration and a `<root>` element holding one or more `<report>` elements.
- Each `<report>` holds, in this order: `version`, `sessionid`, `type`, `sku`, `createtime`, `buildsignature`,
  `categoryid`, `desyncid`, `systemconfig` (empty), `screenshot` (empty), `desyncdata`.
- `type` is `desync` in every sample seen.
- `sku` names the build: `ea.maxis.sims4_64.15.pc` (2018, 2022), `ea.maxis.sims4.13.pc` (2015).
  **Mac:** a value like `ea.maxis.sims4.15.macarm64` is reported but not opened (**I**).
- `createtime` is `YYYY-MM-DD HH:MM:SS` (local time: **I**).
- `buildsignature` carries the game version: `Local.Unknown.Unknown.<game version>-<build>.Release`.
- `categoryid` is `<python file>:<line>`, the innermost frame. It is the best grouping key.
- `desyncid` equals `sessionid` in the samples.
- `desyncdata` is the message and Python traceback. In the raw file the line breaks are written as the entities
  `&#13;&#10;`, and `<` `>` as `&lt;` `&gt;` (S [BE1], which embeds the raw file). Any XML parser decodes them.
- The same error is often repeated in many `<report>` elements. Group by `categoryid`.
- The text may end with `rtim=0` and `ClientInfo isn't here` lines (S [BE1]).
- The files seen were well-formed. A file cut off by a crash is possible (**I**), so parse defensively and fall
  back to a regular expression per `<report>`.

Illustrative example, modeled on [MTS1] and [BE1] (shown with real line breaks; not a real player's log):

```xml
<?xml version="1.0" ?><root>
<report><version>2</version><sessionid>0a1b2c3d4e5f60718293a4b5</sessionid><type>desync</type>
<sku>ea.maxis.sims4_64.15.pc</sku><createtime>2026-11-20 19:42:07</createtime>
<buildsignature>Local.Unknown.Unknown.1.129.39.1030-1.200.000.999.Release</buildsignature>
<categoryid>tunable.py:2138</categoryid><desyncid>0a1b2c3d4e5f60718293a4b5</desyncid>
<systemconfig/><screenshot/><desyncdata>[maxisdev] Caught exception loading reference. RefName: 136725 Manager: InstanceManager_interaction.
 TunableReference is set to a value that is not allowed by its class restriction. (ValueError: ...)
Traceback (most recent call last):
  File "T:\InGame\Gameplay\Scripts\Core\sims4\tuning\instance_manager.py", line 433, in load_data_into_class_instances
  File "T:\InGame\Gameplay\Scripts\Core\sims4\tuning\tunable.py", line 2138, in load_etree_node
ValueError: TunableReference is set to a value that is not allowed by its class restriction.
</desyncdata></report>
</root>
```

How people read it to name a mod:

| Step | Mark |
|---|---|
| Frames under `T:\InGame\Gameplay\Scripts\...` are the game's own code. A traceback made only of these does not name a mod. | S [MTS1], [BE1] (all 73 frames in the BE sample are game frames) |
| A frame from any other path belongs to a script mod. Match the file or module name to a `.pyc` inside one of her `.ts4script` archives. | I (how third-party analyzers do it; not seen in an opened sample) |
| The path in a mod frame is whatever the mod author's computer had at compile time. It need not contain `.ts4script` or her Mods path. | I (Python behavior; verify on her logs) |
| Tuning errors name a resource, not a file: `RefName: 136725 Manager: InstanceManager_interaction`. The number is a tuning instance ID. Finding which package holds or overrides that instance needs the package index (section 4). | S for the message [MTS1]; I for the lookup |
| A traceback that runs from `instance_manager.py` into `xml\etree\ElementTree.py` and ends in `ParseError: mismatched tag: line N` means a tuning XML inside some package is itself broken. The log does not say which package. | S [MTS2] |
| Bracketed tags such as `[maxisdev]` are Maxis developer names, not mods. | I |
| Many errors are too generic to pin on a mod. "Sometimes, there is nothing anyone can do." Then the 50/50 method is the only way. | S [MCCC] |
| An exception at load time often comes from an out-of-date mod that stops the others loading. Custom content can cause exceptions too, not only script mods. | S [MCCC] |

`lastUIException.txt`: an exception in the user interface. Same folder, and by search summaries the same `<report>`
wrapper with `categoryid` such as `(AS)...` and an ActionScript stack trace (`TypeError: Error #1009 ... at
olympus.controls::GUIComponent`). **I** throughout: no full sample could be opened. Illustrative only:

```xml
<report>...<categoryid>(AS)widgets.Example::ExampleWidget/onUpdate</categoryid>...<desyncdata>TypeError: Error #1009: Cannot access a property or method of a null object reference.
	at widgets.Example::ExampleWidget/onUpdate()
	at olympus.controls::GUIComponent/validateNow()</desyncdata></report>
```

`lastCrash.txt`: written after a hard crash. Crinrict: "Only readable by EA/Maxis" (S [CR1]). A real 2014 file
(S [MTS3]) is one line of XML whose root is `<report>` itself, with no `<root>` wrapper. Fields in order: `version`,
`sessionid`, `type` (= `crash`), `sku`, `createtime`, `buildsignature`, `systemconfig`, `categoryid` (a hex code
address), `stack` (bare hex addresses), `threads`, `screenshot`, `memdump` (about 50 KB of encoded data),
`contextdata`. It has no Python traceback and no file names. Newer files may add fields (**I**). Illustrative,
modeled on [MTS3]:

```xml
<?xml version="1.0" encoding="UTF-8"?><report><version>2</version><sessionid>0a1b2c3d4e5f60718293a4b</sessionid><type>crash</type><sku>ea.maxis.sims4_64.15.pc</sku><createtime>2026-11-20 19:44:51</createtime><buildsignature>Local.Unknown.Unknown.1.129.39.1030-1.200.000.999.Release</buildsignature><systemconfig></systemconfig><categoryid> 0xce2052</categoryid><stack> 0xce2052</stack><threads></threads><screenshot></screenshot><memdump>...</memdump><contextdata>Current Game State: 0x9b8c93c0<br /></contextdata></report>
```

**Design consequence:** from a `lastCrash` file the program can report only when it happened and on which game
version. It must not claim a guilty mod. Because the two log kinds have different roots, detect by `<type>`.

### Logs from diagnostic mods

**Better Exceptions (TwistedMexi).** Writes `BE-ExceptionReport.html` in the user folder (S [SC1]). The previous
report is renamed `BE-ExceptionReport-OLD.html` on a new session (**I**: search summary of a Patreon post).
Sections of a real v2.03 report (S [BE1]): Exception Summary (Exception Date, Game Version, Category ID,
Recommended Action, Possible Cause with a confidence percentage, Reason, MCCC Version, Package Mod Count); Broken
Mods (Invalid Tuning Mods, Invalid Script Mods, Duplicate Mods, Invalid Object CC, Junk Files, **Missing Packs**);
Last Interaction; Active Sim's Traits; Help & Resources; Formatted LastException; Exception Attributes. Two hidden
blocks are machine-readable: `<div id="beRawLEData">` holds the game's raw XML, HTML-escaped, and
`<div id="beDebugData">` holds BE's steps and a mod file list (`relative\path.package*MM/DD/YYYY|...`). The layout
has likely changed since v2.03; the site now lists v3.17 (S [TM]). Illustrative summary:

```
Exception Date: 2026-11-20 19:42:07 | Game Version: 1.129.39.1030-1.200.000.999.Release | Category ID: tunable.py:2138
Possible Cause (Confidence: 10%): tunable
Recommended Action: No mods were listed in the exception but you do have mods installed. ...
```

**MC Command Center (Deaderpool).** Does not create exceptions; it watches the game's logging and notifies (S [MCCC]).
Its report `mc_lastexception.html` sits with the MCCC files in Mods (S [SC1]). MCCC's own log is
`mc_cmd_center.log` in the mod folder, starting with "Initializing MC Command Center version"; its settings file is
`mc_settings.cfg` (S [MCCC]). The inner layout of `mc_lastexception.html` could not be verified, so no example is
given (**I**: treat it as HTML text holding the same traceback, and extract `File "..."` lines).

**Mod Hound** (a website) accepts `mc_lastexception`, `BE-ExceptionReport.html` and a Lumpinou log file and reports
outdated or broken mods, but only for mods listed there (S [PBP `casual-mod-hound.md`]).

A warning from MCCC's author worth repeating in the program's wording: mod conflict detectors "detect when two CC
mods are altering the same resource ID. They have nothing to do with determining whether or not a mod or CC are OUT
OF DATE and causing exceptions" (S [MCCC]). Conflict scanning and crash diagnosis are separate features.

## 4. The `.package` (DBPF) format

Enough to list resource keys. All values little-endian. S [DBPF] and [KUR] agree unless noted.

**Header, 96 bytes**

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic `DBPF` |
| 4 | 4 | Major version = 2 |
| 8 | 4 | Minor version = 1 ([DBPF]; [KUR] says 0, which is the Sims 3 value) |
| 12 | 24 | User version, creation and update times, unused |
| 36 | 4 | **Index entry count** |
| 40 | 4 | Index offset, short form. Maxis always writes 0 here |
| 44 | 4 | Index size in bytes |
| 48 | 12 | Unused |
| 60 | 4 | Constant 3 |
| 64 | 8 | **Index offset, long form (absolute)**. Use it when the short form is 0 |
| 72 | 24 | Padding |

Which game a package is for, from the version pair (S [PB `Services/Scans/WrongGameVersionScan.cs`]):
Sims 2 = 1.1, Sims 3 = 2.0, SimCity = 3.0. Sims 4 = 2.1 (S [DBPF]). A `.package` in her Mods folder with another
pair is the wrong game's file.

**Index**, at the index offset:

1. `uint32` flags: bit 0 = type is constant, bit 1 = group is constant, bit 2 = instance high half is constant.
2. One `uint32` for each set bit, in that order: the shared value.
3. Then `count` entries. Each entry has, skipping any field that is constant: `type` (uint32), `group` (uint32),
   `instance high` (uint32); then always `instance low` (uint32), `offset` (uint32, absolute), `compressed size`
   (low 31 bits; the top bit means "extended entry" and is always set), `uncompressed size` (uint32), then
   `compression type` (uint16) and `committed` (uint16).
4. Compression type: `0x0000` none, `0x5A42` zlib, `0xFFFF` internal (Maxis), `0xFFFE` streamable (unused),
   **`0xFFE0` deleted**. A deleted entry tells the game to unload a resource; it appears in delta packages and is
   uncommon in mods.

- The resource key is `type:group:instance`, with the 64-bit instance = `(high << 32) | low`.
- Keys are readable from the index alone. Nothing needs decompressing (**I**, a direct consequence of the layout).
- Sanity checks before trusting a file: magic, version pair, `index offset + index size <= file size`, and index
  size = `4 + 4k + count * (32 - 4k)` where k is the number of constant flags set (**I**, from the layout). PlumbBuddy has a corrupt-package scan; expect truncated downloads.
- [KUR] notes the top byte of the group is a set of flags. For tuning, the group can instead encode a required pack
  (section 5).

**Finding two mods that override the same resource:** build a map from key to the list of packages holding it.
Caveats, all **I** unless marked:

- A shared key is not always a fault. Default replacements and override mods do it on purpose (S [CR3] describes
  default replacement).
- Two copies of the same mod also collide on every key. Better Exceptions reports these as "Duplicate Mods"
  (S [BE1]). Detect identical files by hash first and report them as duplicates, not conflicts.
- Merged packages hold many creators' items in one file, so name the resource as well as the file.
- Which copy wins among equal-priority packages is not documented in any source opened. Do not tell her which one
  "wins".
- String tables and some other types are meant to coexist under related keys; start with a short list of types
  where a collision matters (tuning XML, CAS parts, object definitions) and grow it.

**Existing open-source parsers** (license read from the GitHub API or the README on 2026-11-24)

| Project | Language | License | Notes |
|---|---|---|---|
| Llama-Logic/LlamaLogic (`LlamaLogic.Packages` on NuGet) | C# | MIT | Active (pushed 2026-10). Powers PlumbBuddy. |
| Llama-Logic/PlumbBuddy | C# (.NET MAUI) | MIT | A full mod-health app for Windows and macOS. See open questions. |
| sims4toolkit/models (`@s4tk/models`) | TypeScript | MIT | Last push 2024-03. Compression is in sims4toolkit/compression (MIT). |
| anonhostpi/DBPF.js | TypeScript | MIT | Small; last push 2024-10. |
| s4ptacle/Sims4Tools (s4pi / s4pe) | C# | GPL-3.0 (README; no license file detected) | The classic library. Last push 2024-03. |
| Kuree/Sims4Tools | C# | none detected | Archived fork; useful for its wiki only. |
| chances/dbpf-d (D, MIT), thequux/s4py (Python, no license, 2014), lingeringwillx/sims2py (Python, GPL-2.0, Sims 2 only) | | | Of little use here. |
| Llama-Logic/Binary-Templates | 010 Editor templates | MIT | Handy as a format cross-check. |

GPL code cannot be copied into a program under another license. The index reader is about 60 lines, so writing it
from the [DBPF] spec is cheaper than adopting a dependency, unless the program is in C# (then use LlamaLogic).

**Caution:** a GitHub search for "sims 4 mod manager" returns as its top result a repository whose name says "dlc
unlocker". Many small Sims repos are unreviewed. Take nothing from them without reading it.

## 5. Which packs are installed

| Claim | Mark |
|---|---|
| Pack codes: `EP##` expansion, `GP##` game pack, `SP##` stuff pack **and kits** (they share the prefix), `FP##` free pack. | S [PACK] |
| [PACK] maps every code to its name and to a "Group ID" number (for example EP01 Get To Work = 0x3, EP02 = 0x9, EP11 = 0x34). It was updated 2026-11-15 and lists packs through SP87. | S [PACK] |
| Win: each installed pack is a folder named by its code directly inside the game's install folder, beside `Data`, `Delta` and `Game`. PlumbBuddy lists those folders and keeps names matching `^\wp\d{2,}$`. | S [PB `Services/SmartSimObserver.cs`] |
| **Mac:** pack folders are in a sibling folder named `The Sims 4 Packs`, next to `The Sims 4.app`. `Data` and `Delta` are inside the app at `Contents/Data` and `Contents/Delta`. | S [PB `Platforms/MacCatalyst/PlatformFunctions.cs`] |
| A pack folder that exists only under `Delta` is patch data, not an installed pack. | I (EA forum search summary) |
| A pack can be installed but turned off with the launch argument `-disablepacks:EP01,GP02`. PlumbBuddy reads it from the EA app or Steam settings. `UserSetting.ini` also records disabled packs. | S [PB]; S [CR1] |
| Better Exceptions reports "Missing Packs: not owned or are disabled". | S [BE1] |
| A pack folder on disk shows the pack is installed, not that she owns it. | I |
| Game version, Win: the file version of `Game\Bin\TS4_x64.exe`. | S [PB `Platforms/Windows/PlatformFunctions.cs`] |
| Game version, **Mac:** `gameversion` under `[Version]` in `The Sims 4.app/Contents/Resources/Default.ini`. | S [PB `Platforms/MacCatalyst/PlatformFunctions.cs`] |
| Game version, either system: `GameVersion.txt` in the user folder, but it is only as fresh as the last game start. | S [CR1] |
| `GameVersion.txt` may not be plain text only. Pull the version out with a pattern like `\d+\.\d+\.\d+\.\d+`. | I |
| Version numbers differ by system: the patch of 2026-10-27 is PC `1.129.39.1030`, Mac `1.129.39.1230`. | S [MCCC] |
| Finding the install, Win: registry subkey `SOFTWARE\WOW6432Node\Maxis\The Sims 4`, value `Install Dir` (hive HKLM: **I**). Steam default: `C:\Program Files (x86)\Steam\steamapps\common\The Sims 4`. | S [PB `Platforms/Windows/ElectronicArtsApp.cs`]; S [CF1] |
| Finding the install, **Mac:** search for bundle ID `com.ea.mac.thesims4` (`mdfind`), or look in `/Applications`, `/Applications/EA Games`, `~/Applications` and the same on other volumes. | S [PB `Platforms/MacCatalyst/ElectronicArtsApp.cs`] |
| Game process names: Win `TS4_x64`, `TS4_x64_fpb`, `TS4_DX9_x64`. Mac: a process matching `The Sims 4`. | S [PB] |

**Checking a mod's pack needs**

| Claim | Mark |
|---|---|
| A tuning resource can be tied to a pack through its group: `0x00000000` base game, `0x00000003` Get to Work, and so on. The game then skips it when the pack is missing. | S [GRP] |
| Custom content does not use the group this way, and SimData never does. A group that is not of the form `000000XX` is something else. | S [GRP] |
| So the group tells you only when a creator chose to restrict a file. Most mods that need a pack do not say so in the file. | I |
| Some mods carry a manifest (a Llama Logic convention) listing required, incompatible and recommended packs. PlumbBuddy's dependency scan compares the required list with the installed pack folders. | S [PB `PlumbBuddy.Data/ModFileManifest.cs`, `Services/Scans/DependencyScan.cs`]; I: few mods have one |
| Otherwise pack needs come from outside: the mod's download page, Mod Hound, or Better Exceptions' "Missing Packs". | I |

## 6. Safe-operation rules

| Rule | Why | Mark |
|---|---|---|
| Back up before any change by copying the whole `The Sims 4` user folder to another place. That is EA's own method, the same on Windows and Mac. | EA: "Copy" the folder, rename the copy "Sims 4 Backup". | S [EA2] |
| If space is short, the essentials are `saves`, `Tray`, `Mods`, `Screenshots`, `Custom Music`, `Options.ini`. Always copy the **whole** `saves` folder, not chosen files. | Mods keep their own data in `saves`. | S [CR5], [CR6] |
| One save is `Slot_XXXXXXXX.save` plus its `.save.ver0` to `.ver4` files. Do not rename them. The slot number must stay eight digits. | The game matches by name; a wrong name hides the save. | S [CR5], [CR6] |
| To find one bad save, EA's method is to reset the folder, then copy saves back a piece at a time, testing the game after each. | Official bisect method for saves. | I (search summary of [EA2]; the step text was not in what I read) |
| Never delete `.ver0`-`.ver4` files as "clutter". | They are the only built-in way back. The Load screen's Recover button reads them and makes a new `[Recovered]` save. EA: each manual save slot keeps several save points; the Autosave slot keeps none. | S [CR5], [EA3] |
| To restore, rename the current user folder aside (for example `The Sims 4_broken`) and copy the backup in. Do not overwrite in place. | Keeps the newer files in case they are needed. | S [CR5] |
| Refuse to move, rename, delete or edit anything while the game is running. Detect the process (names in section 5). | The game holds files open and rewrites `Options.ini` and caches on exit. PlumbBuddy refuses to move files while the game runs. | S [PB `Scans/Depth/DepthScan.cs`] for the practice; I for the reasons |
| Treat `UserData.lock` and `saves/scratch/` as "game may be running or crashed". Check the process, not the file. | Both exist only while the game runs, and `scratch` survives a crash. | S [CR1], [CR6] |
| Reading files while the game runs is fine if files are opened shared and read-only. | No source says otherwise. | I |
| The EA app being open is not a hazard for the user folder in itself, but an update in progress replaces the install and resets the mod switches. Do not scan the install during an update. | | I |
| "Disable" a mod by moving it out of `Mods` to a holding folder **outside** the user folder, keeping its relative path. | EA and MCCC both describe taking mods out of the folder. Moving keeps the file intact and is easy to undo. | S [EA1], [MCCC] for the practice |
| Do not disable by renaming inside `Mods` (for example `.package.off`) without testing. | It should work, since `Resource.cfg` matches `*.package`, but CurseForge may see a missing file and fetch it again. | I |
| Move the whole mod: its `.ts4script`, its `.package` files and its own folder. | Script mods usually come as several files that belong together. | S [CR3] |
| After adding or removing mods, delete `localthumbcache.package`. | Crinrict: "Always delete this file after adding/removing CC and Mods." | S [CR1] |
| Never let her save with mods off or with a mod she relies on removed, unless she means to. Say so on screen. | Content from missing mods "may be removed from your saved game". | S [EA1] |
| Never touch `Tray` during mod cleanup. | CurseForge's own "select all, Delete" also deletes saved Sims and buildings from the library. | S [CF3] |
| Warn when the user folder is inside OneDrive (Win) or iCloud Drive (Mac). | Sync causes permission errors and folder switching. MCCC: the Mods folder "should be on a physical drive". CurseForge's fix for missing mods includes quitting OneDrive. | S [MCCC], [CF3], [CR2] |
| Keep backups outside the user folder and outside synced folders. Verify each one (file count and sizes, or hashes). Copy, verify, then delete the original; never a bare move across drives. | A backup inside `Mods` or `saves` would be scanned as live data. A failed move can leave neither copy whole. | I |
| Use the recycle bin or a quarantine folder, not permanent delete, for anything outside the cache list. | Makes every action reversible. | I |
| Leave `Resource.cfg` and `Options.ini` edits as explicit, backed-up, opt-in actions. | A bad `Resource.cfg` hides mods; deleting it is the documented fix. `Options.ini` holds all her settings. | S [MCCC], [CR1] |

### CurseForge specifics

| Claim | Mark |
|---|---|
| The app finds the game's Mods folder itself, and a "Scan mods folder" adds existing mods. | S [CF1] |
| Hand-installed mods are detected and shown with a folder icon, but cannot be updated through the app. | S [CF1] |
| Mods in folders the player made herself are not recognized as CurseForge mods; the app expects them in its default places under `Mods` or `Tray`. | I (search summary of a CurseForge article; the opened pages do not state it) |
| Where CurseForge records what it installed, and what it does when a tracked file is moved or renamed, is not documented in the pages opened. | Open question |
| **Mac:** CurseForge supports macOS and asks for the folder holding `The Sims 4.app`. | S [CF1] |

## Open questions

1. Is she on Windows or macOS, and is her Documents folder redirected to OneDrive or iCloud?
2. What does CurseForge do when a file it installed is moved out of `Mods`: re-download it, mark it missing, or
   nothing? This decides how "disable" must work. Needs a test on a copy.
3. How do script-mod frames look in her real `lastException` files? The file-to-mod matching rule in section 3 is
   inferred and needs her logs to confirm.
4. The exact layout of `lastUIException.txt`, `lastCrash.txt` and `mc_lastexception.html`, and of current Better
   Exceptions reports (v3.x). No full sample could be opened. Her own files will settle it.
5. Which copy of a duplicated resource the game loads when priorities are equal.
6. Does she already use Better Exceptions or MCCC? If so their reports are the best input the program can get.
7. PlumbBuddy (MIT, Windows and macOS) already does depth, setting, cache, corrupt-file, wrong-game, duplicate,
   dependency and error-log scans. Should this project build on it, sit beside it, or simply install it for her?
8. Two small checks on a real install: is `GameVersion.txt` plain text, and can a pack folder exist on disk for a
   pack she does not own (trials, refunds)?
