# Third-party notices

## Serverboy 0.0.7

- Project: https://gitlab.com/piglet-plays/serverboy.js
- Author: Daniel Shumway.
- License: GNU General Public License, version 2.
- The embedded GameBoy-Online core identifies Grant Galitz, copyright
  2010–2012, and GNU GPL version 2 in its source headers.
- Serverboy also credits Guillermo Rauch's `gameboy` project and Grant Galitz's
  [GameBoy-Online](https://github.com/taisel/GameBoy-Online).

The backend is installed as an npm dependency. This repository does not modify
or copy its source. All private-core integration is isolated in
`src/emulator/game-boy/serverboy.ts` and is specific to the pinned 0.0.7 release.
The dependency's historical ROM fixtures are not used in our tests or copied
into project artifacts. Do not redistribute those fixtures with a build.

## pngjs 7.0.0

- Project: https://github.com/pngjs/pngjs
- License: MIT, distributed with the installed package.

## Inspiration

[christianmat/jev-pokemon](https://github.com/christianmat/jev-pokemon), by
Christian Mathiesen, inspired the project and the choice of emulator backend.
No Pokémon-specific source or game data from that project is included.

## Pokémon memory-layout references

The original Pokémon reader uses factual addresses, data encodings, and
structure meanings documented by [pret/pokered](https://github.com/pret/pokered).
See [the reader documentation](docs/pokemon-readers.md) for exact sources and
supported ROM hashes. No disassembly source, ROM bytes, game artwork, fonts,
or extracted game-data tables are included. Users supply their own ROMs.
