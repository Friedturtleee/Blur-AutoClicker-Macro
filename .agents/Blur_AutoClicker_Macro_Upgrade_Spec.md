# Blur AutoClicker: Macro, Action Recorder, and Background Window Automation

> Implementation specification and working instructions for a coding AI agent.
> Target repository: https://github.com/Blur009/Blur-AutoClicker
> Reference baseline: official Windows project, v3.9.6 (verified 2026-10-09).
> Language of this specification: English, to minimize ambiguity when used with coding agents.

## 0. Your role and required outcome

You are a senior Windows automation engineer working **inside the existing Blur AutoClicker codebase**. **Implement** the requested changes; do not stop after giving design advice or producing mock-ups.

Deliver a working, maintainable, Windows-first upgrade with three integrated capabilities:

1. **Macro:** Rename/evolve the current **Click Points** page into a programmable macro editor and execution engine. Support an editable, human-readable mini language inspired by AutoHotkey (AHK), including mouse motion, mouse buttons, keyboard actions, delays, loops, and conditions. **Keep the user's existing clicker activation hotkey to start/stop a macro.**
2. **Record Actions:** Transform the old Click Points point-entry workflow into a **recording workflow** that captures real user actions, preserves their ordering and timing, and converts them into editable macro source code. Preserve compatibility with old saved Click Points presets.
3. **Background Target Window:** Where Windows and the destination application permit, click and interact with a selected target window **without making it the foreground/focused window**, disturbing the real cursor, or stealing keyboard focus. Expose limitations rather than silently activating a window.

Also implement the core usability and safety enhancements in this document; keep optional advanced ideas scoped to later phases.

**Working rules**

- Inspect the repository, current branch, tests, and documented development commands first. Use actual architecture, conventions, and dependencies; the proposed paths below are starting points, not permission to duplicate existing services.
- Preserve existing Simple, Advanced, Zones, presets, high-speed clicking, stop zones, activation hotkey, master switch, hold/toggle semantics, and portable-mode storage.
- Do not replace the whole application, introduce a second application, or unnecessarily rewrite the clicker engine.
- Make incremental changes, run appropriate tests, fix the failures you introduce, and report anything that cannot be tested in the current environment.
- Prefer Rust for Windows input, hooks, target-window handling, parsing/runtime state, cancellation, and security boundaries; use React/TypeScript for editor, timeline, UI, state, and Tauri events.
- All macros run **locally** and only when explicitly invoked. Do not add covert monitoring, stealth behavior, credential harvesting, or security-boundary bypasses.
- If a platform restriction makes something impossible for a particular target, return a clear `Unsupported` / `NotVerified` / `PermissionDenied` status. **Never report success solely because a Windows API accepted a message.**

## 1. Existing project: where to inspect

Official project: https://github.com/Blur009/Blur-AutoClicker

Current baseline uses **React + TypeScript + Vite + Tauri 2 + Rust** on Windows. Existing Click Points are a sequence of `{ id, x, y, clicks, radius }` rather than a general scripting language. The existing configuration also includes `clickPointsEnabled`, `stopWhenComplete`, hotkey/master-switch handling, click-point events, and a native `SendInput` mouse engine.

Inspect these files before editing:

| Area | Existing locations to review |
|---|---|
| Main navigation and state | `src/App.tsx`, `src/store.ts`, `src/settingsSchema.ts` |
| Existing Click Points UI | `src/components/panels/click-points/ClickPointsPanel.tsx`, `ClickPointsContent.tsx`, `ClickPointRow.tsx`, `ClickPointsPanel.css` |
| Hotkey UI/config | `src/hotkeys.ts`, `src/components/HotkeyCaptureInput.tsx`, Settings panel sections |
| Native input and scheduling | `src-tauri/src/engine/mouse.rs`, `keyboard.rs`, `worker.rs`, `mod.rs`, `failsafe.rs` |
| Native commands/hotkeys | `src-tauri/src/ui_commands.rs`, `src-tauri/src/hotkeys.rs`, `src-tauri/src/app_state.rs`, `src-tauri/src/lib.rs` |
| Native settings and migration | `src-tauri/src/settings/mod.rs` |
| Builds and tests | `BUILDING.md`, `package.json`, existing `src/test/` and Rust tests |

