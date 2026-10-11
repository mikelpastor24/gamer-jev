# Local viewer

[Documentation](README.md) · [Project overview](../README.md)

## Controls and layout

| Input | Keyboard |
| --- | --- |
| D-pad | Arrow keys |
| A / B | Z / X |
| Start | Enter |
| Select | Shift |

You can also hold the on-screen buttons with a mouse or touch. The viewer
provides pause/resume, a single-frame step, reset, checkpoint save/restore, and
PNG screenshot downloads, stereo sound, mute, and volume controls. Inputs are cleared when the window loses focus and
expire on the server if the viewer disconnects.

The viewer uses a dashboard that fits the window, with separate cards for agent
status, local game state, Jev exchanges, and available actions. **Settings** opens
a dialog with display preferences and session tools. Show or hide cards and
controller buttons, or select **Game only** for more display space. **⤢** expands
a card. Pause/resume and the camera button for PNG screenshots stay beside the
game; sound, checkpoints, frame stepping, and reset live in **Settings → Session**. Controller buttons
are shown by default for manual play and hidden by default for agent sessions.
Narrow or short windows switch to section tabs.
Cards paginate long content instead of adding scroll areas. Click a state field,
action, objective, or stop reason to read its full details; action cards only
inspect a choice and never execute it. **Fields** lets you hide individual state
values. Panel and field visibility are remembered in this browser, with field
preferences kept separately for each reader. **Reset layout & fields** restores
the defaults. These preferences do not alter observations sent to Jev.

## ROM library

Load another cartridge from **Settings → ROMs**: select a file and press
**Load selected ROM**. The library lists up to 256 regular `.gb` and `.gbc`
files directly inside the project's `roms/` folder, each at most 8 MiB.
It refreshes whenever you open its tab. Missing or empty folders show an
instruction to add your own ROMs. Color-only ROMs remain unsupported; the
emulator validates the selected cartridge before replacing the current game.

Loading pauses the current session, cancels pending model work, and saves its
checkpoint. The selected game automatically restores its latest compatible
checkpoint, or starts from boot if none exists. It stays paused, with the matching
reader selected by exact hash; press **Resume** to play. Reloading the current
ROM preserves its current progress, including the checkpoint saved by that load.
Loading never
makes model requests. Speed, custom objectives, constraints, milestones,
providers, action duration, and ceilings carry over. Untouched reader objectives
refresh from the new game's suggestions. Decision and
request counters, elapsed time, history, and inspection start fresh. Unapplied
editor drafts are discarded. Each agent game has its own local JSONL record.
Memory-only agent sessions reject cartridges without a compatible reader.

Checkpoints after a ROM change use
`saves/<console>/<rom-sha256>/checkpoint.json`, independently for each ROM.
An explicit startup `--save` path applies to the initial game. The previous
game stays loaded and paused if cartridge validation, checkpoint restoration,
or checkpoint saving fails. Invalid checkpoints remain unchanged and are reported
as errors rather than silently starting a new game.
Library loading also works after an agent reaches a session limit; the new
session uses the currently applied limits. Start the viewer with `npm run demo`
for manual play, or with your existing agent command, then choose a ROM here.
ROM bytes and absolute library paths are never returned to the browser.

## Inspecting Jev exchanges

During agent sessions, **Jev exchange** pairs each decision's **Input** and
**Response** by request number and emulator frame. The input sections show
objectives, semantic game state, observations, available actions, recent history
with action results, **Repeated states** feedback, the typed question, and the
request JSON. **Game facts & routes** shows optional profile-owned facts and
evidence about each currently offered action. Response sections show the selected
action, confidence, probabilities, model, token usage, validation warnings, and
the normalized decision. **Response fields** shows the supported fields received
from the provider, including rejected responses when available. Mock sessions
show their local context and decision without making network requests.

**Latest result** keeps the last completed pair visible while the next request
is pending. Choose **Current request** or **Last completed** to inspect either
pair explicitly. Errors and cancellations remain visible; reset and checkpoint
restore clear both pairs. Expand the card and use its section selector and page
arrows for long content. Only the current and last completed exchanges are kept,
with a 1 MiB limit per inspected object. Viewing them does not call a model or
advance the emulator. Credentials and transport headers are excluded, and
exchange contents are not saved in browser storage.

