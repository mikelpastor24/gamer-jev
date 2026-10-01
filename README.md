# Gamer Jev

A public, game-agnostic project where [TypeSafe AI's Jev](https://typesafe.ai/)
selects controller actions from a user's objectives, structured game state, and optional visual observations
of an emulated game. Inspired by
[jev-pokemon](https://github.com/christianmat/jev-pokemon).

Implemented: Game Boy emulation, stereo audio, a local viewer, checkpoints,
and a bounded agent loop with structured game state, Jev decisions, and optional
visual perception. Game readers use interchangeable strategies selected by
console and ROM hash. Live mode uses one Vercel AI Gateway key; manual and mock
modes need no credentials. Gameplay competence still needs validation with real games.

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
npm run demo
```

Open the URL printed by the CLI, normally **http://127.0.0.1:8787**.
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

Create a [Vercel AI Gateway API key](https://vercel.com/docs/ai-gateway/getting-started),
copy `.env.example` to `.env`, and replace the key placeholder:

```dotenv
AI_GATEWAY_API_KEY=your-vercel-ai-gateway-key
```

Choose how to play:

| Mode | Configuration | Model calls |
| --- | --- | --- |
| Manual | Omit `--agent`; optionally select `--profile` for state inspection | None |
| Jev with game state | `--agent gateway --observation state` and a compatible reader | Jev only |
| Jev with vision | `--agent gateway --observation vision`; a reader is optional | Jev and vision |

For a ROM without a reader, start with vision:

```sh
npm start -- --rom "roms/my-game.gb" --agent gateway --observation vision --goal "Start the game and complete the first level"
```

Open the printed viewer URL to watch the session. **Pause** cancels pending
requests and discards their decisions. **Resume** requests a fresh observation.
The panel shows the objective, observation, chosen input, confidence
when reported, decision count, request count, and stop reason. Manual button
input is disabled during agent sessions. Checkpoints and screenshots still work.

The default observation mode is `vision`, preserving existing commands. In that
mode, no game-specific reader is required. The default vision model,
`google/gemini-2.5-flash`, describes the current screenshot and compares it with
the previous observation. Jev, `typesafe-ai/jev`, receives structured game state,
any visual description, objectives, recent action results, repeated-screen
evidence, and the current available actions. A compatible reader supplies
semantic state and filters those actions; otherwise vision uses generic
controller actions and explicitly labeled emulator metadata. Jev selects the
action; vision only observes and cannot overwrite memory-derived state or actions.
When enabled, both models use the same Gateway key and account credits. Optional `.env` settings
`VISION_MODEL` and `JEV_MODEL` change the configured Gateway model IDs; the
vision model must support image input and Jev must remain a TypeSafe model.
`VISION_MODEL` is not validated or used in state-only mode.

The original demo has an automatically selected memory reader. To use only Jev:

```sh
npm start -- --demo --agent gateway --observation state --goal "Increase scrollX"
npm start -- --rom "roms/my-game.gb" --profile "my-reader" --agent gateway --observation state --goal "Complete the first level"
```

State-only mode requires a compatible reader. Arbitrary games have different
memory layouts; emulator metadata alone cannot reveal menus, health, player
positions, or valid gameplay choices. Readers follow the `GameReader` Strategy
contract and registry. See [adding a game reader](docs/game-readers.md) and the
working [demo strategy](src/profiles/demo.ts). Simple layouts can use a
[JSON profile](examples/demo-profile.json) without implementing another class.

Open **Local game state** in manual or agent mode to inspect live fields,
descriptions, and available actions. `GET /api/game-state` exposes the same
read-only snapshot. This makes no model calls and does not advance the emulator.

Jev accepts text-based state, so screenshots go to a separate visual model.
The integration uses Gateway's documented [evaluation HTTP API](https://vercel.com/docs/ai-gateway/modalities/evaluation)
and [chat completions API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions).
Native Node `fetch` avoids an additional SDK dependency; Apache-2.0 SDK code
would be incompatible with the emulator's GPL-2.0-only license.

The emulator freezes while models respond, keeping each decision tied to the
observed screen. Generic actions hold one button or a direction with A/B for a bounded
duration, then release for four frames; readers can supply other valid button combinations.
The `wait` action advances without input. Model
latency creates gaps in gameplay and audio. This first loop is best suited to
games that tolerate discrete control rather than fast reactions.

To test the entire controller loop without keys, network access, or costs:

```sh
npm run agent:demo
npm run agent:demo -- --headless --decisions 10 --screenshot "output/agent-demo.png"
```

The mock decision provider cycles through predetermined inputs. The demo still
uses its real local memory reader and state-dependent action availability. Mock
decisions do not demonstrate Jev's gameplay ability. Add `--observation vision`
to the demo command to test composition with a mock visual provider, still
without keys or API calls.

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

Requests have a 20-second timeout and a shared minimum interval of 250 ms.
HTTP 429 and server errors retry once with bounded backoff. Authentication,
malformed responses, and unlisted actions stop the session without fallback
inputs. These are request and execution limits, not a currency budget; requests
already accepted by a provider may be billed even if cancelled. Gateway's own
upstream routing is outside the application's attempt counter.

Stopping at a limit leaves the viewer open for inspection. Start a new process
for a new budget. Reset and restore clear visual/action history and discard
pending responses while retaining the current session's counters. Checkpoints
restore emulator state; they do not restore agent history or provider budgets.
Milestones and a model-selected `stop` are not independently verified evidence
of completion. A future game profile can supply explicit progress checks.

Each agent run writes a local JSONL record under `logs/sessions/`: objectives,
candidate actions, observations, model choices and usage, actual frame ranges,
interrupted actions, and stop reasons. API keys and provider error bodies are
excluded. Records may contain game text and user objectives; keep them local.
Live state-only mode sends structured state to Jev. Vision mode additionally
sends screenshots to the visual provider. ROM binaries and checkpoints stay on
your machine. Reader-specific memory meanings are not guessed for unsupported ROMs.

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

```sh
npm start -- --rom "roms/my-game.gb" --paused --speed 1 --port 8787
```

Speed is a target relative to the approximately 59.73 Hz Game Boy frame rate.
Actual throughput depends on your machine and the emulator.

Click **Enable sound** in the viewer to start audio; browsers require a user
interaction before playback. Use **Mute sound** or the volume slider to adjust
it. Audio follows pause/resume and is cleared when resetting, restoring a
checkpoint, or hiding the tab. Speed changes affect sound tempo and pitch.
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
evidence. Shared HTTP transport and request limits live in `src/providers/`.
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
- Only the original demo currently has a shipped, verified memory reader.
  Its new work-RAM readiness flag changes the ROM hash; older demo checkpoints
  must be replaced. Reader compatibility is checked against exact ROM hashes.

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
agent lifecycle, request budgets, and Gateway request/response validation,
memory decoding, reader compatibility, state-dependent actions, and independent
state-only and vision-assisted observation paths.
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
