# Development and emulator APIs

[Documentation](README.md) · [Project overview](../README.md)

Run the commands below from the repository root. For interactive setup, see
[Getting started](getting-started.md); for model configuration, see
[Agent sessions](agent-sessions.md).

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
are written when `--save` is supplied. Headless runs start fresh unless `--load`
is supplied; they do not automatically resume existing checkpoints.

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
the core. See [the reader extension guide](game-readers.md) for the contract,
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
  dynamic regional routing, full field/battle-command legality, and verified
  full-objective completion remain future work. Local collision and destination
  executions reached Pallet Town, Oak's encounter, and his laboratory in all
  three, using an offline fixture decider and preserved saves. Named later-story
  checks and static regional routing are partial; no real-model success is claimed.
  Normal battles add cartridge-derived move names, types, power, base accuracy,
  PP, STAB and type effectiveness. Jev can select an explicit usable move slot;
  its executor navigates and confirms only that choice. Metadata was checked
  locally for all three, and slot 2 execution was checked in a Red combat replay.
  Status/special rules are distinguished. Slot-based party choices and ordinary
  medicines are supported in verified menus; full damage prediction and complete
  party/item battle legality remain incomplete. See [Pokémon readers](pokemon-readers.md).
  The demo's new readiness flag changes its hash; older demo checkpoints must
  be replaced. Reader compatibility is checked against exact ROM hashes.

## Checks and build

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