Study existing cancellation, generation IDs, active-click-point progress events, pointer overlay, process allow/block lists, update/preset storage, and `AUTOCLICKER_EXTRA_INFO` tagging before adding new code.

## 2. Product behavior and navigation

### 2.1 Navigation and page behavior

- Rename the top-level **Click Points** entry to **Macro**, retaining the established location/keybind as much as possible.
- In **Macro**, provide three subviews: **Editor**, **Record Actions**, and **Run / History**. This avoids adding another main navigation page just for recording.
- Replace the old manual point-list editor as the primary experience with a recorder. Keep a compact **Pick Coordinate / Insert Click** action for users who prefer manually adding a point.
- An existing saved sequence must appear as an imported/converted macro, not disappear. An empty installation shows a small starter macro and a recording guide.
- Show the active macro, target application, selected execution mode, and a clear state: `Idle`, `Recording`, `Validating`, `Running`, `Paused`, `Completed`, `Cancelled`, or `Error`.
- Keep the application's visual design, themes, scaling, and status-bar conventions consistent.

Suggested layout (adapt to existing CSS/layout):

```text
+---------------------------------------------------------------------+
| Macro | [Editor] [Record Actions] [Run / History]                    |
+---------------------------------------------------------------------+
| Macro: [My Workflow v] [New] [Save] [Duplicate] [Import] [Export]   |
| Target: [Pick Window] [Notepad.exe ...]  Mode: Foreground/Background |
| [Source Editor: line numbers, syntax colors, errors, autocomplete]  |
|                                                                     |
| [Validate] [Dry Run] [Run / Stop] [Step] [Recorder]                  |
| Status: Running step 4/15 | Target verified | Stop: Ctrl+Y         |
+---------------------------------------------------------------------+
```

### 2.2 Hotkey compatibility: mandatory

- **Keep using the existing configured clicker activation hotkey** (currently `hotkey`, default commonly `Ctrl+Y` in the source) to toggle the selected macro in Macro mode. Do not hard-code a new macro-only start/stop shortcut.
- Preserve the existing **Toggle** and **Hold** modes. In Hold mode, release must cancel promptly and release any held synthetic inputs.
- Preserve multi-key hotkey combinations, left/right modifier support, existing master-switch behavior, and suppression/debouncing of injected hotkeys.
- If the normal clicker is running and the user switches UI pages, pressing the stop hotkey must still stop the **actual running job**, not mistakenly start a second worker. Define one authoritative `ActiveAutomationJob` and consistent routing rules.
- **Recording** has its own configurable start/stop hotkey (suggested default: `Ctrl+Shift+R`) that cannot conflict with the macro toggle or emergency stop. Recording shortcuts should not be inserted into the recorded script.
- Add a configurable, reliably accessible **emergency stop** (suggested `Ctrl+Shift+F12`), even if the editor/recorder is not focused. Preserve existing corner/edge/stop-zone safeguards for foreground cursor-based actions; do not falsely apply screen-edge cursor checks to a virtual background cursor.

## 3. Macro language: Blur Macro Script (BMScript)

Implement a small, deterministic, human-readable domain-specific language (DSL) rather than passing scripts to `eval`, a JS runtime, a shell, or arbitrary native code. AHK-like ergonomics are desired, **not full AutoHotkey compatibility**.

### 3.1 Syntax rules

- Store source as UTF-8 text with a documented extension such as `.bms`.
- One statement per line; nested blocks use `{` and `}`. Blank lines are ignored. `#` introduces comments outside strings.
- Strings use `"..."`, with standard escaped quotes and backslashes. Integers, booleans, and durations are distinct typed values; positions are integer pixels.
- Parser must produce a typed AST with **line/column diagnostics**; validate before executing. No `eval`, arbitrary library calls, file access, HTTP requests, or shell execution.
- Prefer an explicit supported grammar; reject unknown instructions or options rather than silently ignoring them.
- Stable versioned syntax (`bmsVersion: 1`) and a reference command guide must ship with the product.

### 3.2 Required v1 commands

