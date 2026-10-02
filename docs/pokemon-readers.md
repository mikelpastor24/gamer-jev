# Pokémon game readers

The shipped `pokemon-red-en` strategy supports **Pokémon Red Version (USA,
Europe), SGB Enhanced**, with this exact cartridge image:

| Digest | Value |
| --- | --- |
| SHA-256 | `5ca7ba01642a3b27b0cc0b5349b52792795b62d3ed977e98a09390659af96b7b` |
| SHA-1 | `ea9bcae617fdf159b045185467ae58b2e4a48b9a` |

The registry detects the reader from the console and SHA-256. Renaming the file
does not change compatibility. Translations, hacks, patched ROMs, and different
revisions need their own verified descriptors and layouts. This repository
includes no commercial ROM, artwork, extracted font, or game-data dump.

## Run Red

Supply your own ROM. These commands assume it is named `roms/pokemon-red.gb`;
use your actual local path, including quotes when it contains spaces.

```sh
# Manual play and local memory inspection; no credentials or model calls.
npm start -- --rom "roms/pokemon-red.gb"

# Offline integration check; mock choices do not understand Pokémon.
npm start -- --rom "roms/pokemon-red.gb" --agent mock --vision none --goal "Inspect the opening menus" --headless --decisions 10

# Jev through direct TypeSafe, with local memory observations and no vision.
npm start -- --rom "roms/pokemon-red.gb" --agent typesafe --vision none --goal "Choose a starter Pokemon and explore Pallet Town"
```

For direct Jev, set `TYPESAFE_API_KEY` in your local `.env`. Gateway decisions
use `--agent gateway` and `AI_GATEWAY_API_KEY`. To add visual evidence, select
`--vision gateway` independently and supply the Gateway key and optional
`VISION_MODEL`. An existing reader continues to provide memory facts and
actions when vision is enabled. No screenshots leave the computer with
`--vision none`.

Open **Game state** in the viewer to inspect facts, descriptions, and
available actions. The same snapshot is available at `GET /api/game-state`.
Use `--profile pokemon-red-en` to select explicitly, `--list-profiles` to list
readers, and `--load <checkpoint>` to resume a compatible local checkpoint.
Pause or stop from the viewer; Ctrl+C stops the process. Agent limits and
records follow the workflows in the [README](../README.md).

## What Jev receives

| Fields | Meaning |
| --- | --- |
| `phase`, `gameStarted` | Boot/intro, transition, boxed text, menu, naming, overworld, or battle evidence |
| `screenTextTop`, `screenTextBottom` | English text decoded from complete boxes in the 20 by 18 work-RAM tile map |
| `menuCursorX`, `menuCursorY`, `menuCursorRow` | Visible boxed cursor position and its row; not a claim that the game is polling input |
| `namingPrompt`, `enteredName` | Heading and current entry when the naming alphabet grid is visible |
| `playerName`, `rivalName` | Terminated, decoded names after gameplay starts |
| `mapId`, `playerX`, `playerY`, `mapWidth`, `mapHeight`, `facing`, `movementMode` | Location and movement state; map dimensions use movement squares |
| `money`, `badgeCount`, `badges`, `pokedexOwned`, `pokedexSeen` | Packed-BCD money, badge flags, and 151-species bit counts |
| `bagCount`, `bagItems` | Occupied bag slots and internal item ID/quantity pairs |
| `partyCount`, `party1` through `party6`, corresponding `Moves` fields | Nicknames, internal species IDs, levels, big-endian HP, types, status, and move IDs/PP |
| `battleKind`, `battleType`, `battlePlayer`, `battlePlayerMoves`, `battleEnemy` | Active battle data, including current HP and normal/demo/Safari variant |

Fields appear only when applicable. Before the game timer starts and a valid
player name exists, the reader excludes party, location, and progression
defaults written during Oak's introduction. It drops active battle fields
when the battle flag clears, regardless of stale enemy bytes remaining in RAM.
Invalid counts, names, BCD, and transitional Pokémon data stay unknown or
unavailable; they are not coerced into plausible game facts.

The reader interprets text-box borders before decoding text. Map graphics and
portraits can reuse character tile IDs; decoding every tile as a letter would
invent text. Text can be incomplete while printing, and each text field is
limited to 256 characters. Unboxed content is excluded, except for the naming
heading and entry when its alphabet grid establishes the context. This is
memory decoding, not OCR or a vision model. Battle graphics, some status and
party screens, and other unboxed labels are not fully represented.