```sh
npm start -- --rom "roms/my-game.gb" --paused --speed 1 --port 8787
```

## Emulation speed

Change **Settings → Session → Emulation → Speed** during manual or agent play.
The dashboard offers 0.25×, 0.5×, 1×, 2×, 4×, 8×, 16×, and 32×; changes apply
immediately and preserve pause state, objectives, pending Jev requests, and
action frame counts. The game card shows the current target. You can also set
the initial speed with `--speed`, including fractional values up to 32:

```sh
npm start -- --rom "roms/my-game.gb" --agent typesafe --vision none --goal "Finish the game" --speed 8
```

When starting the viewer from TypeScript, pass `speed: 8` in `startViewer`'s
options; call `viewer.setSpeed(8)` to change it later. Speed is a target relative to the approximately 59.73 Hz Game Boy frame
rate. Actual throughput depends on your machine and the emulator. Higher speeds
shorten controller execution between decisions; they do not shorten provider
response times or change request throttling. The viewer keeps emulation and audio
running while vision or Jev responds, with all buttons released and only one
observation/decision in flight. Each request uses a snapshot; before execution,
the local GameReader checks that the chosen action and its inputs/duration are
still available. An unavailable action is recorded and discarded, and Jev is
asked again on a fresh snapshot without pausing. These responses still count
toward session limits. Pauses, errors, configured limits, and Jev's stop action
still stop playback. Headless execution waits for responses to keep frame counts
deterministic and already runs without real-time pacing, so `--speed` applies
to the viewer. Runtime speed edits are local to this process and appear in agent
or debug JSONL records; checkpoints do not store the viewer's target speed.

## Sound

Click **Enable sound** in the viewer to start audio; browsers require a user
interaction before playback. Use **Mute sound** or the volume slider to adjust
it. Audio follows pause/resume and is cleared when resetting, restoring a
checkpoint, changing speed, or hiding the tab. Speed changes affect sound tempo and pitch.
The audio queue is bounded so muted or disconnected viewers cannot accumulate
an ever-growing recording. Headless runs generate audio internally but do not
play it through the system speakers.

## Checkpoints and autosave

**Press Ctrl+C to stop.** The viewer saves a checkpoint under
`saves/game-boy/<rom-sha256>/checkpoint.json` before exiting. The save button
writes to the same path. Loading that ROM in the viewer, including at startup,
automatically restores this latest checkpoint when it exists. **Restore checkpoint**
also lets you return to the last save during play and pauses the session.

Enable **Autosave** in **Settings → Session → Checkpoint**, set both intervals,
and press **Apply**. It is off by default. Agent play saves after every 25 new
Jev decisions by default, once the current input finishes; manual play saves
after every 60 seconds of active play. Both intervals are editable: 1–10,000
decisions and 1–86,400 seconds. Paused manual time does not count, and emulation
speed does not change the time interval. Saving keeps emulation, audio, and
pending model work running and makes no additional model requests.

Autosave uses the current cartridge's checkpoint path. Settings carry across
ROM and play-mode changes during this application run; restarting starts with
autosave off. Applying autosave settings, switching modes or cartridges, manually
saving, resetting, or restoring starts a new interval. The Settings panel shows
the last automatic save and any error. Failed saves leave gameplay running and
retry at the next interval. Writes replace the checkpoint only after a complete
temporary file is ready, and checkpoint operations wait for any pending autosave.
Autosave is a viewer feature; headless execution keeps its explicit save behavior.

Choose your own checkpoint path; interactive startup automatically resumes it
when present. An explicit `--load` takes precedence if supplied:

```sh
npm start -- --rom "roms/my-game.gb" --save "saves/my-session.json"
npm start -- --rom "roms/my-game.gb" --load "saves/my-session.json" --save "saves/my-session.json"
```

Checkpoints validate the ROM hash, console, backend version, schema, and data
shape. They include private game memory and must stay local. They are emulator
snapshots, not interchangeable cartridge `.sav` files. Automatic battery-save
import/export is not implemented.
