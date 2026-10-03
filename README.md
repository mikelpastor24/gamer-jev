# Gamer Jev

A public, game-agnostic project where [TypeSafe AI's Jev](https://typesafe.ai/)
selects controller actions from a user's objectives, structured game state, and optional visual observations
of an emulated game. Inspired by
[jev-pokemon](https://github.com/christianmat/jev-pokemon).

Implemented: Game Boy emulation, stereo audio, a local viewer, checkpoints,
and an agent loop with configurable session limits, structured game state, Jev decisions, and optional
visual perception. Game readers use interchangeable strategies selected by
console and ROM hash. Jev can use direct TypeSafe or Vercel AI Gateway; vision
is configured independently. Manual and fully mocked sessions need no credentials.
Gameplay competence still needs validation with real games.

## Requirements

- Node.js 22.18 or newer and npm.
- Your own legally obtained Game Boy ROM, or the included synthetic demo.
- A modern browser for the local viewer.

The implementation uses TypeScript and the same `serverboy` 0.0.7 emulator
backend as the reference project. It needs no native emulator, Python, build
toolchain, game disassembly, or boot ROM. Windows and Linux are the initial
development targets; CI checks both.

## Quick start

```sh
npm ci
npm start
```

Open the URL printed by the CLI, normally **http://127.0.0.1:8787**.
No arguments are required. The application starts paused in manual mode and
opens **Settings → ROMs** so you can choose a cartridge from your local `roms/`
folder. The included demo is loaded initially; close Settings and Resume to try
it, or use `npm run demo` to start the demo directly.
The demo is an original checkerboard program that scrolls while you hold a
direction and plays a steady 440 Hz test tone when sound is enabled. It is
generated in memory and contains no third-party game assets.

To load your own ROM:

```sh
npm start -- --rom "roms/my-game.gb"
```

Paths with spaces work when quoted. The ROM can live anywhere on your machine.
The `roms/`, `saves/`, `output/`, screenshots, and local runtime files are ignored
by Git. Do not add commercial ROMs or generated gameplay artifacts to the repo.

## Let Jev play

Copy `.env.example` to `.env`, set the keys you want to use, and run `npm start`.
The server reads `.env` even for manual play. **Settings → Agent → Mode & models**
lets you choose **Manual** or **Agent**, the Jev provider, and vision independently.
Providers with no configured key are disabled; mock providers remain available
offline. Key presence does not verify credits, account access, or model support.
The browser receives provider availability and model identifiers, never API keys.
Restart the application after editing `.env`.

Model fields start with `TYPESAFE_MODEL`, `JEV_MODEL`, or `VISION_MODEL` from `.env`
and can be edited in the application. Jev remains a TypeSafe decision model;
Gateway vision requires a model that supports image inputs. Set an objective
in **Objectives**, optionally adjust **Limits**, and use **Apply changes**.
Applying pauses the game and cancels pending work; close Settings and Resume.
Switching modes, providers, or models preserves the cartridge, agent counters,
request budget, and elapsed time. It clears recent history and inspection so
the next decision uses the current game state. Manual play makes no model calls.
The session timer begins when the agent is first enabled and includes later
pauses and time spent in manual mode. Loading a ROM starts a fresh session and
keeps applied mode, model choices, objectives, and limits.

You can also choose the decision provider with `--agent` and the visual provider
with `--vision`. Every combination is supported:

| Component | Option | Credential |
| --- | --- | --- |
| Jev directly through TypeSafe | `--agent typesafe` | `TYPESAFE_API_KEY` |
| Jev through Vercel AI Gateway | `--agent gateway` | `AI_GATEWAY_API_KEY` |
| Predetermined local decisions | `--agent mock` | None |
| No vision; requires a compatible memory reader | `--vision none` | None |
| Vision through Vercel AI Gateway | `--vision gateway` | `AI_GATEWAY_API_KEY` |
| Fixed local visual descriptions for testing | `--vision mock` | None |

Omit `--agent` for manual play; `--profile` can still enable local state inspection.
Copy `.env.example` to `.env` and set only credentials for the providers you
select. Obtain a direct key from the [TypeSafe console](https://console.typesafe.ai/)
or a [Vercel AI Gateway key](https://vercel.com/docs/ai-gateway/getting-started).
The two credentials are not interchangeable. If both models use Gateway, one
Gateway key authenticates both.

For example, use only Jev directly with the demo's automatically selected reader:

```dotenv
TYPESAFE_API_KEY=your-typesafe-api-key
```

```sh
npm start -- --demo --agent typesafe --vision none --goal "Increase scrollX"
```

For a ROM without a reader, start with vision:

```sh
npm start -- --rom "roms/my-game.gb" --agent gateway --vision gateway --goal "Start the game and complete the first level"
```

Or use direct TypeSafe decisions with Gateway vision. This combination needs
both keys:

```sh
npm start -- --rom "roms/my-game.gb" --agent typesafe --vision gateway --goal "Start the game and complete the first level"
```

Open the printed viewer URL to watch the session. **Pause** cancels pending
requests and discards their decisions. **Resume** requests a fresh observation.
The panel shows each selected provider, the objective, observation, chosen input,
confidence when reported, decision count, request count, and stop reason. Manual button
input is disabled during agent sessions. Checkpoints and screenshots still work.

Existing commands keep their defaults: a live agent uses Gateway vision, and
a mock agent uses mock vision, unless `--vision` is specified. The compatibility
option `--observation state` means `--vision none`; `--observation vision` enables
the default visual provider. Conflicting `--observation` and `--vision` options
are rejected. With vision, no game-specific reader is required. The default
Gateway vision model,
`google/gemini-2.5-flash`, describes the current screenshot and compares it with
the previous observation. Jev receives structured game state,
any visual description, objectives, recent action results, repeated-screen
evidence, and the current available actions. A compatible reader supplies
semantic state and filters those actions; otherwise vision uses generic
controller actions and explicitly labeled emulator metadata. Jev selects the
action; vision only observes and cannot overwrite memory-derived state or actions.
Each remote provider uses its selected service's credentials and account credits.
Model settings are independent:

| Environment setting | Used by | Default |
| --- | --- | --- |
| `TYPESAFE_MODEL` | Direct TypeSafe decisions | `jev-latest` |
| `JEV_MODEL` | Gateway decisions | `typesafe-ai/jev` |
| `VISION_MODEL` | Gateway vision | `google/gemini-2.5-flash` |

Only selected providers validate their credentials and model settings. Direct
TypeSafe ignores `JEV_MODEL`; disabled and mock vision ignore `VISION_MODEL`.
Direct TypeSafe records the actual model ID returned by the API. Gateway model
names use its provider/model format, and the visual model must accept images.

The original demo and the verified English Pokémon Red, Blue, and Yellow
revisions have automatically selected memory readers. To use only Jev:

```sh
npm start -- --demo --agent gateway --vision none --goal "Increase scrollX"
npm start -- --rom "roms/pokemon-red.gb" --agent typesafe --vision none --goal "Choose a starter Pokemon"
npm start -- --rom "roms/my-game.gb" --profile "my-reader" --agent typesafe --vision none --goal "Complete the first level"
```

State-only mode requires a compatible reader. Arbitrary games have different
memory layouts; emulator metadata alone cannot reveal menus, health, player
positions, or valid gameplay choices. Readers follow the `GameReader` Strategy
contract and registry. See [adding a game reader](docs/game-readers.md) and the
working [demo strategy](src/profiles/demo.ts). Simple layouts can use a
[JSON profile](examples/demo-profile.json) without implementing another class.
See [Pokémon readers](docs/pokemon-readers.md) for the supported hashes,
decoded fields, limits, and extending the shared Gen I reader to other revisions.
Pokémon readers also supply profile-owned decision facts: live walking collision,
objects/signs, exits, and local route distances with the first available inputs.
Jev chooses the destination and each action. Surfing and special field mechanics
remain partial; decoded routes do not prove quest progress or full-game competence.

Open **Game state** in manual or agent mode to inspect live fields,
descriptions, and available actions. `GET /api/game-state` exposes the same
read-only snapshot. This makes no model calls and does not advance the emulator.

Jev accepts text-based state, so screenshots go to a separate visual model.
Direct decisions use TypeSafe's documented [System One API](https://docs.typesafe.ai/api).
Gateway decisions use its [evaluation HTTP API](https://vercel.com/docs/ai-gateway/modalities/evaluation),
and Gateway vision uses its [chat completions API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions).
The adapters normalize the different confidence and token-usage fields into the
same decision contract and validate selected actions and probability distributions.
Native Node `fetch` avoids an additional SDK dependency; Apache-2.0 SDK code
would be incompatible with the emulator's GPL-2.0-only license.

The viewer keeps emulation and sound running while models respond, with one
request pipeline at a time. Decisions use a snapshot and local action availability
is checked again before execution. Generic actions hold one button or a direction with A/B for a bounded
duration, then release for four frames; readers can supply other valid button combinations.
The `wait` action advances without input; buttons are also released during model
requests. Model latency delays the next controller input while the game continues.
This loop is best suited to games that tolerate discrete control rather than fast reactions.

Recent history includes `result` for completed actions: execution-end frame,
screen/state change flags, and up to 12 changed fields with bounded before/after
values. Jev also receives `feedback` over up to 32 observations: recurring states,
consecutive unchanged states/actions, repeated action cycles, and fields that
remained stable across recent observations. Opening and closing a menu does not
erase visits to the same earlier state. These are observed changes, not verified
progress or collision information; Jev still selects every controller action.

To test the entire controller loop without keys, network access, or costs:

```sh
npm run agent:demo
npm run agent:demo -- --headless --decisions 10 --screenshot "output/agent-demo.png"
```

The mock decision provider cycles through predetermined inputs. The demo still
uses its real local memory reader and state-dependent action availability. Mock
decisions do not demonstrate Jev's gameplay ability. To test composition with
mock vision, still without keys or API calls:

```sh
npm start -- --demo --agent mock --vision mock --goal "Inspect the screen"
```

Mixing providers is useful for testing each layer separately. A mock decision
provider with `--vision gateway` makes real, potentially billable vision requests;
a live Jev provider with `--vision mock` still makes Jev requests. Mock vision
returns fixed descriptions and does not interpret the screenshots.

### Objectives and limits

For a goal with constraints and milestones, edit
[`examples/objectives.json`](examples/objectives.json) and use it instead of
`--goal`:

```sh
npm start -- --rom "roms/my-game.gb" --agent gateway --objectives "examples/objectives.json"
npm start -- --rom "roms/my-game.gb" --agent gateway --goal "Reach gameplay" --headless --decisions 20 --save "saves/agent.json"
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--decisions` | 100 | Maximum accepted Jev choices |
| `--requests` | 300 | Jev and optional vision HTTP attempts, including failures, retries, and cancellations |
| `--max-seconds` | 300 | Wall-clock session limit, including viewer pauses |
| `--action-frames` | 24 | Input duration; held inputs also get 4 release frames |
| `--frames` | 1,000,000 in agent mode | Additional headless frame limit |

Agent ceilings accept `unlimited` instead of a number. **Settings → Agent** also
lets you edit objectives, constraints, milestones, action duration, and the three
session ceilings while the viewer is running. Choose **Objectives** or **Limits**
in the editor; enter one constraint or milestone per line. Leave a ceiling blank
to disable it individually, or select **No session limits** to disable all three.
Use **Apply changes**, close Settings, and **Resume**. Saving pauses the agent,
interrupts active inputs, and cancels pending observations/decisions so that the
next request uses the new objective and action set. Profiles can still choose
their own bounded action durations. Changes are recorded in the local JSONL log;
the objectives file and browser storage are not rewritten.

The **?** beside each setting explains its behavior. Hover, focus the help button
with the keyboard, or tap it to read the tooltip. Press Escape or tap elsewhere
to dismiss it. Agent help describes shared request counts, elapsed time during
pauses, action durations, and the difference between guidance and verified progress.

For a session without decision, request, or time ceilings from startup:

```sh
npm start -- --rom "roms/my-game.gb" --agent typesafe --vision none --goal "Finish the game" --unlimited
```

`--unlimited` also removes the default headless frame ceiling. An explicit
`--frames <count>` still applies; headless agent runs can alternatively use
`--frames unlimited`. Individual `--decisions unlimited`, `--requests unlimited`,
and `--max-seconds unlimited` flags leave the other ceilings in place. Keep
`--unlimited` separate from those three individual options.

Unlimited sessions still honor pause, Ctrl+C, provider failures, and Jev's
explicit stop action. HTTP timeouts, retry bounds, action bounds, history sizes,
and recording caps remain in effect. A stop chosen by Jev is **unverified
completion**: no current reader verifies that the whole game has been finished.

Requests have a 20-second timeout and a shared minimum interval of 250 ms.
HTTP 429 and server errors retry once with bounded backoff. Authentication,
malformed responses, and unlisted actions stop the session without fallback
inputs. These are request and execution limits, not a currency budget; requests
already accepted by a provider may be billed even if cancelled. Gateway's own
upstream routing is outside the application's attempt counter.

Stopping at a limit leaves the viewer open for inspection. Increase or disable
the reached ceiling in **Settings → Agent** and apply the changes to continue
from the current emulator state. Applying settings can also reopen a session
after a Jev stop or provider error; it remains paused until you explicitly resume.
Decision/request counters and elapsed time are retained. Time ceilings are total
seconds since session startup, including pauses, rather than a new countdown
after each edit. A ceiling below already consumed counts or time keeps the
session stopped. Load a ROM or start a new process for fresh counters. Reset and restore clear
visual/action history and discard pending responses while retaining the current
session's counters. Checkpoints restore emulator state; they do not restore agent
history, edited settings, or provider budgets.
Milestones and a model-selected `stop` are not independently verified evidence
of completion. A future game profile can supply explicit progress checks.

Each agent run writes a local JSONL record under `logs/sessions/`: objectives,
selected provider IDs, candidate actions, observations, model choices and usage,
actual frame ranges, interrupted actions, and stop reasons. API keys and provider error bodies are
excluded. Records may contain game text and user objectives; keep them local.
The same file includes timestamped diagnostics for the agent, game reader,
Jev validation, and HTTP attempts, including failed decisions. Reader snapshots
are recorded when fields or available actions change. Reset and restore clear
that comparison, so the next read is recorded again. Logs stop at 32 MiB, write
a `log-limit` marker, and warn in the terminal; gameplay continues.

Add **`--debug`** to print these diagnostics in the terminal too. Without it,
only diagnostic warnings and errors are printed. Manual play also creates a
local diagnostic record when `--debug` is enabled. Each record wraps an `event`
with an ISO `at` timestamp; diagnostic events have `type: "diagnostic"`,
`component`, `level`, `event`, an optional emulator `frame`, and structured
`data`. Use the frame, decision sequence, and model request number to correlate
reader output, the candidate actions sent to Jev, and the returned distribution.
No raw HTTP response bodies, authentication headers, or screenshots are logged.

```sh
npm start -- --rom "roms/my-game.gb" --agent typesafe --vision none --goal "Earn the first badge" --debug
```

An `action-distribution` diagnostic keeps the probabilities as returned, their
sum, the allowed rounding tolerance, and the selected and highest probabilities.
For direct TypeSafe responses on a two-decimal grid, the sum check allows half a
hundredth per option, capped at 0.05. This handles the rounded probabilities
observed in local sessions; higher-precision responses retain the stricter check.
Zero distributions, missing or invalid probabilities, and unlisted choices
still stop the session. The
[TypeSafe Choice contract](https://docs.typesafe.ai/api#choice-answer) identifies
`choice` as the highest-probability option. Direct responses observed locally
have sometimes selected a listed action with a lower returned probability.
The runtime treats the explicit `choice` as Jev's gameplay decision, preserves
it, and records a `choice-probability-mismatch` warning when the distribution
ranks another action higher. It does not replace the choice with an argmax or
make another model request. Probability values are recorded without normalizing
them. Current action availability and frame bounds are always enforced.

Live state-only mode sends structured state to the selected Jev service. Gateway
vision additionally sends screenshots to its visual model; mock vision runs
locally. ROM binaries and checkpoints stay on your machine. Reader-specific
memory meanings are not guessed for unsupported ROMs.

## Manual viewer

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

Load another cartridge from **Settings → ROMs**: select a file and press
**Load selected ROM**. The library lists up to 256 regular `.gb` and `.gbc`
files directly inside the project's `roms/` folder, each at most 8 MiB.
It refreshes whenever you open its tab. Missing or empty folders show an
instruction to add your own ROMs. Color-only ROMs remain unsupported; the
emulator validates the selected cartridge before replacing the current game.

Loading pauses the current session, cancels pending model work, and saves its
checkpoint. The new game starts from boot, paused, with the matching reader
selected by exact hash. Press **Resume** to start, or **Settings → Session →
Restore checkpoint** to continue a previous save for that ROM. Loading never
makes model requests. Speed and applied agent objectives, constraints,
milestones, providers, action duration, and ceilings carry over; decision and
request counters, elapsed time, history, and inspection start fresh. Unapplied
editor drafts are discarded. Each agent game has its own local JSONL record.
Memory-only agent sessions reject cartridges without a compatible reader.

Checkpoints after a ROM change use
`saves/<console>/<rom-sha256>/checkpoint.json`, independently for each ROM.
An explicit startup `--save` path applies to the initial game. The previous
game stays loaded and paused if validation or checkpoint saving fails.
Library loading also works after an agent reaches a session limit; the new
session uses the currently applied limits. Start the viewer with `npm run demo`
for manual play, or with your existing agent command, then choose a ROM here.
ROM bytes and absolute library paths are never returned to the browser.

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

Click **Enable sound** in the viewer to start audio; browsers require a user
interaction before playback. Use **Mute sound** or the volume slider to adjust
it. Audio follows pause/resume and is cleared when resetting, restoring a
checkpoint, changing speed, or hiding the tab. Speed changes affect sound tempo and pitch.
The audio queue is bounded so muted or disconnected viewers cannot accumulate
an ever-growing recording. Headless runs generate audio internally but do not
play it through the system speakers.

**Press Ctrl+C to stop.** The viewer saves a checkpoint under
`saves/game-boy/<rom-sha256>/checkpoint.json` before exiting. The save button
writes to the same path. Restore pauses the session so you can inspect it
before resuming. Starting the same ROM does not load a checkpoint automatically.

Choose your own checkpoint path and resume it explicitly:

```sh
npm start -- --rom "roms/my-game.gb" --save "saves/my-session.json"
npm start -- --rom "roms/my-game.gb" --load "saves/my-session.json" --save "saves/my-session.json"
```

Checkpoints validate the ROM hash, console, backend version, schema, and data
shape. They include private game memory and must stay local. They are emulator
snapshots, not interchangeable cartridge `.sav` files. Automatic battery-save
import/export is not implemented.

## Headless execution

Run a fixed number of frames with optional held inputs:

```sh
npm run headless -- --rom "roms/my-game.gb" --frames 120
npm run headless -- --demo --frames 120 --buttons RIGHT --screenshot "output/demo.png" --save "saves/demo.json"
npm run headless -- --demo --load "saves/demo.json" --frames 60
```

Frames in a headless run execute as fast as possible. `--buttons RIGHT,A` holds
those buttons throughout that run; an empty button list waits. Buttons are
released at every action boundary, including failures. A session is bounded
by `--frames`; Ctrl+C interrupts between small batches. Headless checkpoints
are written when `--save` is supplied.

```sh
npm start -- --help
npm start -- --list-consoles
```

## Emulator API

```ts
import { readFile } from "node:fs/promises";
import { createDefaultRegistry } from "./src/emulator/registry.js";

const registry = createDefaultRegistry();
const emulator = await registry.create("game-boy", await readFile("roms/my-game.gb"));
try {
  emulator.advance({ buttons: ["RIGHT", "A"], frames: 4 });
  emulator.advance({ buttons: [], frames: 8 });
  const frame = emulator.captureFrame(); // Owned RGBA8888 pixels
  const checkpoint = emulator.saveState();
  emulator.restoreState(checkpoint);
} finally {
  emulator.dispose();
}
```

Actions accept 1–600 frames. Unsupported buttons, duplicate inputs, opposite
D-pad directions, and invalid frame counts fail before execution. Observations
are copies, so callers cannot change the running emulator's memory or screen.
Game-specific memory access is an optional capability of the Game Boy adapter;
the shared runtime does not depend on a memory map.

Audio is another optional capability: an `AudioSource` exposes `drainAudio()`
with the source sample rate, channel count, and owned interleaved `Float32Array`
PCM samples. The Game Boy adapter retains at most 250 ms of samples. The viewer
streams little-endian float PCM to Web Audio and removes the legacy APU's DC
offset before playback. Audio data is not included in checkpoints; the sample
generation phase is saved so playback can continue consistently after restoring.
Checkpoints made before audio support remain loadable.

The adapter configures each backend CPU interval to 70,224 clock cycles, rather
than treating the backend's default 8 ms interval as a hardware frame. The
initial power-on state comes from the emulator's boot-skipping initialization;
frame numbers count the steps requested after loading the ROM.

## Adding another console

Implement the `Emulator` contract in `src/core/emulator.ts` and register a
factory with `EmulatorRegistry.register()`. Each adapter declares its own
console ID, available buttons, screen dimensions, frame rate, backend version,
and capabilities, including whether it supplies audio. Factories can initialize asynchronously, including a future
WebAssembly backend. Frame operations are synchronous after initialization.

The viewer, agent, and headless runner use that common contract. Keep console-specific
timing, memory, initialization, and checkpoint data inside the new adapter.
Only the Game Boy adapter is currently registered. Browser keyboard shortcuts
are provided for the Game Boy input names; other names still get on-screen
buttons and can add appropriate keyboard bindings.

Observation, vision, and decision providers implement separate contracts in
`src/core/agent.ts`. `src/jev/` owns decision evaluation, `src/vision/` owns image
description, and `src/observation/` composes local state with optional visual
evidence. Independent factories, bounded HTTP transport, and shared request
limits live in `src/providers/`. TypeSafe and Gateway implement the same
decision contract without exposing their keys to readers, the runner, or the viewer.
Game strategies implement `src/core/game-reader.ts` and register under
`src/profiles/`. Keep game names, memory addresses, and progress rules outside
the core. See [the reader extension guide](docs/game-readers.md) for the contract,
registration, JSON schema, validation, and examples.

## Compatibility and current limits

- Original Game Boy ROMs are the initial supported target. Dual-mode GB/GBC
  cartridges run in Game Boy mode. Color-only cartridges are explicitly rejected.
- ROM sizes must match the cartridge header. Hardware accuracy and special
  cartridge features depend on the legacy emulator; not every game is verified.
- Checkpoints and deterministic continuation are tested with the synthetic ROM.
  Real-time-clock cartridges and commercial game compatibility need separate
  validation. Checkpoints from other backends or versions are not compatible.
- The viewer runs on loopback only and supports one local controller session.
- The agent infrastructure is tested offline with the synthetic ROM and mocked
  HTTP responses. Live credentials and success in commercial games have not
  been validated. Visual interpretations may be wrong, and compatibility does
  not guarantee objective completion or effective play in every game.
- Shipped readers cover the original demo and exact English Pokémon Red, Blue,
  and Yellow revisions. Startup, naming, the starting room, and overworld menus
  were checked locally for all three; party/battle decoding is tested with
  synthetic RAM. Full-game play, other Pokémon revisions and generations,
  global routing, full field/battle-command legality, and verified progress checks
  remain future work. Local walking collisions and exit routes were checked from
  both house floors into Pallet Town; no real-model success is claimed.
  The demo's new readiness flag changes its hash; older demo checkpoints must
  be replaced. Reader compatibility is checked against exact ROM hashes.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run check
node dist/cli.js --demo --headless --frames 120
```

Tests execute the real emulator against the original synthetic ROM, validate
action safety and save-state continuation, and exercise the local HTTP viewer,
agent lifecycle, shared request budgets, TypeSafe and Gateway request/response validation,
memory decoding, reader compatibility, state-dependent actions, and independent
state-only and vision-assisted observation paths. Provider tests cover all nine
decision/vision combinations, separate credentials, native confidence and token
usage, cancellation, overload retries, and malformed responses.
They require no commercial ROM, network API, credentials, or paid model calls.
The compiled CLI reads the static viewer from `web/`; keep that directory
alongside `dist/` when moving a build.

## License and credits

GPL-2.0-only; see [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The emulator derives from
Serverboy and GameBoy-Online. The reference project is acknowledged as
inspiration; its Pokémon-specific harness is not part of this implementation.

Game Boy is a Nintendo trademark. This project is independent of Nintendo and
TypeSafe AI.
