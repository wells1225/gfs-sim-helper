# Grok: save copies, launching, CurseForge updates and mod wishes (2026-11-26)

Grok searched X and the web with generic terms. X was thin on slot renaming, CurseForge's disk behaviour and how
long a tuning mod takes, so those rest on guides and forums. Posts are opinion unless a guide backs them.

## 1. A save copied in under a new slot

- Guides say a copied save loads when its name is an unused slot:
  [Crinrict's recover guide](https://sims4.crinrict.com/eng/2014/09/recover-backup-save-game/).
- The name is `Slot_` + exactly 8 hex digits (`0-9`, `a-f`) + `.save`, written in lower case. The game counts
  `02`–`09`, then `0a`–`0f`, then `10`, and so on.
- EA's community helpers say a save whose first digit is not `0` has sometimes failed to load. **Decision:** we only
  ever create `Slot_0<7 hex>.save`.
- A `.save.ver0` to `.ver4` file loads once renamed to a free slot. Households travel inside the save. Gallery and
  library households live in Tray, separately.
- Unknown: whether two copies of one save share an id the game cares about. No X post tested a slot copy. Tyler's
  live check settles it.

## 2. How players back up saves

- They copy `Documents\Electronic Arts\The Sims 4` by hand and use the game's own `.ver` files.
  [@VelvettBYT, 2026-08-05](https://x.com/VelvettBYT/status/2085126250813858300),
  [@BluebellFlora1, 2023-12-07](https://x.com/BluebellFlora1/status/1732832504510361601).
- OneDrive is the failure players post about: it renames saves (`- Copy`), and the game then ignores them.
  [@afuneralrose, 2026-10-07](https://x.com/afuneralrose/status/2107921759551033456),
  [@cherrywhims, 2026-03-22](https://x.com/cherrywhims/status/2035548367099732263).
- Unknown: whether copying a save while the game runs gives a broken copy. We refuse while it runs anyway.

## 3. Starting the game from `TS4_x64.exe`

- Players say double-clicking `Game\Bin\TS4_x64.exe` starts the game on an EA app install, and that it works "most of
  the time": [@Crosimmer, 2023-04-13](https://x.com/Crosimmer/status/1646602940101152794),
  [@SacrificialMods, 2026-03-22](https://x.com/SacrificialMods/status/2035857900829040677),
  [@milkemie, 2024-09-28](https://x.com/milkemie/status/1840066422766219772). Leave `TS4_DX9_x64.exe` alone.
- Steam installs need EA Desktop signed in:
  [Steam discussion, 2024-03-16](https://steamcommunity.com/app/1222670/discussions/0/7056650139338578346/).
- Unknown: whether a cold start with the EA app closed always works. **Decision:** if the game is not running 60
  seconds after Play, show "If the game didn't open, open the EA app, then press Play again."

## 4. CurseForge updates on disk

- Not verified. One Reddit report says an update drops the new files into Mods and leaves the old copies there, and
  that a file moved into a folder of your own stops being managed:
  [r/thesims4, 2024-06-30](https://www.reddit.com/r/thesims4/comments/1ds4nx9/new_to_curseforge_and_i_have_some_questions/).
- Nothing was found on what happens when the old file was moved out, and there is no public write-up of
  `AddonGameInstance.json`.
- **Decision:** PR 16's Waiting on list reads only the local `fileDate`. The `back-in-mods` state exists because of
  this report. Tyler's live check settles it.

## 5. Mods players wish someone would make

- **Traits come up most:** Brave, Quiet, Shy, Stubborn, mental-health traits, the Sims 3 traits.
- **Next:** aspirations (especially for children) and ordinary careers (librarian, dentist, therapist). Examples:
  [@solofmari, 2026-10-31](https://x.com/solofmari/status/2116389830880108847),
  [@Jsimlady, 2024-10-20](https://x.com/Jsimlady/status/1848006456475275356),
  [@RaionLeo1, 2026-11-24](https://x.com/RaionLeo1/status/2125052041399783658),
  [@CharXP, 2024-08-07](https://x.com/CharXP/status/1821232442444792146).
- **What each kind takes:**
  - Traits, buffs and career pay or hours are tuning only: XML and SimData inside a `.package`, often cloned from an
    existing one ([JaneSimsten's tutorial, 2024-12-14](https://www.patreon.com/JaneSimsten/posts/tutorial-basics-117922068)).
  - A new pie-menu interaction usually needs XML Injector (a shared `.ts4script`) as well.
  - A whole career with its own events is a big job.
  - "Small" can mislead: food likes look like one trait but expand to thousands of tuning files
    ([Waffle, 2025-08-19](https://www.patreon.com/waffle_mix_ins/posts/how-hard-would-136847529)).
- **Decision:** PR 17's `ready.json` note names any required mod (such as XML Injector). Requests for 3D CC get the
  honest answer that Tyler can't make those.