| Statement | Semantics |
|---|---|
| `target process="..." title_contains="..."` | Select/re-resolve a specific target window. Process/title filters may be combined; do not accidentally match a different instance. |
| `mode foreground` | Use the existing physical input path; physical pointer/focus effects are possible. |
| `mode background strict=true` | Target compatible window controls without stealing focus or moving the real pointer. Fail transparently if unsupported. |
| `move x=200 y=150 space=screen duration=100ms` | Move real cursor in foreground; in background move only the macro's **virtual cursor** and optionally dispatch supported target mouse-move messages. |
| `click button=left x=200 y=150 space=client count=2 radius=0` | Click at specified point. `left/right/middle`; optional coordinates mean current real/virtual position, depending on mode. Defaults should be documented. |
| `mouse_down button=left` / `mouse_up button=left` | Press/release for dragging, holding, and chords. Must always be balanced on cancellation. |
| `key_down "CTRL"` / `key_up "CTRL"` | Hold/release a physical/logical key. |
| `press "CTRL+A"` | Atomic hotkey/chord, with platform-dependent capability checks in background mode. |
| `type "Hello"` | Input Unicode text where a compatible input method exists; separate from physical key sequence. |
| `scroll delta=-120 x=200 y=150 space=client` | Wheel input; document wheel unit and target compatibility. |
| `wait 250ms` | Interruptible delay; also support `wait 2s`. |
| `let attempts = 0`, `set attempts = attempts + 1` | Local typed variables and basic arithmetic. |
| `repeat 5 { ... }` | Counted loop with valid nesting. |
| `while attempts < 5 { ... }` | Conditional loop with runtime limits. |
| `if attempts == 5 { ... } else { ... }` | Branching, with `==`, `!=`, `<`, `<=`, `>`, `>=` and boolean conditions. |
| `window_exists(process="notepad.exe")` | Safe condition usable by `if`, no arbitrary code. |
| `log "Finished"` | Append to local run log; omit sensitive input text by default. |

Support comments, whitespace, escaped strings, nested blocks, and negative coordinates on multi-monitor desktops. `screen` means virtual desktop coordinates; `client` means the target window's client area. Reject ambiguous background coordinates unless a conversion is explicitly possible.

### 3.3 Executable examples: syntax to support exactly

**Example A - normal foreground macro**

```bms
# This is a Blur Macro Script v1 example.
target process="notepad.exe" title_contains="Notepad"
mode foreground
let completed = 0
repeat 3 {
  move x=300 y=240 space=screen duration=100ms
  click button=left x=300 y=240 space=screen count=1 radius=0
  wait 250ms
  press "CTRL+A"
  type "Hello from Blur Macro!"
  set completed = completed + 1
}
if completed == 3 {
  log "Completed 3 iterations"
} else {
  log "Unexpected count"
}
```

**Example B - strict background click**

```bms
# The target must be a compatible Windows window/control.
target process="notepad.exe" title_contains="Notepad"
mode background strict=true
move x=140 y=90 space=client
click button=left x=140 y=90 space=client count=1 radius=0
wait 150ms
log "Background click dispatched; verify target effect separately"
```

**Example C - held mouse button and cancellable loop**

```bms
mode foreground
let i = 0
while i < 4 {
  move x=100 y=100 space=screen duration=50ms
  mouse_down button=left
  move x=500 y=100 space=screen duration=500ms
  mouse_up button=left
  wait 500ms
  set i = i + 1
}
```

If an example cannot be executed by the implemented parser, fix the parser or update the example before declaring v1 complete. Maintain parser snapshot/round-trip tests using these scripts.

### 3.4 Runtime requirements

