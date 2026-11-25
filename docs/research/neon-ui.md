# Front-End UI & Windows Desktop UX Research

*Epistemic tags: every substantive claim is marked **Sourced** (with a verified URL) or **Inferred** (reasoned from documented platform specs, UX principles, or `docs/plan/plan.md`).*

---

## 1. React UI Component Libraries for Electron (Late 2026)

Target: a friendly, warm, single-user Windows desktop app (Electron + React 19 + Vite + TypeScript) built primarily by AI coding agents for the screens in `docs/plan/plan.md` (welcome, folder picker, "What happened?", check-up cards, Send to Tyler, one-click fixes, History/Undo, 50/50 wizard).

| Criterion | **shadcn/ui + Tailwind CSS v4** | **Mantine (v9)** | **Fluent UI React v9** |
|---|---|---|---|
| **Look & Feel** | Neutral, clean canvas; easily styled warm and consumer-friendly via OKLCH CSS tokens (**Sourced**: [shadcn/ui](https://ui.shadcn.com/)). | Clean, friendly web-app defaults with 120+ styled components; slightly "SaaS dashboard" out of the box (**Sourced**: [Mantine](https://mantine.dev/)). | Crisp Windows 11 / Microsoft 365 native look; feels utilitarian/enterprise rather than cozy (**Sourced**: [Fluent UI v9](https://react.fluentui.dev/)). |
| **Accessibility** | Built on headless **Base UI** (default in 2026) or **Radix UI** primitives with full WAI-ARIA, roving tabindex, and focus traps (**Sourced**: [shadcn/ui](https://ui.shadcn.com/), [Base UI](https://base-ui.com/), [Radix](https://www.radix-ui.com/)). | Strong: 10k+ unit tests with `jest-axe`, keyboard traps, and manual screen-reader checks (**Sourced**: [Mantine Accessibility](https://mantine.dev/guides/accessibility/)). | Best-in-class Windows enterprise a11y, including built-in Windows High Contrast token support (**Sourced**: [Fluent UI v9](https://react.fluentui.dev/)). |
| **Bundle Weight** | Smallest: copy-paste source components; only the primitives and Tailwind utilities used are bundled (**Sourced**: [Tailwind v4](https://tailwindcss.com/)). | Heavier baseline (~300+ kB min+gzip full `@mantine/core`), though Vite tree-shakes unused JS; shared CSS needs care (**Sourced**: [Mantine](https://mantine.dev/)). | Modular tree-shaking via `@fluentui/react-components` + atomic **Griffel** CSS-in-JS (near-zero runtime with build transform) (**Sourced**: [Griffel](https://griffel.js.org/)). |
| **Theming** | CSS-first `@theme inline` + OKLCH custom properties in one CSS file; instant light/dark switching (**Sourced**: [shadcn/ui Tailwind v4](https://ui.shadcn.com/docs/tailwind-v4)). | Rich theme object + CSS variables (moving to OKLCH in v9); very easy to customize globally (**Sourced**: [Mantine](https://mantine.dev/)). | JS theme tokens (`webLightTheme`/`webDarkTheme`) in `<FluentProvider>`; customizing beyond Fluent's aesthetic fights the library (**Inferred**). |
| **AI Coding Agent Ergonomics** | **Best.** Agents know Tailwind + shadcn idioms cold, own every component file in `src/renderer/components/ui/`, and never fight hidden library internals (**Inferred**). | **Good.** Ships `llms.txt` and `@mantine/mcp-server`, but version drift (v7→v8→v9 prop changes) trips agents more often than local Tailwind JSX (**Sourced** / **Inferred**). | **Moderate.** Griffel `makeStyles` slots and Fluent token names are verbose and less familiar to agents; easy to mis-style (**Inferred**). |

### Recommendation: **shadcn/ui + Tailwind CSS v4 (Vite plugin)**
Pick **shadcn/ui** initialized with `@tailwindcss/vite` (**Sourced**: [shadcn Vite install](https://ui.shadcn.com/docs/installation/vite)).
1. **Tailored warmth without fighting a corporate design system** (**Inferred**): We need ~10 primitives (Button, Card, Badge, Progress, Accordion/Collapsible, Dialog, Alert, Toast/Sonner, RadioGroup). Owning those files locally makes our cozy palette and plain-language finding cards effortless to polish and snapshot-test.
2. **Base UI vs. Radix backend**: shadcn/ui now defaults to Base UI, with Radix supported via `-b radix` (**Sourced**: [shadcn/ui](https://ui.shadcn.com/)). **Pick Radix (`-b radix`)** unless we need Combobox/NumberField—agents have deeper muscle memory for Radix's `asChild` and data-state patterns, reducing PR churn (**Inferred**).
3. **Why not Mantine or Fluent v9**: Mantine's 120+ components are overkill for a focused 6-screen helper, and Fluent v9 makes a personal game helper feel like Windows Settings/IT software (**Inferred**).

---

## 2. Visual Direction: Sims-Warm Without Copying EA's IP

### Trademark Boundary
EA's official **Policy on Mods for The Sims 4** explicitly prohibits using **any game logos, official key art, stylized game typography, or any version of the Plumbob** to brand or promote fan projects/mods, while permitting factual text stating compatibility with *The Sims 4* (**Sourced**: [EA Policy on Mods](https://help.ea.com/help/the-sims/the-sims-4/the-sims-4-policy-on-mods/)).
- **Non-infringing visual nod (not a Plumbob)** (**Inferred**): Use a **warm botanical/cozy-home emblem**—for example, a **soft rounded house silhouette cradling a 4-point star/sparkle** (or a **rounded botanical leaf-and-sparkle badge**) in muted sage-emerald. Strictly avoid any faceted diamond, octahedron, floating crystal, or neon-green `#00C853` gem shape.
- **Disclaimer**: Include a quiet line on the About screen: *"Independent helper tool for The Sims 4. Not affiliated with or endorsed by Electronic Arts or Maxis."* (**Sourced**: [EA Policy on Mods](https://help.ea.com/help/the-sims/the-sims-4/the-sims-4-policy-on-mods/)).

### Palette, Type, Icons, and Tone (**Inferred**, checked against WCAG 2.2 AA)
- **Color palette (OKLCH CSS variables)**:
  - *Light mode (cozy sunlit daylight):* Warm alabaster canvas (`#FAF9F6`), crisp white cards (`#FFFFFF`) with soft warm-stone borders (`#E7E5E0`), deep charcoal ink (`#1F2421`, >12:1 contrast).
  - *Dark mode (cozy evening play):* Deep warm slate (`#171B1A`), elevated surface (`#202624`), soft off-white ink (`#F2F4F2`), muted borders (`#303A36`).
  - *Primary accent:* Calm **emerald-teal / botanical sage** (`#1E7E63` light / `#4DB896` dark) — echoes cozy life-sim greenery without touching EA's neon Plumbob green or Maxis bright blue.
  - *Severity semantics (always paired with icon + text label, never color alone):* `stop` = warm terracotta-crimson (`#B9382C` / soft tint `#FDF2F1`), `warn` = honey amber (`#A15C07` / tint `#FEF8EC`), `info` = soft periwinkle-teal (`#25637A` / tint `#F0F7FA`), `ok/safe` = calm sage (`#1E7E63` / tint `#EEF8F4`).
- **Typography**: Bundle **Plus Jakarta Sans** (headings + UI) or **Nunito** locally via `@fontsource` (zero network calls, renders identically on macOS dev and Windows target), falling back to `Segoe UI Variable, Segoe UI, sans-serif`. Use `tabular-nums` for file counts, timestamps, and 50/50 round counters; restrict monospace (`Cascadia Mono` / `Consolas`) strictly to collapsed *"Technical details"* boxes. Minimum body size `15px` (`0.9375rem`), line-height `1.5`.
- **Iconography**: **Lucide React** (`lucide-react`, ISC license) at `1.75px` stroke—rounded caps feel friendly and approachable, not stark (**Sourced**: [Lucide](https://lucide.dev/)).
- **Voice & tone**: Calm, encouraging, zero-blame, plain English (NN/g: avoid jargon, error codes, blaming words like *"Invalid"*, and avoid jokes/cutesy humor inside errors) (**Sourced**: [NN/g Error-Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/)). Keep the personal warmth ("Hi Lila! Tyler made this…") on the Welcome and About screens; keep findings and fix buttons crystal clear and reassuring.

---

## 3. Core UX Patterns for Planned Screens

### A. Health Check with Severity-Sorted Results (Check-Up Screen)
- **Lead with a plain-English verdict banner** (**Inferred**): Before the list, show one calm summary card (e.g., *"Found 1 urgent thing and 2 quick fixes"* or *"Your mods folder looks healthy — ready to try the 50/50 test?"*).
- **Group by severity with human labels & redundant cues** (**Sourced**: [NN/g](https://www.nngroup.com/articles/error-message-guidelines/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/)): Order `stop` → `warn` → `info` using distinct icon + badge + border accent:
  - `stop`: Shield-Alert icon + **"Do this first"** (e.g., *"Mods are turned off after an update — don't save your game yet"*).
  - `warn`: Triangle-Alert icon + **"Likely cause / Worth fixing"**.
  - `info`: Info icon + **"Good to know"**.
- **Aggregate per rule, never spam per file** (**Inferred**): If a scan finds 42 duplicate packages or 6 `.zip` files in `Mods`, show **one card** (*"6 zipped files are sitting in your Mods folder"*) with an expandable file list—not 42 separate cards.

### B. Explaining Technical Problems to a Non-Technical Player
- **Three-part card anatomy** (**Sourced**: [NN/g](https://www.nngroup.com/articles/error-message-guidelines/); **Inferred**):
  1. **Headline (What happened):** *"A script mod is buried too deep in folders"* (never *"Depth > 1 violation on .ts4script"*).
  2. **1–2 sentence plain explanation (Why it matters):** *"The Sims 4 can only load script mods if they are directly inside Mods or one folder down. Right now the game is ignoring this one."*
  3. **One clear primary action:** e.g., **"Move it up a folder"** (or **"See affected files"** before PR 10).
- **Progressive disclosure for evidence** (**Inferred**): Keep `Finding.evidence` (paths, `.pyc` module names, `categoryId`, stack frames) tucked inside a collapsed **"Technical details"** accordion on each card. Pair this with an always-reachable **"Send to Tyler"** button that explains in one line what it bundles (logs + mod list, no personal files, user name scrubbed) and opens the Desktop folder when done.
- **Label hints honestly** (**Inferred** from `plan.md` Rule 9 & Rule 11): Never claim certainty when a log only hints. Use soft badges like **"Possible clue"** for pre-patch script mods, and for bare `lastCrash.txt` say plainly *"The game didn't say which mod crashed it — the 50/50 test can find it step by step."*

### C. Destructive-Looking Actions That Are Actually Reversible (Fixes, Backup, History/Undo)
- **Prefer immediate reversible action + Undo over "Are you sure?" modals** (**Sourced**: [NN/g Confirmation Dialogs](https://www.nngroup.com/articles/confirmation-dialog/)): Repetitive confirmation popups cause dialog fatigue and make safe fixes feel scary. Because every fix in PR 9–10 backs up first and journals moves, execute on click and immediately show an inline confirmation + toast with an **Undo** button.
- **Calm safety framing & gentle verbs** (**Inferred**):
  - Show a subtle, always-visible safety pill in the app footer/header: *"Saves & Tray are never touched • Automatic backup before any change"*.
  - Use **non-scary, accurate verbs**: **"Set aside"** (not *"Delete"* or *"Quarantine"*), **"Move up a folder"**, **"Turn mods back on"**, **"Clear temporary cache"**.
  - Note clearly where "set aside" files live (safe folder inside app data) and that **History → Undo** puts every file back byte-for-byte.
- **History screen**: Reverse-chronological list with plain-English action summaries (*"Today at 4:12 PM — Set aside 3 zip files from Mods"*), file count, and a clear **Undo** button (turning into a muted *"Undone"* pill once reverted).
- **When to keep a blocking prompt** (**Sourced**: [NN/g](https://www.nngroup.com/articles/confirmation-dialog/); **Inferred**): Only block/prompt when `gate.ts` refuses (e.g., *"The Sims 4 is still open — please save or close the game first, then click Try Again"*) or when abandoning an active 50/50 session (*"Stop 50/50 test and put all 64 mod groups back?"*).

### D. Long Multi-Step Wizard Surviving App Restarts (Guided 50/50 Test)
- **Persistent resume banner** (**Inferred**): Because a 50/50 session spans many game launches (and possibly days/reboots), if `FiftyFifty` state exists on disk at startup, show a prominent top banner (or route straight to a resume card): *"50/50 test in progress — Round 2 of ~6 • 16 suspects left"* with **Continue test** and a safe secondary **Put everything back & stop**.
- **One task per screen + linear wayfinding** (**Sourced**: [NN/g Wizards](https://www.nngroup.com/articles/wizards/)): Show a compact step indicator (`Round 2 of ~6` + a shrinking funnel bar: *64 → 32 → 16 → 8 groups left*), never an overwhelming spreadsheet of 5,000 files.
- **Concrete round layout (`awaiting: "test"` vs `"answer"`)** (**Inferred**):
  1. *Pre-round checklist card:* Auto-check if Sims 4 is closed; remind her to close CurseForge (*"So it doesn't re-download mods mid-test"*).
  2. *Test instructions card:* Show exactly what the app just did (*"We set aside 16 mod groups (script mods first) and cleared the cache."*), followed by a calm highlighted safety callout: **"Open The Sims 4, start a NEW test household (don't open your real save), and try the thing that crashed."**
  3. *Answer prompt:* Two large, unambiguous buttons — **"It still crashed"** and **"No crash — it worked!"** — plus a quiet **"Not sure / let me re-test"** link.
  4. *Finish screen:* Name the isolated `ModGroup`, offer **"Keep this mod set aside & restore everything else"** (primary) or **"Put everything back"** (secondary).

### E. Progress for Scanning Thousands of Files
- **Two-phase determinate progress** (**Sourced**: [NN/g Progress Indicators](https://www.nngroup.com/articles/progress-indicators/); **Inferred**):
  1. *Phase 1 (<1s):* Fast directory walk counting files (indeterminate pulse: *"Counting files in your Mods folder…"*).
  2. *Phase 2 (determinate bar):* Show percentage bar + live counts (*"Checking mod 1,420 of 5,300"*) + human stage labels (*1. Finding your Sims folder → 2. Checking your mods → 3. Reading crash logs → 4. Putting your check-up together*).
- **No jumping ETAs & throttled IPC** (**Inferred**): Omit volatile "seconds remaining" guesses; throttle progress updates from `main` to `renderer` to ~100 ms intervals so React renders stay smooth during a 5,000-file DBPF/SHA-256 sweep.

---

## 4. Lessons from Existing Sims 4 Tools

| Tool | What to Borrow | What to Avoid |
|---|---|---|
| **Sims 4 Mod Manager** (GameTimeDev, Electron) ([s4mm.gametimedev.de](https://s4mm.gametimedev.de/)) | Approachable, friendly Electron consumer look; clear enabled/disabled visual state; simple toggle mental model (**Sourced**). | File-explorer-first density and heavy 3D/thumbnail grid complexity—distracting when a player just wants to stop crashes (**Inferred**). |
| **PlumbBuddy** (MIT, Llama-Logic) ([plumbbuddy.app](https://plumbbuddy.app/docs/user-interface-overview)) | Opens straight to **Mod Health**; shows phased cataloging progress; offers one-click fixes for `Options.ini` and misplaced `.zip`s; clear cache action (**Sourced**). | Power-user toolbar clutter (Dev Mode toggles, Pack Selector, Manifest tools); jumping out to external wiki docs via `?` icons instead of explaining inline; holding exclusive file locks (**Sourced** / **Inferred**). |
| **CurseForge Sims 4 View** ([CurseForge Guide](https://support.curseforge.com/support/solutions/articles/9000221982-the-sims-4-mods-getting-started)) | Clean, familiar mod names + dates that players already recognize (**Sourced**). | Mixing `Tray/` and `Mods/` in one list (causes accidental household deletion); destructive **Delete** with no per-mod disable or undo; ads/bloat; zero post-patch crash context (**Sourced**). |
| **Better Exceptions HTML Report** (TwistedMexi) ([twistedmexi.com](https://twistedmexi.com/)) | Color-coded summary banner at the top before deep data; surfacing likely culprit names first (**Sourced**). | Confusing *"10% Confidence: `utils`"* guesses that mislead casual players into blaming game files; overwhelming raw Python tracebacks visible by default; in-game-only popups that fail on hard CTDs (**Sourced** / **Inferred**). |

---

## 5. Windows Desktop Details for Electron

1. **Title bar — recommend native Windows title bar for v1 (or `titleBarOverlay`, never `frame: false`)**:
   - **Native title bar (Recommended for PR 1–7)** (**Inferred**): Zero drag-region bugs, full Windows 11 Snap Layouts, automatic dark/light frame matching `nativeTheme`, and crisp DPI scaling out of the box. Put our clean compact app navigation bar right below it.
   - **Optional upgrade (`titleBarStyle: 'hidden'` + `titleBarOverlay`)** (**Sourced**: [Electron Window Customization](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)): Preserves native Windows 11 Snap Layouts on maximize-hover and native caption buttons, unlike `frame: false`. If used, always omit hardcoded `height` (so Windows scales it at 125%–200% DPI), update `win.setTitleBarOverlay({ color, symbolColor })` on `nativeTheme.on('updated')`, and mark interactive header buttons `-webkit-app-region: no-drag`.
   - **Eliminate startup flash**: Create `BrowserWindow` with `show: false` and a `backgroundColor` matching `nativeTheme.shouldUseDarkColors`, then call `win.show()` on `'ready-to-show'` (**Sourced**: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)).
2. **Dark mode following Windows settings**:
   - Leave `nativeTheme.themeSource = 'system'` (default) so Electron native dialogs, scrollbars, and CSS `@media (prefers-color-scheme: dark)` track Windows automatically (**Sourced**: [Electron Dark Mode](https://www.electronjs.org/docs/latest/tutorial/dark-mode)).
   - Mirror `nativeTheme.shouldUseDarkColors` via IPC on `nativeTheme.on('updated')` to toggle Tailwind's `.dark` class (allowing an optional Light / Dark / Match Windows toggle in About/Settings without reloading) (**Inferred**).
   - **Skip `backgroundMaterial: 'mica'`** in v1: requires transparent body backgrounds, degrades differently on Windows 10 vs. 11, and risks contrast regressions (**Sourced** / **Inferred**).
3. **High-DPI scaling on Windows**:
   - Windows laptops commonly default to **125%–150% DPI scaling**: a 1920×1080 laptop at 150% yields **1280×720 effective pixels (epx)**, and a 1366×768 laptop at 125% yields **1092×614 epx** (minus ~40–48 epx taskbar = ~566 epx tall) (**Sourced**: [Microsoft Effective Pixels](https://learn.microsoft.com/en-us/windows/apps/design/layout/screen-sizes-and-breakpoints-for-responsive-design); **Inferred** math).
   - Use `rem` typography, fluid single-column layouts (`max-w-3xl mx-auto`), and flexible card heights so text never clips at 150%–175% scale. Test Playwright Electron views at both `100%` and `150%` scale factors (**Inferred**).
4. **Keyboard navigation & accessibility**:
   - Meet **WCAG 2.2 AA**: ≥4.5:1 text contrast, ≥3:1 non-text/focus-ring contrast (`SC 1.4.11`), visible `2px` `:focus-visible` outlines (`SC 2.4.7`), and ensure sticky banners/footers never cover focused elements (`SC 2.4.11 Focus Not Obscured`) (**Sourced**: [WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
   - Announce scan milestones and Undo toasts via `aria-live="polite"`, `stop` findings via `role="alert"`, respect `prefers-reduced-motion`, and omit default Electron menu bar (`Menu.setApplicationMenu(null)` or minimal Edit/Help menu) so `Alt` doesn't flash a developer menu (**Sourced**: [Electron Accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility); **Inferred**).
5. **Minimum & default window size**:
   - **Default launch:** `960 × 700` epx (clamped to primary display `workAreaSize` so it never spawns off-screen on a 1366×768 @ 125% laptop) (**Inferred**).
   - **Minimum size:** `minWidth: 500`, `minHeight: 520` epx — meets Microsoft's **≤500 epx** guideline for Windows 11 Snap Layouts (side-by-side with Sims 4 or CurseForge during the 50/50 test!) and fits cleanly inside 1366×768 @ 125% (**Sourced**: [Microsoft Snap Layouts](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/apply-snap-layout-menu); **Inferred**).
