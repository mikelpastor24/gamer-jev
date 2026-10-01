# Gamer Jev

A Game Boy emulation foundation for a public, game-agnostic project where
[TypeSafe AI's Jev](https://typesafe.ai/) will select gameplay actions from a
user's objectives. Inspired by
[jev-pokemon](https://github.com/christianmat/jev-pokemon).

The first milestone is implemented: a real Game Boy emulator, a local manual
viewer, a bounded headless runner, screenshots, and compatible save states.
Jev integration and automatic interpretation of game observations are planned.
No API key is needed for this milestone.

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
direction. It is generated in memory and contains no third-party game assets.

To load your own ROM:

```sh
npm start -- --rom "roms/my-game.gb"
```

Paths with spaces work when quoted. The ROM can live anywhere on your machine.
The `roms/`, `saves/`, `output/`, screenshots, and local runtime files are ignored
by Git. Do not add commercial ROMs or generated gameplay artifacts to the repo.

## Manual viewer

| Input | Keyboard |
| --- | --- |
| D-pad | Arrow keys |
| A / B | Z / X |
| Start | Enter |
| Select | Shift |

You can also hold the on-screen buttons with a mouse or touch. The viewer
provides pause/resume, a single-frame step, reset, checkpoint save/restore, and
PNG screenshot downloads. Inputs are cleared when the window loses focus and
expire on the server if the viewer disconnects.

```sh
npm start -- --rom "roms/my-game.gb" --paused --speed 1 --port 8787
```

Speed is a target relative to the approximately 59.73 Hz Game Boy frame rate.
Actual throughput depends on your machine and the emulator. Audio playback is
not implemented.

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

The adapter configures each backend CPU interval to 70,224 clock cycles, rather
than treating the backend's default 8 ms interval as a hardware frame. The
initial power-on state comes from the emulator's boot-skipping initialization;
frame numbers count the steps requested after loading the ROM.

## Adding another console

Implement the `Emulator` contract in `src/core/emulator.ts` and register a
factory with `EmulatorRegistry.register()`. Each adapter declares its own
console ID, available buttons, screen dimensions, frame rate, backend version,
and capabilities. Factories can initialize asynchronously, including a future
WebAssembly backend. Frame operations are synchronous after initialization.

The viewer and headless runner use that common contract. Keep console-specific
timing, memory, initialization, and checkpoint data inside the new adapter.
Only the Game Boy adapter is currently registered. Browser keyboard shortcuts
are provided for the Game Boy input names; other names still get on-screen
buttons and can add appropriate keyboard bindings.

## Compatibility and current limits

- Original Game Boy ROMs are the initial supported target. Dual-mode GB/GBC
  cartridges run in Game Boy mode. Color-only cartridges are explicitly rejected.
- ROM sizes must match the cartridge header. Hardware accuracy and special
  cartridge features depend on the legacy emulator; not every game is verified.
- Checkpoints and deterministic continuation are tested with the synthetic ROM.
  Real-time-clock cartridges and commercial game compatibility need separate
  validation. Checkpoints from other backends or versions are not compatible.
- The viewer runs on loopback only and supports one local controller session.
- This milestone emulates games and accepts manual or programmed controller
  input. It does not yet understand objectives or play autonomously.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run check
node dist/cli.js --demo --headless --frames 120
```

Tests execute the real emulator against the original synthetic ROM, validate
action safety and save-state continuation, and exercise the local HTTP viewer.
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