- Lex -> Parse -> Validate -> Typed AST / IR -> Execute in a dedicated **cancellable Rust worker**, never on the React rendering thread or a UI event callback.
- Exactly one exclusive automation job controls global input at a time. Define start/stop/pause/resume semantics and a state machine; prevent double starts or races.
- A stop request must interrupt `wait`, `repeat`, `while`, smooth moves, and queued actions promptly (target: under 200 ms for normal cancellable actions, excluding an uninterruptible OS call).
- On stop, exception, target exit, master-switch off, app shutdown, or panic recovery, release synthetic held keys/buttons, remove hooks, and mark the final job state accurately.
- Apply configurable execution limits with safe defaults: maximum statement count, nested-block depth, total runtime, loop iteration count, and log size. No infinite loop may lock the UI. `while` requires a watchdog even if its condition never changes.
- Timing should use monotonic clocks; preserve actual recorded delays and offer playback speed multiplier without cumulative drift where practical.
- The editor must support syntax highlighting, live validation, error annotations, line numbers, autocomplete/help, and source-to-executing-step highlighting. A lighter-weight editor is acceptable if it integrates cleanly.
- **Step**, **Pause/Resume**, **Dry Run** (validate/preview only, no real input) and breakpoint support are strongly recommended after basic execution works.

## 4. Record Actions: convert user interactions into code

### 4.1 Capture workflow

1. User opens `Macro -> Record Actions`, optionally chooses a target window and coordinate mode, then selects **Start Recording**.
2. Show an explicit visible indicator and optional 3-second countdown. Install event hooks **only during active, consented recording**.
3. Record the user's mouse/keyboard actions, timestamped using a monotonic clock. Display a live sequence/timeline.
4. User stops via UI or a separate configurable recording hotkey. Exclude the stop event and the app's activation/emergency hotkeys from the output.
5. Convert recorded events into **valid editable BMScript** using the *same grammar/interpreter* as manually written macros. Open the result in Editor. Allow trimming, deleting, reordering, and re-recording a segment.
6. Let the user preview, validate, save, export, and replay it. Never start replay automatically at the end of recording.

### 4.2 Required capture details

- Mouse left/right/middle **down/up**, clicks/double clicks, pointer movement, wheel up/down, and dragging.
- Keyboard **down/up**, modifier keys, shortcuts/chords, special/function/navigation keys, and key-repeat handling.
- Precise order and meaningful `wait` gaps, including between press and release; choose a configurable default timing compression/rounding policy and document it.
- A default movement filter/sampler that removes noisy high-frequency samples without changing recorded drag paths. Offer `Record cursor movement` toggle.
- Distinguish `press` from `key_down`/`key_up` when a key was held across other events. Do not flatten a held modifier into independent keypresses.
- Preserve mouse screen coordinates; when bound to a target, additionally capture window identity and client-relative coordinates to make replay resistant to window movement. Never assume DPI scale is 100%.
- Use suitable Windows input capture facilities such as `WH_KEYBOARD_LL` and `WH_MOUSE_LL`, or an equivalent tested design. Run low-level callbacks on a dedicated message-loop thread; quickly queue lightweight event records and return. Hooks must not perform expensive parsing, I/O, or React calls.
- Filter out program-injected events using native injected-event metadata, existing `AUTOCLICKER_EXTRA_INFO` where applicable, and playback/recording state, to avoid recursive recording.
- Be transparent about security: do not intentionally capture sensitive/password fields. Detect known password UI Automation fields where possible, automatically pause/redact, and clearly warn that detection cannot be universally guaranteed. Keep source local; do not send input history to telemetry or crash reports.
- Handle focus changes, screen changes, window close, alt-tab, and target process changes without corrupting event ordering.

### 4.3 Recorder conversion example

Captured sequence:

```text
0 ms   Mouse moved to (250, 300)
170 ms Left button down
245 ms Left button up
540 ms CTRL down
555 ms A down
590 ms A up
620 ms CTRL up
900 ms Text: Hello
```

The resulting source should preserve equivalent behavior and timing, for example:

```bms
mode foreground
move x=250 y=300 space=screen
wait 170ms
mouse_down button=left
wait 75ms
mouse_up button=left
wait 295ms
key_down "CTRL"
wait 15ms
key_down "A"
wait 35ms
key_up "A"
wait 30ms
key_up "CTRL"
wait 280ms
type "Hello"
```

This is an illustrative semantic mapping: recorder-produced output must be parseable by the real BMScript parser and must not fabricate `type` events when only uncertain raw key events are known. Prefer key down/up pairs unless an optional, reliable text-input aggregation stage is explicitly enabled.

## 5. Background window input: capabilities and hard limits

