# Getting started

[Documentation](README.md) · [Project overview](../README.md)

Run the commands below from the repository root.

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

## Next steps

- [Set up Jev and optional vision](agent-sessions.md), choose objectives, and configure session limits.
- [Use the local viewer](viewer.md) for controls, sound, ROM switching, and checkpoints.
- [Run without the viewer](development.md#headless-execution) or inspect compatibility and development details.