Party and battle structures are different. During a fight, `battlePlayer`
contains current HP and `battlePlayerMoves` contains current PP; the party copy
can lag until the fight ends. Internal species IDs are **not Pokédex numbers**.
Item and move IDs are not translated using a bundled game-data table. Names
visible in boxed menus remain available as text; a nickname need not identify
its species.

Actions retain stable controller IDs such as `press_a` and `press_down`, with
context descriptions. Button presses use at most eight frames, or a shorter
`--action-frames` setting, followed by four release frames. Waits retain the
configured duration. Simultaneous button combinations are excluded. LCD-off
and blocked overworld transitions offer only `wait` and `stop`. Other phases
offer single-button attempts: a control can do nothing if the current screen
ignores it. The reader does not claim to enumerate every legal in-game command
or exclude every ineffective input. Jev selects all gameplay inputs; the reader
never chooses moves, walks a route, or executes a walkthrough.

## Share code by engine family

A single memory layout cannot read every Pokémon game. The reusable part is
an observation vocabulary and decoding for a compatible engine:

```text
GameReader contract
  GenerationOnePokemonReader (English Gen I structures and encoding)
    pokemon-red-en (verified hash and Red addresses)
    future Blue/Yellow readers (their own verified layouts and hashes)
  future Gen II reader (its engine structures and encoding)
  future GBA reader (its engine structures and a GBA emulator adapter)
```

[`generation-one.ts`](../src/profiles/pokemon/generation-one.ts) owns Gen I
decoding and action descriptions. [`encoding.ts`](../src/profiles/pokemon/encoding.ts)
owns English character codes, BCD, bit counts, and boxed text.
[`red.ts`](../src/profiles/pokemon/red.ts) supplies the exact revision and its
addresses. These modules stay under `src/profiles/`; the core, Jev adapters,
vision adapters, and runner contain no Pokémon knowledge. Reads take a fresh
bounded RAM snapshot without writes, frame advancement, or caches.

To add a compatible Gen I release:

1. Verify the user's exact ROM hash against an authoritative disassembly.
2. Check every `GenerationOneLayout` address and the character/structure
   assumptions for that language and revision. If semantics differ, extend or
   specialize the family reader rather than changing addresses blindly.
3. Create a descriptor and factory using `GenerationOnePokemonReader`, and
   register them in `src/profiles/default-registry.ts`.
4. Add synthetic RAM tests for the differences. Check the reader locally with
   a legally obtained ROM through startup, menus, overworld, party, and battle.
   Keep that ROM and all resulting saves/screenshots out of Git.

Blue and Yellow are **not registered or advertised as supported readers yet**.
Later generations need different readers; a common filename, franchise, or
English title does not establish RAM compatibility. GBA games such as Emerald
also require an emulator backend that this project does not currently supply.

## Evidence and limits

Layout facts come from the matching English Red disassembly:

- [Release hashes and project documentation](https://github.com/pret/pokered)
- [Red symbol addresses](https://github.com/pret/pokered/blob/symbols/pokered.sym)
- [Work-RAM structures and semantics](https://github.com/pret/pokered/blob/master/ram/wram.asm)
- [Character encoding](https://github.com/pret/pokered/blob/master/constants/charmap.asm)
- [Party structures and PP masks](https://github.com/pret/pokered/blob/master/constants/pokemon_data_constants.asm)
- [Runtime flags](https://github.com/pret/pokered/blob/master/constants/ram_constants.asm)

The reader is an original implementation using documented layout facts; no
disassembly code or commercial assets are copied. Automated tests use invented
RAM and blank frames, including party/battle decoding, startup guards, bounded
actions, revision rejection, restore/reset, and a memory-only session. Local
checks with the matching Red ROM exercised the intro, naming, starting room,
and overworld menu. Battle decoding is covered by synthetic fixtures; full-game
play and live Jev performance have not been verified.

This first reader supplies observations, not a complete Pokémon agent. It has
no collision map, NPC or exit model, pathfinding, event-flag objectives, or
verified completion checks. Vision can supplement missing visible evidence.
Loading the ROM and decoding state do not establish that Jev will finish it.