**Definition:** When macro mode is `background`, another unrelated app can remain active and usable. The selected target receives compatible actions **without** calling `SetForegroundWindow`, `BringWindowToTop`, foreground-changing activation helpers, or moving the physical pointer. Do not temporarily steal focus and switch back as a hidden workaround.

### 5.1 Target selection and identity

- Add a crosshair/window picker and window list showing title, process name/PID, HWND, class name, visibility, and supported capability probe results. Avoid exposing sensitive paths unnecessarily.
- Bind a macro to a **stable set of selectors** (process executable + optional title substring/class/child control/UI Automation element), not only a transient HWND, because HWNDs can be recycled.
- Re-resolve and validate at run start and after target recreation. Explicitly handle multiple matching windows; ask for selection rather than using an arbitrary match.
- Track DPI awareness, virtual-screen origin, screen-to-client and client-to-screen conversions, child HWND hit testing, resizes, and multi-monitor/negative coordinates.
- Provide optional `Target Lost: Stop / Wait and Reacquire` behavior, with an explicit timeout.

### 5.2 Execution backends

**Foreground backend:** Reuse the existing Rust `SendInput` keyboard/mouse engine and its safeguards. This is the reliable default for physical input but cannot be treated as background targeting.

**Background Win32 message backend:** For cooperating Win32 HWNDs/child controls, investigate and implement appropriate `PostMessageW` mouse messages (`WM_MOUSEMOVE`, `WM_LBUTTONDOWN`, `WM_LBUTTONUP`, right/middle equivalents, and compatible wheel messages), with correct `wParam`, `lParam`, client coordinates, and press/release ordering. Implement keyboard/window messages only for supported targets and key types. `PostMessageW` returning success means **queued**, not **acted upon**.

**Background UI Automation backend:** Where a control exposes appropriate automation patterns, prefer semantic invocation (`InvokePattern`, `ValuePattern`, `SelectionItemPattern`, etc.) over blind coordinate messages, as appropriate. UI Automation availability/behavior depends on the target app and control.

- Use a capability probe before execution; make backend choice visible (`Foreground SendInput`, `Background Win32 Message`, `UI Automation`, or `Unsupported`). Allow a manual backend override for debugging, but never mislabel it as guaranteed.
- In strict background mode, an unsupported `type`, mouse drag, modifier chord, or target control **fails transparently**. No automatic fallback to foreground input. An explicit **user-approved** fallback policy may be added later.
- In background mode, `move` changes the **virtual per-macro mouse position**, not the physical OS cursor. A background `click` without explicit coordinates uses that virtual position.
- Detect window destruction, invalid/closed handles, incorrect integrity levels, hung windows, and protected/unsupported targets; stop with actionable explanations and logs.
- A minimized or occluded window is **not** universally automatable. In particular, game engines, full-screen exclusive apps, Raw Input, DirectInput, elevated apps, browser canvases, or GPU-rendered controls may ignore synthetic window messages entirely. Do not promise otherwise and do not attempt anti-cheat, UAC, session-lock, or integrity-boundary bypasses.
- Do not install injection DLLs in foreign processes or depend on driver/kernel-level input interception for this feature.

### 5.3 Background-mode acceptance example

1. Open a normal test Win32 app with a clickable button/counter and a separate foreground editor.
2. Bind macro to the test app using the picker; set `mode background strict=true`.
3. Keep typing in the separate foreground editor while the macro dispatches the click to the test app.
4. Verify via the test app's **observable counter** that the action occurred. Verify foreground HWND stays unchanged and the physical pointer position does not change.
5. Run the same test against an intentionally unsupported input target: show `Unsupported` / `NotVerified` instead of claiming that a click occurred.

## 6. Persistence, presets, and old Click Points migration

- Add a versioned `Macro` model: stable ID, name, source text, syntax version, target selectors, preferred mode/backend, playback options, last validation result, and creation/update timestamps.
- Keep current settings/config conventions and portable-mode behavior. Do not inadvertently write portable users' macros into `%APPDATA%` instead of their portable `Data/` location.
- Save/load named macros, duplicate, rename, delete with confirmation, import `.bms`, and export `.bms` (optionally a `.bmacro.json` package for metadata). Prevent path traversal and do not execute imported macros merely by importing them.
- Ensure scripts with Unicode strings round-trip correctly. Preserve unsaved editor changes with an explicit dirty indicator and safe navigation prompt.
- Make preset activation save/restore the associated macro and target configuration where applicable.

### 6.1 Backwards compatibility is non-negotiable

The original Click Points model in `src/settingsSchema.ts` / Rust settings includes `id`, `x`, `y`, `clicks`, `radius`. There are also `clickPoints`, `clickPointsEnabled`, and `stopWhenComplete` settings.

Create a **one-time idempotent migration** on load:

- Preserve a backup/legacy representation until the converted macro has been successfully saved.
- Translate each old coordinate point and click count into ordered `click` statements, retaining `radius`, timing/cadence, stop/loop semantics, and original screen coordinate space as faithfully as current runtime behavior permits.
- Use a migration/schema version so reloading does not create duplicate macros.
- Preserve existing clicker hotkeys, master switch, all unrelated settings, and old presets.
- A profile with no points remains valid. Invalid/corrupted old data returns a clear migration warning rather than deleting settings silently.
- Include fixture-based migration tests for multiple points, zero/one point, various `clicks`/`radius` values, `stopWhenComplete`, and old saved presets.

## 7. Architecture and candidate modules

Adapt these names to repository style; don't add parallel state machines when existing equivalents can be extended.

```text
src/
  components/panels/macro/
    MacroPanel.tsx
    MacroEditor.tsx
    RecorderPanel.tsx
    MacroTimeline.tsx
    MacroRunStatus.tsx
    TargetPicker.tsx
  macro/
    types.ts
    diagnostics.ts
    examples.ts
    migration.ts
  settingsSchema.ts                   # versioned schema update
  store.ts                            # safe persisted state integration
  App.tsx                             # navigation + active-job routing

src-tauri/src/
  macro/
    mod.rs
    lexer.rs
    parser.rs
    ast.rs
    validate.rs
    interpreter.rs
    runtime.rs
    migration.rs
  recorder/
    mod.rs
    hooks.rs
    events.rs
    to_script.rs
  target_window/
    mod.rs
    picker.rs
    message_backend.rs
    uia_backend.rs
    capabilities.rs
  ui_commands.rs                      # Tauri command integration
  app_state.rs                        # single active-job state / cancellation
  hotkeys.rs                          # preserve one primary activation hotkey
  engine/mouse.rs                     # reuse, don't regress existing engine
  engine/keyboard.rs
  settings/mod.rs
```

Suggested command/event interfaces (adjust naming to conventions):

```text
Commands:
  macro_validate(source) -> { ok, errors[], astSummary }
  macro_start(macroId, selectedTarget?) -> JobState
  macro_pause(jobId) / macro_resume(jobId)
  macro_stop(jobId) -> JobState
  recorder_start(options) -> RecorderSession
  recorder_stop(sessionId) -> { eventCount, generatedSource }
  target_list() / target_pick() / target_probe(selector) -> TargetCapabilities

Events:
  macro:state, macro:step, macro:log, macro:error
  recorder:state, recorder:event, recorder:stopped
  target:lost, target:capability
```

Do not trust validation only on the frontend: the Rust backend must revalidate and enforce execution limits. Make Tauri command arguments typed and versioned where needed. Handle errors without crashing WebView2.

## 8. Additional functionality to prioritize

### P0 - part of the required core

1. **Reliable emergency stop + cleanup** for all modes; visible status and exact stop reason.
2. **Macro save/load/import/export** and migration from existing click points.
3. **Syntax error display, validate button, line highlighting**, and clear runtime errors.
4. **Target window picker**, real capability reporting, and strict background policy.
5. **Recording timeline**, movement noise filtering, conversion to editable source, and preview before replay.

### P1 - high-value next step

6. **Timeline <-> script synchronization:** drag steps in a visual timeline; regenerate script without discarding unsupported expressions.
7. **Pause/resume, step execution, breakpoints, variable inspector**, and detailed execution history for debugging.
8. **Relative positioning and anchors:** client-area coordinates; optional named UI Automation controls; normalized coordinates for resizable windows.
9. **Playback controls:** global speed multiplier, per-step delay override, bounded jitter/randomization, and a repeat-until-stopped option with hard failsafe.
10. **Conditions and wait-until:** wait for window exists, pixel color, basic image match, or UI Automation property, with timeout. Warn about image capture limitations for minimized/occluded windows.
11. **Macros as profiles:** per-application bindings and auto-select by target process (without automatic unattended execution by default).
12. **Run history and diagnostic trace:** timestamp, step, backend, dispatched/result-unverified/confirmed status, errors, and export with redaction.

### P2 - optional future roadmap; do not block P0 on these

13. **Image recognition and OCR** for safe UI state checks, with configurable region and confidence threshold.
14. **Reusable functions/parameters and nested macro calls** with recursion and execution caps.
15. **Conditional branching UI** and reusable recorder segments.
16. **Scheduled start / start on window creation**, explicitly opt-in with visible enabled state and stop controls.
17. **Mouse path smoothing** (foreground only) with interpolation curves and exact timing preview.
18. **Community sample macro library** (local templates; no unreviewed remote code auto-execution).
19. **Portable export bundles** including metadata, compatibility warnings, and optional redacted screenshots.
20. **Accessibility-focused control selection** by automation ID/name for robust UI automation instead of hard-coded pixels.

Prioritize stability and accurate capability reporting over adding all features at once.

## 9. Security, privacy, stability, and performance

- Recorder is **off by default**, visibly enabled only after explicit user action, and cleanly unhooks on completion, error, or app exit.
- Never run input listeners as a persistent hidden keylogger. Do not collect/process password-field content where detectable; warn about limitations. No network upload or analytics of recorded input.
- Macros should not get arbitrary filesystem, process-spawning, HTTP, PowerShell, elevated privileges, or dynamic plugin execution in v1.
- Use the existing process allow/block list where meaningful and re-check before every potentially unsafe target action.
- Keep Windows UIPI/integrity boundaries intact; display elevation mismatch rather than requesting blanket admin privilege or bypassing it.
- Avoid blocking hooks, busy-loop waits, unbounded allocation/logging, runaway macro loops, and deadlocks with the existing high-CPS click engine.
- Do not lose physical keyboard/mouse usability when background mode is running. Use a shared input lease to avoid concurrent jobs or button state conflicts.
- Provide accessibility labels and keyboard navigation for editor, record controls, window picker, and dialogs.
- Avoid accidental click-through in the app, focus loss during editing, and hotkey activation when capturing a new hotkey in settings.
- Respect GPL-3.0 requirements when reusing/distributing the original project's code and modifications.

## 10. Test plan and hard acceptance criteria

Implement automated tests where possible and document manual Windows integration tests. **Do not claim that tests passed unless executed.**

| ID | Test | Required result |
|---|---|---|
| A01 | Existing Simple/Advanced clicker and global hotkey | Behavior stays unchanged outside Macro mode. |
| A02 | Click Points navigation | Displayed as Macro; editor and recorder accessible; no broken nav keybind. |
| A03 | Parse/run the provided example scripts | Each validates and behaves as defined. |
| A04 | Bad syntax and unknown commands | Accurate line/column errors; no execution. |
| A05 | Nested repeat/while/if, variables | Correct results, bounded by watchdog and limits. |
| A06 | Start/stop with existing configured hotkey | Works, including Hold and Toggle; no duplicate workers. |
| A07 | Stop during long `wait`, drag, or held key | Stops promptly and releases injected keys/buttons. |
| A08 | Record click, movement, scroll, modifier chord, key down/up | Generates parseable editable BMScript; order and delays preserved. |
| A09 | Record/replay feedback prevention | Replayed injected events do not recursively add to recording. |
| A10 | Background Win32 test with live target-effect counter | Target action occurs while an unrelated foreground app remains focused and usable; physical cursor remains unchanged. |
| A11 | Unsupported background app / elevated or minimized target | No false success and no stealth focus switch; explicit reason displayed. |
| A12 | DPI scaling and multi-monitor negative coordinates | Consistent coordinate conversion in foreground and supported background paths. |
| A13 | Existing presets with point count and radius | Migrated one time, no data loss, semantics preserved as tested. |
| A14 | Portable and normal install persistence | Macros stored/loaded in correct user-data locations. |
| A15 | Target process closes/reopens mid-run | Controlled stop or bounded re-acquisition, without clicking unrelated windows. |
| A16 | Security and log privacy | Recording only when requested; no password/input plaintext in standard logs; hooks removed. |
| A17 | Macros saved with Unicode source, import/export | Byte-safe round trip and explicit file errors. |
| A18 | Emergency stop during all job states | Always transitions safely; cleanup and stop reason visible. |

### 10.1 Suggested build/quality commands

Verify against the current repository's `BUILDING.md` and `package.json` first. The official baseline documents commands including:

```sh
npm install
npm run lint
npm run frontend:build
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

On a supported Windows/MSVC environment, additionally run the maintained Tauri development/build flow and perform real UI + background-input integration tests. If commands or environment support differ from the checked-out branch, record what actually ran and why.

## 11. Recommended execution order for the coding AI

**Phase 0 - audit:** Identify actual UI entry points, hotkey dispatch, worker lifecycle, settings/preset persistence, current click-point cadence, and injection tagging. Document any constraints discovered before modifying behavior.

**Phase 1 - language and model (P0):** Implement DSL lexer/parser/AST/validator, BMScript command spec, safe runtime + cancellation, versioned Macro model, and parser/runtime tests. Expose Tauri commands.

**Phase 2 - Macro UI/hotkeys (P0):** Rename Click Points navigation, add Editor/Recorder subviews, run/stop/status/error display, save/import/export, and preserve the existing activation hotkey/master switch and normal-clicker flow.

**Phase 3 - recorder (P0):** Add consented Windows hooks, event normalization/timestamps, recorder controls, generated BMScript, timeline preview, no self-recording, and privacy safeguards.

**Phase 4 - background automation (P0):** Add window selector, target identity + re-resolution, capability detection, Win32 messages/UI Automation adapters, strict no-focus-stealing guarantee, and reliable test app/observable-effect tests.

**Phase 5 - migration and regression (P0):** One-time import of historical click-point presets, preservation of old settings/hotkeys, portable storage checks, unit/integration tests, fixes, and user docs.

**Phase 6 - high-value P1 features (if time and tests allow):** Step/pause/breakpoints, visual timeline improvements, relative anchors, wait-until controls, run history, and reusable profiles.

Keep commits or change sets small and reviewable. If work spans multiple sessions, leave `IMPLEMENTATION_STATUS.md` with completed tasks, changed files, tested behavior, open issues, and exact next steps. Do not mark an unimplemented capability as complete.

## 12. Final deliverables and reporting format

Return actual source changes, not only a proposal. Include:

1. Summary of implemented behaviors and where the new Macro / Record Actions UI is located.
2. Exact changed/added files and reasons for notable architecture choices.
3. A small working `.bms` example for each implemented mode.
4. A clear explanation of **which background-window input types are supported, which are not**, and how capability/failure is reported.
5. Migration behavior and what happened to the user's old Click Points presets.
6. Commands executed and their **real** pass/fail results; manual Windows tests performed; unsupported test conditions.
7. Remaining P1/P2 items, limitations, and any issues needing further work.

**Definition of done:** The user can type an executable Macro, press the same hotkey previously used for Click Points to start/stop it, record real actions and edit the generated script, safely target at least one supported non-focused Win32 test window with an externally verifiable effect, preserve old presets, and use the other Blur AutoClicker modes without regression.

## 13. Authoritative references

- Original repository: https://github.com/Blur009/Blur-AutoClicker
- Baseline releases: https://github.com/Blur009/Blur-AutoClicker/releases
- Build instructions: https://github.com/Blur009/Blur-AutoClicker/blob/main/BUILDING.md
- `SendInput` and UIPI: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
- `PostMessageW` queue semantics: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew
- `WM_LBUTTONDOWN` semantics: https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-lbuttondown
- Low-level keyboard hook requirements: https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc
- UI Automation `InvokePattern`: https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.invokepattern.invoke

**Begin by auditing the checked-out code. Then implement P0 in order, validating each stage. Do not silently substitute foreground input for strict background input.**
